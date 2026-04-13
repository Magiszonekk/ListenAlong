const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const YTMusic = require('ytmusic-api');
const { prisma } = require('../lib/db');

const router = express.Router();
const DURATION_TOLERANCE_MS = 10000;
const YT_DLP = process.env.YT_DLP_PATH || '/usr/local/bin/yt-dlp';
const COOKIES_FILE = path.join(__dirname, '..', 'cookies.txt');
const COOKIES_TMP  = path.join(__dirname, '..', 'cookies_tmp.txt');

// Copy cookies.txt → cookies_tmp.txt before each yt-dlp call so yt-dlp
// can write back whatever it wants without touching the source file.
function refreshCookiesTmp() {
  try {
    fs.copyFileSync(COOKIES_FILE, COOKIES_TMP);
  } catch (err) {
    console.error('[cookies] failed to copy cookies.txt:', err.message);
  }
}
const ytmusic = new YTMusic();
const ytmusicReady = ytmusic.initialize();

// Cookies are managed manually — upload fresh cookies.txt when they expire.

// --- CDN URL cache + yt-dlp queue (max 1 concurrent process) ---

const urlCache = new Map();        // videoId → { url, expiresAt }
const pendingResolves = new Map(); // videoId → Promise (dedup same-video calls)
const URL_CACHE_TTL = 5 * 60 * 60 * 1000; // 5h
const COOKIE_REFRESH_INTERVAL = 25 * 60 * 1000; // 25 minut

// Serialize all yt-dlp calls — YouTube rate-limits bursts from one IP
let ytdlpQueue = Promise.resolve();

// Cookie refresh state
let cookieRefreshPromise = null;
let lastCookieRefreshAt = Date.now(); // treat startup cookies as fresh

function getCachedUrl(videoId) {
  const entry = urlCache.get(videoId);
  if (entry && Date.now() < entry.expiresAt) return entry.url;
  urlCache.delete(videoId);
  return null;
}

function runYtdlp(videoId) {
  return new Promise((resolve, reject) => {
    function attempt(isRetry) {
      refreshCookiesTmp();
      execFile(
        YT_DLP,
        [
          '--get-url',
          '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
          '--no-playlist',
          '--cookies', COOKIES_TMP,
          '--js-runtimes', `node:${process.env.NODE_PATH || '/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node'}`,
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            const is429 = stderr.includes('429') || stderr.includes('Sign in to confirm');
            if (is429 && !isRetry) {
              // Reject with retriable marker — resolveUrl will re-queue after backoff
              return reject(Object.assign(new Error('429'), { retriable: true }));
            }
            return reject(err);
          }
          const audioUrl = stdout.trim().split('\n')[0];
          if (!audioUrl) return reject(new Error('yt-dlp returned no URL'));
          urlCache.set(videoId, { url: audioUrl, expiresAt: Date.now() + URL_CACHE_TTL });
          resolve(audioUrl);
        }
      );
    }
    attempt(false);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function refreshCookiesWithCamoufox() {
  if (cookieRefreshPromise) {
    console.log('[cookies] refresh already in progress — reusing promise');
    return cookieRefreshPromise;
  }
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'get_cookies.py');
  console.log('[cookies] launching Camoufox headful to refresh cookies...');
  cookieRefreshPromise = new Promise((resolve) => {
    execFile('python3', [SCRIPT], {
      timeout: 60000,
      env: { ...process.env, DISPLAY: ':99' },
    }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[cookies] Camoufox failed:', err.message);
      } else {
        lastCookieRefreshAt = Date.now();
        console.log('[cookies] Camoufox OK:', stderr.trim().split('\n').pop());
        refreshCookiesTmp();
      }
      resolve(); // zawsze resolve — nie blokuj retry przy błędzie
    });
  }).finally(() => { cookieRefreshPromise = null; });
  return cookieRefreshPromise;
}

function resolveUrl(videoId) {
  const cached = getCachedUrl(videoId);
  if (cached) return Promise.resolve(cached);

  if (pendingResolves.has(videoId)) {
    console.log(`[resolve] ${videoId} already in flight — reusing promise`);
    return pendingResolves.get(videoId);
  }

  // Chain onto the serialized queue — only one yt-dlp at a time.
  // pendingResolves entry stays alive through the entire retry cycle so
  // concurrent requests for the same videoId always reuse this promise.
  const promise = ytdlpQueue
    .then(async () => {
      const cached2 = getCachedUrl(videoId);
      if (cached2) return cached2;
      // Proactive cookie refresh — if cookies are stale, refresh before yt-dlp
      if (Date.now() - lastCookieRefreshAt > COOKIE_REFRESH_INTERVAL) {
        console.log('[cookies] proactive refresh — cookies stale, refreshing before yt-dlp...');
        await refreshCookiesWithCamoufox();
      }
      await sleep(1500);
      try {
        return await runYtdlp(videoId);
      } catch (err) {
        if (err.retriable) {
          console.warn(`[audio] 429 for ${videoId} — refreshing cookies then retrying...`);
          await refreshCookiesWithCamoufox();
          await sleep(1500);
          return runYtdlp(videoId); // one retry, inline — pendingResolves stays valid
        }
        throw err;
      }
    })
    .finally(() => pendingResolves.delete(videoId));

  ytdlpQueue = promise.catch(() => {});
  pendingResolves.set(videoId, promise);
  return promise;
}

async function odesliLookup(trackId) {
  try {
    const url = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(`https://open.spotify.com/track/${trackId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const platforms = data.linksByPlatform ?? {};
    for (const key of ['youtubeMusic', 'youtube']) {
      const link = platforms[key]?.url;
      if (link) {
        const videoId = new URL(link).searchParams.get('v');
        if (videoId) return videoId;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// --- Routes ---

const INSTRUMENTAL_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?)\b|[\[(（]inst[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;

// GET /youtube/search?track=...&artist=...&duration_ms=...&track_id=...
router.get('/search', async (req, res) => {
  const { track, artist, duration_ms, track_id } = req.query;

  if (!track || !artist || !duration_ms) {
    return res.status(400).json({ error: 'track, artist and duration_ms are required' });
  }

  const targetMs = parseInt(duration_ms, 10);

  if (track_id) {
    const cached = await prisma.track.findUnique({
      where: { id: track_id },
      include: { blacklist: true },
    });

    if (cached) {
      // All sources already exhausted — no re-search possible
      if (cached.allSourcesTried) {
        console.log(`[search] allSourcesTried for ${track_id}`);
        return res.json({ videoId: cached.videoId, allSourcesTried: true });
      }

      const blacklistedIds = new Set(cached.blacklist.map((b) => b.videoId));

      // prefer_duration (not_ideal) — bypass cache, text search sorted by duration
      if (cached.searchMode === 'prefer_duration') {
        console.log(`[search] prefer_duration for ${track_id}, searching for better duration match`);
        await ytmusicReady;
        const pdResults = await ytmusic.searchSongs(`${track} ${artist}`);
        const candidates = pdResults
          .filter((s) => s.videoId && s.duration && !INSTRUMENTAL_RE.test(s.name))
          .sort((a, b) => Math.abs(a.duration * 1000 - targetMs) - Math.abs(b.duration * 1000 - targetMs));
        const pdMatch = candidates[0] ?? null;
        await prisma.track.update({
          where: { id: track_id },
          data: {
            ...(pdMatch ? { videoId: pdMatch.videoId, ytTitle: pdMatch.name, source: 'search' } : {}),
            searchMode: 'default',
            not_ideal: false,
          },
        });
        const pdFinalId = pdMatch ? pdMatch.videoId : cached.videoId;
        console.log(`[search] prefer_duration result for ${track_id} → ${pdFinalId}${pdMatch ? '' : ' (no better found, keeping current)'}`);
        return res.json({ videoId: pdFinalId, allSourcesTried: false });
      }

      // Cache valid — current videoId not on blacklist
      if (!blacklistedIds.has(cached.videoId)) {
        console.log(`[search] cache hit for ${track_id}`);
        // Backfill ytTitle in background if missing
        if (!cached.ytTitle) {
          ytmusicReady
            .then(() => ytmusic.searchSongs(`${track} ${artist}`))
            .then((results) => {
              const match = results.find((s) => s.videoId === cached.videoId);
              if (match?.name) {
                console.log(`[search] backfilling ytTitle for ${track_id}: ${match.name}`);
                return prisma.track.update({ where: { id: track_id }, data: { ytTitle: match.name } });
              }
            })
            .catch(() => {});
        }
        return res.json({ videoId: cached.videoId, allSourcesTried: false });
      }

      // Current videoId is blacklisted — re-search
      console.log(`[search] ${track_id} blacklisted, re-searching (mode=${cached.searchMode})`);

      // Odesli — only for default mode (bugged), not for prefer_duration (not_ideal)
      if (cached.searchMode === 'default') {
        const odesliId = await odesliLookup(track_id);
        if (odesliId && !blacklistedIds.has(odesliId)) {
          console.log(`[search] odesli re-hit for ${track_id} → ${odesliId}`);
          await prisma.track.update({
            where: { id: track_id },
            data: { videoId: odesliId, source: 'odesli', searchMode: 'default', not_ideal: false, bugged: false },
          });
          return res.json({ videoId: odesliId, allSourcesTried: false });
        }
      }

      // Text search — exclude blacklisted and instrumentals
      await ytmusicReady;
      const results = await ytmusic.searchSongs(`${track} ${artist}`);
      const candidates = results.filter(
        (s) => s.videoId && s.duration && !blacklistedIds.has(s.videoId) && !INSTRUMENTAL_RE.test(s.name)
      );

      let match = null;
      if (cached.searchMode === 'prefer_duration') {
        // Sort by closest duration — no hard tolerance
        candidates.sort((a, b) => Math.abs(a.duration * 1000 - targetMs) - Math.abs(b.duration * 1000 - targetMs));
        match = candidates[0] ?? null;
      } else {
        // Standard — within ±10s tolerance
        match = candidates.find((s) => Math.abs(s.duration * 1000 - targetMs) <= DURATION_TOLERANCE_MS) ?? null;
      }

      if (match) {
        console.log(`[search] re-search text hit for ${track_id} → ${match.videoId}`);
        await prisma.track.update({
          where: { id: track_id },
          data: { videoId: match.videoId, ytTitle: match.name, source: 'search', searchMode: 'default', not_ideal: false, bugged: false },
        });
        return res.json({ videoId: match.videoId, allSourcesTried: false });
      }

      // Nothing found — Odesli emergency whitelist
      console.log(`[search] all sources exhausted for ${track_id}, using Odesli emergency whitelist`);
      const emergencyId = await odesliLookup(track_id);
      const finalId = emergencyId ?? cached.videoId;
      await prisma.track.update({
        where: { id: track_id },
        data: { videoId: finalId, allSourcesTried: true, searchMode: 'default', not_ideal: false, bugged: false },
      });
      return res.json({ videoId: finalId, allSourcesTried: true });
    }
  }

  // First-time search — no Track in DB yet

  // Odesli lookup
  if (track_id) {
    const videoId = await odesliLookup(track_id);
    if (videoId) {
      console.log(`[search] odesli hit for ${track_id} → ${videoId}`);
      await prisma.track.upsert({
        where: { id: track_id },
        create: { id: track_id, videoId, track, artist, source: 'odesli' },
        update: { videoId, source: 'odesli' },
      });
      return res.json({ videoId, allSourcesTried: false });
    }
    console.log(`[search] odesli miss for ${track_id}, falling back to search`);
  }

  await ytmusicReady;
  const results = await ytmusic.searchSongs(`${track} ${artist}`);
  const durationMatches = results.filter(
    (s) => s.duration && Math.abs(s.duration * 1000 - targetMs) <= DURATION_TOLERANCE_MS
  );
  const match = durationMatches.find((s) => !INSTRUMENTAL_RE.test(s.name)) ?? durationMatches[0] ?? null;
  const videoId = match ? match.videoId : null;

  if (videoId && track_id) {
    await prisma.track.upsert({
      where: { id: track_id },
      create: { id: track_id, videoId, track, artist, ytTitle: match.name, source: 'search' },
      update: { videoId, ytTitle: match.name, source: 'search' },
    });
  }

  res.json({ videoId: videoId ?? null, allSourcesTried: false });
});

// GET /youtube/track/:id
router.get('/track/:id', async (req, res) => {
  const track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: 'not found' });
  res.json(track);
});

// PATCH /youtube/track/:id — blacklistuje videoId i ustawia tryb re-searchu
router.patch('/track/:id', async (req, res) => {
  const { not_ideal, bugged } = req.body;
  if (!not_ideal && !bugged) return res.status(400).json({ error: 'not_ideal or bugged required' });

  const reason = not_ideal ? 'not_ideal' : 'bugged';

  try {
    const track = await prisma.track.findUnique({ where: { id: req.params.id } });
    if (!track) return res.status(404).json({ error: 'track not found' });

    if (reason === 'bugged') {
      await prisma.videoBlacklist.upsert({
        where: { trackId_videoId: { trackId: req.params.id, videoId: track.videoId } },
        create: { trackId: req.params.id, videoId: track.videoId, reason },
        update: { reason },
      });
    }

    await prisma.track.update({
      where: { id: req.params.id },
      data: {
        not_ideal: reason === 'not_ideal',
        bugged: reason === 'bugged',
        allSourcesTried: false,
        searchMode: reason === 'not_ideal' ? 'prefer_duration' : 'default',
      },
    });

    res.json({ ok: true });
  } catch (_) {
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /youtube/prefetch/:videoId — resolves CDN URL in background and caches it
router.get('/prefetch/:videoId', (req, res) => {
  const { videoId } = req.params;
  const cached = getCachedUrl(videoId);
  if (cached) {
    console.log(`[prefetch] ${videoId} already cached`);
    return res.json({ ok: true, cached: true });
  }
  res.json({ ok: true, cached: false });
  console.log(`[prefetch] ${videoId} resolving in background...`);
  resolveUrl(videoId)
    .then(() => console.log(`[prefetch] ${videoId} cached OK`))
    .catch((err) => console.error(`[prefetch] ${videoId} failed:`, err.message));
});

// GET /youtube/audio/:videoId — zwraca 302 do CDN (z cache lub przez yt-dlp)
router.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const cached = getCachedUrl(videoId);
  if (cached) {
    console.log(`[audio] ${videoId} → cache hit`);
    return res.redirect(302, cached);
  }
  console.log(`[audio] ${videoId} → resolving via yt-dlp`);
  try {
    const audioUrl = await resolveUrl(videoId);
    res.redirect(302, audioUrl);
  } catch (err) {
    console.error(`[audio] yt-dlp error for ${videoId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { search: searchConfig } = require('@listenalong/config');
const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const YTMusic = require('ytmusic-api');
const { prisma } = require('../lib/db');

const router = express.Router();
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

const NOISE_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?|nightcore|nighcore|cover|ai\s+cover|slowed|reverb|sped[\s-]?up|speed[\s-]?up|(?:english|spanish|french|portuguese|german|italian|dutch|korean|chinese)\s+(?:ver(?:sion)?\.?|dub)|translat(?:ion|ed))\b|[\[(（](?:inst|english)[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;
const ODESLI_BONUS_MS = searchConfig.odesliBonus;

async function searchYouTube(track, artist) {
  return new Promise((resolve) => {
    refreshCookiesTmp();
    execFile(
      YT_DLP,
      [
        '--no-download', '--print', '%(id)s\t%(duration)s\t%(title)s',
        '--cookies', COOKIES_TMP,
        '--js-runtimes', `node:${process.env.NODE_PATH || '/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node'}`,
        `ytsearch${searchConfig.ytSearchCount}:${track} ${artist}`,
      ],
      { timeout: 12000 },
      (err, stdout) => {
        // On timeout yt-dlp is killed but stdout may contain partial results — use them
        if (err && !stdout) { resolve([]); return; }
        resolve(
          (stdout ?? '').trim().split('\n')
            .map((line) => {
              const [id, dur, ...rest] = line.split('\t');
              return { videoId: id, durationMs: parseInt(dur, 10) * 1000, title: rest.join('\t') };
            })
            .filter((r) => r.videoId && r.durationMs > 0)
        );
      }
    );
  });
}

// Returns 0..1 — fraction of track+artist words present in title
function titleRelevance(title, track, artist) {
  if (!title) return 0;
  const t = title.toLowerCase();
  const words = `${track} ${artist}`.toLowerCase()
    .replace(/_/g, ' ')
    .split(/[\s,\-–()/]+/)
    .filter((w) => w.length > 3);
  if (!words.length) return 0;
  return words.filter((w) => t.includes(w)).length / words.length;
}

const TITLE_BONUS_MS = searchConfig.titleBonus;

// CJK: hiragana, katakana, CJK unified ideographs, Hangul syllables
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SCRIPT_BONUS_MS = searchConfig.scriptBonus;

function scriptBonus(title, track, artist) {
  if (!CJK_RE.test(track) && !CJK_RE.test(artist)) return 0;
  return CJK_RE.test(title ?? '') ? SCRIPT_BONUS_MS : 0;
}

async function searchAllSources(track, artist, targetMs, trackId, blacklistedIds = new Set()) {
  const [odesliResult, ytMusicResult, ytSearchResult] = await Promise.allSettled([
    trackId ? odesliLookup(trackId) : Promise.resolve(null),
    ytmusicReady.then(() => ytmusic.searchSongs(`${track} ${artist}`)).catch(() => []),
    searchYouTube(track, artist),
  ]);

  const odesliId = odesliResult.status === 'fulfilled' ? odesliResult.value : null;
  if (ytMusicResult.status === 'rejected') console.warn(`[search] ytmusic failed: ${ytMusicResult.reason}`);
  if (ytSearchResult.status === 'rejected') console.warn(`[search] ytsearch failed: ${ytSearchResult.reason}`);

  const candidates = [];
  const seen = new Set();

  function addCandidate(videoId, durationMs, title, source) {
    if (!videoId || blacklistedIds.has(videoId) || NOISE_RE.test(title ?? '')) return;
    const isOdesli = videoId === odesliId;
    const deltaMs = Math.abs(durationMs - targetMs);
    const effectiveSource = isOdesli ? `odesli+${source}` : source;
    if (seen.has(videoId)) {
      const ex = candidates.find((c) => c.videoId === videoId);
      if (ex && !ex.source.includes(source)) ex.source += `+${source}`;
      return;
    }
    seen.add(videoId);
    candidates.push({ videoId, title, deltaMs, source: effectiveSource });
  }

  for (const s of (ytMusicResult.status === 'fulfilled' ? (ytMusicResult.value ?? []) : [])) {
    if (s.videoId && s.duration) addCandidate(s.videoId, s.duration * 1000, s.name, 'ytmusic');
  }
  for (const s of (ytSearchResult.status === 'fulfilled' ? (ytSearchResult.value ?? []) : [])) {
    addCandidate(s.videoId, s.durationMs, s.title, 'ytsearch');
  }

  // Pure Odesli — not found in any search result, trust it with neutral score
  if (odesliId && !blacklistedIds.has(odesliId) && !seen.has(odesliId)) {
    candidates.push({ videoId: odesliId, title: null, deltaMs: ODESLI_BONUS_MS, source: 'odesli' });
  }

  if (!candidates.length) return null;

  // Score: lower = better
  // Odesli gets ODESLI_BONUS_MS advantage; title relevance gives up to TITLE_BONUS_MS advantage
  candidates.sort((a, b) => {
    const sa = a.deltaMs
      - (a.source.includes('odesli') ? ODESLI_BONUS_MS : 0)
      - titleRelevance(a.title, track, artist) * TITLE_BONUS_MS
      - scriptBonus(a.title, track, artist);
    const sb = b.deltaMs
      - (b.source.includes('odesli') ? ODESLI_BONUS_MS : 0)
      - titleRelevance(b.title, track, artist) * TITLE_BONUS_MS
      - scriptBonus(b.title, track, artist);
    return sa - sb;
  });

  return candidates[0];
}

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
      if (cached.allSourcesTried) {
        console.log(`[search] allSourcesTried for ${track_id}`);
        return res.json({ videoId: cached.videoId, allSourcesTried: true });
      }

      const blacklistedIds = new Set(cached.blacklist.map((b) => b.videoId));

      // Cache hit — not blacklisted and no re-search pending
      if (!blacklistedIds.has(cached.videoId) && cached.searchMode !== 'prefer_duration') {
        console.log(`[search] cache hit for ${track_id}`);
        // Backfill missing metadata in background
        if (!cached.ytTitle || !cached.track || !cached.artist) {
          const metaUpdate = {};
          if (!cached.track && track) metaUpdate.track = track;
          if (!cached.artist && artist) metaUpdate.artist = artist;
          if (!cached.ytTitle) {
            ytmusicReady
              .then(() => ytmusic.searchSongs(`${track} ${artist}`))
              .then((results) => {
                const match = (results ?? []).find((s) => s.videoId === cached.videoId);
                if (match?.name) metaUpdate.ytTitle = match.name;
                if (Object.keys(metaUpdate).length) {
                  console.log(`[search] backfilling [${Object.keys(metaUpdate).join(', ')}] for ${track_id}`);
                  return prisma.track.update({ where: { id: track_id }, data: metaUpdate });
                }
              })
              .catch(() => {});
          } else if (Object.keys(metaUpdate).length) {
            console.log(`[search] backfilling [${Object.keys(metaUpdate).join(', ')}] for ${track_id}`);
            prisma.track.update({ where: { id: track_id }, data: metaUpdate }).catch(() => {});
          }
        }
        return res.json({ videoId: cached.videoId, allSourcesTried: false });
      }

      // Re-search: blacklisted videoId or prefer_duration mode
      const reason = cached.searchMode === 'prefer_duration' ? 'prefer_duration' : 'blacklisted';
      console.log(`[search] re-search for ${track_id} (reason=${reason})`);

      const winner = await searchAllSources(track, artist, targetMs, track_id, blacklistedIds);
      if (winner) {
        console.log(`[search] re-search winner for ${track_id} → ${winner.videoId} (${winner.source})`);
        await prisma.track.update({
          where: { id: track_id },
          data: {
            videoId: winner.videoId,
            ...(winner.title ? { ytTitle: winner.title } : {}),
            source: winner.source,
            searchMode: 'default',
            not_ideal: false,
            bugged: false,
          },
        });
        return res.json({ videoId: winner.videoId, allSourcesTried: false });
      }

      console.log(`[search] all sources exhausted for ${track_id}`);
      await prisma.track.update({
        where: { id: track_id },
        data: { allSourcesTried: true, searchMode: 'default', not_ideal: false, bugged: false },
      });
      return res.json({ videoId: cached.videoId, allSourcesTried: true });
    }
  }

  // First-time search
  const winner = await searchAllSources(track, artist, targetMs, track_id ?? null);
  if (!winner) {
    return res.json({ videoId: null, allSourcesTried: false });
  }

  console.log(`[search] first-time winner for ${track_id ?? '(no id)'} → ${winner.videoId} (${winner.source})`);

  if (track_id) {
    await prisma.track.upsert({
      where: { id: track_id },
      create: { id: track_id, videoId: winner.videoId, track, artist, ...(winner.title ? { ytTitle: winner.title } : {}), source: winner.source },
      update: { videoId: winner.videoId, ...(winner.title ? { ytTitle: winner.title } : {}), source: winner.source },
    });
  }

  return res.json({ videoId: winner.videoId, allSourcesTried: false });
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

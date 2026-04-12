const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const YTMusic = require('ytmusic-api');

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
const TRACK_CACHE_FILE = path.join(__dirname, '..', 'cache.json');

const ytmusic = new YTMusic();
const ytmusicReady = ytmusic.initialize();

// --- Persistent track→videoId cache (survives restarts) ---

let trackCache = {};
try {
  const raw = JSON.parse(fs.readFileSync(TRACK_CACHE_FILE, 'utf8'));
  // Migrate old format (string videoId) to new format (object)
  for (const [id, val] of Object.entries(raw)) {
    trackCache[id] = typeof val === 'string' ? { videoId: val } : val;
  }
  console.log(`[cache] loaded ${Object.keys(trackCache).length} entries from cache.json`);
} catch (_) {}

function saveTrackCache() {
  fs.writeFileSync(TRACK_CACHE_FILE, JSON.stringify(trackCache, null, 2));
}

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

// --- Routes ---

// GET /youtube/search?track=...&artist=...&duration_ms=...&track_id=...
router.get('/search', async (req, res) => {
  const { track, artist, duration_ms, track_id } = req.query;

  if (!track || !artist || !duration_ms) {
    return res.status(400).json({ error: 'track, artist and duration_ms are required' });
  }

  // Persistent cache hit — no ytmusic-api call needed
  if (track_id && trackCache[track_id]) {
    console.log(`[search] cache hit for ${track_id}`);
    return res.json({ videoId: trackCache[track_id].videoId });
  }

  const targetMs = parseInt(duration_ms, 10);

  await ytmusicReady;
  const results = await ytmusic.searchSongs(`${track} ${artist}`);

  const INSTRUMENTAL_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?)\b|[\[(（]inst[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;

  const durationMatches = results.filter((song) => {
    if (!song.duration) return false;
    return Math.abs(song.duration * 1000 - targetMs) <= DURATION_TOLERANCE_MS;
  });

  const match = durationMatches.find((s) => !INSTRUMENTAL_RE.test(s.name)) ?? durationMatches[0] ?? null;

  const videoId = match ? match.videoId : null;

  if (videoId && track_id) {
    trackCache[track_id] = { videoId, track, artist, ytTitle: match.name };
    saveTrackCache();
  }

  res.json({ videoId });
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

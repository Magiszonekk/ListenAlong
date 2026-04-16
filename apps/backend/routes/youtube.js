const { search: searchConfig, cache: cacheConfig } = require('@listenalong/config');
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
const permanentlyFailed = new Set(); // videoId → no audio formats (cleared on restart)
const COOKIE_REFRESH_INTERVAL = 25 * 60 * 1000; // 25 minut

// Priority levels for URL resolution
const PRIO = { DIRECT: 0, PREFETCH: 1, WARM: 2 };

// Priority queue for yt-dlp calls.
// Items with lower priority value run first (DIRECT=0 > PREFETCH=1 > WARM=2).
// A higher-priority item preempts the running item by aborting its AbortController —
// Python's ThreadingHTTPServer handles the in-flight request to completion in its own
// thread while Node immediately starts the higher-priority item.
class YtdlpQueue {
  #queue = [];    // { videoId, priority, ac, workFn, resolve, reject }
  #active = null; // currently executing item
  #running = false;

  enqueue(videoId, priority, workFn) {
    const ac = new AbortController();
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const item = { videoId, priority, ac, workFn, resolve, reject };

    const insertAt = this.#queue.findIndex(i => i.priority > priority);
    if (insertAt === -1) this.#queue.push(item);
    else this.#queue.splice(insertAt, 0, item);

    // Preempt if new item outranks the running one
    if (this.#active && priority < this.#active.priority) {
      console.log(`[queue] preempting ${this.#active.videoId} (prio=${this.#active.priority}) for ${videoId} (prio=${priority})`);
      this.#active.ac.abort();
    }

    this.#maybeRun();
    return promise;
  }

  // Promote a queued or active item to a higher priority (lower number)
  promote(videoId, priority) {
    if (this.#active?.videoId === videoId && priority < this.#active.priority) {
      this.#active.priority = priority;
    }
    const item = this.#queue.find(i => i.videoId === videoId);
    if (item && priority < item.priority) {
      item.priority = priority;
      this.#queue.sort((a, b) => a.priority - b.priority);
    }
  }

  // Cancel a queued or active item (e.g. HTTP client disconnected)
  cancel(videoId) {
    const idx = this.#queue.findIndex(i => i.videoId === videoId);
    if (idx !== -1) {
      const [item] = this.#queue.splice(idx, 1);
      item.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      return;
    }
    if (this.#active?.videoId === videoId) this.#active.ac.abort();
  }

  #maybeRun() {
    if (!this.#running && this.#queue.length > 0) this.#run();
  }

  async #run() {
    this.#running = true;
    while (this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (item.ac.signal.aborted) {
        item.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        continue;
      }
      this.#active = item;
      try {
        item.resolve(await item.workFn(item.ac.signal));
      } catch (err) {
        item.reject(err);
      } finally {
        this.#active = null;
      }
    }
    this.#running = false;
  }
}

const ytdlpQueue = new YtdlpQueue();
let lastYtdlpAt = 0; // timestamp of last yt-dlp start — throttle only consecutive calls

const YTDLP_PORT = process.env.YTDLP_SERVER_PORT || 9091;

// Cookie refresh state
let cookieRefreshPromise = null;
let lastCookieRefreshAt = Date.now(); // treat startup cookies as fresh

function getCachedUrl(videoId) {
  const entry = urlCache.get(videoId);
  if (entry && Date.now() < entry.expiresAt) return entry.url;
  if (entry) {
    urlCache.delete(videoId);
    prisma.urlCache.delete({ where: { videoId } }).catch(() => {});
  }
  return null;
}

async function purgeExpiredUrlCache() {
  try {
    const { count } = await prisma.urlCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (count) console.log(`[cache] purged ${count} expired URL entries from DB`);
  } catch (err) {
    console.error('[cache] DB purge failed:', err.message);
  }
}

// Restore valid URL cache entries from DB on startup, purge expired ones immediately
(async () => {
  try {
    const [entries] = await Promise.all([
      prisma.urlCache.findMany({ where: { expiresAt: { gt: new Date() } } }),
      purgeExpiredUrlCache(),
    ]);
    for (const e of entries) urlCache.set(e.videoId, { url: e.url, expiresAt: e.expiresAt.getTime() });
    if (entries.length) console.log(`[cache] restored ${entries.length} URLs from DB`);
  } catch (err) {
    console.error('[cache] DB restore failed:', err.message);
  }
})();

// Purge expired entries from DB every hour (CDN URLs expire in ~6h)
setInterval(purgeExpiredUrlCache, 60 * 60 * 1000);

// Pre-warm CDN URL cache for top-N most played tracks.
// Phase 1: proactively re-search tracks with blacklisted/stale videoIds.
// Phase 2: refresh CDN URLs for clean tracks whose TTL is running low.
async function warmUrlCache() {
  try {
    const topPlays = await prisma.play.groupBy({
      by: ['trackId'],
      _count: { trackId: true },
      orderBy: { _count: { trackId: 'desc' } },
      take: cacheConfig.warmTopN,
    });
    if (!topPlays.length) return;

    const trackIds = topPlays.map(t => t.trackId);
    const tracks = await prisma.track.findMany({
      where: { id: { in: trackIds }, allSourcesTried: false },
      select: {
        id: true, videoId: true, track: true, artist: true, durationMs: true,
        bugged: true,
        blacklist: { select: { videoId: true } },
      },
    });

    const needsResearch = tracks.filter(t => t.bugged);
    const cleanTracks = tracks.filter(t => !t.bugged);

    // --- Phase 1: proactive re-search for blacklisted tracks ---
    if (needsResearch.length) {
      console.log(`[warmer] pre-searching ${needsResearch.length} blacklisted tracks...`);
      for (const t of needsResearch) {
        if (!t.track || !t.artist) continue;
        const blacklistedIds = new Set(t.blacklist.map(b => b.videoId));
        try {
          const winner = await searchAllSources(t.track, t.artist, t.durationMs, blacklistedIds);
          const valid = winner && !permanentlyFailed.has(winner.videoId) ? winner : null;
          if (valid) {
            console.log(`[warmer] re-search winner for ${t.id} → ${valid.videoId} (${valid.source})`);
            await prisma.track.update({
              where: { id: t.id },
              data: {
                videoId: valid.videoId,
                ...(valid.title ? { ytTitle: valid.title } : {}),
                source: valid.source,
                bugged: false,
              },
            });
            if (!getCachedUrl(valid.videoId)) {
              try {
                await resolveUrl(valid.videoId, PRIO.WARM);
                console.log(`[warmer] warmed ${valid.videoId} (re-search)`);
              } catch (err) {
                console.warn(`[warmer] failed to warm ${valid.videoId}: ${err.message}`);
              }
            }
          } else {
            console.log(`[warmer] re-search no winner for ${t.id} — marking allSourcesTried`);
            await prisma.track.update({
              where: { id: t.id },
              data: { allSourcesTried: true, bugged: false },
            });
          }
        } catch (err) {
          console.warn(`[warmer] re-search failed for ${t.id}: ${err.message}`);
        }
      }
    }

    // --- Phase 2: refresh stale CDN URLs for clean tracks ---
    const minTtlMs = cacheConfig.warmMinTtlM * 60 * 1000;
    const stale = cleanTracks.filter(t => {
      const entry = urlCache.get(t.videoId);
      return !entry || (entry.expiresAt - Date.now()) < minTtlMs;
    });

    if (!stale.length) return;
    console.log(`[warmer] refreshing ${stale.length} stale URLs...`);

    for (const track of stale) {
      if (getCachedUrl(track.videoId)) continue;
      try {
        await resolveUrl(track.videoId, PRIO.WARM);
        console.log(`[warmer] warmed ${track.videoId}`);
      } catch (err) {
        console.warn(`[warmer] failed ${track.videoId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[warmer] error:', err.message);
  }
}

if (cacheConfig.warmEnabled) {
  setTimeout(() => warmUrlCache(), 60_000);
  setInterval(() => warmUrlCache(), 4 * 60 * 60 * 1000);
}

async function runYtdlp(videoId, signal) {
  refreshCookiesTmp(); // ensure worker reads fresh cookies
  let res;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      res = await fetch(`http://127.0.0.1:${YTDLP_PORT}/audio/${videoId}`, { signal: combinedSignal });
      break;
    } catch (err) {
      if (signal?.aborted) throw err; // don't retry if preempted/cancelled
      if (err.cause?.code === 'ECONNREFUSED' && attempt < 9) {
        if (attempt === 0) console.warn('[ytdlp] worker not ready, retrying...');
        await sleep(500);
      } else {
        throw err;
      }
    }
  }
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = data.error || 'ytdlp worker error';
    const is429 = msg.includes('429') || msg.includes('Sign in to confirm');
    if (is429) throw Object.assign(new Error('429'), { retriable: true });
    const isPermanent = msg.includes('Requested format is not available');
    if (isPermanent) throw Object.assign(new Error(msg), { permanent: true });
    throw new Error(msg);
  }
  let expiresAt;
  try {
    const expireParam = new URL(data.url).searchParams.get('expire');
    if (!expireParam) {
      console.warn(`[cache] no expire= param in CDN URL for ${videoId} — using fallback TTL`);
      expiresAt = Date.now() + 5.5 * 3600 * 1000;
    } else {
      expiresAt = Number(expireParam) * 1000 - 5 * 60 * 1000; // 5-min buffer before actual expiry
    }
  } catch (_) {
    expiresAt = Date.now() + 5.5 * 3600 * 1000;
  }
  urlCache.set(videoId, { url: data.url, expiresAt });
  prisma.urlCache.upsert({
    where: { videoId },
    create: { videoId, url: data.url, expiresAt: new Date(expiresAt) },
    update: { url: data.url, expiresAt: new Date(expiresAt) },
  }).catch((err) => console.error(`[cache] DB write failed for ${videoId}:`, err.message));
  return data.url;
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

function autoBlacklist(videoId) {
  prisma.track.findFirst({ where: { videoId }, select: { id: true } })
    .then((track) => {
      if (!track) return;
      console.log(`[audio] auto-blacklisting ${videoId} (track ${track.id}) — no playable formats`);
      return prisma.$transaction([
        prisma.videoBlacklist.upsert({
          where: { trackId_videoId: { trackId: track.id, videoId } },
          create: { trackId: track.id, videoId, reason: 'format_unavailable' },
          update: { reason: 'format_unavailable' },
        }),
        prisma.track.update({
          where: { id: track.id },
          data: { bugged: true, allSourcesTried: false },
        }),
      ]);
    })
    .catch((err) => console.error(`[audio] auto-blacklist failed for ${videoId}:`, err.message));
}

function resolveUrl(videoId, priority = PRIO.DIRECT) {
  const cached = getCachedUrl(videoId);
  if (cached) return Promise.resolve(cached);

  if (permanentlyFailed.has(videoId)) {
    return Promise.reject(new Error(`${videoId}: no playable formats (permanently failed)`));
  }

  if (pendingResolves.has(videoId)) {
    console.log(`[resolve] ${videoId} already in flight — reusing promise`);
    ytdlpQueue.promote(videoId, priority);
    return pendingResolves.get(videoId);
  }

  // Work function executed inside the priority queue — runs after higher-priority items.
  // pendingResolves entry stays alive through the entire retry cycle so concurrent
  // requests for the same videoId always reuse this promise.
  const workFn = async (signal) => {
    const cached2 = getCachedUrl(videoId);
    if (cached2) return cached2;
    // Proactive cookie refresh — if cookies are stale, refresh before yt-dlp
    if (Date.now() - lastCookieRefreshAt > COOKIE_REFRESH_INTERVAL) {
      console.log('[cookies] proactive refresh — cookies stale, refreshing before yt-dlp...');
      await refreshCookiesWithCamoufox();
    }
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const gap = Date.now() - lastYtdlpAt;
    const waitMs = Math.max(0, 1500 - gap);
    if (waitMs > 0) await sleep(waitMs);
    lastYtdlpAt = Date.now();
    try {
      return await runYtdlp(videoId, signal);
    } catch (err) {
      if (err.permanent) {
        permanentlyFailed.add(videoId);
        autoBlacklist(videoId);
      } else if (err.retriable) {
        console.warn(`[audio] 429 for ${videoId} — refreshing cookies then retrying...`);
        await refreshCookiesWithCamoufox();
        if (signal.aborted) throw err;
        await sleep(1500);
        return runYtdlp(videoId, signal); // one retry — pendingResolves stays valid
      }
      throw err;
    }
  };

  const promise = ytdlpQueue.enqueue(videoId, priority, workFn)
    .finally(() => pendingResolves.delete(videoId));

  pendingResolves.set(videoId, promise);
  return promise;
}

// --- Routes ---

const NOISE_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?|nightcore|nighcore|cover|ai\s+cover|slowed|reverb|sped[\s-]?up|speed[\s-]?up|(?:english|spanish|french|portuguese|german|italian|dutch|korean|chinese)\s+(?:ver(?:sion)?\.?|dub)|translat(?:ion|ed))\b|[\[(（](?:inst|english)[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;

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

async function searchAllSources(track, artist, targetMs, blacklistedIds = new Set()) {
  const [ytMusicResult, ytSearchResult] = await Promise.allSettled([
    ytmusicReady.then(() => ytmusic.searchSongs(`${track} ${artist}`)).catch(() => []),
    searchYouTube(track, artist),
  ]);

  if (ytMusicResult.status === 'rejected') console.warn(`[search] ytmusic failed: ${ytMusicResult.reason}`);
  if (ytSearchResult.status === 'rejected') console.warn(`[search] ytsearch failed: ${ytSearchResult.reason}`);

  const candidates = [];
  const seen = new Set();

  function addCandidate(videoId, durationMs, title, source) {
    if (!videoId || blacklistedIds.has(videoId) || NOISE_RE.test(title ?? '')) return;
    const deltaMs = Math.abs(durationMs - targetMs);
    if (seen.has(videoId)) {
      const ex = candidates.find((c) => c.videoId === videoId);
      if (ex && !ex.source.includes(source)) ex.source += `+${source}`;
      return;
    }
    seen.add(videoId);
    candidates.push({ videoId, title, deltaMs, source });
  }

  for (const s of (ytMusicResult.status === 'fulfilled' ? (ytMusicResult.value ?? []) : [])) {
    if (s.videoId && s.duration) addCandidate(s.videoId, s.duration * 1000, s.name, 'ytmusic');
  }
  for (const s of (ytSearchResult.status === 'fulfilled' ? (ytSearchResult.value ?? []) : [])) {
    addCandidate(s.videoId, s.durationMs, s.title, 'ytsearch');
  }

  if (!candidates.length) return null;

  // Score: lower = better. Title relevance and script match reduce effective distance.
  candidates.sort((a, b) => {
    const sa = a.deltaMs
      - titleRelevance(a.title, track, artist) * TITLE_BONUS_MS
      - scriptBonus(a.title, track, artist);
    const sb = b.deltaMs
      - titleRelevance(b.title, track, artist) * TITLE_BONUS_MS
      - scriptBonus(b.title, track, artist);
    return sa - sb;
  });

  // Filter out videos that failed permanently while this search was in flight
  const valid = candidates.filter(c => !permanentlyFailed.has(c.videoId));
  return valid[0] ?? null;
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
      if (req.query.blacklist) {
        String(req.query.blacklist).split(',').forEach((id) => blacklistedIds.add(id));
      }

      // Cache hit — not blacklisted and not permanently failed.
      if (!blacklistedIds.has(cached.videoId) && !permanentlyFailed.has(cached.videoId)) {
        console.log(`[search] cache hit for ${track_id}`);
        if (!getCachedUrl(cached.videoId)) resolveUrl(cached.videoId, PRIO.PREFETCH).catch(() => {});
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

      console.log(`[search] re-search for ${track_id} (reason=blacklisted)`);

      const winner = await searchAllSources(track, artist, targetMs, blacklistedIds);
      // Belt-and-suspenders: reject winner if it became permanently failed while search was in flight
      const validWinner = winner && !permanentlyFailed.has(winner.videoId) ? winner : null;
      if (validWinner) {
        console.log(`[search] re-search winner for ${track_id} → ${validWinner.videoId} (${validWinner.source})`);
        if (!getCachedUrl(validWinner.videoId)) resolveUrl(validWinner.videoId, PRIO.PREFETCH).catch(() => {});
        await prisma.track.update({
          where: { id: track_id },
          data: {
            videoId: validWinner.videoId,
            ...(validWinner.title ? { ytTitle: validWinner.title } : {}),
            source: validWinner.source,
            bugged: false,
            durationMs: targetMs,
          },
        });
        return res.json({ videoId: validWinner.videoId, allSourcesTried: false });
      }

      console.log(`[search] all sources exhausted for ${track_id}`);
      await prisma.track.update({
        where: { id: track_id },
        data: { allSourcesTried: true, bugged: false },
      });
      return res.json({ videoId: cached.videoId, allSourcesTried: true });
    }
  }

  // First-time search
  const blacklistedIds = new Set();
  if (req.query.blacklist) {
    String(req.query.blacklist).split(',').forEach((id) => blacklistedIds.add(id));
  }
  const winner = await searchAllSources(track, artist, targetMs, blacklistedIds);
  if (!winner) {
    return res.json({ videoId: null, allSourcesTried: false });
  }

  console.log(`[search] first-time winner for ${track_id ?? '(no id)'} → ${winner.videoId} (${winner.source})`);
  if (!getCachedUrl(winner.videoId)) resolveUrl(winner.videoId, PRIO.PREFETCH).catch(() => {});

  if (track_id) {
    await prisma.track.upsert({
      where: { id: track_id },
      create: { id: track_id, videoId: winner.videoId, track, artist, durationMs: targetMs, ...(winner.title ? { ytTitle: winner.title } : {}), source: winner.source },
      update: { videoId: winner.videoId, durationMs: targetMs, ...(winner.title ? { ytTitle: winner.title } : {}), source: winner.source },
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

// PATCH /youtube/track/:id — blacklist current videoId and trigger a fresh search
router.patch('/track/:id', async (req, res) => {
  const { bugged } = req.body;
  if (!bugged) return res.status(400).json({ error: 'bugged required' });

  try {
    const track = await prisma.track.findUnique({ where: { id: req.params.id } });
    if (!track) return res.status(404).json({ error: 'track not found' });

    await prisma.videoBlacklist.upsert({
      where: { trackId_videoId: { trackId: req.params.id, videoId: track.videoId } },
      create: { trackId: req.params.id, videoId: track.videoId, reason: 'bugged' },
      update: { reason: 'bugged' },
    });

    await prisma.track.update({
      where: { id: req.params.id },
      data: {
        bugged: true,
        allSourcesTried: false,
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
  resolveUrl(videoId, PRIO.PREFETCH)
    .then(() => console.log(`[prefetch] ${videoId} cached OK`))
    .catch((err) => console.error(`[prefetch] ${videoId} failed:`, err.message));
});

// GET /youtube/audio/:videoId — zwraca 302 do CDN (z cache lub przez yt-dlp)
// ?fresh=1 — pomija cache i wymusza nowe wywołanie yt-dlp (używane przez frontend po 403)
router.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (req.query.fresh !== '1') {
    const cached = getCachedUrl(videoId);
    if (cached) {
      console.log(`[audio] ${videoId} → cache hit`);
      return res.redirect(302, cached);
    }
  } else {
    urlCache.delete(videoId);
    prisma.urlCache.delete({ where: { videoId } }).catch(() => {});
    console.log(`[audio] ${videoId} → force refresh`);
  }
  console.log(`[audio] ${videoId} → resolving via yt-dlp`);
  // Cancel the in-flight resolve if the client disconnects before we respond.
  // This unblocks the queue for the next (higher-priority) request.
  let clientGone = false;
  req.on('close', () => {
    if (!res.headersSent) {
      clientGone = true;
      ytdlpQueue.cancel(videoId);
    }
  });
  try {
    const audioUrl = await resolveUrl(videoId, PRIO.DIRECT);
    if (!clientGone) res.redirect(302, audioUrl);
  } catch (err) {
    if (clientGone || err.name === 'AbortError') return;
    console.error(`[audio] yt-dlp error for ${videoId}:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// --- Cache warming ---

async function warmTopTracks() {
  if (pendingResolves.size > 0) { console.log('[cache-warm] skipping — resolves in flight'); return; }
  const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  try {
    const topEvents = await prisma.userEvent.groupBy({
      by: ['trackId'],
      where: { trackId: { not: null }, createdAt: { gte: since } },
      _count: { trackId: true },
      orderBy: { _count: { trackId: 'desc' } },
      take: 20,
    });
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const trackIds = topEvents.map((e) => e.trackId).filter(Boolean);
    const tracks = await prisma.track.findMany({
      where: { id: { in: trackIds } },
      select: { id: true, videoId: true },
    });
    const toWarm = tracks
      .map((t) => t.videoId)
      .filter((videoId) => {
        if (!videoId) return false;
        const entry = urlCache.get(videoId);
        return !entry || entry.expiresAt - Date.now() < ONE_HOUR_MS;
      });
    if (toWarm.length) console.log(`[cache-warm] warming ${toWarm.length} URLs`);
    toWarm.forEach((videoId, i) => {
      setTimeout(
        () => resolveUrl(videoId, PRIO.WARM).catch((err) => console.error(`[cache-warm] ${videoId} failed:`, err.message)),
        i * 2000
      );
    });
  } catch (err) {
    console.error('[cache-warm] error:', err.message);
  }
}

// First run after 60s (lets ytdlp worker start), then every 30 min
setTimeout(warmTopTracks, 60 * 1000);
setInterval(warmTopTracks, 30 * 60 * 1000);

module.exports = router;

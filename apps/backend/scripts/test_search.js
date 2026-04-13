#!/usr/bin/env node
// test_search.js — simulate the full parallel search pipeline for a given track
//
// Usage:
//   node scripts/test_search.js --track "Song Name" --artist "Artist" --duration_ms 210000
//   node scripts/test_search.js --track "Song Name" --artist "Artist" --duration_ms 210000 --track_id abc123
//
// Does NOT touch the database or cache — purely diagnostic.

const { execFile } = require('child_process');
const path = require('path');
const YTMusic = require('ytmusic-api');
const { search: searchConfig } = require('@listenalong/config');

const NOISE_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?|nightcore|nighcore|cover|ai\s+cover|slowed|reverb|sped[\s-]?up|speed[\s-]?up|(?:english|spanish|french|portuguese|german|italian|dutch|korean|chinese)\s+(?:ver(?:sion)?\.?|dub)|translat(?:ion|ed))\b|[\[(（](?:inst|english)[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;
const ODESLI_BONUS_MS = searchConfig.odesliBonus;

const YT_DLP = process.env.YT_DLP_PATH || '/usr/local/bin/yt-dlp';
const COOKIES_TMP = path.join(__dirname, '..', 'cookies_tmp.txt');
const NODE_BIN = process.env.NODE_PATH || '/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node';

// --- Parse args ---

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const track     = getArg('track');
const artist    = getArg('artist');
const durationS = getArg('duration_ms');
const trackId   = getArg('track_id');

if (!track || !artist || !durationS) {
  console.error('Usage: node scripts/test_search.js --track "Name" --artist "Artist" --duration_ms 210000 [--track_id id]');
  process.exit(1);
}

const targetMs = parseInt(durationS, 10);

// --- Helpers ---

function fmtDelta(deltaMs) {
  const sign = deltaMs >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(deltaMs) / 1000).toFixed(1)}s`;
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

const pad  = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const lpad = (s, n) => String(s ?? '').slice(0, n).padStart(n);

async function odesliLookup(id) {
  try {
    const url = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
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
  } catch (_) { return null; }
}

function searchYouTube(t, a) {
  return new Promise((resolve) => {
    execFile(
      YT_DLP,
      ['--no-download', '--print', '%(id)s\t%(duration)s\t%(title)s',
       '--cookies', COOKIES_TMP,
       '--js-runtimes', `node:${NODE_BIN}`,
       `ytsearch${searchConfig.ytSearchCount}:${t} ${a}`],
      { timeout: 12000 },
      (err, stdout) => {
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

function printTable(rows, odesliId) {
  const COL = { rank: 4, title: 48, id: 13, dur: 7, delta: 8 };
  const hr = '-'.repeat(COL.rank + COL.title + COL.id + COL.dur + COL.delta + 20);
  console.log(
    pad('#', COL.rank) + '  ' + pad('Title', COL.title) + '  ' +
    pad('VideoId', COL.id) + '  ' + lpad('Dur', COL.dur) + '  ' +
    lpad('Delta', COL.delta) + '  Flags'
  );
  console.log(hr);
  rows.forEach((r, i) => {
    const isNoise   = NOISE_RE.test(r.title ?? '');
    const isOdesli  = r.videoId === odesliId;
    const flags = [isNoise ? 'NOISE' : '', isOdesli ? 'ODESLI' : ''].filter(Boolean).join(' ');
    const durStr   = r.durationMs ? fmtDuration(r.durationMs / 1000) : '?';
    const deltaStr = r.durationMs ? fmtDelta(r.durationMs - targetMs) : '?';
    console.log(
      pad(i + 1, COL.rank) + '  ' + pad(r.title, COL.title) + '  ' +
      pad(r.videoId, COL.id) + '  ' + lpad(durStr, COL.dur) + '  ' +
      lpad(deltaStr, COL.delta) + '  ' + flags
    );
  });
}

// --- Main ---

async function main() {
  console.log('');
  console.log(`Track    : ${track}`);
  console.log(`Artist   : ${artist}`);
  console.log(`Target   : ${fmtDuration(targetMs / 1000)}  [${targetMs} ms]`);
  if (trackId) console.log(`Track ID : ${trackId}`);
  console.log('');

  const ytmusic = new YTMusic();

  // Run all three in parallel (same as production)
  process.stdout.write('Running Odesli + YTMusic + YouTube in parallel... ');
  const [odesliResult, ytMusicResult, ytSearchResult] = await Promise.allSettled([
    trackId ? odesliLookup(trackId) : Promise.resolve(null),
    ytmusic.initialize().then(() => ytmusic.searchSongs(`${track} ${artist}`)).catch(() => []),
    searchYouTube(track, artist),
  ]);
  console.log('done\n');

  const odesliId = odesliResult.status === 'fulfilled' ? odesliResult.value : null;
  const ytMusicSongs = ytMusicResult.status === 'fulfilled' ? (ytMusicResult.value ?? []) : [];
  const ytSearchSongs = ytSearchResult.status === 'fulfilled' ? (ytSearchResult.value ?? []) : [];

  // --- Odesli ---
  console.log(`=== Odesli ===`);
  if (odesliId) {
    console.log(`HIT → ${odesliId}  https://www.youtube.com/watch?v=${odesliId}`);
  } else {
    console.log(`miss${odesliResult.status === 'rejected' ? ` (error: ${odesliResult.reason})` : ''}`);
  }
  console.log('');

  // --- YTMusic ---
  console.log(`=== YTMusic (${ytMusicSongs.length} results) ===`);
  if (ytMusicResult.status === 'rejected') console.log(`ERROR: ${ytMusicResult.reason}`);
  if (ytMusicSongs.length) {
    const rows = [...ytMusicSongs]
      .sort((a, b) => Math.abs((a.duration ?? 0) * 1000 - targetMs) - Math.abs((b.duration ?? 0) * 1000 - targetMs))
      .map((s) => ({ videoId: s.videoId, title: s.name, durationMs: (s.duration ?? 0) * 1000 }));
    printTable(rows, odesliId);
  }
  console.log('');

  // --- YouTube search ---
  console.log(`=== YouTube search (${ytSearchSongs.length} results) ===`);
  if (ytSearchResult.status === 'rejected') console.log(`ERROR: ${ytSearchResult.reason}`);
  if (ytSearchSongs.length) {
    const rows = [...ytSearchSongs].sort((a, b) => Math.abs(a.durationMs - targetMs) - Math.abs(b.durationMs - targetMs));
    printTable(rows, odesliId);
  }
  console.log('');

  // --- Combined winner (same logic as searchAllSources) ---
  console.log(`=== Combined winner ===`);
  const candidates = [];
  const seen = new Set();

  function addCandidate(videoId, durationMs, title, source) {
    if (!videoId || NOISE_RE.test(title ?? '')) return;
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

  for (const s of ytMusicSongs) {
    if (s.videoId && s.duration) addCandidate(s.videoId, s.duration * 1000, s.name, 'ytmusic');
  }
  for (const s of ytSearchSongs) {
    addCandidate(s.videoId, s.durationMs, s.title, 'ytsearch');
  }
  if (odesliId && !seen.has(odesliId)) {
    candidates.push({ videoId: odesliId, title: null, deltaMs: ODESLI_BONUS_MS, source: 'odesli' });
  }

  if (!candidates.length) {
    console.log('NO CANDIDATES — nothing would be found');
  } else {
    candidates.sort((a, b) => {
      const sa = a.source.includes('odesli') ? Math.max(0, a.deltaMs - ODESLI_BONUS_MS) : a.deltaMs;
      const sb = b.source.includes('odesli') ? Math.max(0, b.deltaMs - ODESLI_BONUS_MS) : b.deltaMs;
      return sa - sb;
    });
    const w = candidates[0];
    console.log(`WINNER: ${w.title ?? '(no title)'}`);
    console.log(`  videoId : ${w.videoId}`);
    console.log(`  source  : ${w.source}`);
    console.log(`  delta   : ${fmtDelta(w.deltaMs)} from target`);
    console.log(`  url     : https://www.youtube.com/watch?v=${w.videoId}`);
  }
  console.log('');
}

main().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
// test_search.js — simulate the full parallel search pipeline for a given track
//
// Usage:
//   node scripts/test_search.js --track "Song Name" --artist "Artist" --duration_ms 210000
//
// Does NOT touch the database or cache — purely diagnostic.

const { execFile } = require('child_process');
const path = require('path');
const YTMusic = require('ytmusic-api');
const { search: searchConfig } = require('@listenalong/config');

const NOISE_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?|nightcore|nighcore|cover|ai\s+cover|slowed|reverb|sped[\s-]?up|speed[\s-]?up|(?:english|spanish|french|portuguese|german|italian|dutch|korean|chinese)\s+(?:ver(?:sion)?\.?|dub)|translat(?:ion|ed))\b|[\[(（](?:inst|english)[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;

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

if (!track || !artist || !durationS) {
  console.error('Usage: node scripts/test_search.js --track "Name" --artist "Artist" --duration_ms 210000');
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

function titleRelevance(title, trackName, artistName) {
  if (!title) return 0;
  const lowerTitle = title.toLowerCase();
  const words = `${trackName} ${artistName}`.toLowerCase()
    .replace(/_/g, ' ')
    .split(/[\s,\-–()/]+/)
    .filter((word) => word.length > 3);
  if (!words.length) return 0;
  return words.filter((word) => lowerTitle.includes(word)).length / words.length;
}

const TITLE_BONUS_MS = searchConfig.titleBonus;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SCRIPT_BONUS_MS = searchConfig.scriptBonus;

function scriptBonus(title, trackName, artistName) {
  if (!CJK_RE.test(trackName) && !CJK_RE.test(artistName)) return 0;
  return CJK_RE.test(title ?? '') ? SCRIPT_BONUS_MS : 0;
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

function printTable(rows) {
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
    const flags = [isNoise ? 'NOISE' : ''].filter(Boolean).join(' ');
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
  console.log('');

  const ytmusic = new YTMusic();

  // Run both production search sources in parallel.
  process.stdout.write('Running YTMusic + YouTube in parallel... ');
  const [ytMusicResult, ytSearchResult] = await Promise.allSettled([
    ytmusic.initialize().then(() => ytmusic.searchSongs(`${track} ${artist}`)).catch(() => []),
    searchYouTube(track, artist),
  ]);
  console.log('done\n');

  const ytMusicSongs = ytMusicResult.status === 'fulfilled' ? (ytMusicResult.value ?? []) : [];
  const ytSearchSongs = ytSearchResult.status === 'fulfilled' ? (ytSearchResult.value ?? []) : [];

  // --- YTMusic ---
  console.log(`=== YTMusic (${ytMusicSongs.length} results) ===`);
  if (ytMusicResult.status === 'rejected') console.log(`ERROR: ${ytMusicResult.reason}`);
  if (ytMusicSongs.length) {
    const rows = [...ytMusicSongs]
      .sort((a, b) => Math.abs((a.duration ?? 0) * 1000 - targetMs) - Math.abs((b.duration ?? 0) * 1000 - targetMs))
      .map((s) => ({ videoId: s.videoId, title: s.name, durationMs: (s.duration ?? 0) * 1000 }));
    printTable(rows);
  }
  console.log('');

  // --- YouTube search ---
  console.log(`=== YouTube search (${ytSearchSongs.length} results) ===`);
  if (ytSearchResult.status === 'rejected') console.log(`ERROR: ${ytSearchResult.reason}`);
  if (ytSearchSongs.length) {
    const rows = [...ytSearchSongs].sort((a, b) => Math.abs(a.durationMs - targetMs) - Math.abs(b.durationMs - targetMs));
    printTable(rows);
  }
  console.log('');

  // --- Combined winner (same logic as searchAllSources) ---
  console.log(`=== Combined winner ===`);
  const candidates = [];
  const seen = new Set();

  function addCandidate(videoId, durationMs, title, source) {
    if (!videoId || NOISE_RE.test(title ?? '')) return;
    const deltaMs = Math.abs(durationMs - targetMs);
    if (seen.has(videoId)) {
      const ex = candidates.find((c) => c.videoId === videoId);
      if (ex && !ex.source.includes(source)) ex.source += `+${source}`;
      return;
    }
    seen.add(videoId);
    candidates.push({ videoId, title, deltaMs, source });
  }

  for (const s of ytMusicSongs) {
    if (s.videoId && s.duration) addCandidate(s.videoId, s.duration * 1000, s.name, 'ytmusic');
  }
  for (const s of ytSearchSongs) {
    addCandidate(s.videoId, s.durationMs, s.title, 'ytsearch');
  }

  if (!candidates.length) {
    console.log('NO CANDIDATES — nothing would be found');
  } else {
    candidates.sort((a, b) => {
      const sa = a.deltaMs
        - titleRelevance(a.title, track, artist) * TITLE_BONUS_MS
        - scriptBonus(a.title, track, artist);
      const sb = b.deltaMs
        - titleRelevance(b.title, track, artist) * TITLE_BONUS_MS
        - scriptBonus(b.title, track, artist);
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

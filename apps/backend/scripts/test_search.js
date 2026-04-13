#!/usr/bin/env node
// test_search.js — simulate the full search pipeline for a given track
//
// Usage:
//   node scripts/test_search.js --track "Song Name" --artist "Artist" --duration_ms 210000
//   node scripts/test_search.js --track "Song Name" --artist "Artist" --duration_ms 210000 --track_id abc123
//
// Does NOT touch the database or cache — purely diagnostic.

const YTMusic = require('ytmusic-api');

const DURATION_TOLERANCE_MS = 10000;
const INSTRUMENTAL_RE = /\b(instrumental|karaoke|off[\s-]?vocal|backing[\s-]?track|inst\.?)\b|[\[(（]inst[\]）)]|インスト|カラオケ|オフボーカル|\bMR\b/i;

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
const targetSec = (targetMs / 1000).toFixed(1);

// --- Helpers ---

function fmtDelta(deltaMs) {
  const sign = deltaMs >= 0 ? '+' : '-';
  const abs = Math.abs(deltaMs);
  return `${sign}${(abs / 1000).toFixed(1)}s`;
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

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
  } catch (e) {
    return null;
  }
}

// --- Main ---

async function main() {
  console.log('');
  console.log(`Track    : ${track}`);
  console.log(`Artist   : ${artist}`);
  console.log(`Target   : ${targetSec}s  (${fmtDuration(targetMs / 1000)})  [${targetMs} ms]`);
  if (trackId) console.log(`Track ID : ${trackId}`);
  console.log('');

  // 1. Odesli
  if (trackId) {
    process.stdout.write('Odesli lookup... ');
    const odesliId = await odesliLookup(trackId);
    if (odesliId) {
      console.log(`HIT → https://www.youtube.com/watch?v=${odesliId}`);
    } else {
      console.log('miss');
    }
    console.log('');
  }

  // 2. YTMusic search
  process.stdout.write(`YTMusic search: "${track} ${artist}"... `);
  const ytmusic = new YTMusic();
  await ytmusic.initialize();
  const results = await ytmusic.searchSongs(`${track} ${artist}`);
  console.log(`${results.length} results\n`);

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  // Annotate each result
  const annotated = results.map((s) => {
    const durationMs = (s.duration ?? 0) * 1000;
    const deltaMs = durationMs - targetMs;
    const withinTolerance = Math.abs(deltaMs) <= DURATION_TOLERANCE_MS;
    const isInstrumental = INSTRUMENTAL_RE.test(s.name ?? '');
    return { ...s, durationMs, deltaMs, withinTolerance, isInstrumental };
  });

  // Sort by duration proximity for display
  const sorted = [...annotated].sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));

  // Determine what the algorithm would actually pick (standard mode)
  const standardPick = annotated
    .filter((s) => s.videoId && s.duration && !s.isInstrumental && s.withinTolerance)[0] ?? null;

  // prefer_duration pick (closest regardless of tolerance)
  const preferDurationPick = [...annotated]
    .filter((s) => s.videoId && s.duration)
    .sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs))[0] ?? null;

  // Table header
  const COL = { rank: 4, title: 48, id: 13, dur: 7, delta: 8, flags: 6 };
  const hr = '-'.repeat(COL.rank + COL.title + COL.id + COL.dur + COL.delta + COL.flags + 10);

  const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  const lpad = (s, n) => String(s ?? '').slice(0, n).padStart(n);

  console.log(
    pad('#', COL.rank) + '  ' +
    pad('Title', COL.title) + '  ' +
    pad('VideoId', COL.id) + '  ' +
    lpad('Dur', COL.dur) + '  ' +
    lpad('Delta', COL.delta) + '  ' +
    'Flags'
  );
  console.log(hr);

  sorted.forEach((s, i) => {
    const isStandard = standardPick && s.videoId === standardPick.videoId;
    const isPrefDur  = preferDurationPick && s.videoId === preferDurationPick.videoId;
    const flags = [
      s.isInstrumental  ? 'INST' : '',
      !s.withinTolerance ? 'OUT'  : '',
      isStandard         ? '← std'   : '',
      (!isStandard && isPrefDur) ? '← pref_dur' : '',
    ].filter(Boolean).join(' ');

    const durStr = s.duration ? fmtDuration(s.duration) : '?';
    const deltaStr = s.durationMs ? fmtDelta(s.deltaMs) : '?';

    console.log(
      pad(i + 1, COL.rank) + '  ' +
      pad(s.name, COL.title) + '  ' +
      pad(s.videoId, COL.id) + '  ' +
      lpad(durStr, COL.dur) + '  ' +
      lpad(deltaStr, COL.delta) + '  ' +
      flags
    );
  });

  console.log('');
  console.log('--- Decision ---');
  if (standardPick) {
    console.log(`standard     : ${standardPick.name} (${standardPick.videoId})  Δ${fmtDelta(standardPick.deltaMs)}`);
  } else {
    console.log('standard     : NO MATCH within ±10s tolerance');
  }
  if (preferDurationPick) {
    console.log(`prefer_dur   : ${preferDurationPick.name} (${preferDurationPick.videoId})  Δ${fmtDelta(preferDurationPick.deltaMs)}`);
  }
  console.log('');
}

main().catch((err) => { console.error(err); process.exit(1); });

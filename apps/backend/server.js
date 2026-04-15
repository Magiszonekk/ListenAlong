require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer, OPEN } = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const { prisma } = require('./lib/db');
const { getAccessToken } = require('./routes/auth');
const { polling, cache: cacheConfig } = require('@listenalong/config');

// Start Xvfb for headful Camoufox sessions
const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], {
  detached: true,
  stdio: 'ignore',
});
xvfb.unref();
xvfb.on('error', (err) => console.error('[xvfb] failed to start:', err.message));
process.on('exit', () => { try { xvfb.kill(); } catch (_) {} });

// Start persistent yt-dlp Python worker — keeps Python + yt_dlp warm across calls
const YTDLP_PORT = process.env.YTDLP_SERVER_PORT || 9091;
const COOKIES_TMP_PATH = path.join(__dirname, 'cookies_tmp.txt');
console.log(`[ytdlp-worker] spawning on port ${YTDLP_PORT}`);
const ytdlpWorker = spawn(
  'python3',
  [path.join(__dirname, 'scripts', 'ytdlp_server.py'), COOKIES_TMP_PATH, String(YTDLP_PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
ytdlpWorker.stdout.on('data', (d) => process.stdout.write(`[ytdlp] ${d}`));
ytdlpWorker.stderr.on('data', (d) => process.stderr.write(`[ytdlp] ${d}`));
ytdlpWorker.on('error', (err) => console.error('[ytdlp-worker] failed to start:', err.message));
function killYtdlpWorker() { try { ytdlpWorker.kill(); } catch (_) {} }
process.on('exit', killYtdlpWorker);
process.on('SIGTERM', () => { killYtdlpWorker(); process.exit(0); });

const app = express();

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

let currentLogDate = null;
let logStream = null;

function getLogStream() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== currentLogDate) {
    if (logStream) logStream.end();
    currentLogDate = today;
    logStream = fs.createWriteStream(path.join(LOGS_DIR, `${today}.log`), { flags: 'a' });
  }
  return logStream;
}

// Mirror all server-side console output to the log file
['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    orig(...args);
    const line = `${new Date().toISOString()} [server] ${args.join(' ')}\n`;
    getLogStream().write(line);
  };
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// POST /log — frontend sends debug logs here
app.post('/log', (req, res) => {
  const { msg } = req.body;
  if (typeof msg !== 'string') return res.status(400).end();
  const line = `${new Date().toISOString()} [frontend] ${msg}\n`;
  getLogStream().write(line);
  res.end();
});

// POST /events — frontend event log (start, pause, resume, spotify_pause, spotify_play, bug, not_ideal, exit)
app.post('/events', async (req, res) => {
  const clientId = req.headers['x-client-id'] || req.body.clientId;
  const { action, trackId } = req.body;
  if (!clientId || typeof action !== 'string') return res.status(400).end();
  const ip = req.headers['x-forwarded-for'] ?? req.ip ?? null;
  prisma.userEvent.create({
    data: { clientId, action, trackId: trackId ?? null, ip },
  }).catch(() => {});
  console.log(`[event] ${clientId.slice(0, 6)} ${action}${trackId ? ` (${trackId})` : ''}`);
  res.end();
});

app.use('/auth', require('./routes/auth'));

// Spotify redirects to /callback — forward to /auth/callback
app.get('/callback', (req, res) => {
  res.redirect(`/auth/callback?${new URLSearchParams(req.query)}`);
});
app.use('/spotify', require('./routes/spotify'));
app.use('/youtube', require('./routes/youtube'));

// --- HTTP server + WebSocket ---

const PORT = process.env.PORT || 3004;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// clientId → ws socket
const wsClients = new Map();

function broadcastAll(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients)
    if (ws.readyState === OPEN) ws.send(payload);
}

function broadcastListeners() {
  const clientIds = [...wsClients.keys()];
  broadcastAll({ type: 'listeners', count: clientIds.length, clientIds });
}

// Shared Spotify state pushed to all clients
let lastState = null;
let lastQueue = undefined;
let lastTrackId = null;
let endOfTrackTimer = null;
let pollInFlight = false;
let lastBroadcastAt = 0;

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'identify' && typeof msg.clientId === 'string') {
      clientId = msg.clientId;
      wsClients.set(clientId, ws);
      broadcastListeners();
      // Send current state immediately so new client doesn't wait up to 3s
      if (lastState) ws.send(JSON.stringify({
        type: 'now_playing',
        ...lastState,
        serverAge: lastBroadcastAt ? Date.now() - lastBroadcastAt : 0,
      }));
      if (lastQueue !== undefined) ws.send(JSON.stringify(queueMsg(lastQueue)));
    }

    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
  });

  ws.on('close', () => {
    if (clientId) wsClients.delete(clientId);
    broadcastListeners();
  });

  ws.on('error', (err) => console.error(`[ws] client error (${clientId}):`, err.message));
});

// --- Server-side Spotify polling ---

async function fetchNowPlaying() {
  const token = await getAccessToken();
  if (!token) return { is_playing: false, auth_error: true };
  const r = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: (s) => s < 500,
  });
  if (r.status === 204 || !r.data?.item) return { is_playing: false };
  const { item, progress_ms, is_playing } = r.data;
  return {
    track: item.name,
    artist: item.artists.map((a) => a.name).join(', '),
    track_id: item.id,
    progress_ms,
    duration_ms: item.duration_ms,
    is_playing,
  };
}

async function fetchQueue() {
  const token = await getAccessToken();
  if (!token) return null;
  const r = await axios.get('https://api.spotify.com/v1/me/player/queue', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: (s) => s < 500,
  });
  if (r.status !== 200 || !r.data?.queue?.length) return [];
  return r.data.queue.slice(0, cacheConfig.prefetchAhead).map((q) => ({
    track_id: q.id,
    track: q.name,
    artist: q.artists.map((a) => a.name).join(', '),
    duration_ms: q.duration_ms,
  }));
}

// Build a 'queue' WS message from the fetched track list.
// tracks[0] = next (full audio prefetch), tracks[1..] = upcoming (URL-only prefetch).
function queueMsg(tracks) {
  if (!tracks) return { type: 'queue', next: null, upcoming: [] };
  return { type: 'queue', next: tracks[0] ?? null, upcoming: tracks.slice(1) };
}

function stateChanged(a, b) {
  if (!a || !b) return a !== b;
  return a.is_playing !== b.is_playing || a.track_id !== b.track_id || !!a.auth_error !== !!b.auth_error;
}

async function spotifyPollTick() {
  if (pollInFlight) return;
  pollInFlight = true;
  if (wss.clients.size === 0) { pollInFlight = false; return; }
  try {
    const now = Date.now();
    const state = await fetchNowPlaying();
    // Broadcast on real state change (track, play/pause, auth) OR if progress drifted
    // from what the client can compute locally (seek, buffering, etc.).
    // When playing and progress advanced ~as expected, skip — client interpolates locally.
    const elapsed = lastBroadcastAt ? now - lastBroadcastAt : Infinity;
    const progressDrifted = state.is_playing &&
      lastState?.progress_ms != null && state.progress_ms != null &&
      Math.abs(state.progress_ms - (lastState.progress_ms + elapsed)) > polling.spotifyMs * polling.driftFactor + polling.driftBaseMs;
    const shouldBroadcast = stateChanged(lastState, state) || progressDrifted;
    if (shouldBroadcast) {
      lastState = state;
      lastBroadcastAt = now;
      broadcastAll({ type: 'now_playing', ...state, serverAge: 0 });

      if (state.track_id && state.track_id !== lastTrackId) {
        lastTrackId = state.track_id;
        const next = await fetchQueue();
        lastQueue = next;
        broadcastAll(queueMsg(next));

        // Refresh queue after 30s so prefetch is up-to-date before track ends.
        // Guard: if track changes before timeout fires, skip stale refresh.
        const expectedTrackId = lastTrackId;
        setTimeout(async () => {
          if (lastTrackId !== expectedTrackId) return;
          const next2 = await fetchQueue().catch(() => null);
          if (next2 !== undefined) { lastQueue = next2; broadcastAll(queueMsg(next2)); }
        }, 30000);
      }
    }

    // Schedule an early poll ~300ms after the track should end so the transition
    // is detected immediately instead of waiting up to spotifyMs for the next tick.
    // Reset on every tick so the estimate stays fresh as progress_ms accumulates.
    if (endOfTrackTimer) { clearTimeout(endOfTrackTimer); endOfTrackTimer = null; }
    if (state.is_playing && state.duration_ms && state.progress_ms != null) {
      const msUntilEnd = state.duration_ms - state.progress_ms;
      if (msUntilEnd > 0) {
        const expectedId = state.track_id;
        endOfTrackTimer = setTimeout(async () => {
          endOfTrackTimer = null;
          if (lastTrackId !== expectedId) return; // regular poll already caught the change
          await spotifyPollTick();
        }, msUntilEnd + 300);
      }
    }
  } catch (err) {
    console.error('[spotify-poll] error:', err.message);
  } finally {
    pollInFlight = false;
  }
}

setInterval(spotifyPollTick, polling.spotifyMs);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

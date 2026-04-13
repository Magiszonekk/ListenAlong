require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { prisma } = require('./lib/db');

// Start Xvfb for headful Camoufox sessions
const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], {
  detached: true,
  stdio: 'ignore',
});
xvfb.unref();
xvfb.on('error', (err) => console.error('[xvfb] failed to start:', err.message));
process.on('exit', () => { try { xvfb.kill(); } catch (_) {} });

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

// Track active clients (clientId → lastSeen timestamp)
const activeClients = new Map();

function pruneClients() {
  const cutoff = Date.now() - 10000; // 10s = ~3 missed polls
  for (const [id, ts] of activeClients) {
    if (ts < cutoff) activeClients.delete(id);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// Heartbeat — update lastSeen for any request carrying X-Client-Id
app.use((req, res, next) => {
  const id = req.headers['x-client-id'];
  if (id) activeClients.set(id, Date.now());
  next();
});

// GET /clients — returns active listener count
app.get('/clients', (req, res) => {
  pruneClients();
  res.json({ count: activeClients.size });
});

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

const PORT = process.env.PORT || 3004;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

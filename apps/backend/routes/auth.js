const express = require('express');
const axios = require('axios');
const { prisma } = require('../lib/db');
const router = express.Router();

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  REDIRECT_URI,
} = process.env;

const SCOPES = 'user-read-playback-state user-read-currently-playing';

// GET /auth/login
router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// GET /auth/callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`Spotify auth error: ${error || 'missing code'}`);
  }

  const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const data = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const response = await axios.post('https://accounts.spotify.com/api/token', data.toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  accessToken = response.data.access_token;
  refreshToken = response.data.refresh_token;
  tokenExpiresAt = Date.now() + 3300000; // 55 minutes

  prisma.authEvent.create({
    data: {
      ip: req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown',
      userAgent: req.headers['user-agent'] ?? null,
      action: 'login',
    },
  }).catch(() => {});

  res.redirect('/');
});

// GET /auth/refresh
router.get('/refresh', async (req, res) => {
  await doRefresh();
  res.json({ ok: true, expiresAt: tokenExpiresAt });
});

async function doRefresh() {
  if (!refreshToken) throw new Error('No refresh token available');

  const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const data = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await axios.post('https://accounts.spotify.com/api/token', data.toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  accessToken = response.data.access_token;
  tokenExpiresAt = Date.now() + 3300000;

  // Spotify may return a new refresh token
  if (response.data.refresh_token) {
    refreshToken = response.data.refresh_token;
  }
}

async function getAccessToken() {
  if (!accessToken) return null;

  // Refresh if expiring within 60 seconds
  if (Date.now() >= tokenExpiresAt - 60000) {
    await doRefresh();
  }

  return accessToken;
}

module.exports = router;
module.exports.getAccessToken = getAccessToken;

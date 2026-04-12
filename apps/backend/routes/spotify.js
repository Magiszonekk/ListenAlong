const express = require('express');
const axios = require('axios');
const { getAccessToken } = require('./auth');

const router = express.Router();

// GET /spotify/now-playing
router.get('/now-playing', async (_req, res) => {
  const token = await getAccessToken();

  if (!token) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: (status) => status < 500,
  });

  // 204 = nothing playing
  if (response.status === 204 || !response.data || !response.data.item) {
    return res.json({ is_playing: false });
  }

  const { item, progress_ms, is_playing } = response.data;

  res.json({
    track: item.name,
    artist: item.artists.map((a) => a.name).join(', '),
    track_id: item.id,
    progress_ms,
    duration_ms: item.duration_ms,
    is_playing,
  });
});

// GET /spotify/queue — returns the next track in Spotify queue
router.get('/queue', async (_req, res) => {
  const token = await getAccessToken();

  if (!token) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const response = await axios.get('https://api.spotify.com/v1/me/player/queue', {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: (status) => status < 500,
  });

  if (response.status !== 200 || !response.data.queue || !response.data.queue.length) {
    return res.json({ next: null });
  }

  const next = response.data.queue[0];
  res.json({
    next: {
      track_id: next.id,
      track: next.name,
      artist: next.artists.map((a) => a.name).join(', '),
      duration_ms: next.duration_ms,
    },
  });
});

module.exports = router;

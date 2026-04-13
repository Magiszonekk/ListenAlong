# ListenAlong

Streams audio synced to whatever is currently playing on Spotify — finds the matching track on YouTube and keeps everyone in sync. The host plays music on Spotify; listeners open the app URL and hear the same thing with a shared audio player.

## How it works

1. The host authenticates with Spotify via OAuth.
2. The backend polls Spotify every 3 seconds for the currently playing track.
3. For each track it resolves a YouTube audio URL (via Odesli or YTMusic search + yt-dlp).
4. All listeners receive the same audio stream, synced to Spotify's playback position.

---

## Prerequisites

- **Node.js** v18+
- **Python 3.9+**
- **yt-dlp** — install via `pip install yt-dlp` or your package manager, expected at `/usr/local/bin/yt-dlp` (override with `YT_DLP_PATH` env var)
- **Camoufox** — headful browser used to refresh YouTube cookies: `pip install camoufox && python3 -m camoufox fetch`
- **Xvfb** — virtual display for headful Camoufox on servers: `apt install xvfb`

---

## Setup

### 1. Environment variables

Copy the example file and fill in the values:

```bash
cp example.env .env
```

| Variable | Description |
|---|---|
| `PORT` | Port the server listens on (default `3000`) |
| `SPOTIFY_CLIENT_ID` | From your Spotify Developer app |
| `SPOTIFY_CLIENT_SECRET` | From your Spotify Developer app |
| `REDIRECT_URI` | Must match exactly what's registered in your Spotify app (e.g. `https://yourdomain.com/callback`) |
| `GOOGLE_EMAIL` | *(Optional)* Google account email for auto YouTube login |
| `GOOGLE_PASSWORD` | *(Optional)* Google account password for auto YouTube login |

### 2. Spotify app

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Set the **Redirect URI** to match `REDIRECT_URI` in your `.env`.
3. Copy **Client ID** and **Client Secret** into `.env`.

### 3. Install dependencies

```bash
npm install
```

### 4. Initialize the database

```bash
cd apps/backend
npx prisma db push
```

This creates `apps/backend/data.db` with all required tables.

### 5. YouTube cookies (initial setup)

yt-dlp needs valid YouTube cookies to resolve audio URLs. Generate them once before first run:

```bash
cd apps/backend
python3 scripts/get_cookies.py
```

If `GOOGLE_EMAIL` and `GOOGLE_PASSWORD` are set in `.env`, the script logs in automatically. Otherwise a browser window opens — log in manually and close it. Cookies are saved to `apps/backend/cookies.txt`.

> The server refreshes cookies automatically every 25 minutes and on 429 errors, so you normally only need to run this once.

### 6. Build the frontend

```bash
npm run build
```

---

## Running

### Production

```bash
npm start
```

Serves the built frontend as static files and starts the API on the configured `PORT`.

### Development

```bash
npm run dev
```

Runs the backend with `--watch` and the Vite dev server concurrently. The Vite dev server proxies API requests to the backend.

---

## How to use

### As the host

1. Open the app in a browser.
2. Click **Log in with Spotify** and authorize the app.
3. Start playing something on Spotify.
4. Click **Start sync** — audio will begin playing synced to your Spotify position. (optional)
5. You can **Close the website**, backend will be still connected to your spotify and serving music to listeners

### As a listener

1. Open the app URL in a browser.
2. Click **Start sync** — audio starts playing synced to whatever the host is playing.

---

## Feedback buttons

These appear after clicking Start sync:

| Button | When visible | What it does |
|---|---|---|
| `~` | Source is Odesli (timing may be off) | Flags the current match as imprecise — on next play it searches for a version with a closer duration |
| Bug icon | Always | Blacklists the current YouTube video — on next play it finds an entirely different source |

If all alternative sources have been tried, both buttons are disabled and a notice is shown.

---

## Database

SQLite at `apps/backend/data.db`. Inspect with Prisma Studio:

```bash
cd apps/backend
npm run studio
```

Tables:
- **Track** — cached Spotify→YouTube matches with search metadata
- **VideoBlacklist** — videos flagged as bugged per track
- **Play** — per-client play history
- **AuthEvent** — Spotify OAuth login events (IP, user agent)
- **UserEvent** — client-side events (start, pause, resume, spotify_pause, spotify_play, bug, not_ideal, exit)

---

## Logs

Server logs are written to `logs/YYYY-MM-DD.log` and also mirrored to stdout. Frontend debug messages are sent to `POST /log` and appear in the same log file tagged `[frontend]`. User events are tagged `[event]`.

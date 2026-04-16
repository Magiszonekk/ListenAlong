# ListenAlong

Streams audio synced to whatever is currently playing on Spotify — finds the matching track on YouTube and keeps everyone in sync. The host plays music on Spotify; listeners open the app URL and hear the same thing with a shared audio player.

## How it works

1. The host authenticates with Spotify via OAuth.
2. The backend polls Spotify every second for the currently playing track and progress.
3. State is broadcast to all connected clients over WebSocket.
4. When a new track starts, the backend resolves a YouTube audio URL (via YTMusic search + yt-dlp) and caches it.
5. Upcoming tracks are prefetched in the background so the transition is seamless:
   - **N+1** — CDN URL resolved + audio buffered in the browser.
   - **N+2 … N+`PREFETCH_AHEAD`** — CDN URL resolved only (no audio element).
6. All listeners play from the same YouTube CDN URL, seeked to Spotify's current position.

---

## Prerequisites

- **Node.js** v20+
- **Python 3.9+**
- **yt-dlp** binary at `/usr/local/bin/yt-dlp` — install via `pip install yt-dlp` or download from the yt-dlp releases page
- **Camoufox** — headful browser used to refresh YouTube cookies automatically: `pip install camoufox && python3 -m camoufox fetch`
- **Xvfb** — virtual display for headless servers: `apt install xvfb`

---

## Setup

### 1. Environment variables

```bash
cp example.env .env
```

Fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `PORT` | | Port the server listens on (default `3000`) |
| `SPOTIFY_CLIENT_ID` | Yes | From your Spotify Developer app |
| `SPOTIFY_CLIENT_SECRET` | Yes | From your Spotify Developer app |
| `REDIRECT_URI` | Yes | Must match exactly what's registered in your Spotify app (e.g. `https://yourdomain.com/callback`) |
| `GOOGLE_EMAIL` | | Google account email for automatic YouTube login |
| `GOOGLE_PASSWORD` | | Google account password for automatic YouTube login |

### 2. Spotify app

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Set the **Redirect URI** to match `REDIRECT_URI` in your `.env`.
3. Copy **Client ID** and **Client Secret** into `.env`.

### 3. Install dependencies

```bash
npm install
```

This also generates the Prisma client automatically.

### 4. YouTube cookies

yt-dlp needs valid YouTube cookies to resolve audio URLs. Generate them before first run:

```bash
cd apps/backend
python3 scripts/get_cookies.py
```

If `GOOGLE_EMAIL` and `GOOGLE_PASSWORD` are set, the script logs in automatically. Otherwise a browser window opens for manual login. Cookies are saved to `apps/backend/cookies.txt`.

> The server refreshes cookies automatically every 25 minutes and on 429/403 errors via Camoufox — you only need to run this once.

The database (`apps/backend/data.db`) is created automatically on first `npm start` or `npm run dev`.

### 5. Build the frontend

```bash
npm run build
```

---

## Running

### Production

```bash
npm start
```

Serves the built frontend as static files and starts the API on `PORT`.

### Development

```bash
npm run dev
```

Runs the backend with `--watch` and the Vite dev server concurrently. Vite proxies API and WebSocket requests to the backend.

---

## How to use

### As the host

1. Open the app in a browser.
2. Click **Log in with Spotify** and authorize.
3. Start playing something on Spotify.
4. Click **Start sync** — audio begins playing synced to your Spotify position.
5. You can close the browser tab — the backend stays connected to Spotify and keeps serving music to listeners.

### As a listener

1. Open the app URL.
2. Click **Start sync** — audio starts, synced to whatever the host is playing.

---

## Feedback buttons

These appear after clicking Start sync:

| Button | What it does |
|---|---|
| Bug icon | Blacklists the current YouTube video — on next play an entirely different source is found |

If all alternative sources have been tried, the button is disabled and a notice is shown.

---

## Configuration

All variables are optional — defaults are shown. Set them in `.env`.

### Search scoring

| Variable | Default | Description |
|---|---|---|
| `YT_SEARCH_COUNT` | `5` | Number of YouTube candidates to fetch and score |
| `TITLE_BONUS_MS` | `15000` | Max score bonus for title/artist word overlap |
| `SCRIPT_BONUS_MS` | `10000` | Score bonus when track has CJK characters and the YouTube title also does |

### Polling & sync

| Variable | Default | Description |
|---|---|---|
| `SPOTIFY_POLL_MS` | `1000` | How often the server polls Spotify and pushes state over WebSocket |
| `DRIFT_FACTOR_PCT` | `15` | Broadcast is skipped when `|actual − expected| ≤ poll_ms × factor% + base_ms` |
| `DRIFT_BASE_MS` | `1000` | Base drift tolerance in ms (see above) |

### Prefetch & URL cache

| Variable | Default | Description |
|---|---|---|
| `PREFETCH_AHEAD` | `5` | How many upcoming tracks to prefetch CDN URLs for (N+1 also buffers audio, N+2… only resolve URLs) |
| `WARM_CACHE_ENABLED` | `0` | Set to `1` to enable the background cache warmer |
| `WARM_CACHE_TOP_N` | `50` | Number of most-played tracks to keep warm |
| `WARM_CACHE_MIN_TTL_M` | `15` | Refresh a cached URL when fewer than this many minutes remain |

---

## Database

SQLite at `apps/backend/data.db`. Inspect with Prisma Studio:

```bash
cd apps/backend
npm run studio
```

### Tables

| Table | Contents |
|---|---|
| `Track` | Cached Spotify→YouTube matches with search metadata |
| `VideoBlacklist` | Videos flagged as bugged per track |
| `UrlCache` | Resolved YouTube CDN URLs with expiry timestamps |
| `Play` | Per-client play history |
| `AuthEvent` | Spotify OAuth login events (IP, user agent) |
| `UserEvent` | Client-side events: `start`, `pause`, `resume`, `spotify_pause`, `spotify_play`, `bug`, `exit` |

### Cleanup

Remove old records (default: older than 30 days) and expired URL cache entries:

```bash
# Preview what would be deleted
npm run db:cleanup:dry

# Delete
npm run db:cleanup

# Custom retention period
npm run db:cleanup -- --days=7
```

---

## Logs

Server logs are written to `logs/YYYY-MM-DD.log` and mirrored to stdout. Frontend debug messages are posted to `POST /log` and appear in the same file tagged `[frontend]`. User events are tagged `[event]`.

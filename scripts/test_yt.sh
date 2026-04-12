#!/usr/bin/env bash
# test_yt.sh — verify yt-dlp works with current cookies; simulate 429 recovery
# Usage: bash scripts/test_yt.sh [VIDEO_ID]
# Default video: dQw4w9WgXcQ (Rick Astley — Never Gonna Give You Up)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VIDEO_ID="${1:-dQw4w9WgXcQ}"
VIDEO_LABEL="Rick Astley — Never Gonna Give You Up"

COOKIES_SRC="$PROJECT_ROOT/cookies.txt"
COOKIES_TMP="$PROJECT_ROOT/cookies_tmp.txt"
YT_DLP="${YT_DLP_PATH:-/usr/local/bin/yt-dlp}"
NODE_BIN="${NODE_PATH:-/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node}"

tag() { echo "[test_yt] $*"; }

tag "=== yt-dlp Audio Test ==="
tag "Video: $VIDEO_ID ($VIDEO_LABEL)"
tag "yt-dlp: $YT_DLP"
tag "node:   $NODE_BIN"
echo

# ── Prepare cookies_tmp.txt ───────────────────────────────────────────────────
if [[ ! -f "$COOKIES_SRC" ]]; then
    tag "ERROR: cookies.txt not found at $COOKIES_SRC"
    exit 1
fi
cp "$COOKIES_SRC" "$COOKIES_TMP"
tag "Copied cookies.txt → cookies_tmp.txt"

# ── Helper: run yt-dlp ────────────────────────────────────────────────────────
run_ytdlp() {
    "$YT_DLP" \
        --get-url \
        --format 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio' \
        --no-playlist \
        --cookies "$COOKIES_TMP" \
        --js-runtimes "node:$NODE_BIN" \
        "https://www.youtube.com/watch?v=$VIDEO_ID" \
        2>&1
}

# ── Test 1: run yt-dlp ────────────────────────────────────────────────────────
tag "Running yt-dlp..."
YTDLP_OUT="$(run_ytdlp)" && YTDLP_EXIT=0 || YTDLP_EXIT=$?

# Extract audio URL (first non-empty line not starting with [)
AUDIO_URL="$(echo "$YTDLP_OUT" | grep -v '^\[' | grep -v '^$' | head -1 || true)"

if [[ $YTDLP_EXIT -eq 0 && -n "$AUDIO_URL" ]]; then
    TRUNC="${AUDIO_URL:0:80}..."
    echo
    tag "PASS: yt-dlp returned audio URL → $TRUNC"
    exit 0
fi

# ── Diagnose failure ──────────────────────────────────────────────────────────
IS_429=0
if echo "$YTDLP_OUT" | grep -qiE '429|Sign in to confirm|not a bot'; then
    IS_429=1
    REASON="429 / bot-detection"
else
    REASON="error (exit $YTDLP_EXIT)"
fi
echo
tag "FAIL ($REASON):"
echo "$YTDLP_OUT" | tail -5 | sed 's/^/          /'

# ── Test 2: refresh cookies then retry ───────────────────────────────────────
echo
tag "Refreshing cookies via get_cookies.py (DISPLAY=${DISPLAY:-:99})..."
DISPLAY="${DISPLAY:-:99}" python3 "$SCRIPT_DIR/get_cookies.py" || true

cp "$COOKIES_SRC" "$COOKIES_TMP"
tag "cookies_tmp.txt updated — retrying yt-dlp..."
echo

YTDLP_OUT2="$(run_ytdlp)" && YTDLP_EXIT2=0 || YTDLP_EXIT2=$?
AUDIO_URL2="$(echo "$YTDLP_OUT2" | grep -v '^\[' | grep -v '^$' | head -1 || true)"

if [[ $YTDLP_EXIT2 -eq 0 && -n "$AUDIO_URL2" ]]; then
    TRUNC2="${AUDIO_URL2:0:80}..."
    tag "PASS (after cookie refresh): yt-dlp recovered → $TRUNC2"
    exit 0
else
    tag "FAIL: yt-dlp failed even after cookie refresh"
    echo "$YTDLP_OUT2" | tail -5 | sed 's/^/          /'
    exit 1
fi

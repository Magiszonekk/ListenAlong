#!/usr/bin/env python3
"""Persistent yt-dlp HTTP worker.

Keeps the HTTP server and Python interpreter warm across requests.
Uses /usr/local/bin/yt-dlp (binary release with bundled EJS solver)
via subprocess — same approach as the working ListenAlong version.

Usage: python3 ytdlp_server.py <cookies_path> <port>
"""
import sys
import json
import glob
import shutil
import subprocess
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

COOKIES = sys.argv[1] if len(sys.argv) > 1 else None
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9091

YT_DLP = '/usr/local/bin/yt-dlp'

# Locate node binary for n-challenge solving (same as ListenAlong)
NODE_BIN = (
    shutil.which('node')
    or next(iter(sorted(glob.glob('/home/ubuntu/.nvm/versions/node/*/bin/node'), reverse=True)), None)
)
print(f'[ytdlp-worker] binary: {YT_DLP}, node: {NODE_BIN or "NOT FOUND"}', flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Node.js side logs what matters

    def do_GET(self):
        video_id = self.path.removeprefix('/audio/')
        if not video_id or '/' in video_id:
            self._json(400, {'error': 'invalid path'})
            return

        args = [
            YT_DLP,
            '--get-url',
            '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
        ]
        if NODE_BIN:
            args += ['--js-runtimes', f'node:{NODE_BIN}']
        if COOKIES:
            args += ['--cookies', COOKIES]
        args.append(f'https://www.youtube.com/watch?v={video_id}')

        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=20,
            )
            if result.returncode != 0:
                err = result.stderr.strip().splitlines()
                # Grab last non-empty line as the error message
                msg = next((l for l in reversed(err) if l.strip()), result.stderr.strip())
                raise RuntimeError(msg)
            url = result.stdout.strip().split('\n')[0]
            if not url:
                raise RuntimeError('yt-dlp returned no URL')
            self._json(200, {'url': url})
        except subprocess.TimeoutExpired:
            self._json(500, {'error': 'yt-dlp timed out'})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, body):
        try:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except BrokenPipeError:
            pass  # Node.js aborted the request (preemption) — socket already closed


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.serve_forever()

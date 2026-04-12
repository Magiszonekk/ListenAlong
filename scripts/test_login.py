#!/usr/bin/env python3
"""
Test script: verify Camoufox login and cookie refresh.
Runs get_cookies.py and checks before/after state.

Usage:
  DISPLAY=:99 python3 scripts/test_login.py
"""
import os
import sys
import subprocess

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPTS_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPTS_DIR, '..')
ENV_FILE     = os.path.join(PROJECT_ROOT, '.env')
COOKIES_FILE = os.path.join(PROJECT_ROOT, 'cookies.txt')
GET_COOKIES  = os.path.join(SCRIPTS_DIR, 'get_cookies.py')

# ── Load .env ────────────────────────────────────────────────────────────────
if os.path.exists(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def tag(msg):
    print(f'[test_login] {msg}', flush=True)


def read_cookies(filepath):
    cookies = []
    if not os.path.exists(filepath):
        return cookies
    with open(filepath, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) < 7:
                continue
            domain, _, path, secure, expires, name, value = parts[:7]
            cookies.append({'domain': domain, 'name': name, 'value': value})
    return cookies


def is_authenticated(cookies):
    for c in cookies:
        domain = c.get('domain', '')
        val = c.get('value', '')
        if not val or val == 'deleted':
            continue
        if c['name'] == 'SID' and 'google.com' in domain:
            return True
        if c['name'] == 'LOGIN_INFO' and 'youtube.com' in domain:
            return True
        if c['name'] == 'SID' and 'youtube.com' in domain:
            return True
    return False


# ── Pre-flight checks ─────────────────────────────────────────────────────────
tag('=== Cookie Login Test ===')

email    = os.environ.get('GOOGLE_EMAIL', '')
password = os.environ.get('GOOGLE_PASSWORD', '')
if not email or not password:
    tag('WARNING: GOOGLE_EMAIL or GOOGLE_PASSWORD not set in .env — login will be skipped by get_cookies.py')
else:
    tag(f'Credentials loaded for: {email}')

display = os.environ.get('DISPLAY', '')
if not display:
    tag('WARNING: DISPLAY not set — Xvfb may not be running. Set DISPLAY=:99 or start Xvfb first.')
else:
    tag(f'DISPLAY={display}')

# ── Before state ──────────────────────────────────────────────────────────────
before_cookies = read_cookies(COOKIES_FILE)
before_count   = len(before_cookies)
before_auth    = is_authenticated(before_cookies)
tag(f'Before: {before_count} cookies, authenticated={before_auth}')

# ── Run get_cookies.py ────────────────────────────────────────────────────────
tag('Running get_cookies.py...')
env = {**os.environ, 'DISPLAY': display or ':99'}
result = subprocess.run(
    [sys.executable, GET_COOKIES],
    env=env,
    capture_output=True,
    text=True,
    timeout=120,
)

# Print script's stderr (its logging goes there)
for line in result.stderr.strip().splitlines():
    tag(f'  >> {line}')

if result.returncode != 0:
    tag(f'get_cookies.py exited with code {result.returncode}')

# ── After state ───────────────────────────────────────────────────────────────
after_cookies = read_cookies(COOKIES_FILE)
after_count   = len(after_cookies)
after_auth    = is_authenticated(after_cookies)
tag(f'After:  {after_count} cookies, authenticated={after_auth}')

# ── Result ────────────────────────────────────────────────────────────────────
tag('')
if after_auth:
    if after_count >= before_count:
        tag(f'PASS: cookies refreshed successfully ({before_count} → {after_count}, authenticated)')
    else:
        tag(f'PASS (but WARNING): authenticated, cookie count dropped ({before_count} → {after_count})')
elif before_auth and not after_auth:
    tag(f'FAIL: lost authentication! ({before_count} → {after_count} cookies, no SID)')
    sys.exit(1)
elif not before_auth and not after_auth:
    if email and password:
        tag(f'FAIL: still not authenticated after login attempt ({before_count} → {after_count} cookies)')
        sys.exit(1)
    else:
        tag(f'SKIP: no credentials set — anonymous session expected ({before_count} → {after_count} cookies)')
else:
    tag(f'PASS: {before_count} → {after_count} cookies')

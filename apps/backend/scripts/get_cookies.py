#!/usr/bin/env python3
"""
Refresh YouTube cookies using Camoufox headful browser.
If GOOGLE_EMAIL and GOOGLE_PASSWORD are set (in .env or environment),
logs in automatically when an anonymous session is detected.
Supports Google Prompt (phone approval) and SMS 2FA — waits up to 90s.

Usage: python3 get_cookies.py [/path/to/cookies.txt]
"""
import sys
import os
import time

# Load .env from project root
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

COOKIES_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'cookies.txt'
)
GOOGLE_EMAIL    = os.environ.get('GOOGLE_EMAIL', '')
GOOGLE_PASSWORD = os.environ.get('GOOGLE_PASSWORD', '')
SCREENSHOTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')


try:
    from camoufox.sync_api import Camoufox
except ImportError:
    print('camoufox not installed. Run: pip install camoufox && python3 -m camoufox fetch', file=sys.stderr)
    sys.exit(1)


def read_netscape(filepath):
    cookies = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) < 7:
                continue
            domain, _inc_sub, path, secure, expires, name, value = parts[:7]
            cookie = {
                'domain': domain,
                'path': path,
                'name': name,
                'value': value,
                'secure': secure == 'TRUE',
            }
            exp = int(expires)
            if exp > 0:
                cookie['expires'] = exp
            cookies.append(cookie)
    return cookies


def to_netscape(cookies):
    lines = ['# Netscape HTTP Cookie File\n']
    for c in cookies:
        domain = c['domain']
        include_sub = 'TRUE' if domain.startswith('.') else 'FALSE'
        secure = 'TRUE' if c.get('secure') else 'FALSE'
        expires = str(int(c['expires'])) if c.get('expires') and c['expires'] > 0 else '0'
        lines.append(
            f"{domain}\t{include_sub}\t{c['path']}\t{secure}\t{expires}\t{c['name']}\t{c['value']}\n"
        )
    return ''.join(lines)


def is_logged_in(ctx):
    """Check if context has an authenticated YouTube/Google session."""
    cookies = ctx.cookies()
    for c in cookies:
        domain = c.get('domain', '')
        val = c['value']
        if not val or val == 'deleted':
            continue
        # Google account cookie
        if c['name'] == 'SID' and 'google.com' in domain:
            return True
        # YouTube session cookie (present when logged into YouTube)
        if c['name'] == 'LOGIN_INFO' and 'youtube.com' in domain:
            return True
        if c['name'] == 'SID' and 'youtube.com' in domain:
            return True
    return False


def do_google_login(page, ctx):
    """Attempt Google login. Returns True if successful."""
    if not GOOGLE_EMAIL or not GOOGLE_PASSWORD:
        print('[camoufox] no GOOGLE_EMAIL/GOOGLE_PASSWORD set — skipping login', file=sys.stderr)
        return False

    print(f'[camoufox] attempting login for {GOOGLE_EMAIL}...', file=sys.stderr)

    # Go to Google sign-in
    page.goto('https://accounts.google.com/signin/v2/identifier', wait_until='domcontentloaded', timeout=30000)
    page.wait_for_timeout(1500)

    # Email
    try:
        page.fill('input[type="email"]', GOOGLE_EMAIL)
        page.wait_for_timeout(500)
        page.keyboard.press('Enter')
        page.wait_for_timeout(2000)
    except Exception as e:
        print(f'[camoufox] email step failed: {e}', file=sys.stderr)
        _screenshot(page, 'login_email_error')
        return False

    # Password
    try:
        page.wait_for_selector('input[type="password"]', timeout=10000)
        page.fill('input[type="password"]', GOOGLE_PASSWORD)
        page.wait_for_timeout(500)
        page.keyboard.press('Enter')
        page.wait_for_timeout(3000)
    except Exception as e:
        print(f'[camoufox] password step failed: {e}', file=sys.stderr)
        _screenshot(page, 'login_password_error')
        return False

    # Wait for 2FA / success — up to 90 seconds
    print('[camoufox] waiting for login (approve phone prompt or enter 2FA code)...', file=sys.stderr)
    deadline = time.time() + 90
    while time.time() < deadline:
        url = page.url
        if 'myaccount.google.com' in url or (
            'google.com' in url and 'signin' not in url and 'accounts' not in url
        ):
            break
        if is_logged_in(ctx):
            break
        # Check for 2FA input (SMS code or TOTP)
        if page.query_selector('input[type="tel"], input[aria-label*="code" i], input[aria-label*="kod" i]'):
            print('[camoufox] 2FA code required — waiting for user input...', file=sys.stderr)
            _screenshot(page, 'login_2fa')
        time.sleep(3)
    else:
        _screenshot(page, 'login_timeout')
        print('[camoufox] login timed out after 90s', file=sys.stderr)
        return False

    logged = is_logged_in(ctx)
    print(f'[camoufox] login {"succeeded" if logged else "failed — still anonymous"}', file=sys.stderr)
    if not logged:
        _screenshot(page, 'login_failed')
    return logged


def _screenshot(page, name):
    try:
        os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
        path = os.path.join(SCREENSHOTS_DIR, f'camoufox_{name}.png')
        page.screenshot(path=path)
        print(f'[camoufox] screenshot saved: {path}', file=sys.stderr)
    except Exception:
        pass


# --- Main ---

existing = []
if os.path.exists(COOKIES_FILE):
    existing = read_netscape(COOKIES_FILE)
    print(f'[camoufox] loaded {len(existing)} existing cookies', file=sys.stderr)
else:
    print('[camoufox] WARNING: no cookies.txt found', file=sys.stderr)

print('[camoufox] launching headful browser...', file=sys.stderr)
with Camoufox(headless=False) as browser:
    ctx = browser.new_context()

    if existing:
        ctx.add_cookies(existing)

    page = ctx.new_page()
    page.goto('https://www.youtube.com', wait_until='domcontentloaded', timeout=30000)
    page.wait_for_timeout(3000)

    # If still anonymous and we have credentials — attempt login
    if not is_logged_in(ctx) and GOOGLE_EMAIL and GOOGLE_PASSWORD:
        print('[camoufox] anonymous session detected — attempting login...', file=sys.stderr)
        if do_google_login(page, ctx):
            # Return to YouTube after login to collect YouTube-specific cookies
            page.goto('https://www.youtube.com', wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(3000)
        else:
            print('[camoufox] login failed — will keep existing cookies', file=sys.stderr)

    cookies = ctx.cookies()

# Safety check — never overwrite with fewer cookies than we started with
# (unless we successfully logged in, in which case new cookies are authoritative)
if existing and len(cookies) < len(existing) and not is_logged_in({'cookies': lambda: cookies}):
    print(
        f'[camoufox] WARNING: got {len(cookies)} cookies vs {len(existing)} original — '
        'keeping original (anonymous session, no credentials)',
        file=sys.stderr,
    )
    sys.exit(0)

# Don't overwrite if we still don't have auth cookies and had them before
had_auth = any(c['name'] == 'SID' and 'google.com' in c.get('domain', '') for c in existing)
has_auth = any(c['name'] == 'SID' and 'google.com' in c.get('domain', '') for c in cookies)

if had_auth and not has_auth:
    print(
        '[camoufox] WARNING: lost auth cookies — keeping original cookies.txt',
        file=sys.stderr,
    )
    sys.exit(0)

os.makedirs(os.path.dirname(os.path.abspath(COOKIES_FILE)), exist_ok=True)
with open(COOKIES_FILE, 'w', encoding='utf-8') as f:
    f.write(to_netscape(cookies))

print(f'[camoufox] saved {len(cookies)} cookies to {COOKIES_FILE}', file=sys.stderr)

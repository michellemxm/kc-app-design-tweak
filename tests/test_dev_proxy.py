"""The injecting reverse proxy that puts select-to-edit back on dev servers.

The bug this covers: framing a dev server DIRECTLY means its own index.html is
what loads, so the overlay is never injected and select-to-edit — the app's whole
purpose — silently does not exist. The postMessage bridge being origin-agnostic
is true and irrelevant: there was nothing in the page to talk to.

A stub upstream stands in for Vite so these run without a node_modules anywhere.
"""
import os
import sys
import tempfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-proxy-test-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


PAGE = (b'<!DOCTYPE html><html><head><title>t</title></head>'
        b'<body><div id="root"></div>'
        b'<script type="module" src="/src/main.tsx"></script></body></html>')


class Upstream(BaseHTTPRequestHandler):
    """Stands in for a dev server. Records what the proxy forwarded."""
    seen = []

    def log_message(self, *a):
        pass

    def _reply(self, code, ctype, body):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Upstream', 'yes')          # must survive the relay
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        Upstream.seen.append((self.command, self.path, dict(self.headers)))
        if self.path.startswith('/src/'):
            return self._reply(200, 'application/javascript', b'export default 1')
        if self.path == '/missing':
            return self._reply(404, 'text/html; charset=utf-8', b'<html><body>no</body></html>')
        if self.path == '/data.json':
            return self._reply(200, 'application/json', b'{"a":1}')
        return self._reply(200, 'text/html; charset=utf-8', PAGE)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        Upstream.seen.append(('POST', self.path, body))
        return self._reply(200, 'application/json', b'{"ok":true}')


up = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
up.daemon_threads = True
threading.Thread(target=up.serve_forever, daemon=True).start()
up_url = f'http://127.0.0.1:{up.server_address[1]}'

srv, proxy_url = server._start_inject_proxy(up_url)
check('the proxy starts and reports a loopback url',
      bool(proxy_url.startswith('http://127.0.0.1:')), True)
check('  ...on its OWN port, not the upstream one',
      proxy_url.rstrip('/').endswith(str(up.server_address[1])), False)


def get(path='/', **kw):
    r = urllib.request.urlopen(proxy_url.rstrip('/') + path, timeout=8, **kw)
    return r.status, r.read(), dict(r.headers)


# --- the actual fix -----------------------------------------------------
_, direct, _ = (0, urllib.request.urlopen(up_url, timeout=8).read(), 0)
check('the dev server itself has NO overlay (the bug)',
      b'__kiro_select_to_edit__' in direct, False)
status, body, headers = get('/')
check('through the proxy the overlay IS injected',
      b'__kiro_select_to_edit__' in body, True)
check('  ...before </body>', body.strip().endswith(b'</body></html>'), True)
check('  ...and the page is otherwise intact', b'<div id="root"></div>' in body, True)
# A <base> tag would repoint every relative URL; the proxy maps paths 1:1 so it
# must NOT add one. This is the difference between the two proxy modes.
check('no <base> tag is injected for a dev server',
      b'<base' in body.lower(), False)
check('the overlay script is served by the proxy itself',
      get(server._OVERLAY_PATH)[0], 200)
check('  ...as javascript',
      'javascript' in get(server._OVERLAY_PATH)[2].get('Content-Type', ''), True)

# --- transparency -------------------------------------------------------
check('non-HTML is passed through untouched', get('/src/main.tsx')[1], b'export default 1')
check('json is not rewritten', get('/data.json')[1], b'{"a":1}')
check('upstream headers survive', get('/data.json')[2].get('X-Upstream'), 'yes')
check('root-absolute paths reach the upstream unchanged',
      any(p == '/src/main.tsx' for _, p, _ in Upstream.seen), True)

# Header handling, measured on a request made THROUGH the proxy and tagged with a
# unique path so the direct-to-upstream probe above cannot be mistaken for it.
urllib.request.urlopen(urllib.request.Request(
    proxy_url.rstrip('/') + '/src/tagged.tsx',
    headers={'Accept-Encoding': 'gzip', 'Connection': 'keep-alive', 'X-Kiro': '1'}),
    timeout=8).read()
via = next(h for m, p, h in Upstream.seen
           if p == '/src/tagged.tsx' and isinstance(h, dict))
lower = {k.lower(): v for k, v in via.items()}
# Gzip would arrive compressed and could not be rewritten without decompressing.
check('a client Accept-Encoding: gzip never reaches the dev server',
      'gzip' in lower.get('accept-encoding', ''), False)
check('  ...it is replaced with identity',
      lower.get('accept-encoding'), 'identity')
check('hop-by-hop headers are not forwarded', 'connection' in lower, False)
check('ordinary client headers ARE forwarded', lower.get('x-kiro'), '1')
check('Host is rewritten to the upstream',
      lower.get('host', '').endswith(str(up.server_address[1])), True)

# A 404 page still gets the overlay: the dev server's own error page is a real
# page the user may want to comment on.
try:
    urllib.request.urlopen(proxy_url.rstrip('/') + '/missing', timeout=8)
    got404 = False
except urllib.error.HTTPError as e:
    got404 = e.code == 404 and b'__kiro_select_to_edit__' in e.read()
check('a 404 HTML page is relayed AND injected', got404, True)

req = urllib.request.Request(proxy_url, data=b'{"x":1}',
                             headers={'Content-Type': 'application/json'})
check('POST bodies are forwarded', urllib.request.urlopen(req, timeout=8).status, 200)
check('  ...with the body intact',
      any(b == b'{"x":1}' for m, p, b in Upstream.seen if m == 'POST'), True)

# --- lifecycle ----------------------------------------------------------
rec = {'proxy': srv}
server._stop_inject_proxy(rec)
check('stopping clears the handle', rec['proxy'], None)
try:
    urllib.request.urlopen(proxy_url, timeout=3)
    still = True
except (urllib.error.URLError, OSError):
    still = False
check('  ...and the port stops answering', still, False)
check('stopping a record with no proxy is a no-op',
      server._stop_inject_proxy({}) is None, True)

# An unreachable upstream must be a clean 502, not a traceback.
dead, dead_url = server._start_inject_proxy('http://127.0.0.1:1')
try:
    urllib.request.urlopen(dead_url, timeout=8)
    code = 200
except urllib.error.HTTPError as e:
    code = e.code
except OSError:
    code = -1
check('an unreachable dev server yields 502', code, 502)
server._stop_inject_proxy({'proxy': dead})
up.shutdown()

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL DEV-PROXY CHECKS PASSED')
sys.exit(1 if failed else 0)

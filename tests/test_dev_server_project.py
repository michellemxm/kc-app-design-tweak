"""Registering a project with a dev-server URL (throwaway data dir, loopback only).

A project is always identified by its FOLDER — that is where the agent edits.
An optional `previewUrl` only changes how it is PREVIEWED: framed directly at the
dev server instead of proxied from disk, because this backend cannot upgrade a
WebSocket and HMR dies behind the proxy.
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-devsrv-test-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

PORT = 8802
threading.Thread(
    target=lambda: server.ThreadingHTTPServer(('127.0.0.1', PORT), server.Handler).serve_forever(),
    daemon=True,
).start()
time.sleep(0.6)
B = f'http://127.0.0.1:{PORT}/api'


def post(path, body=None):
    req = urllib.request.Request(
        B + path, method='POST',
        data=json.dumps(body if body is not None else {}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=5).read())
    except urllib.error.HTTPError as e:
        return {'HTTP': e.code, **json.loads(e.read())}


def get(path):
    return json.loads(urllib.request.urlopen(B + path, timeout=5).read())


# `_valid_root` stores the RESOLVED path, and on macOS /var is a symlink to
# /private/var — so compare against the resolved form, not what mkdtemp returned.
FOLDER = os.path.realpath(tempfile.mkdtemp(prefix='dt-proj-'))
FOLDER2 = os.path.realpath(tempfile.mkdtemp(prefix='dt-proj2-'))

print('1. a folder-only project has no previewUrl (static, proxied — unchanged)')
r = post('/projects', {'path': FOLDER})
pid = r['project']['id']
assert 'previewUrl' not in r['project'], r
print(f"   -> {r['project']['name']} registered, proxied from disk")

print('2. attaching a dev-server URL to an existing project')
r = post('/projects/preview-url', {'id': pid, 'previewUrl': 'http://localhost:5173'})
assert r['project']['previewUrl'] == 'http://localhost:5173', r
print(f"   -> previewUrl={r['project']['previewUrl']}")

print('3. the folder is still the identity — projectRoot is unaffected')
# This is the point of hanging the URL off a folder project: a URL alone would
# leave the agent with nowhere to edit.
cap = post('/submit', {
    'type': 'visual_edit_request', 'comment': 'dev capture',
    'projectId': pid, 'previewUrl': 'http://localhost:5173/pricing',
    'selection': {'mode': 'single', 'elements': [{'tag': 'div', 'locator': 'body>div'}]},
})
req = [x for x in get('/queue')['pending'] if x['id'] == cap['id']][0]
assert req['projectRoot'] == FOLDER, req
print(f"   -> projectRoot={req['projectRoot']}")

print('4. clearing the URL reverts the project to proxied-from-disk')
r = post('/projects/preview-url', {'id': pid, 'previewUrl': ''})
assert 'previewUrl' not in r['project'], r
print('   -> previewUrl removed')

print('5. registering a project WITH a URL in one step')
r = post('/projects', {'path': FOLDER2, 'previewUrl': 'http://127.0.0.1:3000/'})
# The trailing slash is normalised off so the reload cache-buster can append
# cleanly and two spellings of one server do not look like two servers.
assert r['project']['previewUrl'] == 'http://127.0.0.1:3000', r
print(f"   -> previewUrl={r['project']['previewUrl']} (trailing slash normalised)")

print('6. re-adding the same folder with a new URL UPDATES it, not duplicates')
before = len(get('/projects')['projects'])
r = post('/projects', {'path': FOLDER2, 'previewUrl': 'http://localhost:4321'})
after = len(get('/projects')['projects'])
assert r.get('existing') and r.get('updated') == 'previewUrl', r
assert before == after, f'project count changed {before} -> {after}'
print(f"   -> updated in place to {r['project']['previewUrl']}, still {after} project(s)")

print('7. non-loopback URLs are refused (SSRF guard)')
codes = {}
for bad in ('http://evil.example.com:5173', 'https://localhost:5173',
            'file:///etc/passwd', 'javascript:alert(1)', 'http://169.254.169.254'):
    codes[bad] = post('/projects/preview-url', {'id': pid, 'previewUrl': bad}).get('HTTP')
for bad, code in codes.items():
    print(f'   {code}  {bad}')
assert all(c == 400 for c in codes.values()), codes

print('8. a bad URL at registration time is refused too')
bad = post('/projects', {'path': FOLDER, 'previewUrl': 'http://example.com'})
assert bad.get('HTTP') == 400, bad
print(f"   -> {bad['HTTP']} {bad['error'][:52]}…")

print('9. preview-url on an unknown project is a 404, not a silent no-op')
assert post('/projects/preview-url', {'id': 'nope', 'previewUrl': 'http://localhost:1'}).get('HTTP') == 404
print('   -> 404')

print('\nALL DEV-SERVER PROJECT CHECKS PASSED')

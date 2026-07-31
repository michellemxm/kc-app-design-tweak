"""End-to-end check of the batched request model (throwaway data dir, loopback only)."""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

# Fresh isolated data dir per run — nothing to clean up, nothing of the user's touched.
os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-batch-test-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

server._CFG['projects'] = [{'id': 'proj1', 'path': '/tmp', 'name': 'tmp'}]
threading.Thread(
    target=lambda: server.ThreadingHTTPServer(('127.0.0.1', 8801), server.Handler).serve_forever(),
    daemon=True,
).start()
time.sleep(0.6)
B = 'http://127.0.0.1:8801/api'


def call(path, body=None, method=None):
    req = urllib.request.Request(
        B + path,
        method=method or ('POST' if body is not None else 'GET'),
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'},
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=5).read())
    except urllib.error.HTTPError as e:
        return {'HTTP': e.code, **json.loads(e.read())}


def post(path, body=None):
    """These endpoints take their arguments in the query string, so an explicit
    method is required — a bodyless request would otherwise be sent as GET."""
    return call(path, body if body is not None else {}, method='POST')


def cap(text, tag, cls, follow=''):
    p = {
        'type': 'visual_edit_request', 'comment': text,
        'previewUrl': 'http://x/apps/poke-and-prose/api/proxy/proj1/index.html',
        'selection': {'mode': 'single', 'elements': [
            {'tag': tag, 'classes': [cls], 'locator': 'body>' + tag}]},
    }
    if follow:
        p['followUpTo'] = follow
    return call('/submit', p)


print('1. three comments accumulate into ONE draft')
a = cap('make this sticky', 'nav', 'site-header')
b = cap('gap to 24px', 'div', 'card-grid')
c = cap('mute the footer', 'footer', 'ft')
print(f'   labels {a["label"]}, {b["label"]}, {c["label"]}  same request: {a["id"] == b["id"] == c["id"]}')
q = call('/queue')['pending']
assert len(q) == 1 and len(q[0]['comments']) == 3 and q[0]['status'] == 'draft', q
print(f'   -> 1 request, 3 comments, status={q[0]["status"]}')

print('2. removing a draft comment keeps sub-numbers contiguous')
post(f'/delete-comment?id={a["id"]}&cid={b["cid"]}')
q = call('/queue')['pending'][0]
assert [x['index'] for x in q['comments']] == [1, 2], q
print(f'   -> indexes {[x["index"] for x in q["comments"]]}')

print('3. send seals the request')
r = post(f'/send?id={a["id"]}')['request']
assert r['state'] == 'sent' and all(x['status'] == 'sent' for x in r['comments']), r
print(f'   -> state={r["state"]} comments={[x["status"] for x in r["comments"]]}')

print('4. a comment after send opens a NEW draft (seal-on-send)')
d = cap('round the avatar', 'img', 'avatar')
qs = call('/queue')['pending']
assert len(qs) == 2 and d['id'] != a['id'] and d['label'].endswith('.1'), qs
print(f'   -> requests {[(x["number"], x["status"], len(x["comments"])) for x in qs]}')

print('5. per-comment progress + status via &cid=')
post(f'/thread?id={a["id"]}&cid={a["cid"]}',
     {'role': 'agent', 'text': 'editing Header.tsx', 'status': 'done'})
r = [x for x in call('/queue')['pending'] if x['id'] == a['id']][0]
cm = {x['cid']: x for x in r['comments']}
assert r['status'] == 'sent' and r['doneCount'] == 1, r
assert len(cm[a['cid']]['thread']) == 2 and cm[a['cid']]['status'] == 'done'
assert cm[c['cid']]['status'] == 'sent', 'sibling must not be touched'
print(f'   -> request status={r["status"]} doneCount={r["doneCount"]}/{len(r["comments"])},'
      f' sibling still {cm[c["cid"]]["status"]}')

print('6. all comments done -> request rolls up to done')
post(f'/thread?id={a["id"]}&cid={c["cid"]}', {'role': 'agent', 'text': 'done', 'status': 'done'})
r = [x for x in call('/queue')['pending'] if x['id'] == a['id']][0]
assert r['status'] == 'done', r
print(f'   -> status={r["status"]} doneCount={r["doneCount"]}/{len(r["comments"])}')

print('7. follow-up links to an earlier comment, ships in the current draft')
f = cap('actually make it 32px', 'div', 'card-grid', follow=c['cid'])
draft = [x for x in call('/queue')['pending'] if x['state'] == 'draft'][0]
fu = [x for x in draft['comments'] if x['cid'] == f['cid']][0]
assert fu['followUpTo'] == c['cid'] and draft['id'] == d['id'], fu
print(f'   -> {f["label"]} in request {draft["number"]} (draft), followUpTo set')

print('8. guards')
codes = {
    'send unknown id': post('/send?id=nope').get('HTTP'),
    'remove from sent request': post(f'/delete-comment?id={a["id"]}&cid={a["cid"]}').get('HTTP'),
    'thread unknown cid': post(f'/thread?id={a["id"]}&cid=nope', {'text': 'x'}).get('HTTP'),
}
print(f'   -> {codes}')
assert codes['send unknown id'] == 404
assert codes['remove from sent request'] == 409
assert codes['thread unknown cid'] == 404

print('9. archive moves the request into History with its comments intact')
post(f'/clear?id={a["id"]}')
hist = call('/history')['history']
assert hist and hist[0]['id'] == a['id'] and len(hist[0]['comments']) == 2, hist
print(f'   -> history has request {hist[0]["number"]} with {len(hist[0]["comments"])} comments')


def cap_raw(text, url, project_id=None, tag='div', source=None):
    """Capture with an arbitrary previewUrl — models a dev-server page."""
    el = {'tag': tag, 'classes': ['x'], 'locator': 'body>' + tag}
    if source:
        el['source'] = source
    p = {
        'type': 'visual_edit_request', 'comment': text, 'previewUrl': url,
        'selection': {'mode': 'single', 'elements': [el]},
    }
    if project_id is not None:
        p['projectId'] = project_id
    return call('/submit', p)


DEV_URL = 'http://localhost:5173/pricing'

print('10. an explicit projectId identifies a DEV-SERVER capture')
# The whole point: this URL has no /api/proxy/<id>/ to pattern-match, so
# without the explicit id the comment would belong to no project at all.
def find_comment(cid):
    for r in call('/queue')['pending']:
        for c in r['comments']:
            if c['cid'] == cid:
                return r, c
    raise AssertionError(f'comment {cid} not found in the queue')


d1 = cap_raw('dev server comment', DEV_URL, project_id='proj1')
req, cm = find_comment(d1['cid'])
print(f'   -> projectId={cm["projectId"]!r} projectRoot={req["projectRoot"]!r}')
assert cm['projectId'] == 'proj1', cm
assert req['projectRoot'] == '/tmp', req      # resolved from the registry, not the URL

print('11. a dev-server route does NOT become a bogus sourceFile')
# `/pricing` is a route, not a file on disk. Guessing a path here would send the
# agent to edit something that does not exist.
print(f'   -> sourceFile={cm["sourceFile"]!r}')
assert cm['sourceFile'] == '', cm

print('12. a dev-server comment still groups into ITS project\'s draft')
d2 = cap_raw('second dev comment', DEV_URL, project_id='proj1')
assert d2['id'] == d1['id'], 'second comment opened a different request'
print(f'   -> {d1["label"]} and {d2["label"]} share request {d2["number"]}')

print('13. two projects previewed from dev servers do NOT collide')
server._CFG['projects'].append({'id': 'proj2', 'path': '/tmp', 'name': 'other'})
d3 = cap_raw('other project', DEV_URL, project_id='proj2')
assert d3['id'] != d1['id'], 'projects collided into one draft'
print(f'   -> proj2 opened request {d3["number"]}, separate from {d1["number"]}')

print('14. proxied captures still resolve a real sourceFile (no regression)')
p1 = cap_raw('proxied', 'http://x/apps/poke-and-prose/api/proxy/proj1/index.html',
             project_id='proj1')
_, pc = find_comment(p1['cid'])
print(f'   -> sourceFile={pc["sourceFile"]!r}')
assert pc['sourceFile'] == '/tmp/index.html', pc

print('15. a payload with NO projectId still works (pre-change comments)')
p2 = cap_raw('legacy', 'http://x/apps/poke-and-prose/api/proxy/proj1/about.html')
_, lc = find_comment(p2['cid'])
print(f'   -> fell back to the URL: projectId={lc["projectId"]!r}')
assert lc['projectId'] == 'proj1' and lc['sourceFile'] == '/tmp/about.html', lc

print('16. the per-element source block reaches the agent')
# This is what makes dev-server projects targetable at all: the Vite plugin's
# data-kiro-source is resolved in the overlay and must survive to the summary.
hi = {'file': 'src/Pricing.tsx', 'line': 42, 'column': 6, 'confidence': 'high'}
s1 = cap_raw('mapped', DEV_URL, project_id='proj1', source=hi)
_, sc = find_comment(s1['cid'])
print(f'   -> source={sc["source"]}')
assert sc['source'] == hi, sc

print('17. an unrecognised `state` must NOT read back as an unsent draft')# Regression: an agent wrote state="done" into the file, and the old roll-up did
# `if state != "sent": return "draft"` — so a fully-worked request showed the
# "draft · not sent" badge and a Send bar in the left panel.
e = cap('badge regression check', 'section', 'hero')
eid = e['id']
qdir = __import__('pathlib').Path(os.environ['KIROCREW_APP_DATA_DIR']) / 'queue'
fp = qdir / f'{eid}.json'
raw = json.loads(fp.read_text())
for cm in raw['comments']:
    cm['status'] = 'done'
raw['state'] = 'done'                      # a value the server itself never writes
fp.write_text(json.dumps(raw, indent=2))
r = [x for x in call('/queue')['pending'] if x['id'] == eid][0]
print(f'   raw state={raw["state"]!r} -> reported status={r["status"]!r}')
assert r['status'] == 'done', f'expected done, got {r["status"]}'

print('18. a worked request can no longer collect new comments')
# Same file, still state="done": a fresh capture must open a NEW request rather
# than appending to one the agent has already acted on.
g = cap('should start a new request', 'aside', 'sidebar')
assert g['id'] != eid, 'capture leaked into an already-worked request'
print(f'   -> new capture opened request {g["number"]} (not {[x["number"] for x in call("/queue")["pending"] if x["id"] == eid]})')

print('19. progress on a draft normalises state, so the two cannot drift')
hid = g['id']
post(f'/thread?id={hid}&cid={g["cid"]}', {'role': 'agent', 'text': 'working'})
raw = json.loads((qdir / f'{hid}.json').read_text())
r = [x for x in call('/queue')['pending'] if x['id'] == hid][0]
print(f'   -> state={raw["state"]!r} sentAt set={bool(raw["sentAt"])} status={r["status"]!r}')
assert raw['state'] == 'sent' and raw['sentAt'] and r['status'] == 'sent'

print('\nALL CHECKS PASSED')

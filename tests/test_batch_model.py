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

print('10. an unrecognised `state` must NOT read back as an unsent draft')
# Regression: an agent wrote state="done" into the file, and the old roll-up did
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

print('11. a worked request can no longer collect new comments')
# Same file, still state="done": a fresh capture must open a NEW request rather
# than appending to one the agent has already acted on.
g = cap('should start a new request', 'aside', 'sidebar')
assert g['id'] != eid, 'capture leaked into an already-worked request'
print(f'   -> new capture opened request {g["number"]} (not {[x["number"] for x in call("/queue")["pending"] if x["id"] == eid]})')

print('12. progress on a draft normalises state, so the two cannot drift')
hid = g['id']
post(f'/thread?id={hid}&cid={g["cid"]}', {'role': 'agent', 'text': 'working'})
raw = json.loads((qdir / f'{hid}.json').read_text())
r = [x for x in call('/queue')['pending'] if x['id'] == hid][0]
print(f'   -> state={raw["state"]!r} sentAt set={bool(raw["sentAt"])} status={r["status"]!r}')
assert raw['state'] == 'sent' and raw['sentAt'] and r['status'] == 'sent'

print('\nALL CHECKS PASSED')

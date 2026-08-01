"""Per-app isolation: each web app is its own body of work.

Two things have to hold for the panel not to read as someone else's backlog the
moment you switch apps:

  • request NUMBERING is per project — app B's first request is "Request 1", not
    "Request 7" because six unrelated requests were filed against app A;
  • a comment captured while app B is in the preview joins app B's draft, never
    whichever draft happens to be open.

The second was already true (`_open_draft_file` takes a project id); it is
asserted here so it stays true.
"""
import json
import os
import sys
import tempfile

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-perapp-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


def mk(project_id, number, state='sent', where='queue'):
    # A request with NO comments derives as a draft whatever `state` says (see
    # _request_status), so a fixture meant to be sent must carry a sent comment —
    # otherwise every fixture is an open draft and the draft assertions are moot.
    d = server.QUEUE_DIR if where == 'queue' else server.HANDLED_DIR
    rid = server._new_id()
    fp = d / f'{rid}.json'
    status = 'new' if state == 'draft' else 'sent'
    fp.write_text(json.dumps({
        'type': 'visual_edit_batch', 'id': rid, 'number': number, 'state': state,
        'projectId': project_id, 'projectRoot': f'/tmp/{project_id}',
        'createdAt': server._now_iso(), 'sentAt': '', 'thread': [],
        'comments': [{'cid': f'c-{rid}', 'index': 1, 'status': status,
                      'comment': 'x', 'thread': []}],
    }))
    return fp


# --- numbering is per project -------------------------------------------
check('a project with no requests starts at 1', server._next_number('A'), 1)
mk('A', 1)
mk('A', 2)
check('it continues within the project', server._next_number('A'), 3)
check('a DIFFERENT app also starts at 1', server._next_number('B'), 1)
mk('B', 1)
check('  ...and continues independently', server._next_number('B'), 2)
check('  ...without disturbing the first', server._next_number('A'), 3)
# Numbers must not be reused after archiving, or history and the live list would
# both hold a "Request 3" for the same app.
mk('A', 9, where='handled')
check('archived requests still occupy their number', server._next_number('A'), 10)
# A request written before per-project numbering has no projectId; it must not
# leak into any project's sequence.
mk('', 99)
check('an unscoped legacy request is not counted for a project',
      server._next_number('B'), 2)
mk('C', None)
check('a malformed number does not raise', server._next_number('C'), 1)

# --- drafts never cross projects ----------------------------------------
fa = mk('A', 10, state='draft')
check("app A's draft is found for app A", server._open_draft_file('A'), fa)
check('  ...and is NOT offered to app B', server._open_draft_file('B'), None)
fb = mk('B', 2, state='draft')
check('each app can hold its own open draft at once',
      (server._open_draft_file('A'), server._open_draft_file('B')), (fa, fb))
# A sent request is not a draft, so a late comment opens a fresh one instead of
# being appended to work the agent already has.
for fp in (fa, fb):
    req = server._read_request(fp)
    req['state'] = 'sent'
    req['comments'] = [{'cid': 'c1', 'status': 'sent', 'comment': 'x'}]
    fp.write_text(json.dumps(req))
check('a sent request stops being a draft', server._open_draft_file('A'), None)

# --- the queue/history endpoints still return everything ----------------
# Scoping is the PANEL's job: one fetch serves every app, and the panel filters
# by projectId. If the backend filtered too, switching apps would need a refetch.
pending = [server._read_request(f) for f in server._pending_files()]
ids = {r.get('projectId') for r in pending if r}
check('/queue data spans every project (the panel scopes it)',
      {'A', 'B'} <= ids, True)

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL PER-APP CHECKS PASSED')
sys.exit(1 if failed else 0)

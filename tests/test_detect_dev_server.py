"""Dev-server detection: port -> pid -> working directory -> project match.

`lsof` and the HTTP probe are both stubbed, so these assert the LOGIC rather than
whatever happens to be listening on the machine running them.
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-detect-test-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

ROOT = Path(tempfile.mkdtemp(prefix='dt-site-')).resolve()
OTHER = Path(tempfile.mkdtemp(prefix='dt-other-')).resolve()
(ROOT / 'apps' / 'web').mkdir(parents=True)      # monorepo shape

# Keep the real implementations so the last check can exercise one of them.
REAL_LISTENERS = server._loopback_listeners

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


def fake(listeners, cwds, html_ports):
    """Stub the two lsof calls and the HTTP probe."""
    server._loopback_listeners = lambda: dict(listeners)
    server._cwd_for_pids = lambda pids: {p: c for p, c in cwds.items() if p in pids}
    server._serves_html = lambda port: port in html_ports


# --- the core case: one server, rooted in the project ---------------------
fake({5173: 100}, {100: str(ROOT)}, {5173})
check('one HTML server in the project root is detected',
      server._auto_dev_server(ROOT), 'http://localhost:5173')

# --- it must not claim servers belonging to other folders -----------------
fake({5173: 100}, {100: str(OTHER)}, {5173})
check('a server rooted elsewhere is NOT claimed',
      server._auto_dev_server(ROOT), '')

# --- discrimination: the API server in the same folder --------------------
# Both run from the project, but only one answers with a page. Attaching the
# API server would frame JSON instead of the app.
fake({5173: 100, 4000: 101}, {100: str(ROOT), 101: str(ROOT)}, {5173})
check('a non-HTML listener in the same folder is ignored',
      server._auto_dev_server(ROOT), 'http://localhost:5173')

# --- ambiguity must NOT be resolved by guessing ---------------------------
fake({5173: 100, 3000: 101}, {100: str(ROOT), 101: str(ROOT)}, {5173, 3000})
check('two HTML servers => no automatic pick', server._auto_dev_server(ROOT), '')
check('  ...but both are offered to the user',
      len(server._detect_dev_servers(ROOT)), 2)

# --- monorepo: server runs from a subfolder -------------------------------
fake({5173: 100}, {100: str(ROOT / 'apps' / 'web')}, {5173})
check('a server in a subfolder still belongs to the project',
      server._auto_dev_server(ROOT), 'http://localhost:5173')

# --- ordering: root-level beats nested -----------------------------------
fake({5173: 100, 3000: 101},
     {100: str(ROOT / 'apps' / 'web'), 101: str(ROOT)}, {5173, 3000})
check('the shallower cwd sorts first',
      server._detect_dev_servers(ROOT)[0]['port'], 3000)

# --- nothing running -----------------------------------------------------
fake({}, {}, set())
check('no listeners => no suggestion', server._auto_dev_server(ROOT), '')
check('no listeners => empty candidate list', server._detect_dev_servers(ROOT), [])

# --- a pid with no readable cwd is skipped, not crashed on ---------------
fake({5173: 100}, {}, {5173})
check('a listener whose cwd cannot be read is skipped',
      server._detect_dev_servers(ROOT), [])

# --- lsof missing entirely ----------------------------------------------
# _lsof_fields already swallows OSError and returns [], so the layer above must
# turn that into "no candidates" rather than propagating or inventing data.
server._loopback_listeners = REAL_LISTENERS
server._lsof_fields = lambda args: []
check('lsof unavailable degrades to no candidates, not an exception',
      server._loopback_listeners(), {})

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL DETECTION CHECKS PASSED')
sys.exit(1 if failed else 0)

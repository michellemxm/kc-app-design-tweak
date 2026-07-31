"""Project classification: previewable from disk, or needs its own dev server?

The distinction is NOT "does it have an index.html" — a Vite project has one, and
serving it statically renders a blank page because its only script is TypeScript.
So the classifier resolves the entry and asks whether that entry can stand alone.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-classify-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


def project(**files):
    """Build a throwaway project folder. Keys are relative paths."""
    root = Path(tempfile.mkdtemp(prefix='dt-proj-'))
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return root


VITE_HTML = '<html><body><div id="root"></div>' \
            '<script type="module" src="./src/main.tsx"></script></body></html>'
BUILT_HTML = '<html><body><div id="root"></div>' \
             '<script type="module" src="/assets/index-a1b2.js"></script></body></html>'
PLAIN_HTML = '<html><body><h1>Hello</h1><script src="js/app.js"></script></body></html>'
PKG = json.dumps({'scripts': {'dev': 'vite', 'build': 'vite build'}})

# --- static sites preview from disk -------------------------------------
r = project(**{'index.html': PLAIN_HTML})
check('a plain static site needs no dev server',
      server._classify_project(r)['needsDevServer'], False)

r = project(**{'public/index.html': PLAIN_HTML})
check('a static site nested in public/ needs no dev server',
      server._classify_project(r)['needsDevServer'], False)

# A built bundle is static even though the project clearly has a dev script —
# this is the "register dist/ instead" escape hatch, so it must classify static.
r = project(**{'index.html': BUILT_HTML, 'package.json': PKG})
check('a BUILT bundle is static even with a dev script present',
      server._classify_project(r)['needsDevServer'], False)

# --- framework projects need one ---------------------------------------
r = project(**{'index.html': VITE_HTML, 'package.json': PKG, 'package-lock.json': '{}'})
c = server._classify_project(r)
check('a vite template needs a dev server', c['needsDevServer'], True)
check('  ...and names the entry that gave it away', c['unbundledEntry'], './src/main.tsx')
check('  ...and the command to run', c['devCommand'], 'npm run dev')

# No HTML at all, but a dev script → the framework owns the entry (Next, Nuxt…)
r = project(**{'package.json': PKG, 'package-lock.json': '{}'})
check('no HTML entry + a dev script => needs a dev server',
      server._classify_project(r)['needsDevServer'], True)

# --- neither: nothing to do -------------------------------------------
r = project(**{'README.md': '# nothing here'})
c = server._classify_project(r)
check('an empty folder does not claim to need a dev server', c['needsDevServer'], False)
check('  ...and offers no command', c['devCommand'], '')

# A framework template with NO dev script: still needs one, but we cannot start it.
# The UI has to tell the user to start it themselves rather than show a dead button.
r = project(**{'index.html': VITE_HTML})
c = server._classify_project(r)
check('a template with no package.json still needs a dev server', c['needsDevServer'], True)
check('  ...with no command to offer', c['devCommand'], '')

# --- package manager comes from the lockfile --------------------------
for lock, pm in (('pnpm-lock.yaml', 'pnpm'), ('yarn.lock', 'yarn'),
                 ('package-lock.json', 'npm')):
    r = project(**{'package.json': PKG, lock: ''})
    check(f'{lock} => {pm}', server._dev_command(r), [pm, 'run', 'dev'])

r = project(**{'package.json': PKG, 'bun.lockb': ''})
check('bun.lockb => bun run', server._dev_command(r), ['bun', 'run', 'dev'])

# pnpm wins over a co-existing package-lock.json (monorepos often carry both).
r = project(**{'package.json': PKG, 'pnpm-lock.yaml': '', 'package-lock.json': '{}'})
check('the more specific manager wins when two lockfiles exist',
      server._dev_command(r)[0], 'pnpm')

# --- script name fallbacks -------------------------------------------
r = project(**{'package.json': json.dumps({'scripts': {'start': 'react-scripts start'}})})
check('falls back to `start` when there is no `dev`',
      server._dev_command(r), ['npm', 'run', 'start'])
r = project(**{'package.json': json.dumps({'scripts': {'build': 'tsc'}})})
check('a build-only project offers no dev command', server._dev_command(r), [])
r = project(**{'package.json': '{ not json'})
check('malformed package.json does not raise', server._dev_command(r), [])

# --- refusing to start without dependencies --------------------------
# Spawning `npm run dev` with no node_modules fails slowly and cryptically;
# saying so up front is the useful answer.
r = project(**{'package.json': PKG, 'package-lock.json': '{}', 'index.html': VITE_HTML})
res = server._start_dev_proc('nodeps', r)
check('start refuses when node_modules is missing', res['ok'], False)
check('  ...naming install as the fix', 'install' in res['error'], True)

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL CLASSIFICATION CHECKS PASSED')
sys.exit(1 if failed else 0)

"""A bundler template must be reported, not served as a blank page.

`<script type="module" src="./app/main.tsx">` needs Vite to transform it. Served
from disk, the browser gets TypeScript, refuses to execute it, and leaves an empty
`#root` — HTTP 200, valid HTML, nothing on screen. Every layer reports success,
which is why this has to be detected explicitly.
"""
import os
import sys
import tempfile

os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-tmpl-test-')
sys.path.insert(0, 'backend')
import server  # noqa: E402

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


def page(*body):
    return ('<!DOCTYPE html><html><head><title>t</title></head><body>'
            + ''.join(body) + '</body></html>').encode()


# --- must be caught: the real shapes ------------------------------------
check('vite react template (.tsx)',
      server._unbundled_entry(page('<div id="root"></div>',
                                   '<script type="module" src="./app/main.tsx"></script>')),
      './app/main.tsx')
check('plain .ts entry',
      server._unbundled_entry(page('<script type="module" src="/src/main.ts"></script>')),
      '/src/main.ts')
check('.jsx entry',
      server._unbundled_entry(page('<script type="module" src="src/index.jsx"></script>')),
      'src/index.jsx')
check('attribute order reversed (src before type)',
      server._unbundled_entry(page('<script src="./main.tsx" type="module"></script>')),
      './main.tsx')
check('single quotes + extra attributes',
      server._unbundled_entry(page("<script defer type='module' crossorigin src='./x/main.tsx'></script>")),
      './x/main.tsx')
check('uppercase tag',
      server._unbundled_entry(page('<SCRIPT TYPE="MODULE" SRC="./main.TSX"></SCRIPT>')),
      './main.TSX')

# --- must NOT be caught: real static sites -----------------------------
# A false positive here replaces a WORKING page with an explanation, which is
# worse than the bug being fixed.
check('a bundled .js module is fine statically',
      server._unbundled_entry(page('<script type="module" src="/assets/index-a1b2.js"></script>')), '')
check('a classic (non-module) script is fine',
      server._unbundled_entry(page('<script src="js/app.js"></script>')), '')
check('no scripts at all',
      server._unbundled_entry(page('<h1>Hello</h1>')), '')
check('inline module with no src',
      server._unbundled_entry(page('<script type="module">console.log(1)</script>')), '')
check('a .tsx mentioned in TEXT, not a script src',
      server._unbundled_entry(page('<p>edit app/main.tsx to start</p>')), '')
check('a .tsx in a non-module script is left alone',
      # Unusual, but it is not our business to rewrite it — only module entries
      # are the blank-page signature.
      server._unbundled_entry(page('<script src="./main.tsx"></script>')), '')
check('.json module (import maps / data) is not a bundler entry',
      server._unbundled_entry(page('<script type="module" src="./data.json"></script>')), '')

# --- the built output of the same project SHOULD serve -----------------
# This is the escape hatch the diagnostic points at, so it must actually work.
check('a production build index.html is served normally',
      server._unbundled_entry(page(
          '<div id="root"></div>',
          '<script type="module" crossorigin src="/assets/index-DkP2.js"></script>',
          '<link rel="stylesheet" href="/assets/index-9Xa.css">')), '')

# --- non-UTF8 / binary must not explode --------------------------------
check('undecodable bytes do not raise',
      server._unbundled_entry(b'\xff\xfe\x00binary'), '')

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL BUNDLER-TEMPLATE CHECKS PASSED')
sys.exit(1 if failed else 0)

"""Finding the Node toolchain when PATH does not have it.

The gateway spawns this backend with a minimal PATH (typically
/usr/bin:/bin:/usr/sbin:/sbin), so `npm` is not resolvable by name even though it
works in the user's terminal. Spawning by bare name fails with:

    [Errno 2] No such file or directory: 'npm'

Two things have to be right: the binary is resolved absolutely, AND the child's
PATH contains its directory — `npm run dev` shells out to `node` itself, so a
correctly-spawned npm with a bare PATH fails one level deeper.
"""
import os
import sys
import tempfile
from pathlib import Path

# Strip PATH *before* importing, exactly like the gateway's environment.
os.environ['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
os.environ['KIROCREW_APP_DATA_DIR'] = tempfile.mkdtemp(prefix='dt-path-test-')
sys.path.insert(0, 'backend')
import shutil  # noqa: E402
import server  # noqa: E402

checks = []


def check(name, got, want):
    checks.append({'name': name, 'ok': got == want, 'got': got, 'want': want})


# --- the failure this fixes ---------------------------------------------
check('PATH alone cannot find npm (the reported bug)',
      shutil.which('npm'), None)
resolved = server._resolve_bin('npm')
check('_resolve_bin finds it anyway', resolved is not None, True)
check('  ...as an absolute, executable path',
      bool(resolved and resolved.is_absolute() and os.access(resolved, os.X_OK)), True)

# --- the second-order failure: npm needs node on PATH ------------------
env = server._child_env(resolved.parent)
check("the child's PATH includes the toolchain dir",
      str(resolved.parent) in env['PATH'].split(os.pathsep), True)
check('  ...at the FRONT, so it wins over any system copy',
      env['PATH'].split(os.pathsep)[0], str(resolved.parent))
check('the original PATH entries survive',
      '/usr/bin' in env['PATH'].split(os.pathsep), True)
check('PATH has no duplicate entries',
      len(env['PATH'].split(os.pathsep)), len(set(env['PATH'].split(os.pathsep))))
# Our own NODE_OPTIONS (set for KiroCrew's own builds) would leak into the
# user's dev server and change how THEIR project builds.
os.environ['NODE_OPTIONS'] = '--require /tmp/some-shim.cjs'
check('NODE_OPTIONS is not inherited by the dev server',
      'NODE_OPTIONS' in server._child_env(resolved.parent), False)
del os.environ['NODE_OPTIONS']

# --- a missing toolchain is an explanation, not a traceback ------------
res = server._resolve_bin('definitely-not-a-real-package-manager')
check('an unknown binary resolves to None', res, None)

proj = Path(tempfile.mkdtemp(prefix='dt-noyarn-'))
(proj / 'package.json').write_text('{"scripts":{"dev":"vite"}}')
(proj / 'yarn.lock').write_text('')          # claims yarn, which is not installed
(proj / 'node_modules').mkdir()
out = server._start_dev_proc('noyarn', proj)
check('a lockfile naming an uninstalled manager fails cleanly', out['ok'], False)
check('  ...saying it could not be found', 'Could not find' in out['error'], True)
check('  ...and pointing at the manual route',
      'Dev server' in out['error'], True)

failed = 0
for c in checks:
    print(f"  {'PASS' if c['ok'] else 'FAIL'}  {c['name']}")
    if not c['ok']:
        failed += 1
        print(f"        got {c['got']!r}, want {c['want']!r}")
print(f'\n{failed} CHECK(S) FAILED' if failed else '\nALL TOOLCHAIN-PATH CHECKS PASSED')
sys.exit(1 if failed else 0)

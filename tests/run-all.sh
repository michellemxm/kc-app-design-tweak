#!/usr/bin/env bash
# Run every check. From the app root: tests/run-all.sh
#
# Each suite boots the real backend against a throwaway data dir on loopback and
# touches nothing installed. test_toolchain_path.py deliberately strips PATH so it
# exercises the gateway's stripped environment rather than your shell's.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
run() {
  local label=$1; shift
  if out=$("$@" 2>&1); then
    printf '  %-28s %s\n' "$label" "$(printf '%s' "$out" | tail -1)"
  else
    printf '  %-28s FAILED\n' "$label"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    fail=1
  fi
}

echo "syntax + manifest"
run "backend compiles" python3 -m py_compile backend/server.py
run "ui/index.mjs" node --check ui/index.mjs
run "inject/select-to-edit.js" node --check inject/select-to-edit.js
run "app.json" python3 -c "import json;json.load(open('app.json'));print('valid')"

echo "suites"
for f in tests/test_*.py; do run "$(basename "$f")" python3 "$f"; done
for f in tests/test_*.mjs; do run "$(basename "$f")" node "$f"; done

echo "host CSS"
run "audit_host_classes.py" python3 tests/audit_host_classes.py

[ "$fail" -eq 0 ] && echo "
ALL GREEN" || echo "
SOMETHING FAILED"
exit "$fail"

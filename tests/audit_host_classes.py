"""Find Tailwind classes this app uses that the host's compiled CSS does not ship.

Design Tweak has no build step — it borrows the dashboard's already-compiled
Tailwind. That build is purged to the classes the dashboard itself uses, so any
class only this app references resolves to nothing, silently, with no console
error. This script names them.
"""
import pathlib
import re
import sys

HOST_DIST = pathlib.Path(
    '/Applications/KiroCrew.app/Contents/Resources/backend-dist'
    '/kirocrew-backend/lib/python3.12/site-packages/kiro_crew/static/dist/assets'
)

# Utilities that are pure markers with no generated rule of their own, or that
# the app supplies via inline style anyway — not real misses.
IGNORE = {'group', 'peer', 'app-icon', 'app-icon-nav', 'lucide-inline'}


def used_classes(src: str) -> set[str]:
    found = set()
    for m in re.finditer(r"className:\s*[`'\"]([^`'\"]+)", src):
        # Drop ${...} interpolations first — their contents are JS expressions
        # (identifiers, operators), not class names.
        literal = re.sub(r'\$\{[^}]*\}?', ' ', m.group(1))
        for name in literal.split():
            if name and '{' not in name and '}' not in name:
                found.add(name)
    return found


# Characters Tailwind backslash-escapes inside a generated selector, so
# `text-[13px]` is emitted as `.text-\[13px\]`. The audit has to match that
# backslash or every arbitrary-value utility reads as a false miss.
_TW_ESCAPED = set('[]/.:%()')


def selector_regex(name: str) -> str:
    out = []
    for ch in name:
        if ch in _TW_ESCAPED:
            out.append(r'\\' + re.escape(ch))   # literal backslash, then the char
        else:
            out.append(re.escape(ch))
    return ''.join(out)


def main() -> int:
    ui = pathlib.Path('ui/index.mjs')
    if not ui.is_file():
        print('run from the app root (ui/index.mjs not found)')
        return 1
    sheets = sorted(HOST_DIST.glob('*.css'))
    if not sheets:
        print(f'no host CSS found under {HOST_DIST}')
        return 1
    css = '\n'.join(p.read_text(encoding='utf-8', errors='replace') for p in sheets)

    names = used_classes(ui.read_text())
    absent = []
    for name in sorted(names):
        if name in IGNORE:
            continue
        bare = name.split(':')[-1]          # drop hover: / disabled: variants
        if not re.search(r'\.' + selector_regex(bare) + r'[,{\s:\\]', css):
            absent.append(name)

    print(f'host sheets   : {", ".join(p.name for p in sheets)}')
    print(f'classes used  : {len(names)}')
    print(f'not in bundle : {len(absent)}\n')
    for name in absent:
        print('  ABSENT  ' + name)
    if not absent:
        print('  every class the app uses exists in the host bundle')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Migrate pre-batch queue files (one comment per request) to the batch shape.

Each old `visual_edit_request` file becomes a `visual_edit_batch` holding that
single comment. Idempotent — files already carrying `comments[]` are skipped.
Writes a `.bak` beside every file it rewrites.
"""
import json
import os
import shutil
import sys
from pathlib import Path


def data_dir() -> Path:
    env = os.environ.get('KIROCREW_APP_DATA_DIR')
    if env:
        return Path(env).expanduser()
    home = os.environ.get('KIROCREW_HOME')
    base = Path(home).expanduser() if home else Path.home() / '.kiro/crew'
    return base / 'apps/poke-and-prose/data'


def migrate(fp: Path, number: int, *, apply: bool) -> str:
    try:
        old = json.loads(fp.read_text('utf-8'))
    except (OSError, ValueError) as exc:
        return f'SKIP  {fp.name} — unreadable ({exc})'
    if not isinstance(old, dict):
        return f'SKIP  {fp.name} — not an object'
    if 'comments' in old:
        return f'SKIP  {fp.name} — already batch format'

    status = old.get('status', 'new')
    thread = old.get('thread')
    if not isinstance(thread, list):
        thread = [{'role': 'user', 'text': old.get('comment', ''),
                   'ts': old.get('createdAt', '')}]

    new = {
        'type': 'visual_edit_batch',
        'id': old.get('id') or fp.stem,
        'number': old.get('number') or number,
        # An old file was dispatched the instant it was captured, so anything
        # that isn't still 'new' was already sent.
        'state': 'draft' if status == 'new' else 'sent',
        'projectId': '',
        'projectRoot': old.get('projectRoot', ''),
        'createdAt': old.get('createdAt', ''),
        'sentAt': '' if status == 'new' else old.get('createdAt', ''),
        'thread': [],
        'comments': [{
            'cid': (old.get('id') or fp.stem),
            'index': 1,
            'status': status,
            'comment': old.get('comment', ''),
            'createdAt': old.get('createdAt', ''),
            'selection': old.get('selection') or {'mode': 'single', 'elements': []},
            'previewUrl': old.get('previewUrl', ''),
            'sourceFile': old.get('sourceFile', ''),
            'followUpTo': '',
            'thread': thread,
        }],
    }
    if old.get('devServer'):
        new['comments'][0]['devServer'] = old['devServer']

    if apply:
        shutil.copy2(fp, fp.with_suffix('.json.bak'))
        fp.write_text(json.dumps(new, indent=2), encoding='utf-8')
    return (f'{"OK   " if apply else "WOULD"} {fp.name} — request {new["number"]}, '
            f'state={new["state"]}, 1 comment')


def main() -> int:
    apply = '--apply' in sys.argv
    root = data_dir()
    if not root.is_dir():
        print(f'no data dir at {root}')
        return 1
    print(f'data dir: {root}')
    print('mode: APPLY' if apply else 'mode: DRY RUN (pass --apply to write)')
    seen = 0
    for sub in ('queue', 'handled'):
        d = root / sub
        if not d.is_dir():
            continue
        for fp in sorted(d.glob('*.json')):
            seen += 1
            print('  ' + migrate(fp, seen, apply=apply))
    if not seen:
        print('  nothing to migrate')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

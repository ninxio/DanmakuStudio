"""Copy a reviewable public source snapshot without copying Git history or local data.

Run from the project root. The destination must be a new directory under
.release-export; this script never deletes files, initializes Git, or publishes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT_FILES = {
    '.gitignore', '.prettierrc', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'SECURITY.md', 'RELEASE_NOTES.md', 'package.json', 'pnpm-lock.yaml', 'index.html', 'eslint.config.js',
    'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'tsconfig.app.json',
    'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts',
    'playwright.release.config.ts',
}
EXACT_FILES = {
    'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
    'src-tauri/tauri.conf.json', 'src-tauri/app-icon.svg',
    'docs/USER_GUIDE.md', 'docs/ALGORITHMS.md', 'docs/PRIVACY.md', 'docs/BUILDING.md',
    'docs/PROMOTION.md', 'docs/licenses/DanmakuBox-MIT.txt',
    'ml/contracts/alignment-multimodal-rule-snapshot-cross-language-vector-v1.json',
    'ml/contracts/alignment-multimodal-blind-review-cross-language-vector-v1.json',
    'ml/contracts/alignment-shadow-risk-cross-language-vector-v1.json',
    'ml/contracts/alignment-shadow-risk-local-plan-cross-language-vector-v1.json',
}
PREFIXES = ('src/', 'src-tauri/src/', 'src-tauri/icons/', 'src-tauri/capabilities/',
            'public/', 'fixtures/', 'tests/', 'scripts/')
BLOCKED_PARTS = {'.git', 'node_modules', '__pycache__', 'target', 'dist'}
BLOCKED_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.log', '.pyc'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', default='DanmakuStudio')
    args = parser.parse_args()
    if not args.name or Path(args.name).name != args.name or args.name in {'.', '..'}:
        parser.error('name must be a single directory name')
    root = Path.cwd().resolve()
    export_root = (root / '.release-export').resolve()
    if export_root.parent != root:
        raise RuntimeError('Export directory must stay inside the checkout')
    destination = export_root / args.name
    if destination.exists():
        raise RuntimeError('Destination already exists; choose a new name. Nothing was changed.')
    tracked = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root)
    selected = []
    for name in sorted(set(tracked.decode('utf-8').split('\0'))):
        if not name or not (name in ROOT_FILES or name in EXACT_FILES or name.startswith(PREFIXES)):
            continue
        relative = Path(name)
        if BLOCKED_PARTS.intersection(relative.parts) or relative.suffix.lower() in BLOCKED_SUFFIXES or relative.name.startswith('.env'):
            raise RuntimeError(f'Unexpected file in public source selection: {name}')
        source = root / relative
        if not source.exists():
            continue  # tracked deletion in the current working tree
        if source.is_symlink() or source.resolve() != source.absolute() or not source.is_file():
            raise RuntimeError(f'Public source must contain regular files: {name}')
        selected.append((name, source.read_bytes()))
    required = ROOT_FILES | (EXACT_FILES - {'src-tauri/app-icon.svg'})
    missing = required - {name for name, _ in selected}
    if missing:
        raise RuntimeError(f'Missing required public files: {sorted(missing)}')
    destination.mkdir(parents=True)
    manifest = []
    for name, data in selected:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        manifest.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    (destination / 'PUBLIC_SOURCE_MANIFEST.json').write_text(
        json.dumps({'format': 1, 'files': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(manifest), 'destination': str(destination), 'historyCopied': False}))

if __name__ == '__main__':
    main()

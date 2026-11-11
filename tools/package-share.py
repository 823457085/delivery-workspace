#!/usr/bin/env python3
"""只从源码白名单重新生成分享包，绝不打包本机状态和认证文件。"""
from pathlib import Path
import hashlib
import json
import re
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'Delivery-Workspace-share.zip'
directories = ['server', 'shared', 'src', 'test', 'tools', 'support', 'docs', 'examples',
               'scripts/cursor-accounts', 'scripts/ai-accounts',
               'plugins/jira', 'plugins/confluence', 'plugins/wecom', 'plugins/todos', 'plugins/example-notes']
root_files = ['README.md', 'AGENTS.md', '.env.example', '.gitignore', '.npmrc', 'package.json', 'pnpm-lock.yaml',
              'pnpm-workspace.yaml', 'index.html', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts',
              'public/catchup/apex-930.json', 'public/system-project-import.xlsx',
              'scripts/bootstrap.mjs', 'scripts/doctor.mjs', 'scripts/runtime-requirements.mjs', 'scripts/start.mjs',
              'scripts/refactor-workbook.py', 'scripts/integration-capture-lock.ts', 'scripts/integration-cleared-issues.ts',
              'scripts/integration-execution-progress.ts', 'scripts/merchant-integration-progress.ts',
              'scripts/render-integration-request-evidence.ts', 'scripts/send-integration-evidence.ts', 'scripts/state-backup.ts']
blocked = {'.git', '.data', '.local', '.verify', 'node_modules', '__pycache__', 'credentials', 'auth.json',
           'config.toml', 'sync-state.json'}
files = ['README.md', 'START_HERE.md', 'FEATURES.md', 'VERIFICATION.md', 'AGENTS.md', 'SOURCE-SNAPSHOT.json',
              '.env.example', '.gitignore', '.npmrc', 'package.json', 'pnpm-lock.yaml',
              'pnpm-workspace.yaml', 'index.html', 'tsconfig.json', 'tsconfig.server.json',
              'vite.config.ts', 'delivery.mjs', '启动.command', 'scripts/refactor-workbook.py',
              'scripts/integration-capture-lock.ts', 'scripts/integration-cleared-issues.ts',
              'scripts/integration-execution-progress.ts', 'scripts/merchant-integration-progress.ts',
              'scripts/render-integration-request-evidence.ts', 'scripts/send-integration-evidence.ts',
              'scripts/state-backup.ts']
blocked = {'.git', '.data', '.local', '.verify', 'node_modules', '__pycache__', 'credentials', 'auth.json', 'config.toml'}
files = [root / name for name in root_files]
for name in directories:
    for file in (root / name).rglob('*'):
        relative = file.relative_to(root)
        if any(part in blocked or part.startswith('.') for part in relative.parts):
            continue
        if relative.parts[0] == 'scripts' and file.suffix not in {'.py', '.md'}:
            continue
        if file.is_symlink():
            raise SystemExit(f'分享包拒绝符号链接: {relative}')
        if file.is_file() and not file.name.startswith('.env') and file.suffix not in {'.pyc', '.log', '.sqlite', '.db'} and file.name != '.DS_Store':
            files.append(file)
secrets = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}')
for file in files:
    try:
        text = file.read_text()
    except UnicodeError:
        continue
    if secrets.search(text):
        raise SystemExit(f'请检查可能的凭据，未生成包: {file.relative_to(root)}')
manifest = {'format': 1, 'product': 'Delivery Workspace', 'runtimeDataIncluded': False, 'credentialsIncluded': False,
            'files': {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(files)}}
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(files):
        archive.write(file, 'Delivery-Workspace/' + file.relative_to(root).as_posix())
    archive.writestr('Delivery-Workspace/PACKAGE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None, '压缩包校验失败'
    assert len(archive.namelist()) == len(files) + 1
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
print(json.dumps({'archive': str(output), 'files': len(files) + 1, 'bytes': output.stat().st_size,
                  'sha256': checksum}, ensure_ascii=False))

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

test('源码分享包包含账号读取所需 Python 依赖，排除账号记录与认证文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'account-share-package-'));
  const required = ['scripts/cursor-accounts/bridge.py', 'scripts/cursor-accounts/cursor_accounts.py',
    'scripts/cursor-accounts/keychain_native.py',
    'scripts/ai-accounts/bridge.py', 'scripts/ai-accounts/common.py', 'scripts/ai-accounts/codex_adapter.py',
    'scripts/ai-accounts/claude_adapter.py', 'scripts/ai-accounts/codex_usage.py', 'scripts/refactor-workbook.py',
    'scripts/integration-capture-lock.ts', 'scripts/integration-cleared-issues.ts',
    'scripts/integration-execution-progress.ts', 'scripts/merchant-integration-progress.ts',
    'scripts/render-integration-request-evidence.ts', 'scripts/send-integration-evidence.ts', 'scripts/state-backup.ts'];
  try {
    await mkdir(path.join(directory, 'tools'), { recursive: true });
    await copyFile(new URL('../tools/package-share.py', import.meta.url), path.join(directory, 'tools/package-share.py'));
    await exec('/usr/bin/python3', ['-c', `import ast,pathlib,sys
root=pathlib.Path(sys.argv[1])
tree=ast.parse((root/'tools/package-share.py').read_text())
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='root_files' for t in node.targets):
  for name in ast.literal_eval(node.value):
   p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{}' if name.endswith('.json') else '# isolated source fixture')
`, directory]);
    for (const name of required) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await copyFile(new URL('../' + name, import.meta.url), path.join(directory, name));
    }
    for (const name of ['auth.json', 'accounts.json', 'runtime-state.txt']) await writeFile(path.join(directory, 'scripts/ai-accounts', name), 'PRIVATE_FIXTURE_DO_NOT_PACKAGE');
    const archive = path.join(directory, 'source.zip');
    await exec('/usr/bin/python3', [path.join(directory, 'tools/package-share.py'), archive]);
    const { stdout } = await exec('/usr/bin/python3', ['-c', 'import zipfile,json,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive]);
    const entries: string[] = JSON.parse(stdout);
    for (const name of required) assert.ok(entries.includes('Delivery-Workspace/' + name), `缺少运行时依赖：${name}`);
    assert.ok(!entries.some(name => /\/(auth\.json|accounts\.json|runtime-state\.txt)$/.test(name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

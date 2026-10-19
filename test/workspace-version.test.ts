import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backendSourceHash, createWorkspaceBuild, createWorkspaceVersionReader, workspaceStaticCacheControl } from '../server/workspace-version.js';
import { isWorkspaceVersion, workspaceVersionState } from '../shared/workspace-version.js';

test('构建与运行后端分别标记；新构建及源码更新不会冒充进程已升级', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['server', 'shared', 'dist', '.data']) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const source = path.join(root, 'server', 'index.ts');
  await fs.writeFile(source, 'old source');
  const runtimeFiles = [
    'scripts/integration-execution-progress.ts', 'scripts/integration-cleared-issues.ts',
    'src/features/workbench/domain.ts', 'src/shared/task-schedule.ts', 'src/features/agent-workbench/conversation.ts',
    'src/features/api-integration/review-catalog.ts', 'src/features/api-integration/page-classification.ts',
    'src/features/api-integration/page-plan.ts', 'src/features/integration-execution/execution-plan.ts',
  ];
  const uiFiles = ['src/App.vue', 'src/app/themes.css', 'src/shared/theme/theme.ts'];
  for (const file of [...runtimeFiles, ...uiFiles]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'original');
  }
  const original = await createWorkspaceBuild(root);
  const read = await createWorkspaceVersionReader(root);
  assert.equal((await read()).frontend, null, '旧构建缺少元信息时仍可读取后端身份');
  const metadata = path.join(root, 'dist', 'workspace-version.json');
  await fs.writeFile(metadata, JSON.stringify(original));
  assert.equal(workspaceVersionState(original, await read()).status, 'current');
  await fs.writeFile(path.join(root, '.data', 'private.json'), 'private');
  assert.equal(await backendSourceHash(root), original.backendSourceHash, '业务数据不进入源码摘要');
  for (const file of uiFiles) await fs.writeFile(path.join(root, file), 'new presentation');
  const frontendOnly = await createWorkspaceBuild(root);
  assert.equal(frontendOnly.backendSourceHash, original.backendSourceHash, 'Vue、CSS 和仅前端使用的逻辑不要求重启后端');
  await fs.writeFile(metadata, JSON.stringify(frontendOnly));
  assert.equal(workspaceVersionState(original, await read()).status, 'refresh-required');
  let previousHash = original.backendSourceHash;
  for (const file of runtimeFiles) {
    await fs.writeFile(path.join(root, file), 'updated runtime logic');
    const upgraded = await createWorkspaceBuild(root);
    assert.notEqual(upgraded.backendSourceHash, previousHash, `${file} 的运行逻辑必须进入后端摘要`);
    await fs.writeFile(metadata, JSON.stringify(upgraded));
    assert.equal(workspaceVersionState(upgraded, await read()).status, 'restart-required', `${file} 更新后旧后端必须提示重启`);
    previousHash = upgraded.backendSourceHash;
  }
  await fs.writeFile(source, 'new source');
  const fullUpgrade = await createWorkspaceBuild(root);
  await fs.writeFile(metadata, JSON.stringify(fullUpgrade));
  const oldBackend = await read();
  assert.equal(oldBackend.backend.sourceHash, original.backendSourceHash);
  assert.equal(workspaceVersionState(fullUpgrade, oldBackend).status, 'restart-required');
  const restarted = await createWorkspaceVersionReader(root);
  assert.equal(workspaceVersionState(fullUpgrade, await restarted()).status, 'current');
  await fs.writeFile(metadata, '{broken');
  assert.equal(workspaceVersionState(fullUpgrade, await restarted()).status, 'unavailable');
  await fs.writeFile(metadata, JSON.stringify({ id: 'invalid' }));
  assert.equal((await restarted()).frontend, null);
});

test('版本协议不把缺失或伪造元数据当作一致；开发模式不提示生产升级', () => {
  assert.equal(isWorkspaceVersion({}), false);
  assert.equal(isWorkspaceVersion({ frontend: null, backend: { sourceHash: 'unknown', startedAt: '' } }), false);
  const build = { id: '12345678', builtAt: new Date().toISOString(), backendSourceHash: 'a'.repeat(64), development: false };
  const version = { frontend: build, backend: { sourceHash: 'a'.repeat(64), startedAt: build.builtAt } };
  assert.equal(isWorkspaceVersion(version), true);
  assert.equal(workspaceVersionState(build).status, 'unavailable');
  assert.equal(workspaceVersionState({ ...build, development: true }, version).status, 'development');
});

test('HTML 和版本信息不缓存，带内容 hash 的历史 JS/CSS 可保留供旧页面加载', () => {
  for (const file of ['index.html', 'agent', 'workspace-version.json', 'assets/unversioned.js', 'assets/index.css']) {
    assert.equal(workspaceStaticCacheControl(file), 'no-store');
  }
  for (const file of ['assets/index-C_123456.js', 'assets/Panel-AbcD1234.css']) {
    assert.equal(workspaceStaticCacheControl(file), 'public, max-age=31536000, immutable');
  }
});

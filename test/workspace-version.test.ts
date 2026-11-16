import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backendSourceHash, createWorkspaceBuild, createWorkspaceVersionReader, frontendBuildSourceHash, pruneStaleBuildAssets, workspaceStaticCacheControl } from '../server/workspace-version.js';
import { isWorkspaceVersion, workspaceVersionState } from '../shared/workspace-version.js';

test('构建与运行后端分别标记；新构建及源码更新不会冒充进程已升级', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['server', 'shared', 'dist', '.data']) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const source = path.join(root, 'server', 'index.ts');
  await fs.writeFile(source, 'old source');
  const original = await createWorkspaceBuild(root);
  const read = await createWorkspaceVersionReader(root);
  assert.equal((await read()).frontend, null, '旧构建缺少元信息时仍可读取后端身份');
  const metadata = path.join(root, 'dist', 'workspace-version.json');
  await fs.writeFile(metadata, JSON.stringify(original));
  assert.equal(workspaceVersionState(original, await read()).status, 'current');
  await fs.writeFile(path.join(root, '.data', 'private.json'), 'private');
  assert.equal(await backendSourceHash(root), original.backendSourceHash, '业务数据不进入源码摘要');
  const frontendOnly = await createWorkspaceBuild(root);
  await fs.writeFile(metadata, JSON.stringify(frontendOnly));
  assert.equal(workspaceVersionState(original, await read()).status, 'refresh-required');
  await fs.writeFile(source, 'new source');
  const fullUpgrade = await createWorkspaceBuild(root);
  await fs.writeFile(metadata, JSON.stringify(fullUpgrade));
  const oldBackend = await read();
  assert.equal(oldBackend.backend.sourceHash, original.backendSourceHash);
  assert.equal(workspaceVersionState(fullUpgrade, oldBackend).status, 'restart-required');
  const restarted = await createWorkspaceVersionReader(root);
  assert.equal(workspaceVersionState(fullUpgrade, await restarted()).status, 'current');
  await fs.writeFile(source, 'newer source');
  const staleBuild = await createWorkspaceVersionReader(root);
  const staleState = workspaceVersionState(fullUpgrade, await staleBuild());
  assert.equal(staleState.status, 'build-required', '后端已是最新源码时提示构建页面而非重启');
  assert.equal(staleState.restartRequired, false);
  await fs.writeFile(source, 'new source');
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
  const failed = { ...version, buildError: '自动构建失败' };
  assert.equal(isWorkspaceVersion(failed), true);
  assert.equal(workspaceVersionState(build, failed).status, 'build-failed');
  assert.equal(workspaceVersionState(build, failed).buildRequired, true);
  assert.equal(workspaceVersionState({ ...build, development: true }, failed).buildRequired, false);
});

test('HTML 和版本信息不缓存，带内容 hash 的历史 JS/CSS 可保留供旧页面加载', () => {
  for (const file of ['index.html', 'agent', 'workspace-version.json', 'assets/unversioned.js', 'assets/index.css']) {
    assert.equal(workspaceStaticCacheControl(file), 'no-store');
  }
  for (const file of ['assets/index-C_123456.js', 'assets/Panel-AbcD1234.css']) {
    assert.equal(workspaceStaticCacheControl(file), 'public, max-age=31536000, immutable');
  }
});

test('插件声明、服务代码和页面均参与版本核对', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-version-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const directory of ['server','shared','plugins/example']) await fs.mkdir(path.join(root,directory),{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),'{}');
  const before = await createWorkspaceBuild(root);
  await fs.writeFile(path.join(root,'plugins/example/integration.json'),'{}');
  const manifest = await createWorkspaceBuild(root);
  assert.notEqual(manifest.backendSourceHash,before.backendSourceHash);
  await fs.writeFile(path.join(root,'plugins/example/Page.vue'),'<template>插件</template>');
  const page = await createWorkspaceBuild(root);
  assert.notEqual(page.buildSourceHash,manifest.buildSourceHash);
  await fs.writeFile(path.join(root,'plugins/example/server.ts'),'export const version=1;');
  assert.notEqual(await backendSourceHash(root),manifest.backendSourceHash);
  const frontendBeforeServerEdit = await frontendBuildSourceHash(root);
  await fs.writeFile(path.join(root,'server/only-backend.ts'),'export const fastRestart = true;');
  assert.equal(await frontendBuildSourceHash(root), frontendBeforeServerEdit, '纯后端文件改动不影响前端构建输入摘要');
  await fs.writeFile(path.join(root,'plugins/example/Page.vue'),'<template>插件 v2</template>');
  assert.notEqual(await frontendBuildSourceHash(root), frontendBeforeServerEdit, '前端或插件视图改动会更新前端构建输入摘要');
});

test('pruneStaleBuildAssets 保留当前构建与最近上一代资源，清理更早历史分片且不动非 assets 文件', async t => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-assets-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const assetsDir = path.join(outDir, 'assets');
  const themesDir = path.join(outDir, 'themes');
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(themesDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(themesDir, 'bg.jpg'), 'theme-image');

  const now = Date.now();
  const writeWithMtime = async (name: string, content: string, mtimeMs: number) => {
    const target = path.join(assetsDir, name);
    await fs.writeFile(target, content);
    const time = new Date(mtimeMs);
    await fs.utimes(target, time, time);
  };

  // 第 3 代及更早（应被清理）
  await writeWithMtime('editor.api-OLD00001.js', 'x'.repeat(1024), now - 3_600_000);
  await writeWithMtime('agent-OLD00002.js', 'y'.repeat(512), now - 1_800_000);
  // 最近上一代（同批 60 秒内写出，应整体保留供旧页面加载懒加载模块）
  await writeWithMtime('editor.api-PREV0001.js', 'p'.repeat(1024), now - 600_000);
  await writeWithMtime('DeliverySettings-PREV0002.js', 'q'.repeat(256), now - 550_000);
  // 当前代（即使复用了更早的未变文件，只要在 currentFiles 中就必须保留）
  await writeWithMtime('vendor-vue-SHARED01.js', 'v'.repeat(512), now - 7_200_000);
  await writeWithMtime('agent-CURR0001.js', 'c'.repeat(512), now);
  await writeWithMtime('ts.worker-CURR0002.js', 'w'.repeat(512), now);

  const result = await pruneStaleBuildAssets(
    outDir,
    ['assets/vendor-vue-SHARED01.js', 'assets/agent-CURR0001.js', 'index.html'],
    { buildStartedAtMs: now - 1_000, generationWindowMs: 180_000 },
  );

  assert.equal(result.removedCount, 2);
  assert.equal(result.removedBytes, 1536);
  assert.equal(result.keptCount, 5);

  const remaining = (await fs.readdir(assetsDir)).sort();
  assert.deepEqual(remaining, [
    'DeliverySettings-PREV0002.js',
    'agent-CURR0001.js',
    'editor.api-PREV0001.js',
    'ts.worker-CURR0002.js',
    'vendor-vue-SHARED01.js',
  ]);
  assert.equal(await fs.readFile(path.join(outDir, 'index.html'), 'utf8'), '<html></html>');
  assert.equal(await fs.readFile(path.join(themesDir, 'bg.jpg'), 'utf8'), 'theme-image');
});

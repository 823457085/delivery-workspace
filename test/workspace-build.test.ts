import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspaceBuild } from '../server/workspace-build.js';
import { createWorkspaceBuild, createWorkspaceVersionReader } from '../server/workspace-version.js';
import { workspaceVersionState } from '../shared/workspace-version.js';

async function fixture(t: TestContext, hashedAssets = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-auto-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['server', 'shared', 'src']) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'server/index.ts'), 'server');
  await fs.writeFile(path.join(root, 'src/App.vue'), 'original');
  const dist = path.join(root, 'custom-dist');
  let builds = 0;
  const build = async (_root: string, output: string) => {
    builds++;
    const version = await createWorkspaceBuild(root);
    const asset = `assets/app-${builds}${hashedAssets ? '-0123456789' : ''}.js`;
    await fs.mkdir(path.join(output, 'assets'), { recursive: true });
    await fs.writeFile(path.join(output, asset), `build:${builds}`);
    await fs.writeFile(path.join(output, 'index.html'), `<script src="/${asset}"></script>`);
    await fs.writeFile(path.join(output, 'workspace-version.json'), JSON.stringify(version));
    return { stdout: 'build passed', stderr: '' };
  };
  return { root, dist, build, builds: () => builds };
}

test('首次启动自动构建；完整且版本一致时复用；前端更新会重建并保留旧资源', async t => {
  const f = await fixture(t);
  const original = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  assert.equal(original.rebuilt, true);
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, false);
  assert.equal(f.builds(), 1);
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'changed frontend');
  const version = await (await createWorkspaceVersionReader(f.root, f.dist))();
  assert.equal(workspaceVersionState(original.build, version).buildRequired, true);
  const next = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  assert.equal(next.rebuilt, true);
  assert.equal(next.build.backendSourceHash, original.build.backendSourceHash);
  assert.notEqual(next.build.buildSourceHash, original.build.buildSourceHash);
  assert.equal(await fs.readFile(path.join(f.dist, 'assets/app-1.js'), 'utf8'), 'build:1');
  assert.equal(await fs.readFile(path.join(f.dist, 'assets/app-2.js'), 'utf8'), 'build:2');
  assert.match(await fs.readFile(path.join(f.dist, 'index.html'), 'utf8'), /app-2/);
});

test('构建失败不替换旧入口及版本，保存诊断并可在下次启动重试', async t => {
  const f = await fixture(t);
  const original = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.writeFile(path.join(f.root, 'server/index.ts'), 'changed backend');
  await assert.rejects(ensureWorkspaceBuild(f.root, f.dist, { build: async (_root, output) => {
    await fs.writeFile(path.join(output, 'index.html'), 'broken candidate');
    throw Object.assign(new Error('typecheck failed'), { stderr: 'fixture compilation error' });
  } }), /页面自动构建失败/);
  assert.match(await fs.readFile(path.join(f.dist, 'index.html'), 'utf8'), /app-1/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dist, 'workspace-version.json'), 'utf8')).id, original.build.id);
  assert.match(await fs.readFile(path.join(f.root, '.data/workspace-build.log'), 'utf8'), /fixture compilation error/);
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, true);
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.delivery-build-')), false);
});

test('预构建不发布页面，后续启动复用同一候选，保留旧入口资源', async t => {
  const f = await fixture(t);
  const original = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.writeFile(path.join(f.root, 'server/index.ts'), 'new backend');
  const next = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, prepareOnly: true });
  assert.notEqual(next.build.backendSourceHash, original.build.backendSourceHash);
  assert.match(await fs.readFile(path.join(f.dist, 'index.html'), 'utf8'), /app-1/);
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, prepareOnly: true })).build.id, next.build.id);
  await assert.rejects(ensureWorkspaceBuild(f.root, f.dist, {
    build: f.build, backendSourceHash: original.build.backendSourceHash,
  }), /页面自动构建失败/);
  assert.match(await fs.readFile(path.join(f.dist, 'index.html'), 'utf8'), /app-1/);
  const prepared = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, prepareOnly: true });
  const buildCount = f.builds();
  const activated = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  assert.equal(f.builds(), buildCount, '后端启动时跳过重复构建');
  assert.equal(activated.build.id, prepared.build.id);
  assert.equal(await fs.readFile(path.join(f.dist, 'assets/app-1.js'), 'utf8'), 'build:1');
});

test('预构建后源码变化时重新构建，纯页面更新可核对运行后端后发布', async t => {
  const f = await fixture(t);
  const original = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'first edit');
  const stale = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, prepareOnly: true });
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'latest edit');
  const current = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, backendSourceHash: original.build.backendSourceHash });
  assert.notEqual(current.build.id, stale.build.id);
  assert.equal(f.builds(), 3);
  assert.match(await fs.readFile(path.join(f.dist, 'index.html'), 'utf8'), /app-3/);
});

test('发布带 hash 的新资源时沿用历史资源目录，保留旧页面和报告依赖', async t => {
  const f = await fixture(t, true);
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  const assets = path.join(f.dist, 'assets');
  const originalAssets = await fs.stat(assets);
  await fs.writeFile(path.join(f.dist, 'existing-report.html'), 'report');
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'new frontend');
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build, prepareOnly: true });
  assert.equal(await fs.readFile(path.join(assets, 'app-2-0123456789.js'), 'utf8').catch(() => null), null);
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  assert.equal((await fs.stat(assets)).ino, originalAssets.ino);
  assert.equal(await fs.readFile(path.join(assets, 'app-1-0123456789.js'), 'utf8'), 'build:1');
  assert.equal(await fs.readFile(path.join(assets, 'app-2-0123456789.js'), 'utf8'), 'build:2');
  assert.equal(await fs.readFile(path.join(f.dist, 'existing-report.html'), 'utf8'), 'report');
});

test('同名历史资源内容不符时回到完整合并，使用已校验候选的资源', async t => {
  const f = await fixture(t, true);
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'next frontend');
  const asset = path.join(f.dist, 'assets/app-2-0123456789.js');
  await fs.writeFile(asset, 'broken asset');
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  assert.equal(await fs.readFile(asset, 'utf8'), 'build:2');
});

test('构建过程中源码变化时拒绝候选，避免把旧产物标成最新', async t => {
  const f = await fixture(t);
  const original = await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.writeFile(path.join(f.root, 'src/App.vue'), 'first edit');
  await assert.rejects(ensureWorkspaceBuild(f.root, f.dist, { build: async (root, output) => {
    const result = await f.build(root, output);
    await fs.writeFile(path.join(root, 'src/App.vue'), 'second edit');
    return result;
  } }), /页面自动构建失败/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dist, 'workspace-version.json'), 'utf8')).id, original.build.id);
});

test('元数据相同但入口依赖缺失仍自动修复，数据和报告变化不重建应用', async t => {
  const f = await fixture(t);
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  await fs.mkdir(path.join(f.root, '.data'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'public/integration-runs'), { recursive: true });
  await fs.writeFile(path.join(f.root, '.data/state.json'), 'private state');
  await fs.writeFile(path.join(f.root, 'public/integration-runs/report.html'), 'report');
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, false);
  await fs.rm(path.join(f.dist, 'assets/app-1.js'));
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, true);
  await fs.writeFile(path.join(f.root, 'public/logo.svg'), '<svg/>');
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, true);
  await fs.writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'changed dependency lock');
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, true);
});

test('缺少新版本标记或不完整候选不会被当成可用构建', async t => {
  const f = await fixture(t);
  await ensureWorkspaceBuild(f.root, f.dist, { build: f.build });
  const file = path.join(f.dist, 'workspace-version.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.buildSourceHash;
  await fs.writeFile(file, JSON.stringify(legacy));
  await assert.rejects(ensureWorkspaceBuild(f.root, f.dist, { build: async (_root, output) => {
    await fs.writeFile(path.join(output, 'workspace-version.json'), JSON.stringify(await createWorkspaceBuild(f.root)));
    return { stdout: '', stderr: '' };
  } }), /页面自动构建失败/);
  assert.equal((await ensureWorkspaceBuild(f.root, f.dist, { build: f.build })).rebuilt, true);
});

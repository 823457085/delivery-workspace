import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createLocalRetests, planLocalRetest, refactorBranches } from '../server/refactor-local-retest.js';

const exec = promisify(execFile);
async function fixture(t: TestContext, listening = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-retest-')));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const git = async (...args: string[]) => (await exec('git', ['-C', source, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Retest fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'retest-fixture', type: 'module', scripts: { dev: 'node server.mjs' } }));
  await fs.writeFile(path.join(source, 'server.mjs'), listening
    ? "import http from 'node:http'; import fs from 'node:fs'; http.createServer((req,res)=>res.end(fs.readFileSync('marker.txt'))).listen(Number(process.env.PORT),process.env.HOST);"
    : 'setInterval(()=>{},1000);');
  await fs.writeFile(path.join(source, 'marker.txt'), 'main');
  await git('add', '.'); await git('commit', '-m', '测试初始版本');
  await git('switch', '-c', 'feature/selected');
  await fs.writeFile(path.join(source, 'marker.txt'), 'selected-branch');
  await git('add', '.'); await git('commit', '-m', '测试目标分支');
  const selectedHead = await git('rev-parse', 'HEAD');
  await git('switch', 'main');
  await fs.writeFile(path.join(source, 'marker.txt'), 'uncommitted-original');
  const state = await git('status', '--porcelain');
  const service = createLocalRetests(root, path.join(root, 'runs'), { timeoutMs: 5000, pollMs: 50 });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, source, git, selectedHead, state, service };
}

test('分支预览只读；按固定提交运行真实服务，不带入来源脏改动，也不切换来源分支', async t => {
  const f = await fixture(t);
  const choices = await refactorBranches(f.source);
  assert.equal(choices.current, 'refs/heads/main');
  assert.equal(choices.branches.find(branch => branch.name === 'feature/selected')?.head, f.selectedHead);
  const plan = await planLocalRetest(f.source, 'refs/heads/feature/selected');
  assert.equal(plan.packageManager, 'npm'); assert.equal(plan.startScript, 'dev');
  assert.equal(await fs.access(path.join(f.root, 'runs')).then(() => true, () => false), false);
  await assert.rejects(planLocalRetest(f.source, 'HEAD~1'), /所选分支不存在/);
  // A queued job keeps the confirmed commit even if the ref subsequently moves.
  await f.git('update-ref', 'refs/heads/feature/selected', await f.git('rev-parse', 'main'));
  const id = randomUUID(), runtime = await f.service.prepare(id, plan);
  assert.equal(await (await fetch(runtime.baseUrl)).text(), 'selected-branch');
  assert.equal((await exec('git', ['-C', runtime.workspacePath, 'rev-parse', 'HEAD'])).stdout.trim(), f.selectedHead);
  assert.equal(await f.git('branch', '--show-current'), 'main');
  assert.equal(await f.git('status', '--porcelain'), f.state);
  assert.equal(await fs.readFile(path.join(f.source, 'marker.txt'), 'utf8'), 'uncommitted-original');
  await f.service.verify(runtime);
  await fs.writeFile(path.join(runtime.workspacePath, 'marker.txt'), 'changed-candidate');
  await assert.rejects(f.service.verify(runtime), /代码与选定 Commit 不一致/);
  await f.service.stop(id);
  assert.equal(runtime.state, 'stopped');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'runs', id, 'runtime.json'), 'utf8')).state, 'stopped');
  for (let i = 0; i < 30; i++) {
    if (!await fetch(runtime.baseUrl).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('任务停止后本次服务仍在监听');
});

test('来源未提交的启动脚本不会替代分支脚本，缺少启动脚本时不创建工作区', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify({ scripts: { dev: 'uncommitted-command' } }));
  const plan = await planLocalRetest(f.source, 'refs/heads/main', { startScript: 'not-in-this-branch' });
  assert.equal(plan.script, 'node server.mjs');
  assert.equal(plan.startScript, 'dev');
  assert.equal(await fs.access(path.join(f.root, 'runs')).then(() => true, () => false), false);
});

test('准备阶段可停止，未监听独立端口的脚本不会被当作启动成功', async t => {
  const f = await fixture(t, false), id = randomUUID();
  const plan = await planLocalRetest(f.source, 'refs/heads/main');
  const pending = f.service.prepare(id, plan);
  const rejected = assert.rejects(pending, /停止|abort/i);
  for (let i = 0; i < 100 && !f.service.phase(id)?.includes('启动'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  f.service.cancel(id); await rejected;
  assert.equal(await f.git('status', '--porcelain'), f.state);
  await assert.rejects(f.service.prepare(id, plan), /已停止/);
});

test('重建管理器后按记录回查端口归属，只停止原任务工作区的进程组', async t => {
  const f = await fixture(t), id = randomUUID();
  const runtime = await f.service.prepare(id, await planLocalRetest(f.source, 'refs/heads/main'));
  const recovered = createLocalRetests(f.root, path.join(f.root, 'runs'));
  await recovered.stop(id); await recovered.close();
  for (let i = 0; i < 30; i++) {
    if (!await fetch(runtime.baseUrl).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('重建后仍未停止已确认归属的本次服务');
});

for (const ownWorkspace of [false, true]) test(`生产工作台内的${ownWorkspace ? '自带 workspace 项目' : '独立项目'}安装自己的开发依赖，不修改宿主依赖`, async t => {
  const f = await fixture(t), host = path.join(f.root, 'host');
  await fs.mkdir(host);
  await fs.writeFile(path.join(host, 'package.json'), JSON.stringify({ name: 'host-fixture', private: true }));
  await fs.writeFile(path.join(host, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  const hostLock = 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n';
  await fs.writeFile(path.join(host, 'pnpm-lock.yaml'), hostLock);
  await fs.mkdir(path.join(f.source, 'helper'));
  await fs.writeFile(path.join(f.source, 'helper/package.json'), JSON.stringify({ name: 'local-retest-helper', version: '1.0.0', type: 'module', main: 'index.js' }));
  await fs.writeFile(path.join(f.source, 'helper/index.js'), "export default 'own-dev-dependency';");
  if (ownWorkspace) await fs.writeFile(path.join(f.source, 'pnpm-workspace.yaml'), 'packages:\n  - .\n  - helper\n');
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify({ name: 'nested-retest-fixture', type: 'module',
    scripts: { dev: 'node server.mjs' }, devDependencies: { 'local-retest-helper': ownWorkspace ? 'workspace:*' : 'file:./helper' } }));
  await fs.writeFile(path.join(f.source, 'server.mjs'), "import http from 'node:http'; import marker from 'local-retest-helper'; http.createServer((req,res)=>res.end(marker + ':' + process.env.NODE_ENV)).listen(Number(process.env.PORT),process.env.HOST);");
  await f.git('add', '.'); await f.git('commit', '-m', '测试嵌套工作区的开发依赖');
  const service = createLocalRetests(host, path.join(host, '.local/runs'), { timeoutMs: 5000, pollMs: 50 });
  const previous = process.env.NODE_ENV, id = randomUUID();
  process.env.NODE_ENV = 'production';
  try {
    const runtime = await service.prepare(id, await planLocalRetest(f.source, 'refs/heads/main', { packageManager: 'pnpm' }));
    assert.equal(await (await fetch(runtime.baseUrl)).text(), 'own-dev-dependency:development');
    assert.equal(await fs.readFile(path.join(host, 'pnpm-lock.yaml'), 'utf8'), hostLock);
    assert.equal(await fs.access(path.join(runtime.workspacePath, 'node_modules/local-retest-helper')).then(() => true, () => false), true);
  } catch (error) {
    t.diagnostic(await fs.readFile(path.join(host, '.local/runs', id, 'startup.log'), 'utf8')); throw error;
  } finally {
    previous === undefined ? delete process.env.NODE_ENV : process.env.NODE_ENV = previous;
    await service.close();
  }
});

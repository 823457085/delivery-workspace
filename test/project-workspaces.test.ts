import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectsData } from '../shared/hub.js';
import { createProjectWorkspaces, type ProjectWorkspaceOptions } from '../server/project-workspaces.js';
import { createProjectWorkspaceRoutes } from '../server/project-workspace-routes.js';
import { withProjectGitLock } from '../server/project-git.js';

const exec = promisify(execFile);
const git = async (folder: string, ...args: string[]) => (await exec('git', ['-C', folder, ...args],
  { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
const exists = (folder: string) => fs.stat(folder).then(() => true, () => false);
async function until(check: () => boolean, timeout = 10_000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('等待后台清理超时'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-test-')));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git'), state = path.join(root, 'state');
  await fs.mkdir(repo); await git(root, 'init', '--bare', remote); await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'file.txt'), 'saved\n'); await git(repo, 'add', 'file.txt'); await git(repo, 'commit', '-m', 'fixture');
  await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const known = new Set([repo]), busy = new Set<string>();
  let current = Date.now(), running = true, scans = 0;
  const options: ProjectWorkspaceOptions = {
    readProjects: async () => { scans++; return { projects: [...known].filter(folder => true).map(folder => ({ path: folder })) } as ProjectsData; },
    withWorkspace: async (_folder, _owner, action) => action(),
    checkBusy: async folder => { if (busy.has(folder)) throw new Error('工作区正在使用'); },
    canRun: () => running, protectedPaths: [state], now: () => current, intervalMs: 20,
  };
  const service = await createProjectWorkspaces(state, options);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = async (folder = repo) => ({ path: folder, revision: (await service.preview(folder)).revision, confirmName: path.basename(folder) });
  return { root, repo, remote, state, service, known, busy, options, input,
    advance: (amount: number) => { current += amount; }, future: () => new Date(current + 1000).toISOString(),
    pause: () => { running = false; }, resume: () => { running = true; }, scans: () => scans,
    linked: async () => { const folder = path.join(root, 'linked'); await git(repo, 'worktree', 'add', '-b', 'feature/temporary', folder, 'origin/main'); known.add(folder); return folder; },
  };
}

test('手动删除独立克隆；严格确认目录名和最新预览，不删除父目录/别名/未扫描目录', async t => {
  const f = await fixture(t), p = await f.input();
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.repo, alias);
  for (const folder of [alias, f.root, path.join(f.repo, '.git')]) {
    assert.equal((await f.service.preview(folder)).canSchedule, false);
    await assert.rejects(f.service.remove({ ...p, path: folder, confirmName: path.basename(folder) }));
  }
  await assert.rejects(f.service.remove({ ...p, confirmName: 'wrong' }), /文件夹名称/);
  await assert.rejects(f.service.remove({ ...p, revision: 'stale' }), /状态已变化/);
  f.known.delete(f.repo); await assert.rejects(f.service.remove(p), /工作区列表/); f.known.add(f.repo);
  assert.equal((await f.service.preview(f.repo)).eligible, true);
  assert.deepEqual(await f.service.remove(p), { path: f.repo, deleted: true });
  assert.equal(await exists(f.repo), false); assert.equal(await exists(f.remote), true);
});

test('删除 linked worktree 保留主仓库和分支；主仓库被依赖时不能删除或预约', async t => {
  const f = await fixture(t), linked = await f.linked();
  const main = await f.service.preview(f.repo);
  assert.equal(main.canSchedule, false); assert.match(main.reason || '', /依赖/);
  await assert.rejects(f.service.schedule({ ...await f.input(), deleteAt: f.future() }), /依赖/);
  const head = await git(f.repo, 'rev-parse', 'HEAD');
  await f.service.remove(await f.input(linked));
  assert.equal(await exists(linked), false);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.repo, 'rev-parse', 'feature/temporary'), head);
  assert.ok(!(await git(f.repo, 'worktree', 'list', '--porcelain')).includes(linked));
});

test('手动确认可丢弃独立克隆和 linked worktree 的改动，并保留远端与共享分支', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t), folder = linked ? await f.linked() : f.repo;
    const tracked = path.join(folder, 'file.txt'), untracked = path.join(folder, 'new.txt');
    const head = await git(f.repo, 'rev-parse', 'HEAD');
    await fs.writeFile(tracked, 'staged\n'); await git(folder, 'add', 'file.txt');
    await fs.writeFile(tracked, 'unstaged\n'); await fs.writeFile(untracked, 'new\n');
    const preview = await f.service.preview(folder);
    assert.equal(preview.eligible, false);
    assert.equal(preview.requiresDiscardChanges, true);
    const input = { path: folder, revision: preview.revision, confirmName: path.basename(folder) };
    await assert.rejects(f.service.remove(input), /未提交/);

    await fs.writeFile(untracked, 'newer\n');
    await assert.rejects(f.service.remove({ ...input, discardChanges: true }), /状态已变化/);
    assert.equal(await fs.readFile(untracked, 'utf8'), 'newer\n');
    await f.service.remove({ ...await f.input(folder), discardChanges: true });
    assert.equal(await exists(folder), false);
    assert.equal(await git(f.remote, 'rev-parse', 'HEAD'), head);
    if (linked) {
      assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);
      assert.equal(await git(f.repo, 'rev-parse', 'feature/temporary'), head);
      assert.ok(!(await git(f.repo, 'worktree', 'list', '--porcelain')).includes(folder));
    }
  }
});

test('确认丢弃改动后仍检查工作区占用、Git 锁和删除前新增的改动', async t => {
  const f = await fixture(t), linked = await f.linked(), file = path.join(linked, 'file.txt');
  await fs.writeFile(file, 'dirty\n');
  const input = { ...await f.input(linked), discardChanges: true };
  f.busy.add(linked);
  assert.equal((await f.service.preview(linked)).requiresDiscardChanges, undefined);
  await assert.rejects(f.service.remove(input), /正在使用/);
  f.busy.delete(linked);
  const gitDir = await git(linked, 'rev-parse', '--absolute-git-dir');
  const indexLock = path.join(gitDir, 'index.lock');
  await fs.writeFile(indexLock, 'locked');
  assert.equal((await f.service.preview(linked)).requiresDiscardChanges, undefined);
  await assert.rejects(f.service.remove(input), /Git 操作/);
  await fs.unlink(indexLock);
  await git(f.repo, 'worktree', 'lock', linked);
  assert.equal((await f.service.preview(linked)).requiresDiscardChanges, undefined);
  await assert.rejects(f.service.remove(input), /Git 操作|锁定/);
  await git(f.repo, 'worktree', 'unlock', linked);

  let checks = 0;
  f.options.checkBusy = async () => {
    if (++checks === 2) await fs.writeFile(file, 'edited after preview\n');
  };
  await assert.rejects(f.service.remove(input), /状态已变化/);
  assert.equal(await fs.readFile(file, 'utf8'), 'edited after preview\n');
  assert.ok((await git(f.repo, 'worktree', 'list', '--porcelain')).includes(linked));
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.delivery-delete-')), false);
});

test('手动确认可丢弃已暂停的冲突合并，但仍检查合并目标和自动删除', async t => {
  const f = await fixture(t), file = path.join(f.repo, 'file.txt');
  await git(f.repo, 'switch', '-c', 'feature/incoming');
  await fs.writeFile(file, 'incoming\n'); await git(f.repo, 'commit', '-am', 'incoming');
  const mergeHead = await git(f.repo, 'rev-parse', 'HEAD');
  await git(f.repo, 'switch', 'main');
  await fs.writeFile(file, 'current\n'); await git(f.repo, 'commit', '-am', 'current');
  await git(f.repo, 'push', 'origin', 'main');
  await assert.rejects(git(f.repo, 'merge', '--no-edit', mergeHead), /git/);
  await git(f.repo, 'branch', '-D', 'feature/incoming');
  assert.equal(await git(f.repo, 'rev-parse', 'MERGE_HEAD'), mergeHead);
  const unsafe = await f.service.preview(f.repo);
  assert.equal(unsafe.requiresDiscardChanges, undefined);
  await assert.rejects(f.service.remove({ ...await f.input(), discardChanges: true }), /未推送/);

  await git(f.repo, 'push', 'origin', `${mergeHead}:refs/heads/feature/incoming`);
  const preview = await f.service.preview(f.repo);
  assert.equal(preview.eligible, false);
  assert.equal(preview.requiresDiscardChanges, true);
  await assert.rejects(f.service.remove(await f.input()), /未提交|合并/);
  await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  f.advance(2000); f.service.start();
  await until(() => f.service.list()[0]?.status === 'blocked');
  assert.equal(await git(f.repo, 'rev-parse', 'MERGE_HEAD'), mergeHead);

  await f.service.remove({ ...await f.input(), discardChanges: true });
  assert.equal(await exists(f.repo), false);
  assert.equal(await git(f.remote, 'rev-parse', 'feature/incoming'), mergeHead);
});

test('dirty、未推送、stash、运行占用不能立即删除，但可预约；到期阻塞后恢复会重试', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'dirty\n');
  let preview = await f.service.preview(f.repo);
  assert.equal(preview.eligible, false); assert.equal(preview.canSchedule, true);
  await assert.rejects(f.service.remove(await f.input()), /未提交/);
  const scheduled = await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  assert.equal(scheduled.rule?.status, 'scheduled');
  f.advance(2000); f.service.start();
  await until(() => f.service.list()[0]?.status === 'blocked');
  assert.equal(await exists(f.repo), true);
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'saved\n');
  f.busy.add(f.repo);
  await until(() => /正在使用/.test(f.service.list()[0]?.message || ''));
  assert.equal(await exists(f.repo), true);
  f.busy.delete(f.repo);
  await until(() => f.service.list()[0]?.status === 'deleted');
  assert.equal(await exists(f.repo), false);
});

test('本地分支独有提交、stash 和 Git 锁保留原目录', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-c', 'feature/local-only');
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'local-only\n'); await git(f.repo, 'commit', '-am', 'local-only');
  await git(f.repo, 'switch', 'main');
  assert.match((await f.service.preview(f.repo)).reason || '', /未推送/);
  await assert.rejects(f.service.remove(await f.input()), /未推送/);
  await git(f.repo, 'branch', '-D', 'feature/local-only');
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'stash\n'); await git(f.repo, 'stash', 'push');
  assert.match((await f.service.preview(f.repo)).reason || '', /stash/);
  await git(f.repo, 'stash', 'drop');
  const input = await f.input();
  await withProjectGitLock(f.repo, () => assert.rejects(f.service.remove(input), /Git 操作正在执行/));
  await fs.writeFile(path.join(f.repo, '.git', 'index.lock'), 'locked');
  assert.equal((await f.service.preview(f.repo)).eligible, false);
  assert.equal(await exists(f.repo), true);
});

test('排程绑定 inode/仓库身份，原路径被另一份干净仓库替换时不删除', async t => {
  const f = await fixture(t);
  await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  await fs.rename(f.repo, path.join(f.root, 'original'));
  await git(f.root, 'clone', f.remote, f.repo);
  f.advance(2000); f.service.start();
  await until(() => f.service.list()[0]?.status === 'blocked');
  assert.match(f.service.list()[0].message || '', /替换/);
  assert.equal(await exists(f.repo), true); assert.equal(await exists(path.join(f.root, 'original')), true);
});

test('排程重载及停机补执行；取消缺失工作区排程不依赖目录可访问性', async t => {
  const f = await fixture(t);
  await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  const reloaded = await createProjectWorkspaces(f.state, f.options); t.after(() => reloaded.close());
  f.advance(2000); f.pause(); reloaded.start();
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(await exists(f.repo), true);
  f.resume(); await until(() => reloaded.list()[0]?.status === 'deleted');
  const missing = await f.service.preview(f.repo);
  assert.equal(missing.eligible, false); assert.equal(missing.rule?.status, 'scheduled');
  await f.service.schedule({ path: f.repo, revision: '', deleteAt: null });
  assert.equal(f.service.list().length, 0);
});

test('没有排程不扫描；排程未start不会执行；并发删除只执行一次', async t => {
  const f = await fixture(t); f.service.start();
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.scans(), 0);
  const input = await f.input();
  const outcomes = await Promise.allSettled([f.service.remove(input), f.service.remove(input)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(await exists(f.repo), false);
});

test('保护目录和被替换成符号链接的配置 fail closed；不因此删除任何工作区', async t => {
  const f = await fixture(t);
  const protectedService = await createProjectWorkspaces(path.join(f.root, 'protected-state'), { ...f.options, protectedPaths: [f.repo] });
  t.after(() => protectedService.close());
  assert.equal((await protectedService.preview(f.repo)).canSchedule, false);
  await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  const config = path.join(f.state, 'workspace-cleanup.json'), outside = path.join(f.root, 'outside.json');
  await fs.writeFile(outside, 'untouched'); await fs.rename(config, config + '.saved'); await fs.symlink(outside, config);
  f.advance(2000); f.service.start(); await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await exists(f.repo), true); assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});

test('到期批次逐条执行：第一个删除等待期间可取消下一条，下一条不会被删除', async t => {
  const f = await fixture(t), second = path.join(f.root, 'second');
  await git(f.root, 'clone', f.remote, second); f.known.add(second);
  await f.service.schedule({ ...await f.input(), deleteAt: f.future() });
  await f.service.schedule({ ...await f.input(second), deleteAt: f.future() });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  f.options.checkBusy = async folder => { if (folder === f.repo && ++checks === 2) { enter(); await released; } };
  f.advance(2000); f.service.start(); await entered;
  const cancelled = f.service.schedule({ path: second, revision: '', deleteAt: null });
  release(); await cancelled;
  await until(() => f.service.isIdle());
  assert.equal(await exists(f.repo), false); assert.equal(await exists(second), true);
  assert.equal(f.service.list().some(rule => rule.path === second), false);
});

test('隔离前最后检查期间新建未推送分支或stash，删除回滚并保留内容', async t => {
  for (const change of ['branch', 'stash']) {
    const f = await fixture(t), input = await f.input();
    const tree = await git(f.repo, 'rev-parse', 'HEAD^{tree}');
    const commit = await git(f.repo, 'commit-tree', tree, '-p', 'HEAD', '-m', 'late unique commit');
    let injected = false;
    f.options.checkBusy = async () => {
      if (injected) return;
      injected = true;
      if (change === 'branch') await git(f.repo, 'update-ref', 'refs/heads/feature/late', commit);
      else { await fs.writeFile(path.join(f.repo, 'file.txt'), 'late stash content\n'); await git(f.repo, 'stash', 'push'); }
    };
    await assert.rejects(f.service.remove(input), /分支、提交或 stash 已变化/);
    assert.equal(await exists(f.repo), true);
    assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.delivery-delete-')), false);
    if (change === 'branch') assert.equal(await git(f.repo, 'rev-parse', 'refs/heads/feature/late'), commit);
    else assert.ok((await git(f.repo, 'stash', 'list')).length > 0);
  }
});

test('保护树仅放开显式工作区容器的Git后代；主目录、容器和其它目录仍拒绝', async t => {
  const f = await fixture(t), app = path.join(f.root, 'app'), container = path.join(app, 'workspaces'), child = path.join(container, 'child');
  await fs.mkdir(container, { recursive: true }); await git(f.root, 'clone', f.remote, child); f.known.add(child);
  const service = await createProjectWorkspaces(path.join(app, 'state'), { ...f.options,
    protectedPaths: [app], workspaceRoots: [container] });
  t.after(() => service.close());
  for (const folder of [app, container, path.join(app, 'state')]) assert.equal((await service.preview(folder)).canSchedule, false);
  const preview = await service.preview(child); assert.equal(preview.eligible, true); assert.equal(preview.canSchedule, true);
  await service.schedule({ path: child, revision: preview.revision, confirmName: 'child', deleteAt: f.future() });
  await service.remove({ path: child, revision: preview.revision, confirmName: 'child' });
  assert.equal(await exists(child), false); assert.equal(await exists(container), true); assert.equal(await exists(app), true);
});

test('清理接口拒绝跨站、缺确认、错误类型及越权入口；合法预览不产生删除', async t => {
  const f = await fixture(t);
  let port = 0;
  const server = http.createServer(async (request, response) => {
    const route = createProjectWorkspaceRoutes(f.service, { port,
      json: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); },
      body: async req => { let content = ''; for await (const chunk of req) content += chunk; return JSON.parse(content); } });
    await route(request, response, new URL(request.url || '/', `http://127.0.0.1:${port}`));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${port}`, base = origin + '/api/projects/workspaces';
  const get = await fetch(base + '?path=' + encodeURIComponent(f.repo)); assert.equal(get.status, 200);
  assert.equal((await get.json()).eligible, true);
  const input = JSON.stringify(await f.input());
  assert.equal((await fetch(base + '/delete', { method: 'POST', body: input })).status, 403);
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers: { Origin: 'https://outside.invalid', 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: input })).status, 403);
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain', 'X-Delivery-Confirmed': 'yes' }, body: input })).status, 415);
  assert.equal((await fetch(base + '/schedule', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify({ ...await f.input(), deleteAt: f.future(), discardChanges: true }) })).status, 400);
  assert.equal(await exists(f.repo), true);
});

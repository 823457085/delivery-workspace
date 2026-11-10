import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeProjectGitAction, readProjectGitSnapshot, readProjectDiff, updateShareConfig } from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await exec('git', ['-C', directory, ...args])).stdout.trim();
async function fixture(t: TestContext, unborn = false) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-git-regression-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Git Regression');
  await git(repo, 'config', 'user.email', 'fixture@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  const write = (file: string, content: string) => fs.writeFile(path.join(repo, file), content);
  if (!unborn) {
    await write('value.txt', 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', '初始化验证仓库');
  }
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;
  const act = async (action: string, extra: Record<string, unknown> = {}, directory = repo) => executeProjectGitAction({
    path: directory, action, revision: (await readProjectGitSnapshot(directory)).revision, ...extra,
  }, source);
  const remote = path.join(temporary, 'remote.git');
  const addRemote = async () => {
    await git(temporary, 'init', '--bare', '-q', '--initial-branch=main', remote);
    await git(repo, 'remote', 'add', 'origin', remote);
    return remote;
  };
  return { temporary, repo, write, act, addRemote, source };
}

test('本地及远端分支标记其他 worktree 占用，拒绝重复检出且保留双方工作区', async t => {
  const f = await fixture(t); await f.addRemote();
  await git(f.repo, 'branch', 'feature/occupied');
  await git(f.repo, 'push', '-q', '-u', 'origin', 'feature/occupied');
  const linked = path.join(f.temporary, 'linked workspace\n中文');
  await git(f.repo, 'worktree', 'add', '-q', linked, 'feature/occupied');
  const before = await git(f.repo, 'rev-parse', 'HEAD');
  const snapshot = await readProjectGitSnapshot(f.repo);
  for (const ref of ['refs/heads/feature/occupied', 'refs/remotes/origin/feature/occupied']) {
    const branch = snapshot.branches.find(item => item.ref === ref)!;
    assert.deepEqual(branch.worktreePaths, [linked]);
    assert.match(branch.switchBlockedReason, /其他工作区/);
    await assert.rejects(f.act('switch', { ref }), /其他工作区/);
  }
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before);
  assert.equal(await git(linked, 'branch', '--show-current'), 'feature/occupied');
});

test('从仓库子目录操作统一定位仓库根目录，暂存与全部取消暂存覆盖完整仓库', async t => {
  const f = await fixture(t); const sub = path.join(f.repo, 'nested'); await fs.mkdir(sub);
  await f.write('nested/a.txt', 'nested\n'); await f.write('value.txt', 'updated\n');
  assert.equal((await readProjectGitSnapshot(sub)).directory, f.repo);
  await f.act('stage', { files: ['value.txt'] }, sub);
  await f.act('stage', { files: ['nested/a.txt'] }, sub);
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 2);
  await f.act('unstage-all', {}, sub);
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 0);
  assert.equal(await fs.readFile(path.join(sub, 'a.txt'), 'utf8'), 'nested\n');
});

for (const action of ['unstage', 'unstage-all']) {
  test(`首次提交前 ${action} 可取消已再次修改文件的暂存并保留工作区内容`, async t => {
    const f = await fixture(t, true);
    await f.write('new.txt', 'first\n'); await f.act('stage-all'); await f.write('new.txt', 'second\n');
    await f.act(action, action === 'unstage' ? { files: ['new.txt'] } : {});
    assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 0);
    assert.equal(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8'), 'second\n');
    assert.equal(await git(f.repo, 'ls-files'), '');
  });
}

test('本地分支与上游名称不同时，推送更新原上游而非创建同名远端并改写跟踪', async t => {
  const f = await fixture(t); const remote = await f.addRemote();
  await git(f.repo, 'branch', '-m', 'feature/local-review');
  await git(f.repo, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/feature/published');
  await f.write('value.txt', 'changed\n'); await f.act('stage-all'); await f.act('commit', { message: '验证上游推送' });
  await f.act('push', { remote: 'origin' });
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/feature/published'), await git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(await git(f.repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/published');
  assert.equal(await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature/local-review'), '');
});

test('文件状态仍为 M 但内容已变化时，旧快照不能继续暂存新内容', async t => {
  const f = await fixture(t);
  await f.write('value.txt', 'first\n'); const before = await readProjectGitSnapshot(f.repo);
  await f.write('value.txt', 'other\n');
  const after = await readProjectGitSnapshot(f.repo);
  assert.notEqual(after.revision, before.revision);
  await assert.rejects(executeProjectGitAction({ path: f.repo, action: 'stage-all', revision: before.revision }, f.source), /状态已变化/);
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 0);
});

test('逐文件丢弃恢复暂存区版本，保留暂存、未选文件及已提交版本', async t => {
  const f = await fixture(t);
  await f.write('value.txt', 'staged\n');
  await f.act('stage', { files: ['value.txt'] });
  await fs.unlink(path.join(f.repo, 'value.txt'));
  await f.write('other.txt', 'keep\n');
  const result = await f.act('discard', { file: 'value.txt', confirmed: true });
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'staged\n');
  assert.equal(await fs.readFile(path.join(f.repo, 'other.txt'), 'utf8'), 'keep\n');
  assert.equal(await git(f.repo, 'show', 'HEAD:value.txt'), 'base');
  assert.deepEqual(result.snapshot?.files.find(file => file.path === 'value.txt'), {
    path: 'value.txt', status: 'M', staged: true, unstaged: false, untracked: false, conflict: false,
  });
  await assert.rejects(f.act('discard', { file: 'value.txt', confirmed: true }), /未暂存或未跟踪/);
});

test('删除未跟踪文件只影响确认的路径，状态变更或缺少确认时拒绝', async t => {
  const f = await fixture(t);
  const file = '内容 [a].txt';
  await f.write(file, 'before\n');
  await f.write('内容 a.txt', 'keep\n');
  const before = await readProjectGitSnapshot(f.repo);
  await f.write(file, 'new content\n');
  await assert.rejects(f.act('discard', { file, revision: before.revision, confirmed: true }), /状态已变化/);
  await assert.rejects(f.act('discard', { file, confirmed: true, revision: undefined }), /请从当前改动列表确认/);
  await assert.rejects(f.act('discard', { file }), /请从当前改动列表确认/);
  await assert.rejects(f.act('discard', { file: '../outside.txt', confirmed: true }), /请选择项目内/);
  assert.equal(await fs.readFile(path.join(f.repo, file), 'utf8'), 'new content\n');
  await f.act('discard', { file, confirmed: true });
  await assert.rejects(fs.stat(path.join(f.repo, file)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.repo, '内容 a.txt'), 'utf8'), 'keep\n');
});

test('Git 操作已成功时，项目列表刷新故障不把成功结果报告成失败', async t => {
  const f = await fixture(t); await f.write('value.txt', 'updated\n');
  const source = { readLocalProjects: async () => { throw new Error('inventory offline'); } } as unknown as SourceBackend;
  const result = await executeProjectGitAction({ path: f.repo, action: 'stage-all' }, source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot!.counts.staged, 1);
});

test('重复切换当前本地或跟踪分支是无损操作，保留未提交文件', async t => {
  const f = await fixture(t); await f.addRemote(); await git(f.repo, 'push', '-q', '-u', 'origin', 'main');
  await f.write('value.txt', 'dirty\n');
  await f.act('switch', { ref: 'refs/heads/main' });
  await f.act('switch', { ref: 'refs/remotes/origin/main' });
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'dirty\n');
  assert.equal(await git(f.repo, 'branch', '--show-current'), 'main');
});

test('暂存重命名差异包含来源路径，取消暂存保留重命名后的文件', async t => {
  const f = await fixture(t); await git(f.repo, 'mv', 'value.txt', 'renamed.txt');
  const diff = await readProjectDiff(f.repo, 'renamed.txt', true);
  assert.match(diff.patch, /rename from value.txt/);
  assert.match(diff.patch, /rename to renamed.txt/);
  await f.act('unstage', { files: ['renamed.txt'] });
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 0);
  assert.equal(await fs.readFile(path.join(f.repo, 'renamed.txt'), 'utf8'), 'base\n');
});

test('远端检出保留已有自定义名称的跟踪分支，也能首次创建本地跟踪', async t => {
  const f = await fixture(t); await f.addRemote();
  await git(f.repo, 'push', '-q', 'origin', 'main:refs/heads/feature/new-remote');
  await f.act('fetch', { remote: 'origin' });
  await f.act('switch', { ref: 'refs/remotes/origin/feature/new-remote' });
  assert.equal((await readProjectGitSnapshot(f.repo)).upstream, 'origin/feature/new-remote');
  await git(f.repo, 'branch', '-m', 'feature/custom-local'); await f.act('switch', { ref: 'refs/heads/main' });
  await f.act('switch', { ref: 'refs/remotes/origin/feature/new-remote' });
  assert.equal((await readProjectGitSnapshot(f.repo)).branch, 'feature/custom-local');
});

test('切换 Jira 站点时清除旧凭据，测试连接不会将旧凭据发给新站点', async t => {
  const f = await fixture(t);
  const envFile = path.join(f.repo, '.env');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('不应访问网络'); });
  for (const [key, value] of Object.entries({ DELIVERY_CREDENTIALS_FILE: envFile,
    JIRA_BASE_URL: 'https://old.example.test', JIRA_USERNAME: '', JIRA_KEYCHAIN_ACCOUNT: '', JIRA_API_TOKEN: 'fixture-token', JIRA_AUTH_HEADER: 'Bearer fixture-token',
    JIRA_COOKIE: 'fixture-cookie', JIRA_KEYCHAIN_SERVICE: 'fixture-service' })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const source = {} as SourceBackend;
  await assert.rejects(updateShareConfig({ action: 'test-jira', jiraBaseUrl: 'https://new.example.test' }, source), /请先填写/);
  const result = await updateShareConfig({ jiraBaseUrl: 'https://new.example.test' }, source);
  assert.ok('config' in result && result.config?.hasJiraToken === false);
  assert.match(await fs.readFile(envFile, 'utf8'), /JIRA_API_TOKEN=\n/);
});

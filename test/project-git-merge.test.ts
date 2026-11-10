import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeProjectGitAction, readProjectGitSnapshot } from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) =>
  (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args])).stdout.trim();

async function fixture(t: TestContext) {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-git-merge-')));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Merge Fixture');
  await git(repo, 'config', 'user.email', 'merge@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  const write = (file: string, content: string | Buffer) => fs.writeFile(path.join(repo, file), content);
  const commit = async (message: string) => {
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  await write('value.txt', 'base\n'); const base = await commit('初始化仓库');
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;
  const act = (action: string, extra: Record<string, unknown> = {}) =>
    executeProjectGitAction({ path: repo, action, ...extra }, source);
  const preview = async (ref = 'refs/heads/feature/incoming') => {
    const result = await act('merge-preview', { ref });
    assert.ok('preview' in result && result.preview);
    return result.preview;
  };
  return { repo, write, commit, act, preview, base };
}

test('合并预览按目标到来源计算独有提交与改动，不包含目标分支已有改动且保留脏工作区', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  await f.write('source\t中文\nname.txt', 'incoming\n');
  await f.write('binary.dat', Buffer.from([0, 1, 2]));
  const sourceSha = await f.commit('来源变更');
  await git(f.repo, 'switch', '-q', 'main');
  await f.write('target.txt', 'target\n'); const targetSha = await f.commit('目标已有变更');
  await f.write('value.txt', 'staged\n'); await git(f.repo, 'add', 'value.txt');
  await f.write('value.txt', 'dirty\n');
  const before = await readProjectGitSnapshot(f.repo);
  const preview = await f.preview();
  assert.equal(preview.sourceSha, sourceSha); assert.equal(preview.targetSha, targetSha);
  assert.equal(preview.sourceRef, 'refs/heads/feature/incoming');
  assert.equal(preview.targetRef, 'refs/heads/main');
  assert.equal(preview.mergeBase, f.base);
  assert.equal(preview.ahead, 1); assert.equal(preview.behind, 1);
  assert.equal(preview.canFastForward, false); assert.equal(preview.alreadyMerged, false);
  assert.deepEqual(preview.commits.map(item => item.subject), ['来源变更']);
  assert.deepEqual(preview.files.map(item => item.path).sort(), ['binary.dat', 'source\t中文\nname.txt']);
  assert.deepEqual(preview.totals, { files: 2, additions: 1, deletions: 0, binaryFiles: 1 });
  assert.deepEqual(preview.branchDiff, {
    total: 3,
    files: [
      { path: 'binary.dat', status: 'A' },
      { path: 'source\t中文\nname.txt', status: 'A' },
      { path: 'target.txt', status: 'D' },
    ],
  });
  assert.equal((await readProjectGitSnapshot(f.repo)).revision, before.revision);
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'dirty\n');
  await assert.rejects(f.act('merge', { ref: preview.sourceRef }), /请先提交/);
});

test('指定远端基准创建本地分支，不错误继承远端目标分支的跟踪关系', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  await f.write('incoming.txt', 'incoming\n'); const sha = await f.commit('基准提交');
  await git(f.repo, 'switch', '-q', 'main');
  await git(f.repo, 'update-ref', 'refs/remotes/origin/incoming', sha);
  await f.act('create-branch', { branch: 'feature/from-remote', startRef: 'refs/remotes/origin/incoming' });
  const result = await readProjectGitSnapshot(f.repo);
  assert.equal(result.branch, 'feature/from-remote'); assert.equal(result.head, sha); assert.equal(result.upstream, '');
  await assert.rejects(f.act('create-branch', { branch: 'feature/invalid', startRef: '--orphan' }), /基准分支已不存在/);
  assert.equal((await readProjectGitSnapshot(f.repo)).branch, 'feature/from-remote');
});

test('按请求获取两个分支并合入指定本地目标，远端分支保持原提交', async t => {
  const f = await fixture(t);
  const remote = path.join(f.repo, '.git', 'fixture-origin');
  await git(f.repo, 'init', '--bare', '-q', remote);
  await git(f.repo, 'remote', 'add', 'origin', remote);
  await git(f.repo, 'branch', 'target', f.base);
  await git(f.repo, 'switch', '-qc', 'remote-target');
  await f.write('target.txt', 'target\n'); const targetSha = await f.commit('目标前进');
  await git(f.repo, 'switch', '-qc', 'feature/source', f.base);
  await f.write('source.txt', 'source\n'); const sourceSha = await f.commit('来源改动');
  await git(f.repo, 'push', '-q', remote, 'remote-target:target', 'feature/source', 'main:unrelated');
  // 部分 Git 版本也会从路径推送更新同 URL 的跟踪分支。测试先统一抓取前状态。
  await git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/unrelated');

  const fetch = await f.act('fetch', { remote: 'origin', branches: ['feature/source', 'target'] });
  assert.ok(fetch.snapshot?.branches.some(b => b.ref === 'refs/remotes/origin/target' && b.sha === targetSha));
  assert.ok(!fetch.snapshot?.branches.some(b => b.ref === 'refs/remotes/origin/unrelated'));
  await f.act('switch', { ref: 'refs/heads/target' });
  await f.act('merge', { ref: 'refs/remotes/origin/target', strategy: 'ff-only',
    expectedTargetBranch: 'target', expectedSourceSha: targetSha, expectedTargetSha: f.base });
  await assert.rejects(f.act('merge-preview', { ref: 'refs/remotes/origin/feature/source', expectedTargetBranch: 'main' }), /分支与预览目标不一致/);
  await assert.rejects(f.act('merge', { ref: 'refs/remotes/origin/feature/source', expectedTargetBranch: 'main',
    expectedSourceSha: sourceSha, expectedTargetSha: targetSha }), /分支与预览目标不一致/);
  const result = await f.act('merge', { ref: 'refs/remotes/origin/feature/source', expectedTargetBranch: 'target',
    expectedSourceSha: sourceSha, expectedTargetSha: targetSha });
  assert.equal(result.snapshot?.branch, 'target');
  assert.equal(await git(f.repo, 'show', '-s', '--format=%P'), `${targetSha} ${sourceSha}`);
  assert.equal(await git(remote, 'rev-parse', 'target'), targetSha);
});

test('新建分支检查同名及双向路径冲突，换名后仍从指定基准创建', async t => {
  const f = await fixture(t);
  await git(f.repo, 'branch', 'feature/APEX-655', f.base);
  await git(f.repo, 'branch', 'feature/HEAD', f.base);
  await git(f.repo, 'pack-refs', '--all');
  await f.write('current.txt', 'current\n');
  const head = await f.commit('当前分支前进');
  const startRef = 'refs/heads/feature/APEX-655';

  await assert.rejects(f.act('create-branch', { branch: 'feature/APEX-655', startRef }), /本地分支「feature\/APEX-655」已存在/);
  for (const branch of ['feature/APEX-655/20261109', 'feature']) {
    await assert.rejects(f.act('create-branch', { branch, startRef }), /与本地分支「feature\/APEX-655」存在路径冲突/);
  }
  await assert.rejects(f.act('create-branch', { branch: 'feature/HEAD/child', startRef }), /与本地分支「feature\/HEAD」存在路径冲突/);
  await git(f.repo, 'update-ref', 'refs/remotes/origin/feature/APEX-655/20261109', f.base);
  await assert.rejects(f.act('switch', { ref: 'refs/remotes/origin/feature/APEX-655/20261109' }), /与本地分支「feature\/APEX-655」存在路径冲突/);
  assert.equal(await git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head);

  const result = await f.act('create-branch', { branch: 'feature/APEX-655-20261109', startRef });
  assert.equal(result.snapshot?.branch, 'feature/APEX-655-20261109');
  assert.equal(result.snapshot?.head, f.base);
  assert.equal(await git(f.repo, 'rev-parse', startRef), f.base);
});

test('分支创建在忽略大小写的仓库提示实际冲突名称，并解释无效分支名', async t => {
  const f = await fixture(t);
  await git(f.repo, 'config', 'core.ignoreCase', 'true');
  await git(f.repo, 'branch', 'feature/APEX-655');

  await assert.rejects(f.act('create-branch', { branch: 'feature/apex-655' }), /「feature\/APEX-655」已存在.*仅大小写不同/);
  for (const branch of ['feature/apex-655/20261109', 'FEATURE']) {
    await assert.rejects(f.act('create-branch', { branch }), /与本地分支「feature\/APEX-655」存在路径冲突/);
  }
  await assert.rejects(f.act('create-branch', { branch: 'FEATURE/APEX-655-fix' }), /请沿用已有目录的拼写「feature」/);
  await git(f.repo, 'update-ref', 'refs/remotes/origin/feature/apex-655', f.base);
  await assert.rejects(f.act('switch', { ref: 'refs/remotes/origin/feature/apex-655' }), /「feature\/APEX-655」已存在.*仅大小写不同/);
  for (const branch of ['HEAD', 'feature//APEX-655', 'feature/APEX-655.lock', '@{-1}']) {
    await assert.rejects(f.act('create-branch', { branch }), /分支名称格式不正确/);
  }
  assert.equal(await git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal((await f.act('create-branch', { branch: 'feature/APEX-655-fix' })).snapshot?.branch, 'feature/APEX-655-fix');
});

test('预览能识别快进与已包含，默认合并保持快进兼容', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  await f.write('incoming.txt', 'incoming\n'); const sourceSha = await f.commit('来源提交');
  await git(f.repo, 'switch', '-q', 'main');
  const preview = await f.preview();
  assert.equal(preview.canFastForward, true); assert.equal(preview.behind, 0);
  await f.act('merge', { ref: preview.sourceRef, expectedSourceSha: sourceSha, expectedTargetSha: f.base });
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), sourceSha);
  const merged = await f.preview();
  assert.equal(merged.alreadyMerged, true); assert.equal(merged.ahead, 0);
  assert.equal(merged.files.length, 0); assert.equal(merged.commits.length, 0);
});

test('始终创建合并提交保留双亲及中文说明，来源已变更时拒绝过时确认', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  await f.write('incoming.txt', 'incoming\n'); const sourceSha = await f.commit('来源提交');
  await git(f.repo, 'switch', '-q', 'main');
  const preview = await f.preview();
  await assert.rejects(f.act('merge', { ref: preview.sourceRef, expectedSourceSha: f.base, expectedTargetSha: f.base }), /重新预览/);
  await assert.rejects(f.act('merge', { ref: preview.sourceRef, expectedSourceSha: sourceSha, expectedTargetSha: sourceSha }), /重新预览/);
  await assert.rejects(f.act('merge', { ref: preview.sourceRef, strategy: '--squash' }), /合并方式/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.base);
  await f.act('merge', { ref: preview.sourceRef, strategy: 'no-ff', message: '合并：验证功能',
    expectedSourceSha: sourceSha, expectedTargetSha: f.base });
  assert.equal(await git(f.repo, 'show', '-s', '--format=%P'), `${f.base} ${sourceSha}`);
  assert.equal(await git(f.repo, 'show', '-s', '--format=%s'), '合并：验证功能');
});

test('仅快进拒绝分叉，普通合并冲突可回读、中止及解决后提交', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  await f.write('incoming-only.txt', 'can be merged automatically\n');
  await f.write('value.txt', 'incoming\n'); const sourceSha = await f.commit('来源提交');
  await git(f.repo, 'switch', '-q', 'main');
  await f.write('value.txt', 'target\n'); const targetSha = await f.commit('目标提交');
  const preview = await f.preview();
  await assert.rejects(f.act('merge', { ref: preview.sourceRef, strategy: 'ff-only' }));
  assert.equal((await readProjectGitSnapshot(f.repo)).clean, true);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), targetSha);
  const result = await f.act('merge', { ref: preview.sourceRef, strategy: 'ff' });
  assert.equal(result.outcome, 'merge-conflicts');
  const conflict = result.snapshot!;
  assert.equal(conflict.mergeInProgress, true);
  assert.deepEqual(conflict.counts, { total: 2, staged: 1, unstaged: 0, untracked: 0, conflicts: 1 });
  assert.deepEqual(conflict.files.map(({ path, staged, conflict }) => ({ path, staged, conflict })), [
    { path: 'value.txt', staged: false, conflict: true },
    { path: 'incoming-only.txt', staged: true, conflict: false },
  ]);
  const indexBefore = await git(f.repo, 'ls-files', '--stage');
  await assert.rejects(f.act('stage', { files: ['value.txt'] }), /处理后保存/);
  await assert.rejects(f.act('stage-all'), /先逐个处理冲突/);
  await assert.rejects(f.act('unstage-all'), /先完成或中止合并/);
  assert.equal(await git(f.repo, 'ls-files', '--stage'), indexBefore);
  await f.act('abort-merge');
  assert.equal((await readProjectGitSnapshot(f.repo)).clean, true);
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'target\n');
  assert.equal((await f.act('merge', { ref: preview.sourceRef })).outcome, 'merge-conflicts');
  // Simulate staging unresolved markers outside the workbench.
  await git(f.repo, 'add', 'value.txt');
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.conflicts, 0);
  await assert.rejects(f.act('commit', { message: '不能提交未处理冲突' }), /仍有合并冲突标记/);
  await f.write('value.txt', 'target and incoming\n');
  await assert.rejects(f.act('commit', { message: '工作区已修复但尚未暂存' }), /仍有合并冲突标记/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), targetSha);
  await f.act('stage-all');
  await f.act('commit', { message: '解决冲突并合并' });
  assert.equal((await readProjectGitSnapshot(f.repo)).mergeInProgress, false);
  assert.equal(await git(f.repo, 'show', '-s', '--format=%P'), `${targetSha} ${sourceSha}`);
});

test('预览限制提交和文件展示数量，同时保留完整计数', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-qc', 'feature/incoming');
  for (let i = 0; i < 103; i++) await f.write(`source-${i}.txt`, 'incoming\n');
  let sha = await f.commit('新增文件');
  const tree = await git(f.repo, 'rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 101; i++) sha = await git(f.repo, 'commit-tree', tree, '-p', sha, '-m', `历史提交 ${i}`);
  await git(f.repo, 'update-ref', 'refs/heads/feature/incoming', sha);
  await git(f.repo, 'switch', '-q', 'main');
  const preview = await f.preview();
  assert.equal(preview.ahead, 102); assert.equal(preview.commits.length, 100); assert.equal(preview.commitsTruncated, true);
  assert.equal(preview.files.length, 100); assert.equal(preview.filesTruncated, true);
  assert.equal(preview.totals.files, 103); assert.equal(preview.totals.additions, 103);
  assert.equal(preview.branchDiff.total, 103); assert.equal(preview.branchDiff.files.length, 100);
});

test('无共同祖先或来源ref无效时拒绝预览且不改动分支', async t => {
  const f = await fixture(t);
  const tree = await git(f.repo, 'rev-parse', 'HEAD^{tree}');
  const unrelated = await git(f.repo, 'commit-tree', tree, '-m', '独立历史');
  await git(f.repo, 'update-ref', 'refs/heads/feature/unrelated', unrelated);
  await assert.rejects(f.preview('refs/heads/feature/unrelated'), /没有共同祖先/);
  await assert.rejects(f.preview('--all'), /请选择要合入/);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.base);
});

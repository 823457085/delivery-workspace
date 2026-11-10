import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deliverJiraDevMergeRequest } from '../server/jira-dev-automation-mr.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await exec('git', ['-C', directory, ...args])).stdout.trim();

test('研发 MR 只使用已验证并推送的任务提交，回读审核人且不重复创建', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jira-dev-mr-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const sourceProjectPath = path.join(root, 'source');
  const workspacePath = path.join(root, 'task');
  const remote = path.join(root, 'remote.git');
  const branchName = 'feature/ABC-22';
  const repositoryPath = '0123456789abcdef01234567/team/project';
  const repositoryUrl = `https://codeup.aliyun.com/${repositoryPath}`;
  await fs.mkdir(sourceProjectPath);
  await git(sourceProjectPath, 'init', '-qb', 'main');
  await git(sourceProjectPath, 'config', 'user.name', 'MR Fixture');
  await git(sourceProjectPath, 'config', 'user.email', 'fixture@localhost');
  await git(sourceProjectPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(sourceProjectPath, 'value.txt'), 'base\n');
  await git(sourceProjectPath, 'add', 'value.txt');
  await git(sourceProjectPath, 'commit', '-qm', '初始化');
  const baseSha = await git(sourceProjectPath, 'rev-parse', 'HEAD');
  await git(root, 'init', '--bare', '-q', remote);
  await git(sourceProjectPath, 'push', '-q', remote, 'main');
  await git(sourceProjectPath, 'worktree', 'add', '-qb', branchName, workspacePath);
  await fs.writeFile(path.join(workspacePath, 'value.txt'), 'verified\n');
  await git(workspacePath, 'commit', '-qam', 'ABC-22: 修复显示');
  const verifiedHead = await git(workspacePath, 'rev-parse', 'HEAD');
  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh
case "$*" in
  *git-receive-pack*) exec git-receive-pack '${remote}' ;;
  *) exec git-upload-pack '${remote}' ;;
esac
`, { mode: 0o700 });
  await git(sourceProjectPath, 'config', 'core.sshCommand', ssh);
  await git(sourceProjectPath, 'config', 'ssh.variant', 'ssh');
  await git(sourceProjectPath, 'remote', 'add', 'origin', `git@codeup.aliyun.com:${repositoryPath}.git`);
  await fs.writeFile(path.join(root, 'yunxiao-credentials.json'), JSON.stringify({ token: 'fixture-token' }));

  const issue = { key: 'ABC-22', summary: '修复显示', project: 'ABC', parent: null };
  const profile = { id: 'test-project', name: '测试项目', repositoryUrl, localPath: sourceProjectPath,
    runtimeCommand: 'pnpm dev', runtimeEnvironment: 'test', targetBranch: 'main', jiraProjects: [], components: [], labels: [] };
  const settings = { autoCreateMergeRequest: true, reviewer: '张三', projectProfiles: [profile] };
  const input = { issue, settings, sourceProjectPath, workspacePath, branchName, baseSha, verifiedHead };
  const reviewer = { name: '张三', username: 'zhangsan', memberType: 'USERS', state: 'active', userId: 'reviewer-id' };
  const request = { localId: 21, sourceBranch: branchName, targetBranch: 'main', sourceProjectId: 123, targetProjectId: 123,
    detailUrl: `${repositoryUrl}/change/21`, status: 'UNDER_REVIEW', reviewers: [reviewer] };
  let posts = 0, calls = 0, members = [reviewer], allowed = true;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://openapi-rdc.aliyuncs.com');
    if (init?.method === 'POST') {
      assert.match(target.pathname, /\/repositories\/123\/changeRequests$/);
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.reviewerUserIds, ['reviewer-id']);
      assert.equal(body.sourceBranch, branchName);
      assert.equal(body.targetBranch, 'main');
      posts++;
      return Response.json(request);
    }
    if (target.pathname.endsWith('/members')) return Response.json(members);
    if (target.pathname.endsWith('/changeRequests/21')) return Response.json(request);
    if (target.pathname.endsWith('/changeRequests')) return Response.json(posts ? [request] : []);
    return Response.json({ id: 123, pathWithNamespace: repositoryPath });
  };
  const options = { dataDirectory: root, fetcher, beforeCreate: async () => { if (!allowed) throw new Error('自动交付授权已变化'); } };
  const pushOptions = { ...options, pushVerifiedHead: true };
  const branchRef = `refs/heads/${branchName}`;

  assert.equal((await deliverJiraDevMergeRequest({ ...input, settings: { ...settings, autoCreateMergeRequest: false } }, options)).status, 'skipped');
  assert.match((await deliverJiraDevMergeRequest(input, options)).message, /尚未推送/);
  await fs.writeFile(path.join(workspacePath, 'value.txt'), 'dirty\n');
  assert.match((await deliverJiraDevMergeRequest(input, options)).message, /与已验证提交不一致/);
  await git(workspacePath, 'restore', 'value.txt');
  await fs.mkdir(path.join(workspacePath, 'tempdocs'));
  await fs.writeFile(path.join(workspacePath, 'tempdocs', 'checks.md'), 'local evidence');
  await fs.mkdir(path.join(workspacePath, 'docs', 'requirements'), { recursive: true });
  const design = 'docs/requirements/ABC-22-tech-design.md';
  await fs.writeFile(path.join(workspacePath, design), 'local design');
  await git(workspacePath, 'add', design);
  assert.match((await deliverJiraDevMergeRequest(input, options)).message, /与已验证提交不一致/);
  await git(workspacePath, 'restore', '--staged', design);
  assert.match((await deliverJiraDevMergeRequest({ ...input, settings: { ...settings, projectProfiles: [profile, { ...profile, id: 'duplicate' }] } }, options)).message, /多个项目配置/);
  assert.equal(calls, 0);

  await git(sourceProjectPath, 'switch', '-qc', 'other');
  await git(sourceProjectPath, 'commit', '--allow-empty', '-qm', '并行提交');
  const diverged = await git(sourceProjectPath, 'rev-parse', 'HEAD');
  await git(sourceProjectPath, 'push', '-q', remote, `HEAD:${branchRef}`);
  assert.match((await deliverJiraDevMergeRequest(input, pushOptions)).message, /远端任务分支已分叉/);
  assert.equal(await git(remote, 'rev-parse', branchRef), diverged);
  await git(remote, 'update-ref', '-d', branchRef);

  await git(workspacePath, 'push', '-q', remote, `HEAD:${branchRef}`);
  members = [reviewer, { ...reviewer, userId: 'different-id' }];
  assert.match((await deliverJiraDevMergeRequest(input, options)).message, /无法唯一核对/);
  members = [reviewer];
  allowed = false;
  assert.match((await deliverJiraDevMergeRequest(input, options)).message, /授权已变化/);
  await git(remote, 'update-ref', '-d', branchRef);
  assert.match((await deliverJiraDevMergeRequest(input, pushOptions)).message, /授权已变化/);
  await assert.rejects(git(remote, 'rev-parse', '--verify', branchRef));
  assert.equal(posts, 0);
  allowed = true;
  const created = await deliverJiraDevMergeRequest(input, pushOptions);
  assert.equal(created.status, 'created');
  assert.equal('url' in created && created.url, request.detailUrl);
  assert.equal(await git(remote, 'rev-parse', branchRef), verifiedHead);
  assert.equal((await deliverJiraDevMergeRequest(input, options)).status, 'existing');
  assert.equal(posts, 1);
  await git(workspacePath, 'add', design);
  await git(workspacePath, 'commit', '-qm', '误提交本地方案');
  const invalidHead = await git(workspacePath, 'rev-parse', 'HEAD');
  assert.match((await deliverJiraDevMergeRequest({ ...input, verifiedHead: invalidHead }, pushOptions)).message, /包含本地交付产物/);
  assert.equal(await git(remote, 'rev-parse', branchRef), verifiedHead);
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listProjectMergeRequests, prepareProjectMergeRequest, createProjectMergeRequest, updateProjectMergeRequestTitle } from '../server/project-merge-request.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await exec('git', ['-C', directory, ...args])).stdout.trim();
const organization = '0123456789abcdef01234567';
const repositoryPath = `${organization}/team/project`;
const repositoryUrl = `https://codeup.aliyun.com/${repositoryPath}`;

async function fixture(t: TestContext, host = 'codeup.aliyun.com') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-mr-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git'), dataDirectory = path.join(root, 'data');
  await fs.mkdir(repo); await fs.mkdir(dataDirectory);
  await git(repo, 'init', '-qb', 'main'); await git(repo, 'config', 'user.name', 'MR Fixture');
  await git(repo, 'config', 'user.email', 'fixture@localhost'); await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'value.txt'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', '初始化');
  await git(root, 'init', '--bare', '-q', remote); await git(repo, 'push', '-q', remote, 'main');
  await git(repo, 'switch', '-qc', 'feature/中文');
  await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', '功能');
  await git(repo, 'push', '-q', remote, 'HEAD:refs/heads/feature/中文');
  // 保留真实 Codeup/GitLab/GitHub remote URL；仅以本地 upload-pack 代替 SSH 网络传输。
  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o700 });
  await git(repo, 'config', 'core.sshCommand', ssh); await git(repo, 'config', 'ssh.variant', 'ssh');
  await git(repo, 'remote', 'add', 'origin', `git@${host}:${repositoryPath}.git`);
  await fs.writeFile(path.join(dataDirectory, 'yunxiao-credentials.json'), JSON.stringify({ token: 'fixture-secret-not-real' }));
  const input = { path: repo, remote: 'origin', sourceBranch: 'feature/中文', targetBranch: 'main' };
  let requests: unknown[] = [], postCount = 0, postMode: 'success' | 'timeout' | 400 | 403 = 'success', readbackBroken = false, readbackForbidden = false;
  let currentTitle = '创建测试';
  const calls: { url: string; method: string }[] = [];
  const request = () => ({ localId: 12, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch,
    sourceProjectId: 123, targetProjectId: 123, webUrl: repositoryUrl, detailUrl: `${repositoryUrl}/change/12`,
    title: currentTitle, status: 'TO_BE_MERGED' });
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url)); const method = init?.method || 'GET'; calls.push({ url: target.href, method });
    assert.equal(target.origin, 'https://openapi-rdc.aliyuncs.com');
    assert.equal(new Headers(init?.headers).get('x-yunxiao-token'), 'fixture-secret-not-real');
    if (method === 'POST') {
      postCount++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.sourceBranch, input.sourceBranch); assert.equal(body.targetBranch, input.targetBranch);
      assert.equal(body.sourceProjectId, 123); assert.equal(body.triggerAIReviewRun, false);
      if (postMode === 'timeout') throw new Error('fixture-secret-not-real network failure');
      if (typeof postMode === 'number') return Response.json({ message: 'fixture-secret-not-real' }, { status: postMode });
      requests = [request()]; return Response.json({ ...request(), detailUrl: undefined });
    }
    if (method === 'PUT') {
      assert.ok(target.pathname.endsWith('/repositories/123/changeRequests/12'));
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body), ['title']);
      currentTitle = body.title;
      return Response.json({ result: true });
    }
    if (target.pathname.endsWith('/changeRequests/12')) return readbackForbidden
      ? Response.json({}, { status: 403 }) : Response.json(readbackBroken ? { ...request(), localId: 13 } : request());
    if (target.pathname.endsWith('/changeRequests')) return Response.json(requests, { headers: {
      'x-next-page': '1', 'x-page': '1', 'x-total-pages': '1', 'x-total': String(requests.length), 'x-per-page': '100' } });
    return Response.json({ id: 123, pathWithNamespace: repositoryPath });
  };
  const options = { dataDirectory, fetcher };
  const prepare = () => prepareProjectMergeRequest(input, options);
  const create = async (prepared?: Awaited<ReturnType<typeof prepare>>) => {
    const confirmed = prepared || await prepare();
    return createProjectMergeRequest({ ...input, title: '创建测试', description: '验证说明',
      revision: confirmed.revision, expectedSourceSha: confirmed.sourceSha, expectedTargetSha: confirmed.targetSha }, options);
  };
  return { root, repo, remote, dataDirectory, input, options, prepare, create, calls, request,
    get postCount() { return postCount; }, setRequests: (value: unknown[]) => { requests = value; },
    setMode: (mode: typeof postMode) => { postMode = mode; }, breakReadback: () => { readbackBroken = true; },
    forbidReadback: () => { readbackForbidden = true; } };
}

test('Codeup 准备只读，创建后回读真实编号并复用已有请求', async t => {
  const f = await fixture(t); const prepared = await f.prepare();
  assert.equal(prepared.mode, 'api'); assert.equal(prepared.canCreate, true); assert.equal(f.postCount, 0);
  assert.equal(prepared.sourceSha, await git(f.repo, 'rev-parse', 'HEAD'));
  const result = await f.create(prepared); assert.equal(result.created, true); assert.equal(result.request.id, 12);
  assert.equal(result.request.url, `${repositoryUrl}/change/12`); assert.equal(f.postCount, 1);
  assert.deepEqual((await f.prepare()).existing, { id: 12, title: '创建测试', url: `${repositoryUrl}/change/12`, state: 'TO_BE_MERGED' });
  assert.equal((await f.create()).created, false); assert.equal(f.postCount, 1);
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
});

test('Codeup 兼容 webUrl 为详情的响应，拒绝仓库首页或其他站点的链接', async t => {
  const f = await fixture(t);
  f.setRequests([{ ...f.request(), detailUrl: undefined, webUrl: `${repositoryUrl}/change/12` }]);
  assert.equal((await f.prepare()).existing?.url, `${repositoryUrl}/change/12`);
  f.setRequests([{ ...f.request(), detailUrl: 'https://example.com/change/12', webUrl: `${repositoryUrl}/` }]);
  await assert.rejects(f.prepare(), /合并请求详情地址/);
  assert.equal(f.postCount, 0);
});

test('工作台列出同一仓库的未结束请求，返回平台发起人、分支和详情链接', async t => {
  const f = await fixture(t);
  const request = f.request();
  f.setRequests([
    { ...request, author: { name: '发起人姓名', username: 'creator', email: 'fixture@localhost' } },
    { ...request, localId: 15, detailUrl: `${repositoryUrl}/change/15`, author: { name: ' ', username: 'account-only' } },
    { ...request, localId: 13, status: 'MERGED' },
    { ...request, localId: 14, sourceProjectId: 456 },
  ]);
  const { requests } = await listProjectMergeRequests(f.input, f.options);
  const expected = { id: 12, title: request.title, state: request.status, url: request.detailUrl,
    sourceBranch: request.sourceBranch, targetBranch: request.targetBranch, author: '发起人姓名' };
  assert.deepEqual(requests, [expected, { ...expected, id: 15, url: `${repositoryUrl}/change/15`, author: 'account-only' }]);
  assert.equal(f.postCount, 0);
});

test('只更新所选合并请求的标题并回读，拒绝过期标题和错误分支', async t => {
  const f = await fixture(t);
  const input = { ...f.input, repositoryUrl, id: 12, expectedTitle: '创建测试', title: '  修订后的标题  ' };
  await assert.rejects(updateProjectMergeRequestTitle({ ...input, targetBranch: 'other' }, f.options), /不一致/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  const result = await updateProjectMergeRequestTitle(input, f.options);
  assert.equal(result.request.title, '修订后的标题');
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/changeRequests/12')).slice(-3).map(call => call.method),
    ['GET', 'PUT', 'GET']);
  await updateProjectMergeRequestTitle(input, f.options);
  await assert.rejects(updateProjectMergeRequestTitle({ ...input, title: '另一个标题' }, f.options), /标题已被修改/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('Codeup 超时持久保留未知状态，不重试；再次查询找到请求才恢复', async t => {
  const f = await fixture(t); f.setMode('timeout');
  await assert.rejects(f.create(), error => /创建结果尚未确认/.test(String(error)) && !String(error).includes('fixture-secret'));
  assert.equal(f.postCount, 1); const prepared = await f.prepare();
  assert.equal(prepared.canCreate, false); assert.match(prepared.reason!, /不会自动重复创建/);
  await assert.rejects(f.create(), /创建结果尚未确认/); assert.equal(f.postCount, 1);
  f.setRequests([f.request()]); assert.equal((await f.prepare()).existing?.id, 12);
  assert.equal((await f.create()).created, false); assert.equal(f.postCount, 1);
});

for (const status of [400, 403] as const) {
  test(`Codeup ${status} 不暴露令牌，仅权限拒绝提示检查权限`, async t => {
    const f = await fixture(t); f.setMode(status);
    await assert.rejects(f.create(), error => {
      assert.match(String(error), new RegExp(String(status)));
      assert.doesNotMatch(String(error), /fixture-secret/);
      assert.equal(/权限/.test(String(error)), status === 403);
      return true;
    });
    assert.equal((await f.prepare()).canCreate, true); assert.equal(f.postCount, 1);
  });
}

test('远端目标变化后拒绝使用旧准备结果创建', async t => {
  const f = await fixture(t); const prepared = await f.prepare();
  await git(f.repo, 'push', '-q', f.remote, 'HEAD:refs/heads/main');
  await assert.rejects(f.create(prepared), /远端分支提交已变化/); assert.equal(f.postCount, 0);
});

test('远端目标已包含源提交时阻止新建并仍可查询已有合并请求', async t => {
  const f = await fixture(t);
  await git(f.repo, 'push', '-q', f.remote, 'HEAD:refs/heads/main');
  const same = await f.prepare();
  assert.equal(same.sourceSha, same.targetSha);
  assert.equal(same.canCreate, false);
  assert.match(same.reason!, /目标分支已包含/);

  await git(f.repo, 'switch', '-qc', 'target-ahead');
  await git(f.repo, 'commit', '--allow-empty', '-qm', '推进目标分支');
  await git(f.repo, 'push', '-q', f.remote, 'HEAD:refs/heads/main');
  await git(f.repo, 'switch', '-q', f.input.sourceBranch);
  const ahead = await f.prepare();
  assert.notEqual(ahead.sourceSha, ahead.targetSha);
  assert.equal(ahead.canCreate, false);
  await assert.rejects(f.create(ahead), /目标分支已包含/);
  assert.equal(f.postCount, 0);

  f.setRequests([f.request()]);
  assert.equal((await f.prepare()).existing?.id, 12);
});

test('当前源分支未推送、远端缺失与同分支选择均拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareProjectMergeRequest({ ...f.input, sourceBranch: 'feature/missing' }, f.options), /尚未推送/);
  await assert.rejects(prepareProjectMergeRequest({ ...f.input, targetBranch: 'missing' }, f.options), /远端不存在/);
  await assert.rejects(prepareProjectMergeRequest({ ...f.input, targetBranch: f.input.sourceBranch }, f.options), /不能相同/);
  await fs.writeFile(path.join(f.repo, 'later.txt'), 'later'); await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-qm', '未推送');
  await assert.rejects(f.prepare(), /提交不一致/); assert.equal(f.postCount, 0);
});

test('缺少云效凭据返回不可创建状态，不请求云效', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.dataDirectory, 'yunxiao-credentials.json'));
  const prepared = await f.prepare(); assert.equal(prepared.mode, 'unavailable'); assert.equal(prepared.canCreate, false);
  assert.match(prepared.reason!, /个人访问令牌/); assert.equal(f.calls.length, 0);
});

for (const [host, provider] of [['github.com', 'GitHub'], ['gitlab.example.com', 'GitLab']]) {
  test(`${provider} 仅准备携带源目标及标题的官方页面，不创建请求`, async t => {
    const f = await fixture(t, host); const prepared = await f.prepare(); const url = new URL(prepared.url);
    assert.equal(prepared.provider, provider); assert.equal(prepared.mode, 'browser'); assert.equal(f.calls.length, 0);
    if (provider === 'GitHub') {
      assert.match(decodeURIComponent(url.pathname), /compare\/main\.\.\.feature\/中文$/); assert.equal(url.searchParams.get('quick_pull'), '1');
    } else {
      assert.equal(url.searchParams.get('merge_request[source_branch]'), 'feature/中文');
      assert.equal(url.searchParams.get('merge_request[target_branch]'), 'main');
    }
    await assert.rejects(f.create(), /前往代码平台/);
  });
}

test('创建后的编号回读不一致不声称成功', async t => {
  const f = await fixture(t); f.breakReadback();
  await assert.rejects(f.create(), /创建结果尚未确认/); assert.equal(f.postCount, 1);
});

test('POST 已成功后回读遭到权限拒绝仍保留未知记录，不能再次创建', async t => {
  const f = await fixture(t); f.forbidReadback();
  await assert.rejects(f.create(), /创建结果尚未确认/); assert.equal(f.postCount, 1);
  assert.equal((await fs.readdir(path.join(f.dataDirectory, 'project-merge-requests'))).length, 1);
  f.setRequests([]); assert.equal((await f.prepare()).canCreate, false);
  await assert.rejects(f.create(), /创建结果尚未确认/); assert.equal(f.postCount, 1);
});

test('损坏的凭据 JSON 不把原始内容泄露到错误', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDirectory, 'yunxiao-credentials.json'), 'fixture-secret-invalid-json');
  await assert.rejects(f.prepare(), error => /格式无效/.test(String(error)) && !String(error).includes('fixture-secret'));
  assert.equal(f.calls.length, 0);
});

for (const pageSize of [100, 20]) {
  test(`重复检查读取第二页，兼容平台实际每页 ${pageSize} 条`, async t => {
    const f = await fixture(t); const pages: number[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/changeRequests') && init?.method === 'GET') {
        const page = Number(target.searchParams.get('page')); pages.push(page);
        return Response.json(page === 1 ? Array.from({ length: pageSize }, (_, i) => ({ ...f.request(), localId: i + 100, sourceBranch: `feature/other-${i}` })) : [f.request()],
          { headers: { 'x-next-page': String(page + 1), 'x-total-pages': '2', 'x-per-page': String(pageSize) } });
      }
      return f.options.fetcher(url, init);
    };
    const result = await prepareProjectMergeRequest(f.input, { ...f.options, fetcher });
    assert.equal(result.existing?.id, 12); assert.deepEqual(pages, [1, 2]); assert.equal(f.postCount, 0);
  });
}

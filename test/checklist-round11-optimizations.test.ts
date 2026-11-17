import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { ProjectsData } from '../shared/hub.js';
import {
  executePortAction,
  parsePsProcesses,
  verifyPortActionTargetPid,
} from '../server/port-monitor.js';
import {
  createProjectWorkspaces,
  type ProjectWorkspaceOptions,
} from '../server/project-workspaces.js';
import { createJenkinsDeployments } from '../server/jenkins-deployments.js';
import { createYunxiaoDeployments } from '../server/yunxiao-deployments.js';
import {
  createProjectMergeRequest,
  listProjectMergeRequests,
  prepareProjectMergeRequest,
} from '../server/project-merge-request.js';

const exec = promisify(execFile);

test('Round 11 · P0-5 & P1-20b：端口管理执行前实时复核 PID/端口/命令行归属，且状态文件绝不明文落盘敏感命令行参数', async (t: TestContext) => {
  // 1. 纯逻辑复核：拦截未监听目标端口的过期/伪造 PID 与命令行漂移
  const processes = parsePsProcesses(
    '300 1 tester node /work/app/vite.js --port 5173\n'
    + '301 300 tester node /work/app/worker.js\n'
    + '888 1 tester postgres -D /usr/local/var/postgres\n',
  );
  const listeners = [
    { pid: 301, process: 'node', address: '127.0.0.1', port: 5173 },
    { pid: 888, process: 'postgres', address: '127.0.0.1', port: 5432 },
  ];

  // 父进程 300 派生了监听 5173 的子进程 301 -> 校验通过
  const matched = verifyPortActionTargetPid(300, 5173, { listeners, processes }, 'node /work/app/vite.js --port 5173');
  assert.equal(matched.port, 5173);

  // 伪造/已退出复用的 PID 999 未监听 5173 -> 拒绝终止
  assert.throws(
    () => verifyPortActionTargetPid(999, 5173, { listeners, processes }),
    /当前未监听端口 5173/,
  );

  // 把数据库 PID 888 当作端口 5173 传入 -> 拒绝终止
  assert.throws(
    () => verifyPortActionTargetPid(888, 5173, { listeners, processes }),
    /当前未监听端口 5173/,
  );

  // 同端口但命令行已变成完全不同的进程 -> 拒绝终止
  assert.throws(
    () => verifyPortActionTargetPid(888, 5432, { listeners, processes }, 'node /work/app/vite.js'),
    /实际命令行已变化/,
  );

  // 2. 真实子进程测试：停止带 --token 敏感参数的独立服务后，磁盘状态文件 0600 且绝不含明文密钥；非项目进程禁止自动重启
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r11-port-')));
  const scriptPath = path.join(tempDir, 'dev-server.mjs');
  await fs.writeFile(
    scriptPath,
    `import http from 'node:http';
const srv = http.createServer((_req, res) => res.end('ok'));
srv.listen(0, '127.0.0.1', () => process.send?.({ port: srv.address().port }));
`,
    'utf8',
  );

  const inlineSecret = 'super_inline_tok_r11_secret';
  const child = spawn(process.execPath, [scriptPath, '--token', inlineSecret], {
    cwd: tempDir,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    try { child.kill('SIGKILL'); } catch { /* exited */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    child.once('message', msg => resolve((msg as { port: number }).port));
    child.once('error', reject);
  });

  // 尝试传错误端口停止该 PID -> 被实时复核拦截，原服务毫发无损
  await assert.rejects(
    () => executePortAction({ action: 'stop', pid: child.pid!, port: boundPort === 65000 ? 65001 : 65000 }, { dataDir: tempDir, root: tempDir }),
    /当前未监听端口/,
  );
  assert.equal(await (await fetch(`http://127.0.0.1:${boundPort}`)).text(), 'ok');

  // 正确停止服务后核验磁盘状态文件脱敏与 0600 权限
  const stopRes = await executePortAction(
    { action: 'stop', pid: child.pid!, port: boundPort, cwd: tempDir },
    { dataDir: tempDir, root: tempDir },
  );
  assert.equal(stopRes.ok, true);

  const persistedPath = path.join(tempDir, 'port-monitor-state.json');
  const persistedText = await fs.readFile(persistedPath, 'utf8');
  assert.equal(persistedText.includes(inlineSecret), false, '磁盘状态文件严禁落盘明文命令行密钥');
  assert.match(persistedText, /\[redacted\]/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(persistedPath)).mode & 0o777, 0o600);
  }
});

test('Round 11 · P0-6：工作区删除识别被 .gitignore 忽略的敏感文件、移入 7 天可恢复回收站并支持一键恢复与排程退避冻结', async (t: TestContext) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r11-ws-')));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const stateDir = path.join(root, 'state');
  const git = async (folder: string, ...args: string[]) =>
    (await exec('git', ['-C', folder, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();

  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.mkdir(repo);
  await git(root, 'init', '--bare', remote);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'r11@localhost');
  await git(repo, 'config', 'user.name', 'Round11');
  await fs.writeFile(path.join(repo, '.gitignore'), '.env*\nnode_modules/\ndist/\n', 'utf8');
  await fs.writeFile(path.join(repo, 'index.ts'), 'export const ok = true;\n', 'utf8');
  await git(repo, 'add', '.gitignore', 'index.ts');
  await git(repo, 'commit', '-m', 'feat: init with gitignore');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  // 写入被 .gitignore 忽略的 .env.local 与 node_modules 缓存
  await fs.writeFile(path.join(repo, '.env.local'), 'LOCAL_CUSTOM_TOKEN=preserve-me\n', 'utf8');
  await fs.mkdir(path.join(repo, 'node_modules', 'demo'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules', 'demo', 'index.js'), 'module.exports = 1;\n', 'utf8');

  let clock = Date.parse('2026-11-16T02:00:00.000Z');
  const known = new Set([repo]);
  const options: ProjectWorkspaceOptions = {
    readProjects: async () => ({ projects: [...known].map(p => ({ path: p })) }) as ProjectsData,
    withWorkspace: async (_folder, _owner, action) => action(),
    checkBusy: async () => {},
    canRun: () => true,
    protectedPaths: [stateDir],
    now: () => clock,
    intervalMs: 60_000,
  };

  const service = await createProjectWorkspaces(stateDir, options);
  t.after(() => service.close());

  // 1. 预览忽略 node_modules 噪音，但精准识别 .env.local 敏感忽略文件并要求显式确认
  const prev = await service.preview(repo);
  assert.deepEqual(prev.ignoredFiles, ['.env.local']);
  assert.deepEqual(prev.sensitiveIgnoredFiles, ['.env.local']);
  assert.equal(prev.eligible, false);
  assert.equal(prev.requiresDiscardChanges, true);
  assert.match(prev.reason || '', /\.env\.local/);

  // 未传 discardChanges 时拒绝删除，防止无感丢失 .env.local
  await assert.rejects(
    () => service.remove({ path: repo, revision: prev.revision, confirmName: 'repo' }),
    /\.env\.local/,
  );

  // 2. 生产级定时排程退避与超过 24 小时自动冻结保护
  await service.schedule({
    path: repo,
    revision: prev.revision,
    confirmName: 'repo',
    deleteAt: new Date(clock + 60_000).toISOString(),
  });
  clock += 120_000;
  service.start();
  // 等待首次到期检查将状态置为 blocked
  for (let i = 0; i < 40 && service.list()[0]?.status !== 'blocked'; i++) {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(service.list()[0]?.status, 'blocked');
  // 推进超过 24 小时再次触发 -> 自动冻结不再盲目重试
  clock += 25 * 60 * 60 * 1000;
  await service.close();
  const reloaded = await createProjectWorkspaces(stateDir, options);
  t.after(() => reloaded.close());
  reloaded.start();
  for (let i = 0; i < 40 && !/超过 24 小时/.test(reloaded.list()[0]?.message || ''); i++) {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.match(reloaded.list()[0]?.message || '', /超过 24 小时/);

  // 3. 显式确认删除 -> 移入隔离回收区而非永久擦除，一键恢复后 .env.local 完好无损！
  const freshPrev = await reloaded.preview(repo);
  await reloaded.remove({
    path: repo,
    revision: freshPrev.revision,
    confirmName: 'repo',
    discardChanges: true,
  });
  await assert.rejects(() => fs.stat(repo));

  const trashItems = await reloaded.listTrash();
  assert.equal(trashItems.length, 1);
  assert.deepEqual(trashItems[0]?.ignoredFiles, ['.env.local']);

  const restored = await reloaded.restoreTrash({ id: trashItems[0]!.id });
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredPath, repo);
  assert.equal(await fs.readFile(path.join(repo, '.env.local'), 'utf8'), 'LOCAL_CUSTOM_TOKEN=preserve-me\n');
  assert.equal((await reloaded.listTrash()).length, 0);
});

test('Round 11 · P1-17：Jenkins 与云效部署 4xx 明确判败、队列 404 按 queueId 自动回查构建号，并支持人工解除卡死记录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r11-deploy-'));
  try {
    const baseUrl = 'https://jenkins.example.test';
    const jobName = 'ops/order-api';
    const jobPath = '/job/ops/job/order-api';
    const projectId = 'gitlab.example.test:ops/order-api';
    let postStatus = 403;
    let queue404 = true;

    const jenkinsFetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        if (postStatus !== 201) return new Response('Forbidden', { status: postStatus });
        return new Response('', { status: 201, headers: { location: `${baseUrl}/queue/item/95/` } });
      }
      if (url.pathname === `${jobPath}/api/json`) {
        if (url.searchParams.get('tree')?.startsWith('builds[')) {
          return Response.json({
            builds: [{ number: 38, queueId: 95, url: `${baseUrl}${jobPath}/38/` }],
          });
        }
        return Response.json({ fullName: jobName, name: 'order-api', buildable: true, property: [] });
      }
      if (url.pathname === '/queue/item/95/api/json' && queue404) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.pathname === `${jobPath}/38/api/json`) {
        return Response.json({ number: 38, queueId: 95, building: false, result: 'SUCCESS', url: `${baseUrl}${jobPath}/38/` });
      }
      return new Response('Not Found', { status: 404 });
    };

    const jenkins = await createJenkinsDeployments(path.join(dir, 'jenkins'), {
      readProjects: async () => ({
        projects: [{ projectId, displayName: '订单服务', suggestedDisplayName: '', projectName: 'order-api', repository: 'ops/order-api', path: '/repos/order', branch: 'main' }] as ProjectsData['projects'],
      }),
      credentialsPath: path.join(dir, 'jenkins-creds.json'),
      fetcher: jenkinsFetcher,
      pollIntervalMs: 0,
    });
    await jenkins.saveConfig({ baseUrl, username: 'ops', token: 'tok-r11' });
    const binding = await jenkins.saveBinding({ projectId, environment: '生产', jobFullName: jobName });

    // 1. Jenkins 明确返回 HTTP 403 时直接判为 failed，不锁死在 unknown
    const rejectedRun = await jenkins.startRun({ bindingId: binding.id, requestId: randomUUID(), parameters: {} });
    assert.equal(rejectedRun.status, 'failed');
    assert.equal(rejectedRun.result, 'HTTP_403');

    // 2. 无需勾选 acknowledgeUnknown 即可正常重新发起；当 /queue/item/95 返回 404 时自动从 builds 回查 #38 并收敛为 success
    postStatus = 201;
    const queuedRun = await jenkins.startRun({ bindingId: binding.id, requestId: randomUUID(), parameters: {} });
    assert.equal(queuedRun.status, 'queued');
    const recoveredRun = await jenkins.getRun(queuedRun.id);
    assert.equal(recoveredRun.status, 'success');
    assert.equal(recoveredRun.buildNumber, 38);
    assert.equal(jenkins.isIdle(), true);

    // 3. 若某次构建远端彻底被删（404 无对应 build），可通过 resolveRun 人工解除卡死，恢复 isIdle()
    const stuckRun = await jenkins.startRun({ bindingId: binding.id, requestId: randomUUID(), parameters: {} });
    // 修改 queueId 使 builds 回查不到，模拟构建被彻底清理
    queue404 = true;
    const resolved = await jenkins.resolveRun({ id: stuckRun.id, resolution: 'cancelled', note: '远端队列已人工清理' });
    assert.equal(resolved.status, 'cancelled');
    assert.equal(resolved.result, 'MANUAL_CANCELLED');
    assert.equal(jenkins.isIdle(), true);
    await jenkins.close();

    // 4. 云效同样支持 4xx 判败与 resolveRun 人工解除
    const yunxiaoDir = path.join(dir, 'yunxiao');
    await fs.mkdir(yunxiaoDir, { recursive: true });
    const yxRepo = 'cccccccccccccccccccccccc/team/order-api';
    const yxProjId = `codeup.aliyun.com:${yxRepo}`;
    await fs.writeFile(
      path.join(yunxiaoDir, 'yunxiao-deployments.json'),
      JSON.stringify([{
        id: yxProjId,
        name: '订单服务',
        repository: yxRepo,
        projectUrl: `https://codeup.aliyun.com/${yxRepo}/pipeline`,
        environments: [{ environment: 'pre', name: '预发流水线', url: 'https://flow.aliyun.com/pipelines/555/current' }],
      }]),
    );
    let yxPostMode: 400 | 'ok' = 400;
    const yunxiao = await createYunxiaoDeployments(yunxiaoDir, {
      pollIntervalMs: 0,
      fetcher: (async (input, init) => {
        if (init?.method === 'POST') {
          return yxPostMode === 400
            ? Response.json({ errorMessage: 'InvalidBranch' }, { status: 400 })
            : Response.json(88);
        }
        return Response.json({
          name: '预发流水线',
          pipelineConfig: { sources: [{ data: { repo: `https://codeup.aliyun.com/${yxRepo}.git`, branch: 'main' } }] },
        });
      }) as typeof fetch,
    });
    await yunxiao.saveConfig({ token: 'yx-tok-r11' });
    const yxRejected = await yunxiao.startRun({ projectId: yxProjId, environment: 'pre', requestId: randomUUID(), branches: {} });
    assert.equal(yxRejected.status, 'failed');
    assert.equal(yxRejected.result, 'HTTP_400');

    yxPostMode = 'ok';
    const yxQueued = await yunxiao.startRun({ projectId: yxProjId, environment: 'pre', requestId: randomUUID(), branches: {} });
    assert.equal(yxQueued.status, 'queued');
    assert.equal(yunxiao.isIdle(), false);
    const yxResolved = await yunxiao.resolveRun({ id: yxQueued.id, resolution: 'failed', note: '云效侧已手动终止' });
    assert.equal(yxResolved.status, 'failed');
    assert.equal(yunxiao.isIdle(), true);
    await yunxiao.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Round 11 · 第四节 #10：GitHub 与自托管 GitLab（含 providerOverride 显式指定）支持原生 API 列表查询、准备、创建与回读核对', async (t: TestContext) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r11-mr-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const dataDirectory = path.join(root, 'data');
  const git = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args])).stdout.trim();

  await fs.mkdir(repo);
  await fs.mkdir(dataDirectory);
  await git(repo, 'init', '-qb', 'main');
  await git(repo, 'config', 'user.name', 'Round11 MR');
  await git(repo, 'config', 'user.email', 'mr@localhost');
  await fs.writeFile(path.join(repo, 'app.ts'), 'export const v = 1;\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'feat: base');
  await git(root, 'init', '--bare', '-q', remote);
  await git(repo, 'push', '-q', remote, 'main');
  await git(repo, 'switch', '-qc', 'feat/api-mr');
  await fs.writeFile(path.join(repo, 'mr.ts'), 'export const mr = true;\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'feat: add mr support');
  await git(repo, 'push', '-q', remote, 'HEAD:refs/heads/feat/api-mr');

  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o700 });
  await git(repo, 'config', 'core.sshCommand', ssh);
  await git(repo, 'config', 'ssh.variant', 'ssh');
  await git(repo, 'remote', 'add', 'github', 'git@github.com:acme/workbench.git');
  // 自托管内网域名不含 "gitlab" 关键字，验证 providerOverride: 'GitLab'
  await git(repo, 'remote', 'add', 'corp', 'git@code.corp.internal:platform/sub/workbench.git');

  await fs.writeFile(path.join(dataDirectory, 'github-credentials.json'), JSON.stringify({ token: 'gh-pat-fixture-r11' }));
  await fs.writeFile(path.join(dataDirectory, 'gitlab-credentials.json'), JSON.stringify({ token: 'gl-pat-fixture-r11' }));

  let ghPulls: unknown[] = [];
  let glMrs: unknown[] = [];

  const fetcher: typeof fetch = async (urlRaw, init) => {
    const url = new URL(String(urlRaw));
    const method = init?.method || 'GET';
    const headers = new Headers(init?.headers);

    if (url.origin === 'https://api.github.com') {
      assert.equal(headers.get('authorization'), 'Bearer gh-pat-fixture-r11');
      if (method === 'POST' && url.pathname === '/repos/acme/workbench/pulls') {
        const body = JSON.parse(String(init?.body));
        const created = {
          number: 77,
          html_url: 'https://github.com/acme/workbench/pull/77',
          title: body.title,
          state: 'open',
          user: { login: 'octocat' },
          head: { ref: body.head, repo: { full_name: 'acme/workbench' } },
          base: { ref: body.base, repo: { full_name: 'acme/workbench' } },
        };
        ghPulls = [created];
        return Response.json(created, { status: 201 });
      }
      if (url.pathname === '/repos/acme/workbench/pulls/77') {
        return Response.json(ghPulls[0]);
      }
      if (url.pathname === '/repos/acme/workbench/pulls') {
        return Response.json(ghPulls);
      }
    }

    if (url.origin === 'https://code.corp.internal') {
      assert.equal(headers.get('private-token'), 'gl-pat-fixture-r11');
      if (method === 'POST' && url.pathname === '/api/v4/projects/platform%2Fsub%2Fworkbench/merge_requests') {
        const body = JSON.parse(String(init?.body));
        const created = {
          iid: 204,
          web_url: 'https://code.corp.internal/platform/sub/workbench/-/merge_requests/204',
          title: body.title,
          state: 'opened',
          source_branch: body.source_branch,
          target_branch: body.target_branch,
          author: { name: '王工', username: 'wang' },
        };
        glMrs = [created];
        return Response.json(created, { status: 201 });
      }
      if (url.pathname === '/api/v4/projects/platform%2Fsub%2Fworkbench/merge_requests/204') {
        return Response.json(glMrs[0]);
      }
      if (url.pathname === '/api/v4/projects/platform%2Fsub%2Fworkbench/merge_requests') {
        return Response.json(glMrs);
      }
    }

    return new Response('Unexpected URL', { status: 500 });
  };

  // 1. GitHub API 闭环：prepare -> create -> readback -> list
  const ghPrep = await prepareProjectMergeRequest(
    { path: repo, remote: 'github', sourceBranch: 'feat/api-mr', targetBranch: 'main' },
    { dataDirectory, fetcher },
  );
  assert.equal(ghPrep.provider, 'GitHub');
  assert.equal(ghPrep.mode, 'api');
  assert.equal(ghPrep.canCreate, true);

  const ghCreated = await createProjectMergeRequest(
    {
      path: repo,
      remote: 'github',
      sourceBranch: 'feat/api-mr',
      targetBranch: 'main',
      title: 'feat: GitHub native PR creation',
      revision: ghPrep.revision,
      expectedSourceSha: ghPrep.sourceSha,
      expectedTargetSha: ghPrep.targetSha,
    },
    { dataDirectory, fetcher },
  );
  assert.equal(ghCreated.created, true);
  assert.equal(ghCreated.request.id, 77);
  assert.equal(ghCreated.request.url, 'https://github.com/acme/workbench/pull/77');

  const ghListed = await listProjectMergeRequests({ path: repo, remote: 'github' }, { dataDirectory, fetcher });
  assert.equal(ghListed.requests.length, 1);
  assert.equal(ghListed.requests[0]?.author, 'octocat');

  // 2. 自托管 GitLab（域名不含 gitlab）通过 providerOverride: 'GitLab' 走 API 闭环
  const glPrep = await prepareProjectMergeRequest(
    { path: repo, remote: 'corp', providerOverride: 'GitLab', sourceBranch: 'feat/api-mr', targetBranch: 'main' },
    { dataDirectory, fetcher },
  );
  assert.equal(glPrep.provider, 'GitLab');
  assert.equal(glPrep.mode, 'api');
  assert.equal(glPrep.canCreate, true);

  const glCreated = await createProjectMergeRequest(
    {
      path: repo,
      remote: 'corp',
      providerOverride: 'GitLab',
      sourceBranch: 'feat/api-mr',
      targetBranch: 'main',
      title: 'feat: Self-hosted GitLab MR creation',
      revision: glPrep.revision,
      expectedSourceSha: glPrep.sourceSha,
      expectedTargetSha: glPrep.targetSha,
    },
    { dataDirectory, fetcher },
  );
  assert.equal(glCreated.created, true);
  assert.equal(glCreated.request.id, 204);
  assert.equal(glCreated.request.url, 'https://code.corp.internal/platform/sub/workbench/-/merge_requests/204');

  const glListed = await listProjectMergeRequests(
    { path: repo, remote: 'corp', providerOverride: 'GitLab' },
    { dataDirectory, fetcher },
  );
  assert.equal(glListed.requests.length, 1);
  assert.equal(glListed.requests[0]?.author, '王工');
});

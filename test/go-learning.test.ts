import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGoLearningService } from '../server/go-learning.js';
import { createGoLearningRoutes } from '../server/go-learning-routes.js';
import { workspaceLocation, workspaceView } from '../src/pages/agent/workspace-navigation.js';

test('Go 实训工坊导航入口与路由映射正确', () => {
  const view = workspaceView('go-studio');
  assert.ok(view);
  assert.equal(view.label, 'Go 实训工坊');
  assert.deepEqual(workspaceLocation('/go-studio', { day: '3' }), {
    path: '/agent',
    query: { day: '3', view: 'go-studio' },
  });
});

test('Go 实训工坊服务端支持 7 天课程读取、进度保存、沙盒快照切换、命令运行与 HTTP 调试', async t => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'go-learning-test-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  let courseListening = false;
  let liveRequests = 0;
  t.mock.method(globalThis, 'fetch', async (resource: string | URL, init?: RequestInit) => {
    const url = new URL(resource);
    assert.equal(url.origin, 'http://127.0.0.1:8080');
    if (url.pathname === '/__go-learning/health') {
      return courseListening ? new Response(null, { status: 204, headers: { 'X-Delivery-Go-Learning': 'taskmgr' } })
        : new Response('普通服务');
    }
    liveRequests++;
    assert.equal(url.pathname, '/tasks');
    assert.equal(init?.redirect, 'manual');
    return new Response('课件返回', { status: 302, headers: { Location: 'https://example.test' } });
  });
  const stateDir = path.join(tmpRoot, '.data', 'go-learning');
  const docsDir = path.join(tmpRoot, 'work', 'go-learning-docs', 'docs');
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'work', 'go-learning-docs', 'README.md'),
    '# 《7 天上手 Go》通俗图解导读\n\n测试导读内容',
    'utf8'
  );
  await fs.writeFile(
    path.join(docsDir, 'Day1-环境与基本语法.md'),
    '## 第 1 天：环境与基本语法\n\n> ### 💡 本日大白话速懂卡片\n> 测试速懂卡片\n\n### 1. 学习目标\n测试正文\n\n#### 第 1 天练习参考答案\n\n```go\npackage main\n```',
    'utf8'
  );

  const service = await createGoLearningService(stateDir, { rootDir: tmpRoot });
  const overview1 = await service.overview();
  assert.equal(overview1.days.length, 7);
  assert.equal(overview1.progress.currentDay, 1);
  assert.ok(overview1.sandboxFiles.some(f => f.path === 'main.go'));
  assert.ok(overview1.currentDayDetail.cardMarkdown.includes('测试速懂卡片'));
  assert.equal((await service.overview(5)).progress.currentDay, 5);
  assert.match((await service.getDay(6)).dayDetail.tutorialMarkdown, /练习步骤/);
  assert.equal((await service.overview()).progress.currentDay, 1);

  // 1. Update checklist, exercise & note
  const updatedProgress = await service.updateProgress({
    currentDay: 3,
    toggleChecklistId: 'd3-c1',
    toggleExerciseId: 'd3-e1',
    note: { day: 3, content: '记住：首字母大写代表导出 Public' },
  });
  assert.equal(updatedProgress.currentDay, 3);
  assert.ok(updatedProgress.checkedItems.includes('d3-c1'));
  assert.ok(updatedProgress.completedExercises.includes('d3-e1'));
  assert.equal(updatedProgress.notes['3'], '记住：首字母大写代表导出 Public');

  // 2. Switch sandbox snapshot to day7-graduation
  await service.applySnapshot('day7-graduation');
  const sandboxAfterSwitch = await service.readSandboxFiles();
  assert.ok(sandboxAfterSwitch.files.some(f => f.path === 'task/task.go'));
  assert.ok(sandboxAfterSwitch.files.some(f => f.path === 'server/server.go'));
  const serverGo = sandboxAfterSwitch.files.find(f => f.path === 'server/server.go')!;
  assert.ok(serverGo.content.includes('ListByStatus'));
  assert.ok(serverGo.content.includes('GET /__go-learning/health'));
  assert.match(sandboxAfterSwitch.files.find(f => f.path === 'main.go')!.content, /127\.0\.0\.1:8080/);

  // 3. Reject path traversal on saveSandboxFile
  await assert.rejects(
    () => service.saveSandboxFile('../escaped.go', 'package main'),
    /不允许访问沙盒目录之外的文件/
  );
  const outsideFile = path.join(tmpRoot, 'fixture.go');
  await fs.writeFile(outsideFile, '不可被沙盒覆盖');
  await fs.symlink(outsideFile, path.join(overview1.sandboxPath, 'linked.go'));
  await assert.rejects(() => service.saveSandboxFile('linked.go', 'package main'), /普通文件/);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), '不可被沙盒覆盖');
  if (overview1.environment.installed) await assert.rejects(() => service.runCommand('run'), /移除沙盒中的符号链接/);
  await fs.unlink(path.join(overview1.sandboxPath, 'linked.go'));

  // 4. Run a local fixture without inheriting a Workbench environment variable.
  await service.applySnapshot('day1');
  await service.saveSandboxFile('main.go', 'package main\nimport ("fmt"; "os")\nfunc main(){ fmt.Println(os.Getenv("DELIVERY_GO_FIXTURE_TOKEN") == "") }\n');
  const previous = process.env.DELIVERY_GO_FIXTURE_TOKEN;
  process.env.DELIVERY_GO_FIXTURE_TOKEN = 'fixture-value';
  t.after(() => {
    if (previous === undefined) delete process.env.DELIVERY_GO_FIXTURE_TOKEN;
    else process.env.DELIVERY_GO_FIXTURE_TOKEN = previous;
  });
  const runRes = await service.runCommand('run');
  assert.equal(runRes.exitCode, 0, runRes.stderr);
  assert.ok(runRes.stdout.length > 0);
  if (!runRes.simulated) assert.equal(runRes.stdout, 'true');

  // 5. HTTP Mini-Debugger end-to-end CRUD + filter validation
  const createRes = await service.debugHttpEndpoint({
    method: 'POST',
    path: '/tasks',
    body: JSON.stringify({ title: '测试 Go 实训工坊接口' }),
  });
  assert.equal(createRes.status, 201);
  assert.ok(createRes.tasksJsonContent?.includes('测试 Go 实训工坊接口'));

  const badCreate = await service.debugHttpEndpoint({
    method: 'POST',
    path: '/tasks',
    body: JSON.stringify({ title: '   ' }),
  });
  assert.equal(badCreate.status, 400);

  const patchRes = await service.debugHttpEndpoint({
    method: 'PATCH',
    path: '/tasks/1/done',
  });
  assert.equal(patchRes.status, 200);
  assert.ok(JSON.parse(patchRes.responseBody).done === true);

  const filterDone = await service.debugHttpEndpoint({
    method: 'GET',
    path: '/tasks?done=true',
  });
  assert.equal(filterDone.status, 200);
  assert.equal(JSON.parse(filterDone.responseBody).length, 1);

  const filterInvalid = await service.debugHttpEndpoint({
    method: 'GET',
    path: '/tasks?done=invalid',
  });
  assert.equal(filterInvalid.status, 400);

  const deleteRes = await service.debugHttpEndpoint({
    method: 'DELETE',
    path: '/tasks/1',
  });
  assert.equal(deleteRes.status, 200);
  assert.equal(liveRequests, 0);
  courseListening = true;
  const live = await service.debugHttpEndpoint({ method: 'GET', path: '/tasks' });
  assert.equal(live.mode, 'live-server');
  assert.equal(live.status, 302);
  assert.equal(liveRequests, 1);

  // 6. Verify HTTP Route handler wrapper
  let lastStatus = 0;
  let lastBody: unknown;
  const routes = createGoLearningRoutes(service, {
    port: 5199,
    json: (_res, status, value) => {
      lastStatus = status;
      lastBody = value;
    },
    body: async () => ({ toggleChecklistId: 'd3-c2' }),
  });

  const headers = { host: 'localhost:5199', origin: 'http://localhost:5199', 'x-delivery-confirmed': 'yes',
    'content-type': 'application/json' };
  const request = (method: string, resource: string, change?: Record<string, string>, remoteAddress = '127.0.0.1') => routes({
    method, headers: { ...headers, ...change }, socket: { remoteAddress },
  } as unknown as IncomingMessage, {} as ServerResponse, new URL(`http://localhost:5199/api/go-learning/${resource}`));
  assert.equal(await request('POST', 'progress', { origin: 'http://127.0.0.1:5199' }), true);
  assert.equal(lastStatus, 403);
  await request('POST', 'progress', { 'x-delivery-confirmed': '' });
  assert.equal(lastStatus, 403);
  await request('POST', 'progress', { 'content-type': 'text/plain' });
  assert.equal(lastStatus, 415);
  await request('GET', 'overview', undefined, '192.0.2.1');
  assert.equal(lastStatus, 403);
  assert.equal(await request('POST', 'progress'), true);
  assert.equal(lastStatus, 200);
  assert.ok((lastBody as { progress: { checkedItems: string[] } }).progress.checkedItems.includes('d3-c2'));

});

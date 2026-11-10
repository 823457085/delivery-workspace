import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createYunxiaoDeployments } from '../server/yunxiao-deployments.js';

const repository = 'aaaaaaaaaaaaaaaaaaaaaaaa/demo-project/demo';
const projectId = `codeup.aliyun.com:${repository}`;
const repo = `https://codeup.aliyun.com/${repository}.git`;
const target = { projectId, environment: 'pre' };
async function fixture(t: { after(callback: () => Promise<void>): void }, dispatchFails = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-deploy-test-'));
  await fs.writeFile(path.join(directory, 'yunxiao-deployments.json'), JSON.stringify([{ id: projectId, name: '测试项目', repository,
    projectUrl: `https://codeup.aliyun.com/${repository}/pipeline`, environments: [{ environment: 'pre', name: '接口流水线名称', url: 'https://flow.aliyun.com/pipelines/123/current' }] }]));
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let status = 'RUNNING', wrongId = false, logContent = '构建中 L_RAW fixture-pat\n';
  const fetcher = (async (input, init) => {
    const url = String(input), method = init?.method || 'GET';
    assert.equal(new Headers(init?.headers).get('x-yunxiao-token'), 'fixture-pat');
    assert.equal(init?.redirect, 'error');
    assert.match(url, /^https:\/\/openapi-rdc.aliyuncs.com\/oapi\/v1\/flow\/organizations\/aaaaaaaaaaaaaaaaaaaaaaaa\/pipelines\/123/);
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST') {
      if (dispatchFails) throw new Error('fixture-pat socket interrupted');
      return Response.json(42);
    }
    if (url.endsWith('/runs/42/job/7/log')) return Response.json({ content: logContent, last: 17, more: false });
    if (url.endsWith('/runs/42')) return Response.json({ pipelineId: wrongId ? 999 : 123, pipelineRunId: 42, status,
      stages: [{ name: '接口阶段名称', stageInfo: { status, jobs: [{ id: 7, name: '构建任务', status }] } }] });
    return Response.json({ name: '接口流水线名称', pipelineConfig: { sources: [{ data: { repo, branch: 'pre' } }] } });
  }) as typeof fetch;
  let service = await createYunxiaoDeployments(directory, { fetcher, pollIntervalMs: 0 });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, calls, get service() { return service; }, setStatus(value: string) { status = value; }, mismatch() { wrongId = true; },
    setLogContent(value: string) { logContent = value; },
    async restart() { await service.close(); service = await createYunxiaoDeployments(directory, { fetcher, pollIntervalMs: 0 }); return service; } };
}

test('未配置凭据不能运行；仅允许已关联环境；凭据只写本机私有文件并不回传', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.snapshot(), { config: { hasToken: false }, runs: [] });
  await assert.rejects(f.service.prepare(target), /个人访问令牌/);
  assert.equal(f.calls.length, 0);
  await f.service.saveConfig({ token: 'fixture-pat' });
  assert.equal((await fs.stat(path.join(f.directory, 'yunxiao-credentials.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await f.service.snapshot()).config, { hasToken: true });
  assert.equal(JSON.stringify(await f.service.snapshot()).includes('fixture-pat'), false);
  await assert.rejects(f.service.prepare({ ...target, environment: 'prod' }), /尚未关联/);
  assert.deepEqual(await f.service.prepare(target), { name: '接口流水线名称', sources: [{ repo, branch: 'pre' }] });
  await assert.rejects(f.service.startRun({ ...target, requestId: randomUUID(), branches: { 'https://evil.test/repo': 'master' } }), /未定义的代码源/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('确认部署使用真实参数与运行ID，幂等且禁止活跃环境重复发布，精确轮询并保留阶段原文', async t => {
  const f = await fixture(t); await f.service.saveConfig({ token: 'fixture-pat' });
  const input = { ...target, requestId: randomUUID(), branches: { [repo]: 'feature/demo' } };
  const run = await f.service.startRun(input);
  assert.equal(run.pipelineRunId, '42'); assert.equal(run.status, 'queued');
  assert.deepEqual(f.calls.find(call => call.method === 'POST')?.body, { params: JSON.stringify({ runningBranchs: { [repo]: 'feature/demo' } }) });
  assert.deepEqual(await f.service.startRun(input), run);
  await assert.rejects(f.service.startRun({ ...input, requestId: randomUUID() }), /已有云效部署/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const running = await f.service.getRun(run.id);
  assert.equal(running.status, 'running'); assert.equal(running.result, 'RUNNING');
  assert.deepEqual(running.steps, [{ name: '接口阶段名称', status: 'RUNNING' }, { name: '构建任务', status: 'RUNNING', jobId: '7' }]);
  f.mismatch(); f.setStatus('SUCCESS');
  assert.equal((await f.service.getRun(run.id)).status, 'running');
  assert.match((await f.service.getRun(run.id)).error || '', /不匹配/);
});

test('重启只恢复运行查询，只有明确SUCCESS才成功，未知状态不误报完成', async t => {
  const f = await fixture(t); await f.service.saveConfig({ token: 'fixture-pat' });
  const run = await f.service.startRun({ ...target, requestId: randomUUID(), branches: {} });
  await f.restart();
  f.setStatus('WAITING_APPROVAL'); assert.equal((await f.service.getRun(run.id)).status, 'unknown');
  f.setStatus('SUCCESS'); assert.equal((await f.service.getRun(run.id)).status, 'success');
  assert.equal(f.service.isIdle(), true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('提交中断不重试，不暴露令牌；未知结果要求人工核对后才能重新发起', async t => {
  const f = await fixture(t, true); await f.service.saveConfig({ token: 'fixture-pat' });
  const input = { ...target, requestId: randomUUID(), branches: {} };
  const run = await f.service.startRun(input);
  assert.equal(run.status, 'unknown'); assert.equal(run.error?.includes('fixture-pat'), false);
  await f.service.startRun(input);
  await assert.rejects(f.service.startRun({ ...input, requestId: randomUUID() }), /勿重复提交/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await f.restart(); assert.equal((await f.service.snapshot()).runs[0]?.status, 'unknown');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('云效手动添加保存本机地址与自定义环境，保留其他映射且不请求部署', async t => {
  const f = await fixture(t);
  const input = { projectId, environment: '联调环境', url: 'https://flow.aliyun.com/pipelines/456/current/' };
  const saved = await f.service.saveManualBinding(input);
  assert.equal(saved.environment, '联调环境');
  assert.equal(saved.url, 'https://flow.aliyun.com/pipelines/456/current');
  assert.deepEqual(await f.service.saveManualBinding(input), saved);
  const links = await f.service.links();
  assert.equal(links[0]?.environments.length, 2);
  assert.equal(links[0]?.environments[0]?.name, '接口流水线名称');
  assert.equal((await fs.stat(path.join(f.directory, 'yunxiao-deployments.json'))).mode & 0o777, 0o600);
  await assert.rejects(f.service.saveManualBinding({ ...input, url: 'https://flow.aliyun.com/pipelines/999/current' }), /已关联其他/);
  for (const url of ['https://evil.test/pipelines/456/current', 'https://flow.aliyun.com/pipelines/456/current?token=fixture',
    'https://name:secret@flow.aliyun.com/pipelines/456/current', 'https://flow.aliyun.com/pipelines/456/current#token']) {
    await assert.rejects(f.service.saveManualBinding({ ...input, environment: '非法地址', url }));
  }
  await assert.rejects(f.service.saveManualBinding({ ...input, projectId: 'codeup.aliyun.com:unknown/repo' }), /Codeup 项目/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.snapshot()).runs.length, 0);
});

test('云效首次映射仅接收真实 Codeup 项目身份，不允许请求伪造仓库', async t => {
  const f = await fixture(t);
  const repository = 'bbbbbbbbbbbbbbbbbbbbbbbb/project/new-app';
  const localProject = { id: `codeup.aliyun.com:${repository}`, name: '本机项目', repository, paths: [], branches: [] };
  const input = { projectId: localProject.id, environment: 'test', url: 'https://flow.aliyun.com/pipelines/789/current' };
  await f.service.saveManualBinding(input, localProject);
  assert.equal((await f.service.links()).find(project => project.id === localProject.id)?.projectUrl, `https://codeup.aliyun.com/${repository}/pipeline`);
  await assert.rejects(f.service.saveManualBinding({ ...input, projectId: 'gitlab.test:project/new-app' }, { ...localProject, id: 'gitlab.test:project/new-app' }), /Codeup 项目/);
  assert.equal(f.calls.length, 0);
});

test('终态旧记录补取一次任务编号，日志只读取该次运行的已知任务并脱敏', async t => {
  const f = await fixture(t); await f.service.saveConfig({ token: 'fixture-pat' });
  const run = await f.service.startRun({ ...target, requestId: randomUUID(), branches: {} });
  f.setStatus('SUCCESS'); await f.service.getRun(run.id);
  const file = path.join(f.directory, 'yunxiao-runs.json');
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored[0].steps = [{ name: '旧任务', status: 'SUCCESS' }];
  await fs.writeFile(file, JSON.stringify(stored)); await f.restart();
  const before = f.calls.length;
  const terminal = await f.service.getRun(run.id);
  assert.equal(terminal.status, 'success'); assert.equal(terminal.steps?.find(step => step.jobId)?.jobId, '7');
  assert.equal(f.calls.length, before + 1);
  await f.service.getRun(run.id); assert.equal(f.calls.length, before + 1);
  const log = await f.service.log(run.id, '7', 0);
  assert.equal(log.text, '构建中 L_RAW [凭据已隐藏]\n'); assert.equal(log.moreData, false);
  assert.equal(log.nextOffset, Buffer.byteLength(log.text));
  const requests = f.calls.length;
  await assert.rejects(f.service.log(run.id, '8', 0), /任务/);
  assert.equal(f.calls.length, requests);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('云效日志复用通用脱敏，隐藏Bearer和URL凭据并逐字保留L码与业务文案', async t => {
  const f = await fixture(t); await f.service.saveConfig({ token: 'fixture-pat' });
  f.setLogContent('Authorization: Bearer fixture-bearer\nhttps://example.test/log?token=fixture-query&branch=pre\n'
    + '业务文案 L000509，构建记录原样保留。\nfixture-pat\n');
  const run = await f.service.startRun({ ...target, requestId: randomUUID(), branches: {} });
  const log = await f.service.log(run.id, '7', 0);
  assert.equal(log.text, 'Authorization: Bearer [凭据已隐藏]\nhttps://example.test/log?token=[凭据已隐藏]&branch=pre\n'
    + '业务文案 L000509，构建记录原样保留。\n[凭据已隐藏]\n');
  assert.equal(log.nextOffset, Buffer.byteLength(log.text));
  assert.equal(log.moreData, false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/runs/42/job/7/log')).length, 1);
});

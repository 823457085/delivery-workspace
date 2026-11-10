import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRefactorControl } from '../server/refactor-control';
import { integrationCatalogFixture } from './fixtures/integration-catalog';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog';
import { refactorJobLabel, type RefactorLaunch, type RefactorResult } from '../shared/refactor-control';
import type { AgentRun, AgentRuntimeDashboard, StartAgentRunInput } from '../shared/agent-runtime';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime';
import { createAgentTeamService } from '../server/agent-team-service';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance';
import type { GroupConfig, GroupRoomDetail, GroupSendInput } from '../shared/agent-group-chat';
import { defaultTeamProfileConfig, type TeamTask } from '../shared/agent-team';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/integration-runs'), { recursive: true });
  const data = path.join(root, '.data/refactor-control');
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const merchant = catalog.find(item => item.id === 'fixture-merchant')!;
  const equipment = catalog.find(item => item.method === 'GET' && item.ui.route.includes('EquipmentMonitoring'))!;
  const records = Object.fromEntries([merchant, equipment].map(item => [item.id,
    { assignee: { name: 'demo-user', displayName: '测试人员' }, evidence: '', blocker: '', confirmedAt: '', updatedAt: '' }]));
  await fs.writeFile(path.join(root, '.data/apex-bff-review.json'), JSON.stringify(records));
  const automation = { workspacePath: root, deliveryRoot: root, baseUrl: 'http://127.0.0.1:6791', environment: 'DEV', assignee: 'demo-user' };
  await fs.writeFile(path.join(root, 'public/integration-runs/execution-plan.json'), JSON.stringify({ automation, tasks: [] }));
  for (const [moduleId, item] of [['merchant', merchant], ['equipment', equipment]] as const) {
    const issues = [1, 2].map(index => ({ id: `${moduleId}-ISSUE-${index}`, summary: `真实问题 ${index}`, kind: '后端问题', status: '待后端修复',
      interfaceIds: [item.id], pages: [item.ui.page], report: '/integration-runs/original.html',
      retest: { interfaceIds: [item.id], pages: [item.ui.page], request: `GET ${item.path}?id=fixture-${index}`, headers: { 'X-Region': 'NA' }, requiredFields: ['name'] } }));
    await fs.writeFile(path.join(root, `public/integration-runs/${moduleId}.json`), JSON.stringify({ automation, status: '历史通过', current: '', startedAt: '', updatedAt: '2026-10-01T00:00:00Z', environment: 'DEV',
      interfaces: [{ id: item.id, operationId: '', page: item.ui.page, request: `GET ${item.path}`, status: '已通过', result: '历史结论', checkedAt: '2026-10-01T00:00:00Z' }],
      pages: [{ name: item.ui.page, status: '已通过', result: '历史页面结论' }], issues }));
  }
  await fs.writeFile(path.join(root, 'public/integration-runs/original.html'), '<p>原问题的真实现场</p>');
  const runs = new Map<string, AgentRun>(), launches: StartAgentRunInput[] = [];
  let uncertain = false;
  const runtime = {
    async dashboard() { return { runtimes: [{ provider: 'codex', label: 'Codex', ready: true, writable: true, accessModes: ['workspace', 'full'], models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['high'] }] }], runs: [...runs.values()] } as AgentRuntimeDashboard; },
    getRun: (id: string) => [...runs.values()].find(run => run.id === id),
    findManagedRefactor: (id: string) => runs.get(id),
    async startManagedRefactor(input: StartAgentRunInput, id: string) {
      launches.push(input);
      const run = { id: randomUUID(), status: 'running', result: '', objective: input.objective, events: [] } as unknown as AgentRun;
      runs.set(id, run);
      if (uncertain) throw new Error('模拟派发回执中断');
      return run;
    },
    async stop(id: string) { const run = [...runs.values()].find(run => run.id === id)!; run.status = 'cancelled'; return run; },
  };
  const service = await createRefactorControl(root, data, runtime, { catalog: integrationCatalogFixture, autoDispatch: false });
  t.after(() => service.close());
  const dashboard = await service.dashboard();
  const launch = (overrides: Partial<RefactorLaunch> = {}): RefactorLaunch => ({ action: 'integrate', moduleIds: ['merchant', 'equipment'], issueIds: [], version: '', notes: '', provider: 'codex', model: 'fixture-model', reasoningEffort: 'high', revision: dashboard.revision, ...overrides });
  async function start(input = launch(), requestId = randomUUID()) {
    const preview = await service.preview(input);
    const body = { launch: input, scopeHash: preview.scopeHash, requestId };
    return { result: await service.start(body), body, preview };
  }
  return { root, data, runs, launches, runtime, service, launch, start, records, setUncertain() { uncertain = true; } };
}

test('本地分支复测经预览和队列启动真实独立服务；自动记录Commit、来源保持不变、完成停止服务', async t => {
  const f = await fixture(t), exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('git', ['-C', f.root, ...args])).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
  await fs.writeFile(path.join(f.root, 'server.cjs'), "require('http').createServer((req,res)=>res.end(require('fs').readFileSync('marker.txt'))).listen(Number(process.env.PORT),process.env.HOST);");
  await fs.writeFile(path.join(f.root, 'marker.txt'), 'main');
  await git('add', 'package.json', 'server.cjs', 'marker.txt'); await git('commit', '-m', '测试主分支');
  await git('switch', '-c', 'feature/retest'); await fs.writeFile(path.join(f.root, 'marker.txt'), 'chosen');
  await git('add', 'marker.txt'); await git('commit', '-m', '测试复测分支');
  const head = await git('rev-parse', 'HEAD'); await git('switch', 'main');
  await fs.writeFile(path.join(f.root, 'marker.txt'), 'dirty-main');
  const sources = await f.service.branches({ moduleIds: ['merchant', 'equipment'] });
  assert.equal(sources.length, 1); assert.equal(sources[0].moduleIds.length, 2);
  const input = f.launch({ action: 'retest', retestMode: 'local', moduleIds: ['merchant'], issueIds: ['merchant-ISSUE-1'],
    branches: [{ workspacePath: sources[0].workspacePath, ref: 'refs/heads/feature/retest' }] });
  await assert.rejects(f.service.preview({ ...input, branches: [] }), /每个执行项目选择/);
  await assert.rejects(f.service.preview({ ...input, branches: [{ workspacePath: path.dirname(f.root), ref: 'refs/heads/main' }] }), /每个执行项目选择/);
  const preview = await f.service.preview(input);
  assert.equal(preview.environment, 'LOCAL'); assert.equal(preview.version, head); assert.equal(preview.jobs[0].localPlan?.head, head);
  await git('update-ref', 'refs/heads/feature/retest', await git('rev-parse', 'main'));
  await assert.rejects(f.service.start({ launch: input, scopeHash: preview.scopeHash, requestId: randomUUID() }), /代码或执行范围已变化/);
  await git('update-ref', 'refs/heads/feature/retest', head);
  const started = await f.service.start({ launch: input, scopeHash: preview.scopeHash, requestId: randomUUID() });
  await f.service.pump();
  const job = (await f.service.dashboard()).jobs.find(item => item.id === started.jobIds[0])!;
  assert.equal(job.environment, 'LOCAL'); assert.equal(job.version, head); assert.equal(job.sourceHead, head);
  assert.ok(job.localRuntime); assert.equal(f.launches[0].workspacePath, job.localRuntime.workspacePath);
  assert.equal(await (await fetch(job.localRuntime.baseUrl)).text(), 'chosen');
  assert.match(f.launches[0].objective, /不能回退到原 DEV/); assert.match(f.launches[0].objective, /不等于后端已在本地/);
  assert.equal(await fs.readFile(path.join(f.root, 'marker.txt'), 'utf8'), 'dirty-main');
  assert.equal(await git('branch', '--show-current'), 'main');
  assert.equal(f.service.isIdle(), false);
  assert.equal(f.service.isIdle(false), true);
  await f.service.close(true);
  assert.equal(await (await fetch(job.localRuntime.baseUrl)).text(), 'chosen');
  const reopened = await createRefactorControl(f.root, f.data, f.runtime, { catalog: integrationCatalogFixture, autoDispatch: false });
  t.after(() => reopened.close());
  await reopened.pump();
  assert.equal(f.launches.length, 1, '重启沿用原任务和本地服务');
  assert.equal(await (await fetch(job.localRuntime.baseUrl)).text(), 'chosen');
  f.runs.get(job.id)!.status = 'completed'; await reopened.pump();
  assert.equal((await reopened.dashboard()).jobs.find(item => item.id === job.id)?.localRuntime?.state, 'stopped');
  assert.equal(reopened.isIdle(), true);
});

test('串行执行模块、重复请求不重复派发，重启保留待办和原运行身份', async t => {
  const f = await fixture(t);
  const { result, body } = await f.start();
  assert.equal(result.jobIds.length, 2);
  assert.deepEqual((await f.service.dashboard()).jobs.map(job => job.status), ['queued', 'queued']);
  assert.equal((await f.service.start(body)).reused, true);
  await f.service.pump(); await f.service.pump();
  assert.equal(f.launches.length, 1);
  const first = f.runs.get(result.jobIds[0])!;
  await f.service.close();
  const reopened = await createRefactorControl(f.root, f.data, f.runtime, { catalog: integrationCatalogFixture, autoDispatch: false });
  t.after(() => reopened.close());
  await reopened.pump(); assert.equal(f.launches.length, 1);
  first.status = 'completed'; await reopened.pump();
  assert.equal(f.launches.length, 2);
  assert.equal((await reopened.dashboard()).jobs.find(job => job.id === result.jobIds[0])?.runId, first.id);
  assert.match(f.launches[0].objective, /本次不授权发消息/);
  assert.doesNotMatch(f.launches[0].objective, /--send-inline|integrationFeedbackInstructions/);
  assert.match(f.launches[0].objective, /任务结果目录|结果只保存到/);
  assert.equal(f.launches[0].serviceTier, 'default');
});

test('兼容执行器省略权限列表及平台默认模型；明确受限的执行器不能派发', async t => {
  const f = await fixture(t);
  const health = await f.runtime.dashboard();
  const executor = health.runtimes[0];
  delete executor.accessModes;
  executor.models = [{ id: '', label: '平台默认' }];
  f.runtime.dashboard = async () => health;
  const launch = f.launch({ model: '', reasoningEffort: '' });
  assert.equal((await f.service.preview(launch)).jobs.length, 2);
  executor.accessModes = ['workspace'];
  await assert.rejects(f.service.preview(launch), /完全访问/);
});

test('预览只核验所选执行器，不等待其他供应商健康检查或全量会话列表', async t => {
  const f = await fixture(t), health = (await f.runtime.dashboard()).runtimes[0], checked: string[] = [];
  Object.assign(f.runtime, { async health(provider: string) { checked.push(provider); return health; } });
  f.runtime.dashboard = async () => { throw new Error('不应读取全量运行状态'); };
  assert.equal((await f.service.preview(f.launch())).jobs.length, 2);
  assert.deepEqual(checked, ['codex']);
});

test('重构任务通过真实团队服务按保存岗位派发；负责人结束不结束批次，重开恢复同一团队并可定向停止', async t => {
  const f = await fixture(t); await f.service.close();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-team-runtime-'));
  const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: AgentRun[] = [];
  const adapters: AgentRuntimeAdapter[] = (['codex', 'claude', 'cursor'] as const).map(provider => ({ id: provider,
    health: async () => ({ provider, label: provider, binary: 'fixture', version: 'fixture', ready: true, authenticated: true,
      message: '测试适配器', modes: ['ask', 'agent', 'plan'], writable: true, defaultModel: '', checkedAt: new Date().toISOString(),
      models: provider === 'codex' ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
        : provider === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer' }]
          : ['sonnet', 'opus', 'fable'].map(id => ({ id, label: id === 'sonnet' ? 'Sonnet 5.5' : id === 'opus' ? 'Opus 5.5' : 'Fable 5.1', efforts: ['high'] })) }),
    execute: async context => {
      calls.push(structuredClone(context.run));
      if (context.run.team?.profileId === 'leader') return report({ taskPlan: { templateId: 'frontend', reason: '测试真实团队派发', risk: 'low',
        acceptanceCriteria: [{ id: 'AC-1', text: '只核对夹具，不调用业务接口', source: '测试夹具' }], allowedPaths: [], needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] } });
      if (context.run.team?.profileId === 'frontend') {
        await Promise.race([held, new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))]);
        return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '测试适配器，无业务实测', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '仅核对夹具' }], selfTests: [{ command: 'fixture-only', exitCode: 0 }] } });
      }
      if (context.run.team?.profileId === 'verifier') return report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '测试夹具' }] } });
      return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [] } });
    } }));
  const runtime = await createAgentRuntimeService(data, { adapters });
  const teams = await createAgentTeamService(data, runtime);
  let service = await createRefactorControl(f.root, f.data, runtime, { teams, catalog: integrationCatalogFixture, autoDispatch: false });
  t.after(async () => { release(); await service.close(); await teams.close(); await runtime.close(); await fs.rm(data, { recursive: true, force: true }); });
  const draft = teams.profiles.read();
  Object.assign(draft.profiles.find(profile => profile.id === 'frontend')!, { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' });
  const profile = await teams.profiles.save({ expectedRevision: draft.revision, profiles: draft.profiles, reviewRouting: draft.reviewRouting, options: draft.options });
  const input = f.launch({ collaborationMode: 'automatic', teamRevision: profile.revision, revision: (await service.dashboard()).revision });
  const preview = await service.preview(input);
  const batch = { launch: input, scopeHash: preview.scopeHash, requestId: randomUUID() };
  const started = await service.start(batch); await service.pump();
  for (let i = 0; i < 500 && !calls.some(run => run.team?.profileId === 'frontend'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const dashboard = await service.dashboard();
  const job = dashboard.jobs.find(job => job.id === started.jobIds[0])!;
  assert.ok(job.teamTaskId); assert.equal(job.team?.profileRevision, profile.revision);
  assert.equal(job.model, profile.profiles.find(p => p.id === 'leader')?.model);
  assert.equal(job.team?.nodes.find(node => node.profileId === 'leader')?.status, 'completed');
  assert.equal(job.team?.nodes.find(node => node.profileId === 'frontend')?.status, 'running');
  assert.equal(refactorJobLabel(job), '团队执行中');
  assert.equal(calls.find(run => run.team?.profileId === 'frontend')?.provider, profile.profiles.find(p => p.id === 'frontend')?.provider);
  await service.pump(); assert.equal(teams.list().length, 1);
  await service.close(); service = await createRefactorControl(f.root, f.data, runtime, { teams, catalog: integrationCatalogFixture, autoDispatch: false });
  await service.pump(); assert.equal(teams.list().length, 1);
  assert.equal((await service.start(batch)).reused, true);
  await assert.rejects(service.start({ ...batch, requestId: randomUUID() }), /已有任务/);
  await service.stop(started.jobIds[0]);
  assert.equal(teams.getTask(job.teamTaskId!).state, 'cancelled');
  assert.equal((await service.dashboard()).jobs.find(job => job.id === started.jobIds[1])?.status, 'queued');
  await assert.rejects(service.preview({ ...input, teamRevision: profile.revision + 1 }), /配置已变化/);
  await service.pump(); release();
  for (let i = 0; i < 500 && !teams.list().some(task => task.id !== job.teamTaskId && task.state === 'completed'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const second = (await service.dashboard()).jobs.find(job => job.id === started.jobIds[1])!;
  assert.equal(second.team?.state, 'completed');
  assert.equal(refactorJobLabel(second), '团队执行结束，待核对结果');
  assert.equal(second.report, undefined);
});

test('批量复测准确绑定所选问题、环境与版本；失效范围和重复占用被拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.preview(f.launch({ action: 'retest', issueIds: ['merchant-ISSUE-1'] })), /已部署版本/);
  await assert.rejects(f.service.preview(f.launch({ action: 'retest', version: 'bff-v2', issueIds: ['unknown'] })), /不在本轮范围/);
  await assert.rejects(f.service.preview(f.launch({ moduleIds: ['monitoring'] })), /当前执行范围/);
  const input = f.launch({ action: 'retest', moduleIds: ['merchant'], issueIds: ['merchant-ISSUE-1', 'merchant-ISSUE-2'], version: 'bff-v2' });
  const { result, preview } = await f.start(input);
  assert.equal(preview.jobs.length, 1); assert.equal(preview.jobs[0].targetIds.length, 2);
  const job = (await f.service.dashboard()).jobs[0];
  assert.deepEqual(job.issueIds, input.issueIds); assert.equal(job.environment, 'DEV'); assert.equal(job.version, 'bff-v2');
  await assert.rejects(f.start(input), /已有任务/);
  await f.service.pump();
  assert.ok(f.launches[0].objective.includes('fixture-1') && f.launches[0].objective.includes('fixture-2'));
  assert.match(f.launches[0].objective, /无法恢复原条件则记录 blocked/);
  f.runs.get(result.jobIds[0])!.status = 'completed';
  assert.equal(refactorJobLabel((await f.service.dashboard()).jobs[0]), '执行结束，待核对结果');
});

test('派发结果不明时恢复既有运行，不重发或并发启动下一模块；取消只影响所选任务', async t => {
  const f = await fixture(t); f.setUncertain();
  const { result } = await f.start();
  await f.service.pump(); await f.service.pump();
  assert.equal(f.launches.length, 1);
  assert.equal((await f.service.dashboard()).jobs.find(job => job.id === result.jobIds[0])?.status, 'started');
  await f.service.stop(result.jobIds[1]);
  assert.equal((await f.service.dashboard()).jobs.find(job => job.id === result.jobIds[1])?.status, 'cancelled');
  assert.equal(f.runs.get(result.jobIds[0])?.status, 'running');
});

test('报告需匹配本轮范围、环境和版本，不能以部分项目或自引用证据冒充整批通过', async t => {
  const f = await fixture(t);
  const { result } = await f.start(f.launch({ moduleIds: ['merchant'], action: 'retest', issueIds: ['merchant-ISSUE-1', 'merchant-ISSUE-2'], version: 'deployed-sha' }));
  await f.service.pump(); const id = result.jobIds[0]; f.runs.get(id)!.status = 'completed';
  const directory = path.join(f.data, 'artifacts', id);
  const report: RefactorResult = { jobId: id, environment: 'DEV', version: 'deployed-sha', status: 'passed', summary: '本轮现场通过',
    items: [{ targetId: 'merchant-ISSUE-1', status: 'passed', actual: '真实响应字段存在', evidence: ['network.json'] }],
    checks: [{ name: '原请求与页面核验', status: 'passed', detail: '新请求、新页面现场' }], changedFiles: [] };
  await fs.writeFile(path.join(directory, 'network.json'), JSON.stringify({ url: '/test', status: 200, response: { name: 'fixture' } }));
  const write = async () => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report));
  await write(); let job = (await f.service.dashboard()).jobs[0];
  assert.equal(job.report, undefined); assert.match(job.reportError!, /部分通过/);
  report.items.push({ ...report.items[0], targetId: 'merchant-ISSUE-2' });
  report.version = 'other-version'; await write(); assert.match((await f.service.dashboard()).jobs[0].reportError!, /版本不匹配/);
  report.version = 'deployed-sha'; report.items[0].evidence = ['result.json']; await write(); assert.match((await f.service.dashboard()).jobs[0].reportError!, /独立证据/);
  report.items[0].evidence = ['network.json']; report.checks[0].status = 'not_run'; await write(); assert.match((await f.service.dashboard()).jobs[0].reportError!, /未执行检查/);
  report.checks[0].status = 'passed'; await write(); job = (await f.service.dashboard()).jobs[0];
  assert.equal(job.report?.status, 'passed'); assert.equal(refactorJobLabel(job), '检查通过，待验收');
  for (const actual of ['Authorization: [redacted]', '{"authorization":"[redacted]"}', 'password: "[redacted]"']) {
    report.items[0].actual = actual; await write();
    assert.equal((await f.service.dashboard()).jobs[0].report?.status, 'passed', actual);
  }
  for (const actual of ['Authorization: Bearer fixture-secret', '{"authorization":"fixture-secret"}', 'password: "fixture-password"']) {
    report.items[0].actual = actual; await write();
    assert.match((await f.service.dashboard()).jobs[0].reportError!, /未脱敏/, actual);
  }
  report.items[0].actual = '真实响应字段存在'; await write();
  const markdown = await f.service.export('md', ['merchant']);
  assert.match(markdown, /deployed-sha/); assert.match(markdown, /本轮现场通过/); assert.match(markdown, /人工验收分别记录/);
  await assert.rejects(f.service.stop(id), /已经结束/);
});

test('证据读取拒绝穿越、符号链接和未关联的来源文件，配置修改须回读版本', async t => {
  const f = await fixture(t); const { result } = await f.start(f.launch({ moduleIds: ['merchant'] })); await f.service.pump();
  const directory = path.join(f.data, 'artifacts', result.jobIds[0]);
  await fs.writeFile(path.join(f.root, 'private.txt'), '不应暴露'); await fs.symlink(path.join(f.root, 'private.txt'), path.join(directory, 'outside.txt'));
  await assert.rejects(f.service.artifact(result.jobIds[0], '../private.txt'), /路径无效/);
  await assert.rejects(f.service.artifact(result.jobIds[0], 'outside.txt'), /不在本次任务/);
  await assert.rejects(f.service.sourceArtifact('/integration-runs/auth.json'), /不属于/);
  assert.equal(await f.service.sourceArtifact('/integration-runs/original.html'), await fs.realpath(path.join(f.root, 'public/integration-runs/original.html')));
  const before = await f.service.dashboard();
  await assert.rejects(f.service.configure({ config: before.config, revision: randomUUID() }), /其他页面/);
  const saved = await f.service.configure({ config: { ...before.config, baseUrl: 'http://127.0.0.1:6792' }, revision: before.revision });
  assert.equal(saved.config.baseUrl, 'http://127.0.0.1:6792'); assert.notEqual(saved.revision, before.revision);
  const old = f.launch(); await assert.rejects(f.service.preview(old), /配置已变化/);
});

test('重构新任务沿用群聊团队配置并进入自动编排；待建团队时可恢复、停止且不重复派发', async t => {
  const f = await fixture(t); await f.service.close();
  let config: GroupConfig = { revision: 9, name: '我的可配置交付团队', members: [
    { id: 'leader', name: '自定义负责人', instructions: '只按本轮授权安排工作', enabled: true, capability: 'read', binding: { provider: 'codex', model: 'fixture-model', reasoningEffort: 'high' } },
    { id: 'verifier', name: '接口复测', instructions: '记录实测证据', enabled: true, capability: 'verify', binding: { provider: 'codex', model: 'fixture-model', reasoningEffort: 'high' } },
  ] };
  const sent: GroupSendInput[] = [], rooms = new Map<string, GroupRoomDetail>();
  const groups = {
    dashboard: () => ({ config: structuredClone(config), rooms: [...rooms.values()].map(({ room }) => ({ ...room, state: room.rounds.at(-1)!.state })) }),
    detail: (id: string) => { const room = rooms.get(id); if (!room) throw new Error('找不到这个团队群聊'); return structuredClone(room); },
    send: async (input: GroupSendInput) => {
      sent.push(structuredClone(input));
      assert.equal(input.expectedConfigRevision, config.revision);
      assert.equal(input.memberIds, undefined, '不指定成员顺序派发，进入群聊原有自动编排');
      const id = randomUUID(), createdAt = new Date().toISOString();
      const detail: GroupRoomDetail = { room: { id, title: input.title || input.text.slice(0, 100), workspacePath: f.root, executionPath: f.root,
        orchestration: 'automatic', paused: false, cursorTrustPaths: [], createdAt, updatedAt: createdAt,
        rounds: [{ id: randomUUID(), requestId: input.requestId, requestHash: 'fixture', text: input.text, accessMode: 'full', attachmentIds: [], configRevision: config.revision,
          automatic: { config: structuredClone(config), inputs: [] }, state: 'queued', turns: [], createdAt, updatedAt: createdAt }] }, runs: [] };
      rooms.set(id, detail); return structuredClone(detail);
    },
    action: async (id: string, _action: 'pause' | 'continue' | 'cancel') => { const detail = rooms.get(id)!; detail.room.rounds[0].state = 'cancelled'; return structuredClone(detail); },
  };
  const runtime = { ...f.runtime, health: async () => ({ ...(await f.runtime.dashboard()).runtimes[0], modes: ['ask', 'agent'],
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['high', 'max', 'ultra'] }] }) as any };
  let service = await createRefactorControl(f.root, f.data, runtime, { groups, catalog: integrationCatalogFixture, autoDispatch: false });
  t.after(() => service.close());
  const launch = f.launch({ moduleIds: ['merchant'], collaborationMode: 'automatic', teamRevision: config.revision, revision: (await service.dashboard()).revision });
  const preview = await service.preview(launch);
  for (const effort of ['max', 'ultra'] as const) {
    config.members[0].binding!.reasoningEffort = effort;
    assert.equal((await service.preview(launch)).teamSource, 'group');
  }
  config.members[0].binding!.reasoningEffort = 'high';
  assert.deepEqual((await service.dashboard()).groupConfig, config);
  assert.equal(preview.teamSource, 'group'); assert.equal(preview.teamName, config.name);
  config.members[0].instructions = '预览后修改职责';
  await assert.rejects(service.start({ launch, scopeHash: preview.scopeHash, requestId: randomUUID() }), /范围已变化/);
  const fresh = await service.preview(launch);
  const batch = { launch, scopeHash: fresh.scopeHash, requestId: randomUUID() };
  const started = await service.start(batch); await service.pump();
  let job = (await service.dashboard()).jobs[0];
  assert.equal(sent[0].title, `${job.moduleTitle} · 触发联调（${job.targetIds.length}项）`);
  assert.equal(rooms.get(job.groupRoomId!)!.room.title, sent[0].title);
  assert.ok(sent[0].text.startsWith(`[重构管理任务:${job.id}]\n`), '业务标题不替换完整任务指令或任务编号');
  assert.ok(job.groupRoomId); assert.equal(job.teamName, config.name); assert.equal(job.teamSource, 'group');
  assert.equal(job.runStatus, 'queued'); assert.equal(sent.length, 1); assert.equal(f.launches.length, 0);
  await service.close(); service = await createRefactorControl(f.root, f.data, runtime, { groups, catalog: integrationCatalogFixture, autoDispatch: false });
  await service.pump(); assert.equal(sent.length, 1); assert.equal((await service.start(batch)).reused, true);
  await service.stop(started.jobIds[0]);
  job = (await service.dashboard()).jobs[0]; assert.equal(job.status, 'cancelled');
  assert.equal(rooms.get(job.groupRoomId!)!.room.rounds[0].state, 'cancelled');
  const completed = await service.start({ launch, scopeHash: fresh.scopeHash, requestId: randomUUID() }); await service.pump();
  const current = (await service.dashboard()).jobs.find(job => job.id === completed.jobIds[0])!;
  const detail = rooms.get(current.groupRoomId!)!, first = detail.room.rounds[0];
  const task = { id: randomUUID(), state: 'completed', parentConversationId: 'original-conversation', profileConfig: defaultTeamProfileConfig(),
    nodes: [], sourceWorkspacePath: f.root } as unknown as TeamTask;
  const later = { ...task, id: randomUUID(), state: 'running' } as TeamTask;
  first.state = 'completed'; first.automatic!.taskId = task.id;
  detail.room.rounds.push({ ...structuredClone(first), id: randomUUID(), requestId: 'later-user-discussion', state: 'running', automatic: { ...structuredClone(first.automatic!), taskId: later.id } });
  detail.collaborations = [{ task, runs: [] }, { task: later, runs: [] }]; detail.collaboration = { task: later, runs: [] };
  await service.pump();
  const original = (await service.dashboard()).jobs.find(job => job.id === completed.jobIds[0])!;
  assert.equal(original.teamTaskId, task.id, '原任务仍追踪原轮，不追踪房间后续讨论');
  assert.equal(original.team?.state, 'completed'); assert.equal(refactorJobLabel(original), '团队执行结束，待核对结果');
  await assert.rejects(service.stop(original.id), /任务已经结束/);
  rooms.delete(original.groupRoomId!);
  assert.equal((await service.dashboard()).jobs.find(job => job.id === original.id)?.teamTaskId, task.id, '删除群聊后仍可回读关联任务');
  const queued = await service.start({ launch, scopeHash: fresh.scopeHash, requestId: randomUUID() });
  config = { ...config, revision: config.revision + 1 };
  await service.pump();
  assert.equal(sent.length, 2, '后续群聊轮次不会占住原联调任务队列');
  const failed = (await service.dashboard()).jobs.find(job => job.id === queued.jobIds[0])!;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /排队期间 AI 团队配置已变化/);

  for (const [action, label] of [['develop', '开发实现'], ['style-check', '检查样式'], ['style-fix', '修改样式'], ['retest', '复测']] as const) {
    const input = f.launch({ action, moduleIds: ['merchant'], collaborationMode: 'automatic', teamRevision: config.revision,
      revision: (await service.dashboard()).revision, version: 'fixture-release', issueIds: action === 'retest' ? ['merchant-ISSUE-1', 'merchant-ISSUE-2'] : [] });
    const plan = await service.preview(input);
    const result = await service.start({ launch: input, scopeHash: plan.scopeHash, requestId: randomUUID() }); await service.pump();
    const generated = (await service.dashboard()).jobs.find(item => item.id === result.jobIds[0])!;
    assert.equal(sent.at(-1)!.title, `${generated.moduleTitle} · ${label}（${generated.targetIds.length}项）`);
    assert.equal(rooms.get(generated.groupRoomId!)!.room.title, sent.at(-1)!.title);
    assert.ok(sent.at(-1)!.text.startsWith(`[重构管理任务:${generated.id}]\n`));
    await service.stop(generated.id);
  }

  const exec = promisify(execFile);
  const git = (...args: string[]) => exec('git', ['-C', f.root, ...args]);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
  await fs.writeFile(path.join(f.root, 'server.cjs'), "require('http').createServer((req,res)=>res.end('fixture')).listen(Number(process.env.PORT),process.env.HOST);");
  await git('add', 'package.json', 'server.cjs'); await git('commit', '-m', '本地复测标题夹具');
  const [source] = await service.branches({ moduleIds: ['merchant'] });
  const local = f.launch({ action: 'retest', retestMode: 'local', moduleIds: ['merchant'], issueIds: ['merchant-ISSUE-1'],
    branches: [{ workspacePath: source.workspacePath, ref: 'refs/heads/main' }], collaborationMode: 'automatic', teamRevision: config.revision,
    revision: (await service.dashboard()).revision });
  const localPlan = await service.preview(local);
  const localResult = await service.start({ launch: local, scopeHash: localPlan.scopeHash, requestId: randomUUID() }); await service.pump();
  const localJob = (await service.dashboard()).jobs.find(item => item.id === localResult.jobIds[0])!;
  assert.equal(sent.at(-1)!.title, `${localJob.moduleTitle} · 本地复测（1项）`);
  assert.equal(localJob.environment, 'LOCAL');
  assert.ok(sent.at(-1)!.text.startsWith(`[重构管理任务:${localJob.id}]\n`));
  assert.equal(JSON.parse(sent.at(-1)!.text.split('\n')[1]).version, localJob.version);

  const group = rooms.get(localJob.groupRoomId!)!;
  const waiting = { ...task, id: randomUUID(), state: 'waiting_input' } as TeamTask;
  group.room.rounds[0].state = 'running';
  group.room.rounds[0].automatic!.taskId = waiting.id;
  group.collaboration = { task: waiting, runs: [] };
  assert.equal((await service.dashboard()).jobs.find(item => item.id === localJob.id)?.team?.state, 'waiting_input');

  const manual = { ...local, collaborationMode: 'manual' as const, teamRevision: undefined };
  const manualPlan = await service.preview(manual);
  const request = { launch: manual, scopeHash: manualPlan.scopeHash, requestId: randomUUID() };
  const manualResult = await service.start(request);
  assert.notEqual(manualResult.jobIds[0], localJob.id);
  assert.deepEqual(await service.start(request), { jobIds: manualResult.jobIds, reused: true });
  await assert.rejects(service.start({ ...request, requestId: randomUUID() }), /已有任务/);
  await service.pump();
  const manualJob = (await service.dashboard()).jobs.find(item => item.id === manualResult.jobIds[0])!;
  assert.equal(manualJob.runStatus, 'running');
  assert.equal(manualJob.version, localJob.version);
  assert.ok(manualJob.localRuntime);
  assert.notEqual(manualJob.localRuntime.workspacePath, localJob.localRuntime?.workspacePath);
  assert.notEqual(manualJob.localRuntime.baseUrl, localJob.localRuntime?.baseUrl);
  await service.stop(manualJob.id);
  assert.equal(group.room.rounds[0].state, 'running');
  assert.equal(await (await fetch(localJob.localRuntime!.baseUrl)).text(), 'fixture');

  const deployed = { ...manual, retestMode: 'deployed' as const, branches: undefined, version: 'fixture-release' };
  const deployedPlan = await service.preview(deployed);
  const deployedResult = await service.start({ launch: deployed, scopeHash: deployedPlan.scopeHash, requestId: randomUUID() });
  await service.pump();
  assert.equal((await service.dashboard()).jobs.find(item => item.id === deployedResult.jobIds[0])?.status, 'queued');
  await service.stop(localJob.id);
  await service.pump();
  assert.equal((await service.dashboard()).jobs.find(item => item.id === deployedResult.jobIds[0])?.runStatus, 'running');
  await service.stop(deployedResult.jobIds[0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDeliveryAcceptanceStore } from '../server/delivery-acceptance';
import { createDeliveryAcceptanceSourceResolver } from '../server/delivery-acceptance-source';
import { deliveryAcceptanceInputSchema, deliveryAcceptanceStatus, emptyDeliveryEvidence,
  type DeliveryAcceptanceInput, type DeliveryAcceptanceRecord, type ResolvedDeliveryAcceptanceSource } from '../shared/delivery-acceptance';
import { launchDeliveryRecords, reconcileDeliveryRecords } from '../src/features/workbench/domain';
import { readDeliveryAcceptances, saveDeliveryAcceptance } from '../src/features/workbench/acceptance-api';
import type { AgentRun } from '../shared/agent-runtime';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development';
import type { AutomationData, CatchupData, JiraIssue } from '../shared/hub';

const source = { runId: 'run-1', updatedAt: '2026-10-16T01:00:00.000Z' };
function input(): DeliveryAcceptanceInput {
  return { recordId: 'requirement:req-1', source, expectedRevision: 0, checks: emptyDeliveryEvidence(),
    decision: 'pending', summary: '', authorization: 'record-delivery-acceptance' };
}
function accepted(): DeliveryAcceptanceInput {
  const value = input(); value.decision = 'accepted'; value.summary = '本次修改已逐项核对';
  for (const check of Object.values(value.checks)) { check.status = 'not_applicable'; check.evidence = '该项不在本次文档修改范围内'; }
  value.checks.tests = { status: 'passed', evidence: 'node --test 已通过；报告保存在本机', sha: '' };
  return value;
}
const run: AgentRun = { id: source.runId, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test', reasoningEffort: 'xhigh',
  objective: '', workspacePath: '/isolated', branch: 'feature/test', headSha: '', status: 'completed', sessionId: '', pid: null,
  result: '运行结束', error: '', events: [], createdAt: source.updatedAt, updatedAt: source.updatedAt,
  task: { source: 'workflow', role: 'main', sourceId: 'requirement:req-1', title: '测试需求', parentConversationId: '', dependsOnConversationIds: [] } };
const requirement = { id: 'req-1', input: { title: '测试需求', issueKey: 'APEX-1', project: 'APEX', branch: 'feature/test' },
  status: 'started', workspacePath: '/isolated', runId: run.id, error: '', createdAt: '2026-10-15T00:00:00Z' } as RequirementDevelopmentRecord;

test('验收通过要求适用项证据、N/A 理由和完整远端 SHA，不能随意省略门禁', () => {
  assert.ok(deliveryAcceptanceInputSchema.safeParse(accepted()).success);
  for (const mutate of [
    (value: DeliveryAcceptanceInput) => { value.checks.tests.evidence = ''; },
    (value: DeliveryAcceptanceInput) => { value.checks.deployment.evidence = ''; },
    (value: DeliveryAcceptanceInput) => { value.checks.browser.status = 'pending'; },
    (value: DeliveryAcceptanceInput) => { value.checks.tests.status = 'failed'; },
    (value: DeliveryAcceptanceInput) => { value.summary = ''; },
    (value: DeliveryAcceptanceInput) => { value.checks.remote = { status: 'passed', evidence: '已推送', sha: 'abc1234' }; },
  ]) { const value = accepted(); mutate(value); assert.equal(deliveryAcceptanceInputSchema.safeParse(value).success, false); }
  const remote = accepted(); remote.checks.remote = { status: 'passed', evidence: 'git ls-remote 与本次提交一致', sha: 'a'.repeat(40) };
  assert.ok(deliveryAcceptanceInputSchema.safeParse(remote).success);
  assert.equal(deliveryAcceptanceInputSchema.safeParse({ ...accepted(), recordId: '../../etc/passwd' }).success, false);
  assert.equal(deliveryAcceptanceInputSchema.safeParse({ ...accepted(), authorization: '' }).success, false);
});

test('保存要求真实来源、匹配运行与更新时间；运行中只允许记录，不允许通过', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-source-'));
  let current: ResolvedDeliveryAcceptanceSource | undefined;
  try {
    const store = await createDeliveryAcceptanceStore(directory, () => current);
    await assert.rejects(store.save(accepted()), { statusCode: 404 });
    current = { ...source, active: false, runId: 'other' };
    await assert.rejects(store.save(accepted()), { statusCode: 409 });
    current = { ...source, active: false, updatedAt: '2026-10-16T02:00:00Z' };
    await assert.rejects(store.save(accepted()), { statusCode: 409 });
    current = { ...source, active: true };
    await assert.rejects(store.save(accepted()), { statusCode: 409 });
    assert.equal((await store.save(input())).decision, 'pending');
    assert.equal(store.list().length, 1);
    await store.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('乐观版本阻止并发覆盖；原子文件可重读，返回对象不会修改内存', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-revision-'));
  try {
    const resolve = () => ({ ...source, active: false });
    const store = await createDeliveryAcceptanceStore(directory, resolve);
    const writes = await Promise.allSettled([store.save(accepted()), store.save({ ...accepted(), summary: '另一个页面' })]);
    assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(writes.filter(item => item.status === 'rejected').length, 1);
    const record = store.get(input().recordId)!;
    record.summary = '外部修改'; record.checks.tests.evidence = '';
    assert.equal(store.get(record.recordId)!.summary, '本次修改已逐项核对');
    const reloaded = await createDeliveryAcceptanceStore(directory, resolve);
    assert.deepEqual(reloaded.list(), store.list());
    const files = await fs.readdir(directory);
    assert.deepEqual(files, [`${createHash('sha256').update(record.recordId).digest('hex')}.json`]);
    const saved = await store.save({ ...accepted(), expectedRevision: 1, summary: '再次核对' });
    assert.equal(saved.revision, 2);
    await assert.rejects(store.save({ ...accepted(), expectedRevision: 1 }), { statusCode: 409 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('备份写入失败不更新验收内存，close 等待待完成的持久写入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-writer-'));
  let release!: () => void, writing!: () => void;
  const entered = new Promise<void>(resolve => { writing = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let fail = true;
    const store = await createDeliveryAcceptanceStore(directory, () => ({ ...source, active: false }), { writeJson: async (relative, value) => {
      assert.match(relative, /^delivery-acceptance\/[a-f0-9]{64}\.json$/);
      assert.equal((value as DeliveryAcceptanceRecord).recordId, input().recordId);
      if (fail) throw new Error('backup failure');
      writing(); await gate;
    } });
    await assert.rejects(store.save(accepted()), /backup failure/); assert.equal(store.list().length, 0);
    fail = false; const saved = store.save(accepted()); await entered;
    let closed = false; const closing = store.close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    release(); await saved; await closing; assert.equal(closed, true); assert.equal(store.list().length, 1);
  } finally { release?.(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Jira Done 和会话 completed 不自动验收；新运行或来源更新使旧结论失效', () => {
  const issues = [{ key: 'APEX-1', status: ' L-DONE ', statusCategory: 'Done' } as JiraIssue];
  const [without] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), issues, [run]);
  assert.equal(without.currentStatus, 'completed'); assert.equal(without.acceptanceStatus, 'pending');
  assert.equal(without.jiraStatuses![0].status, ' L-DONE ');
  const { expectedRevision: _, authorization: __, ...data } = accepted();
  const record: DeliveryAcceptanceRecord = { ...data, revision: 1, updatedAt: source.updatedAt };
  const [verified] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), issues, [run], { acceptances: [record] });
  assert.equal(verified.acceptanceStatus, 'accepted');
  const [changed] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), issues, [{ ...run, updatedAt: '2026-10-16T03:00:00Z' }], { acceptances: [record] });
  assert.equal(changed.acceptanceStatus, 'stale');
  assert.equal(deliveryAcceptanceStatus(record, { ...source, runId: 'new-run' }), 'stale');
});

test('服务端来源使用实际工作台 ID，拒绝不存在的运行，并跟随续聊最新运行', async () => {
  const runs = [run];
  const catchup = { requirements: [{ id: 'not-started', session: null }] } as unknown as CatchupData;
  const resolve = createDeliveryAcceptanceSourceResolver(() => ({ requirements: [requirement], fixes: [], runs, catchup }));
  assert.deepEqual(await resolve('requirement:req-1'), { ...source, active: false });
  assert.equal(await resolve('requirement:unknown'), undefined);
  runs.length = 0; assert.equal(await resolve('requirement:req-1'), undefined);
  runs.push({ ...run, id: 'new-run', updatedAt: '2026-10-16T03:00:00Z', status: 'running' });
  assert.deepEqual(await resolve('requirement:req-1'), { runId: 'new-run', updatedAt: '2026-10-16T03:00:00Z', active: true });
});

test('旧 Agent 已结束仍不能覆盖业务执行中状态，暂停编辑的运行也不能通过', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-active-'));
  try {
    const job = { id: 'job-1', issueKey: 'APEX-1', title: '旧交付', status: 'dispatching', threadId: run.id,
      workspacePath: '/isolated', branch: 'feature/test', updatedAt: source.updatedAt };
    const snapshot = { automation: { jobs: [job] } as unknown as AutomationData, requirements: [], fixes: [], runs: [{ ...run, task: undefined }] };
    const resolve = createDeliveryAcceptanceSourceResolver(() => snapshot);
    const store = await createDeliveryAcceptanceStore(directory, resolve);
    for (const status of ['dispatching', 'DISPATCHING', 'RUNNING', 'QUEUED']) {
      job.status = status;
      assert.equal((await resolve('job:job-1'))!.active, true);
      await assert.rejects(store.save({ ...accepted(), recordId: 'job:job-1' }), { statusCode: 409 });
    }
    job.status = 'completed'; snapshot.runs[0].pausedForEdit = true;
    assert.equal((await resolve('job:job-1'))!.active, true);
    await assert.rejects(store.save({ ...accepted(), recordId: 'job:job-1' }), { statusCode: 409 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('恢复检查发现旧 CLI 仍在运行时只能保存证据，待核对状态沿用原验收规则', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-recovery-'));
  const recovered: AgentRun = { ...run, status: 'interrupted', recovery: {
    previousStatus: 'running', previousPid: 123, state: 'active', checkedAt: source.updatedAt, message: '旧 CLI 仍在运行',
  } };
  try {
    const resolve = createDeliveryAcceptanceSourceResolver(() => ({ requirements: [requirement], fixes: [], runs: [recovered] }));
    const store = await createDeliveryAcceptanceStore(directory, resolve);
    assert.deepEqual(await resolve(input().recordId), { ...source, active: true });
    await assert.rejects(store.save(accepted()), { statusCode: 409 });
    assert.equal((await store.save(input())).decision, 'pending');
    recovered.recovery!.state = 'needs-review';
    assert.deepEqual(await resolve(input().recordId), { ...source, active: false });
    assert.equal((await store.save({ ...accepted(), expectedRevision: 1 })).decision, 'accepted');
    await store.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('较早关联轮次仍在运行也阻止验收，已完成历史轮次的旧恢复元数据不阻止验收', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-recovery-history-'));
  const previous: AgentRun = { ...run, conversationId: 'conversation-1', status: 'interrupted', recovery: {
    previousStatus: 'running', previousPid: 123, state: 'active', checkedAt: source.updatedAt, message: '旧 CLI 仍在运行',
  } };
  const latest: AgentRun = { ...run, id: 'run-2', conversationId: 'conversation-1', parentRunId: previous.id,
    createdAt: '2026-10-16T02:00:00.000Z', updatedAt: '2026-10-16T03:00:00.000Z' };
  const latestSource = { runId: latest.id, updatedAt: latest.updatedAt };
  try {
    const resolve = createDeliveryAcceptanceSourceResolver(() => ({ requirements: [requirement], fixes: [], runs: [previous, latest] }));
    const store = await createDeliveryAcceptanceStore(directory, resolve);
    assert.deepEqual(await resolve(input().recordId), { ...latestSource, active: true });
    await assert.rejects(store.save({ ...accepted(), source: latestSource }), { statusCode: 409 });
    previous.status = 'completed';
    assert.deepEqual(await resolve(input().recordId), { ...latestSource, active: false });
    assert.equal((await store.save({ ...accepted(), source: latestSource })).decision, 'accepted');
    await store.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('读取验收是只读请求，保存带显式确认，接口失败不伪造已保存', async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  let response = new Response(JSON.stringify({ records: [] }));
  globalThis.fetch = async (_url, options) => { requests.push(options || {}); return response; };
  try {
    assert.deepEqual(await readDeliveryAcceptances(), []);
    assert.equal(requests[0].method, undefined); assert.equal(requests[0].body, undefined);
    response = new Response(JSON.stringify({ records: [] }), { headers: { 'X-Delivery-Source': 'Delivery-Offline' } });
    await assert.rejects(readDeliveryAcceptances(), /交付后端不可用/);
    response = new Response(JSON.stringify({ message: 'revision conflict' }), { status: 409 });
    await assert.rejects(saveDeliveryAcceptance(accepted()), /revision conflict/);
    assert.equal(requests.at(-1)!.method, 'POST');
    assert.equal(new Headers(requests.at(-1)!.headers).get('X-Delivery-Confirmed'), 'yes');
  } finally { globalThis.fetch = original; }
});

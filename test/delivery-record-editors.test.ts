import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, nextTick, shallowRef } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { useDeliveryAcceptance } from '../src/features/workbench/useDeliveryAcceptance';
import { useRequirementProgress, type RequirementRecordView } from '../src/features/requirement-development/useRequirementProgress';
import { deliveryAcceptanceQueryKey } from '../src/features/workbench/acceptance-api';
import { emptyDeliveryEvidence, type DeliveryAcceptanceRecord, type DeliveryEvidence } from '../shared/delivery-acceptance';
import { emptyRequirementProgress } from '../shared/requirement-development';
import type { AgentRun } from '../shared/agent-runtime';
import type { DeliveryRecord } from '../src/features/workbench/domain';

const renderer = createRenderer<object, object>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
const source = { runId: 'run-1', updatedAt: '2026-10-16T01:00:00Z' };
const acceptance = (revision: number): DeliveryAcceptanceRecord => ({ recordId: 'requirement:req-1', source, checks: emptyDeliveryEvidence(),
  decision: 'pending', summary: `验收版本 ${revision}`, revision, updatedAt: source.updatedAt });
const row: DeliveryRecord = { id: 'requirement:req-1', source: '需求开发', issueKeys: ['APEX-1'], title: '测试需求', status: 'started',
  threadId: '', workspacePath: '/isolated', branch: 'feature/test', updatedAt: source.updatedAt, result: '', error: '', detailPath: '/design',
  links: [], runId: source.runId, acceptanceKnown: true, acceptanceStatus: 'pending' };
function reportEvidence(label = '本轮'): DeliveryEvidence {
  return { tests: { status: 'passed', evidence: `${label}定向测试通过`, sha: '' },
    browser: { status: 'failed', evidence: `${label}浏览器验证尚有问题`, sha: '' },
    remote: { status: 'passed', evidence: `${label}远端回读`, sha: 'a'.repeat(40) },
    deployment: { status: 'not_applicable', evidence: `${label}不涉及部署`, sha: '' } };
}
function report(checks = reportEvidence()) { return `\`\`\`delivery-report\n${JSON.stringify({ version: 1, validationEvidence: checks })}\n\`\`\``; }
function evidenceRun(values: Partial<AgentRun> = {}): AgentRun {
  return { id: source.runId, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test', reasoningEffort: '',
    objective: '测试需求', workspacePath: '/isolated', branch: 'feature/test', headSha: '', status: 'completed', resultReady: true,
    sessionId: 'thread-1', pid: null, result: report(), error: '', events: [], createdAt: source.updatedAt, updatedAt: source.updatedAt, ...values };
}
const requirement: RequirementRecordView = { id: 'req-1', input: { title: '测试需求', issueKey: 'APEX-1', prdUrl: '', requirement: '', project: 'APEX',
  fixVersion: '', assignee: '', startDate: '2026-10-16', endDate: '2026-10-17', repository: 'git@example.test:team/repo.git',
  parentDirectory: '/tmp', branch: 'feature/test', confluenceParentUrl: '' }, status: 'started', workspacePath: '/isolated', headSha: '',
  runId: source.runId, error: '', createdAt: source.updatedAt, runStatus: 'completed' };
const withProgress = (revision: number): RequirementRecordView => ({ ...requirement, progress: { ...emptyRequirementProgress(),
  issueKeys: [`APEX-${revision}`], revision, updatedAt: source.updatedAt, source: 'manual', sourceRunId: source.runId } });
function mount<T>(setup: (client: QueryClient) => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let state!: T;
  const app = renderer.createApp({ setup() { state = setup(client); return () => null; } });
  app.use(VueQueryPlugin, { queryClient: client }); app.mount({});
  return { client, state, close: () => { app.unmount(); client.clear(); } };
}
test.beforeEach(t => {
  if ('mock' in t) {
    t.mock.method(ElMessage, 'success', () => ({ close() {} }));
    t.mock.method(ElMessage, 'error', () => ({ close() {} }));
  }
});

test('验收仅预填当前已完成运行报告，保留证据状态和 SHA，不自动保存或验收', t => {
  const checks = reportEvidence(), recordUpdatedAt = '2026-10-16T02:00:00Z';
  const current = { ...row, updatedAt: recordUpdatedAt, agentRuns: [evidenceRun({ id: 'old-run', result: report(reportEvidence('旧轮')) }), evidenceRun()] };
  const { state, close } = mount(() => useDeliveryAcceptance(() => current));
  const requests = t.mock.method(globalThis, 'fetch', async () => { throw new Error('打开表单不应发起保存'); });
  try {
    state.show();
    assert.deepEqual(state.draft.value.checks, checks);
    assert.deepEqual(state.draft.value.source, { runId: source.runId, updatedAt: recordUpdatedAt });
    assert.equal(state.draft.value.decision, 'pending'); assert.equal(state.draft.value.summary, '');
    assert.equal(state.draft.value.expectedRevision, 0); assert.equal(requests.mock.callCount(), 0);
  } finally { close(); }
});

test('同来源的人工记录优先于报告，编辑草稿不修改已保存记录', () => {
  const saved = { ...acceptance(3), checks: reportEvidence('人工'), decision: 'rejected' as const, summary: '人工核对仍有问题' };
  const { state, close } = mount(() => useDeliveryAcceptance(() => ({ ...row, acceptance: saved, agentRuns: [evidenceRun()] })));
  try {
    state.show(); assert.deepEqual(state.draft.value.checks, saved.checks);
    assert.equal(state.draft.value.decision, 'rejected'); assert.equal(state.draft.value.summary, saved.summary);
    assert.equal(state.draft.value.expectedRevision, 3);
    state.draft.value.checks.tests.evidence = '尚未保存的编辑';
    assert.equal(saved.checks.tests.evidence, '人工定向测试通过');
  } finally { close(); }
});

test('旧来源的人工证据与结论不会带入当前来源，仅保留保存版本', async t => {
  for (const decision of ['pending', 'accepted'] as const) for (const staleSource of [
    { ...source, runId: 'old-run' }, { ...source, updatedAt: '2026-10-16T00:00:00Z' },
  ]) await t.test(`${decision} / ${staleSource.runId} / ${staleSource.updatedAt}`, () => {
    const checks = reportEvidence('旧人工'); checks.browser = { status: 'passed', evidence: '旧轮人工核对通过', sha: '' };
    const saved = { ...acceptance(4), source: staleSource, checks, decision, summary: '旧轮人工结论' };
    const { state, close } = mount(() => useDeliveryAcceptance(() => ({ ...row, acceptance: saved,
      acceptanceStatus: decision === 'pending' ? 'pending' : 'stale' })));
    try {
      state.show(); assert.deepEqual(state.draft.value.checks, emptyDeliveryEvidence());
      assert.equal(state.draft.value.decision, 'pending'); assert.equal(state.draft.value.summary, '');
      assert.equal(state.draft.value.expectedRevision, 4); assert.deepEqual(state.draft.value.source, source);
    } finally { close(); }
  });
});

test('人工记录过期后可预填当前报告，全部证据通过仍待人工验收', () => {
  const checks = reportEvidence(); checks.browser = { status: 'passed', evidence: '本轮页面验证通过', sha: '' };
  const saved = { ...acceptance(5), source: { ...source, runId: 'old-run' }, checks: reportEvidence('旧人工'), summary: '旧轮结论' };
  const { state, close } = mount(() => useDeliveryAcceptance(() => ({ ...row, acceptance: saved, agentRuns: [evidenceRun({ result: report(checks) })] })));
  try {
    state.show(); assert.deepEqual(state.draft.value.checks, checks);
    assert.equal(state.draft.value.decision, 'pending'); assert.equal(state.draft.value.summary, '');
    assert.equal(state.draft.value.expectedRevision, 5);
  } finally { close(); }
});

test('运行未最终就绪、来源未知或当前运行缺失时不取历史报告预填', async t => {
  const cases: { name: string; values: Partial<DeliveryRecord> }[] = [
    ...(['running', 'queued', 'failed', 'interrupted', 'cancelled'] as const).map(status => ({ name: status, values: { agentRuns: [evidenceRun({ status })] } })),
    { name: '结果未就绪', values: { agentRuns: [evidenceRun({ resultReady: false })] } },
    { name: '历史结果就绪未知', values: { agentRuns: [evidenceRun({ resultReady: undefined })] } },
    { name: '暂停编辑', values: { agentRuns: [evidenceRun({ pausedForEdit: true })] } },
    { name: '关联旧轮暂停编辑', values: { agentRuns: [evidenceRun(), evidenceRun({ id: 'old-run', pausedForEdit: true })] } },
    { name: '关联旧轮恢复仍活跃', values: { agentRuns: [evidenceRun(), evidenceRun({ id: 'old-run', status: 'interrupted',
      recovery: { previousStatus: 'running', previousPid: null, state: 'active', checkedAt: source.updatedAt, message: '旧进程仍运行' } })] } },
    { name: '准备中', values: { status: 'preparing' } },
    { name: '启动中', values: { status: 'starting' } },
    { name: '来源未知', values: { sourceKnown: false } },
    { name: '运行状态未知', values: { agentStateKnown: false } },
    { name: '只有旧轮报告', values: { runId: 'next-run' } },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const current = { ...row, agentRuns: [evidenceRun()], ...item.values };
    const { state, close } = mount(() => useDeliveryAcceptance(() => current));
    try { state.show(); assert.deepEqual(state.draft.value.checks, emptyDeliveryEvidence()); }
    finally { close(); }
  });
});

test('没有合法证据报告或远端 SHA 无效时保持未验证', async t => {
  const invalid = reportEvidence(); invalid.remote.sha = 'abc123';
  for (const [name, result] of [['无证据报告', '本轮任务完成'], ['无效远端 SHA', report(invalid)]]) await t.test(name, () => {
    const { state, close } = mount(() => useDeliveryAcceptance(() => ({ ...row, agentRuns: [evidenceRun({ result })] })));
    try { state.show(); assert.deepEqual(state.draft.value.checks, emptyDeliveryEvidence()); }
    finally { close(); }
  });
});

test('报告刷新与新运行不覆盖编辑草稿，重新读取才更新证据和来源', async t => {
  const current = shallowRef<DeliveryRecord>({ ...row, agentRuns: [evidenceRun()] });
  const { state, close } = mount(() => useDeliveryAcceptance(() => current.value));
  const requests = t.mock.method(globalThis, 'fetch', async () => { throw new Error('预填不应保存'); });
  try {
    state.show(); state.draft.value.checks.tests.evidence = '用户正在编辑'; state.draft.value.summary = '人工草稿';
    current.value = { ...current.value, agentRuns: [evidenceRun({ result: report(reportEvidence('更新')) })] };
    await nextTick(); assert.equal(state.draft.value.checks.tests.evidence, '用户正在编辑');
    assert.equal(state.sourceChanged.value, false);
    const updatedAt = '2026-10-16T03:00:00Z', checks = reportEvidence('新轮');
    current.value = { ...current.value, runId: 'run-2', updatedAt, agentRuns: [evidenceRun({ id: 'run-2', updatedAt, result: report(checks) })] };
    await nextTick(); assert.equal(state.sourceChanged.value, true);
    assert.equal(state.draft.value.checks.tests.evidence, '用户正在编辑'); assert.equal(state.draft.value.summary, '人工草稿');
    await state.reload(); assert.deepEqual(state.draft.value.checks, checks);
    assert.deepEqual(state.draft.value.source, { runId: 'run-2', updatedAt }); assert.equal(state.sourceChanged.value, false);
    assert.equal(state.draft.value.decision, 'pending'); assert.equal(state.draft.value.summary, '');
    assert.equal(requests.mock.callCount(), 0);
  } finally { close(); }
});

test('验收保存成功后迟到的旧读取不覆盖新版本，重开仍使用已保存的 revision', async t => {
  const { client, state, close } = mount(client => useDeliveryAcceptance(() => ({ ...row,
    acceptance: client.getQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey)?.[0] })));
  let release!: (value: DeliveryAcceptanceRecord[]) => void;
  try {
    client.setQueryData(deliveryAcceptanceQueryKey, [acceptance(1)]);
    state.show(); assert.equal(state.draft.value.expectedRevision, 1);
    const oldRead = client.fetchQuery({ queryKey: deliveryAcceptanceQueryKey,
      queryFn: () => new Promise<DeliveryAcceptanceRecord[]>(resolve => { release = resolve; }) }).catch(() => undefined);
    t.mock.method(globalThis, 'fetch', async () => Response.json(acceptance(2)));
    await state.save();
    assert.equal(client.getQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey)?.[0].revision, 2);
    release([acceptance(1)]); await oldRead;
    state.show(); assert.equal(state.draft.value.expectedRevision, 2);
  } finally { release?.([]); close(); }
});

test('迟到的验收保存回包不能覆盖已读到的更高版本', async t => {
  const { client, state, close } = mount(client => useDeliveryAcceptance(() => ({ ...row,
    acceptance: client.getQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey)?.[0] })));
  let release!: (value: Response) => void;
  try {
    client.setQueryData(deliveryAcceptanceQueryKey, [acceptance(1)]); state.show();
    t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
    const saving = state.save();
    client.setQueryData(deliveryAcceptanceQueryKey, [acceptance(3)]);
    release(Response.json(acceptance(2))); await saving;
    assert.equal(client.getQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey)?.[0].revision, 3);
    state.show(); assert.equal(state.draft.value.expectedRevision, 3);
  } finally { release?.(Response.json(acceptance(2))); close(); }
});

test('迟到的需求进度保存回包不能覆盖已读到的更高版本', async t => {
  const key = ['requirement-development'];
  const { client, state, close } = mount(client => useRequirementProgress(() => client.getQueryData<RequirementRecordView[]>(key)?.[0] || requirement));
  let release!: (value: Response) => void;
  try {
    client.setQueryData(key, [withProgress(1)]); state.show();
    t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
    const saving = state.save();
    client.setQueryData(key, [withProgress(3)]);
    release(Response.json(withProgress(2))); await saving;
    assert.equal(client.getQueryData<RequirementRecordView[]>(key)?.[0].progress?.revision, 3);
    state.show(); assert.equal(state.issueKeys.value, 'APEX-3');
  } finally { release?.(Response.json(withProgress(2))); close(); }
});

test('保存进度期间启动续聊，迟到回包仅补进度，不回滚已刷新运行', async t => {
  const key = ['requirement-development'];
  const { client, state, close } = mount(client => useRequirementProgress(() => client.getQueryData<RequirementRecordView[]>(key)?.[0] || requirement));
  let release!: (value: Response) => void;
  try {
    client.setQueryData(key, [withProgress(1)]); state.show();
    t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
    const saving = state.save();
    client.setQueryData(key, [{ ...withProgress(1), runId: 'next-run', runStatus: 'running' }]);
    release(Response.json(withProgress(2))); await saving;
    const current = client.getQueryData<RequirementRecordView[]>(key)![0];
    assert.equal(current.runId, 'next-run'); assert.equal(current.runStatus, 'running');
    assert.equal(current.progress?.revision, 2); assert.equal(current.progress?.sourceRunId, source.runId);
  } finally { release?.(Response.json(withProgress(2))); close(); }
});

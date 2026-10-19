/** 测试真实表单状态与请求，所有 Jira 网络写入均由 fetch 替身拦截。 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { effectScope } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useJiraFixHandoff } from '../src/features/jira-fix/useJiraFixHandoff.js';
import type { JiraFixHandoffContext, JiraStatusChangeState } from '../shared/jira-fix-handoff.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';

function browserStorage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
}
const record = { id: randomUUID() } as JiraFixRecord;
const draft = { cause: '已确认的根因', impact: '编辑入口', suggestion: '回归空值', conclusion: '定向检查通过，浏览器未验证' };
function context(): JiraFixHandoffContext {
  return { runId: randomUUID(), result: '定向测试通过', issue: { key: 'TEST-123', summary: '缺陷', status: { id: 'start', name: '待开始' },
    reporter: { id: 'qa', name: '报告人', kind: 'name', active: true }, assignee: null },
    transitions: [{ id: '11', name: 'Start', to: { id: 'design', name: '设计中' }, dateFields: [
      { id: 'customfield_10109', name: '目标开始日期', required: true },
      { id: 'customfield_10110', name: '目标结束日期', required: false },
    ] }], testingPath: { transitionId: '11', statuses: [{ id: 'design', name: '设计中' }, { id: 'dev', name: '开发中' }, { id: 'test', name: '测试中' }] } };
}

test('打开恢复服务端生成稿，手改稿刷新后仍保留且不调用生成或发布接口', async t => {
  browserStorage(t);
  const latest = context(); latest.draft = { recordId: record.id, runId: latest.runId,
    sourceFingerprint: 'a'.repeat(64), draft, updatedAt: new Date().toISOString() };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(init?.method || 'GET'); return Response.json(latest);
  });
  const first = effectScope(), state = first.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => first.stop());
  await state.show(record); assert.equal(state.form.value.cause, draft.cause);
  assert.equal(state.form.value.conclusion, draft.conclusion);
  state.form.value.cause = '人工补充的根因'; state.close(); first.stop();
  const second = effectScope(), restored = second.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => second.stop());
  await restored.show(record); assert.equal(restored.form.value.cause, '人工补充的根因');
  assert.equal(restored.form.value.conclusion, draft.conclusion);
  assert.deepEqual(requests, ['GET', 'GET']);
});

test('浏览器手改稿不跨事项、运行或结果来源恢复，存储不可用时仍恢复服务端稿', async t => {
  browserStorage(t);
  const latest = context();
  t.mock.method(globalThis, 'fetch', async () => Response.json(latest));
  const scope = effectScope(), state = scope.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => scope.stop());
  await state.show(record); Object.assign(state.form.value, draft); state.close();
  await state.show({ id: randomUUID() } as JiraFixRecord); assert.equal(state.form.value.cause, '');
  const runId = latest.runId;
  latest.runId = randomUUID(); await state.show(record); assert.equal(state.form.value.cause, '');
  latest.runId = runId; latest.result += '；新的检查结果';
  await state.show(record); assert.equal(state.form.value.cause, '');
  latest.draft = { recordId: record.id, runId: latest.runId, sourceFingerprint: 'b'.repeat(64), draft, updatedAt: new Date().toISOString() };
  t.mock.method(localStorage, 'getItem', () => { throw new Error('存储被禁用'); });
  t.mock.method(localStorage, 'setItem', () => { throw new Error('存储被禁用'); });
  await state.show(record); assert.equal(state.form.value.cause, draft.cause);
  state.form.value.cause = '仍可编辑'; assert.equal(state.form.value.cause, '仍可编辑');
});

test('生成中的手动修改和切换事项后的晚到结果不被覆盖，失败保留当前稿', async t => {
  browserStorage(t);
  let latest = context(), finish!: (value: Response) => void;
  const scope = effectScope(), state = scope.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => scope.stop());
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(latest));
  await state.show(record); Object.assign(state.form.value, draft);
  const editing = state.generate(); state.form.value.cause = '生成期间手改';
  finish(Response.json({ ...draft, cause: '晚到模型文本' })); await editing;
  assert.equal(state.form.value.cause, '生成期间手改'); assert.match(state.error.value, /已保留当前编辑/);
  const failed = state.generate(); finish(Response.json({ message: '模拟生成失败' }, { status: 502 })); await failed;
  assert.equal(state.form.value.cause, '生成期间手改');
  const late = state.generate(); latest = context();
  await state.show({ id: randomUUID() } as JiraFixRecord);
  finish(Response.json(draft)); await late;
  assert.equal(state.form.value.cause, ''); assert.equal(state.context.value?.runId, latest.runId);
});

test('失败后保留提测目标、日期和评论，确认展示日期；修正后可重试且成功才选保持当前状态', async t => {
  const scope = effectScope(), state = scope.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => scope.stop());
  let latest = context(), completed = false;
  const posts: JiraStatusChangeState['input'][] = [], confirmations: string[] = [];
  t.mock.method(ElMessageBox, 'confirm', async (message: string) => { confirmations.push(message); });
  t.mock.method(ElMessage, 'success', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json(latest);
    const input = JSON.parse(String(init.body)); posts.push(input);
    const result: JiraStatusChangeState = { input, status: completed ? 'completed' : 'failed', error: completed ? '' : '目标开始日期校验失败', updatedAt: '' };
    if (completed) { latest.issue.status = { id: 'test', name: '测试中' }; latest.transitions = []; delete latest.testingPath; result.result = latest.issue; }
    latest.statusChange = result;
    return Response.json(result);
  });
  await state.show(record);
  assert.equal(state.form.value.transitionId, '__testing__');
  assert.equal(state.canApplyStatus.value, false);
  Object.assign(state.form.value, { cause: '问题原因', impact: '范围', suggestion: '建议', conclusion: '结论' });
  state.transitionFields.value = { customfield_10109: '2026-09-30', staleField: '2026-09-29' };
  assert.equal(state.canApplyStatus.value, true);
  await state.applyStatus();
  assert.equal(state.form.value.transitionId, '__testing__'); assert.equal(state.canApplyStatus.value, true);
  assert.equal(state.form.value.cause, '问题原因'); assert.equal(state.transitionFields.value.customfield_10109, '2026-09-30');
  assert.equal(state.error.value, '目标开始日期校验失败');
  assert.deepEqual(posts[0]!.transitionFields, { customfield_10109: '2026-09-30' });
  assert.deepEqual(posts[0]!.viaStatusIds, ['design', 'dev']);
  assert.match(confirmations[0]!, /目标开始日期：2026-09-30/);
  assert.equal(posts.length, 1);
  completed = true; await state.applyStatus();
  assert.notEqual(posts[0]!.requestId, posts[1]!.requestId);
  assert.equal(state.form.value.transitionId, '__current__'); assert.equal(state.canApplyStatus.value, false);
  assert.equal(state.form.value.cause, '问题原因');
});

test('失败后重新匹配直接流转；权限消失或写入不确定时禁止重试', async t => {
  const scope = effectScope(), state = scope.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => scope.stop());
  let latest = context(), mode: 'available' | 'removed' | 'uncertain' = 'available', writes = 0;
  t.mock.method(ElMessageBox, 'confirm', async () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json(latest);
    writes++;
    const result: JiraStatusChangeState = { input: JSON.parse(String(init.body)), status: mode === 'uncertain' ? 'uncertain' : 'failed',
      error: '流转失败', updatedAt: '', inFlightStatusId: 'design' };
    latest.transitions[0]!.id = 'new-transition';
    if (mode === 'removed') { latest.transitions = []; delete latest.testingPath; }
    latest.statusChange = result;
    return Response.json(result);
  });
  for (const choice of ['available', 'removed', 'uncertain'] as const) {
    mode = choice; latest = context(); await state.show(record);
    state.form.value.transitionId = '11'; state.transitionFields.value.customfield_10109 = '2026-09-30';
    await state.applyStatus();
    assert.equal(state.form.value.transitionId, mode === 'removed' ? '' : 'new-transition');
    assert.equal(state.canApplyStatus.value, mode === 'available');
  }
  await state.applyStatus(); assert.equal(writes, 3);
});

test('取消确认不发送写请求，读取失败不开放旧工作流重试', async t => {
  const scope = effectScope(), state = scope.run(() => useJiraFixHandoff(async () => {}))!;
  t.after(() => scope.stop());
  const latest = context(); let posted = false, cancel = true;
  t.mock.method(ElMessageBox, 'confirm', async () => { if (cancel) throw new Error('cancel'); });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posted = true; return Response.json({ input: JSON.parse(String(init.body)), status: 'failed', error: 'Jira 校验失败', updatedAt: '' }); }
    return posted ? Response.json({}, { status: 502 }) : Response.json(latest);
  });
  await state.show(record); state.transitionFields.value.customfield_10109 = '2026-09-30';
  state.form.value.cause = '保留草稿';
  await state.applyStatus(); assert.equal(posted, false); assert.equal(state.canApplyStatus.value, true);
  cancel = false; await state.applyStatus();
  assert.equal(state.canApplyStatus.value, false); assert.equal(state.form.value.cause, '保留草稿');
  assert.match(state.error.value, /最新可选状态读取失败/);
});

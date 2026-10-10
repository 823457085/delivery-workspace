/** 测试真实表单状态与请求，所有 Jira 网络写入均由 fetch 替身拦截。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { effectScope } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useJiraFixHandoff } from '../src/features/jira-fix/useJiraFixHandoff.js';
import type { JiraFixHandoffContext, JiraStatusChangeState } from '../shared/jira-fix-handoff.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';

const record = { id: randomUUID() } as JiraFixRecord;
function context(): JiraFixHandoffContext {
  return { runId: randomUUID(), result: '定向测试通过', issue: { key: 'TEST-123', summary: '缺陷', status: { id: 'start', name: '待开始' },
    reporter: { id: 'qa', name: '报告人', kind: 'name', active: true }, assignee: null },
    transitions: [{ id: '11', name: 'Start', to: { id: 'design', name: '设计中' }, dateFields: [
      { id: 'customfield_10109', name: '目标开始日期', required: true },
      { id: 'customfield_10110', name: '目标结束日期', required: false },
    ] }], testingPath: { transitionId: '11', statuses: [{ id: 'design', name: '设计中' }, { id: 'dev', name: '开发中' }, { id: 'test', name: '测试中' }] } };
}

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

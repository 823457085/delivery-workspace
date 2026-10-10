/** 用受控 Jira 替身测试真实交接状态机，不向用户 Jira 发送写请求。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJiraFixHandoffService } from '../server/jira-fix-handoff.js';
import { createJiraHandoffClient, type JiraHandoffSource } from '../server/jira-handoff-client.js';
import { jiraFixHandoffInputSchema, jiraFixHandoffComment, type JiraHandoffIssue, type JiraFixHandoffInput } from '../shared/jira-fix-handoff.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';
import { jiraCommentArguments, jiraCommentPrompt, type JiraCommentGenerator } from '../server/jira-comment-generator.js';
import { jiraCommentGenerateSchema, type JiraCommentDraft } from '../shared/jira-fix-handoff.js';

async function fixture(generator?: JiraCommentGenerator) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-handoff-test-'));
  const id = randomUUID(), run = { id: randomUUID(), status: 'completed', result: '定向检查通过，浏览器未验证' } as AgentRun;
  const record = { id, input: { issueKey: 'TEST-123' } } as JiraFixRecord;
  const issue: JiraHandoffIssue = { key: 'TEST-123', summary: '缺陷', status: { id: '1', name: '开发中' },
    reporter: { id: 'qa-name', name: '测试报告人', kind: 'name', active: true }, assignee: null };
  const input: JiraFixHandoffInput = { runId: run.id, transitionId: '21', targetStatusId: '2', reporterId: 'qa-name',
    cause: '校验遗漏，已补齐校验', impact: '编辑入口', suggestion: '验证空值和正常保存', conclusion: '定向检查通过，浏览器未验证', authorization: 'comment-transition-assign-reporter' };
  const writes: string[] = []; let comment = '';
  const source: JiraHandoffSource = {
    statuses: async () => [{ id: '1', name: '开发中' }, { id: '2', name: '待测试' }, { id: '3', name: '已完成' }],
    readIssue: async () => structuredClone(issue),
    transitions: async () => [{ id: '21', name: '提交测试', to: { id: '2', name: '待测试' } }],
    comment: async (_key, body) => { writes.push('comment'); comment = body; return '101'; },
    transition: async () => { writes.push('transition'); issue.status = { id: '2', name: '待测试' }; },
    assign: async (_key, value) => { writes.push('assign'); issue.assignee = value; },
    readComment: async () => comment,
  };
  const find = () => ({ record, run });
  const service = await createJiraFixHandoffService(directory, find, source, generator);
  return { directory, id, run, record, input, issue, writes, source, service, find,
    close: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

const draft: JiraCommentDraft = { cause: '缺少空值校验，已补齐', impact: '编辑页面', suggestion: '回归空值和正常值', conclusion: '定向检查通过，浏览器未验证' };
function statusInput(runId: string) {
  return { requestId: randomUUID(), runId, fromStatusId: '1', transitionId: '21', targetStatusId: '2', authorization: 'transition-jira-status' };
}
async function testingFixture() {
  const f = await fixture();
  const statuses = [{ id: 'start', name: '待开始' }, { id: 'design', name: '设计中' }, { id: 'dev', name: '开发中' }, { id: 'test', name: '测试中' }, { id: 'done', name: '已完成' }];
  f.issue.status = statuses[0]!;
  f.source.statuses = async () => statuses;
  f.source.transitions = async () => {
    const index = statuses.findIndex(item => item.id === f.issue.status.id);
    return index < 3 ? [{ id: `action-${index}`, name: '下一步', to: statuses[index + 1]! }] : [];
  };
  f.source.transition = async (_key, id) => {
    const next = (await f.source.transitions('TEST-123')).find(item => item.id === id);
    assert.ok(next); f.writes.push(id); f.issue.status = next.to;
  };
  const input = { ...statusInput(f.run.id), fromStatusId: 'start', transitionId: 'action-0', targetStatusId: 'test', viaStatusIds: ['design', 'dev'] };
  return { ...f, input, statuses };
}
test('选择测试中展示完整顺序，每步查真实流转并回读，终点停在测试中', async () => {
  const f = await testingFixture();
  try {
    assert.deepEqual((await f.service.context(f.id)).testingPath, { transitionId: 'action-0', statuses: f.statuses.slice(1, 4) });
    assert.deepEqual(f.writes, []);
    const state = await f.service.applyStatus(f.id, f.input);
    assert.equal(state.status, 'completed'); assert.equal(state.result?.status.name, '测试中');
    assert.deepEqual(f.writes, ['action-0', 'action-1', 'action-2']);
    assert.equal((await f.service.context(f.id)).testingPath, undefined);
    await f.service.applyStatus(f.id, f.input); assert.equal(f.writes.length, 3);
  } finally { await f.close(); }
});
test('提测拒绝篡改中间状态、顺序和终点，不将目录当成可达权限', async () => {
  const f = await testingFixture();
  try {
    for (const override of [{ viaStatusIds: ['dev', 'design'] }, { viaStatusIds: ['dev'] }, { targetStatusId: 'done' }, { transitionId: 'design' }]) {
      await assert.rejects(f.service.applyStatus(f.id, { ...f.input, ...override }), /提测路径已变化/);
    }
    f.source.transitions = async () => [];
    assert.equal((await f.service.context(f.id)).testingPath, undefined);
    await assert.rejects(f.service.applyStatus(f.id, f.input), /提测路径已变化/);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});
test('中间步骤无权限立即停止，可从已到达状态重新选择继续，不回滚或重复首步', async () => {
  const f = await testingFixture();
  try {
    const transitions = f.source.transitions;
    f.source.transitions = key => f.issue.status.id === 'design' ? Promise.resolve([]) : transitions(key);
    const state = await f.service.applyStatus(f.id, f.input);
    assert.equal(state.status, 'failed'); assert.equal(state.result?.status.id, 'design');
    assert.deepEqual(f.writes, ['action-0']);
    f.source.transitions = transitions;
    const result = await f.service.applyStatus(f.id, { ...f.input, requestId: randomUUID(), fromStatusId: 'design', transitionId: 'action-1', viaStatusIds: ['dev'] });
    assert.equal(result.status, 'completed'); assert.deepEqual(f.writes, ['action-0', 'action-1', 'action-2']);
  } finally { await f.close(); }
});
test('中间步骤回读失败重启后只核对已执行步骤，重新确认后才能继续提测', async () => {
  const f = await testingFixture();
  try {
    const read = f.source.readIssue, transition = f.source.transition;
    f.source.transition = async (key, id) => { await transition(key, id); f.source.readIssue = async () => { throw new Error('offline'); }; };
    const state = await f.service.applyStatus(f.id, f.input);
    assert.equal(state.status, 'uncertain'); assert.equal(state.inFlightStatusId, 'design');
    f.source.readIssue = read; f.source.transition = transition;
    const restored = await createJiraFixHandoffService(f.directory, f.find, f.source);
    try {
      assert.equal((await restored.applyStatus(f.id, f.input)).status, 'failed');
      assert.deepEqual(f.writes, ['action-0']);
      assert.equal((await restored.applyStatus(f.id, { ...f.input, requestId: randomUUID(), fromStatusId: 'design', transitionId: 'action-1', viaStatusIds: ['dev'] })).status, 'completed');
      assert.deepEqual(f.writes, ['action-0', 'action-1', 'action-2']);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
test('单独状态生效无需评论或报告人，回读成功并持久化防止重放', async () => {
  const f = await fixture();
  try {
    f.issue.reporter = null;
    const input = statusInput(f.run.id);
    const result = await f.service.applyStatus(f.id, input);
    assert.equal(result.status, 'completed'); assert.equal(result.result?.status.id, '2');
    assert.deepEqual(f.writes, ['transition']); assert.equal(f.service.state(f.id), undefined);
    const restored = await createJiraFixHandoffService(f.directory, f.find, f.source);
    try {
      assert.equal((await restored.context(f.id)).statusChange?.status, 'completed');
      await restored.applyStatus(f.id, input); assert.deepEqual(f.writes, ['transition']);
      await assert.rejects(restored.applyStatus(f.id, { ...input, targetStatusId: '3' }), /不能更换目标/);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
test('状态生效拒绝过期轮次、过期状态、伪造流转和缺失授权', async () => {
  const f = await fixture();
  try {
    for (const override of [{ runId: randomUUID() }, { fromStatusId: '9' }, { transitionId: '3', targetStatusId: '3' }, { authorization: '' }, { comment: '不应发布' }, { targetStatusId: '1' }]) {
      await assert.rejects(f.service.applyStatus(f.id, { ...statusInput(f.run.id), ...override }));
    }
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});
test('状态生效与重复提交、评论生成及完整交接互斥', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.source.transition = () => new Promise(resolve => { release = () => { f.writes.push('transition'); f.issue.status.id = '2'; resolve(); }; });
    const task = f.service.applyStatus(f.id, statusInput(f.run.id));
    await assert.rejects(f.service.applyStatus(f.id, statusInput(f.run.id)), /正在处理/);
    await assert.rejects(f.service.submit(f.id, f.input), /状态正在生效/);
    await assert.rejects(f.service.generate(f.id, { runId: f.run.id, draft: {}, feedback: '', authorization: 'generate-jira-comment' }), /状态正在生效/);
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release); release(); assert.equal((await task).status, 'completed');
    assert.deepEqual(f.writes, ['transition']);
  } finally { await f.close(); }
});
test('状态写入超时但回读已达到目标，可以确认成功而不重发', async () => {
  const f = await fixture();
  try {
    f.source.transition = async () => { f.writes.push('transition'); f.issue.status.id = '2'; throw new Error('timeout'); };
    assert.equal((await f.service.applyStatus(f.id, statusInput(f.run.id))).status, 'completed');
    assert.deepEqual(f.writes, ['transition']);
  } finally { await f.close(); }
});
test('状态回读失败和重启不能触发重复流转，也不允许交接绕过未确认写入', async () => {
  const f = await fixture();
  try {
    const read = f.source.readIssue;
    f.source.transition = async () => { f.writes.push('transition'); f.source.readIssue = async () => { throw new Error('offline'); }; };
    const input = statusInput(f.run.id);
    assert.equal((await f.service.applyStatus(f.id, input)).status, 'uncertain');
    const restored = await createJiraFixHandoffService(f.directory, f.find, f.source);
    try {
      f.source.readIssue = read;
      await assert.rejects(restored.applyStatus(f.id, input), /结果不确定/);
      await assert.rejects(restored.submit(f.id, f.input), /结果不确定/);
      f.issue.status.id = '2';
      assert.equal((await restored.applyStatus(f.id, input)).status, 'completed');
      assert.deepEqual(f.writes, ['transition']);
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
test('明确拒绝可重新选择后重试；已有交接记录不允许单独改状态', async () => {
  const f = await fixture();
  try {
    const transition = f.source.transition;
    f.source.transition = async () => { throw Object.assign(new Error('HTTP 400'), { definite: true }); };
    assert.equal((await f.service.applyStatus(f.id, statusInput(f.run.id))).status, 'failed');
    f.source.transition = transition;
    assert.equal((await f.service.applyStatus(f.id, statusInput(f.run.id))).status, 'completed');
    await f.service.submit(f.id, f.input);
    await assert.rejects(f.service.applyStatus(f.id, statusInput(f.run.id)), /已有交接记录/);
    assert.deepEqual(f.writes, ['transition', 'comment', 'assign']);
  } finally { await f.close(); }
});
test('生成及按反馈重写携带证据和手改稿，不发布 Jira、不保存交接状态', async () => {
  const seen: Parameters<JiraCommentGenerator>[0][] = [];
  const f = await fixture(async evidence => { seen.push(evidence); return { ...draft, impact: evidence.feedback || draft.impact }; });
  try {
    const input = { runId: f.run.id, draft: {}, feedback: '', authorization: 'generate-jira-comment' };
    assert.deepEqual(await f.service.generate(f.id, input), draft);
    const modified = { ...draft, cause: '开发手动补充的根因' };
    assert.equal((await f.service.generate(f.id, { ...input, draft: modified, feedback: '还影响新增页面' })).impact, '还影响新增页面');
    assert.deepEqual(seen[1]!.draft, modified); assert.equal(seen[0]!.result, f.run.result);
    assert.equal(seen[0]!.issue.key, 'TEST-123'); assert.deepEqual(f.writes, []);
    assert.equal(f.service.state(f.id), undefined); assert.deepEqual(await fs.readdir(f.directory), []);
    await assert.rejects(f.service.generate(f.id, { ...input, runId: randomUUID() }), /新一轮/);
    await f.service.submit(f.id, f.input);
    await assert.rejects(f.service.generate(f.id, input), /已有交接记录/);
  } finally { await f.close(); }
});
test('生成中的重复请求和发布被阻止；完成时再次核对修复轮次', async () => {
  let finish!: (value: JiraCommentDraft) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const input = { runId: f.run.id, draft: {}, feedback: '', authorization: 'generate-jira-comment' };
    const pending = f.service.generate(f.id, input);
    await assert.rejects(f.service.generate(f.id, input), /正在生成/);
    await assert.rejects(f.service.submit(f.id, f.input), /等待评论生成/);
    f.run.id = randomUUID(); finish(draft);
    await assert.rejects(pending, /新一轮/); assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});
test('旧占位草稿可以重写，生成结果禁止占位文字并保留未验证事实', async () => {
  const f = await fixture(async evidence => ({ ...draft, conclusion: evidence.feedback || evidence.draft.conclusion! }));
  try {
    const input = { runId: f.run.id, draft: { ...draft, conclusion: '【待开发填写】浏览器回归结果' }, feedback: '', authorization: 'generate-jira-comment' };
    assert.equal(jiraCommentGenerateSchema.safeParse(input).success, true);
    for (const conclusion of ['【待开发填写】浏览器回归结果', '【待开发确认】接口验证结果']) {
      await assert.rejects(f.service.generate(f.id, { ...input, draft: { ...draft, conclusion } }), /请先确认并补全交接说明/);
    }
    const rewritten = await f.service.generate(f.id, { ...input, feedback: '定向检查通过，尚未进行浏览器回归' });
    assert.equal(rewritten.conclusion, '定向检查通过，尚未进行浏览器回归');
    assert.equal(jiraFixHandoffInputSchema.safeParse({ ...f.input, ...rewritten }).success, true);
    assert.doesNotMatch(jiraFixHandoffComment(rewritten), /【待开发(?:填写|确认)】/);
    assert.deepEqual(f.writes, []); assert.equal(f.service.state(f.id), undefined);
  } finally { await f.close(); }
});
test('取消和无效模型输出不形成交接记录，下一次可以重新生成', async () => {
  const f = await fixture(async (_evidence, signal) => { signal.throwIfAborted(); return { cause: '不完整' } as JiraCommentDraft; });
  try {
    const input = { runId: f.run.id, draft: {}, feedback: '', authorization: 'generate-jira-comment' };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.service.generate(f.id, input, controller.signal));
    await assert.rejects(f.service.generate(f.id, input));
    assert.equal(f.service.state(f.id), undefined); assert.deepEqual(f.writes, []);
    assert.equal(jiraCommentGenerateSchema.safeParse({ ...input, feedback: 'x'.repeat(6001) }).success, false);
    assert.equal(jiraCommentGenerateSchema.safeParse({ ...input, authorization: 'comment-transition-assign-reporter' }).success, false);
  } finally { await f.close(); }
});
test('评论生成 CLI 独立只读且不加载用户工具，提示词保留未知项和当前稿', () => {
  const args = jiraCommentArguments('/tmp/safe-comment', 'selected-model');
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-schema', 'read-only', 'shell_tool', 'plugins', 'multi_agent']) assert.ok(args.includes(flag));
  assert.equal(args.includes('resume'), false);
  const prompt = jiraCommentPrompt({ issue: { key: 'TEST-1', summary: '测试缺陷' }, notes: '', result: '浏览器未验证', model: '', draft, feedback: '补充空值边界' });
  assert.match(prompt, /不要写【待开发填写】、【待开发确认】等占位文字/); assert.ok(prompt.includes('补充空值边界'));
  assert.match(prompt, /旧草稿中的占位内容必须按证据改写/);
  assert.ok(prompt.includes('浏览器未验证')); assert.ok(prompt.includes('currentDraft'));
});

test('交接只接受明确授权、四段完整说明和精确身份', () => {
  assert.equal(jiraFixHandoffInputSchema.safeParse({ authorization: 'clone-and-fix-jira' }).success, false);
});
test('完整状态与直接流转独立读取，不可直达的状态不能用状态 ID 冒充流转 ID', async () => {
  const f = await fixture();
  try {
    const context = await f.service.context(f.id);
    assert.deepEqual(context.statuses?.map(item => item.name), ['开发中', '待测试', '已完成']);
    assert.deepEqual(context.transitions.map(item => item.to.name), ['待测试']);
    await assert.rejects(f.service.submit(f.id, { ...f.input, transitionId: '3', targetStatusId: '3' }), /不可用/);
    assert.deepEqual(f.writes, []);
    f.source.statuses = async () => { throw new Error('permission'); };
    const fallback = await f.service.context(f.id);
    assert.equal(fallback.statuses, undefined); assert.match(fallback.statusWarning!, /完整状态读取失败/);
    assert.equal(fallback.transitions.length, 1);
  } finally { await f.close(); }
});
test('读取不写入；确认后评论、状态、指派按顺序执行并回读，重复请求不重放', async () => {
  const f = await fixture();
  try {
    const context = await f.service.context(f.id);
    assert.equal(context.issue.reporter?.id, 'qa-name'); assert.deepEqual(f.writes, []);
    for (const override of [{ cause: '' }, { cause: '【待开发填写】' }, { authorization: 'wrong' }, { assignee: 'other' }]) {
      await assert.rejects(f.service.submit(f.id, { ...f.input, ...override }));
    }
    const state = await f.service.submit(f.id, f.input);
    assert.equal(state.status, 'completed'); assert.equal(state.result?.assignee?.id, 'qa-name');
    assert.deepEqual(f.writes, ['comment', 'transition', 'assign']);
    assert.match(jiraFixHandoffComment(f.input), /^问题原因：.*\n\n影响范围：.*\n\n测试建议：.*\n\n自测结论：/);
    await f.service.submit(f.id, f.input);
    assert.equal(f.writes.length, 3);
    await assert.rejects(f.service.submit(f.id, { ...f.input, cause: '换内容' }), /已有交接记录/);
  } finally { await f.close(); }
});
test('未完成、新一轮、报告人变化和无效工作流都在写入前阻止', async () => {
  const f = await fixture();
  try {
    f.run.status = 'running'; await assert.rejects(f.service.context(f.id), /尚未结束/);
    await assert.rejects(f.service.submit(f.id, f.input), /尚未结束/);
    f.run.status = 'completed';
    await assert.rejects(f.service.submit(f.id, { ...f.input, runId: randomUUID() }), /新一轮/);
    await assert.rejects(f.service.submit(f.id, { ...f.input, transitionId: 'wrong' }), /不可用/);
    f.issue.reporter!.id = 'new-reporter'; await assert.rejects(f.service.submit(f.id, f.input), /报告人/);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});
test('状态流转失败不指派；重启后重试跳过已经发布的评论', async () => {
  const f = await fixture();
  let restored: Awaited<ReturnType<typeof createJiraFixHandoffService>> | undefined;
  try {
    const transition = f.source.transition;
    f.source.transition = async () => { throw Object.assign(new Error('HTTP 400'), { definite: true }); };
    const state = await f.service.submit(f.id, f.input);
    assert.equal(state.status, 'failed'); assert.equal(state.commentId, '101'); assert.deepEqual(f.writes, ['comment']);
    await f.service.close(); f.source.transition = transition;
    restored = await createJiraFixHandoffService(f.directory, f.find, f.source);
    assert.equal((await restored.submit(f.id, f.input)).status, 'completed');
    assert.deepEqual(f.writes, ['comment', 'transition', 'assign']);
  } finally { await restored?.close(); await f.close(); }
});
test('评论写入超时不继续流转，也不允许盲目重试', async () => {
  const f = await fixture();
  try {
    f.source.comment = async () => { f.writes.push('comment'); throw new Error('timeout'); };
    const state = await f.service.submit(f.id, f.input);
    assert.equal(state.status, 'uncertain'); assert.match(state.error, /不会自动重放/);
    await f.service.submit(f.id, f.input); assert.deepEqual(f.writes, ['comment']);
  } finally { await f.close(); }
});
test('Jira 已在目标状态跳过流转；回读不一致不冒充交接完成', async () => {
  const f = await fixture();
  try {
    f.issue.status = { id: '2', name: '待测试' };
    f.source.assign = async () => { f.writes.push('assign'); };
    const state = await f.service.submit(f.id, f.input);
    assert.equal(state.status, 'failed'); assert.match(state.error, /回读/);
    assert.deepEqual(f.writes, ['comment', 'assign']);
  } finally { await f.close(); }
});
test('并发提交互斥；服务中断写入标记重载后必须人工核对', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.source.comment = () => new Promise(resolve => { release = () => resolve('101'); });
    const task = f.service.submit(f.id, f.input);
    await assert.rejects(f.service.submit(f.id, f.input), /正在提交/);
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release);
    const restored = await createJiraFixHandoffService(f.directory, f.find, f.source);
    assert.equal(restored.state(f.id)?.status, 'uncertain'); await restored.close();
    release(); await task;
  } finally { await f.close(); }
});
test('Jira 客户端使用精确用户标识、transition id，且不传额外业务字段', async () => {
  const calls: unknown[][] = [];
  const client = createJiraHandoffClient(async (...args) => {
    calls.push(args);
    if (args[1].startsWith('?')) return { key: 'TEST-123', fields: { summary: 'x', status: { id: '1', name: '开发中' }, reporter: { name: 'qa', displayName: '报告人', active: true } } };
    return { id: '101' };
  });
  const issue = await client.readIssue('TEST-123');
  await client.comment('TEST-123', 'comment'); await client.transition('TEST-123', '21'); await client.assign('TEST-123', issue.reporter!);
  assert.deepEqual(calls.slice(1), [ ['TEST-123', '/comment', 'POST', { body: 'comment' }],
    ['TEST-123', '/transitions', 'POST', { transition: { id: '21' } }], ['TEST-123', '/assignee', 'PUT', { name: 'qa' }] ]);
});

test('读取 Jira 流转日期元数据，按日期契约传入 fields', async () => {
  const calls: unknown[][] = [];
  const client = createJiraHandoffClient(async (...args) => {
    calls.push(args);
    if (args[1] === '/transitions?expand=transitions.fields') return { transitions: [{ id: '11', name: 'Start', to: { id: '3', name: '设计中' }, fields: {
      customfield_10109: { name: '目标开始日期', required: false, schema: { type: 'date' }, operations: ['set'] },
      summary: { name: '概要', schema: { type: 'string' }, operations: ['set'] },
      readonlyDate: { name: '只读日期', schema: { type: 'date' }, operations: [] },
    } }] };
  });
  assert.deepEqual(await client.transitions('TEST-123'), [{ id: '11', name: 'Start', to: { id: '3', name: '设计中' }, dateFields: [
    { id: 'customfield_10109', name: '目标开始日期', required: false },
  ] }]);
  await client.transition('TEST-123', '11', { customfield_10109: '2026-09-30' });
  assert.deepEqual(calls[1], ['TEST-123', '/transitions', 'POST', { transition: { id: '11' }, fields: { customfield_10109: '2026-09-30' } }]);
});

test('提测日期只传给首步，后续步骤不重发首步字段', async () => {
  const f = await testingFixture();
  try {
    const transitions = f.source.transitions, transition = f.source.transition;
    f.source.transitions = async key => (await transitions(key)).map(item => ({ ...item, ...(f.issue.status.id === 'start'
      ? { dateFields: [{ id: 'customfield_10109', name: '目标开始日期', required: true }] } : {}) }));
    const fields: (Record<string, string> | undefined)[] = [];
    f.source.transition = async (key, id, dates) => { fields.push(dates); await transition(key, id, dates); };
    const state = await f.service.applyStatus(f.id, { ...f.input, transitionFields: { customfield_10109: '2026-09-30' } });
    assert.equal(state.status, 'completed');
    assert.deepEqual(fields, [{ customfield_10109: '2026-09-30' }, undefined, undefined]);
  } finally { await f.close(); }
});

test('写入前拒绝未声明字段、无效日期和缺失必填日期，评论交接同样校验', async () => {
  const f = await fixture();
  try {
    f.source.transitions = async () => [{ id: '21', name: '提交测试', to: { id: '2', name: '待测试' }, dateFields: [
      { id: 'customfield_10109', name: '目标开始日期', required: true },
    ] }];
    for (const dates of [{ summary: '2026-09-30' }, { customfield_10109: '2026-02-30' }, {}]) {
      await assert.rejects(f.service.applyStatus(f.id, { ...statusInput(f.run.id), transitionFields: dates }));
      await assert.rejects(f.service.submit(f.id, { ...f.input, transitionFields: dates }));
    }
    assert.deepEqual(f.writes, []);
    const transition = f.source.transition;
    let written: Record<string, string> | undefined;
    f.source.transition = async (key, id, fields) => { written = fields; await transition(key, id, fields); };
    assert.equal((await f.service.submit(f.id, { ...f.input, transitionFields: { customfield_10109: '2026-09-30' } })).status, 'completed');
    assert.deepEqual(written, { customfield_10109: '2026-09-30' });
  } finally { await f.close(); }
});

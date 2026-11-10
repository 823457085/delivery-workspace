import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { createAgentGroupChat } from '../server/agent-group-chat.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { groupRoomSchema, type GroupMember } from '../shared/agent-group-chat.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentReasoningEffort, AgentRun } from '../shared/agent-runtime.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const report = (value: object) => '```delivery-report\n' + JSON.stringify({ version: 1, ...value }) + '\n```';
const member = (id: string, capability: GroupMember['capability'], model = 'fixture-primary'): GroupMember => ({
  id, name: `自定义${id}`, capability, enabled: true, instructions: `仅执行${id}的已确认职责`,
  binding: { provider: 'codex', model, reasoningEffort: 'high' }, fallbackBinding: null,
});
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean) {
  for (let i = 0; i < 1500; i++) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('自动团队状态超时：' + JSON.stringify(read()));
}
async function fixture(handler?: (context: Context) => Promise<string | undefined>, efforts: AgentReasoningEffort[] = ['high']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-group-auto-')), data = path.join(root, 'data'), source = path.join(root, 'source');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'value.txt'), 'base');
  const calls: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Codex', binary: 'fixture', version: 'fixture', ready: true,
    authenticated: true, message: 'ready', modes: ['ask', 'agent', 'plan'], accessModes: ['workspace', 'full'],
    models: ['fixture-primary', 'fixture-fallback'].map(id => ({ id, label: id, efforts })), defaultModel: 'fixture-primary', writable: true, checkedAt: new Date().toISOString() }),
    execute: async context => {
      calls.push(structuredClone(context.run)); await context.onSession(`fixture:${context.run.id}`);
      const custom = await handler?.(context); if (custom) return custom;
      if (context.run.team?.profileId === 'leader') {
        if (context.run.teamContext?.includes('本次诊断目标节点：')) return report({ coordinationReply: { action: 'observe', text: '仅核对实际运行，保留原范围' } });
        return report({ taskPlan: { templateId: 'engineering', reason: '按用户目标修改value', risk: 'low',
          acceptanceCriteria: [{ id: 'AC-1', text: 'value为updated', source: '用户原话' }], allowedPaths: ['value.txt'],
          needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] } });
      }
      if (context.run.team?.profileId === 'engineer') {
        await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), 'updated');
        return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已更新value' } });
      }
      if (context.run.team?.profileId === 'verifier') return report({ validationEvidence: emptyDeliveryEvidence(),
        taskResult: { role: 'verifier', status: 'succeeded', summary: '已读取副本验证', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '副本value为updated' }] } });
      if (context.run.team?.profileId === 'reviewer') return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '独立只读核对通过', findings: [] } });
      throw new Error('unexpected role ' + context.run.team?.profileId);
    } };
  const runtime = await createAgentRuntimeService(data, { adapters: [adapter], resolveAttachments: async ids => ids.map(id => ({
    attachment: { id, name: `${id}.txt`, mimeType: 'text/plain', size: 4, url: `/fixture/${id}`, createdAt: new Date().toISOString() }, filePath: path.join(source, 'value.txt'),
  })) });
  const team = await createAgentTeamService(data, runtime);
  let group = await createAgentGroupChat(data, runtime, { profiles: defaultTeamProfileConfig, automatic: team });
  await group.saveConfig({ expectedRevision: 1, name: '统一团队', members: [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), member('audit', 'review')] });
  return { root, data, source, runtime, team, calls, get group() { return group; },
    send: (extra: Record<string, unknown> = {}) => group.send({ text: '请修复value并验证', requestId: 'auto-1', workspacePath: source, accessMode: 'workspace', ...extra }),
    done: (id: string) => waitFor(() => group.detail(id), detail => !!detail.collaboration && ['completed', 'blocked', 'needs_decision', 'waiting_input'].includes(detail.collaboration.task.state)),
    reopen: async () => { await group.close(); group = await createAgentGroupChat(data, runtime, { profiles: defaultTeamProfileConfig, automatic: team }); },
    cleanup: async () => { await group.close(); await team.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('自动群聊支持修订已发送的用户消息和删除，原消息保留且不重复创建修订', async () => {
  const f = await fixture(async context => context.run.team?.profileId === 'leader'
    ? report({ conversationReply: { text: '收到你的消息', resumeWorkflow: false } }) : undefined);
  try {
    const sent = await f.send({ text: '你好' });
    await f.done(sent.room.id);
    const sourceId = sent.room.rounds[0].id;
    await f.group.pauseMessage(sent.room.id, sourceId);
    const input = { requestId: 'auto-revision', text: '请改为说明本次范围' };
    await f.group.reviseMessage(sent.room.id, sourceId, input);
    await f.group.reviseMessage(sent.room.id, sourceId, input);
    const updated = await waitFor(() => f.group.detail(sent.room.id), detail => detail.room.rounds[1]?.state === 'completed');
    assert.equal(updated.room.rounds.length, 2);
    assert.equal(updated.room.rounds[0].text, '你好');
    assert.equal(updated.room.rounds[1].revisesMessageId, sourceId);
    assert.equal(updated.room.rounds[1].text, input.text);
    await f.group.remove(sent.room.id);
    await f.reopen();
    assert.equal(f.group.dashboard().rooms.length, 0);
  } finally { await f.cleanup(); }
});

test('自动群聊继续按钮重试不生成新消息或再次消费待办，空操作不改权限', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async context => {
    if (context.run.teamContext?.includes('本次诊断目标节点：')) {
      await hold;
      return report({ coordinationReply: { action: 'observe', text: '已收到本次继续确认' } });
    }
    if (context.run.team?.profileId === 'engineer') return report({ questions: [{ to: 'user', text: '复现已完成，是否开始修复？', blocking: true }] });
  });
  try {
    const sent = await f.send();
    const waiting = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'waiting_input');
    const taskId = waiting.collaboration!.task.id;
    await f.group.action(sent.room.id, 'pause');
    await f.send({ roomId: sent.room.id, requestId: 'keep-pending-target', text: '随后向指定成员确认', memberIds: ['captain'] });
    await f.group.action(sent.room.id, 'continue', { accessMode: 'full' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const before = f.group.detail(sent.room.id), inputs = before.collaboration!.task.chat!.messages.filter(item => item.role === 'user').map(item => item.id);
    const pending = before.collaboration!.task.chat!.pendingInputs.map(item => item.id), calls = f.calls.length;
    assert.equal(before.collaboration!.task.chat!.paused, false);
    const after = await f.group.action(sent.room.id, 'continue', { accessMode: 'workspace' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(after.collaboration!.task.chat!.messages.filter(item => item.role === 'user').map(item => item.id), inputs);
    assert.deepEqual(after.collaboration!.task.chat!.pendingInputs.map(item => item.id), pending);
    assert.deepEqual(after.room.rounds.map(item => [item.id, item.state]), before.room.rounds.map(item => [item.id, item.state]));
    assert.equal(after.collaboration!.task.accessMode, 'full');
    assert.equal(after.room.rounds[0].accessMode, 'full');
    assert.equal(f.calls.length, calls);
    assert.equal(f.team.getTask(taskId).chat!.messages.filter(item => item.role === 'user' && item.text === '继续执行').length, 1);
  } finally { release(); await f.cleanup(); }
});

test('自动群聊尚未创建任务的暂停排队消息仍能第一次继续', async () => {
  const f = await fixture(async context => context.run.team?.profileId === 'leader'
    ? report({ conversationReply: { text: '已处理原排队消息', resumeWorkflow: false } }) : undefined);
  try {
    await f.group.close();
    const stored = JSON.parse(await fs.readFile(path.join(f.data, 'group-chat.json'), 'utf8'));
    const stamp = new Date().toISOString(), roomId = randomUUID();
    const input = { requestId: 'initial-paused-input', requestHash: 'fixture', text: '请解释原排队消息', attachmentIds: [], accessMode: 'workspace', processed: false };
    stored.rooms = [groupRoomSchema.parse({ id: roomId, title: '尚未派发的自动消息', workspacePath: f.source, executionPath: f.source,
      orchestration: 'automatic', paused: true, createdAt: stamp, updatedAt: stamp,
      rounds: [{ id: randomUUID(), requestId: input.requestId, requestHash: input.requestHash, text: input.text,
        attachmentIds: input.attachmentIds, accessMode: input.accessMode, configRevision: stored.config.revision, state: 'queued', turns: [], createdAt: stamp, updatedAt: stamp,
        automatic: { config: stored.config, inputs: [input] } }] })];
    await fs.writeFile(path.join(f.data, 'group-chat.json'), JSON.stringify(stored));
    await f.reopen();
    assert.equal(f.group.detail(roomId).collaboration, undefined);
    await f.group.action(roomId, 'continue', { accessMode: 'full' });
    const done = await f.done(roomId);
    assert.equal(done.room.paused, false); assert.equal(done.collaboration!.task.accessMode, 'full');
    assert.deepEqual(f.calls.map(run => run.objective), ['请解释原排队消息']);
  } finally { await f.cleanup(); }
});

test('修订自动群聊保留同文的独立待办，并在后续指定成员消息前依次执行', async () => {
  let completing = false;
  const f = await fixture(async context => {
    if (!completing) await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return context.run.team?.profileId === 'leader'
      ? report({ conversationReply: { text: '已处理', resumeWorkflow: false } }) : '已处理指定成员消息';
  });
  try {
    const sent = await f.send({ text: '原始要求' });
    await waitFor(() => f.group.detail(sent.room.id), value => !!value.collaboration?.task.id);
    await waitFor(() => f.calls, calls => calls.some(run => run.objective === '原始要求'));
    for (const requestId of ['pending-one', 'pending-two']) {
      await f.send({ roomId: sent.room.id, requestId, text: '再检查一次' });
    }
    await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.chat?.pendingInputs.length === 2);
    await f.send({ roomId: sent.room.id, requestId: 'direct-after-pending', text: '最后向指定成员提问', memberIds: ['captain'] });
    await f.group.pauseMessage(sent.room.id, sent.room.rounds[0].id);
    completing = true;
    const before = f.calls.length;
    await f.group.reviseMessage(sent.room.id, sent.room.rounds[0].id, { requestId: 'edit-with-queue', text: '修订后的要求' });
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds.length === 5
      && value.room.rounds.slice(1).every(round => round.state === 'completed'));
    assert.deepEqual(done.room.rounds.map(round => round.text), ['原始要求', '修订后的要求', '再检查一次', '再检查一次', '最后向指定成员提问']);
    assert.deepEqual(f.calls.slice(before).map(run => run.objective), ['修订后的要求', '再检查一次', '再检查一次', '最后向指定成员提问']);
    assert.notEqual(done.room.rounds[2].requestId, done.room.rounds[3].requestId);
  } finally { completing = true; await f.cleanup(); }
});

test('自动团队已收消息但群聊丢失回执时，修订按请求标识保留一次并维持队列顺序', async () => {
  let completing = false;
  const f = await fixture(async context => {
    if (!completing) await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return report({ conversationReply: { text: '已处理', resumeWorkflow: false } });
  });
  const chat = f.team.chat;
  f.team.chat = async input => {
    const response = await chat(input);
    if (!completing && input.requestId.endsWith(':lost-receipt')) throw new Error('fixture lost receipt');
    return response;
  };
  try {
    const sent = await f.send({ text: '原始要求' });
    await waitFor(() => f.group.detail(sent.room.id), value => !!value.collaboration?.task.id);
    await waitFor(() => f.calls, calls => calls.some(run => run.objective === '原始要求'));
    await f.send({ roomId: sent.room.id, requestId: 'lost-receipt', text: '已转交但丢回执的待办' });
    await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.chat?.pendingInputs.length === 1
      && value.room.rounds[0].automatic?.inputs.some(input => input.requestId === 'lost-receipt' && !input.processed) === true);
    await f.send({ roomId: sent.room.id, requestId: 'not-forwarded', text: '尚未转交的后续待办' });
    await f.group.pauseMessage(sent.room.id, sent.room.rounds[0].id);
    completing = true;
    const before = f.calls.length;
    await f.group.reviseMessage(sent.room.id, sent.room.rounds[0].id, { requestId: 'edit-lost-receipt', text: '修订后的要求' });
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds.length === 4
      && value.room.rounds.slice(1).every(round => round.state === 'completed'));
    assert.deepEqual(done.room.rounds.map(round => round.text), ['原始要求', '修订后的要求', '已转交但丢回执的待办', '尚未转交的后续待办']);
    // 协调会话保留原目标身份，不能把安全停止期间的协调误算为重派原计划。
    assert.deepEqual(f.calls.slice(before).filter(run => !run.teamContext?.includes('本次诊断目标节点：')).map(run => run.objective),
      ['修订后的要求', '已转交但丢回执的待办', '尚未转交的后续待办']);
  } finally { completing = true; f.team.chat = chat; await f.cleanup(); }
});

test('新建全体群聊复用自动计划、验证失败返工与独立审查；成员、权限和职责来自群聊快照', async () => {
  let verifies = 0;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'verifier' && ++verifies === 1) return report({ validationEvidence: emptyDeliveryEvidence(),
      taskResult: { role: 'verifier', status: 'failed', summary: '首轮失败需要返工', acceptance: [{ id: 'AC-1', status: 'failed', evidence: 'fixture first check failure' }],
        findings: [{ id: 'F-1', severity: 'major', file: 'value.txt', problem: '首轮未通过', expectation: '修复并重新验证' }] } });
  });
  try {
    const sent = await f.send(); assert.equal(sent.room.orchestration, 'automatic');
    const done = await f.done(sent.room.id), task = done.collaboration!.task;
    assert.equal(task.state, 'completed', task.reason);
    assert.equal(task.groupRoomId, sent.room.id);
    assert.ok(f.calls.filter(run => run.team?.profileId === 'engineer').length >= 2);
    assert.ok(f.calls.filter(run => run.team?.profileId === 'verifier').length >= 2);
    assert.equal(f.calls.at(-1)!.team?.profileId, 'reviewer');
    assert.ok(f.calls.every(run => run.model === 'fixture-primary'));
    assert.ok(f.calls.filter(run => run.mode === 'agent').every(run => run.accessMode === 'workspace'));
    assert.ok(f.calls.every(run => run.mode === 'agent' && run.accessMode === 'workspace'));
    assert.match(f.calls.find(run => run.team?.profileId === 'engineer')!.teamContext!, /自定义coder.*仅执行coder/s);
    assert.ok(done.room.rounds[0].turns.some(turn => turn.member.name === '自定义qa'));
    assert.ok(groupRoomSchema.safeParse(done.room).success);
    const count = f.calls.length; await f.send(); await f.reopen(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.calls.length, count, '重发和重载不重复派发');
    await assert.rejects(f.send({ text: '同请求不同内容' }), /请求标识/);
  } finally { await f.cleanup(); }
});

test('自动协作每个岗位使用本轮允许事项快照，配置修改不改变已冻结职责与完整权限', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => { if (context.run.team?.profileId === 'leader') await gate; });
  try {
    const roles = [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), member('audit', 'review')]
      .map(role => ({ ...role, allowedActions: `${role.id}首轮允许事项：核对接口、可修改代码` }));
    await f.group.saveConfig({ expectedRevision: 2, name: '可自定义范围', members: roles });
    const sent = await f.send({ accessMode: 'full' });
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'leader'));
    await f.group.saveConfig({ expectedRevision: 3, name: '下一轮范围', members: roles.map(role => ({ ...role, allowedActions: '次轮独有范围' })) });
    release();
    const done = await f.done(sent.room.id), task = done.collaboration!.task;
    assert.equal(task.state, 'completed', task.reason);
    const ids: Record<string, string> = { leader: 'captain', engineer: 'coder', verifier: 'qa', reviewer: 'audit' };
    for (const run of f.calls) {
      const id = ids[run.team!.profileId];
      assert.ok(id, `未预期的岗位 ${run.team!.profileId}`);
      assert.ok(run.teamContext!.includes(`本轮允许做什么：${id}首轮允许事项：核对接口、可修改代码`));
      assert.doesNotMatch(run.teamContext!, /次轮独有范围/);
    }
    assert.ok(f.calls.every(run => run.mode === 'agent' && run.accessMode === 'full'));
    assert.equal(task.groupMembers!.reviewer!.capability, 'review');
    assert.equal(task.groupMembers!.engineer!.allowedActions, roles[1].allowedActions);
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).collaboration!.task.groupMembers!.engineer!.allowedActions, roles[1].allowedActions);
    assert.equal(f.group.dashboard().config.members[1].allowedActions, '次轮独有范围');
  } finally { release(); await f.cleanup(); }
});

test('缺少验证成员时准确阻塞，不从旧岗位设置启用额外模型', async () => {
  const f = await fixture();
  try {
    await f.group.saveConfig({ expectedRevision: 2, name: '缺少验证', members: [member('captain', 'read'), member('coder', 'write'), { ...member('qa', 'verify'), enabled: false }, member('audit', 'review')] });
    const sent = await f.send(), done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'blocked');
    assert.ok(done.collaboration!.task.nodes.some(node => /缺少已启用的验证/.test(node.error || '')));
    assert.ok(!f.calls.some(run => run.team?.profileId === 'verifier' || run.model.startsWith('gpt-')));
  } finally { await f.cleanup(); }
});

for (const fallback of [false, true]) test(`自动协作按配置保留ultra主模型与max${fallback ? '备用' : '审查'}模型，完整派发且不降低强度`, async () => {
  const f = await fixture(undefined, ['high', 'max', 'ultra']);
  try {
    const members = [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), member('audit', 'review')];
    for (const item of members) item.binding!.reasoningEffort = item.capability === 'review' ? 'max' : 'ultra';
    if (fallback) members[3].binding!.model = 'unavailable-primary';
    members[3].fallbackBinding = { provider: 'codex', model: 'fixture-fallback', reasoningEffort: 'max' };
    members[0].fallbackBinding = { provider: 'codex', model: 'fixture-fallback', reasoningEffort: 'high' };
    await f.group.saveConfig({ expectedRevision: 2, name: '原生推理强度团队', members });
    const sent = await f.send(), done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.deepEqual(f.calls.map(run => [run.team!.profileId, run.model, run.reasoningEffort]), [
      ['leader', 'fixture-primary', 'ultra'], ['engineer', 'fixture-primary', 'ultra'],
      ['verifier', 'fixture-primary', 'ultra'], ['reviewer', fallback ? 'fixture-fallback' : 'fixture-primary', 'max'],
    ]);
    assert.ok(f.calls.every(run => run.accessMode === 'workspace'));
    const task = done.collaboration!.task;
    assert.equal(task.profileConfig.profiles.find(profile => profile.id === 'leader')!.reasoningEffort, 'ultra');
    assert.equal(task.profileConfig.profiles.find(profile => profile.id === 'reviewer')!.escalation!.reasoningEffort, 'max');
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).collaboration!.task.nodes.find(node => node.stage === 'review')!.effectiveChoice!.reasoningEffort, 'max');
    assert.equal(f.calls.length, 4, '回读配置与任务不重复派发');
  } finally { await f.cleanup(); }
});

test('不兼容的模型配置保留为阻塞，不偷偷改用默认模型', async () => {
  const f = await fixture();
  try {
    const api = member('captain', 'read'); api.binding = { provider: 'api', model: 'unsupported', reasoningEffort: '' };
    await f.group.saveConfig({ expectedRevision: 2, name: 'API讨论团队', members: [api] });
    const sent = await f.send(), done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'blocked');
    assert.match(done.collaboration!.task.reason!, /暂不支持/);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('未派发的 API 成员不拦截自动群聊附件，定向选中该成员时仍拒绝', async () => {
  const f = await fixture();
  try {
    const api = member('reporter', 'read');
    api.binding = { provider: 'api', model: 'unsupported', reasoningEffort: '' };
    const members = [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), member('audit', 'review'), api];
    await f.group.saveConfig({ expectedRevision: 2, name: '含 API 成员的团队', members });
    const attachmentIds = [randomUUID()];
    const sent = await f.send({ attachmentIds });
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.ok(f.calls.every(run => run.attachments.some(attachment => attachment.id === attachmentIds[0])));

    await assert.rejects(f.send({ roomId: sent.room.id, requestId: 'api-attachment', memberIds: ['reporter'], attachmentIds }), /API 成员暂不支持附件/);
    assert.equal(f.group.detail(sent.room.id).room.rounds.length, 1);
  } finally { await f.cleanup(); }
});

test('自动群聊只在实际派发不支持附件的岗位时报告该岗位阻塞', async () => {
  const f = await fixture();
  try {
    const apiReviewer = member('audit', 'review');
    apiReviewer.binding = { provider: 'api', model: 'unsupported', reasoningEffort: '' };
    const members = [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), apiReviewer];
    await f.group.saveConfig({ expectedRevision: 2, name: 'API 审查团队', members });
    const sent = await f.send({ attachmentIds: [randomUUID()] });
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'blocked');
    const review = done.collaboration!.task.nodes.find(node => node.stage === 'review');
    assert.equal(review?.status, 'blocked');
    assert.match(review?.error || '', /自定义audit.*不支持附件/);
    assert.deepEqual(f.calls.filter(run => run.team?.profileId !== 'leader').map(run => run.team?.profileId), ['engineer', 'verifier']);
  } finally { await f.cleanup(); }
});

test('新建和已有群聊的定向问候只联系指定成员', async () => {
  const f = await fixture(async context => context.run.team?.interactionMode === 'group' ? '定向成员只读回复' : undefined);
  try {
    const sent = await f.send({ memberIds: ['captain'], text: '你好' });
    await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(sent.room.orchestration, undefined); assert.equal(f.calls.length, 1);
    const second = await f.send({ requestId: 'targeted-next', roomId: sent.room.id, memberIds: ['audit'], text: '你好' });
    await waitFor(() => f.group.detail(second.room.id), value => value.room.rounds[1].state === 'completed');
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['captain', 'audit']);
    assert.equal(second.collaboration, undefined);
  } finally { await f.cleanup(); }
});

test('新群聊的普通问候仅负责人回复，不创建实施、验证或审查任务', async () => {
  const f = await fixture(async context => context.run.team?.profileId === 'leader'
    ? report({ conversationReply: { text: '你好！有什么需要帮忙的？', resumeWorkflow: false } }) : undefined);
  try {
    const sent = await f.send({ text: '你好', workspacePath: '' }), done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed');
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['leader']);
    assert.deepEqual(done.collaboration!.task.nodes.map(node => node.stage), ['plan']);
    assert.equal(done.room.rounds[0].turns.length, 1);
    assert.ok(done.collaboration!.task.chat!.messages.some(message => message.role === 'assistant' && message.text === '你好！有什么需要帮忙的？'));
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'base');
  } finally { await f.cleanup(); }
});

test('已有顺序群聊的新问候等待旧轮完成，由负责人继承历史且重载不重复执行', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.interactionMode === 'group') { await gate; return '此前已核实的接口字段保持原文'; }
    if (context.run.team?.profileId === 'leader') return report({ conversationReply: { text: '你好！', resumeWorkflow: false } });
  });
  try {
    const first = await f.send({ memberIds: ['audit'], text: '请核对接口字段' });
    await waitFor(() => f.calls, calls => calls.length === 1);
    const oldTurn = f.group.detail(first.room.id).room.rounds[0].turns[0];
    await f.send({ requestId: 'legacy-greeting', roomId: first.room.id, text: '你好' });
    assert.equal(f.group.detail(first.room.id).room.rounds[0].automatic, undefined);
    assert.equal(f.group.detail(first.room.id).room.rounds[1].automatic?.inputs[0].text, '你好');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1, '旧轮尚未完成时不并发联系负责人');
    release();
    const done = await f.done(first.room.id);
    assert.equal(done.collaboration!.task.state, 'completed');
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['audit', 'leader']);
    assert.equal(done.room.rounds[0].state, 'completed');
    assert.equal(done.room.rounds[0].turns[0].id, oldTurn.id);
    assert.equal(done.room.rounds[0].turns[0].runId, oldTurn.runId);
    assert.match(f.calls[1].teamContext!, /请核对接口字段/);
    assert.match(f.calls[1].teamContext!, /此前已核实的接口字段保持原文/);
    await f.reopen();
    await f.send({ requestId: 'legacy-greeting', roomId: first.room.id, text: '你好' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 2, '重开和重复发送不重跑旧轮或负责人');
    assert.equal(f.group.detail(first.room.id).room.rounds.length, 2);
  } finally { release(); await f.cleanup(); }
});

test('关联 Jira 的群聊续聊仍保留原任务的顺序成员执行', async () => {
  const f = await fixture(async context => context.run.team?.interactionMode === 'group' ? '已完成本岗位核对' : undefined);
  try {
    const sent = await f.group.startJira({ source: { taskId: '11111111-1111-4111-8111-111111111111', workflow: 'requirement', title: 'APEX-602',
      issueKey: 'APEX-602', issueUrl: '', projects: [{ path: f.source, workspacePath: f.source, baseBranch: 'master', branchName: 'feature/fixture', baseSha: 'fixture' }] },
      objective: '按已确认的岗位顺序核对', workspacePath: f.source, accessMode: 'workspace', requestId: 'jira-first', expectedConfigRevision: 2 });
    await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    await f.send({ requestId: 'jira-followup', roomId: sent.room.id, text: '继续核对' });
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[1].state === 'completed');
    assert.equal(done.room.rounds[1].automatic, undefined);
    assert.equal(done.collaboration, undefined);
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['captain', 'coder', 'qa', 'audit', 'captain', 'coder', 'qa', 'audit']);
  } finally { await f.cleanup(); }
});

test('已有顺序群聊暂停后收到问候，重载仍不调度直到明确继续', async () => {
  const f = await fixture(async context => context.run.team?.interactionMode === 'group' ? '已核对历史事实'
    : context.run.team?.profileId === 'leader' ? report({ conversationReply: { text: '你好！', resumeWorkflow: false } }) : undefined);
  try {
    const first = await f.send({ memberIds: ['audit'], text: '请核对历史事实' });
    await waitFor(() => f.group.detail(first.room.id), value => value.room.rounds[0].state === 'completed');
    await f.group.action(first.room.id, 'pause');
    await f.send({ requestId: 'paused-greeting', roomId: first.room.id, text: '你好' });
    await f.reopen();
    await new Promise(resolve => setTimeout(resolve, 50));
    const paused = f.group.detail(first.room.id);
    assert.equal(paused.room.paused, true);
    assert.equal(paused.room.rounds[1].automatic?.taskId, undefined);
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['audit']);
    await f.group.action(first.room.id, 'continue');
    const done = await f.done(first.room.id);
    assert.equal(done.collaboration!.task.state, 'completed');
    assert.deepEqual(f.calls.map(run => run.team!.profileId), ['audit', 'leader']);
  } finally { await f.cleanup(); }
});

test('已完成群聊的范围追问留在原轮，只显示回执且不重新派发成员', async () => {
  const f = await fixture();
  try {
    const sent = await f.send();
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed');
    const before = f.calls.length;
    const input = { roomId: sent.room.id, requestId: 'scope-question', text: '不是我就让你修复一个 本地 构建报错？你到底在干什么？' };
    await f.send(input);
    await f.send(input);
    const after = f.group.detail(sent.room.id);
    assert.equal(after.room.rounds.length, 1);
    assert.equal(after.room.rounds[0].automatic!.taskId, done.collaboration!.task.id);
    assert.equal(after.room.rounds[0].state, 'completed');
    assert.equal(after.collaboration!.task.nodes.length, done.collaboration!.task.nodes.length);
    assert.equal(f.calls.length, before);
    assert.equal(after.collaboration!.task.chat!.messages.filter(message => message.id.startsWith('status-reply:')).length, 1);
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).room.rounds.length, 1);
    assert.equal(f.calls.length, before);
  } finally { await f.cleanup(); }
});

test('活动自动群聊的后续广播追加同一任务，状态消息不重建流程', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer') await gate;
  });
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const before = f.group.detail(sent.room.id).collaboration!.task.id;
    await f.send({ roomId: sent.room.id, requestId: 'status-message', text: '现在进展怎么样' });
    await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration!.task.chat!.messages.some(message => message.text === '现在进展怎么样'));
    assert.equal(f.group.detail(sent.room.id).collaboration!.task.id, before);
    assert.equal(f.group.detail(sent.room.id).room.rounds[0].automatic!.inputs.length, 2);
    release(); const done = await f.done(sent.room.id); assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
  } finally { release(); await f.cleanup(); }
});

test('自动群聊普通成员重试锁定原模型，仅恢复当前失败节点并拒绝旧运行和完成记录', async () => {
  let fail = true;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'leader' && context.run.teamContext?.includes('本次诊断目标节点：')) {
      return report({ coordinationReply: { action: 'ask', text: '当前错误原因未确认，是否允许使用备用模型继续？' } });
    }
    if (context.run.team?.profileId === 'reviewer' && fail) { fail = false; throw new Error('未识别的 CLI 运行错误（退出码 1）'); }
  });
  try {
    const audit = member('audit', 'review'); audit.fallbackBinding = { provider: 'codex', model: 'fixture-fallback', reasoningEffort: 'high' };
    await f.group.saveConfig({ expectedRevision: 2, name: '成员原模型重试', members: [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), audit] });
    const sent = await f.send();
    const failed = await waitFor(() => f.group.detail(sent.room.id), value => f.team.isIdle()
      && value.room.rounds[0].turns.some(turn => turn.member.id === 'audit' && turn.error.includes('未识别'))
      && value.collaboration!.task.nodes.some(node => node.purpose === 'coordinate' && node.status === 'waiting_input')
      && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const turn = failed.room.rounds[0].turns.find(turn => turn.member.id === 'audit')!;
    const input = { turnId: turn.id, runId: turn.runId }, taskId = failed.collaboration!.task.id;
    const question = f.team.ledger.messages(taskId).find(message => message.type === 'ask' && message.to.kind === 'user')!;
    const unrelated = await f.team.ledger.send({ workflowId: taskId, nodeId: 'unrelated-node:1', type: 'ask', from: { kind: 'profile', profileId: 'analyst' },
      to: { kind: 'user' }, text: '独立问题必须保留', dedupeKey: 'unrelated-question', blocking: false });
    const before = f.calls.filter(run => !['leader', 'reviewer'].includes(run.team!.profileId)).map(run => run.id);
    await assert.rejects(f.group.retryAndContinue(sent.room.id, { ...input, runId: sent.room.id }), /当前已确认停止/);
    const expire = f.team.ledger.expireNodeQuestions;
    f.team.ledger.expireNodeQuestions = async (...args) => { await expire(...args); throw new Error('fixture 问题已过期但回执丢失'); };
    try { await assert.rejects(f.group.retryAndContinue(sent.room.id, input), /回执丢失/); }
    finally { f.team.ledger.expireNodeQuestions = expire; }
    assert.equal(f.team.ledger.messages(taskId).find(message => message.id === question.id)!.processing, 'expired');
    assert.equal(f.team.getTask(taskId).nodes.find(node => `${node.id}:${node.attempt}` === question.nodeId)!.status, 'skipped', '账本成功但回执失败后不恢复旧协调问题');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'reviewer').length, 1, '异常回执不派发新运行');
    const results = await Promise.allSettled([f.group.retryAndContinue(sent.room.id, input), f.group.retryAndContinue(sent.room.id, input)]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.equal(f.team.ledger.messages(taskId).find(message => message.id === question.id)!.processing, 'expired');
    assert.equal(f.team.ledger.messages(taskId).find(message => message.id === unrelated.id)!.processing, 'pending');
    assert.equal(done.collaboration!.task.chat!.messages.some(message => message.replyTo === question.id), false, '选择原模型重试不伪造备用授权回答');
    assert.deepEqual(f.calls.filter(run => !['leader', 'reviewer'].includes(run.team!.profileId)).map(run => run.id), before);
    const [original, retried] = f.calls.filter(run => run.team?.profileId === 'reviewer');
    assert.deepEqual([retried.provider, retried.model, retried.reasoningEffort, retried.mode, retried.accessMode],
      [original.provider, original.model, original.reasoningEffort, original.mode, original.accessMode]);
    assert.equal(f.runtime.getRun(input.runId)!.status, 'failed');
    const latest = done.room.rounds[0].turns.find(turn => turn.id === input.turnId)!;
    await assert.rejects(f.team.retryGroupNode(taskId, { nodeId: latest.id, runId: latest.runId }), /当前已确认停止/);
    await f.reopen(); await assert.rejects(f.group.retryAndContinue(sent.room.id, input), /当前已确认停止/);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'reviewer').length, 2);
  } finally { await f.cleanup(); }
});

for (const profileId of ['engineer', 'reviewer'] as const) test(`自动群聊文本继续只重试失败${profileId}，并发继续不重放计划或已完成岗位`, async () => {
  let attempts = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async context => {
    if (context.run.teamContext?.includes('本次诊断目标节点：')) throw new Error('workspace routing discovery timed out');
    if (context.run.team?.profileId !== profileId) return;
    if (++attempts === 1) throw new Error('workspace routing discovery timed out');
    await hold;
  });
  try {
    const sent = await f.send();
    const blocked = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'blocked'
      && f.team.isIdle() && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const taskId = blocked.collaboration!.task.id, failed = blocked.collaboration!.task.nodes.find(node => node.profileId === profileId)!;
    assert.equal(blocked.collaboration!.task.nodes.find(node => node.purpose === 'coordinate')!.status, 'blocked');
    assert.equal(blocked.collaboration!.task.chat!.coordination?.phase, 'needs_input');
    const original = f.runtime.getRun(failed.runId!)!, completedCalls = f.calls.filter(run => run.team?.profileId !== profileId).map(run => run.id);
    const plans = blocked.collaboration!.task.nodes.filter(node => node.stage === 'plan').map(node => node.id);
    await f.send({ roomId: sent.room.id, requestId: 'resume-failed-text', text: '继续执行', accessMode: 'full' });
    await waitFor(() => f.group.detail(sent.room.id), value => attempts === 2 && value.collaboration!.task.nodes.some(node => node.id === failed.id && node.status === 'running'));
    const followup = { taskId, objective: '继续执行', attachmentIds: [], accessMode: 'full' as const, requestId: 'resume-again-one' };
    await Promise.all([f.team.chat(followup), f.team.chat({ ...followup, requestId: 'resume-again-two' }), f.team.chat(followup)]);
    const active = f.team.getTask(taskId), retried = f.calls.filter(run => run.team?.profileId === profileId).at(-1)!;
    assert.equal(attempts, 2); assert.equal(active.accessMode, original.accessMode);
    assert.deepEqual(active.nodes.filter(node => node.stage === 'plan').map(node => node.id), plans);
    assert.deepEqual(f.calls.filter(run => run.team?.profileId !== profileId).map(run => run.id), completedCalls);
    assert.deepEqual([retried.provider, retried.model, retried.reasoningEffort, retried.accessMode],
      [original.provider, original.model, original.reasoningEffort, original.accessMode]);
    assert.equal(active.nodes.find(node => node.id === failed.id)!.attempt, failed.attempt + 1);
    assert.equal(active.nodes.find(node => node.purpose === 'coordinate')!.status, 'skipped');
    assert.equal(active.chat!.pendingInputs.length, 0);
    assert.equal(active.chat!.messages.filter(message => message.requestId === followup.requestId).length, 1);
    release();
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'completed');
    assert.equal(done.room.rounds.length, 1); assert.equal(f.runtime.getRun(original.id)!.status, 'failed');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, profileId === 'engineer' ? 2 : 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'verifier').length, 1);
  } finally { release(); await f.cleanup(); }
});

for (const uncertain of ['pid', 'pending', 'active', 'needs-review', 'unknown'] as const) test(`自动群聊文本继续不重派停止状态未确认的运行：${uncertain}`, async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'reviewer') throw new Error('workspace routing discovery timed out');
  });
  let original: AgentRun | undefined, saved: AgentRun | undefined;
  try {
    const sent = await f.send();
    const blocked = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'blocked'
      && f.team.isIdle() && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const taskId = blocked.collaboration!.task.id, failed = blocked.collaboration!.task.nodes.find(node => node.profileId === 'reviewer')!;
    original = f.runtime.getRun(failed.runId!)!; saved = structuredClone(original);
    if (uncertain === 'pid') original.pid = process.pid;
    else if (uncertain === 'unknown') { original.status = 'interrupted'; original.recovery = undefined; }
    else original.recovery = { previousStatus: 'running', previousPid: null, state: uncertain, checkedAt: new Date().toISOString(), message: '核对原运行中' };
    const calls = f.calls.length;
    await f.team.chat({ taskId, objective: '继续执行', attachmentIds: [], requestId: `uncertain-${uncertain}`, accessMode: 'full' });
    const after = f.team.getTask(taskId);
    assert.equal(f.calls.length, calls); assert.equal(after.accessMode, 'workspace');
    assert.deepEqual(after.nodes.map(node => [node.id, node.runId, node.attempt]), blocked.collaboration!.task.nodes.map(node => [node.id, node.runId, node.attempt]));
    assert.equal(after.chat!.pendingInputs.length, 0);
  } finally { if (original && saved) { original.status = saved.status; original.pid = saved.pid; original.recovery = saved.recovery; } await f.cleanup(); }
});

test('自动群聊文本继续保留有效业务问题，不把控制词写成用户答案或重放完成步骤', async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer') return report({ questions: [{ to: 'user', text: '请提供测试环境地址', blocking: true }] });
    if (context.run.teamContext?.includes('本次诊断目标节点：')) return report({ coordinationReply: { action: 'ask', text: '仍需要测试环境地址，继续指令没有提供地址' } });
  });
  try {
    const sent = await f.send();
    const waiting = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'waiting_input' && f.team.isIdle());
    const taskId = waiting.collaboration!.task.id, original = waiting.collaboration!.task.nodes.find(node => node.stage === 'implement')!;
    const question = f.team.ledger.messages(taskId).find(item => item.type === 'ask' && item.to.kind === 'user')!;
    await f.team.chat({ taskId, objective: '继续执行', attachmentIds: [], requestId: 'continue-with-unanswered-question' });
    await waitFor(() => f.team.getTask(taskId), task => f.team.isIdle() && task.nodes.some(node => node.purpose === 'coordinate' && node.status === 'waiting_input'));
    const after = f.team.getTask(taskId), messages = f.team.ledger.messages(taskId);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 1);
    assert.equal(after.nodes.find(node => node.id === original.id)!.runId, original.runId);
    assert.equal(after.nodes.filter(node => node.stage === 'plan' && !node.purpose).length, 1);
    assert.equal(messages.find(item => item.id === question.id)!.processing, 'pending');
    assert.equal(messages.some(item => item.type === 'back' && item.answerTo === question.id), false);
    assert.equal(after.chat!.messages.some(item => item.replyTo === question.id), false);
  } finally { await f.cleanup(); }
});

test('自动群聊文本继续不绕过原生已完成的业务验证阻塞，后继诊断超时也不重派', async () => {
  const f = await fixture(async context => {
    if (context.run.teamContext?.includes('本次诊断目标节点：')) throw new Error('workspace routing discovery timed out');
    return context.run.team?.profileId === 'verifier' ? report({
    validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'blocked', summary: '缺少真实接口证据',
      acceptance: [{ id: 'AC-1', status: 'blocked', evidence: '未完成真实接口检查' }], blockers: ['缺少测试环境'] },
    }) : undefined;
  });
  try {
    const sent = await f.send();
    const blocked = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'blocked'
      && f.team.isIdle() && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const taskId = blocked.collaboration!.task.id, original = blocked.collaboration!.task.nodes.find(node => node.stage === 'verify')!;
    assert.equal(f.runtime.getRun(original.runId!)!.status, 'completed');
    const coordinator = blocked.collaboration!.task.nodes.find(node => node.purpose === 'coordinate')!;
    assert.equal(coordinator.status, 'blocked'); assert.equal(f.runtime.getRun(coordinator.runId!)!.status, 'failed');
    const calls = f.calls.length;
    await f.team.chat({ taskId, objective: '继续执行', attachmentIds: [], requestId: 'continue-business-blocker' });
    const after = f.team.getTask(taskId);
    assert.equal(f.calls.length, calls); assert.equal(after.state, 'blocked');
    assert.deepEqual(after.nodes.map(node => [node.id, node.runId, node.attempt]), blocked.collaboration!.task.nodes.map(node => [node.id, node.runId, node.attempt]));
    assert.equal(after.chat!.pendingInputs.length, 0);
  } finally { await f.cleanup(); }
});

test('审查运行额度失败不引入外部模型；显式备用只重试当前审查成员', async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'reviewer' && context.run.model === 'fixture-primary') throw new Error('insufficient_quota fixture-review');
  });
  try {
    const audit = member('audit', 'review'); audit.fallbackBinding = { provider: 'codex', model: 'fixture-fallback', reasoningEffort: 'high' };
    await f.group.saveConfig({ expectedRevision: 2, name: '审查有备用', members: [member('captain', 'read'), member('coder', 'write'), member('qa', 'verify'), audit] });
    const sent = await f.send();
    const failed = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[0].turns.some(turn => turn.member.id === 'audit' && turn.error.includes('insufficient_quota'))
      && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const turn = failed.room.rounds[0].turns.find(turn => turn.member.id === 'audit')!;
    assert.equal(f.calls.filter(run => run.team?.profileId === 'reviewer').length, 1);
    assert.ok(f.calls.every(run => run.model === 'fixture-primary'));
    const implementationCalls = f.calls.filter(run => run.team?.profileId === 'engineer').length;
    await f.group.fallbackAndContinue(sent.room.id, { turnId: turn.id, runId: turn.runId });
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, implementationCalls);
    assert.equal(f.calls.at(-1)!.team?.profileId, 'reviewer'); assert.equal(f.calls.at(-1)!.model, 'fixture-fallback');
  } finally { await f.cleanup(); }
});

test('自动群聊暂停与继续保留原任务，已完成计划不重复派发', async () => {
  let release!: () => void, blocked = true; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer' && blocked) {
      blocked = false;
      await Promise.race([gate, new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))]);
    }
  });
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id;
    await f.group.action(sent.room.id, 'pause');
    await waitFor(() => f.group.detail(sent.room.id), value => !!value.collaboration?.task.chat?.paused && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    assert.equal(f.calls.filter(run => run.team?.profileId === 'verifier').length, 0);
    release(); await f.group.action(sent.room.id, 'continue');
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.equal(done.collaboration!.task.id, taskId);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').length, 1);
  } finally { release(); await f.cleanup(); }
});

test('自动群聊停止中及已暂停时重复暂停和打开编辑只保留一组控制消息', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer') { await gate; throw new Error('stopped'); }
  });
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id, sourceId = sent.room.rounds[0].id;
    const assertPauseCount = () => {
      const messages = f.team.getTask(taskId).chat!.messages;
      const pauses = messages.filter(message => message.role === 'user' && message.text === '暂停任务');
      assert.equal(pauses.length, 1, '重复控制操作不能追加暂停用户消息');
      assert.equal(messages.filter(message => message.hostGenerated && message.replyTo === pauses[0].id).length, 1);
    };
    await f.group.action(sent.room.id, 'pause');
    assert.equal(f.team.getTask(taskId).chat?.coordination?.phase, 'stopping');
    await Promise.all([f.group.action(sent.room.id, 'pause'), f.group.pauseMessage(sent.room.id, sourceId),
      f.group.pauseMessage(sent.room.id, sourceId)]);
    assertPauseCount();
    release(); await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    await f.group.pauseMessage(sent.room.id, sourceId);
    await f.reopen(); await f.group.action(sent.room.id, 'pause'); assertPauseCount();
    await f.group.action(sent.room.id, 'cancel');
    assert.equal(f.team.getTask(taskId).state, 'cancelled'); assertPauseCount();
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'verifier').length, 0);
  } finally { release(); await f.cleanup(); }
});

test('自动群聊再次暂停撤销等待停止的继续请求，恢复后仍可重新暂停', async () => {
  let release!: () => void, writers = 0; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId !== 'engineer') return;
    if (++writers === 1) await gate;
    else await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('stopped');
  });
  try {
    const sent = await f.send(); await waitFor(() => writers, count => count === 1);
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id;
    await f.group.action(sent.room.id, 'pause'); await f.group.action(sent.room.id, 'continue');
    assert.equal(f.team.getTask(taskId).chat?.resumeRequested, true);
    await f.group.action(sent.room.id, 'pause');
    assert.equal(f.team.getTask(taskId).chat?.resumeRequested, false);
    release(); await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    assert.equal(writers, 1, '新的暂停应撤销此前排队的恢复');
    await f.group.action(sent.room.id, 'continue'); await waitFor(() => writers, count => count === 2);
    await f.group.action(sent.room.id, 'pause');
    await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    assert.equal(f.team.getTask(taskId).chat!.messages.filter(message => message.role === 'user' && message.text === '暂停任务').length, 3);
  } finally { release(); await f.cleanup(); }
});

test('自动群聊暂停后新只读协调仍能被再次暂停', async () => {
  let leaders = 0, consultationStopped = false;
  const f = await fixture(async context => {
    const consultation = context.run.team?.profileId === 'leader' && ++leaders > 1;
    if (!consultation && context.run.team?.profileId !== 'engineer') return;
    await new Promise<void>(resolve => {
      const stop = () => { if (consultation) consultationStopped = true; resolve(); };
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    throw new Error('stopped');
  });
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id;
    await f.group.action(sent.room.id, 'pause');
    await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    await f.send({ roomId: sent.room.id, requestId: 'consult-while-paused', text: '请只读说明当前修改范围' });
    await waitFor(() => leaders, count => count === 2);
    assert.equal(f.team.getTask(taskId).chat?.paused, true); assert.equal(consultationStopped, false);
    await f.group.pauseMessage(sent.room.id, sent.room.rounds[0].id);
    await waitFor(() => consultationStopped, Boolean);
    assert.equal(f.team.getTask(taskId).chat!.messages.filter(message => message.role === 'user' && message.text === '暂停任务').length, 2);
  } finally { await f.cleanup(); }
});

test('自动群聊暂停落盘但团队未接受时重试仍送达暂停', async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId !== 'engineer') return;
    await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('stopped');
  });
  const chat = f.team.chat; let failPause = true;
  f.team.chat = async input => {
    if (input.objective === '暂停任务' && failPause) { failPause = false; throw new Error('fixture pause not accepted'); }
    return chat(input);
  };
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id;
    await assert.rejects(f.group.action(sent.room.id, 'pause'), /fixture pause not accepted/);
    const stored = JSON.parse(await fs.readFile(path.join(f.data, 'group-chat.json'), 'utf8'));
    assert.equal(stored.rooms.find((room: { id: string }) => room.id === sent.room.id).paused, true);
    assert.equal(f.team.getTask(taskId).chat?.paused, undefined);
    await f.group.action(sent.room.id, 'pause');
    await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    assert.equal(f.team.getTask(taskId).chat!.messages.filter(message => message.role === 'user' && message.text === '暂停任务').length, 1);
  } finally { f.team.chat = chat; await f.cleanup(); }
});

test('自动群聊暂停落盘期间收到继续请求时按最新团队状态再次暂停', async () => {
  let releaseWriter!: () => void, releaseWrite!: () => void, writing!: () => void;
  const writerGate = new Promise<void>(resolve => releaseWriter = resolve);
  const writeGate = new Promise<void>(resolve => releaseWrite = resolve);
  const writeStarted = new Promise<void>(resolve => writing = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer') { await writerGate; throw new Error('stopped'); }
  });
  let isolated: Awaited<ReturnType<typeof createAgentGroupChat>> | undefined;
  let holdWrite = false;
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const taskId = f.group.detail(sent.room.id).collaboration!.task.id;
    await f.group.action(sent.room.id, 'pause'); await f.group.close();
    isolated = await createAgentGroupChat(f.data, f.runtime, { profiles: defaultTeamProfileConfig, automatic: f.team,
      writeJson: async (_relative, value) => {
        await fs.writeFile(path.join(f.data, 'group-chat.json'), JSON.stringify(value));
        if (holdWrite) { holdWrite = false; writing(); await writeGate; }
      } });
    await waitFor(() => isolated!.isIdle(), Boolean);
    holdWrite = true;
    const pausing = isolated.action(sent.room.id, 'pause');
    await writeStarted;
    await f.team.chat({ taskId, objective: '继续执行', attachmentIds: [], requestId: 'resume-during-pause-persist' });
    assert.equal(f.team.getTask(taskId).chat?.resumeRequested, true);
    releaseWrite(); await pausing;
    assert.equal(f.team.getTask(taskId).chat?.resumeRequested, false, '落盘前的重复暂停判断不能覆盖新到的继续请求');
    releaseWriter(); await waitFor(() => f.team.getTask(taskId), task => task.chat?.coordination?.phase === 'paused');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 1);
  } finally { releaseWrite(); releaseWriter(); await isolated?.close(); await f.cleanup(); }
});

test('取消自动群聊同时取消排队的定向轮次，重载后也不派发', async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'leader') await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return '不应执行已取消的待办';
  });
  const chat = f.team.chat;
  f.team.chat = async input => {
    const response = await chat(input);
    if (input.requestId.endsWith(':lost-before-cancel')) throw new Error('fixture lost receipt');
    return response;
  };
  try {
    const sent = await f.send();
    await waitFor(() => f.calls.length, count => count === 1);
    await f.send({ roomId: sent.room.id, requestId: 'lost-before-cancel', text: '尚未确认转交的广播' });
    await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[0].automatic?.error === 'fixture lost receipt');
    await f.send({ roomId: sent.room.id, requestId: 'queued-target-before-cancel', text: '排队向成员提问', memberIds: ['captain'] });
    await f.group.action(sent.room.id, 'cancel');
    await waitFor(() => f.group.isIdle() && f.team.isIdle() && !f.group.detail(sent.room.id).runs.some(run => f.runtime.isRunActive(run.id)), Boolean);
    const cancelled = f.group.detail(sent.room.id);
    assert.equal(f.calls.length, 1, '取消不能唤醒已排队的定向成员');
    assert.equal(cancelled.room.paused, true);
    assert.deepEqual(cancelled.room.rounds.map(round => round.state), ['cancelled', 'cancelled']);
    await f.reopen();
    await waitFor(() => f.group.isIdle(), Boolean);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.group.detail(sent.room.id).room.rounds.map(round => round.state), ['cancelled', 'cancelled']);
  } finally { f.team.chat = chat; await f.cleanup(); }
});

test('自动任务终止不能清除群聊暂停或唤醒排队成员，明确继续才处理待办', async () => {
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'leader') await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return '已处理定向待办';
  });
  try {
    const sent = await f.send();
    const started = await waitFor(() => f.group.detail(sent.room.id), value => !!value.collaboration?.task.id && f.calls.length === 1);
    const taskId = started.collaboration!.task.id;
    await f.send({ roomId: sent.room.id, requestId: 'paused-target', text: '排队向成员提问', memberIds: ['captain'] });
    await f.group.action(sent.room.id, 'pause');
    await waitFor(() => f.group.detail(sent.room.id).runs, runs => !runs.some(run => f.runtime.isRunActive(run.id)));
    await f.team.decide(taskId, { action: 'cancel', requestId: 'finish-paused-task' });
    await waitFor(() => f.group.isIdle() && f.team.isIdle(), Boolean);
    assert.equal(f.calls.length, 1);
    assert.equal(f.group.detail(sent.room.id).room.paused, true);
    await f.reopen();
    await waitFor(() => f.group.isIdle(), Boolean);
    assert.equal(f.calls.length, 1);
    await f.group.action(sent.room.id, 'continue');
    await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[1].state === 'completed');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].objective, '排队向成员提问');
  } finally { await f.cleanup(); }
});

test('自动完成后定向轮保留独立暂停状态，再广播继承自动和定向真实历史', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.interactionMode === 'group') {
      await Promise.race([gate, new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      return '定向补充事实：接口字段保持原文';
    }
    if (context.run.team?.profileId === 'leader' && context.run.objective.includes('上一轮')) return report({ conversationReply: { text: '已依据前轮真实历史解释', resumeWorkflow: false } });
  });
  try {
    const first = await f.send(); const completed = await f.done(first.room.id);
    assert.equal(completed.collaboration!.task.state, 'completed');
    const firstTask = completed.collaboration!.task;
    await f.send({ roomId: first.room.id, requestId: 'targeted-middle', memberIds: ['audit'], text: '补充只读事实' });
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.interactionMode === 'group'));
    assert.equal(f.group.detail(first.room.id).collaboration, undefined, '正在运行定向轮不受旧自动终态遮盖');
    await f.group.action(first.room.id, 'pause');
    await waitFor(() => f.group.detail(first.room.id), detail => detail.room.paused && !detail.runs.some(run => f.runtime.isRunActive(run.id) || run.status === 'completed' && run.resultReady === false));
    assert.equal(f.group.detail(first.room.id).room.paused, true);
    release(); await f.group.action(first.room.id, 'continue');
    await waitFor(() => f.group.detail(first.room.id), detail => detail.room.rounds[1].state === 'completed');
    await f.send({ roomId: first.room.id, requestId: 'automatic-followup', text: '请解释上一轮和补充事实' });
    const final = await f.done(first.room.id), next = final.collaboration!.task;
    assert.equal(next.state, 'completed', next.reason);
    assert.notEqual(next.id, firstTask.id);
    assert.equal(next.parentConversationId, firstTask.parentConversationId);
    assert.match(next.chat!.parentContext!, /请修复value并验证/);
    assert.match(next.chat!.parentContext!, /定向补充事实：接口字段保持原文/);
    assert.equal(final.collaborations?.length, 2);
  } finally { release(); await f.cleanup(); }
});

test('首次自动派发失败可见；暂停不暗中重试，取消后重载也不启动', async () => {
  const f = await fixture(); let tries = 0;
  await f.group.close();
  let isolated = await createAgentGroupChat(f.data, f.runtime, { profiles: defaultTeamProfileConfig,
    automatic: { ...f.team, chat: async () => { tries++; throw new Error('fixture 首次派发未接受'); } } });
  try {
    const sent = await isolated.send({ text: '执行任务', requestId: 'dispatch-error', workspacePath: f.source });
    await waitFor(() => isolated.detail(sent.room.id), value => value.room.rounds[0].automatic?.error === 'fixture 首次派发未接受');
    assert.equal(isolated.detail(sent.room.id).room.rounds[0].state, 'failed');
    await isolated.action(sent.room.id, 'pause'); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(tries, 1); assert.equal(isolated.detail(sent.room.id).room.paused, true);
    await isolated.action(sent.room.id, 'cancel'); await isolated.close();
    isolated = await createAgentGroupChat(f.data, f.runtime, { profiles: defaultTeamProfileConfig, automatic: f.team });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 0); assert.equal(isolated.detail(sent.room.id).room.rounds[0].state, 'cancelled');
  } finally { await isolated.close(); await f.cleanup(); }
});

test('原群聊显式重跑从原项目创建新任务，保留旧副本失败与用户补充，重复请求不重复派发', async () => {
  let attempts = 0;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer' && ++attempts === 1) throw new Error('fixture 原任务实施失败');
  });
  let team: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  let group: Awaited<ReturnType<typeof createAgentGroupChat>> | undefined;
  try {
    const first = await f.send();
    await f.done(first.room.id);
    await waitFor(() => f.group.detail(first.room.id), value => f.team.isIdle() && value.collaboration?.task.state === 'blocked'
      && value.runs.every(run => !f.runtime.isRunActive(run.id)));
    const old = f.group.detail(first.room.id).collaboration!.task;
    await f.group.close(); await f.team.close();
    // 夹具模拟旧版本保留下来的隔离候选，不改写历史运行结果。
    const candidate = path.join(f.root, 'legacy-candidate');
    await fs.cp(f.source, candidate, { recursive: true }); await fs.writeFile(path.join(candidate, 'value.txt'), 'legacy-only');
    const file = path.join(f.data, 'team-tasks.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const historical = saved.tasks.find((task: { id: string }) => task.id === old.id);
    historical.workspacePath = candidate;
    const removedAttachment = randomUUID(), activeAttachments = Array.from({ length: 6 }, () => randomUUID());
    historical.attachmentIds = activeAttachments;
    historical.chat.messages.push({ id: randomUUID(), role: 'user', text: '仅修复构建错误，保留用户已有本地改动',
      attachmentIds: [removedAttachment], createdAt: new Date().toISOString(), kind: 'message' });
    await fs.writeFile(file, JSON.stringify(saved));
    team = await createAgentTeamService(f.data, f.runtime);
    group = await createAgentGroupChat(f.data, f.runtime, { profiles: defaultTeamProfileConfig, automatic: team });
    await waitFor(() => team!.isIdle(), Boolean);
    const before = team.getTask(old.id), oldRun = group.detail(first.room.id).runs.find(run => run.team?.profileId === 'engineer')!;
    assert.equal(before.workspacePath, candidate);
    await assert.rejects(group.send({ roomId: first.room.id, requestId: 'too-many-rerun-attachments', text: '重跑', attachmentIds: [randomUUID()] }), /附件超过 6/);
    assert.equal(team.getTask(old.id).state, 'blocked', '附件检查失败不能先取消原任务');
    assert.equal(group.detail(first.room.id).room.rounds.length, 1);
    const request = { requestId: 'rerun-original-project', roundId: first.room.rounds[0].id };
    const [accepted, repeated] = await Promise.all([group.action(first.room.id, 'rerun', request), group.action(first.room.id, 'rerun', request)]);
    assert.equal(accepted.room.id, first.room.id); assert.equal(accepted.room.rounds.length, 2);
    assert.equal(repeated.room.rounds[1].id, accepted.room.rounds[1].id);
    assert.equal(accepted.room.rounds[1].rerunsRoundId, request.roundId);
    assert.equal(accepted.room.rounds[1].revisesMessageId, undefined);
    assert.equal(accepted.room.rounds[1].automatic!.previousTaskId, undefined);
    assert.deepEqual(accepted.room.rounds[1].attachmentIds, activeAttachments, '不恢复历史用户消息中已替换的附件');
    const done = await waitFor(() => group!.detail(first.room.id), value => value.room.rounds[1].state === 'completed');
    const next = done.collaboration!.task;
    assert.notEqual(next.id, old.id); assert.equal(next.sourceWorkspacePath, await fs.realpath(f.source));
    assert.equal(next.workspacePath, await fs.realpath(f.source));
    assert.match(next.objective, /请修复value并验证/); assert.match(next.objective, /仅修复构建错误，保留用户已有本地改动/);
    assert.match(next.objective, /不把历史“尚未修复”或“已经完成”的文字当作当前事实/);
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'updated');
    assert.equal(await fs.readFile(path.join(candidate, 'value.txt'), 'utf8'), 'legacy-only');
    assert.equal(team.getTask(old.id).state, 'cancelled'); assert.equal(done.room.rounds[0].state, 'cancelled');
    assert.equal(f.runtime.getRun(oldRun.id)!.error, oldRun.error);
    assert.equal(team.getTask(old.id).nodes.find(node => node.id === oldRun.team!.nodeId)!.error, before.nodes.find(node => node.id === oldRun.team!.nodeId)!.error);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 2);
    await assert.rejects(group.action(first.room.id, 'rerun', { ...request, requestId: 'stale-rerun' }), /当前轮次已变化/);
    await group.close(); group = await createAgentGroupChat(f.data, f.runtime, { profiles: defaultTeamProfileConfig, automatic: team });
    assert.equal((await group.action(first.room.id, 'rerun', request)).room.rounds.length, 2);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 2);
  } finally { await group?.close(); await team?.close(); await f.cleanup(); }
});

test('进行中的原群聊拒绝按钮和精确重跑指令，不停止写入或派发第二轮', async () => {
  let release!: () => void, interrupted = false; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer') {
      context.signal.addEventListener('abort', () => { interrupted = true; }, { once: true }); await gate;
    }
  });
  try {
    const sent = await f.send();
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    await assert.rejects(f.group.action(sent.room.id, 'rerun', { requestId: 'busy-rerun', roundId: sent.room.rounds[0].id }), /原运行尚未结束/);
    await assert.rejects(f.send({ roomId: sent.room.id, requestId: 'busy-rerun-message', text: '请重新跑一遍' }), /原运行尚未结束/);
    assert.equal(interrupted, false); assert.equal(f.group.detail(sent.room.id).room.rounds.length, 1);
    release(); assert.equal((await f.done(sent.room.id)).collaboration!.task.state, 'completed');
  } finally { release(); await f.cleanup(); }
});

test('只有独立精确重跑指令才新建重跑轮次，消息请求幂等', async () => {
  const f = await fixture(async context => context.run.team?.profileId === 'leader'
    ? report({ conversationReply: { text: '已按真实用户消息回复', resumeWorkflow: false } }) : undefined);
  try {
    const sent = await f.send({ text: '说明当前构建问题' });
    await f.done(sent.room.id); await waitFor(() => f.team.isIdle(), Boolean);
    await f.send({ roomId: sent.room.id, requestId: 'not-rerun', text: '先别重跑，只解释为什么失败' });
    await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[1]?.state === 'completed');
    assert.equal(f.group.detail(sent.room.id).room.rounds[1].rerunsRoundId, undefined);
    await waitFor(() => f.team.isIdle(), Boolean);
    const input = { roomId: sent.room.id, requestId: 'exact-rerun', text: '请重新跑一遍' };
    await f.send(input); await f.send(input);
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds[2]?.state === 'completed');
    assert.equal(done.room.rounds.length, 3); assert.equal(done.room.rounds[2].text, input.text);
    assert.equal(done.room.rounds[2].rerunsRoundId, done.room.rounds[1].id);
    assert.equal(done.room.rounds[2].automatic!.previousTaskId, undefined);
  } finally { await f.cleanup(); }
});


for (const accessMode of ['workspace', 'full'] as const) test(`群聊重试显式选择 ${accessMode} 持续传给后续新运行，历史权限不变`, async () => {
  const originalAccess = accessMode === 'full' ? 'workspace' : 'full';
  let attempts = 0;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer' && ++attempts === 1) throw new Error('fixture 停止后允许显式重试');
  });
  try {
    const sent = await f.send({ accessMode: originalAccess });
    const blocked = await waitFor(() => f.group.detail(sent.room.id), value => value.collaboration?.task.state === 'blocked'
      && f.team.isIdle() && !value.runs.some(run => f.runtime.isRunActive(run.id)));
    const failed = blocked.collaboration!.task.nodes.find(node => node.stage === 'implement')!;
    const oldRun = f.runtime.getRun(failed.runId!)!;
    await f.group.retryAndContinue(sent.room.id, { turnId: failed.id, runId: oldRun.id, accessMode });
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    const writerRuns = f.calls.filter(run => run.team?.profileId === 'engineer');
    assert.deepEqual(writerRuns.map(run => run.accessMode), [originalAccess, accessMode]);
    assert.equal(f.runtime.getRun(oldRun.id)!.accessMode, originalAccess);
    assert.equal(done.collaboration!.task.accessMode, accessMode);
    assert.equal(done.room.rounds[0].accessMode, accessMode);
    assert.ok(f.calls.filter(run => ['verifier', 'reviewer'].includes(run.team?.profileId || '')).every(run => run.accessMode === accessMode));
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).room.rounds[0].accessMode, accessMode);
  } finally { await f.cleanup(); }
});

for (const accessMode of ['workspace', 'full'] as const) test(`群聊重跑使用本次显式 ${accessMode}，去重包含权限且原轮权限保留`, async () => {
  const originalAccess = accessMode === 'full' ? 'workspace' : 'full';
  const f = await fixture(async context => context.run.team?.profileId === 'leader' ? report({ conversationReply: { text: '已解释', resumeWorkflow: false } }) : undefined);
  try {
    const sent = await f.send({ text: '请解释value', accessMode: originalAccess }); await f.done(sent.room.id);
    const input = { requestId: `rerun-access-${accessMode}`, roundId: sent.room.rounds[0].id, accessMode };
    await f.group.action(sent.room.id, 'rerun', input);
    const done = await waitFor(() => f.group.detail(sent.room.id), value => value.room.rounds.length === 2 && value.room.rounds[1].state === 'completed');
    assert.deepEqual(done.room.rounds.map(round => round.accessMode), [originalAccess, accessMode]);
    assert.deepEqual(f.calls.map(run => run.accessMode), [originalAccess, accessMode]);
    await f.group.action(sent.room.id, 'rerun', input);
    await assert.rejects(f.group.action(sent.room.id, 'rerun', { ...input, accessMode: originalAccess }), /请求标识/);
  } finally { await f.cleanup(); }
});


test('群聊暂停后继续传递显式完全访问，原运行保持工作区权限', async () => {
  let attempts = 0;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'engineer' && ++attempts === 1) {
      await new Promise<void>((_resolve, reject) => context.signal.aborted ? reject(new Error('stopped')) : context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
  });
  try {
    const sent = await f.send(); await waitFor(() => attempts, value => value === 1);
    await f.group.action(sent.room.id, 'pause');
    await f.group.action(sent.room.id, 'continue', { accessMode: 'full' });
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.deepEqual(f.calls.filter(run => run.team?.profileId === 'engineer').map(run => run.accessMode), ['workspace', 'full']);
    assert.equal(done.room.rounds[0].accessMode, 'full');
  } finally { await f.cleanup(); }
});

test('群聊修订与插队按显式完全访问派发，原消息去重包含权限', async () => {
  let leaders = 0;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'leader' && ++leaders > 1) return report({ conversationReply: { text: '已按新范围解释', resumeWorkflow: false } });
    if (context.run.team?.profileId === 'engineer') {
      await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '保留已有现场' } });
    }
  });
  try {
    const sent = await f.send(); await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    await f.send({ roomId: sent.room.id, requestId: 'selected-for-access', text: '先解释这个字段' });
    const queued = await waitFor(() => f.group.detail(sent.room.id), detail => !!detail.collaboration?.task.chat!.pendingInputs.length);
    const input = { messageId: queued.collaboration!.task.chat!.pendingInputs[0].id, accessMode: 'full' as const };
    await f.group.steerMessage(sent.room.id, input);
    await waitFor(() => f.group.detail(sent.room.id), detail => detail.collaboration!.task.chat!.messages.some(message => message.text === '已按新范围解释'));
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').at(-1)!.accessMode, 'full');
    assert.equal(f.calls.find(run => run.team?.profileId === 'engineer')!.accessMode, 'workspace');
    await f.group.steerMessage(sent.room.id, input);
    await assert.rejects(f.group.steerMessage(sent.room.id, { ...input, accessMode: 'workspace' }), /其他访问权限/);
    const revision = { requestId: 'revision-access', text: '只解释新要求', accessMode: 'workspace' as const };
    await f.group.reviseMessage(sent.room.id, input.messageId, revision);
    const revised = await waitFor(() => f.group.detail(sent.room.id), detail => detail.room.rounds.length === 2 && detail.room.rounds[1].state === 'completed');
    assert.equal(revised.room.rounds[1].accessMode, 'workspace');
    assert.equal(f.calls.at(-1)!.accessMode, 'workspace');
    await f.group.reviseMessage(sent.room.id, input.messageId, revision);
    await assert.rejects(f.group.reviseMessage(sent.room.id, input.messageId, { ...revision, accessMode: 'full' }), /其他内容/);
  } finally { await f.cleanup(); }
});

test('群聊问题回复的显式完全访问作用于续接，重复请求不扩大权限', async () => {
  let asked = false;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'leader' && !asked) {
      asked = true;
      return report({ taskPlan: { templateId: 'engineering', reason: '先核对目标值', risk: 'low', acceptanceCriteria: [{ id: 'AC-1', text: 'value为updated', source: '用户原话' }],
        allowedPaths: ['value.txt'], needsAnalyst: false, needsArchitect: false, questions: [{ id: 'Q-1', text: '是否按已确认值执行？', blocking: true }], risks: [], ownership: [], shared: [] } });
    }
  });
  try {
    const sent = await f.send();
    const waiting = await waitFor(() => f.group.detail(sent.room.id), detail => detail.collaboration?.task.state === 'awaiting_plan');
    const task = waiting.collaboration!.task, question = task.chat!.messages.find(message => message.kind === 'question')!;
    const input = { correlationId: question.id, requestId: 'answer-access', text: '按确认值执行', accessMode: 'full' as const };
    await f.team.answer(task.id, input);
    const done = await f.done(sent.room.id);
    assert.equal(done.collaboration!.task.state, 'completed', done.collaboration!.task.reason);
    assert.ok(f.calls.slice(1).every(run => run.accessMode === 'full'));
    assert.equal(f.calls[0].accessMode, 'workspace');
    await f.team.answer(task.id, input);
    await assert.rejects(f.team.answer(task.id, { ...input, accessMode: 'workspace' }), /requestId/);
  } finally { await f.cleanup(); }
});

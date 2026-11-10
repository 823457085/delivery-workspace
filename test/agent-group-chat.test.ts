import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentGroupChat } from '../server/agent-group-chat.js';
import { jiraDevSkillsDirectory } from '../server/jira-dev-prompt.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { exportGroupTemplate, importGroupTemplate, type GroupMember } from '../shared/agent-group-chat.js';
import type { AgentRun, AgentProvider, AgentUsageLimits } from '../shared/agent-runtime.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const member = (id: string, capability: GroupMember['capability'] = 'read'): GroupMember => ({ id, name: `自定义-${id}`, instructions: `执行${id}的职责`, enabled: true, capability,
  binding: { provider: 'codex', model: 'fixture-model', reasoningEffort: 'high' } });
const settle = async <T>(read: () => T, predicate: (value: T) => boolean) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待群聊状态超时：' + JSON.stringify(read()));
};
async function fixture(handler: (context: Context) => Promise<string> = async context => `真实夹具回复-${context.run.team!.profileId}`,
  readProviderUsage?: Partial<Record<AgentProvider, () => Promise<AgentUsageLimits>>>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-group-')), source = path.join(root, 'project'), data = path.join(root, 'data');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'value.txt'), 'base');
  const calls: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Codex', binary: 'fixture', version: 'fixture', ready: true,
    authenticated: true, message: 'ready', modes: ['ask', 'agent', 'plan'], accessModes: ['workspace', 'full'],
    models: ['fixture-model', 'gpt-6-astra', 'gpt-6.1-sol'].map(id => ({ id, label: id, efforts: ['low', 'high', 'ultra'] as Array<'low' | 'high' | 'ultra'> })), defaultModel: 'fixture-model', writable: true, checkedAt: new Date().toISOString() }),
  execute: async context => { calls.push(structuredClone(context.run)); await context.onSession(`native-${context.run.id}`); return handler(context); } };
  const cursor: AgentRuntimeAdapter = { ...adapter, id: 'cursor', health: async () => ({ ...await adapter.health(), provider: 'cursor', label: 'Cursor', models: [{ id: 'fixture-model', label: 'Fixture model' }] }) };
  const runtime = await createAgentRuntimeService(data, { adapters: [adapter, cursor] });
  let group = await createAgentGroupChat(data, runtime, { profiles: defaultTeamProfileConfig, readProviderUsage });
  async function roles(members: GroupMember[]) { return group.saveConfig({ expectedRevision: group.dashboard().config.revision, name: '我的研发团队', members }); }
  async function send(text = '请按各自职责处理', requestId = 'request-1', extra: Record<string, unknown> = {}) {
    return group.send({ text, requestId, workspacePath: source, ...extra });
  }
  return { root, data, source: await fs.realpath(source), runtime, calls, roles, send, get group() { return group; },
    reopen: async () => { await group.close(); group = await createAgentGroupChat(data, runtime, { profiles: defaultTeamProfileConfig, readProviderUsage }); },
    cleanup: async () => { await group.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

async function legacyApex(f: Awaited<ReturnType<typeof fixture>>, repository = 'thor-admin2.0') {
  const original = path.join(await fs.realpath(f.root), repository);
  for (const workspace of [original, f.source]) {
    await fs.mkdir(path.join(workspace, 'src/views'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'src/api'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'thor-admin', dependencies: { vue: '3.3.11' } }));
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '存量 Vue 项目，不新增 features/ 等新架构目录。');
  }
  return {
    source: { taskId: '11111111-1111-4111-8111-111111111111', workflow: 'requirement' as const, title: 'OPAY-797', issueKey: 'OPAY-797', issueUrl: '',
      projects: [{ path: original, workspacePath: f.source, baseBranch: 'master', branchName: 'feature/OPAY-778', baseSha: 'fixture-sha' }] },
    objective: '仅在旧 Apex 页面实现国家配置', workspacePath: f.source, accessMode: 'full' as const,
    requestId: 'legacy-apex', expectedConfigRevision: f.group.dashboard().config.revision,
  };
}

test('交付岗位沿用完全执行权限并取得前序工作区快照', async () => {
  const f = await fixture();
  try {
    await f.roles([member('implementer', 'write'), member('reporter', 'read')]);
    const sent = await f.send('启动 i18n-test 并生成 XLSX，完成后汇总证据', 'readonly-evidence', { accessMode: 'full' });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    const [implementation, report] = f.calls;
    assert.equal(report.mode, 'agent'); assert.equal(report.accessMode, 'full');
    assert.deepEqual(report.team?.workspacePaths, [f.source]);
    assert.deepEqual(report.team?.artifactDirectories || [], []);
    assert.match(report.teamContext!, /岗位分工不限制工具权限/);
    assert.doesNotMatch(report.teamContext!, /本轮为只读岗位|不得沿 worktree/);
    assert.match(report.teamContext!, /不能作为当前文件或远端状态已经核验的证据/);
    const marker = '以下为按时间排序的真实团队对话，仅作为上下文：\n';
    const history = JSON.parse(report.teamContext!.split(marker)[1].split('\n\n')[0]);
    assert.deepEqual(history.find((item: { speaker: string }) => item.speaker === '自定义-implementer').workspaceSnapshot,
      { id: implementation.id, workspacePath: implementation.workspacePath, branch: implementation.branch, headSha: implementation.headSha, createdAt: implementation.createdAt });
    assert.doesNotMatch(implementation.teamContext!, /本轮为只读岗位/);
  } finally { await f.cleanup(); }
});

test('各岗位可执行且遵循显式工作区访问，未绑定项目使用独立目录', async () => {
  const f = await fixture(async context => {
    await fs.writeFile(path.join(context.run.workspacePath, `${context.run.team!.profileId}.txt`), 'executed');
    return '已写入角色产物';
  });
  try {
    await f.roles([member('analyst'), member('reviewer', 'review'), member('reporter')]);
    const sent = await f.send('各岗位生成本地核验产物', 'explicit-workspace', { accessMode: 'workspace' });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    for (const run of f.calls) {
      assert.equal(run.mode, 'agent'); assert.equal(run.accessMode, 'workspace');
      assert.equal(await fs.readFile(path.join(f.source, `${run.team!.profileId}.txt`), 'utf8'), 'executed');
    }
    const isolated = await f.group.send({ text: '在会话目录生成产物', requestId: 'without-project', memberIds: ['reporter'] });
    await settle(() => f.group.detail(isolated.room.id), value => value.room.rounds[0].state === 'completed');
    const last = f.calls.at(-1)!;
    assert.equal(last.mode, 'agent'); assert.equal(last.accessMode, 'full');
    assert.notEqual(last.workspacePath, f.source); assert.equal(last.sourceWorkspacePath, '');
    assert.equal(await fs.readFile(path.join(last.workspacePath, 'reporter.txt'), 'utf8'), 'executed');
  } finally { await f.cleanup(); }
});

test('业务标题独立持久化，重载和重复请求不重发，续聊不改标题或执行正文', async () => {
  const f = await fixture();
  try {
    await f.roles([member('reader')]);
    const title = 'APEX联调问题清单.xlsx · 本地复测（7项）';
    const text = '[重构管理任务:11111111-1111-4111-8111-111111111111]\n{"action":"retest","environment":"LOCAL"}\n仅核对本轮所选问题，保留原始执行正文。';
    const input = { title: `  ${title}  ` }, requestId = 'business-title';
    const sent = await f.send(text, requestId, input);
    assert.equal((await f.send(text, requestId, input)).room.id, sent.room.id);
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(done.room.title, title);
    assert.equal(done.room.rounds.length, 1);
    assert.equal(done.room.rounds[0].text, text);
    assert.deepEqual(f.calls.map(run => run.objective), [text]);
    await f.reopen();
    assert.equal(f.group.dashboard().rooms.find(room => room.id === sent.room.id)?.title, title);
    assert.equal((await f.send(text, requestId, input)).room.id, sent.room.id);
    assert.equal(f.group.detail(sent.room.id).room.rounds.length, 1);
    assert.equal(f.calls.length, 1);
    const followup = '继续核对本轮证据';
    await f.send(followup, 'business-title-followup', { roomId: sent.room.id, title: '后续消息不能改名' });
    const followed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[1]?.state === 'completed');
    assert.equal(followed.room.title, title);
    assert.deepEqual(followed.room.rounds.map(round => round.text), [text, followup]);
    assert.deepEqual(f.calls.map(run => run.objective), [text, followup]);
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).room.title, title);
  } finally { await f.cleanup(); }
});

test('未提供业务标题的普通群聊仍取首行前100字符，完整消息用于执行', async () => {
  const f = await fixture();
  try {
    await f.roles([member('reader')]);
    const firstLine = '普通用户描述本轮页面问题'.repeat(10), text = `${firstLine}\n第二行保留在执行正文中。`;
    const sent = await f.send(text, 'ordinary-title');
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(done.room.title, firstLine.slice(0, 100));
    assert.equal(done.room.rounds[0].text, text);
    assert.deepEqual(f.calls.map(run => run.objective), [text]);
  } finally { await f.cleanup(); }
});

test('已发送消息可修订，保留原文和成员配置，重复保存不重复派发', async () => {
  const f = await fixture();
  try {
    const role = member('first');
    await f.roles([role]);
    const sent = await f.send('原始要求');
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    await f.roles([member('other')]);
    await f.group.pauseMessage(sent.room.id, sent.room.rounds[0].id);
    const input = { requestId: 'edit-once', text: '修订要求' }, messageId = sent.room.rounds[0].id;
    await f.group.reviseMessage(sent.room.id, messageId, input);
    await f.group.reviseMessage(sent.room.id, messageId, input);
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[1]?.state === 'completed');
    assert.equal(done.room.rounds.length, 2);
    assert.equal(done.room.rounds[0].text, '原始要求');
    assert.equal(done.room.rounds[1].text, '修订要求');
    assert.equal(done.room.rounds[1].revisesMessageId, messageId);
    assert.deepEqual(done.room.rounds[1].turns[0].member, role);
    assert.equal(f.calls.length, 2);
    await assert.rejects(f.group.reviseMessage(sent.room.id, messageId, { ...input, text: '冲突内容' }), /请求已用于/);
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).room.rounds[1].revisesMessageId, messageId);
  } finally { await f.cleanup(); }
});

test('编辑运行中的消息先执行修订，再继续原排队待办', async () => {
  const f = await fixture(async context => {
    if (context.run.objective === '原始要求') await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return '已处理';
  });
  try {
    await f.roles([member('reader')]);
    const sent = await f.send('原始要求');
    await settle(() => f.calls.length, count => count === 1);
    await f.send('旧排队内容', 'queued-before-edit', { roomId: sent.room.id });
    await f.group.pauseMessage(sent.room.id, sent.room.rounds[0].id);
    await f.group.reviseMessage(sent.room.id, sent.room.rounds[0].id, { requestId: 'revise-running', text: '更新后的要求' });
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds.at(-1)?.state === 'completed');
    assert.deepEqual(f.calls.map(run => run.objective), ['原始要求', '更新后的要求', '旧排队内容']);
    assert.equal(done.room.rounds[1].text, '更新后的要求');
    assert.equal(done.room.rounds[2].state, 'completed');
    assert.equal(done.room.rounds[0].text, '原始要求');
  } finally { await f.cleanup(); }
});

test('删除群聊停止本群执行和待办，其他群聊继续，重载与重复删除不会恢复记录', async () => {
  const f = await fixture(async context => {
    if (context.run.objective === '待删除') await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return '已完成';
  });
  try {
    await f.roles([member('reader')]);
    const removed = await f.send('待删除');
    await settle(() => f.calls.length, value => value === 1);
    await f.send('本群旧待办', 'delete-queued', { roomId: removed.room.id });
    const retained = await f.send('其他群聊', 'keep-other');
    await f.group.remove(removed.room.id);
    assert.throws(() => f.group.detail(removed.room.id), /找不到/);
    await f.group.remove(removed.room.id);
    await settle(() => f.group.detail(retained.room.id), value => value.room.rounds[0].state === 'completed');
    assert.deepEqual(f.calls.map(run => run.objective), ['待删除', '其他群聊']);
    await f.reopen();
    assert.deepEqual(f.group.dashboard().rooms.map(room => room.id), [retained.room.id]);
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'base');
  } finally { await f.cleanup(); }
});

test('旧 Apex Jira 默认跳过多余岗位与模型检查，保留自定义成员，重载和续聊不重放历史', async () => {
  const f = await fixture();
  try {
    const unused = ['analyst', 'architect', 'engineer'].map(id => {
      const role = member(id, id === 'engineer' ? 'write' : 'read'); delete role.binding; role.fallbackBinding = null; return role;
    });
    await f.roles([member('leader'), ...unused, member('frontend', 'write'), member('verifier', 'verify'), member('reviewer', 'review'), member('reporter'), member('architect-custom')]);
    const input = await legacyApex(f), expected = ['leader', 'frontend', 'verifier', 'reviewer', 'reporter', 'architect-custom'];
    await f.group.preflightJira(input.expectedConfigRevision, f.source, 'full', input.source.projects.map(project => project.path));
    const sent = await f.group.startJira(input);
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(done.room.title, input.source.title, 'Jira 来源标题优先于完整执行提示词');
    assert.equal(done.room.rounds[0].text, input.source.title);
    assert.equal(done.room.rounds[0].taskPrompt, input.objective);
    assert.ok(f.calls.every(run => run.objective === input.objective));
    assert.deepEqual(f.calls.map(run => run.team?.profileId), expected);
    assert.deepEqual(done.room.rounds[0].turns.map(turn => turn.member.id), expected);
    const originalTurns = done.room.rounds[0].turns.map(turn => ({ id: turn.id, runId: turn.runId }));
    await f.reopen();
    assert.equal(f.group.dashboard().rooms.find(room => room.id === sent.room.id)?.title, input.source.title);
    assert.equal(f.calls.length, expected.length);
    await f.send('继续核对同一旧项目', 'legacy-followup', { roomId: sent.room.id });
    const followed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[1].state === 'completed');
    assert.equal(followed.room.title, input.source.title);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), [...expected, ...expected]);
    assert.deepEqual(followed.room.rounds[0].turns.map(turn => ({ id: turn.id, runId: turn.runId })), originalTurns);
    assert.equal(followed.room.rounds[1].automatic, undefined);
  } finally { await f.cleanup(); }
});

test('多项目、未知项目和新架构不能仅按旧 Apex 名称删除团队岗位', async () => {
  for (const scenario of ['multiple', 'unknown', 'features']) {
    const f = await fixture();
    try {
      const members = [member('leader'), member('analyst'), member('architect'), member('engineer', 'write'), member('frontend', 'write'), member('reporter')];
      await f.roles(members);
      const input = await legacyApex(f, scenario === 'unknown' ? 'other-frontend' : 'thor-admin2.0');
      if (scenario === 'features') for (const workspace of [f.source, input.source.projects[0].path]) await fs.mkdir(path.join(workspace, 'src/features'));
      if (scenario === 'multiple') {
        const bff = path.join(await fs.realpath(f.root), 'node-bff'); await fs.mkdir(bff);
        input.source.projects.push({ path: bff, workspacePath: bff, baseBranch: 'master', branchName: 'feature/OPAY-778', baseSha: 'fixture-sha' });
      }
      const unbound = members.map(role => role.id === 'architect' ? { ...role, binding: undefined, fallbackBinding: null } : role);
      const saved = await f.roles(unbound);
      await assert.rejects(f.group.preflightJira(saved.revision, f.source, 'full', input.source.projects.map(project => project.path)), /设置本机执行器/, scenario);
      input.expectedConfigRevision = (await f.roles(members)).revision;
      const sent = await f.group.startJira(input);
      await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
      assert.deepEqual(f.calls.map(run => run.team?.profileId), members.map(role => role.id), scenario);
    } finally { await f.cleanup(); }
  }
});

test('旧 Apex 保留唯一实现成员，明确指定架构成员时只执行该成员', async () => {
  const f = await fixture();
  try {
    await f.roles([member('leader'), member('analyst'), member('architect'), member('engineer', 'write'), member('reporter')]);
    const input = await legacyApex(f);
    await f.group.preflightJira(input.expectedConfigRevision, f.source, 'full', input.source.projects.map(project => project.path));
    const sent = await f.group.startJira(input);
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'reporter']);
    const count = f.calls.length;
    await f.send('请架构成员只读解释现有目录', 'legacy-targeted', { roomId: sent.room.id, memberIds: ['architect'] });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[1].state === 'completed');
    assert.deepEqual(f.calls.slice(count).map(run => run.team?.profileId), ['architect']);
    assert.equal(f.calls.at(-1)?.mode, 'agent');
  } finally { await f.cleanup(); }
});

test('自定义角色真实接续、共享结果且同执行器仍使用独立原生会话', async () => {
  const f = await fixture();
  try {
    await f.roles([member('api-owner'), member('security-review', 'review')]);
    const sent = await f.send(); const id = sent.room.id;
    await settle(() => f.group.detail(id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].mode, 'agent'); assert.equal(f.calls[1].mode, 'agent');
    assert.match(f.calls[1].teamContext!, /真实夹具回复-api-owner/);
    assert.match(f.calls[1].teamContext!, /自定义-security-review/);
    assert.notEqual(f.calls[0].conversationId, f.calls[1].conversationId);
    assert.equal(f.group.detail(id).runs.length, 2);
    const duplicate = await f.send(); assert.equal(duplicate.room.id, id); assert.equal(duplicate.room.rounds.length, 1); assert.equal(f.calls.length, 2);
    await assert.rejects(f.send('不同内容'), /请求标识/);
  } finally { await f.cleanup(); }
});

test('自定义允许事项保存重载、模板导入导出及顺序执行保留原文，岗位不覆盖本轮访问权限', async () => {
  const f = await fixture();
  try {
    const allowedActions = '核对接口字段、L 码原文\n按需修改代码；外部发布仍需授权';
    const role = { ...member('custom-scope'), allowedActions: `  ${allowedActions}  ` };
    const saved = await f.roles([role, member('legacy')]);
    assert.equal(saved.members[0].allowedActions, allowedActions);
    assert.equal(saved.members[1].allowedActions, undefined, '旧配置不必补填允许事项');
    await f.reopen();
    assert.equal(f.group.dashboard().config.members[0].allowedActions, allowedActions);
    const exported = f.group.template();
    assert.equal(exported.members[0].allowedActions, allowedActions);
    const imported = await f.group.importTemplate(exported, saved.revision);
    assert.equal(imported.members[0].allowedActions, allowedActions);
    assert.equal(imported.members[0].capability, 'read');
    await assert.rejects(f.roles([{ ...role, allowedActions: 'a'.repeat(12001) }]), /12000/);
    assert.equal(f.group.dashboard().config.revision, imported.revision, '无效输入不覆盖已保存配置');
    await f.roles([{ ...role, allowedActions }]);
    const sent = await f.send('仅核对接口', 'custom-scope', { accessMode: 'full' });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].teamContext!.includes(`允许做什么：${allowedActions}`));
    assert.equal(f.calls[0].mode, 'agent');
    assert.equal(f.calls[0].accessMode, 'full');
    assert.equal(f.group.detail(sent.room.id).room.rounds[0].turns[0].member.capability, 'read');
    await f.reopen();
    assert.equal(f.group.detail(sent.room.id).room.rounds[0].turns[0].member.allowedActions, allowedActions);
  } finally { await f.cleanup(); }
});

test('指定单个或多个成员不会唤醒其他角色；未绑定模型会保留为配置问题，不制造群聊记录', async () => {
  const f = await fixture();
  try {
    const unbound = member('unbound'); delete unbound.binding;
    await f.roles([member('selected'), member('second'), unbound]);
    await assert.rejects(f.send(), /设置本机执行器/); assert.equal(f.group.dashboard().rooms.length, 0);
    const sent = await f.send('只问指定角色', 'targeted', { memberIds: ['selected'] });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['selected']);
    const multiple = await f.send('只问两个指定角色', 'targeted-multiple', { roomId: sent.room.id, memberIds: ['second', 'selected'] });
    await settle(() => f.group.detail(multiple.room.id), value => value.room.rounds[1].state === 'completed');
    assert.deepEqual(f.calls.slice(1).map(run => run.team?.profileId), ['selected', 'second']);
    assert.deepEqual(multiple.room.rounds[1].turns.map(turn => turn.member.id), ['selected', 'second']);
  } finally { await f.cleanup(); }
});

test('团队配置按轮冻结；新消息排队，前一轮不会读取尚未处理的后续指令', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => { if (context.run.objective === '第一条' && context.run.team?.profileId === 'one') await gate; return `结果-${context.run.objective}`; });
  try {
    await f.roles([member('one'), { ...member('two'), allowedActions: '首轮允许核对接口' }]); const first = await f.send('第一条', 'first');
    await settle(() => f.calls.length, count => count === 1);
    const changed = member('two'); changed.name = '下一轮新名称'; changed.allowedActions = '次轮允许补充说明'; await f.roles([member('one'), changed]);
    await f.send('下一轮独有指令', 'second', { roomId: first.room.id }); release();
    await settle(() => f.group.detail(first.room.id), value => value.room.rounds.every(round => round.state === 'completed'));
    assert.equal(f.calls.length, 4); assert.doesNotMatch(f.calls[1].teamContext!, /下一轮独有指令|下一轮新名称/);
    assert.match(f.calls[3].teamContext!, /下一轮新名称/); assert.match(f.calls[2].teamContext!, /结果-第一条/);
    assert.match(f.calls[1].teamContext!, /允许做什么：首轮允许核对接口/);
    assert.doesNotMatch(f.calls[1].teamContext!, /次轮允许补充说明/);
    assert.match(f.calls[3].teamContext!, /允许做什么：次轮允许补充说明/);
  } finally { release(); await f.cleanup(); }
});

test('暂停时阻止后续成员；继续只接续未完成角色，不重放已完成角色', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let first = true;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'two' && first) { first = false; await Promise.race([gate, new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))]); }
    return `完成-${context.run.team?.profileId}`;
  });
  try {
    await f.roles([member('one'), member('two'), member('three')]); const sent = await f.send();
    await settle(() => f.calls.length, count => count === 2);
    await f.group.action(sent.room.id, 'pause');
    await settle(() => f.runtime.getRun(f.calls[1].id), run => !!run && !f.runtime.isRunActive(run.id) && (run.status !== 'completed' || run.resultReady !== false));
    assert.equal(f.calls.length, 2); assert.equal(f.group.detail(sent.room.id).room.paused, true);
    release(); await f.group.action(sent.room.id, 'continue');
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'one').length, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'three').length, 1);
  } finally { release(); await f.cleanup(); }
});

test('派发回执持久化后重启服务按同一运行恢复，不重复模型调用', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const f = await fixture(async context => { if (context.run.team?.profileId === 'one') await gate; return '完成'; });
  try {
    await f.roles([member('one'), member('two')]); const sent = await f.send(); await settle(() => f.calls.length, count => count === 1);
    const firstId = f.calls[0].id; await f.reopen(); release();
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 2); assert.equal(f.group.detail(sent.room.id).room.rounds[0].turns[0].runId, firstId);
  } finally { release(); await f.cleanup(); }
});

test('修改代码后验证使用包含最新改动的独立副本，审查有执行权限且不继承实现者会话', async () => {
  const f = await fixture(async context => {
    const id = context.run.team?.profileId;
    if (id === 'writer') await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), 'implemented');
    if (id === 'checker') { assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'value.txt'), 'utf8'), 'implemented'); await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), 'only-in-copy'); }
    return `实际-${id}`;
  });
  try {
    await f.roles([member('writer', 'write'), member('checker', 'verify'), member('audit', 'review')]); const sent = await f.send();
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'implemented');
    assert.notEqual(f.calls[1].workspacePath, f.source); assert.equal(f.calls[2].workspacePath, f.source); assert.equal(f.calls[2].mode, 'agent');
  } finally { await f.cleanup(); }
});

test('Jira 群聊各岗位可读取 Skill、其他项目和本轮前序验证资料，不泄漏其他群或旧轮次目录', async () => {
  const reads = new Map<string, string[]>();
  const f = await fixture(async context => {
    reads.set(context.run.id, context.attachmentReadDirectories || []);
    if (context.run.team?.profileId === 'checker') {
      const report = path.join(context.run.workspacePath, '.verification', 'verification-report.md');
      await fs.mkdir(path.dirname(report), { recursive: true }); await fs.writeFile(report, '实际验证资料');
      return `验证报告：${report}`;
    }
    return `完成-${context.run.team?.profileId}`;
  });
  try {
    const secondary = path.join(await fs.realpath(f.root), 'secondary'); await fs.mkdir(secondary); await fs.writeFile(path.join(secondary, 'value.txt'), 'secondary');
    const saved = await f.roles([member('writer', 'write'), member('checker', 'verify'), member('audit', 'review'), member('reporter')]);
    const other = await f.send('另一个群的验证', 'other-group', { memberIds: ['checker'] });
    await settle(() => f.group.detail(other.room.id), value => value.room.rounds[0].state === 'completed');
    const unrelatedCopy = f.calls[0].workspacePath;
    const sent = await f.group.startJira({ source: { taskId: '11111111-1111-4111-8111-111111111111', workflow: 'requirement', title: 'APEX-602', issueKey: 'APEX-602', issueUrl: '',
      projects: [f.source, secondary].map(workspacePath => ({ path: workspacePath, workspacePath, baseBranch: 'master', branchName: 'feature/APEX-602', baseSha: 'fixture-sha' })) },
      objective: `读取 ${jiraDevSkillsDirectory}/jira-dev-requirement/SKILL.md 后按职责处理`, workspacePath: f.source, accessMode: 'full', requestId: 'jira-materials', expectedConfigRevision: saved.revision });
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    const runs = f.calls.filter(run => run.team?.taskId === done.room.id), writer = runs[0], checker = runs[1];
    const copies = checker.team!.workspacePaths!;
    const skillRoot = await fs.realpath(jiraDevSkillsDirectory);
    assert.deepEqual(writer.team?.artifactDirectories, [skillRoot]);
    assert.deepEqual(checker.team?.artifactDirectories, [skillRoot, f.source, secondary]);
    assert.equal(copies.length, 2);
    for (const role of ['audit', 'reporter']) {
      const run = runs.find(run => run.team?.profileId === role)!;
      assert.equal(run.mode, 'agent'); assert.equal(run.accessMode, 'full');
      assert.deepEqual(run.team?.artifactDirectories, [skillRoot, ...copies]);
      assert.deepEqual(reads.get(run.id), run.team?.artifactDirectories);
      assert.ok(!run.team?.artifactDirectories?.includes(run.workspacePath));
      assert.ok(!run.team?.artifactDirectories?.includes(unrelatedCopy));
      const report = path.join(copies[0], '.verification', 'verification-report.md');
      assert.equal(await fs.readFile(report, 'utf8'), '实际验证资料');
    }
    const followup = await f.send('只整理新一轮资料', 'new-round', { roomId: done.room.id, memberIds: ['reporter'] });
    await settle(() => f.group.detail(followup.room.id), value => value.room.rounds[1].state === 'completed');
    assert.deepEqual(f.calls.at(-1)?.team?.artifactDirectories, [skillRoot]);
    await f.send('核对两个关联项目', 'workspace-read-roots', { roomId: done.room.id, memberIds: ['reporter'], accessMode: 'workspace' });
    await settle(() => f.group.detail(done.room.id), value => value.room.rounds[2].state === 'completed');
    const scoped = f.calls.at(-1)!;
    assert.equal(scoped.mode, 'agent'); assert.equal(scoped.accessMode, 'workspace');
    assert.deepEqual(scoped.team?.artifactDirectories, [skillRoot, secondary]);
    assert.ok(reads.get(scoped.id)?.includes(secondary), '显式工作区模式保留第二项目的实际读取授权');
  } finally { await f.cleanup(); }
});

test('同群后续轮次复核已完成验证的标准产物，不自动附加旧副本根目录或其他群资料', async () => {
  const artifacts = new Map<string, string>(), reads = new Map<string, string[]>();
  let claimedDirectory = '';
  const f = await fixture(async context => {
    const role = context.run.team?.profileId, roomId = context.run.team!.taskId;
    reads.set(context.run.id, context.attachmentReadDirectories || []);
    if (role === 'checker') {
      const directory = path.join(context.run.workspacePath, '.delivery-artifacts');
      await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ checks: 'passed', source: roomId }));
      artifacts.set(roomId, directory);
      return `验证产物：${directory}/summary.json；另称需要读取：${claimedDirectory}`;
    }
    if (context.run.objective === '复核历史验证资料') {
      const directory = artifacts.get(roomId)!;
      assert.ok(context.attachmentReadDirectories?.includes(directory), '先取得标准产物目录的只读授权再读文件');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'summary.json'), 'utf8')), { checks: 'passed', source: roomId });
    }
    return `实际核对-${role}`;
  });
  try {
    claimedDirectory = path.join(await fs.realpath(f.root), 'untrusted-result-path'); await fs.mkdir(claimedDirectory);
    await f.roles([member('checker', 'verify'), member('leader'), member('reporter')]);
    const unrelated = await f.send('其他群验证', 'artifact-unrelated', { memberIds: ['checker'] });
    await settle(() => f.group.detail(unrelated.room.id), value => value.room.rounds[0].state === 'completed');
    const first = await f.send('生成本群验证产物', 'artifact-first', { memberIds: ['checker'] });
    const done = await settle(() => f.group.detail(first.room.id), value => value.room.rounds[0].state === 'completed');
    const copy = done.room.rounds[0].turns[0].workspacePath!, directory = artifacts.get(first.room.id)!;
    const verifierRun = done.room.rounds[0].turns[0].runId, calls = f.calls.length;
    await f.reopen();
    await f.send('复核历史验证资料', 'artifact-followup', { roomId: first.room.id, memberIds: ['leader', 'reporter'] });
    const followed = await settle(() => f.group.detail(first.room.id), value => value.room.rounds[1].state === 'completed');
    assert.equal(f.calls.length, calls + 2, '重载与复核不能重跑验证成员');
    assert.equal(followed.room.rounds[0].turns[0].runId, verifierRun);
    for (const run of f.calls.slice(calls)) {
      assert.equal(run.mode, 'agent'); assert.equal(run.accessMode, 'full');
      assert.deepEqual(run.team?.artifactDirectories, [directory]);
      assert.deepEqual(reads.get(run.id), [directory]);
      assert.ok(!reads.get(run.id)?.includes(copy));
      assert.ok(!reads.get(run.id)?.includes(artifacts.get(unrelated.room.id)!));
      assert.ok(!reads.get(run.id)?.includes(claimedDirectory));
    }
  } finally { await f.cleanup(); }
});

test('历史验证产物目录或副本路径被符号链接替换时，不扩展后续成员的读取范围', async () => {
  for (const redirected of ['artifact', 'copy', 'ancestor']) {
    const reads = new Map<string, string[]>();
    const f = await fixture(async context => {
      reads.set(context.run.id, context.attachmentReadDirectories || []);
      if (context.run.team?.profileId === 'checker') {
        const directory = path.join(context.run.workspacePath, '.delivery-artifacts');
        await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'summary.json'), '{}');
        return `实际产物：${directory}/summary.json`;
      }
      return '仅核对允许读取的资料';
    });
    try {
      await f.roles([member('checker', 'verify'), member('reporter')]);
      const sent = await f.send('先验证', 'symlink-first', { memberIds: ['checker'] });
      const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
      const copy = done.room.rounds[0].turns[0].workspacePath!;
      const redirectedPath = redirected === 'artifact' ? path.join(copy, '.delivery-artifacts') : redirected === 'copy' ? copy : path.dirname(copy);
      const target = path.join(await fs.realpath(f.root), `redirected-${redirected}`);
      await fs.rename(redirectedPath, target); await fs.symlink(target, redirectedPath, 'dir');
      await f.send('复核前轮验证资料', 'symlink-followup', { roomId: sent.room.id, memberIds: ['reporter'] });
      await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[1].state === 'completed');
      const reporter = f.calls.at(-1)!;
      assert.deepEqual(reporter.team?.artifactDirectories || [], [], redirected);
      assert.deepEqual(reads.get(reporter.id), [], redirected);
      assert.equal(f.calls.length, 2);
    } finally { await f.cleanup(); }
  }
});

test('普通群聊不额外附加 Jira Skill，验证副本保持可写且原项目仅作为只读资料', async () => {
  const f = await fixture();
  try {
    await f.roles([member('checker', 'verify'), member('reporter')]);
    const sent = await f.send();
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    const checker = f.calls[0], reporter = f.calls[1];
    assert.deepEqual(checker.team?.artifactDirectories, [f.source]);
    assert.ok(!checker.team?.artifactDirectories?.includes(checker.workspacePath));
    assert.deepEqual(reporter.team?.artifactDirectories, checker.team?.workspacePaths);
    assert.ok(!reporter.team?.artifactDirectories?.includes(jiraDevSkillsDirectory));
    assert.equal(reporter.mode, 'agent'); assert.equal(reporter.accessMode, 'full');
  } finally { await f.cleanup(); }
});

test('修改团队名称保存重载并保留成员和模型，空名称与旧版本不能覆盖配置', async () => {
  const f = await fixture();
  try {
    const saved = await f.roles([{ ...member('owner'), fallbackBinding: { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' } }, member('reviewer', 'review')]);
    const renamed = await f.group.saveConfig({ expectedRevision: saved.revision, name: '  APEX 重构联调团队  ', members: saved.members });
    assert.equal(renamed.name, 'APEX 重构联调团队');
    assert.deepEqual(renamed.members, saved.members);
    await f.reopen();
    assert.deepEqual(f.group.dashboard().config, renamed);
    await assert.rejects(f.group.saveConfig({ expectedRevision: saved.revision, name: '旧页面标题', members: [] }), /其他页面/);
    for (const name of ['  ', 'a'.repeat(101)]) {
      await assert.rejects(f.group.saveConfig({ expectedRevision: renamed.revision, name, members: renamed.members }));
    }
    assert.deepEqual(f.group.dashboard().config, renamed);
    assert.equal(f.group.dashboard().rooms.length, 0);
    assert.equal(f.calls.length, 0, '修改名称不能发起 AI 任务');
  } finally { await f.cleanup(); }
});

test('导出仅包含团队定义；导入不接受模型或账号；旧原型导入按分析岗位准备', async () => {
  const f = await fixture();
  try {
    const saved = await f.roles([member('custom')]), exported = exportGroupTemplate(saved);
    assert.doesNotMatch(JSON.stringify(exported), /fixture-model|provider|binding|workspacePath/);
    assert.throws(() => importGroupTemplate({ ...exported, members: [{ ...exported.members[0], binding: { provider: 'codex', model: 'sneaked' } }] }));
    await assert.rejects(f.group.saveConfig({ expectedRevision: saved.revision - 1, name: '冲突', members: saved.members }), /其他页面/);
    const old = { type: 'rd-team-template', version: 1, name: '旧原型', roles: [{ id: 'new-role', name: '接口专家', duty: '核对接口', provider: 'untrusted' }] };
    const imported = await f.group.importTemplate(old, saved.revision);
    assert.equal(imported.members[0].capability, 'read'); assert.equal(imported.members[0].binding, undefined);
  } finally { await f.cleanup(); }
});


test('普通失败只重试当前成员并沿用原模型权限，重复点击及旧记录不重复派发', async () => {
  let fail = true;
  const f = await fixture(async context => {
    if (context.run.team?.profileId === 'reader' && fail) { fail = false; throw new Error('未识别的 CLI 运行错误（退出码 1）'); }
    return '已完成当前成员';
  });
  try {
    const reader = member('reader'); reader.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' };
    reader.fallbackBinding = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
    await f.roles([member('first'), reader, member('last')]);
    const sent = await f.send('核对当前范围', 'retry-member', { accessMode: 'workspace' });
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(f.calls.length, 2, '未知错误不能自动重试或切换备用');
    const turn = failed.room.rounds[0].turns[1], input = { turnId: turn.id, runId: turn.runId };
    await assert.rejects(f.group.retryAndContinue(sent.room.id, { ...input, runId: sent.room.id }), /运行已变化/);
    const results = await Promise.allSettled([f.group.retryAndContinue(sent.room.id, input), f.group.retryAndContinue(sent.room.id, input)]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'first').length, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'last').length, 1);
    const [original, retried] = f.calls.filter(run => run.team?.profileId === 'reader');
    assert.deepEqual([retried.provider, retried.model, retried.reasoningEffort, retried.mode, retried.accessMode, retried.workspacePath],
      [original.provider, original.model, original.reasoningEffort, original.mode, original.accessMode, original.workspacePath]);
    assert.equal(done.room.rounds[0].turns[1].attempt, 2);
    assert.equal(f.runtime.getRun(input.runId)!.status, 'failed');
    await f.reopen();
    await assert.rejects(f.group.retryAndContinue(sent.room.id, input), /该轮已结束/);
    assert.equal(f.calls.length, 4);
  } finally { await f.cleanup(); }
});

test('普通成员重试拒绝仍在运行及目录信任故障，不改变信任配置', async () => {
  const f = await fixture(async context => {
    if (context.run.provider === 'cursor') throw new Error('workspace trust required');
    await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return '不应到达';
  });
  try {
    await f.roles([member('active')]); const active = await f.send();
    const running = await settle(() => f.group.detail(active.room.id), value => value.runs.some(run => run.status === 'running'));
    const turn = running.room.rounds[0].turns[0];
    await assert.rejects(f.group.retryAndContinue(active.room.id, { turnId: turn.id, runId: turn.runId }), /已确认停止/);
    await f.group.action(active.room.id, 'cancel');
    const cursor = member('cursor'); cursor.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' };
    await f.roles([cursor]); const sent = await f.send('检查目录', 'trust-stays-separate');
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    const trustTurn = failed.room.rounds[0].turns[0];
    await assert.rejects(f.group.retryAndContinue(sent.room.id, { turnId: trustTurn.id, runId: trustTurn.runId }), /目录信任入口/);
    assert.deepEqual(f.group.detail(sent.room.id).room.cursorTrustPaths, failed.room.cursorTrustPaths);
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('历史 Cursor 信任失败只重试当前成员，默认信任实际目录且不增加权限、不重放前序', async () => {
  let firstCursor = true;
  const f = await fixture(async context => {
    if (context.run.provider === 'cursor' && firstCursor) { firstCursor = false; throw new Error('workspace trust required'); }
    return `完成-${context.run.team?.profileId}`;
  });
  try {
    const cursor = member('cursor-reader'); cursor.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' };
    await f.roles([member('first'), cursor]); const sent = await f.send();
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    const turn = failed.room.rounds[0].turns[1];
    await assert.rejects(f.group.trustAndContinue(sent.room.id, { turnId: turn.id, runId: turn.runId, workspacePath: '/different/directory' }), /实际执行目录/);
    const input = { turnId: turn.id, runId: turn.runId, workspacePath: f.source };
    await f.group.trustAndContinue(sent.room.id, input); await f.group.trustAndContinue(sent.room.id, input);
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'first').length, 1);
    const retried = f.calls.filter(run => run.provider === 'cursor'); assert.equal(retried.length, 2);
    assert.equal(retried[1].cursorTrustPath, f.source); assert.equal(retried[1].mode, 'agent'); assert.equal(retried[1].accessMode, 'full');
  } finally { await f.cleanup(); }
});

test('Cursor 群聊与隔离验证副本默认信任各自实际目录，岗位权限保持原值', async () => {
  const f = await fixture();
  try {
    const reader = member('cursor-read'), verifier = member('cursor-verify', 'verify');
    for (const role of [reader, verifier]) { role.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' }; role.fallbackBinding = null; }
    await f.roles([reader, verifier]);
    const sent = await f.send('核对并验证', 'default-trust', { accessMode: 'full' });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 2);
    for (const run of f.calls) assert.equal(run.cursorTrustPath, run.workspacePath);
    assert.equal(f.calls[0].workspacePath, f.source); assert.equal(f.calls[0].mode, 'agent'); assert.equal(f.calls[0].accessMode, 'full');
    assert.notEqual(f.calls[1].workspacePath, f.source); assert.equal(f.calls[1].mode, 'agent'); assert.equal(f.calls[1].accessMode, 'full');
  } finally { await f.cleanup(); }
});

test('显式目录信任随本群聊传入 Cursor，其他目录不能混入同一条消息', async () => {
  const f = await fixture();
  try {
    const cursor = member('cursor-only'); cursor.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' }; await f.roles([cursor]);
    await assert.rejects(f.send('只读处理', 'invalid-trust', { cursorTrustPath: '/another/path' }), /实际目录/);
    assert.equal(f.calls.length, 0);
    const sent = await f.send('只读处理', 'valid-trust', { cursorTrustPath: f.source });
    await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls[0].cursorTrustPath, f.source); assert.equal(f.calls[0].mode, 'agent');
  } finally { await f.cleanup(); }
});

test('发送前团队配置发生变化时保留待确认边界，不以新角色替换用户看到的成员', async () => {
  const f = await fixture();
  try {
    const old = await f.roles([member('old')]); await f.roles([member('new-writer', 'write')]);
    await assert.rejects(f.send('只读讨论', 'stale-config', { expectedConfigRevision: old.revision }), /成员配置已更新/);
    assert.equal(f.calls.length, 0); assert.equal(f.group.dashboard().rooms.length, 0);
  } finally { await f.cleanup(); }
});

function usage(remaining: number | null): AgentUsageLimits {
  return { available: remaining !== null, planType: 'fixture', checkedAt: new Date().toISOString(),
    ...(remaining === null ? {} : { primary: { usedPercent: 100 - remaining, remainingPercent: remaining, windowDurationMins: 10080, resetsAt: null } }) };
}
function cursorReviewer() { const role = member('reviewer', 'review'); role.binding = { provider: 'cursor', model: 'fixture-model', reasoningEffort: '' }; return role; }

test('额度已耗尽在派发前切备用 Astra，首选配置不变且保留切换原因', async () => {
  const f = await fixture(undefined, { cursor: async () => usage(0), codex: async () => usage(55) });
  try {
    await f.roles([cursorReviewer()]); const sent = await f.send();
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].provider, 'codex'); assert.equal(f.calls[0].model, 'gpt-6-astra');
    assert.equal(f.calls[0].mode, 'agent'); assert.equal(f.calls[0].accessMode, 'full');
    assert.equal(f.group.dashboard().config.members[0].binding!.provider, 'cursor');
    const turn = done.room.rounds[0].turns[0]; assert.equal(turn.member.binding!.provider, 'cursor');
    assert.match(turn.fallbacks![0].reason, /额度已用尽/); assert.equal(turn.fallbacks![0].runId, '');
  } finally { await f.cleanup(); }
});

test('真实运行明确报额度用尽才自动切一次备用，失败原记录仍可追溯', async () => {
  const f = await fixture(async context => { if (context.run.provider === 'cursor') throw new Error('insufficient_quota'); return '备用完成'; });
  try {
    await f.roles([member('first'), cursorReviewer(), member('last')]); const sent = await f.send();
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 4); assert.equal(f.calls.filter(run => run.team?.profileId === 'first').length, 1);
    const reviewer = done.room.rounds[0].turns[1]; assert.equal(reviewer.executionBinding!.model, 'gpt-6-astra');
    assert.equal(reviewer.fallbacks!.length, 1); assert.equal(f.runtime.getRun(reviewer.fallbacks![0].runId)!.status, 'failed');
    assert.equal(f.calls.at(-1)!.team?.profileId, 'last');
  } finally { await f.cleanup(); }
});

test('目录未信任不当作额度耗尽；显式备用接续保留前序与权限，不信任 Cursor 目录', async () => {
  const f = await fixture(async context => { if (context.run.provider === 'cursor') throw new Error('当前工作区尚未信任，请确认信任此目录'); return '完成'; });
  try {
    await f.roles([member('one'), member('two'), member('three'), cursorReviewer(), member('last')]);
    const sent = await f.send(); const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(f.calls.length, 4); const original = failed.room.rounds[0].turns;
    const input = { turnId: original[3].id, runId: original[3].runId };
    await f.group.fallbackAndContinue(sent.room.id, input); await f.group.fallbackAndContinue(sent.room.id, input);
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.deepEqual(done.room.rounds[0].turns.slice(0, 3).map(turn => turn.runId), original.slice(0, 3).map(turn => turn.runId));
    assert.equal(f.calls.length, 6); const backup = f.calls[4]; assert.equal(backup.model, 'gpt-6-astra');
    assert.equal(backup.mode, 'agent'); assert.equal(backup.accessMode, 'full'); assert.equal(backup.cursorTrustPath, undefined);
    assert.deepEqual(done.room.cursorTrustPaths, []); assert.equal(f.runtime.getRun(input.runId)!.status, 'failed');
    await f.reopen(); assert.equal(f.group.detail(sent.room.id).room.rounds[0].turns[3].executionBinding!.model, 'gpt-6-astra');
  } finally { await f.cleanup(); }
});

test('未知额度可正常派发，备用同账号额度耗尽时不会换同池模型绕过或无限重试', async () => {
  const unknown = await fixture(undefined, { cursor: async () => usage(null) });
  try {
    await unknown.roles([cursorReviewer()]); const sent = await unknown.send();
    await settle(() => unknown.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(unknown.calls.length, 1); assert.equal(unknown.calls[0].provider, 'cursor');
  } finally { await unknown.cleanup(); }
  const exhausted = await fixture(async () => { throw new Error('quota exhausted'); }, { codex: async () => usage(0) });
  try {
    await exhausted.roles([cursorReviewer()]); const sent = await exhausted.send();
    const failed = await settle(() => exhausted.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(exhausted.calls.length, 1);
    const turn = failed.room.rounds[0].turns[0];
    await assert.rejects(exhausted.group.fallbackAndContinue(sent.room.id, { turnId: turn.id, runId: turn.runId }), /没有健康且额度可用/);
    assert.equal(exhausted.calls.length, 1); assert.equal(exhausted.group.detail(sent.room.id).room.paused, true);
  } finally { await exhausted.cleanup(); }
});

test('分析岗位执行工具后额度失败也暂停，不能因岗位名称重放写入', async () => {
  const f = await fixture(async context => {
    context.onEvent('tool', '写入文件 value.txt');
    for (let index = 0; index < 220; index++) context.onEvent('diagnostic', `后续诊断 ${index}`);
    await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), 'partial-analysis');
    throw new Error('quota exhausted');
  });
  try {
    await f.roles([member('analyst')]); const sent = await f.send();
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(f.calls.length, 1); assert.equal(failed.room.paused, true);
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'partial-analysis');
    assert.equal(failed.room.rounds[0].turns[0].fallbacks, undefined);
    assert.equal(failed.runs[0].toolExecutionStarted, true);
    assert.ok(failed.runs[0].events.every(event => event.type !== 'tool'), '展示事件裁剪后仍不自动重放');
  } finally { await f.cleanup(); }
});

test('修改代码已开始后额度失败暂停，避免自动重放已经执行的写入', async () => {
  const f = await fixture(async context => { await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), 'partial'); throw new Error('quota exhausted'); });
  try {
    await f.roles([member('writer', 'write')]); const sent = await f.send();
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(f.calls.length, 1); assert.equal(failed.room.rounds[0].turns[0].fallbacks, undefined);
    assert.equal(await fs.readFile(path.join(f.source, 'value.txt'), 'utf8'), 'partial');
  } finally { await f.cleanup(); }
});

test('每周窗口 0% 但仍有可用 Credits（额度）时自动切换继续执行，不阻塞成员', async () => {
  const f = await fixture(undefined, { codex: async () => ({ ...usage(0), credits: { hasCredits: true, balance: 34648.47 } }) });
  try {
    await f.roles([member('leader')]); const sent = await f.send();
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].provider, 'codex');
    assert.equal(done.room.rounds[0].turns[0].status, 'completed');
  } finally { await f.cleanup(); }
});


test('现有群改名只更新标题，保留任务和运行且重载后持久化', async () => {
  const f = await fixture();
  try {
    await f.roles([member('reader')]);
    const sent = await f.send('[重构管理任务:11111111-1111-4111-8111-111111111111]\n原始任务 L123', 'rename-existing');
    const before = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    const title = 'APEX联调问题清单 · 本地复测（7项）';
    assert.deepEqual(await f.group.rename(sent.room.id, { title, expectedTitle: before.room.title }), { id: sent.room.id, title });
    const after = f.group.detail(sent.room.id);
    assert.deepEqual(after.room, { ...before.room, title });
    assert.deepEqual(after.runs, before.runs);
    assert.equal(f.calls.length, 1);
    assert.equal(f.group.dashboard().rooms.find(room => room.id === sent.room.id)?.title, title);
    const savedAt = after.room.updatedAt;
    await f.group.rename(sent.room.id, { title, expectedTitle: before.room.title });
    assert.equal(f.group.detail(sent.room.id).room.updatedAt, savedAt, '同一请求重试不重复写入');
    await assert.rejects(f.group.rename(sent.room.id, { title: '冲突标题', expectedTitle: before.room.title }), /已被其他页面更新/);
    await assert.rejects(f.group.rename(sent.room.id, { title: ' ', expectedTitle: title }));
    await assert.rejects(f.group.rename(sent.room.id, { title: '长'.repeat(301), expectedTitle: title }));
    await assert.rejects(f.group.rename('22222222-2222-4222-8222-222222222222', { title, expectedTitle: '' }), /找不到这个团队群聊/);
    await f.reopen();
    const restored = f.group.detail(sent.room.id);
    assert.deepEqual(restored.room, after.room);
    assert.deepEqual(restored.runs, before.runs);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

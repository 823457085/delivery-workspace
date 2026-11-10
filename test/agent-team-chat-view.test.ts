import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, ref } from 'vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import { defaultTeamProfileConfig, teamChatMessageIdentity, type TeamChatMessage } from '../shared/agent-team.js';
import { agentConversationProjectPath, agentConversationStatus, buildAgentConversationList, buildAgentConversations, compareAgentConversations } from '../src/features/agent-workbench/conversation.js';
import { teamChatEntries, teamChatConversation, withTeamChatConversations, teamChatRequestKey, teamChatNodeProgress, teamQuestionState, teamQuestionReply, teamChatActivity, teamChatParticipant, isCurrentTeamChatTask } from '../src/features/agent-workbench/team-chat.js';
import { sendTeamChat, type AdvancedTeamTask } from '../src/features/agent-workbench/team-api.js';
import { useAgentConversationDrafts } from '../src/features/agent-workbench/useAgentConversationDrafts.js';

const at = (minute: number) => `2026-10-29T00:${String(minute).padStart(2, '0')}:00Z`;
function run(id: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'test', reasoningEffort: '', objective: '内部岗位指令',
    workspacePath: '/scratch/chat-workspaces/random', branch: '', headSha: '', status: 'completed', sessionId: id, pid: null,
    result: '内部结构化报告', error: '', events: [], createdAt: at(0), updatedAt: at(1), ...extra };
}
function task(extra: Partial<AdvancedTeamTask> = {}): AdvancedTeamTask {
  return { id: 'task', parentConversationId: 'parent', sourceWorkspacePath: '/scratch/chat-workspaces/random', objective: '你好', attachmentIds: [],
    profileConfig: defaultTeamProfileConfig(), planRevision: 0, nodes: [], state: 'running', round: 0, maxRounds: 2,
    createdAt: at(0), updatedAt: at(3), interactionMode: 'chat',
    chat: { workspaceBound: false, pendingInputs: [], messages: [
      { id: 'user', role: 'user', text: '你好', createdAt: at(0) },
      { id: 'reply', role: 'assistant', text: '你好，有什么需要处理？', profileId: 'leader', kind: 'message', createdAt: at(2) },
    ] }, ...extra };
}

test('团队会话投影使用执行模式与任务权限，不误报为只读问答', () => {
  const defaultConversation = teamChatConversation(task());
  assert.equal(defaultConversation.latest.mode, 'agent');
  assert.equal(defaultConversation.latest.accessMode, 'full');
  const workspaceConversation = teamChatConversation(task({ accessMode: 'workspace' }));
  assert.equal(workspaceConversation.latest.mode, 'agent');
  assert.equal(workspaceConversation.latest.accessMode, 'workspace', '明确选择的任务权限仍准确展示');
});

test('主聊天只投影真实用户与岗位消息，不将内部Leader指令和JSON冒充用户', () => {
  const leader = run('leader', { conversationId: 'parent', team: { taskId: 'task', nodeId: 'leader-node', profileId: 'leader', stageKey: 'plan', profileRevision: 1 } });
  const ordinary = run('ordinary', { objective: '既有用户消息', createdAt: '2026-10-28T00:00:00Z' });
  const value = task();
  const entries = teamChatEntries([ordinary, leader], [value, value]);
  assert.deepEqual(entries.map(entry => entry.id), ['ordinary', 'user', 'reply']);
  assert.equal(entries.filter(entry => entry.kind === 'team' && entry.message.role === 'user').length, 1);
  assert.equal(teamChatEntries([leader], [value], '内部岗位').length, 0);
  assert.equal(teamChatEntries([leader], [value], '你好').length, 2);
});

test('尚未取得团队任务时，Run自身chat标记也会隐藏内部Leader内容', () => {
  const leader = run('leader', { team: { taskId: 'task', nodeId: 'leader-node', profileId: 'leader', stageKey: 'plan', profileRevision: 1, interactionMode: 'chat' } });
  assert.deepEqual(teamChatEntries([leader], []), []);
});

test('消息头像取发送者当时的真实模型，交接目标与后续重试不能改写历史身份', () => {
  const value = task();
  const team = { taskId: value.id, nodeId: 'worker', profileId: 'engineer', stageKey: 'implement', profileRevision: 1 };
  value.nodes = [{ id: 'worker', profileId: 'engineer', stage: 'implement', status: 'completed', dependencies: [], round: 0,
    attempt: 2, createdAt: at(0), updatedAt: at(6), effectiveChoice: { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' } } as AdvancedTeamTask['nodes'][number]];
  const runs = [run('leader', { model: 'gpt-6.1-sol', team: { ...team, nodeId: 'leader', profileId: 'leader' } }),
    run('first', { provider: 'claude', model: 'claude-sonnet-5-5', team, createdAt: at(1) }),
    run('retry', { provider: 'cursor', model: 'composer-2.5', team, createdAt: at(5) })];
  const message: TeamChatMessage = { id: 'old-reply', role: 'assistant', profileId: 'engineer', nodeId: 'worker', text: '已处理', createdAt: at(2) };
  assert.deepEqual(teamChatMessageIdentity(message, value, runs), { provider: 'claude', model: 'claude-sonnet-5-5' });
  assert.deepEqual(teamChatMessageIdentity({ ...message, createdAt: at(6) }, value, runs), { provider: 'cursor', model: 'composer-2.5' });
  assert.deepEqual(teamChatMessageIdentity({ ...message, profileId: 'leader' }, value, runs), { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(teamChatMessageIdentity({ ...message, provider: 'codex', model: 'frozen' }, value, runs), { provider: 'codex', model: 'frozen' });
  assert.equal(teamChatMessageIdentity({ ...message, role: 'user' }, value, runs), undefined);
  assert.equal(teamChatMessageIdentity(message, value, []), undefined);
  value.chat!.messages = [message];
  const [entry] = teamChatEntries([], [value], '', runs);
  assert.equal(entry.kind, 'team');
  if (entry.kind === 'team') assert.deepEqual(entry.identity, { provider: 'claude', model: 'claude-sonnet-5-5' });
});

test('岗位概览当前轮优先，直接展示进展、真实模型与历史阻塞，不把总协调的交接当岗位结果', () => {
  const value = task({ round: 1 });
  const old = { id: 'old', profileId: 'engineer' as const, stage: 'implement' as const, status: 'blocked' as const,
    dependencies: [], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(1), error: 'L020 原始错误',
    result: '```delivery-report\n{"taskResult":{"summary":"此前已核对目录"}}\n```' };
  value.nodes = [old, { ...old, id: 'current', round: 1, status: 'running', error: '', result: '', runId: 'worker' }];
  value.chat!.messages = [{ id: 'dispatch', role: 'assistant', profileId: 'leader', nodeId: 'current', kind: 'handoff', text: '交给工程实现', createdAt: at(2) }];
  const worker = run('worker', { provider: 'cursor', model: 'composer-2.5', status: 'running', result: '', events: [
    { id: 'progress', type: 'message', message: '正在检查同步结果', createdAt: at(2) },
    { id: 'tool', type: 'tool', message: '正在执行：git status', createdAt: at(3) },
  ] });
  const groups = teamChatNodeProgress(value, [worker]);
  assert.deepEqual(groups.map(group => group.round), [1, 0]); assert.equal(groups[0].current, true);
  assert.deepEqual(groups[0].nodes[0].identity, { provider: 'cursor', model: 'composer-2.5' });
  assert.equal(groups[0].nodes[0].activity, '正在检查同步结果');
  assert.equal(groups[0].nodes[0].summary, '');
  assert.equal(groups[0].nodes[0].tool?.message, '正在执行：git status');
  assert.equal(groups[1].nodes[0].error, 'L020 原始错误');
  assert.equal(groups[1].nodes[0].summary, '此前已核对目录');
});

test('重试进行中只展示当前运行，不把旧原因和旧结果继续当作当前进展', () => {
  const value = task();
  value.nodes = [{ id: 'worker-node', profileId: 'engineer', stage: 'implement', status: 'running', dependencies: [], round: 0,
    attempt: 2, createdAt: at(0), updatedAt: at(4), runId: 'retry', reason: '上次失败原因', error: '上次错误', result: '上次结果' }];
  const worker = run('retry', { status: 'running', error: '', result: '新版文件正在生成', createdAt: at(4), events: [] });
  const item = teamChatNodeProgress(value, [worker])[0].nodes[0];
  assert.equal(item.summary, '新版文件正在生成');
  assert.equal(item.activity, ''); assert.equal(item.error, '');
});

test('任务查询暂不可用时仍隐藏标记的岗位子会话，不将临时目录当项目', () => {
  const metadata = { taskId: 'task', nodeId: 'node', profileId: 'leader', stageKey: 'plan', profileRevision: 1, interactionMode: 'chat' as const };
  const leader = run('leader', { conversationId: 'parent', team: metadata });
  const child = run('child', { team: { ...metadata, profileId: 'engineer' }, task: { parentConversationId: 'parent', dependsOnConversationIds: [], role: 'worker', title: '工程', source: 'workflow', sourceId: 'team:task' } });
  const views = withTeamChatConversations(buildAgentConversations([leader, child]), []);
  assert.equal(views.length, 1); assert.equal(views[0].id, 'parent'); assert.equal(views[0].title, '团队聊天');
  assert.equal(agentConversationProjectPath(views[0]), '');
});

test('普通对话只显示用户与结果，调度progress和岗位交接不刷屏', () => {
  const value = task();
  value.nodes = [{ id: 'leader-node', profileId: 'leader' } as AdvancedTeamTask['nodes'][number]];
  value.chat!.messages.splice(1, 0,
    { id: 'progress', role: 'assistant', kind: 'progress', text: '派发中', createdAt: at(1) },
    { id: 'internal-handoff', role: 'assistant', profileId: 'leader', nodeId: 'leader-node', kind: 'progress', text: '交给总协调', createdAt: at(1) });
  assert.deepEqual(teamChatEntries([], [value]).map(entry => entry.id), ['user', 'reply']);
  value.nodes.push({ id: 'engineer-node', profileId: 'engineer' } as AdvancedTeamTask['nodes'][number]);
  value.chat!.messages.push({ id: 'worker-handoff', role: 'assistant', profileId: 'leader', nodeId: 'engineer-node', kind: 'handoff', text: '交给工程实现', createdAt: at(3) });
  assert.deepEqual(teamChatEntries([], [value]).map(entry => entry.id), ['user', 'reply']);
  value.chat!.messages.push({ id: 'leader-answer', role: 'assistant', profileId: 'leader', nodeId: 'leader-node', kind: 'handoff', text: '接口冲突仍待确认，先保留现有行为', createdAt: at(4) });
  assert.deepEqual(teamChatEntries([], [value]).map(entry => entry.id), ['user', 'reply']);
  value.chat!.messages.push({ id: 'result', role: 'assistant', profileId: 'leader', kind: 'message', text: '结果已生成', createdAt: at(5) });
  assert.equal(teamChatEntries([], [value]).at(-1)?.id, 'result');
});

test('Leader完成后worker仍执行：侧栏显示团队状态，原Run身份与完成状态不改', () => {
  const leader = run('leader', { conversationId: 'parent', team: { taskId: 'task', nodeId: 'leader-node', profileId: 'leader', stageKey: 'plan', profileRevision: 1 } });
  const worker = run('worker', { team: { taskId: 'task', nodeId: 'worker-node', profileId: 'engineer', stageKey: 'implement', profileRevision: 1 } });
  const unrelated = run('manual-worker', { team: { taskId: 'manual-task', nodeId: 'manual-node', profileId: 'engineer', stageKey: 'implement', profileRevision: 1 } });
  const original = buildAgentConversations([leader, worker, unrelated]);
  const projected = withTeamChatConversations(original, [task()]);
  assert.deepEqual(projected.map(item => item.id).sort(), ['manual-worker', 'parent']);
  const parent = projected.find(item => item.id === 'parent')!;
  assert.equal(parent.latest, original.find(item => item.id === 'parent')!.latest);
  assert.equal(parent.latest.status, 'completed');
  assert.equal(parent.updatedAt, at(3));
  assert.equal(parent.title, '你好');
  assert.equal(agentConversationStatus(parent).label, '团队执行中');
});

test('单Agent后续回复已完成时，旧选项目等待状态不能重新覆盖当前会话', () => {
  const waiting = task({ state: 'waiting_input', reason: '请选择项目', updatedAt: at(9) });
  const manual = run('manual', { conversationId: 'parent', objective: '就是看看本地', createdAt: at(5), updatedAt: at(8) });
  const original = buildAgentConversations([manual])[0];
  assert.equal(isCurrentTeamChatTask(waiting, original), false);
  const projected = withTeamChatConversations([original], [waiting])[0];
  assert.equal(projected.teamChat, undefined);
  assert.equal(agentConversationStatus(projected).label, '本轮完成');
  assert.equal(projected.title, original.title, '普通会话标题不被状态投影改写');
  assert.equal(projected.latest, manual);
  assert.equal(waiting.state, 'waiting_input', '保留历史协作，不伪造任务完成或取消');
  assert.equal(teamChatEntries([manual], [waiting]).length, 3, '历史消息仍保留');
});

test('静止的旧协作不覆盖新的失败或中断；后台更新时间也不能冒充新的用户请求', () => {
  const waiting = task({ state: 'waiting_input', updatedAt: at(9) });
  for (const status of ['failed', 'interrupted', 'cancelled'] as const) {
    const [conversation] = buildAgentConversations([run('manual', { conversationId: 'parent', status, createdAt: at(5) })]);
    const [projected] = withTeamChatConversations([conversation], [waiting]);
    assert.equal(projected.teamChat, undefined);
    assert.equal(agentConversationStatus(projected).value, status);
  }
});

test('旧协作等待用户且后续节点依赖未完成时，不覆盖已结束的单Agent轮次', () => {
  const waiting = task({ state: 'running', updatedAt: at(9), nodes: [
    { id: 'engineer', profileId: 'engineer', stage: 'implement', status: 'waiting_input', dependencies: [], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(2) },
    { id: 'verifier', profileId: 'verifier', stage: 'verify', status: 'pending', dependencies: ['engineer'], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(2) },
  ] });
  for (const state of ['running', 'waiting_input'] as const) {
    waiting.state = state;
    const [conversation] = buildAgentConversations([run('manual', { conversationId: 'parent', createdAt: at(5), updatedAt: at(8) })]);
    assert.equal(isCurrentTeamChatTask(waiting, conversation), false);
    const [projected] = withTeamChatConversations([conversation], [waiting]);
    assert.equal(projected.teamChat, undefined);
    assert.equal(agentConversationStatus(projected).label, '本轮完成');
    assert.equal(waiting.nodes[1].status, 'pending', '展示状态不能改写历史节点或跳过验证');
    assert.equal(waiting.state, state);
  }
});

test('结束旧状态覆盖后仍保留协作会话标题，用户重命名优先', () => {
  const waiting = task({ state: 'waiting_input', updatedAt: at(9) });
  const leader = run('leader', { conversationId: 'parent', team: { taskId: waiting.id, nodeId: 'leader-node', profileId: 'leader', stageKey: 'plan', profileRevision: 1, interactionMode: 'chat' } });
  const manual = run('manual', { conversationId: 'parent', createdAt: at(5), updatedAt: at(8) });
  const original = buildAgentConversations([leader, manual]);
  assert.equal(withTeamChatConversations(original, [waiting])[0].title, '你好');
  assert.equal(withTeamChatConversations(original, [waiting], { parent: '我的标题' })[0].title, '我的标题');
});

test('真实协作执行和新用户回复仍显示当前状态，不因普通回复完成而丢失', () => {
  const [conversation] = buildAgentConversations([run('manual', { conversationId: 'parent', createdAt: at(5) })]);
  for (const status of ['pending', 'queued', 'running'] as const) {
    const value = task({ nodes: [{ id: 'worker', stage: 'implement', profileId: 'engineer', status, dependencies: [], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(6) }] });
    assert.equal(isCurrentTeamChatTask(value, conversation), true);
    assert.equal(agentConversationStatus(withTeamChatConversations([conversation], [value])[0]).label, '团队执行中');
  }
  const blockedDownstream = task({ state: 'waiting_input', nodes: [
    { id: 'implement', stage: 'implement', profileId: 'engineer', status: 'waiting_input', dependencies: [], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(4) },
    { id: 'verify', stage: 'verify', profileId: 'verifier', status: 'pending', dependencies: ['implement'], round: 0, attempt: 1, createdAt: at(0), updatedAt: at(4) },
  ] });
  assert.equal(isCurrentTeamChatTask(blockedDownstream, conversation), false);
  assert.equal(agentConversationStatus(withTeamChatConversations([conversation], [blockedDownstream])[0]).label, '本轮完成');
  const waiting = task({ state: 'waiting_input' });
  waiting.chat!.messages.push({ id: 'new-request', role: 'user', text: '继续执行原计划', createdAt: at(6) });
  assert.equal(isCurrentTeamChatTask(waiting, conversation), true);
  assert.equal(agentConversationStatus(withTeamChatConversations([conversation], [waiting])[0]).label, '等待回复');
});

test('无项目闲聊不会被临时UUID目录分组，绑定项目后只改变展示路径', () => {
  const value = task(), source = buildAgentConversations([run('leader', { conversationId: 'parent' })]);
  let view = withTeamChatConversations(source, [value])[0];
  assert.equal(agentConversationProjectPath(view), '');
  assert.equal(view.latest.workspacePath, '/scratch/chat-workspaces/random');
  value.chat!.workspaceBound = true; value.sourceWorkspacePath = '/real/project';
  view = withTeamChatConversations(source, [value])[0];
  assert.equal(agentConversationProjectPath(view), '/real/project');
  assert.equal(view.latest.workspacePath, '/scratch/chat-workspaces/random');
});

test('首轮派发无Run时仍可从持久任务恢复会话；重命名优先于首条消息', () => {
  const value = task({ state: 'blocked' });
  const [view] = withTeamChatConversations([], [value], { parent: '自定义标题' });
  assert.equal(view.id, 'parent'); assert.equal(view.title, '自定义标题');
  assert.equal(view.runs.length, 0); assert.equal(agentConversationStatus(view).label, '团队受阻');
  assert.equal(teamChatEntries(view.runs, [value]).length, 2);
});

test('团队进度更新时间不改变会话排序，新的真实用户消息才前移', () => {
  const first = task(), second = task({ id: 'second-task', parentConversationId: 'second-parent', createdAt: at(1), updatedAt: at(1), chat: { workspaceBound: false, pendingInputs: [], messages: [{ id: 'second-user', role: 'user', text: '另一个目标', createdAt: at(1) }] } });
  let list = withTeamChatConversations([], [first, second]).sort(compareAgentConversations);
  assert.equal(list[0].id, 'second-parent');
  first.updatedAt = at(8);
  list = withTeamChatConversations([], [first, second]).sort(compareAgentConversations);
  assert.equal(list[0].id, 'second-parent');
  first.chat!.messages.push({ id: 'later-user', role: 'user', text: '补充目标', createdAt: at(9) });
  list = withTeamChatConversations([], [first, second]).sort(compareAgentConversations);
  assert.equal(list[0].id, 'parent');
});

function computedFromSfc(file: string, name: string, bindings: Record<string, unknown>) {
  const script = readFileSync(new URL(`../src/features/agent-workbench/${file}`, import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => declaration.name.getText(tree) === name)!;
  const code = ts.transpileModule(`const ${declaration.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('computed', ...Object.keys(bindings), `${code}; return ${name};`)(computed, ...Object.values(bindings));
}

test('历史协作回复保持可用，新建普通会话必须核对单 Agent 模型与执行器', () => {
  const automatic = ref(true), props = { changing: '', attachmentDraft: { pending: false } };
  const composer = computedFromSfc('AgentComposer.vue', 'canSend', { automatic, props, hasContent: ref(true), switchingProvider: ref(false), canResume: ref(false), runtime: ref(undefined) });
  assert.equal(composer.value, true);
  props.attachmentDraft.pending = true;
  const uploading = computedFromSfc('AgentComposer.vue', 'canSend', { automatic, props, hasContent: ref(true) });
  assert.equal(uploading.value, false);
  const bindings = { selectedRuntime: ref(undefined), selectedModelOption: ref(undefined), effortOptions: ref([]),
    form: { objective: '你好', provider: 'codex', model: 'test', mode: 'agent', accessMode: 'full' }, newAttachments: ref([]),
    changing: ref(''), submittingNew: ref(false), newAttachmentDraft: ref({ pending: false }) };
  assert.equal(computedFromSfc('AgentRuntimePanel.vue', 'canStart', bindings).value, false, '执行器未就绪不得发送新会话');
  bindings.selectedRuntime.value = { ready: true, modes: ['agent'], accessModes: ['full'] };
  bindings.selectedModelOption.value = { id: 'test' };
  assert.equal(computedFromSfc('AgentRuntimePanel.vue', 'canStart', bindings).value, true);
  const selectedConversation = ref({ teamChat: undefined }), creating = ref(false);
  const legacyMode = computedFromSfc('AgentRuntimePanel.vue', 'automaticTeam', { selectedConversation, creating });
  assert.equal(legacyMode.value, false);
  selectedConversation.value = { teamChat: { state: 'completed' } };
  assert.equal(legacyMode.value, true, '历史协作模式随选中会话恢复');
  creating.value = true;
  assert.equal(legacyMode.value, false, '从历史协作新建仍固定单 Agent');
});

test('聊天API只传用户内容、上下文和去重ID，不携带手动模型/流程参数', async () => {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url, init) => { assert.equal(url, '/api/agent-runtimes/team-chat'); sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ task: task(), runId: 'leader', conversationId: 'parent' })); }) as typeof fetch;
  try {
    const input = { objective: '请检查这个问题', attachmentIds: ['attachment'], requestId: 'request', taskId: 'task' };
    const result = await sendTeamChat(input);
    assert.deepEqual(sent, input); assert.equal(result.conversationId, 'parent');
    assert.equal('model' in sent!, false); assert.equal('templateId' in sent!, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('未知回执后从父Run恢复到taskId仍复用该条内容的去重键，其他会话不串键', () => {
  const input = { objective: '补充要求', attachmentIds: ['a'], parentRunId: 'leader-run' };
  const key = teamChatRequestKey(input, 'conversation');
  assert.equal(teamChatRequestKey({ ...input, parentRunId: undefined, taskId: 'recovered-task' }, 'conversation'), key);
  assert.notEqual(teamChatRequestKey(input, 'other-conversation'), key);
  assert.notEqual(teamChatRequestKey({ ...input, objective: '新要求' }, 'conversation'), key);
});

function sfcFunction(name: string, bindings: Record<string, unknown>) {
  const script = readFileSync(new URL('../src/features/agent-workbench/AgentRuntimePanel.vue', import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentRuntimePanel.ts', script, ts.ScriptTarget.Latest, true);
  const statement = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const code = ts.transpileModule(statement.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
}

test('真实续聊发送保留父会话候选，只有用户明确选择项目才发送workspacePath', async () => {
  const native = run('native', { conversationId: 'parent', workspacePath: '/isolated/current', sourceWorkspacePath: '/source/original' });
  const conversation = buildAgentConversations([native])[0];
  const captured: Record<string, unknown>[] = [];
  const currentTask = ref<AdvancedTeamTask>();
  let restored = 0;
  const send = sfcFunction('sendChatMessage', {
    selectionRevision: 1, pendingSelectionRevision: 0, pendingConversationId: ref(''), selectedConversationId: ref('parent'),
    clearConversationDraft: () => ({ attachments: [] }), restoreConversationDraft: () => { restored++; },
    teamChat: { task: currentTask, send: async (input: Record<string, unknown>) => { captured.push(input); return { conversationId: 'parent' }; } },
    query: { refetch: async () => {} },
  });
  await send(conversation, '继续完成');
  assert.equal(captured[0].parentRunId, 'native');
  assert.equal('workspacePath' in captured[0], false);
  await send(conversation, '改用指定项目', '/explicit/project');
  assert.equal(captured[1].workspacePath, '/explicit/project');
  const leader = run('leader', { conversationId: 'parent', team: { taskId: 'recovered-task', nodeId: 'node', profileId: 'leader', stageKey: 'plan', profileRevision: 1, interactionMode: 'chat' } });
  await send(buildAgentConversations([leader])[0], '回复问题');
  assert.equal(captured[2].taskId, 'recovered-task');
  assert.equal('parentRunId' in captured[2], false);
  assert.equal('workspacePath' in captured[2], false);
  assert.equal(restored, 0);
});


test('问题回复状态绑定任务与当前计划，历史问题过期，已答问题和待处理补充可区分', () => {
  const value = task({ state: 'awaiting_plan' });
  value.nodes = [{ id: 'plan-1', stage: 'plan', profileId: 'leader', status: 'completed', dependencies: [], attempt: 1, round: 0, createdAt: at(0), updatedAt: at(1) }];
  const question: TeamChatMessage = { id: 'plan-question:plan-1:Q-1', role: 'assistant', kind: 'question', text: '使用什么值？', nodeId: 'plan-1', createdAt: at(1) };
  value.chat!.messages.push(question);
  assert.equal(teamQuestionState(value, question), 'pending');
  value.chat!.messages.push({ id: 'answer', role: 'user', text: '2', replyTo: question.id, createdAt: at(2) });
  assert.equal(teamQuestionState(value, question), 'answered');
  value.chat!.messages.pop(); value.state = 'planning';
  assert.equal(teamQuestionState(value, question), 'expired');
  value.chat!.pendingInputs.push({ id: 'user', text: '补充要求', attachmentIds: [], createdAt: at(1) });
  const entry = teamChatEntries([], [value]).find(entry => entry.id === 'user');
  assert.equal(entry?.kind === 'team' && entry.pendingInput, true);
});

test('从第二个问题进入主输入时保留精确问题身份，最新房间已回答后不能继续发给旧问题', () => {
  const value = task({ state: 'awaiting_plan' });
  value.nodes = [{ id: 'plan', stage: 'plan', profileId: 'leader', status: 'completed', dependencies: [], attempt: 1, round: 0, createdAt: at(0), updatedAt: at(1) }];
  value.chat!.messages = ['项目目录？', '是否允许提交？'].map((text, index) => ({ id: `plan-question:plan:Q-${index + 1}`, role: 'assistant', kind: 'question', text, nodeId: 'plan', createdAt: at(1) }));
  const target = { taskId: value.id, questionId: 'plan-question:plan:Q-2' };
  assert.deepEqual(teamQuestionReply([value], target), { ...target, text: '是否允许提交？', state: 'pending' });
  value.nodes.push({ ...value.nodes[0], id: 'coordinate', purpose: 'coordinate' } as AdvancedTeamTask['nodes'][number]);
  assert.equal(teamQuestionReply([value], target)?.state, 'pending', '额外协调运行不替换原计划问题');
  const current = structuredClone(value);
  current.chat!.messages.push({ id: 'answer', role: 'user', text: '不要提交', replyTo: target.questionId, createdAt: at(2) });
  const room = { task: current, messages: [] } as unknown as Parameters<typeof teamQuestionReply>[2];
  assert.equal(teamQuestionReply([value], target, room)?.state, 'answered', '新房间覆盖尚未刷新的任务列表');
  assert.equal(teamQuestionReply([value], { ...target, taskId: 'another-task' }, room), undefined, '其他任务不得同名串答');
  current.state = 'completed'; current.chat!.messages.pop();
  assert.equal(teamQuestionReply([value], target, room)?.state, 'expired');
});

test('选中问题过期时禁用发送，不把已写回复悄悄作为新的执行目标', () => {
  const props = { changing: '', questionReply: { text: '是否允许提交？', state: 'expired' }, attachmentDraft: { pending: false } };
  const bindings = { props, automatic: ref(true), draft: ref('不允许'), hasContent: ref(true) };
  assert.equal(computedFromSfc('AgentComposer.vue', 'canSend', bindings).value, false);
  props.questionReply.state = 'pending';
  assert.equal(computedFromSfc('AgentComposer.vue', 'canSend', bindings).value, true);
});

test('问题回复携带选中问题和附件，失败或切会话均保留原会话草稿', async () => {
  const selected = ref('parent'), drafts = useAgentConversationDrafts(selected);
  const file = { id: 'requirement', name: 'requirement.txt', mimeType: 'text/plain', size: 1, url: '/file', createdAt: at(0) };
  drafts.draft.value = '仅修改本地，不要提交'; drafts.attachments.value = [file];
  const conversation = buildAgentConversations([run('native', { conversationId: 'parent' })])[0];
  const target = { taskId: 'task', questionId: 'plan-question:plan:Q-2' };
  const captured: Record<string, unknown>[] = [];
  let success = false;
  const send = sfcFunction('sendQuestionAnswer', {
    selectionRevision: 1, pendingSelectionRevision: 0, pendingConversationId: ref(''), clearConversationDraft: drafts.clear, restoreConversationDraft: drafts.restore,
    teamChat: { tasks: ref([task()]), answer: async (input: Record<string, unknown>, files: unknown[]) => {
      captured.push(input); assert.deepEqual(files, [file]); selected.value = 'another'; return success;
    } },
  });
  await send(conversation, target);
  assert.equal(drafts.draft.value, '', '失败不能串回当前打开的其他会话');
  selected.value = 'parent';
  assert.equal(drafts.draft.value, '仅修改本地，不要提交'); assert.deepEqual(drafts.attachments.value, [file]);
  assert.deepEqual(captured[0], { ...target, text: '仅修改本地，不要提交', attachmentIds: ['requirement'] });
  success = true; await send(conversation, target); selected.value = 'parent';
  assert.equal(drafts.draft.value, ''); assert.deepEqual(drafts.attachments.value, []);
  drafts.dispose();
});

test('协调反馈原样展示，不把停止请求冒充已暂停，已完成任务不保留旧协调状态', () => {
  const value = task();
  value.chat!.coordination = { phase: 'stopping', text: '正在核对原轮次停止状态，尚未确认退出。' };
  assert.equal(teamChatActivity(value), value.chat!.coordination.text);
  value.chat!.coordination = { phase: 'needs_input', text: 'L020 请补充原接口参数' };
  assert.equal(teamChatActivity(value), 'L020 请补充原接口参数');
  value.state = 'completed';
  assert.equal(teamChatActivity(value), '本轮已完成');
  assert.equal(teamChatParticipant({ id: 'summary', role: 'assistant', kind: 'delivery', text: '已完成', createdAt: at(3) }), '团队交付');
});


test('群聊自动任务与内部 Codex 记录不重复进入普通会话，旧协作历史仍可恢复', () => {
  const grouped = task({ id: 'group-task', parentConversationId: 'group-parent', groupRoomId: 'room' });
  const historical = task();
  const groupRun = run('group-node', { conversationId: 'group-parent', sessionId: 'native-group',
    team: { taskId: 'group-task', nodeId: 'group-node', profileId: 'leader', stageKey: 'plan', profileRevision: 1, interactionMode: 'chat' } });
  const ordinary = run('ordinary');
  const value = computedFromSfc('AgentRuntimePanel.vue', 'conversations', {
    teamChat: { allTasks: ref([grouped, historical]) }, runs: ref([groupRun, ordinary]),
    data: ref({ conversationTitles: {}, codexSessions: [{ id: 'native-group', title: '内部群聊', createdAt: at(0), updatedAt: at(0) }] }),
    codexDetails: ref({}), withTeamChatConversations, buildAgentConversationList, compareAgentConversations,
  });
  assert.deepEqual(value.value.map((item: { id: string }) => item.id).sort(), ['ordinary', 'parent']);
  assert.ok(value.value.find((item: { id: string }) => item.id === 'parent').teamChat, '旧协作仍带有续聊路由');
});

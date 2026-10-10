/** 执行真实 SFC 动作和选择 watcher，使用可控请求覆盖竞态；无需启动 CLI 或增加 DOM 测试依赖。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowRef, watch } from 'vue';
import { useAgentConversationDrafts } from '../src/features/agent-workbench/useAgentConversationDrafts.js';
import { buildAgentConversations, findAgentConversation, reconcileAgentConversation, resumedConversationId,
  type AgentConversation as Conversation } from '../src/features/agent-workbench/conversation.js';
import type { AgentProvider, AgentRun, StartAgentRunInput } from '../shared/agent-runtime.js';
import { providerSwitchInput } from '../src/features/agent-workbench/provider-switch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function loadActions<T>(path: string, names: string[], dependencies: Record<string, unknown>, navigation = false): T {
  const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || raw;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pieces: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      pieces.push(node.getText(tree));
    } else if (navigation && ts.isVariableStatement(node) && node.declarationList.declarations.some((item) =>
      ['selectionRevision', 'pendingSelectionRevision'].includes(item.name.getText(tree)))) {
      pieces.push(node.getText(tree));
    } else if (navigation && ts.isExpressionStatement(node) && node.getText(tree).startsWith('watch([conversations,')) {
      pieces.push(node.getText(tree));
    } else ts.forEachChild(node, visit);
  };
  visit(tree);
  const code = ts.transpileModule(pieces.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies)) as T;
}

const panelPath = '../src/features/agent-workbench/AgentRuntimePanel.vue';
test('暂停编辑晚返回不抢回其他会话，不覆盖续聊草稿；保存失败保留编辑内容', async () => {
  const paused = deferred<AgentRun | undefined>();
  const selectedConversationId = shallowRef('a');
  const editSource = shallowRef<AgentRun>();
  const editObjective = shallowRef('');
  const editDialogOpen = shallowRef(false);
  let refreshes = 0;
  let shouldSave = false;
  const actions = loadActions<{ openEditMessage: (run: AgentRun) => Promise<void>; saveEditedMessage: () => Promise<void> }>(panelPath,
    ['openEditMessage', 'saveEditedMessage'], { selectedConversationId, creating: shallowRef(false), editSource, editObjective,
      editDialogOpen, changing: shallowRef(''), pauseForEdit: () => paused.promise,
      revise: async () => shouldSave ? run('new') : undefined, query: { refetch: async () => { refreshes++; } } });
  const opening = actions.openEditMessage(run('a'));
  selectedConversationId.value = 'b';
  paused.resolve({ ...run('a'), pausedForEdit: true });
  await opening;
  assert.equal(editDialogOpen.value, false);
  assert.equal(editSource.value, undefined);
  selectedConversationId.value = 'a';
  await actions.openEditMessage(run('a'));
  assert.equal(editDialogOpen.value, true);
  editObjective.value = '修改后的要求';
  editDialogOpen.value = false;
  await actions.openEditMessage(run('a'));
  assert.equal(editObjective.value, '修改后的要求', '暂不继续后重新打开，保留本地编辑草稿');
  await actions.saveEditedMessage();
  assert.equal(editObjective.value, '修改后的要求');
  assert.equal(editDialogOpen.value, true);
  shouldSave = true;
  await actions.saveEditedMessage();
  assert.equal(editDialogOpen.value, false);
  assert.equal(editSource.value, undefined);
  assert.equal(refreshes, 1);
});

test('暂停确认期间防重复点击，取消不会发送暂停请求', async () => {
  const confirmation = deferred<void>();
  const changing = shallowRef('');
  let requests = 0;
  const actions = loadActions<{ pauseForEdit: (run: AgentRun) => Promise<AgentRun | undefined> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['pauseForEdit'], {
      changing, ElMessageBox: { confirm: () => confirmation.promise }, ElMessage: { error: () => {} },
      post: async () => { requests++; return run('a'); },
    });
  const first = actions.pauseForEdit({ ...run('a'), status: 'running' });
  assert.equal(changing.value, 'edit:a');
  assert.equal(await actions.pauseForEdit({ ...run('a'), status: 'running' }), undefined);
  confirmation.reject(new Error('cancel'));
  assert.equal(await first, undefined);
  assert.equal(requests, 0);
  assert.equal(changing.value, '');
});
const image = { id: 'image-1', name: 'example.png', mimeType: 'image/png' as const, size: 1024, url: '/attachments/image-1' };
function run(id: string, parentRunId = ''): AgentRun {
  return { id, parentRunId, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
    objective: id, workspacePath: '/repo', branch: 'main', headSha: '', status: 'completed', sessionId: '',
    pid: null, result: '', error: '', events: [], createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' };
}
type Actions = {
  sendMessage: (selection: { queuePlacement: 'append'; workflow?: boolean; provider?: AgentProvider; model?: string; reasoningEffort?: string; accessMode?: string }) => Promise<void>;
  startAgentWorkflow: (input: { templateId: 'implement-review'; objective: string }) => Promise<void>;
  retryRun: (run: { id: string }) => Promise<void>;
  selectConversation: (id: string) => void;
  openCreate: () => void;
  submit: () => Promise<void>;
  forkConversation: () => Promise<void>;
  generateDailyReport: (date: string) => Promise<void>;
  openRun: (id: string) => Promise<boolean>;
};

function sendingFixture(initial = buildAgentConversations([run('a'), run('b')])) {
  const scope = effectScope();
  const selectedConversationId = shallowRef(initial[0].id);
  const creating = shallowRef(false);
  const conversations = shallowRef<Conversation[]>(initial);
  const drafts = useAgentConversationDrafts(selectedConversationId);
  const response = deferred<{ id: string } | undefined>();
  const workflowResponse = deferred<{ worker: { id: string } } | undefined>();
  const workflowInputs: unknown[] = [];
  const queryRefresh = deferred<void>();
  const dailyReportStarting = shallowRef(false);
  const reportInputs: unknown[] = [];
  const actions = scope.run(() => loadActions<Actions>(panelPath, ['sendMessage', 'startAgentWorkflow', 'retryRun', 'selectConversation', 'openCreate', 'submit', 'forkConversation', 'generateDailyReport', 'openRun'], {
    selectedConversationId, creating, conversations, watch,
    selectedConversation: computed(() => findAgentConversation(conversations.value, selectedConversationId.value)),
    isPending: shallowRef(false), error: shallowRef(undefined), selectionInitialized: shallowRef(true),
    pendingConversationId: shallowRef(''), rememberedConversationId: '',
    draft: drafts.draft, draftAttachments: drafts.attachments,
    clearConversationDraft: drafts.clear, restoreConversationDraft: drafts.restore, moveConversationDraft: drafts.move,
    resume: () => response.promise, resumeCodexSession: () => response.promise, retry: () => response.promise,
    orchestrate: (_parent: unknown, input: unknown) => { workflowInputs.push(input); return workflowResponse.promise; },
    resumedConversationId, reconcileAgentConversation, providerSwitchInput,
    query: { refetch: () => queryRefresh.promise }, findAgentConversation,
    canStart: shallowRef(true), start: (input: unknown) => { reportInputs.push(input); return response.promise; }, form: {}, newAttachments: shallowRef([]), resetForm: () => {},
    dailyReportStarting, changing: shallowRef(''), sideWorkspacePath: shallowRef('/repo'), dailyReportRuntime: shallowRef({}),
    createDailyReportInput: (date: string) => ({ objective: date, mode: 'ask' }),
    fork: () => response.promise, forkSource: shallowRef({ id: 'a' }), forkObjective: shallowRef('基于此会话新建'), forkAttachments: shallowRef([]),
  }, true))!;
  return { actions, selectedConversationId, conversations, drafts, creating, response, workflowResponse, workflowInputs, queryRefresh, dailyReportStarting, reportInputs, dispose: () => scope.stop() };
}

test('需求开发入口刷新后定位新建会话，期间手动切换时不抢回选中项', async () => {
  for (const switchAway of [false, true]) {
    const state = sendingFixture();
    try {
      const opening = state.actions.openRun('development');
      if (switchAway) state.actions.selectConversation('b');
      state.conversations.value = buildAgentConversations([run('development'), run('a'), run('b')]);
      state.queryRefresh.resolve();
      assert.equal(await opening, !switchAway);
      assert.equal(state.selectedConversationId.value, switchAway ? 'b' : 'development');
    } finally { state.dispose(); }
  }
});

test('跨执行器发送走独立创建，原会话中新写的草稿不迁移到 Cursor', async () => {
  const state = sendingFixture();
  try {
    const original = state.selectedConversationId.value;
    state.drafts.draft.value = 'Cursor 接着检查';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ provider: 'cursor', model: 'auto', reasoningEffort: '', accessMode: 'workspace', queuePlacement: 'append' });
    assert.equal(state.reportInputs.length, 1);
    assert.equal((state.reportInputs[0] as StartAgentRunInput).provider, 'cursor');
    assert.deepEqual((state.reportInputs[0] as StartAgentRunInput).attachmentIds, [image.id]);
    state.drafts.draft.value = '保留给原会话的新草稿';
    state.conversations.value = buildAgentConversations([run('a'), run('b'), { ...run('cursor-new'), provider: 'cursor' }]);
    state.response.resolve({ id: 'cursor-new' });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, 'cursor-new');
    assert.equal(state.drafts.draft.value, '');
    state.actions.selectConversation(original);
    assert.equal(state.drafts.draft.value, '保留给原会话的新草稿');
  } finally { state.dispose(); }
});

test('跨执行器取消创建恢复原草稿，重复发送不会创建两次', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '待发送';
    state.drafts.attachments.value = [image];
    const selection = { provider: 'cursor' as const, model: 'auto', reasoningEffort: '', accessMode: 'workspace', queuePlacement: 'append' as const };
    const pending = state.actions.sendMessage(selection);
    await state.actions.sendMessage(selection);
    assert.equal(state.reportInputs.length, 1);
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.drafts.draft.value, '待发送');
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('Codex 仍走原 CLI 续接，取消时附件不丢弃', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '继续';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ provider: 'codex', queuePlacement: 'append' });
    assert.equal(state.reportInputs.length, 0);
    state.response.resolve(undefined);
    await pending;
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('日报重复点击只创建一次，独立选择新会话并保留原草稿及附件', async () => {
  const state = sendingFixture();
  try {
    const original = state.selectedConversationId.value;
    state.drafts.draft.value = '未发送开发要求';
    state.drafts.attachments.value = [image];
    const pending = state.actions.generateDailyReport('2026-09-22');
    await state.actions.generateDailyReport('2026-09-22');
    assert.equal(state.reportInputs.length, 1);
    state.response.resolve({ id: 'daily-report' });
    await pending;
    assert.equal(state.selectedConversationId.value, 'daily-report');
    assert.equal(state.dailyReportStarting.value, false);
    state.actions.selectConversation(original);
    assert.equal(state.drafts.draft.value, '未发送开发要求');
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('日报创建期间手动切换会话后，响应不抢回选中项', async () => {
  const state = sendingFixture();
  try {
    const pending = state.actions.generateDailyReport('2026-09-22');
    state.actions.selectConversation('b');
    state.response.resolve({ id: 'daily-report' });
    await pending;
    assert.equal(state.selectedConversationId.value, 'b');
    assert.equal(state.dailyReportStarting.value, false);
  } finally { state.dispose(); }
});

test('取消日报创建不切换会话，仍可重新创建', async () => {
  const state = sendingFixture();
  try {
    const original = state.selectedConversationId.value;
    const pending = state.actions.generateDailyReport('2026-09-22');
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.selectedConversationId.value, original);
    assert.equal(state.dailyReportStarting.value, false);
    await state.actions.generateDailyReport('2026-09-22');
    assert.equal(state.reportInputs.length, 2);
  } finally { state.dispose(); }
});

test('实现并复核从主输入框传递图片，失败后恢复原草稿', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '完成抽屉改造';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ queuePlacement: 'append', workflow: true });
    assert.equal(state.drafts.draft.value, '');
    assert.deepEqual(state.workflowInputs, [{ templateId: 'implement-review', objective: '完成抽屉改造',
      model: undefined, reasoningEffort: undefined, accessMode: undefined, attachmentIds: [image.id] }]);
    state.drafts.draft.value = '补充要求';
    state.workflowResponse.resolve(undefined);
    await pending;
    assert.match(state.drafts.draft.value, /完成抽屉改造/);
    assert.match(state.drafts.draft.value, /补充要求/);
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('工作流启动期间切换会话，不抢回选中项或清除新草稿', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '实现需求';
    const pending = state.actions.startAgentWorkflow({ templateId: 'implement-review', objective: '实现需求' });
    state.drafts.draft.value = '下一条要求';
    state.actions.selectConversation('b');
    state.workflowResponse.resolve({ worker: { id: 'worker' } });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, 'b');
    state.actions.selectConversation('a');
    assert.equal(state.drafts.draft.value, '下一条要求');
  } finally { state.dispose(); }
});

test('发送成功后保留请求期间新写的文本和附件，并尊重用户切换会话', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '本次发送';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    assert.equal(state.drafts.draft.value, '');
    assert.deepEqual(state.drafts.attachments.value, []);
    state.drafts.draft.value = '下一条内容';
    const nextImage = { ...image, id: 'image-2' };
    state.drafts.attachments.value = [nextImage];
    state.actions.selectConversation('b');
    state.drafts.draft.value = 'B 草稿';
    state.conversations.value = [...state.conversations.value];
    await nextTick();
    assert.equal(state.selectedConversationId.value, 'b', '请求期间 SSE 刷新不能拉回 A');
    state.response.resolve({ id: 'a' });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, 'b');
    assert.equal(state.drafts.draft.value, 'B 草稿');
    state.actions.selectConversation('a');
    assert.equal(state.drafts.draft.value, '下一条内容');
    assert.deepEqual(state.drafts.attachments.value, [nextImage]);
  } finally { state.dispose(); }
});

test('共享旧 Codex 会话分叉后仍停留原行，保留发送期间的新草稿', async () => {
  const first = { ...run('first'), conversationId: 'conversation-first', sessionId: 'shared-session' };
  const other = { ...run('other', 'first'), conversationId: 'conversation-other', sessionId: 'shared-session' };
  const state = sendingFixture(buildAgentConversations([first, other]));
  try {
    state.actions.selectConversation('conversation-first');
    state.drafts.draft.value = '本次发送';
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    state.drafts.draft.value = '下一条草稿';
    const forked = { ...run('forked'), conversationId: 'conversation-first', sessionId: 'new-session',
      createdAt: '2026-09-22T00:01:00Z', updatedAt: '2026-09-22T00:01:00Z' };
    state.conversations.value = buildAgentConversations([first, other, forked]);
    state.response.resolve(forked);
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.conversations.value.length, 2);
    assert.equal(state.selectedConversationId.value, 'conversation-first');
    assert.equal(state.drafts.draft.value, '下一条草稿');
  } finally { state.dispose(); }
});

test('发送失败恢复原草稿及附件，同时保留后续输入', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '本次发送';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    state.drafts.draft.value = '下一条内容';
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.drafts.draft.value, '本次发送\n\n下一条内容');
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('发送异常抛出时恢复原会话草稿，不覆盖已切换会话', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '本次发送';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    state.actions.selectConversation('b');
    state.drafts.draft.value = 'B 草稿';
    state.response.reject(new Error('连接失败'));
    await assert.rejects(pending, /连接失败/);
    assert.equal(state.selectedConversationId.value, 'b');
    assert.equal(state.drafts.draft.value, 'B 草稿');
    state.actions.selectConversation('a');
    assert.equal(state.drafts.draft.value, '本次发送');
    assert.deepEqual(state.drafts.attachments.value, [image]);
  } finally { state.dispose(); }
});

test('已发送成功但列表刷新失败时不恢复已发送内容', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '本次发送';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    state.response.resolve({ id: 'a' });
    await Promise.resolve();
    state.queryRefresh.reject(new Error('刷新失败'));
    await assert.rejects(pending, /刷新失败/);
    assert.equal(state.drafts.draft.value, '');
    assert.deepEqual(state.drafts.attachments.value, []);
  } finally { state.dispose(); }
});

test('续接历史会话时迁移后续草稿，并选中已建立的本地会话', async () => {
  const state = sendingFixture();
  try {
    state.conversations.value[0].source = 'codex';
    state.drafts.draft.value = '本次发送';
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    state.drafts.draft.value = '历史会话的下一条';
    state.response.resolve({ id: 'continued-a' });
    await Promise.resolve();
    state.conversations.value = [...state.conversations.value, ...buildAgentConversations([run('continued-a')])];
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, 'continued-a');
    assert.equal(state.drafts.draft.value, '历史会话的下一条');
  } finally { state.dispose(); }
});

test('重试返回时不会覆盖用户打开的新会话页面', async () => {
  const state = sendingFixture();
  try {
    const pending = state.actions.retryRun({ id: 'a' });
    state.actions.openCreate();
    state.response.resolve({ id: 'a' });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.creating.value, true);
    assert.equal(state.selectedConversationId.value, '');
  } finally { state.dispose(); }
});

for (const order of ['stream-first', 'response-first', 'failure', 'switch-away'] as const) {
  test(`50 条截断后继续发送保持会话及新草稿：${order}`, async () => {
    const runs = Array.from({ length: 50 }, (_, index) => run(`a-${index}`, index ? `a-${index - 1}` : ''));
    const state = sendingFixture(buildAgentConversations(runs));
    try {
      state.drafts.draft.value = '本次发送';
      const pending = state.actions.sendMessage({ queuePlacement: 'append' });
      state.drafts.draft.value = '下一条草稿';
      state.drafts.attachments.value = [image];
      if (order === 'response-first') { state.response.resolve({ id: 'a-50' }); await nextTick(); }
      if (order === 'switch-away') {
        state.conversations.value = [...state.conversations.value, ...buildAgentConversations([run('b')])];
        state.actions.selectConversation('b');
        state.drafts.draft.value = 'B 的草稿';
      }
      state.conversations.value = buildAgentConversations([...runs.slice(1), run('a-50', 'a-49'), run('b')]);
      await nextTick();
      assert.equal(state.selectedConversationId.value, order === 'switch-away' ? 'b' : 'a-1', 'HTTP 响应前就应保持有效选中');
      state.response.resolve(order === 'failure' ? undefined : { id: 'a-50' });
      state.queryRefresh.resolve();
      await pending;
      await nextTick();
      assert.equal(state.selectedConversationId.value, order === 'switch-away' ? 'b' : 'a-1');
      if (order === 'switch-away') {
        assert.equal(state.drafts.draft.value, 'B 的草稿');
        state.actions.selectConversation('a-1');
      }
      assert.equal(state.drafts.draft.value, order === 'failure' ? '本次发送\n\n下一条草稿' : '下一条草稿');
      assert.deepEqual(state.drafts.attachments.value, [image]);
    } finally { state.dispose(); }
  });
}

for (const action of ['submit', 'forkConversation'] as const) {
  test(`${action} 晚返回时保留用户选择和对应草稿`, async () => {
    const state = sendingFixture();
    try {
      const pending = state.actions[action]();
      state.actions.selectConversation('b');
      state.drafts.draft.value = 'B 草稿';
      state.response.resolve({ id: 'new-a' });
      state.queryRefresh.resolve();
      await pending;
      assert.equal(state.selectedConversationId.value, 'b');
      assert.equal(state.drafts.draft.value, 'B 草稿');
    } finally { state.dispose(); }
  });
}

test('删除确认及请求期间防重复点击，并明确会停止运行和排队任务', async () => {
  const confirmation = deferred<void>(), response = deferred<void>();
  const changing = shallowRef('');
  let confirmations = 0, requests = 0;
  const runtime = loadActions<{ removeConversation: (id: string, source: 'workspace') => Promise<boolean> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['removeConversation'], {
      changing, codexDetails: shallowRef({}),
      ElMessageBox: { confirm: async (message: string) => {
        confirmations++;
        assert.match(message, /停止.*运行和排队/);
        assert.match(message, /不会删除工作区文件/);
        return confirmation.promise;
      } },
      ElMessage: { success: () => {}, error: () => {} },
      post: async (path: string) => { assert.equal(path, '/api/agent-runtimes/conversations/a/delete'); requests++; return response.promise; },
    });
  const pending = runtime.removeConversation('a', 'workspace');
  assert.equal(changing.value, 'a');
  assert.equal(await runtime.removeConversation('a', 'workspace'), false);
  assert.equal(requests, 0);
  confirmation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await runtime.removeConversation('a', 'workspace'), false);
  assert.equal(requests, 1);
  assert.equal(confirmations, 1);
  response.resolve();
  assert.equal(await pending, true);
  assert.equal(changing.value, '');
});

test('删除排队消息经确认后调用单轮删除接口，确认期间防止重复操作', async () => {
  const confirmation = deferred<void>(), response = deferred<void>();
  const changing = shallowRef('');
  let requests = 0;
  const runtime = loadActions<{ deleteQueuedRun: (run: AgentRun) => Promise<boolean> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['deleteQueuedRun'], {
      changing,
      ElMessageBox: { confirm: async (message: string) => {
        assert.match(message, /删除后不会执行/);
        assert.match(message, /后续排队.*不受影响/);
        return confirmation.promise;
      } },
      ElMessage: { success: () => {}, error: () => {} },
      post: async (path: string) => {
        assert.equal(path, '/api/agent-runtimes/runs/queued/delete');
        requests++;
        return response.promise;
      },
    });
  const queued = { ...run('queued', 'running'), status: 'queued' as const };
  const pending = runtime.deleteQueuedRun(queued);
  assert.equal(changing.value, 'delete:queued');
  assert.equal(await runtime.deleteQueuedRun(queued), false);
  confirmation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  response.resolve();
  assert.equal(await pending, true);
  assert.equal(changing.value, '');
});

for (const outcome of ['cancel', 'failure', 'success'] as const) {
  test(`删除会话 ${outcome} 时仅成功才清除草稿和附件`, async () => {
    const selectedConversationId = shallowRef('a');
    const drafts = useAgentConversationDrafts(selectedConversationId);
    drafts.draft.value = '未发送的草稿';
    drafts.attachments.value = [image];
    let postCount = 0;
    let removedAttachments = 0;
    const runtime = loadActions<{ removeConversation: (id: string, source: 'workspace') => Promise<boolean> }>(
      '../src/features/agent-workbench/useAgentRuntimes.ts', ['removeConversation'], {
        changing: shallowRef(''), codexDetails: shallowRef({}),
        ElMessageBox: { confirm: async () => { if (outcome === 'cancel') throw new Error('cancel'); } },
        ElMessage: { success: () => {}, error: () => {} },
        post: async () => { postCount++; if (outcome === 'failure') throw new Error('请求失败'); },
      });
    const panel = loadActions<{ removeAgentConversation: (conversation: { id: string; source: 'workspace' }) => Promise<void> }>(
      panelPath, ['removeAgentConversation'], {
        removeConversation: runtime.removeConversation, clearConversationDraft: drafts.clear,
        removePendingAgentAttachments: async (attachments: unknown[]) => { removedAttachments += attachments.length; },
      });
    await panel.removeAgentConversation({ id: 'a', source: 'workspace' });
    assert.equal(postCount, outcome === 'cancel' ? 0 : 1);
    assert.equal(drafts.draft.value, outcome === 'success' ? '' : '未发送的草稿');
    assert.deepEqual(drafts.attachments.value, outcome === 'success' ? [] : [image]);
    assert.equal(removedAttachments, outcome === 'success' ? 1 : 0);
  });
}

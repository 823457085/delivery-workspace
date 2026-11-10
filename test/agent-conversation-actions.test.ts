/** 执行真实 SFC 动作和选择 watcher，使用可控请求覆盖竞态；无需启动 CLI 或增加 DOM 测试依赖。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowRef, watch } from 'vue';
import { useAgentConversationDrafts } from '../src/features/agent-workbench/useAgentConversationDrafts.js';
import { AgentAttachmentDraft } from '../src/features/agent-workbench/useAgentAttachments.js';
import { agentConversationContinuation, agentConversationInsertRun, buildAgentConversations, findAgentConversation, reconcileAgentConversation, resumedConversationId,
  type AgentConversation as Conversation } from '../src/features/agent-workbench/conversation.js';
import type { AgentConversationDeleteResult, AgentConversationDeleteTarget, AgentProvider, AgentRun, AgentRunMode, AgentRuntimeHealth, StartAgentRunInput } from '../shared/agent-runtime.js';
import { codexWorkbenchDefaults, workbenchRuntime } from '../shared/agent-runtime.js';
import { providerSwitchInput } from '../src/features/agent-workbench/provider-switch.js';
import { codexServiceTier } from '../src/features/agent-workbench/model-speed.js';
import { useAgentModelSelection } from '../src/features/agent-workbench/model-selection.js';

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
test('仅切换执行器下拉不发送任务或改写草稿，明确发送才携带本轮选择', async () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentComposer.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentComposer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const conversation = buildAgentConversations([{ ...run('current'), mode: 'agent', accessMode: 'full', sessionId: 'native-session' }])[0];
  const draft = shallowRef('仅处理本轮新增要求');
  const savedSelections = new Map([[`agent-model-selection:v2:${conversation.id}:codex`, JSON.stringify({ model: 'codex-model', reasoningEffort: 'low' })]]);
  const providerChanges: AgentProvider[] = [];
  const runtimeRevision = shallowRef(0);
  let failPreferenceWrite = false;
  const emitted: { event: string; selection: { provider: AgentProvider; model: string; reasoningEffort: string; accessMode: string; serviceTier?: string } }[] = [];
  const agentModelDefaults = shallowRef({ model: codexWorkbenchDefaults.model as string, reasoningEffort: 'ultra' as 'low' | 'ultra', revision: '' });
  const runtimes = [
    { provider: 'codex', ready: true, modes: ['agent'], defaultModel: codexWorkbenchDefaults.model, models: [
      { id: codexWorkbenchDefaults.model, efforts: ['low', 'ultra'], defaultEffort: 'ultra' },
      { id: 'codex-model', efforts: ['low'], defaultEffort: 'low' },
    ] },
    { provider: 'cursor', ready: true, modes: ['agent'], defaultModel: 'auto', models: [{ id: 'auto' }] },
    { provider: 'claude', ready: true, modes: ['agent'], accessModes: ['workspace'], defaultModel: 'sonnet', models: [{ id: 'sonnet' }, { id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
  ] as AgentRuntimeHealth[];
  const props = { conversation, changing: '', running: false, canInsert: false, businessOptions: [],
    get runtimes() { void runtimeRevision.value; return runtimes.map(runtime => workbenchRuntime(runtime, agentModelDefaults.value)); } };
  const dependencies = { computed, shallowRef, watch, useTemplateRef: () => shallowRef(), agentConversationContinuation,
    agentConversationInsertRun, codexWorkbenchDefaults, codexServiceTier, agentModelDefaults, useAgentModelSelection,
    defineProps: () => props, defineModel: (name: unknown) => name === 'automatic' ? shallowRef(false) : name === 'attachments' ? shallowRef([]) : draft,
    // providerChange 只同步侧栏额度显示，不属于父组件请求。
    defineEmits: () => (event: string, selection: { provider: AgentProvider; model: string; reasoningEffort: string; accessMode: string } | AgentProvider) => {
      if (event === 'providerChange') providerChanges.push(selection as AgentProvider);
      else emitted.push({ event, selection: selection as Exclude<typeof selection, AgentProvider> });
    },
    defineExpose: () => {}, window: { localStorage: { getItem: (key: string) => savedSelections.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failPreferenceWrite) throw new Error('storage unavailable'); savedSelections.set(key, value); } } } };
  const scope = effectScope();
  try {
    const createState = () => new Function(...Object.keys(dependencies), `${code}\nreturn { selectedProvider, selectedModel, selectedEffort, effortOptions, setModel, saveModelSelection, canSend, submit };`)
      (...Object.values(dependencies)) as { selectedProvider: { value: AgentProvider }; selectedModel: { value: string }; selectedEffort: { value: string };
        effortOptions: { value: string[] }; saveModelSelection: () => void; setModel: (model: string) => void; canSend: { value: boolean }; submit: () => void };
    const state = scope.run(createState)!;
    assert.equal(state.selectedModel.value, 'gpt-6.1-sol', '旧版保存的模型不覆盖统一默认值');
    assert.equal(state.selectedEffort.value, 'ultra');
    state.setModel('codex-model');
    await nextTick();
    const reopened = effectScope();
    try {
      const restored = reopened.run(createState)!;
      assert.equal(restored.selectedModel.value, 'codex-model', '更新后手动选择仍可保存并回读');
      assert.equal(restored.selectedEffort.value, 'low');
    } finally { reopened.stop(); }
    agentModelDefaults.value = { model: 'gpt-6.1-sol', reasoningEffort: 'low', revision: 'apply-1' };
    await nextTick();
    assert.equal(state.selectedModel.value, 'gpt-6.1-sol', '统一应用覆盖上一次手动选择');
    assert.equal(state.selectedEffort.value, 'low');
    agentModelDefaults.value = { model: 'gpt-6.1-sol', reasoningEffort: 'ultra', revision: 'apply-2' };
    await nextTick();
    assert.equal(state.selectedEffort.value, 'ultra', '同模型仅修改强度也即时应用');
    state.setModel('codex-model');
    await nextTick();
    assert.equal(JSON.parse(savedSelections.get(`agent-model-selection:v3:${conversation.id}:codex`)!).revision, 'apply-2');
    agentModelDefaults.value = { ...agentModelDefaults.value, revision: 'apply-3' };
    await nextTick();
    assert.equal(state.selectedModel.value, 'gpt-6.1-sol', '重复应用相同默认值也清除会话覆盖');
    failPreferenceWrite = true;
    state.selectedEffort.value = 'low';
    state.saveModelSelection();
    runtimeRevision.value++;
    await nextTick();
    assert.equal(state.selectedEffort.value, 'low', '存储失败时目录刷新仍保留页面内的手动选择');
    failPreferenceWrite = false;
    state.selectedProvider.value = 'cursor';
    await nextTick();
    assert.equal(state.canSend.value, true);
    assert.equal(emitted.length, 0, '选择及配置 watcher 不得触发父组件请求');
    assert.equal(providerChanges.at(-1), 'cursor', '下拉选择同步给侧栏额度');
    assert.equal(draft.value, '仅处理本轮新增要求');
    assert.equal(conversation.latest.provider, 'codex');
    state.submit();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'send');
    assert.equal(emitted[0].selection.provider, 'cursor');
    assert.equal(emitted[0].selection.model, 'auto');
    state.selectedProvider.value = 'claude';
    await nextTick();
    assert.equal(state.selectedModel.value, 'sonnet');
    assert.equal(state.selectedEffort.value, '');
    state.setModel('opus');
    await nextTick();
    assert.deepEqual(state.effortOptions.value, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(state.selectedEffort.value, '', '不猜测 CLI 的默认强度');
    assert.equal(state.canSend.value, true, '默认强度允许发送');
    state.selectedEffort.value = 'max';
    state.saveModelSelection();
    const savedClaude = effectScope();
    try {
      const restored = savedClaude.run(createState)!;
      restored.selectedProvider.value = 'claude';
      await nextTick();
      assert.equal(restored.selectedEffort.value, 'max', '重新打开保留 Claude 强度');
    } finally { savedClaude.stop(); }
    state.submit();
    assert.equal(emitted[1].selection.provider, 'claude');
    assert.equal(emitted[1].selection.model, 'opus');
    assert.equal(emitted[1].selection.reasoningEffort, 'max');
    assert.equal(emitted[1].selection.accessMode, 'workspace', '从完全访问会话切到 Claude 时使用支持的权限');
    assert.equal('serviceTier' in emitted[1].selection, false);
    assert.equal(JSON.parse(savedSelections.get(`agent-model-selection:${conversation.id}:claude`)!).model, 'opus');
    state.setModel('sonnet');
    await nextTick();
    assert.deepEqual(state.effortOptions.value, []);
    assert.equal(state.selectedEffort.value, '', '切换到无强度能力模型时清空旧值');
    savedSelections.delete(`agent-model-selection:${conversation.id}:claude`);
    conversation.runs[0].provider = 'claude';
    conversation.runs[0].model = 'opus';
    conversation.runs[0].reasoningEffort = 'high';
    const reopenedClaude = effectScope();
    try {
      const restored = reopenedClaude.run(createState)!;
      assert.equal(restored.selectedProvider.value, 'claude');
      assert.equal(restored.selectedModel.value, 'opus', '同执行器 Claude 续聊保留原模型');
      assert.equal(restored.selectedEffort.value, 'high', '无本地偏好时续聊沿用原轮强度');
    } finally { reopenedClaude.stop(); }
  } finally { scope.stop(); }
});


test('新会话按模型能力提供 Claude 强度，切换执行器和不支持的模型时清空旧档位', async () => {
  const source = readFileSync(new URL(panelPath, import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentRuntimePanel.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = tree.statements.filter(node => ['watch(selectedRuntime,', 'watch(selectedModelOption,']
    .some(prefix => node.getText(tree).startsWith(prefix)));
  const code = ts.transpileModule(statements.map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const form = reactive({ provider: 'codex', model: 'codex-model', reasoningEffort: 'high' });
  const runtimes = [
    { provider: 'codex', modes: ['agent'], defaultModel: 'codex-model', models: [{ id: 'codex-model', efforts: ['high'], defaultEffort: 'high' }] },
    { provider: 'claude', modes: ['agent'], defaultModel: 'opus', models: [{ id: 'opus', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku' }] },
  ];
  const selectedRuntime = computed(() => runtimes.find(runtime => runtime.provider === form.provider));
  const selectedModelOption = computed(() => selectedRuntime.value?.models.find(model => model.id === form.model));
  const scope = effectScope();
  try {
    scope.run(() => new Function('watch', 'form', 'selectedRuntime', 'selectedModelOption', code)(watch, form, selectedRuntime, selectedModelOption));
    assert.equal(form.reasoningEffort, 'high');
    form.provider = 'claude';
    await nextTick();
    assert.equal(form.model, 'opus');
    assert.equal(form.reasoningEffort, '', '切换执行器不继承 Codex 强度');
    form.reasoningEffort = 'max';
    form.model = 'haiku';
    await nextTick();
    assert.equal(form.reasoningEffort, '');
    form.model = 'opus';
    await nextTick();
    assert.equal(form.reasoningEffort, '', '保留 CLI 默认值');
    form.provider = 'codex';
    await nextTick();
    assert.equal(form.reasoningEffort, 'high');
  } finally { scope.stop(); }
});

test('访问选择器拒绝执行器不支持的权限，恢复旧状态及只读模式时归一为工作区访问', async () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentAccessSelector.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentAccessSelector.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const accessMode = shallowRef('full');
  const props = reactive({ mode: 'agent', disabled: false, accessModes: ['workspace'] });
  const scope = effectScope();
  try {
    const select = scope.run(() => new Function('computed', 'watch', 'defineProps', 'withDefaults', 'defineModel', 'defineEmits', `${code}\nreturn select;`)(
      computed, watch, () => props, (value: unknown) => value, () => accessMode, () => () => {})) as (command: unknown) => void;
    assert.equal(accessMode.value, 'workspace');
    select('full');
    select('unknown');
    assert.equal(accessMode.value, 'workspace');
    props.accessModes = ['workspace', 'full'];
    await nextTick();
    select('full');
    assert.equal(accessMode.value, 'full');
    props.mode = 'ask';
    await nextTick();
    assert.equal(accessMode.value, 'workspace');
    select('full');
    assert.equal(accessMode.value, 'workspace');
  } finally { scope.stop(); }
});

test('统一应用刷新已挂载新建会话的模型与强度并保留草稿，其他执行器不受影响', async () => {
  const source = readFileSync(new URL(panelPath, import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentRuntimePanel.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = tree.statements.find(node => node.getText(tree).startsWith('watch(() => agentModelDefaults.value.revision'))!;
  const code = ts.transpileModule(statement.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const form = reactive({ provider: 'codex', model: 'manual', reasoningEffort: 'low', objective: '保留草稿' });
  const agentModelDefaults = shallowRef({ model: 'gpt-6.1-sol', reasoningEffort: 'ultra', revision: '' });
  const scope = effectScope();
  try {
    scope.run(() => new Function('watch', 'form', 'agentModelDefaults', code)(watch, form, agentModelDefaults));
    agentModelDefaults.value = { ...agentModelDefaults.value, revision: 'apply' };
    await nextTick();
    assert.equal(form.model, 'gpt-6.1-sol');
    assert.equal(form.reasoningEffort, 'ultra');
    assert.equal(form.objective, '保留草稿');
    for (const provider of ['cursor', 'claude']) {
      form.provider = provider; form.model = provider === 'cursor' ? 'auto' : 'opus'; form.reasoningEffort = '';
      agentModelDefaults.value = { ...agentModelDefaults.value, revision: `apply-${provider}` };
      await nextTick();
      assert.equal(form.model, provider === 'cursor' ? 'auto' : 'opus');
      assert.equal(form.reasoningEffort, '');
    }
  } finally { scope.stop(); }
});

test('输入框先放行输入法确认，上传期间 Enter 不发送，结束后恢复发送', () => {
  const pending = shallowRef(true);
  const emitted: string[] = [];
  let handledMentions = 0;
  const actions = loadActions<{ onKeydown: (event: KeyboardEvent) => void }>(
    '../src/features/agent-workbench/AgentPromptEditor.vue', ['onKeydown'], {
      props: { submitOnEnter: true, disabled: false }, attachedFiles: { pending },
      mentions: { handleKeydown: () => { handledMentions++; return false; } }, emit: (event: string) => emitted.push(event),
    });
  const event = (input: Partial<KeyboardEvent> = {}) => ({ key: 'Enter', keyCode: 13, isComposing: false,
    shiftKey: false, preventDefault() {}, ...input } as KeyboardEvent);
  actions.onKeydown(event({ isComposing: true }));
  actions.onKeydown(event({ keyCode: 229 }));
  assert.equal(handledMentions, 0);
  assert.deepEqual(emitted, []);
  actions.onKeydown(event());
  assert.deepEqual(emitted, []);
  pending.value = false;
  actions.onKeydown(event({ shiftKey: true }));
  assert.deepEqual(emitted, []);
  actions.onKeydown(event());
  assert.deepEqual(emitted, ['submit']);
});

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
  sendMessage: (selection: { queuePlacement: 'append' | 'next'; workflow?: boolean; provider?: AgentProvider; mode?: AgentRunMode; model?: string; reasoningEffort?: string; accessMode?: string }) => Promise<void>;
  startAgentWorkflow: (input: { templateId: 'implement-review'; objective: string }) => Promise<void>;
  retryRun: (run: { id: string }, selection?: Pick<AgentRun, 'mode' | 'accessMode'>) => Promise<void>;
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
  const response = deferred<{ id: string; conversationId?: string } | undefined>();
  const resumeInputs: unknown[][] = [];
  const retryInputs: unknown[][] = [];
  const workflowResponse = deferred<{ worker: { id: string } } | undefined>();
  const workflowInputs: unknown[] = [];
  const queryRefresh = deferred<void>();
  const dailyReportStarting = shallowRef(false);
  const reportInputs: unknown[] = [];
  const newAttachments = shallowRef<typeof image[]>([]);
  const newAttachmentDraft = shallowRef(new AgentAttachmentDraft(newAttachments));
  const forkAttachments = shallowRef<typeof image[]>([]);
  const forkAttachmentDraft = shallowRef(new AgentAttachmentDraft(forkAttachments));
  const submittingNew = shallowRef(false);
  // 原有动作回归继续覆盖手动模式；自动模式另用真实发送函数和独立可控回执覆盖。
  const automaticTeam = shallowRef(false);
  const form = { objective: '自动聊天目标', workspacePath: '', accessMode: 'full' as const };
  const teamInputs: unknown[][] = [];
  const teamResponse = deferred<{ task: unknown; runId: string; conversationId: string } | undefined>();
  const teamChat = { task: shallowRef(undefined), allTasks: shallowRef([]), changing: shallowRef(''), refetch: async () => {}, send: (...args: unknown[]) => { teamInputs.push(args); return teamResponse.promise; } };
  const actions = scope.run(() => loadActions<Actions>(panelPath, ['sendMessage', 'sendChatMessage', 'startAgentWorkflow', 'retryRun', 'selectConversation', 'openCreate', 'submit', 'forkConversation', 'generateDailyReport', 'openRun'], {
    selectedConversationId, creating, conversations, watch, automaticTeam, teamChat,
    groupMode: shallowRef(false), data: shallowRef({ runs: [] }),
    selectedConversation: computed(() => findAgentConversation(conversations.value, selectedConversationId.value)),
    isPending: shallowRef(false), error: shallowRef(undefined), selectionInitialized: shallowRef(true),
    pendingConversationId: shallowRef(''), rememberedConversationId: '',
    draft: drafts.draft, draftAttachments: drafts.attachments,
    clearConversationDraft: drafts.clear, restoreConversationDraft: drafts.restore, moveConversationDraft: drafts.move,
    attachmentsPending: drafts.attachmentsPending,
    resume: (...args: unknown[]) => { resumeInputs.push(args); return response.promise; }, resumeCodexSession: () => response.promise,
    retry: (...args: unknown[]) => { retryInputs.push(args); return response.promise; },
    orchestrate: (_parent: unknown, input: unknown) => { workflowInputs.push(input); return workflowResponse.promise; },
    resumedConversationId, reconcileAgentConversation, providerSwitchInput, agentConversationContinuation, agentConversationInsertRun,
    query: { refetch: () => queryRefresh.promise }, findAgentConversation,
    dailyReportForDate: () => undefined, canStart: shallowRef(true), start: (input: unknown) => { reportInputs.push(input); return response.promise; }, form, workspacePaths: shallowRef([]), newAttachments, newAttachmentDraft, submittingNew, panelDisposed: false, resetForm: () => {},
    dailyReportStarting, changing: shallowRef(''), sideWorkspacePath: shallowRef('/repo'), dailyReportRuntime: shallowRef({}),
    createDailyReportInput: (date: string) => ({ objective: date, mode: 'ask' }), agentModelDefaults: shallowRef(codexWorkbenchDefaults),
    fork: () => response.promise, forkSource: shallowRef({ id: 'a' }), forkObjective: shallowRef('基于此会话新建'), forkAttachments, forkAttachmentDraft,
  }, true))!;
  return { actions, automaticTeam, teamChat, teamInputs, teamResponse, form, selectedConversationId, conversations, drafts, creating, response, resumeInputs, retryInputs, workflowResponse, workflowInputs, queryRefresh, dailyReportStarting, reportInputs, newAttachments, newAttachmentDraft, forkAttachmentDraft, submittingNew, dispose: () => scope.stop() };
}

test('附件上传或移除期间，普通发送、插入和实现复核均保留草稿且不提交', async () => {
  for (const operation of ['upload', 'remove'] as const) {
    const state = sendingFixture();
    try {
      state.drafts.draft.value = '等待附件后发送';
      state.drafts.attachments.value = [image];
      const finish = state.drafts.attachmentDraft.value!.begin(operation);
      await state.actions.sendMessage({ queuePlacement: 'append' });
      await state.actions.sendMessage({ queuePlacement: 'next' });
      await state.actions.sendMessage({ queuePlacement: 'append', workflow: true });
      await state.actions.startAgentWorkflow({ templateId: 'implement-review', objective: '等待附件后发送' });
      assert.equal(state.workflowInputs.length, 0);
      assert.equal(state.drafts.draft.value, '等待附件后发送');
      assert.deepEqual(state.drafts.attachments.value, [image]);
      finish();
      state.response.resolve(undefined);
      await state.actions.sendMessage({ queuePlacement: 'append' });
      assert.equal(state.drafts.draft.value, '等待附件后发送', '上传结束后发送失败仍恢复原草稿');
    } finally { state.dispose(); }
  }
});

test('新建与分叉会话上传未完成不提交，新建确认期间也防止重复提交', async () => {
  const state = sendingFixture();
  try {
    const finishNew = state.newAttachmentDraft.value.begin('upload');
    const finishFork = state.forkAttachmentDraft.value.begin('upload');
    await state.actions.submit();
    await state.actions.forkConversation();
    assert.equal(state.reportInputs.length, 0);
    finishNew(); finishFork();
    state.newAttachments.value = [image];
    const pending = state.actions.submit();
    assert.equal(state.submittingNew.value, true);
    await state.actions.submit();
    assert.equal(state.reportInputs.length, 1);
    assert.deepEqual((state.reportInputs[0] as StartAgentRunInput).attachmentIds, [image.id]);
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.submittingNew.value, false);
    assert.deepEqual(state.newAttachments.value, [image]);
  } finally { state.dispose(); }
});

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

test('跨执行器发送保留当前对话、历史与发送期间新写的草稿', async () => {
  const state = sendingFixture();
  try {
    const original = state.selectedConversationId.value;
    state.drafts.draft.value = 'Cursor 接着检查';
    state.drafts.attachments.value = [image];
    const pending = state.actions.sendMessage({ provider: 'cursor', model: 'auto', reasoningEffort: '', accessMode: 'workspace', queuePlacement: 'append' });
    assert.equal(state.reportInputs.length, 1);
    assert.equal((state.reportInputs[0] as StartAgentRunInput).provider, 'cursor');
    assert.equal((state.reportInputs[0] as StartAgentRunInput).continueConversationId, original);
    assert.equal((state.reportInputs[0] as StartAgentRunInput).objective, 'Cursor 接着检查');
    assert.deepEqual((state.reportInputs[0] as StartAgentRunInput).attachmentIds, [image.id]);
    state.drafts.draft.value = '继续当前对话的新草稿';
    state.conversations.value = buildAgentConversations([{ ...run('cursor-new'), provider: 'cursor', conversationId: original }, run('b'), run('a')]);
    state.response.resolve({ id: 'cursor-new', conversationId: original });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, original);
    assert.equal(state.conversations.value.length, 2);
    assert.deepEqual(findAgentConversation(state.conversations.value, original)?.runs.map(item => item.id), ['a', 'cursor-new']);
    assert.equal(state.drafts.draft.value, '继续当前对话的新草稿');
  } finally { state.dispose(); }
});

test('Claude 同执行器续聊调用原运行的 resume，不创建跨执行器任务', async () => {
  const current = { ...run('claude-current'), provider: 'claude' as const, sessionId: 'claude-native', model: 'opus' };
  const state = sendingFixture(buildAgentConversations([current]));
  try {
    state.drafts.draft.value = '继续当前 Claude 会话';
    const pending = state.actions.sendMessage({ provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'workspace', queuePlacement: 'append' });
    assert.equal(state.reportInputs.length, 0);
    assert.equal(state.resumeInputs.length, 1);
    assert.equal((state.resumeInputs[0][0] as AgentRun).sessionId, 'claude-native');
    assert.equal(state.resumeInputs[0][1], '继续当前 Claude 会话');
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.drafts.draft.value, '继续当前 Claude 会话', '请求未接受时恢复原草稿');
  } finally { state.dispose(); }
});

test('取消切换执行器恢复原草稿，重复发送不会提交两次', async () => {
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

test('切换已排队后连续发送沿用队尾执行器，不重复切换也不插入旧执行器', async () => {
  for (const queuePlacement of ['append', 'next'] as const) {
    const active = { ...run('active'), conversationId: 'same-conversation', status: 'running' as const, sessionId: 'codex-session' };
    const queued = { ...run('cursor-queued'), conversationId: 'same-conversation', provider: 'cursor' as const,
      status: 'queued' as const, sessionId: '', createdAt: '2026-09-22T00:01:00Z' };
    const state = sendingFixture(buildAgentConversations([active, queued]));
    try {
      state.drafts.draft.value = '补充给 Cursor';
      const pending = state.actions.sendMessage({ provider: 'cursor', queuePlacement });
      assert.equal(state.reportInputs.length, 0, '已排队的 Cursor 应正常续聊');
      assert.equal((state.resumeInputs[0][0] as AgentRun).id, queued.id);
      assert.equal(state.resumeInputs[0][6], 'append', '过期的插入操作也不能插入旧 Codex 轮次');
      state.response.resolve(undefined);
      await pending;
      assert.equal(state.drafts.draft.value, '补充给 Cursor');
    } finally { state.dispose(); }
  }
});

test('切换提交后手动查看其他对话，回包仍保留两边草稿且不抢回选中项', async () => {
  const state = sendingFixture();
  try {
    state.drafts.draft.value = '切到 Cursor';
    const pending = state.actions.sendMessage({ provider: 'cursor', queuePlacement: 'append' });
    state.drafts.draft.value = '原对话下一条';
    state.actions.selectConversation('b');
    state.drafts.draft.value = 'B 的草稿';
    state.conversations.value = buildAgentConversations([{ ...run('cursor-next'), provider: 'cursor', conversationId: 'a' }, run('b'), run('a')]);
    state.response.resolve({ id: 'cursor-next', conversationId: 'a' });
    state.queryRefresh.resolve();
    await pending;
    assert.equal(state.selectedConversationId.value, 'b');
    assert.equal(state.drafts.draft.value, 'B 的草稿');
    state.actions.selectConversation('a');
    assert.equal(state.drafts.draft.value, '原对话下一条');
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

test('日报重复点击只创建一次，保留当前会话的草稿及附件', async () => {
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
    assert.equal(state.selectedConversationId.value, original);
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

test('会话内重试将输入区的模式权限原样传到运行接口，恢复入口省略时沿用旧配置', async () => {
  const current = { ...run('retry-current'), provider: 'codex' as const, status: 'failed' as const };
  const selection = { mode: 'agent' as const, accessMode: 'full' as const };
  const events: unknown[][] = [];
  const conversation = loadActions<{ retryRun: (run: AgentRun) => void }>(
    '../src/features/agent-workbench/AgentConversation.vue', ['retryRun'], {
      composer: shallowRef({ retrySelection: () => selection }), emit: (...args: unknown[]) => events.push(args),
    });
  conversation.retryRun(current);
  assert.deepEqual(events, [['retry', current, selection]]);
  const state = sendingFixture(buildAgentConversations([current]));
  try {
    const pending = state.actions.retryRun(current, selection);
    assert.deepEqual(state.retryInputs, [[current, selection]]);
    state.response.resolve(undefined);
    await pending;
  } finally { state.dispose(); }
  const inputs: Record<string, unknown>[] = [];
  const { retry } = loadActions<{ retry: (run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>) => Promise<unknown> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['retry'], {
      changing: shallowRef(''), ElMessage: { success: () => {}, error: (message: string) => assert.fail(message) },
      post: async (_path: string, body: Record<string, unknown>) => { inputs.push(body); return current; },
    });
  await retry(current, selection);
  await retry(current);
  assert.deepEqual(inputs, [selection, {}]);
  assert.equal(current.mode, 'ask');
  assert.equal(current.accessMode, 'workspace');
});

for (const order of ['stream-first', 'response-first', 'failure', 'switch-away'] as const) {
  test(`50 条截断后继续发送保持会话及新草稿：${order}`, async () => {
    const runs = Array.from({ length: 50 }, (_, index) => run(`a-${index}`, index ? `a-${index - 1}` : ''));
    const state = sendingFixture(buildAgentConversations([...runs].reverse()));
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
      state.conversations.value = buildAgentConversations([run('b'), run('a-50', 'a-49'), ...runs.slice(1).reverse()]);
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
      client: { invalidateQueries: async () => {} },
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

test('批量删除冻结所选会话并去重，只发一次请求与一次会话列表刷新', async () => {
  const confirmation = deferred<void>(), response = deferred<AgentConversationDeleteResult>(), snapshot = deferred<void>();
  const changing = shallowRef(''), codexDetails = shallowRef<Record<string, unknown>>({ b: {}, keep: {} });
  let confirmations = 0, refreshes = 0;
  const requests: { path: string; body: unknown }[] = [];
  const invalidations: string[][] = [];
  const runtime = loadActions<{ removeConversations: (items: AgentConversationDeleteTarget[]) => Promise<AgentConversationDeleteTarget[]> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['removeConversations'], {
      changing, codexDetails, query: { refetch: async () => { refreshes++; await snapshot.promise; } },
      client: { getQueryData: () => [], invalidateQueries: async ({ queryKey }: { queryKey: string[] }) => { invalidations.push(queryKey); } },
      ElMessageBox: { confirm: async (message: string) => {
        confirmations++;
        assert.match(message, /选中的 2 个会话/);
        assert.match(message, /运行和排队任务/);
        assert.match(message, /不会删除工作区文件/);
        return confirmation.promise;
      } },
      ElMessage: { success: () => {}, error: () => {} },
      post: async (path: string, body: unknown, refresh: boolean) => {
        assert.equal(refresh, false);
        requests.push({ path, body });
        return response.promise;
      },
    });
  const selected = [{ id: 'a', source: 'workspace' as const }, { id: 'b', source: 'codex' as const }, { id: 'a', source: 'workspace' as const }];
  const pending = runtime.removeConversations(selected);
  selected[0].id = 'unselected';
  assert.equal(changing.value, 'conversations:delete');
  assert.deepEqual(await runtime.removeConversations(selected), []);
  assert.equal(requests.length, 0);
  confirmation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await runtime.removeConversations(selected), []);
  const targets = [{ id: 'a', source: 'workspace' as const }, { id: 'b', source: 'codex' as const }];
  assert.deepEqual(requests, [{ path: '/api/agent-runtimes/conversations/delete-batch', body: { targets } }]);
  assert.equal(refreshes, 0);
  response.resolve({ removed: targets, failures: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmations, 1);
  assert.equal(refreshes, 1);
  assert.deepEqual(invalidations, [['requirement-development']]);
  assert.equal(changing.value, 'conversations:delete');
  snapshot.resolve();
  assert.deepEqual(await pending, targets);
  assert.deepEqual(Object.keys(codexDetails.value), ['keep']);
  assert.equal(changing.value, '');
});

test('取消批量删除不发请求，不清除缓存或草稿', async () => {
  const changing = shallowRef(''), codexDetails = shallowRef({ a: {} });
  const runtime = loadActions<{ removeConversations: (items: { id: string; source: 'codex' }[]) => Promise<unknown[]> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['removeConversations'], {
      changing, codexDetails,
      ElMessageBox: { confirm: async () => { throw new Error('cancel'); } },
      ElMessage: { success: () => assert.fail('取消不能显示成功'), error: () => assert.fail('取消不能显示错误') },
      post: () => assert.fail('取消不能发送删除请求'), query: { refetch: () => assert.fail('取消不刷新') },
    });
  assert.deepEqual(await runtime.removeConversations([{ id: 'a', source: 'codex' }]), []);
  assert.deepEqual(Object.keys(codexDetails.value), ['a']);
  assert.equal(changing.value, '');
});

test('批量删除部分失败只清理成功项，且等待关联团队刷新，即使会话列表刷新失败', async () => {
  const errors: string[] = [], requests: string[] = [], cleared: string[] = [], attachments: unknown[] = [];
  const teamRefresh = deferred<void>();
  let teamRefreshes = 0;
  const changing = shallowRef(''), codexDetails = shallowRef<Record<string, unknown>>({ b: {}, keep: {} });
  const targets: AgentConversationDeleteTarget[] = [{ id: 'a', source: 'workspace' }, { id: 'failed', source: 'workspace' }, { id: 'b', source: 'codex' }];
  const runtime = loadActions<{ removeConversations: (items: AgentConversationDeleteTarget[]) => Promise<AgentConversationDeleteTarget[]> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['removeConversations'], {
      changing, codexDetails, ElMessageBox: { confirm: async () => {} },
      ElMessage: { success: () => assert.fail('部分失败不能只提示成功'), error: (message: string) => errors.push(message) },
      query: { refetch: async () => { throw new Error('offline'); } },
      client: {
        getQueryData: () => [{ chat: {}, parentConversationId: 'a' }],
        invalidateQueries: async ({ queryKey }: { queryKey: string[] }) => {
          if (queryKey[0] === 'agent-team-chat') { teamRefreshes++; await teamRefresh.promise; }
        },
      },
      post: async (path: string, body: unknown): Promise<AgentConversationDeleteResult> => {
        requests.push(path);
        assert.deepEqual(body, { targets });
        return { removed: [targets[0], targets[2]], failures: [{ ...targets[1], message: '会话正在收尾' }] };
      },
    });
  const panel = loadActions<{ removeAgentConversations: (items: { id: string; source: 'workspace' | 'codex' }[]) => Promise<void> }>(
    panelPath, ['removeAgentConversations'], {
      removeConversations: runtime.removeConversations,
      clearConversationDraft: (id: string) => { cleared.push(id); return { attachments: [id] }; },
      removePendingAgentAttachments: async (items: unknown[]) => { attachments.push(...items); },
    });
  const pending = panel.removeAgentConversations(targets);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/agent-runtimes/conversations/delete-batch']);
  assert.equal(teamRefreshes, 1);
  assert.equal(changing.value, 'conversations:delete');
  teamRefresh.resolve();
  await pending;
  assert.deepEqual(cleared, ['a', 'b']);
  assert.deepEqual(attachments, ['a', 'b']);
  assert.deepEqual(Object.keys(codexDetails.value), ['keep']);
  assert.ok(errors.some(message => /2 个会话，1 个删除失败.*会话正在收尾/.test(message)));
  assert.ok(errors.some(message => /列表刷新失败/.test(message)));
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
        client: { invalidateQueries: async () => {} },
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


test('新建普通会话固定使用单 Agent，忽略旧自动偏好，重复点击不双发并保留切换后的选择', async () => {
  const state = sendingFixture();
  try {
    state.automaticTeam.value = true;
    state.form.objective = '你好';
    state.newAttachments.value = [image];
    const pending = state.actions.submit();
    await state.actions.submit();
    assert.equal(state.teamInputs.length, 0);
    assert.equal(state.reportInputs.length, 1, '新建只调用单 Agent start');
    assert.deepEqual(state.reportInputs[0], { objective: '你好', workspacePath: '', accessMode: 'full', serviceTier: undefined, isolateWorkspace: true, attachmentIds: [image.id] });
    state.actions.selectConversation('b');
    state.drafts.draft.value = 'B的新草稿';
    state.response.resolve({ id: 'new-agent' });
    state.queryRefresh.resolve(); await pending;
    assert.equal(state.selectedConversationId.value, 'b');
    assert.equal(state.drafts.draft.value, 'B的新草稿');
    assert.deepEqual(state.newAttachments.value, []);
  } finally { state.dispose(); }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`历史协作续聊 ${outcome} 保留发送期间新增草稿和其他会话选择`, async () => {
    const state = sendingFixture();
    try {
      state.automaticTeam.value = false;
      state.conversations.value = state.conversations.value.map(item => item.id === 'a'
        ? { ...item, teamChat: { state: 'completed', lastUserAt: '2026-09-22T00:00:00Z' } } : item);
      state.drafts.draft.value = '我的执行目标';
      state.drafts.attachments.value = [image];
      const pending = state.actions.sendMessage({ queuePlacement: 'append' });
      assert.equal(state.teamInputs.length, 1); assert.equal(state.resumeInputs.length, 0);
      assert.deepEqual(state.teamInputs[0][0], { objective: '我的执行目标', attachmentIds: [image.id], accessMode: 'full', parentRunId: 'a' });
      state.drafts.draft.value = '原聊天后续草稿';
      state.actions.selectConversation('b'); state.drafts.draft.value = 'B的草稿';
      state.teamResponse.resolve(outcome === 'success' ? { task: {}, runId: 'leader', conversationId: 'a' } : undefined);
      state.queryRefresh.resolve(); await pending;
      assert.equal(state.selectedConversationId.value, 'b'); assert.equal(state.drafts.draft.value, 'B的草稿');
      state.actions.selectConversation('a');
      assert.equal(state.drafts.draft.value, outcome === 'success' ? '原聊天后续草稿' : '我的执行目标\n\n原聊天后续草稿');
      assert.deepEqual(state.drafts.attachments.value, outcome === 'success' ? [] : [image]);
    } finally { state.dispose(); }
  });
}

test('普通历史会话忽略旧自动偏好，只续聊原 Agent', async () => {
  const state = sendingFixture();
  try {
    state.automaticTeam.value = true;
    state.drafts.draft.value = '只继续当前 Agent';
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    assert.equal(state.teamInputs.length, 0);
    assert.equal(state.resumeInputs.length, 1);
    state.response.resolve(undefined); await pending;
    assert.equal(state.drafts.draft.value, '只继续当前 Agent');
  } finally { state.dispose(); }
});

test('普通会话既有原生运行未结束时沿原队列续聊，旧自动偏好不另开团队', async () => {
  const state = sendingFixture(buildAgentConversations([{ ...run('active'), status: 'running', sessionId: 'native' }]));
  try {
    state.automaticTeam.value = true; state.drafts.draft.value = '补充当前执行要求';
    const pending = state.actions.sendMessage({ queuePlacement: 'append' });
    assert.equal(state.teamInputs.length, 0); assert.equal(state.resumeInputs.length, 1);
    state.response.resolve(undefined); await pending;
    assert.equal(state.drafts.draft.value, '补充当前执行要求');
  } finally { state.dispose(); }
});

test('普通会话权限菜单显式解锁下一轮 Agent，初始 Plan 与历史权限保持只读', async () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentAccessSelector.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentAccessSelector.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const accessMode = shallowRef('workspace');
  const props = reactive({ mode: 'plan', disabled: false, allowModeChange: true, modes: ['agent', 'ask', 'plan'], accessModes: ['workspace', 'full'] });
  const changes: string[] = [];
  let selections = 0;
  const scope = effectScope();
  try {
    const select = scope.run(() => new Function('computed', 'watch', 'defineProps', 'withDefaults', 'defineModel', 'defineEmits', `${code}\nreturn select;`)(
      computed, watch, () => props, (value: unknown) => value, () => accessMode,
      () => (event: string, mode: string) => {
        if (event === 'modeChange') { changes.push(mode); props.mode = mode; }
        if (event === 'selectionChange') selections++;
      })) as (command: unknown) => void;
    assert.equal(props.mode, 'plan');
    assert.deepEqual(changes, []);
    assert.equal(selections, 0, '初始化归一不能冒充用户选择');
    select('workspace');
    await nextTick();
    assert.equal(props.mode, 'agent');
    assert.equal(accessMode.value, 'workspace', '显式选择工作区不会被提为完全访问');
    select('full');
    await nextTick();
    assert.equal(accessMode.value, 'full');
    select('readonly');
    await nextTick();
    assert.equal(props.mode, 'ask');
    assert.equal(accessMode.value, 'workspace');
    assert.equal(selections, 3);
    props.modes = ['ask'];
    select('full');
    assert.equal(props.mode, 'ask', '执行器不支持 Agent 时不能解锁写权限');
    assert.equal(accessMode.value, 'workspace');
    assert.equal(selections, 3, '不支持的权限不能计为选择');
  } finally { scope.stop(); }
});

test('Kiro 旧 Ask 会话仅显式选择后改变下一轮模式，发送和插入保留真实边界', async () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentComposer.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentComposer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const original: AgentRun = { ...run('kiro-current'), provider: 'kiro', sessionId: 'kiro-native', status: 'running', model: 'auto',
    conversationId: '74e2928d-c5eb-4015-9238-4bdeaf8533df',
    task: { parentConversationId: '74e2928d-c5eb-4015-9238-4bdeaf8533df', dependsOnConversationIds: [], role: 'main', title: '主对话',
      source: 'workflow', sourceId: 'team:74e2928d-c5eb-4015-9238-4bdeaf8533df' } };
  const conversation: Conversation = { ...buildAgentConversations([original])[0],
    teamChat: { state: 'completed', lastUserAt: original.createdAt, workspaceBound: false } };
  const automatic = shallowRef(false);
  const props = reactive({ conversation, changing: '', running: true, canInsert: true, businessOptions: [],
    runtimes: [{ provider: 'kiro', ready: true, modes: ['agent', 'ask', 'plan'], accessModes: ['workspace', 'full'],
      defaultModel: 'auto', models: [{ id: 'auto' }] }] });
  const emitted: { mode?: string; accessMode?: string }[] = [];
  const draft = shallowRef('现在处理文件');
  const dependencies = { computed, shallowRef, watch, useTemplateRef: () => shallowRef(), agentConversationContinuation,
    agentConversationInsertRun, codexWorkbenchDefaults, codexServiceTier, useAgentModelSelection, agentModelDefaults: shallowRef({ ...codexWorkbenchDefaults, revision: '' }),
    defineProps: () => props, defineModel: (name: unknown) => name === 'automatic' ? automatic : name === 'attachments' ? shallowRef([]) : draft,
    defineEmits: () => (event: string, selection: { mode?: string; accessMode?: string }) => { if (event === 'send') emitted.push(selection); },
    defineExpose: () => {}, window: { localStorage: { getItem: () => null, setItem: () => {} } } };
  const scope = effectScope();
  try {
    const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { composerMode, selectedAccessMode, selectedProvider, canInsertCurrent, modeChangeAllowed, setMode, submit, retrySelection };`)
      (...Object.values(dependencies))) as { composerMode: { value: string }; selectedAccessMode: { value: string }; canInsertCurrent: { value: boolean };
        selectedProvider: { value: AgentProvider }; modeChangeAllowed: { value: boolean }; setMode: (mode: string) => void; submit: () => void;
        retrySelection: (run: AgentRun) => Pick<AgentRun, 'mode' | 'accessMode'> | undefined };
    assert.equal(state.modeChangeAllowed.value, true, '有团队历史的 main 主对话在手动模式下仍允许显式切换');
    assert.equal(state.composerMode.value, 'ask');
    assert.equal(state.selectedAccessMode.value, 'workspace');
    assert.equal(state.retrySelection(original), undefined, '未手动选择时重试仍沿用原轮配置');
    assert.equal(state.canInsertCurrent.value, true);
    state.setMode('agent');
    state.selectedAccessMode.value = 'workspace';
    await nextTick();
    props.runtimes = props.runtimes.map(runtime => ({ ...runtime, accessModes: [...runtime.accessModes] }));
    await nextTick();
    assert.equal(state.selectedAccessMode.value, 'workspace', '状态刷新不能把手选的工作区权限提升为完全访问');
    state.selectedAccessMode.value = 'full';
    await nextTick();
    assert.equal(emitted.length, 0, '选择权限不发送任务');
    assert.equal(state.canInsertCurrent.value, false, '下一轮改变模式时不能插入只读的当前轮');
    assert.equal(original.mode, 'ask');
    assert.equal(original.accessMode, 'workspace');
    assert.deepEqual(state.retrySelection(original), { mode: 'agent', accessMode: 'full' }, '重试使用当前明确选择的权限');
    assert.equal(state.retrySelection({ ...original, provider: 'cursor' }), undefined, '不将其他执行器的选择用于重试');
    assert.equal(state.retrySelection({ ...original, task: { ...original.task!, role: 'reviewer' } }), undefined, '历史审查岗位保持固定权限');
    state.submit();
    assert.equal(emitted[0].mode, 'agent');
    assert.equal(emitted[0].accessMode, 'full');
    props.conversation = { ...conversation, source: 'codex' };
    await nextTick();
    assert.equal(state.modeChangeAllowed.value, false, '导入 Codex 历史沿用专用 Agent 续接，不显示不可传递的模式选项');
    props.conversation = { ...conversation, runs: [{ ...original, task: { ...original.task!, role: 'worker' } }] };
    await nextTick();
    assert.equal(state.modeChangeAllowed.value, false, '受控 worker 节点保持固定模式');
    props.conversation = conversation;
    await nextTick();
    state.setMode('agent');
    state.selectedAccessMode.value = 'workspace';
    assert.deepEqual(state.retrySelection(original), { mode: 'agent', accessMode: 'workspace' });
    automatic.value = true;
    await nextTick();
    assert.equal(state.modeChangeAllowed.value, false, '自动团队按岗位配置控制模式');
    assert.equal(state.retrySelection(original), undefined, '自动团队重试沿用原权限');
    automatic.value = false;
    await nextTick();
    assert.equal(state.modeChangeAllowed.value, true, '关闭自动协作后恢复主对话显式切换');
    assert.equal(state.retrySelection(original), undefined, '协作模式切换后重试不采用自动初始化的权限');
    state.setMode('agent');
    state.selectedAccessMode.value = 'workspace';
    state.selectedProvider.value = 'cursor';
    await nextTick();
    state.selectedProvider.value = 'kiro';
    await nextTick();
    assert.equal(state.retrySelection(original), undefined, '切换执行器后重试不采用自动初始化的权限');
  } finally { scope.stop(); }
});

test('发送下一轮模式沿普通续聊参数传递，跨执行器显式模式覆盖旧只读模式', async () => {
  const current = { ...run('kiro-mode'), provider: 'kiro' as const, sessionId: 'kiro-native', model: 'auto' };
  const state = sendingFixture(buildAgentConversations([current]));
  try {
    state.drafts.draft.value = '明确切为 Agent 后处理';
    const pending = state.actions.sendMessage({ provider: 'kiro', mode: 'agent', model: 'auto', reasoningEffort: '', accessMode: 'full', queuePlacement: 'append' });
    assert.equal(state.resumeInputs[0]?.[8], 'agent');
    assert.equal(state.resumeInputs[0]?.[5], 'full');
    assert.equal(current.mode, 'ask');
    state.response.resolve(undefined);
    await pending;
    assert.equal(state.drafts.draft.value, '明确切为 Agent 后处理', '失败恢复原草稿');
    const input = providerSwitchInput(buildAgentConversations([current])[0], '继续处理', {
      provider: 'codex', mode: 'agent', model: 'test-model', reasoningEffort: 'high', accessMode: 'workspace',
    });
    assert.equal(input.mode, 'agent');
    assert.equal(input.accessMode, 'workspace');
  } finally { state.dispose(); }
});

test('普通续聊仅在显式选择模式时发送 mode 字段，旧调用不改变默认语义', async () => {
  const inputs: Record<string, unknown>[] = [];
  const current = { ...run('kiro-post'), provider: 'kiro' as const };
  const { resume } = loadActions<{ resume: (...args: unknown[]) => Promise<unknown> }>(
    '../src/features/agent-workbench/useAgentRuntimes.ts', ['resume'], {
      changing: shallowRef(''), ElMessage: { success: () => {}, error: () => {} },
      post: async (_path: string, body: Record<string, unknown>) => { inputs.push(body); return { ...current, status: 'queued' }; },
    });
  await resume(current, '继续只读', 'auto', '', [], 'workspace', 'append');
  assert.equal('mode' in inputs[0], false);
  await resume(current, '明确执行', 'auto', '', [], 'full', 'append', undefined, 'agent');
  assert.equal(inputs[1].mode, 'agent');
  assert.equal(inputs[1].accessMode, 'full');
});


test('Cursor 启动沿用普通权限确认，编辑与重试不再单独确认目录信任', async () => {
  const current = { ...run('cursor-run'), provider: 'cursor' as const, mode: 'ask' as const, model: 'cursor-model', workspacePath: '/actual-workspace', status: 'failed' as const };
  const confirmations: { body: string; title: string; options: { confirmButtonText: string } }[] = [];
  const inputs: { path: string; body: Record<string, unknown> }[] = [];
  const actions = loadActions<{
    start: (input: StartAgentRunInput) => Promise<AgentRun | undefined>;
    revise: (run: AgentRun, objective: string) => Promise<AgentRun | undefined>;
    retry: (run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>) => Promise<AgentRun | undefined>;
  }>('../src/features/agent-workbench/useAgentRuntimes.ts', ['start', 'revise', 'retry'], {
    changing: shallowRef(''), agentProviderLabels: { cursor: 'Cursor Agent' },
    ElMessageBox: { confirm: async (body: string, title: string, options: { confirmButtonText: string }) => { confirmations.push({ body, title, options }); } },
    ElMessage: { success: () => {}, error: (message: string) => assert.fail(message) },
    post: async (path: string, body: Record<string, unknown>) => { inputs.push({ path, body }); return current; },
  });
  const startInput: StartAgentRunInput = { provider: 'cursor', mode: 'ask', model: 'cursor-model', objective: '只读审查', accessMode: 'workspace', workspacePath: '/source' };
  await actions.start(startInput);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].title, '启动 Agent');
  assert.equal(confirmations[0].options.confirmButtonText, '确认启动');
  assert.match(confirmations[0].body, /不会修改工作区或外部系统/);
  assert.doesNotMatch(confirmations[0].body, /信任/);
  assert.equal(inputs[0].body.cursorTrustPath, undefined);
  assert.equal(inputs[0].body.model, 'cursor-model');
  await actions.revise(current, ' 编辑后继续审查 ');
  const selection = { mode: 'ask' as const, accessMode: 'workspace' as const };
  await actions.retry(current, selection);
  assert.equal(confirmations.length, 1, '编辑与普通重试没有追加信任确认');
  assert.deepEqual(inputs.slice(1), [
    { path: '/api/agent-runtimes/runs/cursor-run/revise', body: { objective: '编辑后继续审查' } },
    { path: '/api/agent-runtimes/runs/cursor-run/retry', body: selection },
  ]);
  assert.equal(current.model, 'cursor-model'); assert.equal(current.mode, 'ask'); assert.equal(current.accessMode, 'workspace');
  await actions.retry({ ...current, recovery: { previousStatus: 'running', previousPid: null, state: 'needs-review', checkedAt: '2026-11-04T00:00:00Z', message: 'runtime_restarted' } } as AgentRun);
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[1].title, '确认中断任务恢复', '独立的恢复确认继续保留');
  assert.deepEqual(inputs.at(-1)?.body, {});
});

/** 执行真实会话 SFC watcher；可控视口复现隐藏后打开及异步更新竞态，无需新增 DOM 依赖。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowReactive, shallowRef, watch, type ShallowRef } from 'vue';
import { buildAgentConversations, type AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { teamChatEntries, teamChatActivity, teamChatActiveStates, isCurrentTeamChatTask } from '../src/features/agent-workbench/team-chat.js';
import { teamRoomAcceptanceRecord, type AdvancedTeamTask, type TeamRoom } from '../src/features/agent-workbench/team-api.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const source = readFileSync(new URL('../src/features/agent-workbench/AgentConversation.vue', import.meta.url), 'utf8')
  .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
const tree = ts.createSourceFile('AgentConversation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function conversation(id: string, result = '初始内容'): AgentConversation {
  return buildAgentConversations([{ id, provider: 'codex', mode: 'agent', accessMode: 'full', model: 'test', reasoningEffort: '',
    objective: id, workspacePath: '/workspace', branch: 'feature/test', headSha: '', status: 'running', sessionId: id,
    pid: null, result, error: '', events: [], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' } as AgentRun])[0];
}

function mount(initial = conversation('a'), visible?: boolean) {
  const props = shallowReactive({ conversation: initial, visible, runtimes: [], changing: '', pinned: false,
    leftCollapsed: false, rightCollapsed: true, businessOptions: [], teamTasks: [] as AdvancedTeamTask[], teamRoom: undefined as TeamRoom | undefined });
  const messageViewport = shallowRef<object>();
  const heights = new Map([[initial.id, 2400]]);
  let displayed = visible !== false, renderedHeight = 2400, offset = 0;
  const viewport = {
    get clientHeight() { return displayed ? 600 : 0; },
    get scrollHeight() { return displayed ? renderedHeight : 0; },
    get scrollTop() { return displayed ? offset : 0; },
    set scrollTop(value: number) { offset = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  };
  let heldTick: (() => Promise<void>) | undefined;
  const dispose: (() => void)[] = [];
  const dependencies = { teamChatEntries, teamChatActivity, teamChatActiveStates, isCurrentTeamChatTask, teamRoomAcceptanceRecord, computed, shallowRef, watch, nextTick: () => {
    const pending = heldTick; heldTick = undefined;
    return pending ? pending() : nextTick();
  }, onBeforeUnmount: (callback: () => void) => dispose.push(callback),
  useTemplateRef: (name: string) => name === 'messageViewport' ? messageViewport : shallowRef(),
  defineProps: () => props, defineModel: (name: string) => shallowRef(name === 'automatic' ? true : undefined), defineEmits: () => () => {}, defineExpose: () => {} };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { conversationView, searchQuery, rememberScroll, effectiveAutomatic, teamProgressVisible, teamResultVisible, currentTeamTask, visibleEntries };`)
    (...Object.values(dependencies))) as { conversationView: ShallowRef<'chat' | 'execution' | 'delivery'>;
      searchQuery: ShallowRef<string>; rememberScroll: () => void; effectiveAutomatic: ShallowRef<boolean>;
      teamProgressVisible: ShallowRef<boolean>; teamResultVisible: ShallowRef<boolean>;
      currentTeamTask: ShallowRef<AdvancedTeamTask | undefined>; visibleEntries: ShallowRef<{ id: string }[]> };
  // 在组件 pre watcher 后、post watcher 前模拟本轮 DOM 更新。
  scope.run(() => watch(() => [props.conversation, props.visible, state.conversationView.value, props.teamTasks, props.teamRoom], () => {
    displayed = props.visible !== false && state.conversationView.value === 'chat';
    renderedHeight = heights.get(props.conversation.id) ?? 2400;
    if (displayed) offset = Math.min(offset, renderedHeight - 600);
  }));
  return { props, state, viewport,
    attach() { messageViewport.value = viewport; },
    scroll(top: number) { viewport.scrollTop = top; state.rememberScroll(); },
    select(id: string, height = 2400) { heights.set(id, height); props.conversation = conversation(id); },
    grow(height: number) {
      heights.set(props.conversation.id, height);
      props.conversation = conversation(props.conversation.id, `${props.conversation.latest.result}新增输出`);
    },
    growTeam(height: number) {
      heights.set(props.conversation.id, height);
      props.teamTasks = [{ id: 'chat-task', interactionMode: 'chat', parentConversationId: props.conversation.id, state: 'running', nodes: [], sourceWorkspacePath: '/workspace', objective: '测试目标', attachmentIds: [], profileConfig: defaultTeamProfileConfig(), planRevision: 0, round: 0, maxRounds: 2, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:01:00Z',
        chat: { messages: [{ id: `message-${height}`, role: 'assistant', profileId: 'engineer', kind: 'handoff', text: '实现已回传', createdAt: '2026-10-24T00:01:00Z' }], workspaceBound: true, pendingInputs: [] } } as AdvancedTeamTask];
    },
    growWorker(height: number) {
      heights.set(props.conversation.id, height);
      props.teamRoom = { task: { ...props.teamTasks[0], budgetLimit: 20, reverifyCount: 0, requestIds: {}, upgradedProfiles: [] }, runs: [{ ...props.conversation.latest, id: 'worker', result: `岗位进展 ${height}`,
        updatedAt: new Date(Date.parse(props.conversation.latest.createdAt) + height).toISOString() }], messages: [], events: [], stale: false } as TeamRoom;
    },
    holdNextTick() {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      heldTick = () => pending;
      return release;
    },
    close() { scope.stop(); dispose.forEach(callback => callback()); },
  };
}

async function settled() { await nextTick(); await nextTick(); }

test('单个 Agent 和单模型接管后的底部不显示旧团队状态，历史任务与消息保留', () => {
  const view = mount();
  try {
    view.growTeam(2400);
    const old = view.props.teamTasks[0];
    old.chat!.coordination = { phase: 'queued', text: '补充已记录；当前岗位不支持实时插入，将在本阶段结束后更新安排。' };
    old.chat!.messages.push({ id: 'old-reply', role: 'assistant', profileId: 'engineer', kind: 'message', text: '历史回复', createdAt: old.createdAt });
    view.props.teamTasks = [old];
    for (const automatic of [false, true]) {
      view.state.effectiveAutomatic.value = automatic;
      assert.equal(view.state.teamProgressVisible.value, false);
      assert.equal(view.state.teamResultVisible.value, false);
      assert.equal(view.state.currentTeamTask.value, old, '执行记录继续使用原任务');
      assert.ok(view.state.visibleEntries.value.some(entry => entry.id === 'old-reply'));
    }
  } finally { view.close(); }
});

test('当前团队进度和结果只在自动协作中显示，切换方式不改写任务状态', () => {
  const view = mount();
  try {
    view.growTeam(2400);
    const current = view.props.teamTasks[0];
    view.props.conversation = { ...view.props.conversation, teamChat: { state: 'running', lastUserAt: current.createdAt } };
    assert.equal(view.state.teamProgressVisible.value, true);
    view.state.effectiveAutomatic.value = false;
    assert.equal(view.state.teamProgressVisible.value, false);
    assert.equal(current.state, 'running');
    const completed = { ...current, state: 'completed' as const, chat: { ...current.chat!, messages: [
      { id: 'delivery', role: 'assistant' as const, kind: 'delivery' as const, text: '本轮结果', createdAt: current.updatedAt },
    ] } };
    view.props.teamTasks = [completed];
    view.props.conversation = { ...view.props.conversation, teamChat: { state: 'completed', lastUserAt: current.createdAt } };
    assert.equal(view.state.teamResultVisible.value, false);
    view.state.effectiveAutomatic.value = true;
    assert.equal(view.state.teamResultVisible.value, true);
    assert.equal(view.state.teamProgressVisible.value, false);
    view.props.conversation = { ...view.props.conversation, teamChat: undefined };
    assert.equal(view.state.teamResultVisible.value, false, '后续单模型接管时不显示旧团队结果');
  } finally { view.close(); }
});

test('消息视口在 setup 后挂载时首次打开长会话默认到底部', async () => {
  const view = mount();
  try {
    await settled();
    view.attach();
    await settled();
    assert.equal(view.viewport.scrollTop, 1800);
  } finally { view.close(); }
});

test('在工作面板隐藏期间挂载的同一会话，显示后才滚到底部', async () => {
  const view = mount(conversation('a'), false);
  try {
    view.attach(); await settled();
    assert.equal(view.viewport.scrollTop, 0);
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 1800);
  } finally { view.close(); }
});

test('切换会话恢复各自阅读位置，包括明确停留在顶部的 0 值', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(750);
    view.select('b', 3000); await settled();
    assert.equal(view.viewport.scrollTop, 2400);
    view.scroll(0);
    view.select('a'); await settled();
    assert.equal(view.viewport.scrollTop, 750);
    view.select('b', 3000); await settled();
    assert.equal(view.viewport.scrollTop, 0);
  } finally { view.close(); }
});

test('会话隐藏期间更新消息不覆盖阅读位置，重新显示后仍恢复', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(825);
    view.props.visible = false; await settled();
    view.grow(3600); await settled();
    view.state.rememberScroll();
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 825);
    view.state.conversationView.value = 'execution'; await settled();
    view.state.conversationView.value = 'chat'; await settled();
    assert.equal(view.viewport.scrollTop, 825);
  } finally { view.close(); }
});

test('流式输出仅在底部跟随，手动上滚或搜索时保持阅读位置', async () => {
  const view = mount();
  try {
    view.attach(); await settled();
    view.grow(3000); await settled();
    assert.equal(view.viewport.scrollTop, 2400);
    view.scroll(900);
    view.grow(3600); await settled();
    assert.equal(view.viewport.scrollTop, 900);
    view.scroll(3000); view.state.searchQuery.value = '查询'; await settled();
    view.grow(4200); await settled();
    assert.equal(view.viewport.scrollTop, 3000);
  } finally { view.close(); }
});

test('旧会话待执行的追底回调不会覆盖快速切换后的另一会话位置', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(650);
    view.select('b'); await settled();
    const release = view.holdNextTick();
    view.grow(3000); await settled();
    view.select('a'); await settled();
    assert.equal(view.viewport.scrollTop, 650);
    release(); await settled();
    assert.equal(view.viewport.scrollTop, 650);
  } finally { view.close(); }
});

 test('团队交接消息沿用底部跟随，阅读旧消息时保持位置', async () => {
  const view = mount();
  try {
    view.attach(); await settled();
    view.growTeam(3000); await settled();
    assert.equal(view.viewport.scrollTop, 2400);
    view.scroll(700);
    view.growTeam(3600); await settled();
    assert.equal(view.viewport.scrollTop, 700);
    view.select('b'); await settled();
    assert.equal(view.viewport.scrollTop, 1800);
    view.select('a'); await settled();
    assert.equal(view.viewport.scrollTop, 700);
  } finally { view.close(); }
});

test('只有岗位实时进展更新时也跟随底部，用户阅读历史时保持位置', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.growTeam(2400); await settled();
    view.growWorker(3000); await settled();
    assert.equal(view.viewport.scrollTop, 2400);
    view.scroll(360); view.growWorker(3300); await settled();
    assert.equal(view.viewport.scrollTop, 360);
  } finally { view.close(); }
});

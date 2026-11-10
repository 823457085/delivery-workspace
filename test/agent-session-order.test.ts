import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, shallowReactive, shallowRef, watch, type ComputedRef } from 'vue';
import type { AgentRun, CodexSessionDetail, CodexSessionSummary } from '../shared/agent-runtime.js';
import { agentConversationProjectPath, buildAgentConversationList, buildAgentConversations, compareAgentConversations,
  type AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { isPinnedAgentSession } from '../src/features/agent-workbench/session-pins.js';

const baseTime = Date.now() - 60_000;
const time = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();
const ids = (conversations: AgentConversation[]) => conversations.map(item => item.id);
function run(id: string, seconds: number, fields: Partial<AgentRun> = {}): AgentRun {
  return { id, conversationId: id, provider: 'codex', mode: 'agent', accessMode: 'full', model: '', reasoningEffort: '',
    objective: id, workspacePath: '/project-a', branch: '', headSha: '', status: 'running', sessionId: id, pid: null,
    result: '', error: '', events: [], createdAt: time(seconds), updatedAt: time(seconds), ...fields };
}
const list = (runs: AgentRun[]) => buildAgentConversationList(runs, [], {});

test('并发会话交替输出、进度及完成事件只更新内容，不改变提交顺序', () => {
  for (const build of [buildAgentConversations, list]) {
    let runs = [run('older', 1), run('newer', 2, { workspacePath: '/project-b' })];
    for (let tick = 0; tick < 8; tick++) {
      const index = tick % 2;
      runs = runs.map((item, position) => position === index ? { ...item, updatedAt: time(10 + tick),
        result: `output-${tick}`, status: tick >= 6 ? 'completed' : 'running' } : item);
      const conversations = build(runs);
      assert.deepEqual(ids(conversations), ['newer', 'older']);
      const changed = conversations.find(item => item.id === runs[index].id)!;
      assert.equal(changed.updatedAt, time(10 + tick), '真实更新时间仍随输出变化');
      assert.equal(changed.latest.result, `output-${tick}`, '固定排序不得冻结会话内容');
      assert.equal(changed.latest.status, tick >= 6 ? 'completed' : 'running');
    }
  }
});

test('新发排队轮次立即提升会话顺序，旧轮运行优先级及后续完成不影响排序', () => {
  const active = run('active', 1, { conversationId: 'older' });
  const other = run('other', 2);
  const queued = run('queued', 3, { conversationId: 'older', parentRunId: active.id, status: 'queued' });
  assert.deepEqual(ids(list([other, active])), ['other', 'older']);
  const conversations = list([queued, other, active]);
  assert.deepEqual(ids(conversations), ['older', 'other']);
  assert.equal(conversations[0].latest.id, active.id, '状态依旧指向真正运行中的旧轮');
  assert.deepEqual(conversations[0].runs.map(item => item.id), [active.id, queued.id]);
  assert.deepEqual(ids(list([queued, other, active].map(item => ({ ...item, status: 'completed',
    updatedAt: item.id === other.id ? time(30) : time(20) })))), ['older', 'other']);
});

test('纯同步历史按摘要时间排序，加载详情不改变位置', () => {
  const session: CodexSessionSummary = { id: 'history', title: '历史', preview: '摘要', workspacePath: '/history',
    branch: '', headSha: '', model: '', reasoningEffort: '', archived: false, createdAt: time(1), updatedAt: time(30) };
  const detail: CodexSessionDetail = { ...session, turns: [{ id: 'history-turn', userMessage: '原问题',
    agentMessage: '原回答', createdAt: time(2), updatedAt: time(30) }] };
  const local = run('local', 20);
  const unloaded = buildAgentConversationList([local], [session], {});
  const loaded = buildAgentConversationList([local], [session], { [session.id]: detail });
  assert.deepEqual(ids(unloaded), ['history', 'local']);
  assert.deepEqual(ids(loaded), ids(unloaded));
  assert.equal(compareAgentConversations(unloaded[0], loaded[0]), 0);
  assert.equal(loaded[0].loaded, true);
});

test('续聊会话只按本地提交时间排序，合并的同步历史不抢占顺序', () => {
  const session: CodexSessionSummary = { id: 'origin', title: '历史', preview: '', workspacePath: '/history',
    branch: '', headSha: '', model: '', reasoningEffort: '', archived: false, createdAt: time(1), updatedAt: time(50) };
  const detail: CodexSessionDetail = { ...session, turns: [{ id: 'synced-turn', userMessage: '另一端后续问题',
    agentMessage: '同步结果', createdAt: time(40), updatedAt: time(50) }] };
  const continued = run('continued', 10, { originSessionId: session.id });
  const other = run('other', 20);
  const conversations = buildAgentConversationList([continued, other], [session], { [session.id]: detail });
  assert.deepEqual(ids(conversations), ['other', 'continued']);
  assert.equal(conversations[1].runs[0].syncedHistory, true);
  assert.equal(conversations[1].latest.id, continued.id);
  assert.equal(conversations[1].source, 'workspace');
});

test('同毫秒或无效时间按会话 ID 稳定排序，快照输入反转不改变顺序', () => {
  for (const createdAt of [time(1), 'invalid']) {
    const runs = [run('z', 1, { createdAt, updatedAt: time(10) }), run('a', 1, { createdAt, updatedAt: time(20) })];
    for (const build of [buildAgentConversations, list]) {
      assert.deepEqual(ids(build(runs)), ['a', 'z']);
      assert.deepEqual(ids(build([...runs].reverse())), ['a', 'z']);
    }
  }
});

type Group = { path: string; conversations: AgentConversation[] };
function sidebar(props: { conversations: AgentConversation[]; selectedId: string; pinnedIds: Set<string> }) {
  // 执行 SFC 原始 computed，避免复制分组和置顶排序后形成只验证测试自身的回归。
  const path = '../src/features/agent-workbench/AgentSessionList.vue';
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = { computed, shallowRef, watch, agentConversationProjectPath, compareAgentConversations, isPinnedAgentSession,
    defineProps: () => props, defineEmits: () => () => {} };
  return new Function(...Object.keys(dependencies), `${code}\nreturn { projectGroups, visibleGroups, pinnedConversations };`)
    (...Object.values(dependencies)) as { projectGroups: ComputedRef<Group[]>; visibleGroups: ComputedRef<Group[]>;
      pinnedConversations: ComputedRef<AgentConversation[]> };
}

test('真实侧栏的项目分组、组内会话与置顶区在并发输出时保持稳定', () => {
  let runs = [run('a-old', 1), run('a-new', 3), run('pin-old', 2, { workspacePath: '/project-b' }),
    run('b', 3.5, { workspacePath: '/project-b' }), run('pin-new', 4, { workspacePath: '/project-c' }),
    run('c', 2.5, { workspacePath: '/project-c' })];
  const props = shallowReactive({ conversations: list(runs), selectedId: 'a-old', pinnedIds: new Set(['pin-old', 'pin-new']) });
  const state = sidebar(props);
  const expectedGroups = ['/project-c', '/project-b', '/project-a'];
  for (let tick = 0; tick < 12; tick++) {
    const index = tick % runs.length;
    runs = runs.map((item, position) => position === index ? { ...item, updatedAt: time(10 + tick),
      result: `output-${tick}`, status: tick >= 6 ? 'completed' : 'running' } : item);
    props.conversations = list(runs);
    assert.deepEqual(state.projectGroups.value.map(group => group.path), expectedGroups);
    assert.deepEqual(state.visibleGroups.value.map(group => [group.path, ids(group.conversations)]), [
      ['/project-c', ['c']], ['/project-b', ['b']], ['/project-a', ['a-new', 'a-old']],
    ]);
    assert.deepEqual(ids(state.pinnedConversations.value), ['pin-new', 'pin-old']);
  }
  props.conversations = list([run('followup', 40, { conversationId: 'a-old', parentRunId: 'a-old', status: 'queued' }), ...runs]);
  assert.deepEqual(state.projectGroups.value.map(group => group.path), ['/project-a', '/project-c', '/project-b']);
  assert.deepEqual(ids(state.visibleGroups.value[0].conversations), ['a-old', 'a-new']);
});

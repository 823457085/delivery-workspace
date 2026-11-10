/** 执行真实详情面板的选择函数与 watcher，验证轮询和跨房间身份，不挂载页面或派发任务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowReactive, shallowRef, watch, type ComputedRef, type ShallowRef } from 'vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { GroupRoom } from '../shared/agent-group-chat.js';
import { buildGroupChatConversation } from '../src/features/agent-workbench/group-chat-conversation.js';

function room(id = 'room'): GroupRoom {
  return { id, title: '团队任务', workspacePath: '/same/project', executionPath: '/same/project', paused: false,
    cursorTrustPaths: [], rounds: [], createdAt: '2026-11-04T09:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z' };
}
function run(id: string, taskId = 'room'): AgentRun {
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-6.1-sol', reasoningEffort: '',
    objective: '原始任务 L123', workspacePath: '/same/project', branch: 'feature/fixture', headSha: 'fixture', status: 'running',
    sessionId: 'same-native-session', pid: null, result: '', error: '', events: [],
    team: { taskId, nodeId: 'node', stageKey: 'stage', profileId: 'frontend', profileRevision: 1 },
    createdAt: '2026-11-04T09:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z' };
}
function fixture() {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentGroupDetailsPanel.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentGroupDetailsPanel.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['conversation', 'ownedRuns', 'selectedRunId', 'selectedRun', 'detailOpen'];
  const pieces = tree.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
      .filter(declaration => names.includes(declaration.name.getText(tree)))
      .map(declaration => `const ${declaration.getText(tree)};`);
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'inspect') return [statement.getText(tree)];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(tree) === 'watch'
      && ['() => props.room?.id', '() => props.visible'].includes(statement.expression.arguments[0]?.getText(tree) || '')) return [statement.getText(tree)];
    return [];
  });
  assert.equal(pieces.length, 8, '必须加载实际选择状态、抽屉开关、inspect 和房间/可见性 watcher');
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const own = run('own');
  const props = shallowReactive<{ room?: GroupRoom; runs: AgentRun[]; visible: boolean }>({ room: room(), runs: [own], visible: true });
  const selectedTabs: string[] = [];
  const sidePanel = shallowRef({ selectTab: (tab: string) => selectedTabs.push(tab) });
  const dependencies = { computed, shallowRef, watch, nextTick, props, sidePanel, buildGroupChatConversation };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { selectedRunId, selectedRun, detailOpen, inspect };`)(...Object.values(dependencies))) as {
    selectedRunId: ShallowRef<string>;
    selectedRun: ComputedRef<AgentRun | undefined>;
    detailOpen: ShallowRef<boolean>;
    inspect: (run: AgentRun) => Promise<void>;
  };
  return { ...state, own, props, selectedTabs, close: () => scope.stop() };
}

test('点击本房间真实执行记录后选中该运行并切换到动态页签', async () => {
  const f = fixture();
  try {
    const pending = f.inspect(f.own);
    assert.equal(f.selectedRunId.value, f.own.id);
    assert.deepEqual(f.selectedTabs, []);
    await pending;
    assert.equal(f.selectedRun.value, f.own);
    assert.deepEqual(f.selectedTabs, ['execution']);
  } finally { f.close(); }
});

test('关闭日志抽屉或隐藏群详情时清空选择，轮询不重新打开抽屉', async () => {
  const f = fixture();
  try {
    await f.inspect(f.own);
    assert.equal(f.detailOpen.value, true);
    f.detailOpen.value = false;
    assert.equal(f.selectedRunId.value, '');
    f.props.runs = [{ ...f.own, result: '新的回读' }]; await nextTick();
    assert.equal(f.detailOpen.value, false);
    await f.inspect(f.own);
    f.props.visible = false; await nextTick();
    assert.equal(f.detailOpen.value, false);
    f.props.visible = true; await nextTick();
    assert.equal(f.detailOpen.value, false);
  } finally { f.close(); }
});

test('同房间轮询换新对象后选中记录同步最新结果和事件，旧点击对象不覆盖新回读', async () => {
  const f = fixture();
  try {
    await f.inspect(f.own);
    const events: AgentRun['events'] = [{ id: 'event-new', type: 'message', message: '最新真实进展 L456', createdAt: '2026-11-04T09:02:00.000Z' }];
    const fresh = { ...f.own, status: 'completed' as const, result: '最新原始结果 L789', events, updatedAt: '2026-11-04T09:02:00.000Z' };
    f.props.room = { ...f.props.room!, updatedAt: fresh.updatedAt };
    f.props.runs = [fresh];
    await nextTick();
    assert.equal(f.selectedRunId.value, f.own.id);
    assert.equal(f.selectedRun.value, fresh);
    assert.equal(f.selectedRun.value?.events, events);
    assert.equal(f.selectedRun.value?.result, fresh.result);
    assert.deepEqual(f.selectedTabs, ['execution'], '轮询不能抢走用户手动页签');
    await f.inspect(f.own);
    assert.equal(f.selectedRun.value, fresh, '只按 ID 定位当前真实记录，不保存旧点击快照');
  } finally { f.close(); }
});

test('同目录同原生 session 的其他房间运行不能被选中或覆盖当前选择', async () => {
  const f = fixture();
  try {
    const foreign = run('foreign', 'other-room');
    f.props.runs = [f.own, foreign];
    await f.inspect(foreign);
    assert.equal(f.selectedRunId.value, '');
    assert.equal(f.selectedRun.value, undefined);
    assert.deepEqual(f.selectedTabs, []);
    await f.inspect(f.own);
    await f.inspect(foreign);
    assert.equal(f.selectedRun.value, f.own);
    assert.deepEqual(f.selectedTabs, ['execution']);
  } finally { f.close(); }
});

test('切换或清空房间时清除旧选择，旧群运行不能进入新群详情', async () => {
  const f = fixture();
  try {
    await f.inspect(f.own);
    const next = run('next-owned', 'next-room');
    f.props.room = room('next-room');
    f.props.runs = [next, f.own];
    await nextTick();
    assert.equal(f.selectedRunId.value, '');
    assert.equal(f.selectedRun.value, undefined);
    await f.inspect(f.own);
    assert.equal(f.selectedRun.value, undefined);
    await f.inspect(next);
    assert.equal(f.selectedRun.value, next);
    assert.deepEqual(f.selectedTabs, ['execution', 'execution']);
    f.props.room = undefined;
    await nextTick();
    assert.equal(f.selectedRunId.value, '');
    assert.equal(f.selectedRun.value, undefined);
  } finally { f.close(); }
});

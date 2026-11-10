import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { useJiraDevRuntime } from '../src/features/jira-dev/useJiraDevRuntime.js';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';
import type { JiraDevWorkflow } from '../shared/jira-dev.js';

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
});
// Codex / Cursor 的健康接口省略 accessModes，运行器和会话页均按两种权限可用处理。
const runtimes = ['codex', 'cursor', 'claude', 'kiro', 'antigravity'].map(provider => ({
  provider, label: provider, ready: true, modes: ['agent', 'plan', 'ask'],
  ...(provider === 'codex' || provider === 'cursor' ? {} : { accessModes: ['workspace', 'full'] }),
  models: [{ id: 'test', label: 'test' }], defaultModel: 'test',
})) as AgentRuntimeHealth[];

function mount(workflow: JiraDevWorkflow, items = runtimes, count = () => 1, mode: 'manual' | 'group' = 'manual') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(['jira-dev-runtimes'], structuredClone(items));
  client.setQueryData(['agent-group-chat'], { config: { revision: 4, name: '自定义研发团队', members: [{ id: 'ui', name: '前端实现', capability: 'write', enabled: true, instructions: '实现', binding: { provider: 'codex', model: 'test', reasoningEffort: '' } }] }, rooms: [] });
  let state!: ReturnType<typeof useJiraDevRuntime>;
  const app = renderer.createApp({ setup() { state = useJiraDevRuntime(workflow, count); state.automatic.value = mode === 'group'; return () => null; } });
  app.use(VueQueryPlugin, { queryClient: client }); app.mount({});
  return { state, close() { app.unmount(); client.clear(); } };
}

for (const workflow of ['requirement', 'jira'] as const) test(`${workflow}：五种执行器都能选择完全访问，切换时保留选择`, async () => {
  const { state, close } = mount(workflow);
  try {
    for (const runtime of runtimes) {
      state.choose(runtime.provider);
      assert.deepEqual(state.accessModes.value, ['workspace', 'full']);
      state.selection.accessMode = 'full';
      await nextTick();
      assert.equal(state.selection.accessMode, 'full');
      assert.match(state.summary.value, /完全访问/);
      assert.equal(state.problem.value, '');
    }
  } finally { close(); }
});

test('新需求默认完全访问，能力列表省略时不得自动降为工作区', () => {
  const { state, close } = mount('requirement');
  try { assert.equal(state.selection.accessMode, 'full'); }
  finally { close(); }
});

test('健康接口明确限定工作区的旧执行器仍遵守实际能力', () => {
  const { state, close } = mount('requirement', [{ ...runtimes[0]!, accessModes: ['workspace'] }]);
  try { assert.deepEqual(state.accessModes.value, ['workspace']); assert.equal(state.selection.accessMode, 'workspace'); }
  finally { close(); }
});

test('Jira 模型与强度分开选择，嵌入强度恢复真实模型ID，Claude保留原生强度', async () => {
  const items = [
    { ...runtimes[4]!, provider: 'antigravity', defaultModel: 'gemini-4-argon-low', models: [
      { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    ] },
    { ...runtimes[2]!, provider: 'claude', defaultModel: 'sonnet', models: [
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high', 'max'] },
    ] },
  ] as AgentRuntimeHealth[];
  const saved = new Map<string, string>();
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } });
  const first = mount('jira', items);
  let reopened: ReturnType<typeof mount> | undefined;
  try {
    first.state.choose('antigravity');
    assert.deepEqual(first.state.models.value.map(item => item.label), ['Gemini 4 Argon']);
    first.state.modelPicker.effort.value = 'high';
    await nextTick();
    assert.equal(first.state.selection.model, 'gemini-4-argon-high');
    assert.equal(first.state.selection.reasoningEffort, '');
    assert.match(first.state.summary.value, /推理高/);
    reopened = mount('jira', items);
    assert.equal(reopened.state.selection.model, 'gemini-4-argon-high');
    assert.equal(reopened.state.modelPicker.effort.value, 'high');
    reopened.state.choose('claude');
    assert.deepEqual(reopened.state.efforts.value, ['low', 'high', 'max']);
    reopened.state.modelPicker.effort.value = 'max';
    assert.equal(reopened.state.selection.model, 'sonnet');
    assert.equal(reopened.state.selection.reasoningEffort, 'max');
  } finally {
    reopened?.close(); first.close();
    if (previousStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
  }
});

test('三个项目选择完全访问后解除权限提示，单个 Agent 与自动协作切换均保留权限', async () => {
  const { state, close } = mount('requirement', runtimes, () => 3);
  try {
    state.selection.accessMode = 'workspace';
    assert.match(state.problem.value, /多项目任务需要完全访问/);
    assert.ok(state.accessModes.value.includes('full'));
    state.selection.accessMode = 'full';
    assert.equal(state.problem.value, '');
    state.automatic.value = true;
    await nextTick();
    state.automatic.value = false;
    await nextTick();
    assert.equal(state.selection.accessMode, 'full');
    assert.equal(state.problem.value, '');
  } finally { close(); }
});

test('团队选项使用自定义角色配置及当前版本，选择不静默改变单模型', async () => {
  const { state, close } = mount('requirement', runtimes, () => 1, 'group');
  try { await nextTick(); assert.equal(state.selection.collaborationMode, 'group'); assert.equal(state.selection.groupConfigRevision, 4); assert.match(state.summary.value, /自定义研发团队.*前端实现/); assert.equal(state.problem.value, ''); } finally { close(); }
});

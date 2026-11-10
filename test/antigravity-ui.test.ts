import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowRef, watch } from 'vue';
import { defaultTeamProfileConfig, profileConfigSchema, teamModelChoiceSchema } from '../shared/agent-team.js';
import { reviewChoiceFor } from '../shared/agent-roles.js';
import { jiraDevRuntimeSchema } from '../shared/jira-dev.js';
import { agentProviderLabels, codexWorkbenchDefaults, workbenchRuntime, type AgentRun, type AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { executionEntries } from '../src/features/auto-delivery/execution-entries.js';
import { agentConversationContinuation, agentConversationInsertRun, buildAgentConversations } from '../src/features/agent-workbench/conversation.js';
import { providerSwitchInput } from '../src/features/agent-workbench/provider-switch.js';
import { codexServiceTier } from '../src/features/agent-workbench/model-speed.js';
import { useAgentModelSelection } from '../src/features/agent-workbench/model-selection.js';

const run: AgentRun = { id: 'antigravity-run', provider: 'antigravity', objective: '检查接入', mode: 'ask', accessMode: 'workspace',
  status: 'completed', model: 'catalog-a', reasoningEffort: '', workspacePath: '/fixture', branch: '', headSha: '', sessionId: 'fixture-session',
  createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:01:00Z', result: '完成', error: '', events: [], pid: null };
const runtime: AgentRuntimeHealth = { provider: 'antigravity', label: 'Antigravity CLI', binary: '/fixture/antigravity', version: 'fixture',
  authenticated: true, ready: true, message: 'fixture', modes: ['ask', 'plan', 'agent'], accessModes: ['workspace', 'full'],
  models: [{ id: 'catalog-a', label: 'L_FIXTURE_MODEL_A' }], defaultModel: 'catalog-a', writable: true, checkedAt: run.updatedAt };

function scriptCode(relative: string) {
  const raw = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const source = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || raw;
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n').replace(/^export /gm, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

test('历史团队配置补齐 Antigravity 审查路由，保留已有岗位并拒绝同执行器自审', () => {
  const original = defaultTeamProfileConfig();
  const { antigravity: _antigravity, ...legacyRouting } = original.reviewRouting;
  const restored = profileConfigSchema.parse({ ...original, reviewRouting: legacyRouting });
  assert.deepEqual(restored.profiles, original.profiles);
  assert.deepEqual(restored.reviewRouting, { ...legacyRouting, antigravity: reviewChoiceFor('antigravity') });
  assert.equal(restored.reviewRouting.antigravity.provider, 'codex');
  const selfReview = { ...restored, reviewRouting: { ...restored.reviewRouting,
    antigravity: { provider: 'antigravity', model: 'catalog-a', reasoningEffort: '' } } };
  assert.equal(profileConfigSchema.safeParse(selfReview).success, false);
  assert.equal(teamModelChoiceSchema.safeParse({ provider: 'antigravity', model: 'catalog-a', reasoningEffort: '' }).success, true);
});

test('Antigravity 使用实际目录模型与权限，执行列表正确识别运行器', () => {
  assert.equal(workbenchRuntime(runtime), runtime);
  assert.deepEqual(jiraDevRuntimeSchema.parse({ provider: 'antigravity', model: 'catalog-a', accessMode: 'workspace' }),
    { provider: 'antigravity', model: 'catalog-a', accessMode: 'workspace', reasoningEffort: '' });
  assert.equal(executionEntries([run], [])[0]?.source, 'Antigravity CLI');
});

test('Antigravity 会话保持只读默认，显式模式透传且不携带 Codex 专属速度', () => {
  const conversation = buildAgentConversations([run])[0];
  const selection = { provider: 'antigravity' as const, model: 'catalog-a', reasoningEffort: '' as const, accessMode: 'full' as const,
    serviceTier: 'priority' as const };
  const readonly = providerSwitchInput(conversation, '继续分析', selection);
  assert.equal(readonly.mode, 'ask');
  assert.equal(readonly.accessMode, 'workspace');
  const writable = providerSwitchInput(conversation, '执行修改', { ...selection, mode: 'agent' });
  assert.equal(writable.mode, 'agent');
  assert.equal(writable.accessMode, 'full');
  assert.equal('serviceTier' in writable, false);
  assert.equal(run.mode, 'ask');
});

test('Antigravity 已保存的 Jira 执行器选择可恢复，不回退到其他 CLI', () => {
  const code = scriptCode('../src/features/jira-dev/useJiraDevRuntime.ts');
  const query = { data: shallowRef([runtime]), isPending: shallowRef(false), error: shallowRef(undefined) };
  const saved = { collaborationMode: 'manual', provider: 'antigravity', model: 'catalog-a', reasoningEffort: '', accessMode: 'workspace' };
  const scope = effectScope();
  try {
    const dependencies = { computed, reactive, watch, useAgentModelSelection, useQuery: () => query, agentProviderLabels,
      agentModelDefaults: shallowRef({ ...codexWorkbenchDefaults, revision: '' }),
      localStorage: { getItem: () => JSON.stringify(saved), setItem: () => {} } };
    const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn useJiraDevRuntime('requirement');`)(...Object.values(dependencies)));
    assert.equal(state.selection.provider, 'antigravity');
    assert.equal(state.selection.accessMode, 'workspace');
    assert.equal(state.models.value[0].label, 'L_FIXTURE_MODEL_A', '目录展示文案原样保留');
    assert.equal(state.problem.value, '');
  } finally { scope.stop(); }
});

test('Antigravity 输入框遵循实时模型目录，手选写权限仅影响下一轮并保留图片草稿', async () => {
  const code = scriptCode('../src/features/agent-workbench/AgentComposer.vue');
  const props = reactive({ conversation: buildAgentConversations([run])[0], changing: '', running: false, canInsert: false,
    businessOptions: [], runtimes: [structuredClone(runtime)] });
  const image = { id: 'fixture-image', name: '截图.png', mimeType: 'image/png', size: 4, url: '/fixture/image' };
  const attachments = shallowRef([image]), draft = shallowRef('按图片要求处理');
  const emitted: Record<string, unknown>[] = [];
  const dependencies = { computed, shallowRef, watch, useTemplateRef: () => shallowRef(), agentConversationContinuation,
    agentConversationInsertRun, codexWorkbenchDefaults, codexServiceTier, useAgentModelSelection, agentModelDefaults: shallowRef({ ...codexWorkbenchDefaults, revision: '' }),
    defineProps: () => props, defineModel: (name: unknown) => name === 'automatic' ? shallowRef(false) : name === 'attachments' ? attachments : draft,
    defineEmits: () => (event: string, selection: Record<string, unknown>) => { if (event === 'send') emitted.push(selection); },
    defineExpose: () => {}, window: { localStorage: { getItem: () => null, setItem: () => {} } } };
  const scope = effectScope();
  try {
    const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { selectedModel, modelOptions, composerMode, selectedAccessMode, setMode, submit, canSend };`)
      (...Object.values(dependencies)));
    assert.equal(state.composerMode.value, 'ask');
    assert.equal(state.selectedAccessMode.value, 'workspace');
    assert.equal(state.modelOptions.value[0].label, 'L_FIXTURE_MODEL_A');
    props.runtimes = [{ ...props.runtimes[0], models: [{ id: 'catalog-b', label: 'L_FIXTURE_MODEL_B' }], defaultModel: 'catalog-b' }];
    await nextTick();
    assert.equal(state.selectedModel.value, 'catalog-b');
    state.setMode('agent');
    state.selectedAccessMode.value = 'workspace';
    await nextTick();
    props.runtimes = props.runtimes.map(value => ({ ...value, accessModes: [...value.accessModes!] }));
    await nextTick();
    assert.equal(state.selectedAccessMode.value, 'workspace');
    assert.equal(emitted.length, 0, '选择和刷新不发送任务');
    assert.equal(state.canSend.value, true);
    state.submit();
    assert.equal(emitted[0].provider, 'antigravity');
    assert.equal(emitted[0].mode, 'agent');
    assert.equal(emitted[0].model, 'catalog-b');
    assert.equal('serviceTier' in emitted[0], false);
    assert.deepEqual(attachments.value, [image]);
    assert.equal(run.mode, 'ask');
  } finally { scope.stop(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { modelSelectionChoices, modelSelectionEffort, selectModelChoice, selectModelEffort, useAgentModelSelection } from '../src/features/agent-workbench/model-selection.js';

const antigravity = { provider: 'antigravity', defaultModel: 'gemini-4-argon-medium', models: [
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
] } as AgentRuntimeHealth;

test('Antigravity先选模型后选目录实际强度，发送与回读保留原始模型ID', () => {
  const before = structuredClone(antigravity), choices = modelSelectionChoices(antigravity);
  assert.deepEqual(choices.map(item => item.label), ['Gemini 4 Argon', 'Claude Opus 5.5', 'GPT-OSS 120B']);
  assert.deepEqual(choices[0].efforts, ['low', 'medium', 'high']);
  assert.deepEqual(selectModelChoice(antigravity, choices[0].id), { model: 'gemini-4-argon-medium', reasoningEffort: '' });
  assert.deepEqual(selectModelEffort(antigravity, 'gemini-4-argon-medium', 'high'), { model: 'gemini-4-argon-high', reasoningEffort: '' });
  assert.equal(modelSelectionEffort(antigravity, 'gemini-4-argon-high', ''), 'high');
  assert.deepEqual(choices[2].efforts, ['medium']);
  assert.equal(selectModelEffort(antigravity, 'gpt-oss-120b-medium', 'low'), undefined, '不补造目录中不存在的强度');
  assert.deepEqual(antigravity, before, '页面分组不改接口模型目录');
});

test('Cursor快慢模型分组独立，无后缀默认不猜成medium', () => {
  const ids = ['gpt-5.3-codex-low', 'gpt-5.3-codex-high', 'gpt-5.3-codex', 'gpt-5.3-codex-low-fast', 'gpt-5.3-codex-high-fast', 'gpt-5.3-codex-fast'];
  const runtime = { provider: 'cursor', defaultModel: 'auto', models: ids.map(id => ({ id, label: id })) } as AgentRuntimeHealth;
  const choices = modelSelectionChoices(runtime);
  assert.deepEqual(choices.map(item => item.label), ['gpt-5.3-codex', 'gpt-5.3-codex-fast']);
  assert.deepEqual(choices[0].efforts, ['low', 'high']);
  assert.deepEqual(selectModelChoice(runtime, choices[0].id), { model: 'gpt-5.3-codex', reasoningEffort: '' });
  assert.deepEqual(selectModelEffort(runtime, ids[3], 'high'), { model: 'gpt-5.3-codex-high-fast', reasoningEffort: '' });
  assert.deepEqual(selectModelEffort(runtime, ids[3], ''), { model: 'gpt-5.3-codex-fast', reasoningEffort: '' });
  assert.equal(selectModelEffort(runtime, ids[0], 'medium'), undefined);
});

test('Codex和Claude保持原生强度参数，自定义模型与未识别名称原样保留', () => {
  const codex = { provider: 'codex', defaultModel: 'sol', models: [{ id: 'sol', label: 'Sol', efforts: ['low', 'ultra'], defaultEffort: 'ultra' }] } as AgentRuntimeHealth;
  assert.deepEqual(selectModelChoice(codex, 'sol'), { model: 'sol', reasoningEffort: 'ultra' });
  assert.deepEqual(selectModelEffort(codex, 'sol', 'low'), { model: 'sol', reasoningEffort: 'low' });
  assert.equal(selectModelEffort(codex, 'sol', 'medium'), undefined);
  const claude = { provider: 'claude', defaultModel: 'sonnet', models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }] } as AgentRuntimeHealth;
  assert.deepEqual(selectModelChoice(claude, 'sonnet'), { model: 'sonnet', reasoningEffort: '' });
  assert.deepEqual(selectModelChoice(claude, 'sonnet', false), { model: 'sonnet', reasoningEffort: 'low' });
  const runtime = { ...antigravity, models: [
    { id: 'mine-high', label: '我的自定义模型', customId: 'custom' },
    { id: 'unknown-high', label: '厂商原始展示名称' },
  ] } as AgentRuntimeHealth;
  assert.deepEqual(modelSelectionChoices(runtime).map(item => [item.id, item.label, item.efforts]), [
    ['mine-high', '我的自定义模型', []], ['unknown-high', '厂商原始展示名称', []],
  ]);
  assert.equal(modelSelectionChoices({ ...antigravity, provider: 'api' }).length, antigravity.models.length);
});

test('可写选择器支持存量ID恢复、模型切换和单档强度，不把显示分组写入请求', () => {
  const model = ref('gemini-4-argon-high'), effort = ref<'' | 'low' | 'medium' | 'high'>('');
  const picker = useAgentModelSelection(() => antigravity, model, effort);
  assert.equal(picker.model.value, 'gemini-4-argon-medium');
  assert.equal(picker.effort.value, 'high');
  assert.equal(picker.allowDefaultEffort.value, false);
  picker.effort.value = 'low';
  assert.equal(model.value, 'gemini-4-argon-low'); assert.equal(effort.value, '');
  picker.model.value = 'gpt-oss-120b-medium';
  assert.equal(picker.effort.value, 'medium');
  picker.effort.value = 'high';
  assert.equal(model.value, 'gpt-oss-120b-medium');
  picker.model.value = 'claude-opus-5-5-low';
  picker.effort.value = 'high';
  const saved = JSON.parse(JSON.stringify({ model: model.value, reasoningEffort: effort.value }));
  assert.deepEqual(saved, { model: 'claude-opus-5-5-high', reasoningEffort: '' });
  const restored = useAgentModelSelection(() => antigravity, ref(saved.model), ref(saved.reasoningEffort));
  assert.equal(restored.effort.value, 'high');
});

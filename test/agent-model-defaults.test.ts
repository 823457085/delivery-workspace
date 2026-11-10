import test from 'node:test';
import assert from 'node:assert/strict';
import { agentModelDefaults, agentModelDefaultsKey, applyAgentModelDefaults, readAgentModelDefaults } from '../src/shared/agent-model-defaults.js';
import { codexWorkbenchDefaults, workbenchRuntime, type AgentRuntimeHealth } from '../shared/agent-runtime.js';

const runtime = { provider: 'codex', defaultModel: 'gpt-6.1-sol', models: [
  { id: 'gpt-6.1-sol', label: 'Sol', efforts: ['low', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-astra', label: 'Astra', efforts: ['medium', 'ultra'], defaultEffort: 'medium' },
  { id: 'custom', label: '自定义' },
] } as AgentRuntimeHealth;

test('默认配置持久化回读、重复应用版本更新，且只使用模型实际支持的档位', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.deepEqual(readAgentModelDefaults(storage), { model: codexWorkbenchDefaults.model, reasoningEffort: 'ultra', revision: '' });
  applyAgentModelDefaults({ model: 'gpt-6-astra', reasoningEffort: 'ultra' }, runtime, storage);
  const saved = readAgentModelDefaults(storage);
  assert.deepEqual(saved, agentModelDefaults.value);
  assert.equal(saved.model, 'gpt-6-astra');
  assert.ok(saved.revision);
  const selected = workbenchRuntime(runtime, saved);
  assert.equal(selected.defaultModel, 'gpt-6-astra');
  assert.equal(selected.models[1].defaultEffort, 'ultra');
  assert.equal(runtime.models[1].defaultEffort, 'medium');
  applyAgentModelDefaults(saved, runtime, storage);
  assert.notEqual(agentModelDefaults.value.revision, saved.revision);
  const before = agentModelDefaults.value;
  assert.throws(() => applyAgentModelDefaults({ model: 'gpt-6-astra', reasoningEffort: 'low' }, runtime, storage));
  assert.throws(() => applyAgentModelDefaults({ model: 'removed-model', reasoningEffort: '' }, runtime, storage));
  assert.throws(() => applyAgentModelDefaults({ model: 'custom', reasoningEffort: 'ultra' }, runtime, storage));
  assert.throws(() => applyAgentModelDefaults(saved, runtime, { setItem() { throw new Error('quota'); } }), /尚未保存/);
  assert.equal(agentModelDefaults.value, before, '保存失败不得应用或显示为已保存');
  applyAgentModelDefaults({ model: 'custom', reasoningEffort: '' }, runtime, storage);
  assert.equal(agentModelDefaults.value.reasoningEffort, '');
  values.set(agentModelDefaultsKey, '{broken');
  assert.equal(readAgentModelDefaults(storage).model, codexWorkbenchDefaults.model);
});

test('API 可设为默认执行器，刷新保留选择且不改 Codex 默认模型', () => {
  const storage = { value: '', getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } };
  const api = { provider: 'api', defaultModel: '', models: [{ id: 'deepseek-fixture', label: 'DeepSeek' }] } as AgentRuntimeHealth;
  applyAgentModelDefaults({ provider: 'api', model: 'deepseek-fixture', reasoningEffort: '' }, api, storage);
  const saved = readAgentModelDefaults(storage);
  assert.equal(saved.provider, 'api');
  assert.equal(workbenchRuntime(api, saved).defaultModel, 'deepseek-fixture');
  assert.equal(workbenchRuntime(runtime, saved), runtime);
  assert.throws(() => applyAgentModelDefaults({ provider: 'api', model: 'deepseek-fixture', reasoningEffort: 'high' }, api, storage));
  assert.throws(() => applyAgentModelDefaults({ provider: 'codex', model: 'deepseek-fixture', reasoningEffort: '' }, api, storage));
});

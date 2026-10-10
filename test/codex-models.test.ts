import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCodexModelReader, normalizeCodexModels, requestCodexModels } from '../server/codex-models.js';
import { codexServiceTier, modelSpeed } from '../src/features/agent-workbench/model-speed.js';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { workbenchRuntime } from '../shared/agent-runtime.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-model-server.mjs', import.meta.url));
test('工作台统一模型与极高强度，不复用低强度、不修改原目录或伪造可用能力', () => {
  const runtime = { provider: 'codex', defaultModel: 'older-model', models: [
    { id: 'older-model', label: 'Older', efforts: ['low'], defaultEffort: 'low' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'max'], defaultEffort: 'low' },
  ] } as AgentRuntimeHealth;
  const original = structuredClone(runtime);
  const selected = workbenchRuntime(runtime);
  assert.equal(selected.defaultModel, 'gpt-6.1-sol');
  assert.deepEqual(selected.models.map(model => [model.id, model.defaultEffort, model.efforts]), [['gpt-6.1-sol', 'max', ['max']]]);
  assert.deepEqual(runtime, original);
  assert.deepEqual(workbenchRuntime({ ...runtime, models: [runtime.models[0]] }).models, []);
  assert.deepEqual(workbenchRuntime({ ...runtime, models: [{ ...runtime.models[1], efforts: ['low'] }] }).models, []);
  const cursor = { ...runtime, provider: 'cursor' as const };
  assert.equal(workbenchRuntime(cursor), cursor);
});
test('模型目录使用真实 model、名称和推理档位，不绑定任何版本白名单', () => {
  const result = normalizeCodexModels([
    { id: 'catalog-id', model: 'future-model', displayName: '未来模型', isDefault: true, defaultReasoningEffort: 'xhigh',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'unknown' }] },
    { model: 'hidden', hidden: true }, null, {},
  ]);
  assert.equal(result.defaultModel, 'future-model');
  assert.deepEqual(result.models, [{ id: '', label: 'CLI 默认（当前配置）' },
    { id: 'future-model', label: '未来模型', efforts: ['medium', 'xhigh'], defaultEffort: 'xhigh' }]);
  assert.throws(() => normalizeCodexModels([]), /未返回/);
});

test('只读读取模型全部分页和速度配置，不创建会话或返回其他配置', async () => {
  const result = await requestCodexModels(process.execPath, [fixture]);
  assert.deepEqual(result.models.map(model => model.id), ['', 'first-model', 'new-model']);
  assert.equal(result.defaultModel, 'new-model');
  assert.deepEqual(result.models[2].efforts, ['high']);
  assert.equal(result.configuredServiceTier, 'priority');
  assert.equal(result.configuredModel, 'first-model');
  assert.deepEqual(result.models[2].serviceTiers, [{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  assert.doesNotMatch(JSON.stringify(result), /never-expose|private_config/);
  const partial = await requestCodexModels(process.execPath, [fixture, 'config-error']);
  assert.equal(partial.models.length, 3);
  assert.equal(partial.configuredServiceTier, undefined, '配置读取失败时不冒充开启倍速');
});

test('倍速按所选模型和 CLI 实际配置显示，原样保留倍率描述，不向 Cursor 或未知模型套用', () => {
  const first = { id: 'priority', name: 'Fast', description: '1.5x speed' };
  const second = { id: 'priority', name: 'Fast', description: '2x speed, increased usage' };
  const catalog = normalizeCodexModels([
    { model: 'sol', isDefault: true, serviceTiers: [first, { id: 'bad', name: 'broken' }] },
    { model: 'astra', serviceTiers: [{ ...second, private_field: 'discard' }] },
    { model: 'custom' },
  ], { model: 'astra', service_tier: 'priority', api_key: 'never-expose' });
  const runtime = { ...catalog, provider: 'codex' } as AgentRuntimeHealth;
  assert.deepEqual(modelSpeed(runtime, 'sol'), first);
  assert.deepEqual(modelSpeed(runtime, 'astra'), second);
  assert.deepEqual(modelSpeed(runtime, ''), second, 'CLI 默认对应实际配置模型，而不是目录推荐模型');
  assert.equal(modelSpeed(runtime, 'custom'), undefined);
  assert.equal(modelSpeed({ ...runtime, provider: 'cursor' }, 'sol'), undefined);
  assert.equal(modelSpeed({ ...runtime, configuredServiceTier: 'default' }, 'sol'), undefined);
  assert.equal(modelSpeed({ ...runtime, configuredServiceTier: undefined }, 'sol'), undefined);
  assert.deepEqual(modelSpeed({ ...runtime, configuredServiceTier: 'fast' }, 'sol'), first);
  assert.deepEqual(modelSpeed({ ...runtime, configuredServiceTier: 'default' }, 'sol', 'priority'), first,
    '输入区显式开启时仍可显示模型目录原文');
  assert.equal(modelSpeed(runtime, 'sol', 'default'), undefined, '输入区关闭时不沿用全局 Fast 提示');
  assert.equal(codexServiceTier(runtime, 'sol', 'default'), 'default');
  assert.equal(codexServiceTier(runtime, 'sol', 'priority'), 'priority');
  assert.equal(codexServiceTier(runtime, 'custom', 'priority'), 'default', '无倍速档位的模型不能沿用上一个模型的选择');
  assert.doesNotMatch(JSON.stringify(catalog), /never-expose|private_field|discard/);
  assert.equal(normalizeCodexModels([{ model: 'sol' }], {}).configuredServiceTier, undefined);
});

test('协议失败、分页循环、超时会释放查询进程且不泄露诊断', async () => {
  await assert.rejects(requestCodexModels(process.execPath, [fixture, 'error']), /Codex 模型查询失败/);
  await assert.rejects(requestCodexModels(process.execPath, [fixture, 'loop']), /分页异常/);
  await assert.rejects(requestCodexModels(process.execPath, [fixture, 'timeout'], 100), /读取超时/);
});

test('并发发现合并成一次查询，缓存过期后读取新模型，断线保留已知列表后恢复', async () => {
  let calls = 0;
  const read = createCodexModelReader(async () => {
    calls++;
    if (calls === 2) throw new Error('offline');
    return normalizeCodexModels([{ model: `model-${calls}`, isDefault: true }]);
  }, 0);
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  const offline = await read();
  assert.equal(offline.defaultModel, 'model-1');
  assert.match(offline.message || '', /上次/);
  const recovered = await read();
  assert.equal(recovered.defaultModel, 'model-3');
  assert.equal(recovered.message, undefined);
  let cachedCalls = 0;
  const cached = createCodexModelReader(async () => { cachedCalls++; return recovered; });
  await cached(); await cached();
  assert.equal(cachedCalls, 1);
});

test('首次失败不伪造可用模型版本，也不猜测 CLI 配置的推理能力', async () => {
  const read = createCodexModelReader(async () => { throw new Error('offline'); });
  const result = await read();
  assert.deepEqual(result.models, [{ id: '', label: 'CLI 默认（当前配置）' }]);
  assert.equal(result.defaultModel, '');
});

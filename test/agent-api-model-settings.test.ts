import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { agentProviderLabels } from '../shared/agent-runtime.js';

function modelSettings() {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentModelSettings.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentModelSettings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const props = reactive({ changing: '', runtimes: [
    { provider: 'codex', label: 'Codex CLI', models: [] },
    { provider: 'api', label: '模型 API', models: [{ id: 'api-model', label: 'L_MODEL_NAME', customId: 'fixture-id',
      api: { baseUrl: 'https://api.deepseek.com', hasApiKey: true } }] },
  ] });
  const visible = ref(true);
  const events: { event: string; input: any }[] = [];
  const dependencies = { computed, reactive, ref, watch, agentProviderLabels, defineProps: () => props, defineModel: () => visible,
    defineEmits: () => (event: string, input: unknown) => { events.push({ event, input }); } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { form, connection, cliRuntimes, customModels, canAdd, add };`)
    (...Object.values(dependencies)));
  return { ...state, props, visible, events, close: () => scope.stop() };
}

test('自定义 API 模型提交地址与独立密钥，立即清空输入；CLI 不携带 API 配置', async () => {
  const state = modelSettings();
  try {
    assert.deepEqual(state.cliRuntimes.value.map((runtime: any) => runtime.provider), ['codex']);
    assert.equal(state.customModels.value[0].label, 'L_MODEL_NAME');
    state.connection.value = 'api';
    Object.assign(state.form, { modelId: '  vendor-model  ', label: '  自定义模型  ', baseUrl: ' https://api.deepseek.com ', apiKey: 'fixture-secret' });
    assert.equal(state.canAdd.value, true);
    state.add();
    assert.deepEqual(state.events[0], { event: 'add', input: { provider: 'api', modelId: 'vendor-model', label: '自定义模型',
      api: { baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-secret' } } });
    assert.equal(state.form.apiKey, '');
    state.connection.value = 'cli';
    await nextTick();
    state.add();
    assert.deepEqual(state.events[1], { event: 'add', input: { provider: 'codex', modelId: 'vendor-model', label: '自定义模型' } });
    state.form.apiKey = 'draft-secret';
    state.visible.value = false;
    await nextTick();
    assert.equal(state.form.apiKey, '');
  } finally { state.close(); }
});

test('API 表单拒绝无效或含凭据的地址，允许无需认证的本机接口并阻止重复提交', () => {
  const state = modelSettings();
  try {
    state.connection.value = 'api';
    Object.assign(state.form, { modelId: 'local-model', label: '本机模型' });
    for (const url of ['', 'invalid', 'http://api.deepseek.com', 'https://user:password@api.deepseek.com', 'https://api.deepseek.com?key=secret', 'https://api.deepseek.com#secret']) {
      state.form.baseUrl = url;
      assert.equal(state.canAdd.value, false, url);
      state.add();
    }
    assert.equal(state.events.length, 0);
    state.form.baseUrl = 'http://127.0.0.1:11434/v1';
    assert.equal(state.canAdd.value, true);
    state.add();
    assert.deepEqual(state.events[0].input.api, { baseUrl: 'http://127.0.0.1:11434/v1' });
    state.props.changing = 'model:add';
    state.add();
    assert.equal(state.events.length, 1);
  } finally { state.close(); }
});

test('Grok 属于独立 API 执行器，固定官方地址且必须填写密钥', async () => {
  const state = modelSettings();
  try {
    state.props.runtimes.push({ provider: 'grok', label: 'Grok', models: [] });
    assert.equal(state.cliRuntimes.value.some((runtime: any) => runtime.provider === 'grok'), false);
    state.connection.value = 'grok';
    await nextTick();
    Object.assign(state.form, { modelId: 'grok-account-model', label: 'L_GROK', baseUrl: 'https://evil.example/v1' });
    assert.equal(state.canAdd.value, false);
    state.form.apiKey = 'xai-fixture';
    state.add();
    assert.deepEqual(state.events[0].input, { provider: 'grok', modelId: 'grok-account-model', label: 'L_GROK',
      api: { baseUrl: 'https://api.x.ai/v1', apiKey: 'xai-fixture' } });
    assert.equal(state.form.apiKey, '');
  } finally { state.close(); }
});

test('DeepSeek 使用独立 API 分支，固定官方地址、清空密钥且不进入 CLI 分类', async () => {
  const state = modelSettings();
  try {
    state.props.runtimes.push({ provider: 'deepseek', label: 'DeepSeek', models: [] });
    assert.equal(state.cliRuntimes.value.some((runtime: any) => runtime.provider === 'deepseek'), false);
    state.connection.value = 'deepseek';
    await nextTick();
    Object.assign(state.form, { modelId: 'account-model', label: 'L_DEEPSEEK', baseUrl: 'https://evil.example' });
    assert.equal(state.canAdd.value, false);
    state.form.apiKey = 'deepseek-fixture';
    state.add();
    assert.deepEqual(state.events[0].input, { provider: 'deepseek', modelId: 'account-model', label: 'L_DEEPSEEK',
      api: { baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-fixture' } });
    assert.equal(state.form.apiKey, '');
  } finally { state.close(); }
});

test('线上 NVIDIA DeepSeek 使用独立密钥与固定模型，切换通道同步清空密钥', () => {
  const state = modelSettings();
  try {
    state.connection.value = 'deepseek';
    Object.assign(state.form, { modelId: 'official-model', label: 'L_NVIDIA', apiKey: 'official-key-must-not-transfer' });
    state.connection.value = 'deepseek-nvidia';
    assert.equal(state.form.apiKey, '');
    assert.equal(state.form.modelId, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(state.canAdd.value, false);
    state.form.apiKey = 'nvidia-fixture';
    state.add();
    assert.deepEqual(state.events[0].input, { provider: 'deepseek', modelId: 'deepseek-ai/deepseek-v4.1-flash', label: 'L_NVIDIA',
      api: { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvidia-fixture' } });
    assert.equal(state.form.apiKey, '');
    state.form.apiKey = 'other-draft';
    state.connection.value = 'deepseek';
    assert.equal(state.form.apiKey, '');
    assert.equal(state.form.modelId, '');
  } finally { state.close(); }
});

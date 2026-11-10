import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService } from '../server/agent-runtime.js';
import { agentCustomModelSchema, agentStartSchema } from '../server/agent-runtime-input.js';
import { stateBackupFiles, validateStateJson } from '../server/state-backup.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function complete(run: AgentRun) {
  for (let attempt = 0; attempt < 300 && !run.resultReady; attempt++) await delay(10);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true);
}
test('DeepSeek 服务配置、配置 ID 绑定、跨重启续聊、权限及凭据备份隔离', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-service-test-'));
  const root = path.join(directory, 'workspace'), state = path.join(directory, 'state');
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.deepseek.com/user/balance') return Response.json({ is_available: true });
    if (String(url) === 'https://api.deepseek.com/models') return Response.json({ data: [{ id: 'same-model-id' }] });
    assert.equal(String(url), 'https://api.deepseek.com/responses');
    requests.push(JSON.parse(String(init!.body)));
    assert.equal((init!.headers as any).Authorization, 'Bearer service-secret');
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'L_SERVICE 原样' }] }] });
  };
  let service = await createAgentRuntimeService(state, { adapters: [], apiModels: true });
  try {
    assert.equal((await service.dashboard()).runtimes.find(item => item.provider === 'deepseek')!.ready, false);
    assert.equal(agentCustomModelSchema.safeParse({ provider: 'deepseek', modelId: 'x', label: 'x' }).success, false);
    await assert.rejects(service.addCustomModel({ provider: 'deepseek', modelId: 'bad', label: 'bad', api: { baseUrl: 'https://evil.example/v1', apiKey: 'secret' } }), /仅接受官方/);
    const model = await service.addCustomModel({ provider: 'deepseek', modelId: 'same-model-id', label: 'L_DEEPSEEK_LABEL',
      api: { baseUrl: 'https://api.deepseek.com', apiKey: 'service-secret' } });
    // The generic API can use the same model name; it must not supply DeepSeek's key or runtime.
    await service.addCustomModel({ provider: 'api', modelId: 'same-model-id', label: 'Generic', api: { baseUrl: 'https://example.com/v1', apiKey: 'other-secret' } });
    const dashboard = await service.dashboard();
    assert.equal(JSON.stringify(dashboard).includes('service-secret'), false);
    const health = dashboard.runtimes.find(item => item.provider === 'deepseek')!;
    assert.equal(health.authenticated, true);
    assert.deepEqual(health.accessModes, ['workspace']);
    assert.equal(health.models[0].label, 'L_DEEPSEEK_LABEL');
    assert.deepEqual(health.models[0].api, { baseUrl: 'https://api.deepseek.com', hasApiKey: true });
    const input = agentStartSchema.parse({ provider: 'deepseek', mode: 'agent', accessMode: 'workspace', model: 'same-model-id', objective: '第一轮', workspacePath: root });
    await assert.rejects(service.start({ ...input, accessMode: 'full' }), /访问权限不受/);
    const first = await service.start(input);
    await complete(first);
    assert.equal(first.customModelId, model.id);
    assert.equal(first.result, 'L_SERVICE 原样');
    await service.close();
    service = await createAgentRuntimeService(state, { adapters: [], apiModels: true });
    const second = await service.resume(first.id, '第二轮', undefined, undefined, [], 'workspace');
    await complete(second);
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(requests[1].input.map((item: any) => item.content), ['第一轮', [{ type: 'output_text', text: 'L_SERVICE 原样' }], '第二轮']);
    const catalog = await fs.readFile(path.join(state, 'custom-models.json'), 'utf8');
    assert.equal(catalog.includes('service-secret'), false);
    validateStateJson('agent-runtimes/custom-models.json', JSON.parse(catalog));
    assert.equal((await fs.stat(path.join(state, 'api-model-credentials.json'))).mode & 0o777, 0o600);
    assert.equal(stateBackupFiles.some(item => /credentials|deepseek-tools|deepseek-transcripts/.test(item)), false);
    await service.removeCustomModel(model.id);
    assert.equal((await fs.readFile(path.join(state, 'api-model-credentials.json'), 'utf8')).includes('service-secret'), false);
  } finally { await service.close(); globalThis.fetch = originalFetch; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService } from '../server/agent-runtime.js';
import { agentCustomModelSchema, agentStartSchema } from '../server/agent-runtime-input.js';
import { stateBackupFiles, validateStateJson } from '../server/state-backup.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function complete(run: AgentRun) {
  for (let attempt = 0; attempt < 200 && !run.resultReady; attempt++) await delay(10);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true);
}

test('API 模型独立持久化、跨服务续聊和用量正确；模型目录与备份不包含密钥', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'api-model-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requests: { body: any; authorization: string | undefined }[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'text/event-stream');
    response.end('data: {"choices":[{"delta":{"content":"L123 原样回复"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n'
      + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  let service = await createAgentRuntimeService(directory, { adapters: [], apiModels: true });
  try {
    const created = await service.addCustomModel(agentCustomModelSchema.parse({ provider: 'api', modelId: 'fixture-model', label: 'API 测试模型',
      api: { baseUrl, apiKey: 'fixture-secret-only' } }));
    const rawCatalog = await fs.readFile(path.join(directory, 'custom-models.json'), 'utf8');
    assert.equal(rawCatalog.includes('fixture-secret-only'), false);
    validateStateJson('agent-runtimes/custom-models.json', JSON.parse(rawCatalog));
    assert.equal(stateBackupFiles.some(file => file.includes('api-model-credentials')), false);
    const credentialsFile = path.join(directory, 'api-model-credentials.json');
    assert.equal((await fs.stat(credentialsFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(credentialsFile, 'utf8'))[created.id], 'fixture-secret-only');
    const catalogFile = path.join(directory, 'custom-models.json');
    await fs.rm(catalogFile); await fs.mkdir(catalogFile);
    await assert.rejects(service.removeCustomModel(created.id));
    assert.equal(JSON.parse(await fs.readFile(credentialsFile, 'utf8'))[created.id], 'fixture-secret-only', '删除落盘失败时恢复模型认证');
    await fs.rm(catalogFile, { recursive: true }); await fs.writeFile(catalogFile, rawCatalog);
    const dashboard = await service.dashboard();
    assert.equal(JSON.stringify(dashboard).includes('fixture-secret-only'), false);
    const runtime = dashboard.runtimes.find(item => item.provider === 'api')!;
    assert.deepEqual(runtime.modes, ['ask', 'plan']);
    assert.deepEqual(runtime.models[0].api, { baseUrl, hasApiKey: true });
    const input = agentStartSchema.parse({ provider: 'api', mode: 'ask', model: 'fixture-model', objective: '第一条消息' });
    await assert.rejects(service.start({ ...input, mode: 'agent', accessMode: 'full' }), /模式不受/);
    const first = await service.start(input);
    await complete(first);
    assert.equal(first.result, 'L123 原样回复');
    assert.equal(first.usage?.source, 'api.usage');
    assert.equal(first.usage?.inputTokens, 8);
    await service.close();
    service = await createAgentRuntimeService(directory, { adapters: [], apiModels: true });
    const second = await service.resume(first.id, '第二条消息');
    await complete(second);
    assert.equal(second.provider, 'api');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(requests[1].authorization, 'Bearer fixture-secret-only');
    assert.deepEqual(requests[1].body.messages.slice(1), [
      { role: 'user', content: '第一条消息' }, { role: 'assistant', content: 'L123 原样回复' }, { role: 'user', content: '第二条消息' },
    ]);
    await assert.rejects(service.addCustomModel({ provider: 'api', modelId: 'unsafe', label: '非法地址',
      api: { baseUrl: 'https://user:password@example.com' } }), /不能包含凭据/);
    await service.removeCustomModel(created.id);
    assert.deepEqual(JSON.parse(await fs.readFile(credentialsFile, 'utf8')), {});
    assert.equal((await service.dashboard()).runtimes.find(item => item.provider === 'api')!.models.length, 0);
  } finally { await service.close(); }
});

test('API 与 CLI 配置严格区分，旧 CLI 及 API 启动字段均可校验', () => {
  assert.equal(agentCustomModelSchema.safeParse({ provider: 'codex', modelId: 'custom', label: '旧模型' }).success, true);
  assert.equal(agentCustomModelSchema.safeParse({ provider: 'codex', modelId: 'custom', label: '旧模型', api: { baseUrl: 'https://example.com' } }).success, false);
  assert.equal(agentCustomModelSchema.safeParse({ provider: 'api', modelId: 'custom', label: 'API' }).success, false);
});

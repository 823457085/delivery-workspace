import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createApiModelAdapter, normalizeApiBaseUrl } from '../server/api-model-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentRuntimeAdapter } from '../server/agent-runtime.js';

async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { response.destroy(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'api-test-current', provider: 'api', mode: 'ask', accessMode: 'workspace', model: 'deepseek-fixture',
    reasoningEffort: '', objective: '当前问题', workspacePath: '', branch: '', headSha: '', status: 'running', sessionId: '',
    pid: null, result: '', error: '', events: [], createdAt: '', updatedAt: '', ...overrides };
}
function context(overrides: Partial<Parameters<AgentRuntimeAdapter['execute']>[0]> = {}) {
  return { run: run(), imagePaths: [], fileAttachments: [], signal: new AbortController().signal,
    onPid() {}, onSession() {}, onEvent() {}, ...overrides };
}
async function requestBody(request: IncomingMessage) {
  let body = ''; for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

test('API Base URL 规范化拒绝非安全协议、远端明文 HTTP 和 URL 凭据', () => {
  assert.equal(normalizeApiBaseUrl(' https://api.deepseek.com/v1/ '), 'https://api.deepseek.com/v1');
  assert.equal(normalizeApiBaseUrl('http://[::1]:1200/'), 'http://[::1]:1200');
  for (const value of ['garbage', 'ftp://api.example.com', 'http://api.example.com', 'https://a:b@api.example.com',
    'https://api.example.com?api_key=secret', 'https://api.example.com/#key']) assert.throws(() => normalizeApiBaseUrl(value));
});

test('API 直接发送模型与多轮历史，分片 SSE 正确重组文字和用量且不混入推理内容', async () => {
  let received: unknown, authorization: string | undefined, pathname = '';
  const service = await endpoint(async (request, response) => {
    received = await requestBody(request); authorization = request.headers.authorization; pathname = request.url || '';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      ': keepalive\r\n\r\n',
      'data: {"choices":[{"delta":{"reasoning_content":"隐藏推理"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"，API"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_cache_hit_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const bytes = Buffer.from(chunks.join(''));
    for (let i = 0; i < bytes.length; i += 7) response.write(bytes.subarray(i, i + 7));
    response.end();
  });
  try {
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom-api', modelId: 'deepseek-fixture', label: '测试 API', api: { baseUrl: `${service.url}/v1` } }],
      apiKey: async () => 'fixture-key', history: () => [run({ id: 'previous', objective: '前一问题', result: '前一回答', status: 'completed' }),
        run({ id: 'failed', objective: '失败问题', result: '未完成', status: 'failed' })] });
    assert.equal((await adapter.health()).models[0]?.customId, 'custom-api');
    assert.deepEqual((await adapter.health()).modes, ['ask', 'plan']);
    const output: string[] = [], usage: unknown[] = [], sessions: string[] = [];
    const result = await adapter.execute(context({ run: run({ knowledgeContext: '已选资料' }), resumeSessionId: 'api-existing-session',
      onOutput: value => output.push(value), onUsage: value => usage.push(value), onSession: id => { sessions.push(id); } }));
    assert.equal(pathname, '/v1/chat/completions');
    assert.equal(authorization, 'Bearer fixture-key');
    assert.deepEqual(received, { model: 'deepseek-fixture', messages: [
      { role: 'system', content: '你是工作台的对话助手。请回答用户的问题。当前 API 会话没有本机文件、终端或其他执行工具；不要声称已执行这些操作。' },
      { role: 'system', content: '已选资料' }, { role: 'user', content: '前一问题' }, { role: 'assistant', content: '前一回答' }, { role: 'user', content: '当前问题' },
    ], stream: true, stream_options: { include_usage: true } });
    assert.equal(result, '你好，API');
    assert.deepEqual(output, ['你好', '你好，API']);
    assert.deepEqual(sessions, ['api-existing-session']);
    assert.deepEqual(usage, [{ usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2 } }]);
  } finally { await service.close(); }
});

test('API 支持 JSON 响应与 plan 模式，无配置不伪报就绪', async () => {
  const service = await endpoint(async (request, response) => {
    const input = await requestBody(request);
    assert.match(input.messages[0].content, /可执行计划/);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '步骤一' }, finish_reason: 'stop' }] }));
  });
  try {
    const empty = createApiModelAdapter({ models: () => [], apiKey: async () => '', history: () => [] });
    assert.equal((await empty.health()).ready, false);
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: '本机 API', api: { baseUrl: `${service.url}/chat/completions` } }],
      apiKey: async () => '', history: () => [] });
    assert.equal(await adapter.execute(context({ run: run({ mode: 'plan' }) })), '步骤一');
    await assert.rejects(adapter.execute(context({ run: run({ mode: 'agent' }) })), /支持对话和规划/);
    await assert.rejects(adapter.execute(context({ imagePaths: ['/tmp/attached.png'] })), /不支持附件/);
  } finally { await service.close(); }
});

test('API 团队轮次保留岗位职责、前置成员成果和本轮用户原文', async () => {
  let messages: { role: string; content: string }[] = [];
  const service = await endpoint(async (request, response) => {
    messages = (await requestBody(request)).messages;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '已核对前置成果' }, finish_reason: 'stop' }] }));
  });
  try {
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: service.url } }],
      apiKey: async () => '', history: () => [] });
    const current = run({ teamContext: '岗位：独立审查。前置成员成果：context-nonce-4217。' });
    assert.equal(await adapter.execute(context({ run: current })), '已核对前置成果');
    assert.ok(messages.some(item => item.role === 'system' && item.content === current.teamContext));
    assert.deepEqual(messages.at(-1), { role: 'user', content: '当前问题' });
    assert.equal(current.objective, '当前问题');
  } finally { await service.close(); }
});

test('API JSON 和 SSE DONE 缺少成功终态时保留部分输出但不得判为完成', async () => {
  const service = await endpoint((request, response) => {
    if (request.url?.startsWith('/json/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '未确认完成的片段' } }] }));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"未确认完成的片段"}}]}\n\ndata: [DONE]\n\n');
    }
  });
  try {
    for (const route of ['json', 'sse']) {
      const output: string[] = [];
      const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: `${service.url}/${route}` } }],
        apiKey: async () => '', history: () => [] });
      await assert.rejects(adapter.execute(context({ onOutput: value => output.push(value) })), /完成前中断/);
      assert.deepEqual(output, ['未确认完成的片段']);
    }
  } finally { await service.close(); }
});

test('API 失败不回显 key，拒绝重定向和未完整结束的流', async () => {
  let stolen = false;
  const service = await endpoint(async (request, response) => {
    if (request.url?.startsWith('/stolen')) { stolen = true; response.end('bad'); return; }
    if (request.url?.startsWith('/redirect/')) { response.writeHead(302, { Location: `${service.url}/stolen` }); response.end(); return; }
    if (request.url?.startsWith('/error/')) { response.writeHead(401); response.end('fixture-secret-key'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"一半"}}]}\n\n');
  });
  try {
    const adapter = (route: string) => createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: `${service.url}/${route}` } }],
      apiKey: async () => 'fixture-secret-key', history: () => [] });
    await assert.rejects(adapter('error').execute(context()), error => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes('fixture-secret-key'));
    await assert.rejects(adapter('redirect').execute(context()), /连接失败/);
    assert.equal(stolen, false);
    await assert.rejects(adapter('partial').execute(context()), /完成前中断/);
  } finally { await service.close(); }
});

test('API 取消会终止读取流，不返回成功结果', async () => {
  let started!: () => void;
  const streaming = new Promise<void>(resolve => { started = resolve; });
  const service = await endpoint((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
    started();
  });
  try {
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: service.url } }],
      apiKey: async () => '', history: () => [] });
    const controller = new AbortController();
    const completion = adapter.execute(context({ signal: controller.signal }));
    const assertion = assert.rejects(completion, { name: 'AbortError' });
    await streaming; controller.abort(); await assertion;
  } finally { await service.close(); }
});

test('API 收到 DONE 后完成回复并关闭读取，不等待服务端断开连接', async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const service = await endpoint((_request, response) => {
    response.once('close', closed);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n');
    response.write('data: [DONE]\n\n');
  });
  try {
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: service.url } }],
      apiKey: async () => '', history: () => [] });
    assert.equal(await adapter.execute(context({ signal: AbortSignal.timeout(2000) })), '完成');
    await disconnected;
  } finally { await service.close(); }
});

test('API 总请求超时终止未完成的响应，不等待无限流', async () => {
  const timeout = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  let started!: () => void;
  const streaming = new Promise<void>(resolve => { started = resolve; });
  const service = await endpoint((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
    started();
  });
  try {
    AbortSignal.timeout = milliseconds => { assert.equal(milliseconds, 180_000); return timeout.signal; };
    const adapter = createApiModelAdapter({ models: () => [{ id: 'custom', modelId: 'deepseek-fixture', label: 'API', api: { baseUrl: service.url } }],
      apiKey: async () => '', history: () => [] });
    const assertion = assert.rejects(adapter.execute(context()), /模型 API 请求超时/);
    await streaming;
    timeout.abort(new DOMException('deadline', 'TimeoutError'));
    await assertion;
  } finally { AbortSignal.timeout = originalTimeout; await service.close(); }
});

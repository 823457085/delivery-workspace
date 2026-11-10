import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { ApiOperationDetail } from '../shared/interface-center.js';
import { apiDebugCurl, apiDebugLimits, prepareApiDebugRequest, type ApiDebugRequest } from '../shared/interface-center-debug.js';
import { executeApiDebug } from '../server/interface-center-debug.js';
import { debugBodyDraft, debugParameterFields, debugServerOptions } from '../src/features/interface-center/debugger-state.js';

const detail = (method = 'POST', path = '/echo/{id}', extra: Partial<ApiOperationDetail> = {}): ApiOperationDetail => ({
  key: `${method} ${path}`, method, path, summary: '原始 L708', description: '', tags: ['fixture'], deprecated: false,
  parameters: [], requestBody: null, responses: {}, security: [], servers: [], raw: {}, ...extra,
});
const input = (operation: ApiOperationDetail, baseUrl: string, extra: Partial<ApiDebugRequest> = {}): ApiDebugRequest => ({
  operationKey: operation.key, baseUrl, pathParameters: [{ name: 'id', value: 'order/中文 L708', enabled: true }],
  queryParameters: [], headers: [], auth: { kind: 'none' }, body: { kind: 'none' }, ...extra,
});
async function fixture() {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(entry);
    if (request.url === '/reset') { request.socket.destroy(); return; }
    if (request.url === '/slow') { setTimeout(() => { if (!response.destroyed) response.end('late'); }, 10_000).unref(); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/must-not-follow' }); response.end('L708 redirect'); return; }
    if (request.url === '/large') { response.setHeader('Content-Type', 'text/plain'); response.end(Buffer.alloc(apiDebugLimits.responseBytes + 700, 'x')); return; }
    if (request.url === '/binary') { response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.from([0, 255, 1, 254])); return; }
    if (request.url === '/text') { response.writeHead(422, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Original': 'L708' }); response.end('L708\n原始接口文案'); return; }
    response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'X-Original': 'L708', 'Set-Cookie': ['one=1', 'two=2'] });
    response.end(JSON.stringify(entry));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, server, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

test('接口调试通过真实 HTTP 发送契约路径、重复查询、原样 JSON 和 Basic 鉴权', async () => {
  const f = await fixture();
  try {
    const operation = detail();
    const body = '{\n  "label": "L708 中文"\n}';
    const result = await executeApiDebug(operation, input(operation, `${f.url}/api/`, { queryParameters: [
      { name: 'q', value: 'L708 中文 & /', enabled: true }, { name: 'q', value: 'second', enabled: true }, { name: 'disabled', value: 'omit', enabled: false }],
    headers: [{ name: 'X-Fixture', value: 'L708', enabled: true }], auth: { kind: 'basic', username: '用户', password: 'fixture:pass' }, body: { kind: 'json', text: body } }));
    assert.equal(result.method, 'POST'); assert.equal(result.status, 201); assert.equal(result.statusText, 'Created');
    assert.equal(result.bodyEncoding, 'utf8'); assert.equal(result.truncated, false); assert.ok(result.durationMs >= 0);
    const echoed = JSON.parse(result.body);
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.url, '/api/echo/order%2F%E4%B8%AD%E6%96%87%20L708?q=L708+%E4%B8%AD%E6%96%87+%26+%2F&q=second');
    assert.equal(echoed.body, body); assert.equal(echoed.headers['x-fixture'], 'L708');
    assert.equal(echoed.headers.authorization, `Basic ${Buffer.from('用户:fixture:pass').toString('base64')}`);
    assert.equal(echoed.headers['content-type'], 'application/json'); assert.equal(echoed.headers['accept-encoding'], 'identity');
    assert.equal(echoed.headers['content-length'], String(Buffer.byteLength(body)));
    assert.deepEqual(result.headers.filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value), ['one=1', 'two=2']);
    assert.equal(result.sizeBytes, Buffer.byteLength(result.body)); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('接口调试发送 Bearer、手动请求头、Raw 和表单请求体', async () => {
  const f = await fixture();
  try {
    const operation = detail('PUT', '/echo');
    const form = await executeApiDebug(operation, input(operation, f.url, { auth: { kind: 'bearer', token: 'fixture-token' },
      body: { kind: 'urlencoded', fields: [{ name: '原字段', value: 'L708 + &', enabled: true }, { name: '原字段', value: 'next', enabled: true }, { name: 'omit', value: 'no', enabled: false }] } }));
    const echoedForm = JSON.parse(form.body);
    assert.equal(echoedForm.headers.authorization, 'Bearer fixture-token');
    assert.equal(echoedForm.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(echoedForm.body, '%E5%8E%9F%E5%AD%97%E6%AE%B5=L708+%2B+%26&%E5%8E%9F%E5%AD%97%E6%AE%B5=next');
    const raw = await executeApiDebug(operation, input(operation, f.url, { headers: [{ name: 'Authorization', value: 'Custom fixture', enabled: true }], body: { kind: 'raw', text: '<value>L708</value>', contentType: 'application/xml' } }));
    const echoedRaw = JSON.parse(raw.body);
    assert.equal(echoedRaw.headers.authorization, 'Custom fixture'); assert.equal(echoedRaw.headers['content-type'], 'application/xml');
    assert.equal(echoedRaw.body, '<value>L708</value>');
  } finally { await f.close(); }
});

test('接口调试不跟随重定向，HTTP 错误响应和二进制原文仍可核对', async () => {
  const f = await fixture();
  try {
    for (const route of ['/redirect', '/text', '/binary']) {
      const operation = detail('GET', route), result = await executeApiDebug(operation, input(operation, f.url));
      if (route === '/redirect') {
        assert.equal(result.status, 302); assert.equal(result.body, 'L708 redirect');
        assert.equal(result.headers.find(header => header.name.toLowerCase() === 'location')?.value, '/must-not-follow');
      } else if (route === '/text') { assert.equal(result.status, 422); assert.equal(result.body, 'L708\n原始接口文案'); }
      else { assert.equal(result.bodyEncoding, 'base64'); assert.equal(result.body, Buffer.from([0, 255, 1, 254]).toString('base64')); }
    }
    assert.deepEqual(f.requests.map(request => request.url), ['/redirect', '/text', '/binary']);
  } finally { await f.close(); }
});

test('接口调试取消会中断真实连接，超时涵盖整个请求，预取消不出网', async () => {
  const f = await fixture();
  try {
    const operation = detail('GET', '/slow'), abort = new AbortController();
    const arrived = once(f.server, 'request');
    const pending = executeApiDebug(operation, input(operation, f.url), abort.signal);
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    const [, serverResponse] = await arrived as [http.IncomingMessage, http.ServerResponse];
    const closed = once(serverResponse, 'close'); abort.abort(); await rejected; await closed;
    const started = performance.now();
    await assert.rejects(executeApiDebug(operation, input(operation, f.url, { timeoutMs: 100 })), /请求超时/);
    assert.ok(performance.now() - started < 2000);
    const before = f.requests.length;
    await assert.rejects(executeApiDebug(operation, input(operation, f.url), abort.signal), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(f.requests.length, before);
  } finally { await f.close(); }
});

test('接口调试响应只保留前 2 MB 并明确标记截断', async () => {
  const f = await fixture();
  try {
    const operation = detail('GET', '/large'), result = await executeApiDebug(operation, input(operation, f.url));
    assert.equal(result.sizeBytes, apiDebugLimits.responseBytes); assert.equal(result.body.length, apiDebugLimits.responseBytes); assert.equal(result.truncated, true);
  } finally { await f.close(); }
});

test('接口调试拒绝方法覆盖、非 HTTP 地址、路径逃逸、请求头注入和超限内容', async () => {
  const f = await fixture();
  try {
    const operation = detail(), normal = input(operation, f.url);
    const cases: unknown[] = [
      { ...normal, method: 'DELETE' }, { ...normal, operationKey: 'DELETE /other' }, { ...normal, baseUrl: 'file:///tmp/file' },
      { ...normal, baseUrl: 'http://name:password@127.0.0.1' }, { ...normal, baseUrl: `${f.url}?secret=x` },
      { ...normal, baseUrl: `${f.url}\n` }, { ...normal, baseUrl: `${f.url}\\other` },
      { ...normal, pathParameters: [{ name: 'id', value: '..', enabled: true }] }, { ...normal, pathParameters: [] },
      { ...normal, headers: [{ name: 'X-Test', value: 'value\r\nInjected: yes', enabled: true }] },
      { ...normal, headers: [{ name: 'Host', value: 'other.host', enabled: true }] },
      { ...normal, headers: [{ name: 'Content-Length', value: '999', enabled: true }] },
      { ...normal, headers: [{ name: 'Authorization', value: 'manual', enabled: true }], auth: { kind: 'bearer', token: 'also-token' } },
      { ...normal, body: { kind: 'json', text: '{bad}' } }, { ...normal, body: { kind: 'raw', text: '文'.repeat(400_000), contentType: 'text/plain' } },
      { ...normal, timeoutMs: 90_000 },
    ];
    for (const invalid of cases) await assert.rejects(executeApiDebug(operation, invalid));
    assert.equal(f.requests.length, 0, '无效调试输入不能发送网络请求');
    const get = detail('GET', '/echo');
    await assert.rejects(executeApiDebug(get, input(get, f.url, { body: { kind: 'json', text: '{}' } })), /不发送请求体/);
  } finally { await f.close(); }
});

test('接口调试允许显式关闭必填 Query、Header 和 Body 以核对真实错误响应', () => {
  const operation = detail('POST', '/echo', { parameters: [{ in: 'query', name: 'L708', required: true }, { in: 'header', name: 'X-Required', required: true }], requestBody: { required: true } });
  const request = input(operation, 'http://127.0.0.1');
  request.queryParameters.push({ name: 'L708', value: '0', enabled: false });
  request.headers.push({ name: 'x-required', value: 'L709', enabled: false });
  const prepared = prepareApiDebugRequest(operation, request);
  assert.equal(prepared.url, 'http://127.0.0.1/echo'); assert.equal(prepared.headers.length, 0); assert.equal(prepared.body, undefined);
});

test('契约中的示例地址不作为调试候选，手动输入同一地址也不会发送请求', async () => {
  const f = await fixture();
  try {
    const operation = detail('POST', '/merchant-app/v1/auth/login', { servers: [
      { url: 'https://{bffDomain}', variables: { bffDomain: { default: 'api.example.com' } } },
      { url: 'https://{unknown}' },
      { url: f.url, description: '联调服务' },
    ] });
    assert.deepEqual(debugServerOptions(operation), [{ url: f.url, description: '联调服务' }]);
    for (const url of ['https://api.example.com', 'https://EXAMPLE.ORG.', 'https://backend.example']) {
      await assert.rejects(executeApiDebug(operation, input(operation, url)), /服务地址是文档示例/);
    }
    await executeApiDebug(operation, input(operation, f.url));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.url, operation.path);
  } finally { await f.close(); }
});

test('调试拒绝已启用的空必填字段，保留契约允许的空值和手动缺参测试', async () => {
  const f = await fixture();
  try {
    const operation = detail('POST', '/echo', {
      parameters: [
        { in: 'query', name: 'countryCode', required: true },
        { in: 'query', name: 'flag', required: true, allowEmptyValue: true },
        { in: 'header', name: 'Authorization', required: true },
      ],
      requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { required: ['label'] } } } },
    });
    const request = input(operation, f.url, {
      queryParameters: [{ name: 'countryCode', value: ' ', enabled: true }, { name: 'flag', value: '', enabled: true }],
      headers: [{ name: 'authorization', value: '', enabled: true }],
      body: { kind: 'urlencoded', fields: [{ name: 'label', value: '', enabled: true }] },
    });
    await assert.rejects(executeApiDebug(operation, request), /必填查询参数.*countryCode/);
    request.queryParameters[0].value = '0';
    await assert.rejects(executeApiDebug(operation, request), /必填请求头.*authorization/);
    request.auth = { kind: 'bearer', token: 'fixture-token' };
    await assert.rejects(executeApiDebug(operation, request), /必填表单字段.*label/);
    assert.equal(f.requests.length, 0);
    request.body.fields[0].enabled = false;
    const result = await executeApiDebug(operation, request);
    const received = JSON.parse(result.body);
    assert.equal(received.url, '/echo?countryCode=0&flag=');
    assert.equal(received.headers.authorization, 'Bearer fixture-token');
    assert.equal(received.body, '');
  } finally { await f.close(); }
});

test('调试区分 TLS 握手重置和 HTTP 响应前断开', async () => {
  const f = await fixture();
  const tlsReset = net.createServer(socket => socket.once('data', () => socket.destroy()));
  tlsReset.listen(0, '127.0.0.1');
  await once(tlsReset, 'listening');
  try {
    const operation = detail('GET', '/reset');
    await assert.rejects(executeApiDebug(operation, input(operation, f.url)), /HTTP 响应前中断.*ECONNRESET/);
    const url = `https://127.0.0.1:${(tlsReset.address() as net.AddressInfo).port}`;
    await assert.rejects(executeApiDebug(operation, input(operation, url)), /TLS 握手阶段被重置.*ECONNRESET/);
  } finally {
    await f.close();
    await new Promise<void>(resolve => tlsReset.close(() => resolve()));
  }
});

test('JSON 调试按契约发送供应商媒体类型，显式请求头仍可覆盖', async () => {
  const f = await fixture();
  try {
    const mediaType = 'application/vnd.fixture+json';
    const operation = detail('POST', '/echo', { requestBody: { content: { [mediaType]: {} } } });
    const request = input(operation, f.url, { body: { kind: 'json', text: '{"label":"L708"}' } });
    assert.equal(debugBodyDraft(operation).kind, 'json');
    assert.equal(JSON.parse((await executeApiDebug(operation, request)).body).headers['content-type'], mediaType);
    request.headers.push({ name: 'Content-Type', value: 'application/json', enabled: true });
    assert.equal(JSON.parse((await executeApiDebug(operation, request)).body).headers['content-type'], 'application/json');
  } finally { await f.close(); }
});

test('cURL 复制只生成转义文本，和请求预览使用相同目标及原文', () => {
  const operation = detail('POST', '/echo'), request = input(operation, 'http://127.0.0.1', { headers: [{ name: 'X-Empty', value: '', enabled: true }],
    body: { kind: 'raw', text: "single'quote\n$(no-execution)", contentType: 'text/plain' } });
  const prepared = prepareApiDebugRequest(operation, request), curl = apiDebugCurl(prepared);
  assert.match(curl, /--request 'POST'/); assert.ok(curl.includes(`--url '${prepared.url}'`));
  assert.ok(curl.includes("--data-binary 'single'\\''quote\n$(no-execution)'"));
  assert.ok(curl.includes("--header 'X-Empty;'")); assert.ok(curl.includes(' \\\n  ')); assert.ok(!curl.includes('--location'));
});

test('调试默认字段和服务变量保留契约名称，凭据示例不填入鉴权字段', () => {
  const operation = detail('POST', '/echo/{L708}', { parameters: [{ in: 'query', name: 'L709', required: true, example: 0 },
    { in: 'header', name: 'Authorization', example: 'Bearer sensitive-example' }],
  servers: [{ url: 'https://{host}/v1', variables: { host: { default: 'example.invalid' } }, description: 'L710' }],
  requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { password: { example: 'hidden' }, label: { default: 'L711' } }, required: ['password', 'label'] } } } } });
  assert.equal(debugParameterFields(operation, 'path')[0].name, 'L708');
  assert.equal(debugParameterFields(operation, 'query')[0].value, '0'); assert.equal(debugParameterFields(operation, 'header')[0].value, '');
  assert.deepEqual(debugServerOptions(operation), [{ url: 'https://example.invalid/v1', description: 'L710' }]);
  const body = debugBodyDraft(operation); assert.equal(body.kind, 'urlencoded'); assert.equal(body.fields[0].value, ''); assert.equal(body.fields[1].value, 'L711');
});

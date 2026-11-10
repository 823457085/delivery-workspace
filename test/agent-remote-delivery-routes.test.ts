import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgentGroupChatRoutes } from '../server/agent-group-chat-routes.js';

test('群聊产物下载路由只读返回原始附件，拒绝额外路径参数并保留写入来源保护', async () => {
  const roomId = randomUUID(), sha256 = 'a'.repeat(64), body = Buffer.from([0x50, 0x4b, 0x00, 0xff]);
  const downloads: unknown[] = [];
  const json = (response: import('node:http').ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const route = createAgentGroupChatRoutes({} as never, { json, body: async () => ({}), port: 5288 }, {
    preview: async () => ({}), submit: async () => { assert.fail('下载不调用提交'); },
    downloadArtifact: async (...args) => { downloads.push(args); return { name: '多语言导入.xlsx', data: body }; },
  });
  const server = createServer(async (request, response) => {
    try {
      if (!await route(request, response, new URL(request.url!, 'http://localhost'))) json(response, 404, {});
    } catch (error) { json(response, 400, { message: error instanceof Error ? error.message : 'invalid request' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/agent-runtimes/group-chat/rooms/${roomId}/artifacts/i18n-0?sha256=${sha256}`;
  try {
    const downloaded = await fetch(url);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);
    assert.equal(downloaded.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(downloaded.headers.get('content-length'), String(body.length));
    assert.equal(downloaded.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('多语言导入.xlsx')}`);
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(downloads, [[roomId, 'i18n-0', sha256]]);
    assert.equal((await fetch(url + '&path=/tmp/secret.xlsx')).status, 400);
    assert.equal((await fetch(url.replace(sha256, 'wrong'))).status, 400);
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal(downloads.length, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

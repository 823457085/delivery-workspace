import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../src/shared/api';

test('工作台拒绝将上游断线返回的 HTTP 200 空态当作真实零记录，读取不发送写操作', async () => {
  const original = globalThis.fetch;
  const requests: { input: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'X-Delivery-Source': 'Delivery-Offline' } });
  };
  try {
    await assert.rejects(readSource('automation', {}, undefined, true), /交付后端不可用/);
    assert.deepEqual(await readSource('automation'), { jobs: [] });
    assert.ok(requests.every(request => !request.init?.body && !request.init?.method));
  } finally { globalThis.fetch = original; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createJiraIssueService, createJiraIssueRoute } from '../server/jira-issue.js';
import { jiraAttachmentMediaType } from '../shared/jira-attachment-media.js';
import { maxJiraAttachmentBytes } from '../server/jira-attachment-media.js';

test('图片和视频类型识别兼容通用 MIME，不把 SVG/HTML 当作可预览图片', () => {
  assert.equal(jiraAttachmentMediaType({ filename: '截图.PNG', mimeType: 'application/octet-stream' }), 'image/png');
  assert.equal(jiraAttachmentMediaType({ filename: 'demo', mimeType: 'video/mp4' }), 'video/mp4');
  assert.equal(jiraAttachmentMediaType({ filename: 'demo.MOV', mimeType: '' }), 'video/quicktime');
  assert.equal(jiraAttachmentMediaType({ filename: 'evil.png', mimeType: 'text/html' }), undefined);
  assert.equal(jiraAttachmentMediaType({ filename: 'evil.svg', mimeType: 'image/svg+xml' }), undefined);
});

test('鉴权附件路由支持预览、下载和单段视频请求，保留归属及同源保护', async t => {
  const bytes = Buffer.from('0123456789');
  let contentRequests = 0;
  let receivedRange: string | undefined;
  const files = [
    { id: '1', filename: '图片.png', mimeType: 'image/png', size: bytes.length },
    { id: '2', filename: '视频.mp4', mimeType: 'video/mp4', size: bytes.length },
    { id: '3', filename: 'active.svg', mimeType: 'image/svg+xml', size: bytes.length },
    { id: '4', filename: 'large.mp4', mimeType: 'video/mp4', size: maxJiraAttachmentBytes + 1 },
  ];
  const service = createJiraIssueService(async (resource, _method, _body, options) => {
    if (resource.startsWith('issue/TEST-1?')) return Response.json({ fields: { attachment: files } });
    assert.match(resource, /^attachment\/content\/\d+$/);
    contentRequests++;receivedRange = options?.range;
    if (options?.range === 'bytes=99-') return new Response(null, { status: 416, headers: { 'content-range': 'bytes */10' } });
    if (options?.range === 'bytes=2-5') return new Response(bytes.subarray(2, 6), { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' } });
    return new Response(bytes, { headers: { 'content-length': '10', 'accept-ranges': 'bytes' } });
  });
  const route = createJiraIssueRoute(service);
  const server = http.createServer((req, res) => void route(req, res, (server.address() as import('node:net').AddressInfo).port));
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(() => { server.closeAllConnections();server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/jira/issues/TEST-1/attachments/`;
  const image = await fetch(base + '1?inline=1');
  assert.equal(image.status, 200);assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition')!, /^inline;/);assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await image.text(), '0123456789');
  const download = await fetch(base + '1');assert.match(download.headers.get('content-disposition')!, /^attachment;/);assert.equal(download.headers.get('content-type'), 'application/octet-stream');await download.text();
  const video = await fetch(base + '2?inline=1', { headers: { Range: 'bytes=2-5' } });
  assert.equal(video.status, 206);assert.equal(receivedRange, 'bytes=2-5');assert.equal(video.headers.get('content-range'), 'bytes 2-5/10');assert.equal(video.headers.get('content-type'), 'video/mp4');assert.equal(await video.text(), '2345');
  const unsatisfied = await fetch(base + '2?inline=1', { headers: { Range: 'bytes=99-' } });assert.equal(unsatisfied.status, 416);assert.equal(unsatisfied.headers.get('content-range'), 'bytes */10');await unsatisfied.text();
  for (const range of ['bytes=0-1,4-5', 'bytes=8-2', 'bytes=-0', 'bytes=9007199254740992-']) {
    const before = contentRequests;const result = await fetch(base + '2?inline=1', { headers: { Range: range } });assert.equal(result.status, 416);await result.text();assert.equal(contentRequests, before);
  }
  assert.equal((await fetch(base + '3?inline=1')).status, 415);
  const before = contentRequests;
  assert.equal((await fetch(base + '4?inline=1')).status, 413);
  assert.equal((await fetch(base + '99?inline=1')).status, 404);
  assert.equal((await fetch(base + '1?inline=1', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(contentRequests, before);
});

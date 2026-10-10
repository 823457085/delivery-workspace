import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentAttachmentStore } from '../server/agent-attachments.js';

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpQAAAABJRU5ErkJggg==';

test('Agent 图片附件验证真实类型、隐藏本地路径并支持完整清理', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-attachments-test-'));
  const store = await createAgentAttachmentStore(directory);
  try {
    const uploaded = await store.upload({ name: '../截图.png', mimeType: 'image/png', data: onePixelPng });
    assert.equal(uploaded.name, '..截图.png');
    assert.equal(uploaded.mimeType, 'image/png');
    assert.match(uploaded.url, /^\/api\/agent-runtimes\/attachments\/[0-9a-f-]{36}$/);
    assert.equal(uploaded.url.includes(directory), false);

    const [resolved] = await store.resolve([uploaded.id]);
    assert.equal(resolved.attachment.id, uploaded.id);
    assert.equal((await fs.stat(resolved.filePath)).isFile(), true);
    assert.equal((await store.read(uploaded.id)).content.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    await store.remove([uploaded.id]);
    await assert.rejects(store.read(uploaded.id), /ENOENT/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Agent 图片附件拒绝声明类型与内容不一致的数据', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-attachments-spoof-test-'));
  const store = await createAgentAttachmentStore(directory);
  try {
    await assert.rejects(store.upload({ name: '伪装.png', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') }),
      /图片内容与文件类型不一致/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Agent 会话支持 XLSX 附件并拒绝伪装的表格文件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-xlsx-test-'));
  const store = await createAgentAttachmentStore(directory);
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  try {
    const data = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).toString('base64');
    const uploaded = await store.upload({ name: '数据.xlsx', mimeType, data });
    assert.equal(uploaded.name, '数据.xlsx');
    assert.equal(uploaded.mimeType, mimeType);
    assert.match((await store.resolve([uploaded.id]))[0].filePath, /\.xlsx$/);
    assert.deepEqual((await store.read(uploaded.id)).content, Buffer.from(data, 'base64'));
    await assert.rejects(store.upload({ name: '伪装.xlsx', mimeType, data: Buffer.from('not a workbook').toString('base64') }),
      /附件内容与文件类型不一致/);
    await assert.rejects(store.upload({ name: '伪装.zip', mimeType, data }), /附件内容与文件类型不一致/);
    await store.remove([uploaded.id]);
    await assert.rejects(store.read(uploaded.id), /ENOENT/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Agent 会话也支持非 XLSX 文件，并保留文件扩展名供 Agent 读取', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-generic-file-test-'));
  const store = await createAgentAttachmentStore(directory);
  try {
    const data = Buffer.from('report content').toString('base64');
    const uploaded = await store.upload({ name: 'report.txt', mimeType: 'text/plain', data });
    assert.equal(uploaded.mimeType, 'text/plain');
    assert.match((await store.resolve([uploaded.id]))[0].filePath, /\.txt$/);
    assert.equal((await store.read(uploaded.id)).content.toString(), 'report content');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

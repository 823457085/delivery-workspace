import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareClaudeInput } from '../server/claude-input.js';

test('Claude 图片以 stream-json 内联传入，不创建附件目录', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.claude-input-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const paths = extensions.map(extension => path.join(root, `image.${extension}`));
  for (const imagePath of paths) await fs.writeFile(imagePath, Buffer.from([0, 1, 2, 255]));
  const directory = path.join(root, 'private', 'run');
  const result = await prepareClaudeInput('查看图片\n保留换行', paths, [], directory);
  const message = JSON.parse(result.stdin);
  assert.equal(result.stdin.endsWith('\n'), true);
  assert.equal(result.stdin.trim().includes('\n'), false);
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  assert.equal(message.parent_tool_use_id, null);
  assert.deepEqual(message.message.content[0], { type: 'text', text: '查看图片\n保留换行' });
  assert.deepEqual(message.message.content.slice(1).map((block: { source: { media_type: string; data: string } }) => block.source),
    ['image/png', 'image/jpeg', 'image/jpeg', 'image/gif', 'image/webp']
      .map(mediaType => ({ type: 'base64', media_type: mediaType, data: 'AAEC/w==' })));
  assert.deepEqual(result.fileAttachments, []);
  assert.deepEqual(result.readOnlyDirectories, []);
  await assert.rejects(fs.stat(path.dirname(directory)), { code: 'ENOENT' });
});

test('Claude 附件只复制本轮文件到私有目录，恶意名称不能写入用户工作区', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.claude-input-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'user-workspace');
  const uploads = path.join(root, 'uploads');
  await fs.mkdir(workspace);
  await fs.mkdir(uploads);
  await fs.writeFile(path.join(workspace, 'keep.txt'), 'unchanged');
  await fs.writeFile(path.join(uploads, 'first.XLSX'), 'workbook');
  await fs.writeFile(path.join(uploads, 'second.unsafe$'), 'data');
  await fs.writeFile(path.join(uploads, 'other-session.txt'), 'not selected');
  const directory = path.join(root, 'runtime', 'claude-attachments', 'run-1');
  const name = '../../user-workspace/overwrite.txt\n"injected"';
  const result = await prepareClaudeInput('分析附件', [], [
    { name, path: path.join(uploads, 'first.XLSX') },
    { name: 'duplicate.xlsx', path: path.join(uploads, 'second.unsafe$') },
  ], directory);
  assert.deepEqual(result.fileAttachments, [
    { name, path: path.join(directory, 'attachment-1.xlsx') },
    { name: 'duplicate.xlsx', path: path.join(directory, 'attachment-2.bin') },
  ]);
  assert.deepEqual(result.readOnlyDirectories, [directory]);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['attachment-1.xlsx', 'attachment-2.bin']);
  assert.equal(await fs.readFile(result.fileAttachments[0].path, 'utf8'), 'workbook');
  assert.equal(await fs.readFile(result.fileAttachments[1].path, 'utf8'), 'data');
  assert.deepEqual(await fs.readdir(workspace), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'unchanged');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const file of result.fileAttachments) assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600);
  const text = JSON.parse(result.stdin).message.content[0].text;
  assert.equal(text.includes(`${JSON.stringify(name)}：${JSON.stringify(result.fileAttachments[0].path)}`), true);
  assert.equal(text.includes(uploads), false);
  assert.equal(text.includes('other-session'), false);
});

test('Claude 拒绝复用已有目录，保留其他轮次文件', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.claude-input-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  await fs.writeFile(source, 'selected');
  const directory = path.join(root, 'existing');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'old.txt'), 'old session');
  await assert.rejects(prepareClaudeInput('读取', [], [{ name: 'source.txt', path: source }], directory), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(directory), ['old.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'old.txt'), 'utf8'), 'old session');
});

test('Claude 附件复制失败只清理自己创建的目录', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.claude-input-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  await fs.writeFile(source, 'selected');
  const directory = path.join(root, 'runtime', 'failed-run');
  await assert.rejects(prepareClaudeInput('读取', [], [
    { name: 'source.txt', path: source }, { name: 'missing.txt', path: path.join(root, 'missing.txt') },
  ], directory), { code: 'ENOENT' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(source, 'utf8'), 'selected');
});

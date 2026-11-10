import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProjectCode, readProjectGitSnapshot, saveProjectCode } from '../server/project-git.js';
import { hasConflictMarkers, parseConflictBlocks, resolveConflictBlock } from '../shared/project-code.js';

const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
async function fixture(t: TestContext) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-code-editor-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repo'); await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Editor Fixture');
  await git(repo, 'config', 'user.email', 'fixture@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  const write = (file: string, content: string | Buffer) => fs.writeFile(path.join(repo, file), content);
  await write('value.txt', 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', '初始化编辑验证仓库');
  const save = async (content: string, extra: Record<string, unknown> = {}) => saveProjectCode({
    path: repo, file: 'value.txt', revision: (await readProjectCode(repo, 'value.txt')).revision, content, ...extra,
  });
  return { temporary, repo, write, save };
}

test('逐块处理 CRLF、多字节字符、diff3 和自定义标记宽度，保留块外内容', () => {
  const input = '开头😀\r\n<<<<<<< HEAD\r\n当前\r\n||||||| base\r\n基础\r\n=======\r\n传入\r\n>>>>>>> feature\r\n中间\r\n<<<<<<<<< HEAD\r\n左\r\n=========\r\n右\r\n>>>>>>>>> other\r\n结尾';
  const blocks = parseConflictBlocks(input);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(block => [block.startLine, block.endLine]), [[2, 8], [10, 14]]);
  assert.equal(blocks[0].base, '基础\r\n');
  assert.equal(resolveConflictBlock(input, blocks[0], 'ours').startsWith('开头😀\r\n当前\r\n中间'), true);
  assert.equal(resolveConflictBlock(input, blocks[0], 'theirs').startsWith('开头😀\r\n传入\r\n中间'), true);
  const first = resolveConflictBlock(input, blocks[0], 'both');
  const resolved = resolveConflictBlock(first, parseConflictBlocks(first)[0], 'theirs');
  assert.equal(resolved, '开头😀\r\n当前\r\n传入\r\n中间\r\n右\r\n结尾');
  assert.equal(hasConflictMarkers(resolved), false);
  assert.equal(parseConflictBlocks('<<<<<<< HEAD\nunfinished\n').length, 0);
  assert.equal(hasConflictMarkers('<<<<<<< HEAD\nunfinished\n'), true);
  assert.equal(parseConflictBlocks('<<<<<<< HEAD\n=======\n>>>>>>> incoming').length, 1);
});

test('冲突行号不受 BOM 或 Git 混合换行影响，解决首行冲突时保留 BOM', () => {
  const content = '\ufeff<<<<<<< HEAD\n当前\r\n=======\n传入\r\n>>>>>>> incoming\n尾行\r\n';
  const [block] = parseConflictBlocks(content);
  assert.equal(block.start, 1);
  assert.deepEqual([block.startLine, block.endLine], [1, 5]);
  assert.equal(resolveConflictBlock(content, block, 'both'), '\ufeff当前\r\n传入\r\n尾行\r\n');
});

test('保存原路径与权限、BOM、CRLF、空文件，不自动暂存或提交', async t => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.repo, 'value.txt'), 0o755);
  await f.save('\ufeff中文\r\nsecond\r\n');
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), '\ufeff中文\r\nsecond\r\n');
  assert.equal((await fs.stat(path.join(f.repo, 'value.txt'))).mode & 0o777, 0o755);
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.staged, 0);
  await f.save('大文件\n'.repeat(40000));
  assert.equal((await readProjectCode(f.repo, 'value.txt')).content, '大文件\n'.repeat(40000));
  await f.save('');
  assert.equal((await fs.stat(path.join(f.repo, 'value.txt'))).size, 0);
  assert.equal((await git(f.repo, 'log', '--oneline')).trim().split('\n').length, 1);
});

test('磁盘被其他会话修改或切换同内容分支时拒绝旧版本，保留最新内容', async t => {
  const f = await fixture(t);
  const first = await readProjectCode(f.repo, 'value.txt');
  await f.write('value.txt', 'other session\n');
  await assert.rejects(f.save('overwrite', { revision: first.revision }), /文件或分支已变化/);
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'other session\n');
  const second = await readProjectCode(f.repo, 'value.txt');
  await git(f.repo, 'switch', '-c', 'feature/same-content');
  await assert.rejects(f.save('overwrite', { revision: second.revision }), /文件或分支已变化/);
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'other session\n');
});

test('拒绝私密文件、目录穿越、符号链接、二进制和无效 UTF-8，不写入其他路径', async t => {
  const f = await fixture(t);
  await f.write('.env.local', 'fixture-secret');
  await f.write('binary.dat', Buffer.from([0, 1, 2]));
  await f.write('legacy.txt', Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(f.temporary, 'outside.txt'), 'outside');
  await fs.symlink(path.join(f.repo, 'value.txt'), path.join(f.repo, 'internal-link'));
  await fs.symlink(path.join(f.temporary, 'outside.txt'), path.join(f.repo, 'external-link'));
  for (const file of ['.env.local', '../outside.txt', 'external-link', 'binary.dat', 'legacy.txt', '.git/config']) {
    await assert.rejects(saveProjectCode({ path: f.repo, file, revision: 'fake', content: 'overwrite' }));
  }
  const linked = await readProjectCode(f.repo, 'internal-link');
  assert.equal(linked.editable, false);
  await assert.rejects(saveProjectCode({ path: f.repo, file: 'internal-link', revision: linked.revision, content: 'overwrite' }), /符号链接/);
  await assert.rejects(f.save('a'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.equal(await fs.readFile(path.join(f.temporary, 'outside.txt'), 'utf8'), 'outside');
  assert.equal(await fs.readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'base\n');
});

test('真实合并冲突：保存进度仍保留冲突，残留标记不能标记解决，只暂存解决后的目标文件', async t => {
  const f = await fixture(t);
  await git(f.repo, 'switch', '-c', 'feature/incoming');
  await f.write('value.txt', 'incoming\n'); await git(f.repo, 'commit', '-qam', '传入改动');
  await git(f.repo, 'switch', 'main');
  await f.write('value.txt', 'current\n'); await git(f.repo, 'commit', '-qam', '当前改动');
  await assert.rejects(git(f.repo, 'merge', 'feature/incoming'));
  const code = await readProjectCode(f.repo, 'value.txt'); assert.equal(code.conflict, true);
  await f.write('unrelated.txt', 'keep unstaged\n');
  await f.save(code.content.replace('current', 'edited current'));
  assert.equal((await readProjectGitSnapshot(f.repo)).counts.conflicts, 1);
  await assert.rejects(f.save('<<<<<<< HEAD\nunfinished\n', { resolve: true }), /仍有冲突标记/);
  const current = await readProjectCode(f.repo, 'value.txt');
  const resolved = resolveConflictBlock(current.content, parseConflictBlocks(current.content)[0], 'both');
  const saved = await f.save(resolved, { resolve: true });
  assert.equal(saved.code.conflict, false);
  assert.equal(saved.code.content, 'edited current\nincoming\n');
  assert.equal(await git(f.repo, 'ls-files', '-u'), '');
  assert.equal((await git(f.repo, 'diff', '--cached', '--name-only')).trim(), 'value.txt');
  assert.equal((await readProjectGitSnapshot(f.repo)).mergeInProgress, true);
  assert.equal(await fs.readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'keep unstaged\n');
});

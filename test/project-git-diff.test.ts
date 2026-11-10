import test from 'node:test';
import assert from 'node:assert/strict';
import { presentGitDiff, splitGitDiff } from '../src/features/project-inventory/git-diff.js';

test('统一差异按每个 hunk 的真实起点展示新旧行号，不把元数据计为增删行', () => {
  const patch = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -20,2 +20,3 @@\n same\n-old\n+new\n+extra\n@@ -60 +61 @@\n-last\n+next\n';
  const result = presentGitDiff(patch);
  assert.equal(result.added, 3); assert.equal(result.removed, 2);
  assert.equal(result.firstChangedLine, 21);
  assert.deepEqual(result.lines.filter(line => ['add', 'remove', 'context'].includes(line.kind)).map(line => [line.oldLine, line.newLine]),
    [[20, 20], [21, null], [null, 21], [null, 22], [60, null], [null, 61]]);
  assert.equal(result.lines[2]!.kind, 'meta');
});

test('代码本身以加减号开头、空白行及未换行标记保留正文并正确计数', () => {
  const result = presentGitDiff('@@ -1,2 +1,2 @@\n---old\n+++new\n+\n\\ No newline at end of file\n');
  assert.deepEqual(result.lines.slice(1).map(line => [line.kind, line.content]), [
    ['remove', '--old'], ['add', '++new'], ['add', ''], ['meta', '\\ No newline at end of file'],
  ]);
  assert.equal(result.added, 2); assert.equal(result.removed, 1);
});

test('未跟踪文件使用从 1 开始的新行号，二进制或非差异文本按原文展示', () => {
  const untracked = presentGitDiff('+first\n+\n+<script>literal</script>');
  assert.deepEqual(untracked.lines.map(line => line.newLine), [1, 2, 3]);
  assert.equal(untracked.lines[2]!.content, '<script>literal</script>');
  assert.equal(untracked.firstChangedLine, 1);
  const binary = 'Binary files a/image.png and b/image.png differ';
  assert.equal(presentGitDiff(binary).lines[0]!.content, binary);
  assert.equal(presentGitDiff(binary).firstChangedLine, undefined);
  assert.equal(presentGitDiff('').lines.length, 0);
});

test('改动定位跳过 hunk 上下文，纯删除定位到新文件中相邻的有效行', () => {
  assert.equal(presentGitDiff('@@ -100,3 +100,4 @@\n context\n next context\n+added\n end').firstChangedLine, 102);
  assert.equal(presentGitDiff('@@ -50,3 +50,2 @@\n context\n-deleted\n tail').firstChangedLine, 51);
  assert.equal(presentGitDiff('@@ -1 +0,0 @@\n-deleted').firstChangedLine, 1);
});

test('左右对比在各改动段内对齐替换和上下文，保留空侧与文件末尾标记', () => {
  const patch = [
    '@@ -10,4 +12,4 @@', ' same', '-old', '+new', '+extra', ' next', '-deleted',
    '@@ -60 +60 @@', '-old end', '\\ No newline at end of file', '+new end',
  ].join('\n');
  const rows = splitGitDiff(presentGitDiff(patch).lines);
  assert.deepEqual(rows.map(row => 'info' in row ? row.info.content : [
    row.old?.line.oldLine ?? null, row.next?.line.newLine ?? null,
    row.old?.line.content ?? null, row.next?.line.content ?? null,
  ]), [
    '@@ -10,4 +12,4 @@', [10, 12, 'same', 'same'], [11, 13, 'old', 'new'],
    [null, 14, null, 'extra'], [12, 15, 'next', 'next'], [13, null, 'deleted', null],
    '@@ -60 +60 @@', [60, 60, 'old end', 'new end'],
  ]);
  const last = rows.at(-1);
  assert.ok(last && !('info' in last));
  assert.equal(last.old?.note, '\\ No newline at end of file');
  assert.equal(last.next?.note, undefined);
});

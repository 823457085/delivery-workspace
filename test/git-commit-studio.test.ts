import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeCommitMessage,
  applyConventionalPrefix,
  detectConventionalType,
  extractDiffHunkIndices,
  splitGitFilePath,
} from '../src/features/project-inventory/git-commit-studio.js';
import { stripMarkdownToPlainText } from '../src/features/agent-workbench/conversation-outline.js';

test('Conventional Commit 前缀支持插入、平滑替换、保留 scope/多行正文与二次点击取消', () => {
  assert.equal(applyConventionalPrefix('', 'feat'), 'feat: ');
  assert.equal(applyConventionalPrefix('新增接口契约抽屉', 'feat'), 'feat: 新增接口契约抽屉');
  assert.equal(detectConventionalType('feat: 新增接口契约抽屉'), 'feat');

  const swapped = applyConventionalPrefix('feat(ui): 新增抽屉\n\n- 补充 cURL 预览', 'fix');
  assert.equal(swapped, 'fix(ui): 新增抽屉\n\n- 补充 cURL 预览');
  assert.equal(detectConventionalType(swapped), 'fix');

  const toggledOff = applyConventionalPrefix('fix(ui): 新增抽屉\n\n- 补充 cURL 预览', 'fix');
  assert.equal(toggledOff, '新增抽屉\n\n- 补充 cURL 预览');
  assert.equal(detectConventionalType(toggledOff), '');
});

test('提交标题长度标尺遵循 GitHub Desktop / GitButler 50/72 字符阈值（按 Unicode 码点计数）', () => {
  assert.deepEqual(analyzeCommitMessage(''), { subjectLength: 0, hasBody: false, tone: 'idle' });
  assert.deepEqual(analyzeCommitMessage('feat: 支持多角色群聊筛选\n\n详细说明'), {
    subjectLength: 15,
    hasBody: true,
    tone: 'good',
  });
  assert.equal(analyzeCommitMessage('a'.repeat(60)).tone, 'ok');
  assert.equal(analyzeCommitMessage('a'.repeat(75)).tone, 'warn');
});

test('Git 路径文件名优先拆分与 Diff Hunk 锚点提取准确处理嵌套目录与目录后缀', () => {
  assert.deepEqual(splitGitFilePath('src/features/project-inventory/ProjectGitDrawer.vue'), {
    base: 'ProjectGitDrawer.vue',
    dir: 'src/features/project-inventory',
  });
  assert.deepEqual(splitGitFilePath('README.md'), { base: 'README.md', dir: '' });
  assert.deepEqual(splitGitFilePath('dist/assets/'), { base: 'assets/', dir: 'dist' });

  const hunks = extractDiffHunkIndices([
    { kind: 'meta', content: '--- a/file.ts' },
    { kind: 'hunk', content: '@@ -10,4 +10,6 @@ export function a()' },
    { kind: 'add', content: '+  return 1;' },
    { kind: 'hunk', content: '@@ -42,3 +44,5 @@ export function b()' },
  ]);
  assert.deepEqual(hunks, [
    { lineIndex: 1, header: '@@ -10,4 +10,6 @@ export function a()' },
    { lineIndex: 3, header: '@@ -42,3 +44,5 @@ export function b()' },
  ]);
});

test('群聊成员汇报纯文本提取保留代码块内容并剥离 Markdown 标记', () => {
  const md = '### 架构结论\n\n> 引用上下文\n\n已检查 **3 处** `[接口](http://localhost:5288)`：\n\n```ts\nconst ok = true;\n```';
  assert.equal(
    stripMarkdownToPlainText(md),
    '架构结论\n\n引用上下文\n\n已检查 3 处 接口：\n\nconst ok = true;',
  );
});

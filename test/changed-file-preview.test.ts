import test from 'node:test';
import assert from 'node:assert/strict';
import { canPreviewMarkdown, changedFileCopyText, resolveChangedFileViewMode } from '../src/features/agent-workbench/changed-file-preview.js';

const preview = {
  path: '/workspace/README.md', status: 'generated', binary: false,
  content: '# 任务工具\n\n- 新增\n- 查询\n', patch: '+# 任务工具\n+\n+- 新增\n+- 查询\n',
};

test('Markdown 文件识别兼容扩展名大小写和常见别名，仅使用文件正文', () => {
  for (const path of ['README.md', '/中文目录/使用说明.MD', 'guide.markdown', 'guide.mdown', 'guide.mkd']) {
    assert.equal(canPreviewMarkdown({ ...preview, path }), true);
  }
  for (const path of ['file.ts', 'README.md.ts', 'markdown', '/README.md/file']) {
    assert.equal(canPreviewMarkdown({ ...preview, path }), false);
  }
  assert.equal(canPreviewMarkdown(null), false);
  assert.equal(canPreviewMarkdown({ ...preview, content: '' }), false);
  assert.equal(canPreviewMarkdown({ ...preview, binary: true }), false);
  assert.equal(canPreviewMarkdown({ ...preview, status: 'deleted' }), false);
});

test('Markdown 预览保留可切换的源码和差异视图', () => {
  for (const mode of ['markdown', 'content', 'unified', 'split'] as const) {
    assert.equal(resolveChangedFileViewMode(mode, preview), mode);
  }
  assert.equal(resolveChangedFileViewMode('markdown', { ...preview, patch: '' }), 'markdown');
});

test('切换到非 Markdown、已删除或仅有差异的文件时恢复有效视图', () => {
  assert.equal(resolveChangedFileViewMode('markdown', { ...preview, path: 'app.ts' }), 'unified');
  assert.equal(resolveChangedFileViewMode('markdown', { ...preview, path: 'app.ts', patch: '' }), 'content');
  assert.equal(resolveChangedFileViewMode('markdown', { ...preview, status: 'deleted', content: '' }), 'unified');
  assert.equal(resolveChangedFileViewMode('markdown', { ...preview, content: '' }), 'unified');
  assert.equal(resolveChangedFileViewMode('content', { ...preview, content: '' }), 'unified');
  assert.equal(resolveChangedFileViewMode('split', { ...preview, patch: '' }), 'content');
});

test('渲染预览复制原始 Markdown，差异视图仍复制 Diff', () => {
  assert.equal(changedFileCopyText('markdown', preview), preview.content);
  assert.equal(changedFileCopyText('content', preview), preview.content);
  assert.equal(changedFileCopyText('unified', preview), preview.patch);
  assert.equal(changedFileCopyText('split', preview), preview.patch);
  assert.equal(changedFileCopyText('markdown', null), '');
});

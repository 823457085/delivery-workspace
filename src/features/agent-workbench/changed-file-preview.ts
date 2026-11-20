export type ChangedFileViewMode = 'unified' | 'split' | 'content' | 'markdown';

interface PreviewSource {
  path: string;
  status: string;
  binary: boolean;
  content: string;
  patch: string;
}

export function canPreviewMarkdown(preview: PreviewSource | null): boolean {
  return Boolean(preview && !preview.binary && preview.status !== 'deleted'
    && /\.(?:md|markdown|mdown|mkd)$/i.test(preview.path) && preview.content.length);
}

export function resolveChangedFileViewMode(mode: ChangedFileViewMode, preview: PreviewSource | null): ChangedFileViewMode {
  if (mode === 'markdown' && canPreviewMarkdown(preview)) return 'markdown';
  if (preview?.content && (mode === 'content' || !preview.patch.trim())) return 'content';
  return mode === 'split' ? 'split' : 'unified';
}

export function changedFileCopyText(mode: ChangedFileViewMode, preview: PreviewSource | null): string {
  return mode === 'content' || mode === 'markdown'
    ? preview?.content || ''
    : preview?.patch || preview?.content || '';
}

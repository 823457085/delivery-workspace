/**
 * 借鉴 GitHub Desktop (desktop/desktop)、GitButler (gitbutlerapp/gitbutler) 与 Lazygit (jesseduffield/lazygit)：
 * 提供 Conventional Commits 前缀切换、50/72 提交标题长度标尺、文件名优先拆分与 Diff Hunk 快速跳转计算。
 */

export interface ConventionalCommitOption {
  type: string;
  label: string;
  hint: string;
}

export const CONVENTIONAL_COMMIT_TYPES: readonly ConventionalCommitOption[] = [
  { type: 'feat', label: 'feat', hint: '新增功能或业务特性' },
  { type: 'fix', label: 'fix', hint: '修复缺陷、异常或样式错位' },
  { type: 'refactor', label: 'refactor', hint: '代码结构重构（不改变外部行为）' },
  { type: 'perf', label: 'perf', hint: '渲染或接口性能优化' },
  { type: 'test', label: 'test', hint: '新增或完善自动化测试' },
  { type: 'docs', label: 'docs', hint: '文档、契约或注释更新' },
  { type: 'chore', label: 'chore', hint: '构建配置、依赖或工具链维护' },
];

const KNOWN_TYPES = new Set(CONVENTIONAL_COMMIT_TYPES.map(item => item.type));
const CONVENTIONAL_RE = /^([a-z]+)(\([^)\r\n]+\))?(!)?:\s*(.*)$/;

export function detectConventionalType(message: string): string {
  const firstLine = (message.split(/\r?\n/, 1)[0] || '').trimStart();
  const match = firstLine.match(CONVENTIONAL_RE);
  if (!match) return '';
  const candidate = match[1]!;
  return KNOWN_TYPES.has(candidate) ? candidate : '';
}

export function applyConventionalPrefix(message: string, type: string, explicitScope?: string): string {
  const cleanType = type.trim().toLowerCase();
  if (!cleanType) return message;
  const lines = message.split(/\r?\n/);
  const firstLine = lines[0] ?? '';
  const restLines = lines.slice(1);
  const match = firstLine.trimStart().match(CONVENTIONAL_RE);
  const normalizedExplicitScope = explicitScope?.trim() ? `(${explicitScope.trim().replace(/^[()]+|[()]+$/g, '')})` : '';

  if (match && KNOWN_TYPES.has(match[1]!)) {
    const [, existingType, existingScope = '', bang = '', remainder = ''] = match;
    if (existingType === cleanType && !normalizedExplicitScope) {
      return [remainder, ...restLines].join('\n');
    }
    const nextScope = normalizedExplicitScope || existingScope;
    const nextFirst = `${cleanType}${nextScope}${bang}: ${remainder}`;
    return [nextFirst, ...restLines].join('\n');
  }

  const trimmedFirst = firstLine.trimStart();
  const nextFirst = `${cleanType}${normalizedExplicitScope}: ${trimmedFirst}`;
  return [nextFirst, ...restLines].join('\n');
}

export interface CommitMessageAnalysis {
  subjectLength: number;
  hasBody: boolean;
  tone: 'idle' | 'good' | 'ok' | 'warn';
}

export function analyzeCommitMessage(message: string): CommitMessageAnalysis {
  const lines = message.split(/\r?\n/);
  const subject = (lines[0] || '').trim();
  const subjectLength = Array.from(subject).length;
  const hasBody = lines.slice(1).join('\n').trim().length > 0;
  const tone =
    subjectLength === 0
      ? 'idle'
      : subjectLength <= 50
        ? 'good'
        : subjectLength <= 72
          ? 'ok'
          : 'warn';
  return { subjectLength, hasBody, tone };
}

export function splitGitFilePath(rawPath: string): { base: string; dir: string } {
  const normalized = rawPath.replaceAll('\\', '/');
  const isTrailingSlash = normalized.endsWith('/') && normalized.length > 1;
  const trimmed = isTrailingSlash ? normalized.slice(0, -1) : normalized;
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) {
    return { base: isTrailingSlash ? `${trimmed}/` : trimmed, dir: '' };
  }
  return {
    base: isTrailingSlash ? `${trimmed.slice(idx + 1)}/` : trimmed.slice(idx + 1),
    dir: trimmed.slice(0, idx),
  };
}

export interface DiffHunkAnchor {
  lineIndex: number;
  header: string;
}

export function extractDiffHunkIndices(lines: readonly { kind: string; content: string }[]): DiffHunkAnchor[] {
  const anchors: DiffHunkAnchor[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind === 'hunk' || line.content.startsWith('@@')) {
      anchors.push({ lineIndex: i, header: line.content.trim() });
    }
  }
  return anchors;
}

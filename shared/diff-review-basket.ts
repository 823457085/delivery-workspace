/**
 * Inline Diff Review Basket & Structured Agent Revision Formatter
 *
 * 借鉴 diffx (wong2/diffx) 本地代码审查工作流与 GitHub Pull Request Multi-Comment Review 机制：
 * - 允许开发者在查看 AI 改动 Diff 时，跨多个文件、多个代码行持续添加带严重度标签的行级批注，
 *   无需每点一行就关闭抽屉打断阅读流；
 * - 汇总时自动做凭据脱敏，并格式化为包含精确 `@path:line` 锚点与代码上下文片段的结构化返修指令。
 */

import { redactSensitiveHandoffText } from './agent-handoff-packet.js';

export type DiffReviewSeverity = 'must_fix' | 'nit' | 'question';

export interface DiffReviewCommentItem {
  id: string;
  file: string;
  line: number;
  side: 'new' | 'old';
  codeSnippet: string;
  comment: string;
  severity: DiffReviewSeverity;
}

export interface DiffReviewCommentDraft {
  file: string;
  line: number;
  side?: 'new' | 'old';
  codeSnippet?: string;
  comment: string;
  severity?: DiffReviewSeverity;
}

export const DIFF_REVIEW_SEVERITY_LABELS: Record<DiffReviewSeverity, string> = {
  must_fix: '必改',
  nit: '细节优化',
  question: '追问确认',
};

function normalizePath(raw: string): string {
  return raw.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function sanitizeSingleLine(raw: string, maxLength: number): string {
  const collapsed = redactSensitiveHandoffText(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export function buildDiffReviewCommentKey(file: string, side: 'new' | 'old', line: number): string {
  return `${normalizePath(file)}:${side}:${Math.max(1, Math.trunc(line))}`;
}

/**
 * 新增或更新同一 `(file, side, line)` 位置的行级审查批注。
 */
export function upsertDiffReviewComment(
  existing: readonly DiffReviewCommentItem[],
  draft: DiffReviewCommentDraft,
): DiffReviewCommentItem[] {
  const file = normalizePath(draft.file);
  const line = Math.max(1, Math.trunc(Number(draft.line) || 1));
  const side: 'new' | 'old' = draft.side === 'old' ? 'old' : 'new';
  const comment = sanitizeSingleLine(draft.comment, 500);
  if (!file || !comment) return [...existing];

  const id = buildDiffReviewCommentKey(file, side, line);
  const nextItem: DiffReviewCommentItem = {
    id,
    file,
    line,
    side,
    codeSnippet: sanitizeSingleLine(draft.codeSnippet || '', 160),
    comment,
    severity: draft.severity || 'must_fix',
  };

  const index = existing.findIndex(item => item.id === id);
  if (index < 0) return [...existing, nextItem];
  const copy = [...existing];
  copy[index] = nextItem;
  return copy;
}

export function removeDiffReviewComment(
  existing: readonly DiffReviewCommentItem[],
  id: string,
): DiffReviewCommentItem[] {
  return existing.filter(item => item.id !== id);
}

export function groupDiffReviewCommentsByFile(
  items: readonly DiffReviewCommentItem[],
): Array<{ file: string; comments: DiffReviewCommentItem[] }> {
  const map = new Map<string, DiffReviewCommentItem[]>();
  for (const item of items) {
    const list = map.get(item.file) || [];
    list.push(item);
    map.set(item.file, list);
  }
  return Array.from(map.entries()).map(([file, comments]) => ({
    file,
    comments: [...comments].sort((a, b) => a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1)),
  }));
}

/**
 * 将批注篮内的多文件行级意见汇总为结构化 Agent 返修提示词。
 * 保留 `@file:line` 引用格式以兼容工作台上下文符号定位器。
 */
export function formatDiffReviewBasketPrompt(items: readonly DiffReviewCommentItem[]): string {
  if (!items.length) return '';
  const groups = groupDiffReviewCommentsByFile(items);
  const lines: string[] = [
    `请根据以下行级代码审查批注（共 ${items.length} 处，涉及 ${groups.length} 个文件）逐项精确修改，并保持其余未提及逻辑稳定：`,
  ];

  groups.forEach((group, groupIdx) => {
    lines.push('', `### ${groupIdx + 1}. \`@${group.file}\``);
    for (const item of group.comments) {
      const tag = DIFF_REVIEW_SEVERITY_LABELS[item.severity] || '必改';
      const anchor = item.side === 'old'
        ? `\`@${group.file}:${item.line}\`（变更前第 ${item.line} 行）`
        : `\`@${group.file}:${item.line}\``;
      const snippetSuffix = item.codeSnippet
        ? ` · 代码片段：\`${item.codeSnippet.replace(/`/g, "'")}\``
        : '';
      lines.push(`- **[${tag}]** ${anchor}${snippetSuffix}`);
      lines.push(`  修改要求：${item.comment}`);
    }
  });

  return lines.join('\n');
}

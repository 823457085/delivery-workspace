/**
 * 设计说明：借鉴 OpenCode `/timeline`、Cherry Studio 对话目录与 LobeChat 划词引用回复。
 * 1. 从当前会话轮次提取清晰的提问目录，方便长对话一键跳到任意一轮；
 * 2. 将选中的段落或指定回复格式化为标准 Markdown 引用块（`> ...`），填入输入框继续追问。
 */

export interface ConversationOutlineItem {
  id: string;
  round: number;
  summary: string;
  status: string;
  changedFiles: number;
  createdAt: string;
}

export interface OutlineSourceEntry {
  id: string;
  text: string;
  status: string;
  changedFiles?: number;
  createdAt: string;
}

export function summarizeOutlineText(raw: string, maxLength = 54): string {
  const withoutQuotes = raw
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join(' ')
    .trim();
  const base = (withoutQuotes || raw).replace(/\s+/g, ' ').trim();
  if (!base) return '（附件或图片消息）';
  return base.length > maxLength ? `${base.slice(0, maxLength)}…` : base;
}

export function buildConversationOutlineItems(entries: readonly OutlineSourceEntry[]): ConversationOutlineItem[] {
  return entries.map((entry, index) => ({
    id: entry.id,
    round: index + 1,
    summary: summarizeOutlineText(entry.text),
    status: entry.status,
    changedFiles: entry.changedFiles || 0,
    createdAt: entry.createdAt,
  }));
}

export function formatQuoteReply(rawSnippet: string, existingDraft = '', maxChars = 900): string {
  const cleaned = rawSnippet
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleaned) return existingDraft;

  const clipped = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars).trimEnd()}…` : cleaned;
  const quoted = clipped
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');

  const trimmedExisting = existingDraft.trim();
  if (!trimmedExisting) return `${quoted}\n\n`;
  if (existingDraft.includes(quoted)) return existingDraft;
  return `${quoted}\n\n${existingDraft}`;
}

export function formatChangedFileReference(filePath: string, line?: number): string {
  const validLine = typeof line === 'number' && Number.isFinite(line) && line > 0 ? `:${Math.trunc(line)}` : '';
  return /\s/.test(filePath) ? `@"${filePath}"${validLine}` : `@${filePath}${validLine}`;
}

export function stripMarkdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

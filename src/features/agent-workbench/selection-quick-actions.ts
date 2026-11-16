/**
 * 设计说明：借鉴 GitHub 标杆项目 Open WebUI / LobeChat / Chatbox 的划词浮动快捷动作条。
 * 选中对话里的任意片段（如报错堆栈、生僻代码、长段方案）后，除了「引用追问」，
 * 支持一键填入「通俗解释」「排查报错」「提炼要点」结构化追问草稿，省去手敲套话。
 */
import { formatQuoteReply } from './conversation-outline';

export type SelectionQuickActionKind = 'quote' | 'explain' | 'fix-error' | 'summarize';

const ERROR_SNIPPET_RE = /(\b(?:Error|Exception|TypeError|SyntaxError|ReferenceError|ERR!|FAIL(?:ED)?|panic|ECONNREFUSED|ETIMEDOUT|status\s+[45]\d{2})\b|报错|失败|异常|未找到|拒绝连接)/i;

export function looksLikeErrorSelection(raw: string): boolean {
  return ERROR_SNIPPET_RE.test(raw || '');
}

export function buildSelectionActionPrompt(
  rawSnippet: string,
  action: SelectionQuickActionKind,
  existingDraft = '',
): string {
  const quotedWithTrailingBlank = formatQuoteReply(rawSnippet, existingDraft);
  if (!rawSnippet.trim() || action === 'quote') {
    return quotedWithTrailingBlank;
  }

  const instructionMap: Record<Exclude<SelectionQuickActionKind, 'quote'>, string> = {
    explain: '请用通俗易懂的大白话解释上面这段内容的核心作用与关键细节。',
    'fix-error': '请帮我排查上面这段报错或异常的原因，并给出具体的修复步骤。',
    summarize: '请把上面这段内容提炼成简明扼要的几条重点结论（方便直接发群里或记笔记）。',
  };

  const sep = quotedWithTrailingBlank.endsWith('\n') ? '' : '\n';
  return `${quotedWithTrailingBlank}${sep}${instructionMap[action]}`;
}

export interface PromptTokenMetrics {
  chars: number;
  lines: number;
  estimatedTokens: number;
  codeBlocks: number;
}

// Matches CJK Unified Ideographs, Hiragana, Katakana, Hangul, and fullwidth punctuation
const CJK_CHAR_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/**
 * Lightweight, zero-WASM token & structure estimator inspired by LobeChat / Open WebUI composer telemetry.
 * Accounts for CJK (~0.65 tok/char) vs ASCII/code (~0.27 tok/char) density.
 */
export function estimatePromptTokens(input: string): PromptTokenMetrics {
  const text = input || '';
  if (!text) {
    return { chars: 0, lines: 0, estimatedTokens: 0, codeBlocks: 0 };
  }
  const chars = [...text].length;
  const lines = text.split('\n').length;
  const codeBlocks = (text.match(CODE_FENCE_RE) || []).length;
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  const rawTokens = cjkCount * 0.65 + nonCjkCount * 0.27;
  const estimatedTokens = Math.max(1, Math.ceil(rawTokens));

  return {
    chars,
    lines,
    estimatedTokens,
    codeBlocks,
  };
}

/**
 * Selects quick-bind workspaces for the New Conversation Launchpad while keeping any active workspace included.
 */
export function pickLaunchpadWorkspaces<T extends { path: string; label: string }>(
  workspaces: readonly T[],
  activePath = '',
  limit = 5,
): T[] {
  const max = Math.max(1, limit);
  if (!workspaces.length) return [];
  const top = workspaces.slice(0, max);
  if (!activePath || top.some(item => item.path === activePath)) {
    return [...top];
  }
  const active = workspaces.find(item => item.path === activePath);
  if (!active) return [...top];
  return [active, ...top.slice(0, max - 1)];
}

/**
 * Appends a `@reference` token into a prompt draft with clean whitespace separation.
 */
export function appendContextMention(currentDraft: string, mentionValue: string): string {
  const token = (mentionValue || '').trim();
  if (!token) return currentDraft;
  if (currentDraft.includes(token)) return currentDraft;
  if (!currentDraft.trim()) return `${token} `;
  const needsSpace = !/\s$/.test(currentDraft);
  return `${currentDraft}${needsSpace ? ' ' : ''}${token} `;
}

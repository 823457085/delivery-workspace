/**
 * 设计说明：借鉴 GitHub 标杆项目 Open WebUI（Prompt `{{变量}}` 填空模板 + Smart Paste 大段粘贴识别）
 * 与 Continue / Cline（报错堆栈一键转修复指令）：
 * 1. 支持在 `/` 快捷指令与个人常用指令中使用 `{{变量名}}` 或 `{{变量名:默认值}}`，选中时弹出轻量填空卡；
 * 2. 粘贴大段未包裹的报错堆栈、JSON、SQL 或长代码时，不拦截原始粘贴，而是在输入框上方提供非侵入式一键整理条。
 */

export interface PromptVariableSpec {
  key: string;
  defaultValue: string;
  rawToken: string;
}

export interface SmartPasteHint {
  pastedText: string;
  lineCount: number;
  charCount: number;
  language: string;
  kind: 'error-log' | 'code-or-data';
  summaryLabel: string;
}

const PROMPT_VAR_PATTERN = /\{\{\s*([^:{}\r\n：]{1,32}?)(?:\s*[:：]\s*([^{}\r\n]{0,120}?))?\s*\}\}/g;
const IGNORED_PROMPT_VAR_KEYS = new Set(['光标', 'cursor']);

export function extractPromptVariables(template: string): PromptVariableSpec[] {
  if (!template || !template.includes('{{')) return [];
  const seen = new Map<string, PromptVariableSpec>();
  for (const match of template.matchAll(PROMPT_VAR_PATTERN)) {
    const rawToken = match[0] || '';
    const key = (match[1] || '').trim();
    const defaultValue = (match[2] || '').trim();
    if (!key || IGNORED_PROMPT_VAR_KEYS.has(key.toLowerCase())) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { key, defaultValue, rawToken });
    } else if (!existing.defaultValue && defaultValue) {
      seen.set(key, { ...existing, defaultValue });
    }
  }
  return [...seen.values()];
}

export function fillPromptVariables(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  if (!template) return '';
  return template
    .replace(/\{\{\s*(?:光标|cursor)\s*\}\}/gi, '')
    .replace(PROMPT_VAR_PATTERN, (_full, rawKey: string, rawDefault?: string) => {
      const key = (rawKey || '').trim();
      if (!key || IGNORED_PROMPT_VAR_KEYS.has(key.toLowerCase())) return '';
      const provided = values[key];
      if (typeof provided === 'string' && provided.trim()) {
        return provided.trim();
      }
      const fallback = (rawDefault || '').trim();
      if (fallback) return fallback;
      return `【${key}】`;
    });
}

function hasOpenCodeFence(textBeforePaste: string): boolean {
  if (!textBeforePaste) return false;
  const matches = textBeforePaste.match(/(?:^|\n)`{3,}/g);
  return Boolean(matches && matches.length % 2 === 1);
}

function looksLikeErrorTrace(text: string): boolean {
  return (
    /(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|AggregateError|Error|Exception)\s*:/i.test(text)
    || /\bat\s+[^\r\n]+\([^()\r\n]+:\d+:\d+\)/.test(text)
    || /\bat\s+(?:async\s+)?[^\s()]+\s+\(?\/[^\r\n]+:\d+:\d+\)?/.test(text)
    || /Traceback \(most recent call last\)/i.test(text)
    || /\bTS\d{4,5}\s*:/.test(text)
    || /\bERR_[A-Z0-9_]+\b/.test(text)
    || /\b(?:npm ERR!|ELIFECYCLE|panic:\s+|error\[E\d+\]:|Caused by:)/i.test(text)
    || /Command failed with exit code \d+/i.test(text)
    || /(?:编译失败|构建失败|未捕获异常|报错堆栈)/.test(text)
  );
}

export function detectPastedLanguage(text: string, isErrorLog: boolean): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      /* 非严格 JSON 继续按常规代码/日志识别 */
    }
  }
  if (/^(?:diff --git |---\s+\S+[\s\S]*\n\+\+\+\s+\S+)/.test(trimmed) && trimmed.includes('\n@@')) {
    return 'diff';
  }
  if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/im.test(trimmed)) {
    return 'sql';
  }
  if (/^\s*(?:<!doctype html|<html\b|<template\b|<svg\b)/im.test(trimmed)) {
    return 'html';
  }
  if (/Traceback \(most recent call last\)|^\s*(?:def\s+\w+\s*\(|from\s+\S+\s+import\s+|import\s+\w+)/m.test(trimmed)) {
    return isErrorLog ? 'text' : 'python';
  }
  if (isErrorLog) {
    return 'text';
  }
  if (/^\s*(?:import\s+[\s\S]+?from\s+['"]|export\s+(?:async\s+)?(?:function|const|class|interface|type)\b|const\s+\w+\s*=|function\s+\w+\s*\()/m.test(trimmed)) {
    return 'ts';
  }
  if (/^\s*(?:\$\s+|curl\s+-|npm\s+run\b|pnpm\s+|git\s+(?:status|diff|log|checkout)\b)/m.test(trimmed)) {
    return 'bash';
  }
  return 'text';
}

export function analyzeSmartPaste(
  pastedText: string,
  draftBeforePaste = '',
): SmartPasteHint | undefined {
  if (!pastedText) return undefined;
  const normalized = pastedText.replace(/\r\n/g, '\n');
  const trimmed = normalized.trim();
  if (!trimmed) return undefined;
  // 已经是独立代码块或正处于代码块内部时不再打扰
  if (/^`{3,}/.test(trimmed) || hasOpenCodeFence(draftBeforePaste)) return undefined;

  const lines = normalized.split('\n');
  const lineCount = lines.length;
  const charCount = normalized.length;
  if (lineCount < 8 && charCount < 420) return undefined;

  const isErrorLog = looksLikeErrorTrace(normalized);
  const language = detectPastedLanguage(normalized, isErrorLog);
  const kind: SmartPasteHint['kind'] = isErrorLog ? 'error-log' : 'code-or-data';

  let summaryLabel = `刚粘贴了 ${lineCount} 行长代码`;
  if (isErrorLog) {
    summaryLabel = `刚粘贴了 ${lineCount} 行报错日志`;
  } else if (language === 'json') {
    summaryLabel = `刚粘贴了 ${lineCount} 行 JSON 数据`;
  } else if (language === 'sql') {
    summaryLabel = `刚粘贴了 ${lineCount} 行 SQL 语句`;
  } else if (language === 'diff') {
    summaryLabel = `刚粘贴了 ${lineCount} 行代码改动`;
  }

  return {
    pastedText: normalized,
    lineCount,
    charCount,
    language,
    kind,
    summaryLabel,
  };
}

function buildSafeCodeFence(content: string, language: string): string {
  const runs = content.match(/`{3,}/g) || [];
  const maxBackticks = runs.reduce((max, item) => Math.max(max, item.length), 2);
  const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
  const cleanBody = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return `${fence}${language}\n${cleanBody}\n${fence}`;
}

export function applySmartPasteAction(
  currentDraft: string,
  hint: SmartPasteHint,
  action: 'wrap-fence' | 'ask-fix-error',
): string {
  const normalizedDraft = currentDraft.replace(/\r\n/g, '\n');
  const fenced = buildSafeCodeFence(hint.pastedText, hint.language);
  const fixLead = '请帮我定位并修复下面这段报错，改完后顺手跑一下验证确认修好：';

  const lastIndex = normalizedDraft.lastIndexOf(hint.pastedText);
  if (lastIndex >= 0) {
    const before = normalizedDraft.slice(0, lastIndex);
    const after = normalizedDraft.slice(lastIndex + hint.pastedText.length);
    const beforeTrimmed = before.trim();
    const prefix = beforeTrimmed
      ? `${before.replace(/\n*$/, '\n\n')}${action === 'ask-fix-error' && !beforeTrimmed.includes('修复') ? `${fixLead}\n\n` : ''}`
      : (action === 'ask-fix-error' ? `${fixLead}\n\n` : '');
    const suffix = after.trim() ? `\n\n${after.replace(/^\n+/, '')}` : '';
    return `${prefix}${fenced}${suffix}`;
  }

  // 若用户在点击整理前微调了文本导致精确子串变化，回退为整体包裹
  if (!normalizedDraft.trim()) {
    return action === 'ask-fix-error' ? `${fixLead}\n\n${fenced}` : fenced;
  }
  const wrappedCurrent = buildSafeCodeFence(normalizedDraft, hint.language);
  return action === 'ask-fix-error' ? `${fixLead}\n\n${wrappedCurrent}` : wrappedCurrent;
}

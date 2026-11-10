import { refactorActionLabels, type RefactorAction } from '../../../shared/refactor-control';

export function jiraTaskPromptTitle(source: string) {
  const [title, marker] = source.split(/\r?\n(?:[ \t]*\r?\n)*/, 2);
  if (/^(?:需求开发|Jira 修复)(?:[ \t]*·.+)?$/.test(title.trim())
    && /^JIRA_DEV_TASK_ID:[ \t]+[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}[ \t]*$/i.test(marker || '')) return title.trim();
}

/** 仅生成展示摘要；旧重构任务的正文仍作为完整提示词保留，不改变执行输入。 */
export function groupTaskMessage(round: { text: string; taskPrompt?: string }): { text: string; prompt?: string } {
  if (round.taskPrompt?.trim()) return { text: round.text, prompt: round.taskPrompt };
  const [marker, metadata] = round.text.split('\n', 2);
  if (!/^\[重构管理任务:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\]\r?$/i.test(marker || '')) return { text: round.text };
  try {
    const data = JSON.parse(metadata || '');
    if (data && typeof data.action === 'string' && Object.hasOwn(refactorActionLabels, data.action)
      && typeof data.version === 'string'
      && ['moduleId', 'environment'].every(key => typeof data[key] === 'string' && data[key].trim())) {
      return { text: `重构管理 · ${refactorActionLabels[data.action as RefactorAction]}（${data.environment}）`, prompt: round.text };
    }
  } catch { /* 无法确认是生成的任务指令时仍完整展示消息。 */ }
  return { text: round.text };
}

/**
 * 只切分用户消息的展示片段，所有片段按顺序拼接仍是原文；不修改保存、复制或搜索使用的消息。
 * 优先识别明确的交接 JSON，保留其后的新要求；普通长消息只按长度折叠，避免猜测业务段落。
 */
export function splitUserMessage(source: string) {
  const marker = /^(?:以下是当前工作台对话跨执行器交接的近期文本|以下是跨执行器带入的近期对话文本)[^\n]*\n\s*(?=\[)/m.exec(source);
  if (marker) {
    const start = marker.index + marker[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) {
        try {
          const history: unknown = JSON.parse(source.slice(start, index + 1));
          if (Array.isArray(history) && history.length && history.every(item => item && typeof item === 'object'
            && typeof item.user === 'string' && typeof item.assistant === 'string')) {
            return { before: source.slice(0, marker.index), hidden: source.slice(marker.index, index + 1),
              after: source.slice(index + 1), handoff: true };
          }
        } catch { /* 不完整或非交接 JSON 仍按普通消息显示。 */ }
        break;
      }
    }
  }
  const lines = source.split('\n');
  if (source.length < 1600 && lines.length < 20) return { before: source, hidden: '', after: '', handoff: false };
  let boundary = Math.min(480, lines.slice(0, 6).join('\n').length);
  // 不把一个 Unicode 字符的代理对切在预览和折叠内容两侧。
  if (boundary > 0 && /[\uD800-\uDBFF]/.test(source[boundary - 1])) boundary--;
  return { before: source.slice(0, boundary), hidden: source.slice(boundary), after: '', handoff: false };
}

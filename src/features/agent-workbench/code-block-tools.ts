/**
 * 设计说明：借鉴 GitHub 标杆项目 Open WebUI / Continue / Cursor / Cherry Studio 的代码块生产力工具：
 * 1. 智能推断代码块文件名与扩展名（优先识别首行文件路径注释如 `// src/retry.ts` 或 `# backup.sh`，否则按语言映射标准后缀），支持一键保存为本地文件；
 * 2. 识别合法 JSON 代码块，支持一键「美化排版（2 空格缩进）」与「单行压缩」切换及字段规模提示；
 * 3. 支持一键将指定代码块格式化为安全反引号围栏块带入对话输入框继续追问（借鉴 Cursor Add to Chat / Continue Ask about code block）。
 */

const LANGUAGE_EXTENSION_MAP: Record<string, { ext: string; mime: string }> = {
  ts: { ext: 'ts', mime: 'text/typescript;charset=utf-8' },
  typescript: { ext: 'ts', mime: 'text/typescript;charset=utf-8' },
  tsx: { ext: 'tsx', mime: 'text/tsx;charset=utf-8' },
  js: { ext: 'js', mime: 'text/javascript;charset=utf-8' },
  javascript: { ext: 'js', mime: 'text/javascript;charset=utf-8' },
  mjs: { ext: 'mjs', mime: 'text/javascript;charset=utf-8' },
  cjs: { ext: 'cjs', mime: 'text/javascript;charset=utf-8' },
  jsx: { ext: 'jsx', mime: 'text/jsx;charset=utf-8' },
  vue: { ext: 'vue', mime: 'text/plain;charset=utf-8' },
  py: { ext: 'py', mime: 'text/x-python;charset=utf-8' },
  python: { ext: 'py', mime: 'text/x-python;charset=utf-8' },
  sh: { ext: 'sh', mime: 'text/x-shellscript;charset=utf-8' },
  bash: { ext: 'sh', mime: 'text/x-shellscript;charset=utf-8' },
  zsh: { ext: 'sh', mime: 'text/x-shellscript;charset=utf-8' },
  shell: { ext: 'sh', mime: 'text/x-shellscript;charset=utf-8' },
  sql: { ext: 'sql', mime: 'application/sql;charset=utf-8' },
  json: { ext: 'json', mime: 'application/json;charset=utf-8' },
  jsonc: { ext: 'json', mime: 'application/json;charset=utf-8' },
  yaml: { ext: 'yaml', mime: 'text/yaml;charset=utf-8' },
  yml: { ext: 'yml', mime: 'text/yaml;charset=utf-8' },
  toml: { ext: 'toml', mime: 'text/plain;charset=utf-8' },
  xml: { ext: 'xml', mime: 'application/xml;charset=utf-8' },
  html: { ext: 'html', mime: 'text/html;charset=utf-8' },
  htm: { ext: 'html', mime: 'text/html;charset=utf-8' },
  svg: { ext: 'svg', mime: 'image/svg+xml;charset=utf-8' },
  css: { ext: 'css', mime: 'text/css;charset=utf-8' },
  scss: { ext: 'scss', mime: 'text/x-scss;charset=utf-8' },
  md: { ext: 'md', mime: 'text/markdown;charset=utf-8' },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8' },
  go: { ext: 'go', mime: 'text/x-go;charset=utf-8' },
  golang: { ext: 'go', mime: 'text/x-go;charset=utf-8' },
  rs: { ext: 'rs', mime: 'text/x-rust;charset=utf-8' },
  rust: { ext: 'rs', mime: 'text/x-rust;charset=utf-8' },
  java: { ext: 'java', mime: 'text/x-java-source;charset=utf-8' },
  diff: { ext: 'patch', mime: 'text/x-diff;charset=utf-8' },
  patch: { ext: 'patch', mime: 'text/x-diff;charset=utf-8' },
  mermaid: { ext: 'mmd', mime: 'text/plain;charset=utf-8' },
};

function sanitizeDownloadBasename(candidate: string): string | undefined {
  const cleaned = candidate
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1);
  if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;
  const safe = cleaned.replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]/g, '');
  if (!safe || safe.startsWith('.') || !safe.includes('.')) return undefined;
  const ext = safe.split('.').at(-1) || '';
  if (ext.length < 1 || ext.length > 10) return undefined;
  return safe.slice(0, 64);
}

function extractCommentFilename(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(0, 3);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过 shebang 如 #!/usr/bin/env bash
    if (line.startsWith('#!')) continue;
    const match = line.match(
      /^(?:\/\/+|#|\/\*+|<!--|--)\s*(?:filepath:\s*|file:\s*|文件[:：]\s*)?([A-Za-z0-9_./\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,10})\s*(?:\*\/|-->)?$/i,
    );
    if (match?.[1]) {
      const safe = sanitizeDownloadBasename(match[1]);
      if (safe) return safe;
    }
    // 仅检查文件头连续注释
    if (!/^(?:\/\/|#|\/\*|<!--|--)/.test(line)) break;
  }
  return undefined;
}

export function inferCodeBlockFilename(
  language: string | undefined,
  text: string,
  blockIndex = 0,
): { filename: string; mimeType: string } {
  const lang = (language || '').trim().toLowerCase();
  if (lang === 'dockerfile') {
    return { filename: 'Dockerfile', mimeType: 'text/plain;charset=utf-8' };
  }
  const spec = LANGUAGE_EXTENSION_MAP[lang];
  const fromComment = extractCommentFilename(text);
  if (fromComment) {
    return {
      filename: fromComment,
      mimeType: spec?.mime || 'text/plain;charset=utf-8',
    };
  }
  const suffix = blockIndex > 0 ? `-${blockIndex + 1}` : '';
  if (spec) {
    const prefix = lang === 'sql' ? 'query' : lang === 'sh' || lang === 'bash' || lang === 'zsh' ? 'script' : lang === 'json' ? 'data' : 'snippet';
    return {
      filename: `${prefix}${suffix}.${spec.ext}`,
      mimeType: spec.mime,
    };
  }
  return {
    filename: `snippet${suffix}.txt`,
    mimeType: 'text/plain;charset=utf-8',
  };
}

export type JsonCodeBlockInspection =
  | {
      valid: true;
      pretty: string;
      minified: string;
      summary: string;
      isMultiLine: boolean;
    }
  | {
      valid: false;
    };

const MAX_JSON_INSPECT_CHARS = 160_000;

export function inspectJsonCodeBlock(
  language: string | undefined,
  text: string,
): JsonCodeBlockInspection {
  if (!text || text.length > MAX_JSON_INSPECT_CHARS) return { valid: false };
  const lang = (language || '').trim().toLowerCase();
  if (lang && lang !== 'json' && lang !== 'jsonc' && lang !== 'text') {
    return { valid: false };
  }
  const trimmed = text.trim();
  const isObjectOrArray =
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!isObjectOrArray) return { valid: false };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return { valid: false };
    const pretty = JSON.stringify(parsed, null, 2);
    const minified = JSON.stringify(parsed);
    const summary = Array.isArray(parsed)
      ? `JSON · ${parsed.length} 项`
      : `JSON · ${Object.keys(parsed).length} 个字段`;
    return {
      valid: true,
      pretty,
      minified,
      summary,
      isMultiLine: trimmed.includes('\n'),
    };
  } catch {
    return { valid: false };
  }
}

const MAX_FOLLOW_UP_CODE_CHARS = 6000;

function pickSafeFence(code: string): string {
  const matches = code.match(/`{3,}/g);
  if (!matches?.length) return '```';
  const longest = Math.max(...matches.map(m => m.length));
  return '`'.repeat(longest + 1);
}

export function formatCodeBlockFollowUp(
  language: string | undefined,
  code: string,
  existingDraft = '',
): string {
  const normalized = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!normalized.trim()) return existingDraft;
  const snippet = normalized.length > MAX_FOLLOW_UP_CODE_CHARS
    ? `${normalized.slice(0, MAX_FOLLOW_UP_CODE_CHARS - 32).trimEnd()}\n// ...(后续代码已省略)`
    : normalized;
  const lang = (language || '').trim().replace(/\s+/g, '');
  const fence = pickSafeFence(snippet);
  const block = `${fence}${lang}\n${snippet}\n${fence}`;
  const trimmedExisting = existingDraft.trim();
  if (!trimmedExisting) {
    return `${block}\n\n`;
  }
  if (trimmedExisting.includes(block)) {
    return existingDraft;
  }
  return `${existingDraft.replace(/\s+$/, '')}\n\n${block}\n\n`;
}

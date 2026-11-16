/**
 * 设计说明：借鉴 Open WebUI Artifacts、LobeChat 与 Cherry Studio 富结果工具栏。
 * 1. 识别 Markdown 中的 HTML 网页 / 原型片段与 SVG 矢量图代码块，并生成严格隔离的沙盒文档（srcdoc）；
 * 2. 支持将 Markdown 结构化表格一键复制为 Excel/飞书可直接分列粘贴的 TSV，或导出为带 UTF-8 BOM 的 CSV（防中文乱码）。
 * 安全红线：iframe 绝不开启 `allow-same-origin`，并注入 CSP 禁止外部网络请求（`connect-src 'none'`）。
 */
import type { MarkdownInline } from './markdown';

export type PreviewableArtifactKind = 'html' | 'svg';

const HTML_TAG_PATTERN = /<(?:!doctype\s+html|html|head|body|div|section|main|article|header|footer|nav|aside|form|table|canvas|svg|button|input|style|h[1-6]|p|ul|ol)\b/i;

export function detectPreviewableCodeArtifact(
  language: string | undefined,
  text: string,
): PreviewableArtifactKind | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 16) return undefined;
  const lang = (language || '').trim().toLowerCase();

  if (
    lang === 'svg'
    || ((lang === 'xml' || lang === 'html' || lang === 'htm' || lang === '')
      && /^(?:<\?xml[^>]*\?>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg\b[\s\S]*<\/svg>$/i.test(trimmed))
  ) {
    if (/<svg\b[\s\S]*<\/svg>/i.test(trimmed)) return 'svg';
  }

  if (lang === 'html' || lang === 'htm') {
    if (HTML_TAG_PATTERN.test(trimmed) && trimmed.includes('>')) return 'html';
  }

  return undefined;
}

const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none';";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";

export function buildArtifactSandboxSrcdoc(kind: PreviewableArtifactKind, rawSource: string): string {
  const source = rawSource.trim();
  if (kind === 'svg') {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${SVG_CSP}">`,
      '<style>',
      'html,body{margin:0;min-height:100%;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif}',
      'svg{max-width:100%;height:auto;display:block}',
      '</style>',
      '</head>',
      `<body>${source}</body>`,
      '</html>',
    ].join('');
  }

  const cspMeta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
  if (/<!doctype\s+html/i.test(source) || /<html\b/i.test(source)) {
    if (/<head\b[^>]*>/i.test(source)) {
      return source.replace(/<head\b[^>]*>/i, match => `${match}${cspMeta}`);
    }
    return `<!doctype html><html><head>${cspMeta}</head>${source}</html>`;
  }

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    cspMeta,
    '<style>',
    'html{box-sizing:border-box;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.5;color:#0f172a;background:#ffffff}',
    '*,*::before,*::after{box-sizing:inherit}',
    'body{margin:0;padding:16px}',
    '</style>',
    '</head>',
    `<body>${source}</body>`,
    '</html>',
  ].join('');
}

export function flattenMarkdownInlines(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map(node => (node.type === 'strong' && node.content ? flattenMarkdownInlines(node.content) : node.text))
    .join('');
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n');
  // 防止 Excel / WPS 表格将 `=`, `+`, `-`, `@` 开头的单元格当作公式执行（CSV Formula Injection 防护）
  const safe = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function markdownTableToTsv(
  headers: readonly (readonly MarkdownInline[])[],
  rows: readonly (readonly (readonly MarkdownInline[])[])[],
): string {
  const allRows = [headers, ...rows];
  return allRows
    .map(row => row.map(cell => flattenMarkdownInlines(cell).replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
    .join('\n');
}

export function markdownTableToCsv(
  headers: readonly (readonly MarkdownInline[])[],
  rows: readonly (readonly (readonly MarkdownInline[])[])[],
): string {
  const allRows = [headers, ...rows];
  const body = allRows
    .map(row => row.map(cell => escapeCsvCell(flattenMarkdownInlines(cell).trim())).join(','))
    .join('\r\n');
  return `\uFEFF${body}`;
}

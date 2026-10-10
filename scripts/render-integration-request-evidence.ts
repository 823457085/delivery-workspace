/**
 * 设计说明：窗口截图不可用时，将同次浏览器 Network 记录呈现为可截图的独立证据页。
 * 只展示已采集事实，不发接口、不生成图片；明确标注来源，避免将报告误认作原生 DevTools。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { redactFeedback } from '../server/wecom-integration.js';

const headers = z.record(z.string(), z.string()).default({});
const httpUrl = z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), '需要实际 HTTP(S) 地址');
const evidenceSchema = z.object({
  source: z.literal('browser-cdp'), batchId: z.string().trim().min(1).max(100),
  capturedAt: z.iso.datetime(), pageUrl: httpUrl,
  request: z.object({ requestId: z.string().min(1), method: z.literal('GET'), url: httpUrl, headers, postData: z.string().optional() }).strict(),
  response: z.object({ status: z.number().int().min(100).max(599), headers, body: z.unknown().refine(value => value !== undefined, '需要本次真实响应体') }).strict(),
}).strict().refine(data => new URL(data.pageUrl).origin === new URL(data.request.url).origin, '请求与页面需要来自同一本轮浏览器源');
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item !== 'boolean' && /^(authorization|cookie|set-cookie|.*password|.*passwd|.*token|.*secret|.*api[-_]?key|webhook|.*phone|.*mobile|.*email|.*idcard|.*bankcard)$/i.test(key) ? '[已脱敏]' : sanitize(item)]));
  return typeof value === 'string' ? redactFeedback(value).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已脱敏]') : value;
}

export function renderIntegrationRequestEvidence(input: unknown) {
  const parsed = evidenceSchema.parse(input);
  if (typeof parsed.response.body === 'string') {
    try { parsed.response.body = JSON.parse(parsed.response.body); }
    catch { /* 非 JSON 响应按原始文本展示。 */ }
  }
  const data = sanitize(parsed) as z.infer<typeof evidenceSchema>;
  const responseBody = typeof data.response.body === 'string' ? data.response.body : JSON.stringify(data.response.body, null, 2);
  const request = [data.request.method + ' ' + data.request.url, '', 'Headers', JSON.stringify(data.request.headers, null, 2), '', 'Body', data.request.postData ?? '无'].join('\n');
  const response = ['HTTP ' + data.response.status, '', 'Headers', JSON.stringify(data.response.headers, null, 2), '', 'Body', responseBody].join('\n');
  return [
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>浏览器请求证据 · ' + escape(data.batchId) + '</title>',
    '<style>body{margin:0;background:#f2f5f9;color:#172b4d;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{padding:24px;max-width:1600px;margin:auto}h1{font-size:22px;margin:0 0 8px}p{margin:6px 0;overflow-wrap:anywhere}.source{color:#526581}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px}section{min-width:0;background:white;border:1px solid #d6deea;border-radius:8px;padding:16px}h2{font-size:16px;margin:0 0 12px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:800px){.columns{grid-template-columns:1fr}}</style>',
    '<main><h1>浏览器请求证据</h1><p class="source">来源：本轮页面实际请求的 Chrome CDP Network 记录；独立证据页</p>',
    '<p>批次：' + escape(data.batchId) + ' · 采集：' + escape(data.capturedAt) + ' · requestId：' + escape(data.request.requestId) + '</p>',
    '<p>页面：' + escape(data.pageUrl) + '</p><div class="columns"><section><h2>请求 · Headers / 参数</h2><pre>' + escape(request) + '</pre></section>',
    '<section><h2>响应 · HTTP / Body</h2><pre>' + escape(response) + '</pre></section></div></main></html>',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , input, output] = process.argv;
    if (!input || !output || !output.endsWith('.html')) throw new Error('用法：tsx scripts/render-integration-request-evidence.ts 浏览器记录.json 证据.html');
    const html = renderIntegrationRequestEvidence(JSON.parse(await fs.readFile(input, 'utf8')));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, html);
    console.log(JSON.stringify({ report: output, source: 'browser-cdp' }));
  } catch (error) { console.error(error instanceof Error ? error.message : '证据页面生成失败'); process.exitCode = 1; }
}

/** 调试数据只驻留在当前页面和请求中，不写入接口契约或本机存储。 */
import { z } from 'zod';
import type { ApiOperationDetail } from './interface-center.js';

export interface ApiDebugField { name: string; value: string; enabled: boolean }
export interface ApiDebugHeader { name: string; value: string }
export type ApiDebugAuth = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'basic'; username: string; password: string };
export type ApiDebugBody = { kind: 'none' } | { kind: 'json'; text: string }
  | { kind: 'raw'; text: string; contentType: string } | { kind: 'urlencoded'; fields: ApiDebugField[] };
export interface ApiDebugRequest {
  operationKey: string; baseUrl: string; pathParameters: ApiDebugField[]; queryParameters: ApiDebugField[];
  headers: ApiDebugField[]; auth: ApiDebugAuth; body: ApiDebugBody; timeoutMs?: number;
}
export interface ApiDebugResult {
  method: string; url: string; status: number; statusText: string; headers: ApiDebugHeader[];
  body: string; bodyEncoding: 'utf8' | 'base64'; durationMs: number; sizeBytes: number; truncated: boolean;
}
export interface PreparedApiDebugRequest {
  method: string; url: string; headers: ApiDebugHeader[]; body?: string; timeoutMs: number;
}
// JSON 转义会放大 1 MB 的 Raw 请求体，外层 JSON 需要独立的上限。
export const apiDebugLimits = { requestBytes: 1024 * 1024, requestEnvelopeLength: 8 * 1024 * 1024, responseBytes: 2 * 1024 * 1024, headerBytes: 32 * 1024,
  urlLength: 16 * 1024, defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000 } as const;
const field = z.object({ name: z.string().max(1024), value: z.string().max(16 * 1024), enabled: z.boolean() }).strict();
const fields = z.array(field).max(150);
const requestSchema = z.object({
  operationKey: z.string().min(1).max(4096), baseUrl: z.string().min(1).max(apiDebugLimits.urlLength),
  pathParameters: fields.default([]), queryParameters: fields.default([]), headers: fields.default([]),
  auth: z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('bearer'), token: z.string().max(16 * 1024) }).strict(),
    z.object({ kind: z.literal('basic'), username: z.string().max(4096), password: z.string().max(16 * 1024) }).strict()]).default({ kind: 'none' }),
  body: z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('json'), text: z.string().max(apiDebugLimits.requestBytes) }).strict(),
    z.object({ kind: z.literal('raw'), text: z.string().max(apiDebugLimits.requestBytes), contentType: z.string().max(1024) }).strict(),
    z.object({ kind: z.literal('urlencoded'), fields }).strict()]).default({ kind: 'none' }),
  timeoutMs: z.number().int().min(100).max(apiDebugLimits.maxTimeoutMs).default(apiDebugLimits.defaultTimeoutMs),
}).strict();
const encoder = new TextEncoder();
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
const forbiddenHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'expect', 'trailer',
  'te', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'accept-encoding']);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const isDebugJsonMediaType = (value: string) => /^[\w.+-]+\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(value);

export function parseApiDebugRequest(value: unknown): ApiDebugRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error('调试请求格式无效，请核对参数数量、请求体大小和超时（100–60000 毫秒）');
  return parsed.data;
}

export function parseApiDebugBaseUrl(value: string): URL {
  if (/[\\\u0000-\u0020\u007f]/.test(value)) throw new Error('服务地址不能包含空白、控制字符或反斜杠');
  let target: URL;
  try { target = new URL(value); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 服务地址'); }
  if (!['http:', 'https:'].includes(target.protocol) || !target.hostname || target.username || target.password || target.search || target.hash
      || /[{}]|%7[bd]/i.test(value)) {
    throw new Error('请输入实际环境的 HTTP 或 HTTPS 服务地址，填写地址中的变量，并移除凭据、查询参数或片段');
  }
  if (/(^|\.)example\.(?:com|net|org)\.?$|\.example\.?$/i.test(target.hostname)) {
    throw new Error('该服务地址是文档示例，请填写实际联调环境的地址');
  }
  return target;
}

/** 浏览器预览/cURL 与服务端执行使用同一套 URL、参数和鉴权构造规则。 */
export function prepareApiDebugRequest(detail: ApiOperationDetail, raw: unknown): PreparedApiDebugRequest {
  const input = parseApiDebugRequest(raw);
  if (input.operationKey !== detail.key) throw new Error('接口已变化，请重新选择接口后调试');
  const method = detail.method.toUpperCase();
  if (!methods.has(method)) throw new Error('接口契约中的 HTTP 方法不支持调试');
  if (!detail.path.startsWith('/') || detail.path.startsWith('//') || /[\\?#\u0000-\u001f\u007f]/.test(detail.path)) throw new Error('接口契约中的路径无效');
  const target = parseApiDebugBaseUrl(input.baseUrl);
  const paths = new Map<string, string>();
  for (const item of input.pathParameters.filter(item => item.enabled)) {
    if (paths.has(item.name)) throw new Error(`路径参数重复：${item.name}`);
    paths.set(item.name, item.value);
  }
  const pathname = detail.path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = paths.get(name);
    if (value === undefined || !value.trim()) throw new Error(`请填写路径参数：${name}`);
    return encodeURIComponent(value);
  });
  if (/[{}]/.test(pathname) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(pathname)) throw new Error('路径参数不能生成空占位符或相对路径段');
  target.pathname = target.pathname.replace(/\/$/, '') + pathname;
  const required = new Set<string>();
  for (const parameter of detail.parameters.map(record)) {
    if (parameter.required !== true || typeof parameter.name !== 'string') continue;
    if (parameter.in === 'query' && parameter.allowEmptyValue !== true) required.add(`query:${parameter.name}`);
    if (parameter.in === 'header') required.add(`header:${parameter.name.toLowerCase()}`);
  }
  for (const item of input.queryParameters.filter(item => item.enabled)) {
    if (!item.name.trim()) throw new Error('已启用的查询参数需要填写名称');
    if (!item.value.trim() && required.has(`query:${item.name}`)) throw new Error(`请填写必填查询参数：${item.name}`);
    target.searchParams.append(item.name, item.value);
  }
  if (target.href.length > apiDebugLimits.urlLength) throw new Error('请求地址不能超过 16 KB');
  const headers = new Map<string, ApiDebugHeader>();
  function setHeader(name: string, value: string) {
    if (!headerName.test(name) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error('请求头名称或值包含无效字符');
    const lower = name.toLowerCase();
    if (forbiddenHeaders.has(lower)) throw new Error(`请求头由 HTTP 客户端管理：${name}`);
    if (headers.has(lower)) throw new Error(`请求头重复：${name}`);
    headers.set(lower, { name, value });
  }
  for (const item of input.headers.filter(item => item.enabled)) {
    const name = item.name.toLowerCase();
    if (name === 'authorization' && input.auth.kind !== 'none' && !item.value.trim()) continue;
    if (!item.value.trim() && required.has(`header:${name}`)) throw new Error(`请填写必填请求头：${item.name}`);
    setHeader(item.name, item.value);
  }
  if (input.auth.kind === 'bearer') {
    if (!input.auth.token || /\s/.test(input.auth.token)) throw new Error('Bearer Token 不能为空或包含空白字符');
    setHeader('Authorization', `Bearer ${input.auth.token}`);
  } else if (input.auth.kind === 'basic') {
    if (input.auth.username.includes(':')) throw new Error('Basic 用户名不能包含冒号');
    const bytes = encoder.encode(`${input.auth.username}:${input.auth.password}`);
    setHeader('Authorization', `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`);
  }
  let body: string | undefined, contentType = '';
  if (input.body.kind !== 'none') {
    const content = record(record(detail.requestBody).content);
    if (['GET', 'HEAD', 'TRACE'].includes(method)) throw new Error(`${method} 请求不发送请求体`);
    if (input.body.kind === 'json') {
      try { JSON.parse(input.body.text); } catch { throw new Error('JSON 请求体格式不正确'); }
      body = input.body.text; contentType = Object.keys(content).find(isDebugJsonMediaType) || 'application/json';
    } else if (input.body.kind === 'raw') { body = input.body.text; contentType = input.body.contentType || 'text/plain'; }
    else {
      const form = new URLSearchParams();
      const schema = record(record(content['application/x-www-form-urlencoded']).schema);
      const requiredFields = Array.isArray(schema.required) ? new Set(schema.required) : undefined;
      for (const item of input.body.fields.filter(item => item.enabled)) {
        if (!item.name.trim()) throw new Error('已启用的表单字段需要填写名称');
        if (!item.value.trim() && requiredFields?.has(item.name)) throw new Error(`请填写必填表单字段：${item.name}`);
        form.append(item.name, item.value);
      }
      body = form.toString(); contentType = 'application/x-www-form-urlencoded';
    }
    if (encoder.encode(body).byteLength > apiDebugLimits.requestBytes) throw new Error('请求体不能超过 1 MB');
    if (!headers.has('content-type')) setHeader('Content-Type', contentType);
  }
  const resultHeaders = [...headers.values()];
  if (encoder.encode(resultHeaders.map(item => `${item.name}: ${item.value}\r\n`).join('')).byteLength > apiDebugLimits.headerBytes) throw new Error('请求头总大小不能超过 32 KB');
  return { method, url: target.href, headers: resultHeaders, ...(body === undefined ? {} : { body }), timeoutMs: input.timeoutMs! };
}

export function apiDebugCurl(request: PreparedApiDebugRequest): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const parts = ['curl', request.method === 'HEAD' ? '--head' : `--request ${quote(request.method)}`, `--url ${quote(request.url)}`,
    `--max-time ${quote(String(request.timeoutMs / 1000))}`, '--header \'Accept-Encoding: identity\''];
  for (const header of request.headers) parts.push(`--header ${quote(header.value === '' ? `${header.name};` : `${header.name}: ${header.value}`)}`);
  if (request.body !== undefined) parts.push(`--data-binary ${quote(request.body)}`);
  return parts.join(' \\\n  ');
}

/**
 * API Debug Intelligence: cURL Reverse Importer, Live OpenAPI Response Validator & Semantic Diff Checker
 *
 * 借鉴 Hoppscotch (hoppscotch/hoppscotch)、Bruno (usebruno/bruno) 与 Scalar (scalar/scalar)：
 * 1. 支持将浏览器 DevTools「Copy as cURL」或后端日志中的 cURL 命令一键反向解析为结构化联调表单（自动剥离路径参数、Query、Bearer/Basic 鉴权、JSON/表单请求体及 HTTP/2 伪头）；
 * 2. 针对真实 HTTP 响应实时执行 OpenAPI 3.x 契约断言（状态码、Content-Type、必填字段、字段类型与枚举约束）；
 * 3. 支持将任意一次响应固定为「对比基准 (Baseline)」，对改代码前后或跨环境的两次响应做 JSON 语义级字段对比。
 */

import type { ApiOperationDetail, ApiProject } from './interface-center.js';
import {
  isDebugJsonMediaType,
  type ApiDebugAuth,
  type ApiDebugBody,
  type ApiDebugField,
  type ApiDebugResult,
} from './interface-center-debug.js';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const HOP_BY_HOP_OR_MANAGED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'expect',
  'trailer',
  'te',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'accept-encoding',
]);

const VALID_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface ParsedCurlDebugDraft {
  method: string;
  baseUrl: string;
  pathParameters: ApiDebugField[];
  queryParameters: ApiDebugField[];
  headers: ApiDebugField[];
  auth: ApiDebugAuth;
  body: ApiDebugBody;
  methodMismatchWarning?: string;
}

/**
 * 解析 Shell 参数序列：支持单引号（含 '\''）、双引号转义、ANSI-C $'...' 转义与反斜杠续行。
 */
export function tokenizeShellCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i]!;

    // 空白分隔符
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      i += 1;
      continue;
    }

    // 反斜杠续行或字符转义
    if (ch === '\\') {
      if (raw[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (raw[i + 1] === '\r' && raw[i + 2] === '\n') {
        i += 3;
        continue;
      }
      hasToken = true;
      if (i + 1 < raw.length) {
        current += raw[i + 1]!;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // ANSI-C $'...' 引号（Chrome DevTools Copy as cURL 常用）
    if (ch === '$' && raw[i + 1] === "'") {
      hasToken = true;
      i += 2;
      while (i < raw.length && raw[i] !== "'") {
        if (raw[i] === '\\' && i + 1 < raw.length) {
          const esc = raw[i + 1]!;
          if (esc === 'n') { current += '\n'; i += 2; }
          else if (esc === 'r') { current += '\r'; i += 2; }
          else if (esc === 't') { current += '\t'; i += 2; }
          else if (esc === "'" || esc === '\\' || esc === '"') { current += esc; i += 2; }
          else if (esc === 'u' && /^[0-9a-fA-F]{4}/.test(raw.slice(i + 2, i + 6))) {
            current += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (esc === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 2, i + 4))) {
            current += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16));
            i += 4;
          } else {
            current += esc;
            i += 2;
          }
        } else {
          current += raw[i]!;
          i += 1;
        }
      }
      if (raw[i] === "'") i += 1;
      continue;
    }

    // 单引号 '...'
    if (ch === "'") {
      hasToken = true;
      i += 1;
      while (i < raw.length && raw[i] !== "'") {
        current += raw[i]!;
        i += 1;
      }
      if (raw[i] === "'") i += 1;
      continue;
    }

    // 双引号 "..."
    if (ch === '"') {
      hasToken = true;
      i += 1;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\' && i + 1 < raw.length) {
          const next = raw[i + 1]!;
          if (next === '\n') { i += 2; continue; }
          if (next === '\r' && raw[i + 2] === '\n') { i += 3; continue; }
          if (next === 'n') { current += '\n'; i += 2; continue; }
          if (next === 't') { current += '\t'; i += 2; continue; }
          if (next === 'r') { current += '\r'; i += 2; continue; }
          current += next;
          i += 2;
        } else {
          current += raw[i]!;
          i += 1;
        }
      }
      if (raw[i] === '"') i += 1;
      continue;
    }

    hasToken = true;
    current += ch;
    i += 1;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

function decodeBasicCredentials(encoded: string): { username: string; password: string } | null {
  try {
    const decoded = atob(encoded.trim());
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return { username: decoded, password: '' };
    return {
      username: decoded.slice(0, colonIdx),
      password: decoded.slice(colonIdx + 1),
    };
  } catch {
    return null;
  }
}

function matchOpenApiPathTemplate(
  urlPathname: string,
  templatePath?: string,
): { basePrefix: string; pathParameters: ApiDebugField[] } {
  if (!templatePath || !templatePath.startsWith('/')) {
    return { basePrefix: '', pathParameters: [] };
  }

  const cleanTemplate = templatePath.replace(/\/+$/, '') || '/';
  const cleanActual = urlPathname.replace(/\/+$/, '') || '/';
  const templateSegments = cleanTemplate.split('/').filter(Boolean);
  const actualSegments = cleanActual.split('/').filter(Boolean);

  if (actualSegments.length < templateSegments.length) {
    return { basePrefix: '', pathParameters: [] };
  }

  const offset = actualSegments.length - templateSegments.length;
  const extracted: ApiDebugField[] = [];

  for (let idx = 0; idx < templateSegments.length; idx++) {
    const tplSeg = templateSegments[idx]!;
    const actSeg = actualSegments[offset + idx]!;
    const paramMatch = /^\{([^{}]+)\}$/.exec(tplSeg);
    if (paramMatch) {
      let decoded = actSeg;
      try { decoded = decodeURIComponent(actSeg); } catch { /* 保留原值 */ }
      extracted.push({ name: paramMatch[1]!, value: decoded, enabled: true });
    } else if (tplSeg !== actSeg) {
      return { basePrefix: '', pathParameters: [] };
    }
  }

  const prefixSegments = actualSegments.slice(0, offset);
  const basePrefix = prefixSegments.length ? `/${prefixSegments.join('/')}` : '';
  return { basePrefix, pathParameters: extracted };
}

/**
 * 将粘贴的 cURL 命令反向解析为 RequestDebugger 可直接回填的字段草稿。
 */
export function parseCurlCommandToDebugDraft(
  rawCurl: string,
  detail?: Pick<ApiOperationDetail, 'method' | 'path'>,
): ParsedCurlDebugDraft {
  const trimmed = rawCurl.trim();
  if (!trimmed) {
    throw new Error('请粘贴包含 http/https 地址的 cURL 命令');
  }

  const tokens = tokenizeShellCommand(trimmed);
  if (!tokens.length) {
    throw new Error('未能解析出有效的 cURL 参数');
  }

  let startIdx = 0;
  if (/^curl(?:\.exe)?$/i.test(tokens[0]!)) {
    startIdx = 1;
  }

  let explicitMethod = '';
  let rawUrl = '';
  let forceGet = false;
  let basicUserPass = '';
  const rawHeaders: { name: string; value: string }[] = [];
  const dataChunks: string[] = [];
  const urlencodedChunks: string[] = [];

  const takeValue = (idx: number, inlineVal?: string): [string, number] => {
    if (inlineVal !== undefined) return [inlineVal, idx];
    if (idx + 1 >= tokens.length) throw new Error(`cURL 参数 ${tokens[idx]} 缺少对应值`);
    return [tokens[idx + 1]!, idx + 1];
  };

  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const eqIdx = tok.indexOf('=');
    const flag = tok.startsWith('--') && eqIdx > 2 ? tok.slice(0, eqIdx) : tok;
    const inlineVal = tok.startsWith('--') && eqIdx > 2 ? tok.slice(eqIdx + 1) : undefined;

    if (flag === '-X' || flag === '--request') {
      const [val, next] = takeValue(i, inlineVal);
      explicitMethod = val.trim().toUpperCase();
      i = next;
    } else if (flag === '--url') {
      const [val, next] = takeValue(i, inlineVal);
      rawUrl = val.trim();
      i = next;
    } else if (flag === '-H' || flag === '--header') {
      const [val, next] = takeValue(i, inlineVal);
      i = next;
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        const hName = val.slice(0, colonIdx).trim();
        const hValue = val.slice(colonIdx + 1).trim();
        if (hName) rawHeaders.push({ name: hName, value: hValue });
      } else if (val.endsWith(';') && val.length > 1) {
        const hName = val.slice(0, -1).trim();
        if (hName) rawHeaders.push({ name: hName, value: '' });
      }
    } else if (
      flag === '-d'
      || flag === '--data'
      || flag === '--data-raw'
      || flag === '--data-binary'
      || flag === '--data-ascii'
    ) {
      const [val, next] = takeValue(i, inlineVal);
      dataChunks.push(val);
      i = next;
    } else if (flag === '--data-urlencode') {
      const [val, next] = takeValue(i, inlineVal);
      urlencodedChunks.push(val);
      i = next;
    } else if (flag === '-G' || flag === '--get') {
      forceGet = true;
    } else if (flag === '-u' || flag === '--user') {
      const [val, next] = takeValue(i, inlineVal);
      basicUserPass = val;
      i = next;
    } else if (flag === '-b' || flag === '--cookie') {
      const [val, next] = takeValue(i, inlineVal);
      if (val.trim()) rawHeaders.push({ name: 'Cookie', value: val.trim() });
      i = next;
    } else if (flag === '-A' || flag === '--user-agent') {
      const [val, next] = takeValue(i, inlineVal);
      if (val.trim()) rawHeaders.push({ name: 'User-Agent', value: val.trim() });
      i = next;
    } else if (flag === '-I' || flag === '--head') {
      if (!explicitMethod) explicitMethod = 'HEAD';
    } else if (
      flag === '-o'
      || flag === '--output'
      || flag === '--connect-timeout'
      || flag === '-m'
      || flag === '--max-time'
      || flag === '-x'
      || flag === '--proxy'
      || flag === '-e'
      || flag === '--referer'
    ) {
      const [val, next] = takeValue(i, inlineVal);
      if ((flag === '-e' || flag === '--referer') && val.trim()) {
        rawHeaders.push({ name: 'Referer', value: val.trim() });
      }
      i = next;
    } else if (!tok.startsWith('-') && /^https?:\/\//i.test(tok) && !rawUrl) {
      rawUrl = tok.trim();
    }
  }

  if (!rawUrl) {
    throw new Error('未在 cURL 命令中找到有效的 HTTP/HTTPS 地址');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`cURL 中的 URL 格式无效：${rawUrl}`);
  }

  const hasPayload = dataChunks.length > 0 || urlencodedChunks.length > 0;
  const inferredMethod = explicitMethod || (forceGet ? 'GET' : hasPayload ? 'POST' : 'GET');

  const queryParameters: ApiDebugField[] = [];
  parsedUrl.searchParams.forEach((value, name) => {
    queryParameters.push({ name, value, enabled: true });
  });

  if (forceGet && hasPayload) {
    for (const chunk of [...dataChunks, ...urlencodedChunks]) {
      const params = new URLSearchParams(chunk);
      params.forEach((value, name) => {
        queryParameters.push({ name, value, enabled: true });
      });
    }
  }

  const { basePrefix, pathParameters } = matchOpenApiPathTemplate(parsedUrl.pathname, detail?.path);
  const baseUrl = `${parsedUrl.origin}${basePrefix}`;

  let auth: ApiDebugAuth = { kind: 'none' };
  if (basicUserPass) {
    const colon = basicUserPass.indexOf(':');
    auth = colon >= 0
      ? { kind: 'basic', username: basicUserPass.slice(0, colon), password: basicUserPass.slice(colon + 1) }
      : { kind: 'basic', username: basicUserPass, password: '' };
  } else if (parsedUrl.username) {
    auth = {
      kind: 'basic',
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password || ''),
    };
  }

  let contentTypeHeader = '';
  const headers: ApiDebugField[] = [];
  const seenHeaders = new Set<string>();

  for (const h of rawHeaders) {
    // 跳过 HTTP/2 伪首部（如 :authority）与浏览器底层受管首部
    if (h.name.startsWith(':') || !VALID_HEADER_NAME.test(h.name)) continue;
    const lower = h.name.toLowerCase();
    if (HOP_BY_HOP_OR_MANAGED_HEADERS.has(lower)) continue;

    if (lower === 'authorization') {
      const bearerMatch = /^Bearer\s+(\S+)$/i.exec(h.value);
      const basicMatch = /^Basic\s+(\S+)$/i.exec(h.value);
      if (bearerMatch) {
        auth = { kind: 'bearer', token: bearerMatch[1]! };
        continue;
      }
      if (basicMatch) {
        const creds = decodeBasicCredentials(basicMatch[1]!);
        if (creds) {
          auth = { kind: 'basic', username: creds.username, password: creds.password };
          continue;
        }
      }
    }

    if (lower === 'content-type') {
      contentTypeHeader = h.value;
      continue;
    }

    if (seenHeaders.has(lower)) continue;
    seenHeaders.add(lower);
    headers.push({ name: h.name, value: h.value, enabled: true });
  }

  let body: ApiDebugBody = { kind: 'none' };
  if (!forceGet && hasPayload && !['GET', 'HEAD', 'TRACE'].includes(detail?.method?.toUpperCase() || inferredMethod)) {
    if (urlencodedChunks.length > 0 && dataChunks.length === 0) {
      const fields: ApiDebugField[] = [];
      for (const item of urlencodedChunks) {
        const eq = item.indexOf('=');
        if (eq >= 0) {
          fields.push({ name: item.slice(0, eq), value: item.slice(eq + 1), enabled: true });
        } else {
          fields.push({ name: item, value: '', enabled: true });
        }
      }
      body = { kind: 'urlencoded', fields };
    } else {
      const combined = [...dataChunks, ...urlencodedChunks].join('&');
      if (/x-www-form-urlencoded/i.test(contentTypeHeader)) {
        const params = new URLSearchParams(combined);
        const fields: ApiDebugField[] = [];
        params.forEach((value, name) => {
          fields.push({ name, value, enabled: true });
        });
        body = { kind: 'urlencoded', fields };
      } else {
        let parsedJson: unknown;
        let isJson = false;
        try {
          parsedJson = JSON.parse(combined);
          isJson = true;
        } catch {
          isJson = false;
        }
        if (isJson || isDebugJsonMediaType(contentTypeHeader)) {
          body = {
            kind: 'json',
            text: isJson ? JSON.stringify(parsedJson, null, 2) : combined,
          };
        } else {
          body = {
            kind: 'raw',
            text: combined,
            contentType: contentTypeHeader || 'text/plain',
          };
        }
      }
    }
  }

  const expectedMethod = detail?.method?.toUpperCase();
  const methodMismatchWarning = expectedMethod && inferredMethod !== expectedMethod
    ? `导入的 cURL 方法为 ${inferredMethod}，当前接口契约为 ${expectedMethod}（已按当前接口方法保留参数）`
    : undefined;

  return {
    method: inferredMethod,
    baseUrl,
    pathParameters,
    queryParameters,
    headers,
    auth,
    body,
    ...(methodMismatchWarning ? { methodMismatchWarning } : {}),
  };
}

export interface ContractAssertionIssue {
  severity: 'error' | 'warning';
  jsonPath: string;
  expected: string;
  actual: string;
  message: string;
}

export interface ContractAssertionCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ContractAssertionReport {
  passed: boolean;
  matchedStatusKey: string | null;
  checkedCount: number;
  passedCount: number;
  checks: ContractAssertionCheck[];
  issues: ContractAssertionIssue[];
  summary: string;
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateJsonValueAgainstSchema(
  value: unknown,
  schemaRaw: Record<string, unknown>,
  jsonPath: string,
  issues: ContractAssertionIssue[],
  depth = 0,
): void {
  if (!Object.keys(schemaRaw).length || depth > 5 || issues.length >= 25) return;

  if (value === null) {
    const rawType = schemaRaw.type;
    const allowsNull = schemaRaw.nullable === true
      || rawType === 'null'
      || (Array.isArray(rawType) && rawType.includes('null'));
    if (!allowsNull && rawType !== undefined) {
      issues.push({
        severity: 'error',
        jsonPath,
        expected: `${Array.isArray(rawType) ? rawType.join('|') : String(rawType)} (非空)`,
        actual: 'null',
        message: `${jsonPath} 返回了 null，但契约未声明 nullable`,
      });
    }
    return;
  }

  if (Array.isArray(schemaRaw.enum) && schemaRaw.enum.length > 0) {
    const matched = schemaRaw.enum.some(item => item === value);
    if (!matched) {
      issues.push({
        severity: 'error',
        jsonPath,
        expected: `enum [${schemaRaw.enum.map(v => JSON.stringify(v)).join(', ')}]`,
        actual: JSON.stringify(value),
        message: `${jsonPath} 值 ${JSON.stringify(value)} 不在契约枚举集合内`,
      });
      return;
    }
  }

  const rawType = schemaRaw.type;
  const allowedTypes = Array.isArray(rawType)
    ? rawType.map(String)
    : typeof rawType === 'string'
      ? [rawType]
      : [];

  const actualType = describeRuntimeType(value);
  if (allowedTypes.length > 0) {
    const typeOk = allowedTypes.some((expected) => {
      if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (expected === 'array') return Array.isArray(value);
      if (expected === 'object') return actualType === 'object';
      return actualType === expected;
    });
    if (!typeOk) {
      issues.push({
        severity: 'error',
        jsonPath,
        expected: allowedTypes.join(' | '),
        actual: typeof value === 'number' ? `number (${value})` : actualType,
        message: `${jsonPath} 类型不匹配：期望 ${allowedTypes.join('|')}，实测为 ${actualType}`,
      });
      return;
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = asRecord(schemaRaw.items);
    if (Object.keys(itemSchema).length) {
      const sampleCount = Math.min(value.length, 5);
      for (let idx = 0; idx < sampleCount; idx++) {
        validateJsonValueAgainstSchema(value[idx], itemSchema, `${jsonPath}[${idx}]`, issues, depth + 1);
        if (issues.length >= 25) return;
      }
    }
    return;
  }

  if (actualType === 'object') {
    const obj = value as Record<string, unknown>;
    const requiredFields = Array.isArray(schemaRaw.required) ? schemaRaw.required.map(String) : [];
    for (const reqKey of requiredFields) {
      if (!(reqKey in obj) || obj[reqKey] === undefined) {
        issues.push({
          severity: 'error',
          jsonPath: `${jsonPath}.${reqKey}`,
          expected: '必填字段存在',
          actual: '缺失 (undefined)',
          message: `${jsonPath} 缺少契约必填字段 "${reqKey}"`,
        });
        if (issues.length >= 25) return;
      }
    }

    const properties = asRecord(schemaRaw.properties);
    for (const [propKey, propSchemaRaw] of Object.entries(properties)) {
      if (propKey in obj && obj[propKey] !== undefined) {
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propKey)
          ? `${jsonPath}.${propKey}`
          : `${jsonPath}[${JSON.stringify(propKey)}]`;
        validateJsonValueAgainstSchema(obj[propKey], asRecord(propSchemaRaw), childPath, issues, depth + 1);
        if (issues.length >= 25) return;
      }
    }
  }
}

/**
 * 对真实 HTTP 调试响应执行实时 OpenAPI 契约断言核验。
 */
export function validateResponseAgainstOpenApi(
  detail: ApiOperationDetail,
  response: Pick<ApiDebugResult, 'status' | 'headers' | 'body' | 'bodyEncoding'>,
): ContractAssertionReport {
  const responses = asRecord(detail.responses);
  const statusStr = String(response.status);
  const wildcardUpper = `${Math.floor(response.status / 100)}XX`;
  const wildcardLower = `${Math.floor(response.status / 100)}xx`;
  const matchedStatusKey = statusStr in responses
    ? statusStr
    : wildcardUpper in responses
      ? wildcardUpper
      : wildcardLower in responses
        ? wildcardLower
        : 'default' in responses
          ? 'default'
          : null;

  const checks: ContractAssertionCheck[] = [];
  const issues: ContractAssertionIssue[] = [];

  const declaredCodes = Object.keys(responses);
  if (declaredCodes.length > 0) {
    const statusOk = matchedStatusKey !== null;
    checks.push({
      id: 'status-code',
      label: 'HTTP 状态码契约',
      passed: statusOk,
      detail: statusOk
        ? `状态码 ${response.status} 命中契约定义 (${matchedStatusKey})`
        : `状态码 ${response.status} 未在契约 [${declaredCodes.join(', ')}] 中声明`,
    });
    if (!statusOk) {
      issues.push({
        severity: 'error',
        jsonPath: '$status',
        expected: declaredCodes.join(' | '),
        actual: statusStr,
        message: `返回状态码 ${response.status} 未在接口契约响应列表中声明`,
      });
    }
  } else {
    const okRange = response.status >= 200 && response.status < 300;
    checks.push({
      id: 'status-code',
      label: 'HTTP 状态码范围',
      passed: okRange,
      detail: `契约未显式定义响应码，实测状态码 ${response.status}`,
    });
  }

  const respSpec = matchedStatusKey ? asRecord(responses[matchedStatusKey]) : {};
  const contentSpec = asRecord(respSpec.content);
  const declaredMimes = Object.keys(contentSpec);
  const actualContentType = response.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  const actualMimeBase = actualContentType.split(';')[0]?.trim().toLowerCase() || '';

  let matchedMimeKey: string | undefined;
  if (declaredMimes.length > 0) {
    matchedMimeKey = declaredMimes.find((m) => {
      const clean = m.split(';')[0]?.trim().toLowerCase() || '';
      return clean === actualMimeBase || (clean === '*/*') || (isDebugJsonMediaType(clean) && isDebugJsonMediaType(actualMimeBase));
    });
    const mimeOk = Boolean(matchedMimeKey);
    checks.push({
      id: 'content-type',
      label: '响应 Content-Type',
      passed: mimeOk,
      detail: mimeOk
        ? `Content-Type (${actualMimeBase || '未标明'}) 符合契约 (${matchedMimeKey})`
        : `实测 Content-Type "${actualMimeBase || '空'}" 与契约 [${declaredMimes.join(', ')}] 不一致`,
    });
    if (!mimeOk) {
      issues.push({
        severity: 'warning',
        jsonPath: '$headers.content-type',
        expected: declaredMimes.join(' | '),
        actual: actualMimeBase || '(缺失)',
        message: `响应头 Content-Type 与契约声明不一致`,
      });
    }
  }

  const jsonMimeKey = matchedMimeKey && isDebugJsonMediaType(matchedMimeKey)
    ? matchedMimeKey
    : declaredMimes.find(isDebugJsonMediaType);
  const jsonSchema = jsonMimeKey ? asRecord(asRecord(contentSpec[jsonMimeKey]).schema) : {};
  const expectsJson = Boolean(jsonMimeKey) || isDebugJsonMediaType(actualMimeBase);

  if (expectsJson && response.bodyEncoding === 'utf8' && response.body.trim()) {
    let parsedBody: unknown;
    let jsonValid = false;
    try {
      parsedBody = JSON.parse(response.body);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
    checks.push({
      id: 'json-syntax',
      label: 'JSON 语法合法性',
      passed: jsonValid,
      detail: jsonValid ? '响应体可正常解析为 JSON' : '响应体无法解析为合法 JSON',
    });
    if (!jsonValid) {
      issues.push({
        severity: 'error',
        jsonPath: '$',
        expected: '合法 JSON 文本',
        actual: response.body.slice(0, 80),
        message: '响应体不是合法的 JSON 格式',
      });
    } else if (Object.keys(jsonSchema).length > 0) {
      const beforeIssues = issues.length;
      validateJsonValueAgainstSchema(parsedBody, jsonSchema, '$', issues, 0);
      const schemaIssuesCount = issues.length - beforeIssues;
      checks.push({
        id: 'json-schema',
        label: 'JSON Schema 字段与类型契约',
        passed: schemaIssuesCount === 0,
        detail: schemaIssuesCount === 0
          ? '必填字段、嵌套结构、类型与枚举全部符合契约'
          : `发现 ${schemaIssuesCount} 处字段缺失或类型/枚举偏差`,
      });
    }
  }

  const passedCount = checks.filter(c => c.passed).length;
  const checkedCount = checks.length;
  const passed = issues.filter(i => i.severity === 'error').length === 0 && passedCount === checkedCount;
  const summary = passed
    ? `契约核验通过 (${passedCount}/${checkedCount})`
    : `发现 ${issues.length} 项契约偏差 (${passedCount}/${checkedCount} 通过)`;

  return {
    passed,
    matchedStatusKey,
    checkedCount,
    passedCount,
    checks,
    issues,
    summary,
  };
}

export type JsonDiffChangeKind = 'added' | 'removed' | 'type_changed' | 'value_changed';

export interface JsonSemanticDiffEntry {
  path: string;
  kind: JsonDiffChangeKind;
  beforePreview: string;
  afterPreview: string;
}

export interface ResponseDiffReport {
  identical: boolean;
  isJsonDiff: boolean;
  statusChanged: boolean;
  baselineStatus: number;
  currentStatus: number;
  durationDeltaMs: number;
  sizeDeltaBytes: number;
  changes: JsonSemanticDiffEntry[];
  truncated: boolean;
  summary: string;
}

function previewScalarOrComposite(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value.length > 48 ? `${JSON.stringify(value.slice(0, 45))}…` : JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(asRecord(value));
  return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
}

function walkJsonDiff(
  beforeVal: unknown,
  afterVal: unknown,
  currentPath: string,
  changes: JsonSemanticDiffEntry[],
  state: { truncated: boolean },
  depth = 0,
): void {
  if (Object.is(beforeVal, afterVal)) return;
  if (changes.length >= 60) {
    state.truncated = true;
    return;
  }

  const beforeType = describeRuntimeType(beforeVal);
  const afterType = describeRuntimeType(afterVal);

  if (beforeType !== afterType) {
    changes.push({
      path: currentPath,
      kind: 'type_changed',
      beforePreview: `${beforeType} (${previewScalarOrComposite(beforeVal)})`,
      afterPreview: `${afterType} (${previewScalarOrComposite(afterVal)})`,
    });
    return;
  }

  if (depth >= 6) {
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes.push({
        path: currentPath,
        kind: 'value_changed',
        beforePreview: previewScalarOrComposite(beforeVal),
        afterPreview: previewScalarOrComposite(afterVal),
      });
    }
    return;
  }

  if (Array.isArray(beforeVal) && Array.isArray(afterVal)) {
    const maxLen = Math.max(beforeVal.length, afterVal.length);
    for (let i = 0; i < maxLen; i++) {
      if (changes.length >= 60) { state.truncated = true; return; }
      const itemPath = `${currentPath}[${i}]`;
      if (i >= beforeVal.length) {
        changes.push({
          path: itemPath,
          kind: 'added',
          beforePreview: '—',
          afterPreview: previewScalarOrComposite(afterVal[i]),
        });
      } else if (i >= afterVal.length) {
        changes.push({
          path: itemPath,
          kind: 'removed',
          beforePreview: previewScalarOrComposite(beforeVal[i]),
          afterPreview: '—',
        });
      } else {
        walkJsonDiff(beforeVal[i], afterVal[i], itemPath, changes, state, depth + 1);
      }
    }
    return;
  }

  if (beforeType === 'object' && afterType === 'object') {
    const left = beforeVal as Record<string, unknown>;
    const right = afterVal as Record<string, unknown>;
    const allKeys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
    for (const key of allKeys) {
      if (changes.length >= 60) { state.truncated = true; return; }
      const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `${currentPath}.${key}`
        : `${currentPath}[${JSON.stringify(key)}]`;
      if (!(key in left)) {
        changes.push({
          path: childPath,
          kind: 'added',
          beforePreview: '—',
          afterPreview: previewScalarOrComposite(right[key]),
        });
      } else if (!(key in right)) {
        changes.push({
          path: childPath,
          kind: 'removed',
          beforePreview: previewScalarOrComposite(left[key]),
          afterPreview: '—',
        });
      } else {
        walkJsonDiff(left[key], right[key], childPath, changes, state, depth + 1);
      }
    }
    return;
  }

  changes.push({
    path: currentPath,
    kind: 'value_changed',
    beforePreview: previewScalarOrComposite(beforeVal),
    afterPreview: previewScalarOrComposite(afterVal),
  });
}

/**
 * 对比基准响应（Baseline）与当前实测响应的结构、状态码与耗时变化。
 */
export function compareApiDebugResponses(
  baseline: Pick<ApiDebugResult, 'status' | 'durationMs' | 'sizeBytes' | 'body' | 'bodyEncoding'>,
  current: Pick<ApiDebugResult, 'status' | 'durationMs' | 'sizeBytes' | 'body' | 'bodyEncoding'>,
): ResponseDiffReport {
  const statusChanged = baseline.status !== current.status;
  const durationDeltaMs = current.durationMs - baseline.durationMs;
  const sizeDeltaBytes = current.sizeBytes - baseline.sizeBytes;

  let isJsonDiff = false;
  const changes: JsonSemanticDiffEntry[] = [];
  const state = { truncated: false };

  if (baseline.bodyEncoding === 'utf8' && current.bodyEncoding === 'utf8') {
    try {
      const leftJson = JSON.parse(baseline.body);
      const rightJson = JSON.parse(current.body);
      isJsonDiff = true;
      walkJsonDiff(leftJson, rightJson, '$', changes, state, 0);
    } catch {
      isJsonDiff = false;
      if (baseline.body !== current.body) {
        changes.push({
          path: '$body',
          kind: 'value_changed',
          beforePreview: baseline.body.slice(0, 60) || '(空)',
          afterPreview: current.body.slice(0, 60) || '(空)',
        });
      }
    }
  } else if (baseline.body !== current.body) {
    changes.push({
      path: '$body (binary)',
      kind: 'value_changed',
      beforePreview: `${baseline.sizeBytes} B`,
      afterPreview: `${current.sizeBytes} B`,
    });
  }

  const identical = !statusChanged && changes.length === 0;
  const summary = identical
    ? '与基准响应完全一致（状态码与字段值无变化）'
    : `较基准共 ${changes.length}${state.truncated ? '+' : ''} 处字段变化${statusChanged ? ` · 状态码 ${baseline.status} → ${current.status}` : ''}`;

  return {
    identical,
    isJsonDiff,
    statusChanged,
    baselineStatus: baseline.status,
    currentStatus: current.status,
    durationDeltaMs,
    sizeDeltaBytes,
    changes,
    truncated: state.truncated,
    summary,
  };
}

/**
 * 当实测响应出现 HTTP 异常或契约偏差时，构造发往 AI 会话的排障提示词。
 */
export function buildDebugDiscrepancyAgentPrompt(
  detail: ApiOperationDetail,
  project: ApiProject | undefined,
  response: Pick<ApiDebugResult, 'method' | 'url' | 'status' | 'statusText' | 'durationMs' | 'body'>,
  assertion: ContractAssertionReport,
  diff?: ResponseDiffReport,
): string {
  const lines: string[] = [
    `请帮我排查接口实测响应与 OpenAPI 契约不一致（或报错）的问题：`,
    ``,
    `- **接口**：\`${detail.method.toUpperCase()} ${detail.path}\`${detail.summary ? `（${detail.summary}）` : ''}${project?.name ? ` · ${project.name}` : ''}`,
    `- **实测地址**：\`${response.url}\``,
    `- **实测状态**：\`${response.status} ${response.statusText}\`（耗时 ${response.durationMs} ms）`,
    `- **契约核验结论**：${assertion.summary}`,
  ];

  if (assertion.issues.length > 0) {
    lines.push(``, `### 契约偏差明细`);
    for (const issue of assertion.issues.slice(0, 12)) {
      lines.push(`- \`${issue.jsonPath}\`：${issue.message}（期望：\`${issue.expected}\`，实测：\`${issue.actual}\`）`);
    }
  }

  if (diff && !diff.identical && diff.changes.length > 0) {
    lines.push(``, `### 与对比基准的变化 (${diff.summary})`);
    for (const ch of diff.changes.slice(0, 10)) {
      lines.push(`- \`${ch.path}\` [${ch.kind}]：\`${ch.beforePreview}\` → \`${ch.afterPreview}\``);
    }
  }

  const bodySnippet = response.body.trim().slice(0, 1200);
  if (bodySnippet) {
    lines.push(``, `### 实测响应体摘录`, '```json', bodySnippet, '```');
  }

  lines.push(``, `请结合代码库定位后端序列化、DTO 字段映射或 OpenAPI 契约过期的原因，并给出最小修复方案。`);
  return lines.join('\n');
}

/**
 * OpenAPI Multi-Language Client & Contract Test Codegen
 *
 * 借鉴 Scalar (scalar/scalar)、hey-api/openapi-ts 与 Hoppscotch (hoppscotch/hoppscotch)：
 * 从 OpenAPI 3.x / Apifox 接口详情（路径参数、Query、RequestBody JSON Schema、2xx Response Schema）
 * 零依赖即时生成：
 * 1. 强类型 TypeScript `fetch` SDK（含 Request / Response `interface` 与 `AbortSignal` 支持）
 * 2. 符合 Go 工程习惯的 `net/http` + `context.Context` 请求代码与 `struct` 标签定义
 * 3. 可直接运行的 `node:test` 接口契约冒烟与必返字段断言测试
 */

import type { ApiOperationDetail, ApiProject } from './interface-center.js';

export type OpenApiCodegenTarget = 'curl' | 'typescript' | 'go' | 'contract-test';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function capitalize(word: string): string {
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : '';
}

function tokenizeIdentifier(raw: string): string[] {
  return raw
    .replace(/\{([^{}]+)\}/g, 'by_$1')
    .split(/[^a-zA-Z0-9]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^(?:api|v\d+)$/i.test(part));
}

/**
 * 从 HTTP 方法与路径推导合法的 camelCase 函数名与 PascalCase 类型前缀。
 */
export function deriveOperationSymbolName(
  method: string,
  rawPath: string,
): { camelName: string; pascalName: string } {
  const verb = method.trim().toLowerCase() || 'request';
  const parts = tokenizeIdentifier(rawPath);
  const effectiveParts = parts.length ? parts : ['root'];
  const pascalSuffix = effectiveParts.map(token => capitalize(token)).join('');
  const pascalName = `${capitalize(verb)}${pascalSuffix}`;
  const camelName = `${verb}${pascalSuffix}`;
  return { camelName, pascalName };
}

function resolveServerBaseUrl(detail: ApiOperationDetail): string {
  for (const rawServer of detail.servers || []) {
    const server = asRecord(rawServer);
    if (typeof server.url !== 'string' || !server.url.trim()) continue;
    const variables = asRecord(server.variables);
    const resolved = server.url.trim().replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
      const def = asRecord(variables[name]).default;
      return typeof def === 'string' || typeof def === 'number' ? String(def) : placeholder;
    });
    if (/^https?:\/\//i.test(resolved)) return resolved.replace(/\/+$/, '');
    if (resolved.startsWith('/')) return `http://127.0.0.1:8080${resolved.replace(/\/+$/, '')}`;
  }
  return 'http://127.0.0.1:8080';
}

function hasSecurityRequirement(security: unknown): boolean {
  if (Array.isArray(security)) {
    return security.some(entry => Object.keys(asRecord(entry)).length > 0);
  }
  return Object.keys(asRecord(security)).length > 0;
}

function extractRequestBodySchema(detail: ApiOperationDetail): Record<string, unknown> | undefined {
  if (!detail.requestBody || ['GET', 'HEAD', 'TRACE'].includes(detail.method.toUpperCase())) return undefined;
  const content = asRecord(asRecord(detail.requestBody).content);
  const jsonMime = Object.keys(content).find(mime => /json/i.test(mime));
  if (!jsonMime) return undefined;
  const schema = asRecord(asRecord(content[jsonMime]).schema);
  return Object.keys(schema).length ? schema : undefined;
}

function extractPrimarySuccessResponse(
  detail: ApiOperationDetail,
): { statusCode: string; schema?: Record<string, unknown> } {
  const responses = asRecord(detail.responses);
  const codes = Object.keys(responses);
  const preferred = codes.find(c => /^20\d$/.test(c)) || codes.find(c => /^2\d\d$/.test(c)) || codes[0] || '200';
  const respObj = asRecord(responses[preferred]);
  const content = asRecord(respObj.content);
  const jsonMime = Object.keys(content).find(mime => /json/i.test(mime));
  const schema = jsonMime ? asRecord(asRecord(content[jsonMime]).schema) : undefined;
  return {
    statusCode: /^\d{3}$/.test(preferred) ? preferred : '200',
    schema: schema && Object.keys(schema).length ? schema : undefined,
  };
}

function formatTsPropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function schemaToTsType(schemaRaw: Record<string, unknown>, indent = 0, depth = 0): string {
  if (!Object.keys(schemaRaw).length || depth > 4) return 'unknown';

  if (Array.isArray(schemaRaw.enum) && schemaRaw.enum.length > 0 && schemaRaw.enum.length <= 12) {
    const union = schemaRaw.enum
      .map(val => (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? JSON.stringify(val) : 'unknown'))
      .join(' | ');
    return schemaRaw.nullable ? `${union} | null` : union;
  }

  const rawType = Array.isArray(schemaRaw.type) ? schemaRaw.type[0] : schemaRaw.type;
  let baseType = 'unknown';

  if (rawType === 'string') baseType = 'string';
  else if (rawType === 'integer' || rawType === 'number') baseType = 'number';
  else if (rawType === 'boolean') baseType = 'boolean';
  else if (rawType === 'array') {
    const itemType = schemaToTsType(asRecord(schemaRaw.items), indent, depth + 1);
    baseType = itemType.includes(' | ') ? `Array<${itemType}>` : `${itemType}[]`;
  } else {
    const props = asRecord(schemaRaw.properties);
    const entries = Object.entries(props).slice(0, 20);
    if (rawType === 'object' || entries.length > 0) {
      if (!entries.length) {
        baseType = 'Record<string, unknown>';
      } else {
        const requiredSet = new Set(Array.isArray(schemaRaw.required) ? schemaRaw.required.map(String) : []);
        const pad = '  '.repeat(indent + 1);
        const closePad = '  '.repeat(indent);
        const fields = entries.map(([propName, propSchemaRaw]) => {
          const propSchema = asRecord(propSchemaRaw);
          const opt = requiredSet.has(propName) ? '' : '?';
          const tsType = schemaToTsType(propSchema, indent + 1, depth + 1);
          return `${pad}${formatTsPropertyKey(propName)}${opt}: ${tsType};`;
        });
        baseType = `{\n${fields.join('\n')}\n${closePad}}`;
      }
    }
  }

  return schemaRaw.nullable ? `${baseType} | null` : baseType;
}

/**
 * 生成零依赖强类型 TypeScript `fetch` 客户端代码（含参数、请求体与返回值类型声明）。
 */
export function buildOperationTypeScriptSdk(detail: ApiOperationDetail, project?: ApiProject): string {
  const method = detail.method.toUpperCase();
  const baseUrl = resolveServerBaseUrl(detail);
  const { camelName, pascalName } = deriveOperationSymbolName(method, detail.path);
  const params = (detail.parameters || []).map(asRecord);
  const pathParams = params.filter(p => p.in === 'path' && typeof p.name === 'string');
  const queryParams = params.filter(p => p.in === 'query' && typeof p.name === 'string');
  const bodySchema = extractRequestBodySchema(detail);
  const { schema: responseSchema } = extractPrimarySuccessResponse(detail);
  const needsAuth = hasSecurityRequirement(detail.security);

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${detail.summary || `${method} ${detail.path}`}${project?.name ? ` · ${project.name}` : ''}`);
  lines.push(` * Route: ${method} ${detail.path}`);
  lines.push(` */`);

  if (pathParams.length || queryParams.length) {
    lines.push(`export interface ${pascalName}Params {`);
    for (const p of [...pathParams, ...queryParams]) {
      const name = String(p.name);
      const isReq = p.in === 'path' || Boolean(p.required);
      const tsType = schemaToTsType(asRecord(p.schema), 1, 1);
      lines.push(`  ${formatTsPropertyKey(name)}${isReq ? '' : '?'}: ${tsType === 'unknown' ? 'string | number' : tsType};`);
    }
    lines.push(`}`, '');
  }

  if (bodySchema) {
    const bodyTs = schemaToTsType(bodySchema, 0, 0);
    if (bodyTs.startsWith('{')) {
      lines.push(`export interface ${pascalName}Body ${bodyTs}`, '');
    } else {
      lines.push(`export type ${pascalName}Body = ${bodyTs};`, '');
    }
  }

  const responseTs = responseSchema ? schemaToTsType(responseSchema, 0, 0) : 'Record<string, unknown>';
  if (responseTs.startsWith('{')) {
    lines.push(`export interface ${pascalName}Response ${responseTs}`, '');
  } else {
    lines.push(`export type ${pascalName}Response = ${responseTs};`, '');
  }

  lines.push(`export interface ${pascalName}ClientOptions {`);
  lines.push(`  baseUrl?: string;`);
  if (needsAuth) lines.push(`  token?: string;`);
  lines.push(`  headers?: Record<string, string>;`);
  lines.push(`  signal?: AbortSignal;`);
  lines.push(`}`, '');

  const argsList: string[] = [];
  const allParamsOptional = [...pathParams, ...queryParams].every(p => p.in !== 'path' && !p.required);
  if (pathParams.length || queryParams.length) {
    argsList.push(`params${allParamsOptional && !bodySchema ? ' = {}' : ''}: ${pascalName}Params`);
  }
  if (bodySchema) {
    argsList.push(`body: ${pascalName}Body`);
  }
  argsList.push(`options: ${pascalName}ClientOptions = {}`);

  lines.push(`export async function ${camelName}(${argsList.join(', ')}): Promise<${pascalName}Response> {`);
  lines.push(`  const baseUrl = (options.baseUrl ?? ${JSON.stringify(baseUrl)}).replace(/\\/+$/, '');`);

  const interpolatedPath = detail.path.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const access = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `params.${name}` : `params[${JSON.stringify(name)}]`;
    return `\${encodeURIComponent(String(${access}))}`;
  });
  lines.push(`  const url = new URL(\`\${baseUrl}${interpolatedPath.startsWith('/') ? interpolatedPath : `/${interpolatedPath}`}\`);`);

  if (queryParams.length) {
    for (const q of queryParams) {
      const qName = String(q.name);
      const access = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(qName) ? `params.${qName}` : `params[${JSON.stringify(qName)}]`;
      lines.push(`  if (${access} !== undefined && ${access} !== null) url.searchParams.set(${JSON.stringify(qName)}, String(${access}));`);
    }
  }

  lines.push(`  const response = await fetch(url, {`);
  lines.push(`    method: ${JSON.stringify(method)},`);
  lines.push(`    headers: {`);
  lines.push(`      Accept: 'application/json',`);
  if (bodySchema) lines.push(`      'Content-Type': 'application/json',`);
  if (needsAuth) lines.push(`      ...(options.token ? { Authorization: \`Bearer \${options.token}\` } : {}),`);
  lines.push(`      ...options.headers,`);
  lines.push(`    },`);
  if (bodySchema) lines.push(`    body: JSON.stringify(body),`);
  lines.push(`    signal: options.signal,`);
  lines.push(`  });`);
  lines.push(`  if (!response.ok) {`);
  lines.push(`    throw new Error(\`[${method} ${detail.path}] HTTP \${response.status}: \${await response.text()}\`);`);
  lines.push(`  }`);
  lines.push(`  return (await response.json()) as ${pascalName}Response;`);
  lines.push(`}`);

  return lines.join('\n');
}

function toGoFieldName(raw: string): string {
  const cleaned = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => (/^(?:id|url|ip|uid|uuid|api|http|sql|dto|vo)$/i.test(part) ? part.toUpperCase() : capitalize(part)))
    .join('');
  return cleaned && /^[A-Z]/.test(cleaned) ? cleaned : `Field${capitalize(cleaned || 'Value')}`;
}

function schemaToGoType(schemaRaw: Record<string, unknown>, depth = 0): string {
  if (!Object.keys(schemaRaw).length || depth > 3) return 'any';
  const rawType = Array.isArray(schemaRaw.type) ? schemaRaw.type[0] : schemaRaw.type;
  if (rawType === 'string') return 'string';
  if (rawType === 'integer') return 'int64';
  if (rawType === 'number') return 'float64';
  if (rawType === 'boolean') return 'bool';
  if (rawType === 'array') return `[]${schemaToGoType(asRecord(schemaRaw.items), depth + 1)}`;
  const props = asRecord(schemaRaw.properties);
  const entries = Object.entries(props).slice(0, 16);
  if (entries.length > 0) {
    const requiredSet = new Set(Array.isArray(schemaRaw.required) ? schemaRaw.required.map(String) : []);
    const fields = entries.map(([k, v]) => {
      const goType = schemaToGoType(asRecord(v), depth + 1);
      const omit = requiredSet.has(k) ? '' : ',omitempty';
      return `\t${toGoFieldName(k)} ${goType} \`json:"${k}${omit}"\``;
    });
    return `struct {\n${fields.join('\n')}\n}`;
  }
  return 'map[string]any';
}

/**
 * 生成符合 Go BFF / 微服务规范的 `net/http` + `context.Context` 调用代码片段。
 */
export function buildOperationGoClientSnippet(detail: ApiOperationDetail, _project?: ApiProject): string {
  const method = detail.method.toUpperCase();
  const baseUrl = resolveServerBaseUrl(detail);
  const { pascalName } = deriveOperationSymbolName(method, detail.path);
  const bodySchema = extractRequestBodySchema(detail);
  const { schema: responseSchema } = extractPrimarySuccessResponse(detail);
  const needsAuth = hasSecurityRequirement(detail.security);

  const lines: string[] = [
    `package client`,
    ``,
    `import (`,
    ...(bodySchema ? [`\t"bytes"`] : []),
    `\t"context"`,
    `\t"encoding/json"`,
    `\t"fmt"`,
    `\t"io"`,
    `\t"net/http"`,
    `)`,
    ``,
  ];

  if (bodySchema) {
    lines.push(`type ${pascalName}Request ${schemaToGoType(bodySchema)}`, ``);
  }
  lines.push(`type ${pascalName}Response ${responseSchema ? schemaToGoType(responseSchema) : 'map[string]any'}`, ``);

  const resolvedSamplePath = detail.path.replace(/\{([^{}]+)\}/g, '1');
  const fullDefaultUrl = `${baseUrl}${resolvedSamplePath.startsWith('/') ? resolvedSamplePath : `/${resolvedSamplePath}`}`;
  const sigArgs = [
    `ctx context.Context`,
    `httpClient *http.Client`,
    ...(bodySchema ? [`payload ${pascalName}Request`] : []),
    ...(needsAuth ? [`bearerToken string`] : []),
  ];

  lines.push(`// ${pascalName} 调用 ${method} ${detail.path}`);
  lines.push(`func ${pascalName}(${sigArgs.join(', ')}) (*${pascalName}Response, error) {`);
  lines.push(`\tif httpClient == nil {`);
  lines.push(`\t\thttpClient = http.DefaultClient`);
  lines.push(`\t}`);
  if (bodySchema) {
    lines.push(`\trawBody, err := json.Marshal(payload)`);
    lines.push(`\tif err != nil {`);
    lines.push(`\t\treturn nil, fmt.Errorf("marshal request: %w", err)`);
    lines.push(`\t}`);
    lines.push(`\treq, err := http.NewRequestWithContext(ctx, ${JSON.stringify(method)}, ${JSON.stringify(fullDefaultUrl)}, bytes.NewReader(rawBody))`);
  } else {
    lines.push(`\treq, err := http.NewRequestWithContext(ctx, ${JSON.stringify(method)}, ${JSON.stringify(fullDefaultUrl)}, nil)`);
  }
  lines.push(`\tif err != nil {`);
  lines.push(`\t\treturn nil, err`);
  lines.push(`\t}`);
  lines.push(`\treq.Header.Set("Accept", "application/json")`);
  if (bodySchema) lines.push(`\treq.Header.Set("Content-Type", "application/json")`);
  if (needsAuth) {
    lines.push(`\tif bearerToken != "" {`);
    lines.push(`\t\treq.Header.Set("Authorization", "Bearer "+bearerToken)`);
    lines.push(`\t}`);
  }
  lines.push(`\tresp, err := httpClient.Do(req)`);
  lines.push(`\tif err != nil {`);
  lines.push(`\t\treturn nil, err`);
  lines.push(`\t}`);
  lines.push(`\tdefer resp.Body.Close()`);
  lines.push(`\tif resp.StatusCode < 200 || resp.StatusCode >= 300 {`);
  lines.push(`\t\tbodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))`);
  lines.push(`\t\treturn nil, fmt.Errorf("${method} ${detail.path} unexpected status %d: %s", resp.StatusCode, string(bodyBytes))`);
  lines.push(`\t}`);
  lines.push(`\tvar out ${pascalName}Response`);
  lines.push(`\tif err := json.NewDecoder(resp.Body).Decode(&out); err != nil {`);
  lines.push(`\t\treturn nil, fmt.Errorf("decode response: %w", err)`);
  lines.push(`\t}`);
  lines.push(`\treturn &out, nil`);
  lines.push(`}`);

  return lines.join('\n');
}

/**
 * 生成可直接通过 `node --test` / `npx tsx --test` 执行的接口契约断言测试模板。
 */
export function buildOperationContractTestSnippet(detail: ApiOperationDetail, _project?: ApiProject): string {
  const method = detail.method.toUpperCase();
  const baseUrl = resolveServerBaseUrl(detail);
  const { statusCode, schema: responseSchema } = extractPrimarySuccessResponse(detail);
  const bodySchema = extractRequestBodySchema(detail);
  const needsAuth = hasSecurityRequirement(detail.security);
  const samplePath = detail.path.replace(/\{([^{}]+)\}/g, '1');
  const fullPath = samplePath.startsWith('/') ? samplePath : `/${samplePath}`;

  const requiredFields = responseSchema && Array.isArray(responseSchema.required)
    ? responseSchema.required.map(String).slice(0, 8)
    : responseSchema ? Object.keys(asRecord(responseSchema.properties)).slice(0, 5) : [];

  const lines: string[] = [
    `import test from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    ``,
    `const BASE_URL = process.env.API_BASE_URL || ${JSON.stringify(baseUrl)};`,
    ...(needsAuth ? [`const API_TOKEN = process.env.API_BEARER_TOKEN || '';`] : []),
    ``,
    `test(${JSON.stringify(`契约验证: ${method} ${detail.path}${detail.summary ? ` (${detail.summary})` : ''}`)}, async () => {`,
    `  const response = await fetch(\`\${BASE_URL}${fullPath}\`, {`,
    `    method: ${JSON.stringify(method)},`,
    `    headers: {`,
    `      Accept: 'application/json',`,
    ...(bodySchema ? [`      'Content-Type': 'application/json',`] : []),
    ...(needsAuth ? [`      ...(API_TOKEN ? { Authorization: \`Bearer \${API_TOKEN}\` } : {}),`] : []),
    `    },`,
    ...(bodySchema ? [`    body: JSON.stringify({}),`] : []),
    `  });`,
    ``,
    `  assert.equal(response.status, ${Number(statusCode)}, \`期望状态码 ${statusCode}，实际返回 \${response.status}\`);`,
    `  const payload = (await response.json()) as Record<string, unknown>;`,
    `  assert.equal(typeof payload, 'object');`,
    `  assert.notEqual(payload, null);`,
  ];

  for (const field of requiredFields) {
    lines.push(`  assert.ok(${JSON.stringify(field)} in payload, ${JSON.stringify(`响应体缺少契约字段: ${field}`)});`);
  }

  lines.push(`});`);
  return lines.join('\n');
}

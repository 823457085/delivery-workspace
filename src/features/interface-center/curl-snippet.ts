/**
 * 借鉴 Scalar (github.com/scalar/scalar) 的 OpenAPI 客户端体验：
 * 无需预先配置联调环境，即可从接口契约一键生成可执行 cURL 命令、结构化 Markdown 接口文档与 AI 联调提示词。
 */
import type { ApiOperationDetail, ApiProject } from '../../../shared/interface-center';
import {
  buildOperationContractTestSnippet,
  buildOperationGoClientSnippet,
  buildOperationTypeScriptSdk,
  deriveOperationSymbolName,
  type OpenApiCodegenTarget,
} from '../../../shared/openapi-client-codegen';

export {
  buildOperationContractTestSnippet,
  buildOperationGoClientSnippet,
  buildOperationTypeScriptSdk,
  deriveOperationSymbolName,
  type OpenApiCodegenTarget,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveDefaultServerUrl(detail: ApiOperationDetail): string {
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

function synthesizeSchemaSample(schemaObj: Record<string, unknown>, depth = 0): unknown {
  if (schemaObj.example !== undefined) return schemaObj.example;
  if (schemaObj.default !== undefined) return schemaObj.default;
  if (Array.isArray(schemaObj.enum) && schemaObj.enum.length > 0) return schemaObj.enum[0];
  if (depth > 2) return {};

  const type = Array.isArray(schemaObj.type) ? schemaObj.type[0] : schemaObj.type;
  if (type === 'string') {
    if (schemaObj.format === 'date-time') return '2026-11-15T10:00:00Z';
    if (schemaObj.format === 'date') return '2026-11-15';
    if (schemaObj.format === 'email') return 'dev@example.com';
    return 'string';
  }
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  if (type === 'array') {
    const items = asRecord(schemaObj.items);
    return Object.keys(items).length ? [synthesizeSchemaSample(items, depth + 1)] : [];
  }
  const properties = asRecord(schemaObj.properties);
  if (type === 'object' || Object.keys(properties).length > 0) {
    const out: Record<string, unknown> = {};
    for (const [key, propRaw] of Object.entries(properties).slice(0, 12)) {
      out[key] = synthesizeSchemaSample(asRecord(propRaw), depth + 1);
    }
    return out;
  }
  return {};
}

function extractSampleJsonBody(detail: ApiOperationDetail): string | undefined {
  if (!detail.requestBody || ['GET', 'HEAD', 'TRACE'].includes(detail.method.toUpperCase())) return undefined;
  const content = asRecord(asRecord(detail.requestBody).content);
  const jsonType = Object.keys(content).find(mime => /json/i.test(mime));
  if (!jsonType) return undefined;
  const media = asRecord(content[jsonType]);
  const schema = asRecord(media.schema);
  const sample = media.example ?? schema.example ?? synthesizeSchemaSample(schema);
  return JSON.stringify(sample ?? {}, null, 2);
}

function hasSecurityRequirement(security: unknown): boolean {
  if (Array.isArray(security)) {
    return security.some(entry => Object.keys(asRecord(entry)).length > 0);
  }
  return Object.keys(asRecord(security)).length > 0;
}

export function buildOperationCurlSnippet(detail: ApiOperationDetail, _project?: ApiProject): string {
  const method = detail.method.toUpperCase();
  const baseUrl = resolveDefaultServerUrl(detail);
  const params = (detail.parameters || []).map(asRecord);

  let resolvedPath = detail.path;
  for (const param of params) {
    if (param.in !== 'path' || typeof param.name !== 'string') continue;
    const schema = asRecord(param.schema);
    const sample = param.example ?? schema.example ?? schema.default;
    if (sample !== undefined && sample !== null && typeof sample !== 'object') {
      resolvedPath = resolvedPath.replaceAll(`{${param.name}}`, encodeURIComponent(String(sample)));
    }
  }

  const queryPairs: string[] = [];
  for (const param of params) {
    if (param.in !== 'query' || typeof param.name !== 'string' || !param.required) continue;
    const schema = asRecord(param.schema);
    const sample = param.example ?? schema.example ?? schema.default ?? `<${param.name}>`;
    queryPairs.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(sample))}`);
  }

  const fullUrl = `${baseUrl}${resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`}${
    queryPairs.length ? `?${queryPairs.join('&')}` : ''
  }`;

  const lines = [
    `curl --request ${method} \\`,
    `  --url ${shellSingleQuote(fullUrl)} \\`,
    `  --header 'Accept: application/json'`,
  ];

  if (hasSecurityRequirement(detail.security)) {
    lines[lines.length - 1] += ' \\';
    lines.push(`  --header 'Authorization: Bearer <YOUR_TOKEN>'`);
  }

  for (const param of params) {
    if (param.in !== 'header' || typeof param.name !== 'string' || !param.required) continue;
    if (param.name.toLowerCase() === 'authorization') continue;
    const schema = asRecord(param.schema);
    const sample = param.example ?? schema.example ?? schema.default ?? `<${param.name}>`;
    lines[lines.length - 1] += ' \\';
    lines.push(`  --header ${shellSingleQuote(`${param.name}: ${String(sample)}`)}`);
  }

  const sampleBody = extractSampleJsonBody(detail);
  if (sampleBody !== undefined) {
    lines[lines.length - 1] += ' \\';
    lines.push(`  --header 'Content-Type: application/json' \\`);
    lines.push(`  --data-raw ${shellSingleQuote(sampleBody)}`);
  }

  return lines.join('\n');
}

export function buildOperationMarkdownDoc(detail: ApiOperationDetail, project?: ApiProject): string {
  const method = detail.method.toUpperCase();
  const title = detail.summary ? `${detail.summary}` : detail.path;
  const sections: string[] = [
    `## ${method} \`${detail.path}\` — ${title}`,
  ];

  const meta: string[] = [];
  if (project?.name) meta.push(`项目：${project.name}`);
  if (detail.tags.length) meta.push(`分类：${detail.tags.join(' / ')}`);
  if (detail.deprecated) meta.push('状态：已废弃');
  if (meta.length) sections.push(meta.join(' · '));

  if (detail.description?.trim()) {
    sections.push(detail.description.trim());
  }

  const params = (detail.parameters || []).map(asRecord).filter(item => item.name || item.$ref);
  if (params.length) {
    const rows = [
      '### 请求参数',
      '| 参数名 | 位置 | 类型 | 必填 | 说明 |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const p of params) {
      const schema = asRecord(p.schema);
      const name = String(p.name || p.$ref || '').replaceAll('|', '\\|');
      const loc = String(p.in || '—');
      const type = (Array.isArray(schema.type) ? schema.type.join('/') : String(schema.type || p.type || 'string')).replaceAll('|', '\\|');
      const req = p.required ? '是' : '否';
      const desc = String(p.description || '—').replace(/\s+/g, ' ').replaceAll('|', '\\|');
      rows.push(`| \`${name}\` | ${loc} | \`${type}\` | ${req} | ${desc} |`);
    }
    sections.push(rows.join('\n'));
  }

  const sampleBody = extractSampleJsonBody(detail);
  if (sampleBody) {
    sections.push(`### 请求体示例 (JSON)\n\`\`\`json\n${sampleBody}\n\`\`\``);
  }

  const responseEntries = Object.entries(detail.responses || {});
  if (responseEntries.length) {
    const respLines = ['### 响应状态'];
    for (const [code, resp] of responseEntries) {
      const desc = String(asRecord(resp).description || '无说明').replace(/\s+/g, ' ');
      respLines.push(`- **\`${code}\`**：${desc}`);
    }
    sections.push(respLines.join('\n'));
  }

  sections.push(`### 快速调用 (cURL)\n\`\`\`bash\n${buildOperationCurlSnippet(detail, project)}\n\`\`\``);
  return sections.join('\n\n');
}

export function buildOperationCodegenSnippet(
  target: OpenApiCodegenTarget,
  detail: ApiOperationDetail,
  project?: ApiProject,
): string {
  switch (target) {
    case 'typescript':
      return buildOperationTypeScriptSdk(detail, project);
    case 'go':
      return buildOperationGoClientSnippet(detail, project);
    case 'contract-test':
      return buildOperationContractTestSnippet(detail, project);
    case 'curl':
    default:
      return buildOperationCurlSnippet(detail, project);
  }
}

export function buildOperationAgentPrompt(
  detail: ApiOperationDetail,
  project?: ApiProject,
  preferredTarget?: OpenApiCodegenTarget,
): string {
  const baseDoc = buildOperationMarkdownDoc(detail, project);
  if (!preferredTarget || preferredTarget === 'curl') {
    return `请基于以下接口契约协助我完成联调或生成类型安全的调用代码：\n\n${baseDoc}\n`;
  }
  const metaMap: Record<Exclude<OpenApiCodegenTarget, 'curl'>, { label: string; fence: string }> = {
    typescript: { label: 'TypeScript SDK 调用骨架', fence: 'ts' },
    go: { label: 'Go net/http 客户端骨架', fence: 'go' },
    'contract-test': { label: 'Node 契约验证测试骨架', fence: 'ts' },
  };
  const meta = metaMap[preferredTarget];
  const snippet = buildOperationCodegenSnippet(preferredTarget, detail, project);
  return `请基于以下接口契约与已生成的 ${meta.label}，将该接口优雅地接入当前代码库（对齐项目的错误处理、鉴权与目录规范）：\n\n${baseDoc}\n\n### 参考 ${meta.label}\n\`\`\`${meta.fence}\n${snippet}\n\`\`\`\n`;
}

export function httpStatusTone(code: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const normalized = code.trim().toUpperCase();
  if (normalized.startsWith('2')) return 'success';
  if (normalized.startsWith('3') || normalized.startsWith('4')) return 'warning';
  if (normalized.startsWith('5')) return 'danger';
  return 'neutral';
}

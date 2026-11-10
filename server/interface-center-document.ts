/** 单文件契约读取：只解析本地引用，不读取 URL 或文件系统引用。 */
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import type { ApiGroup, ApiOperation, ApiOperationDetail } from '../shared/interface-center.js';

type ObjectValue = Record<string, any>;
export type ApiDocument = ObjectValue;
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
export const maxContractBytes = 10 * 1024 * 1024;
const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const sensitive = /authorization|password|passwd|cookie|secret|(?:^|[-_])token(?:$|[-_])|api[-_]?key|accessToken|refreshToken/i;

function scrubExamples(value: unknown, secret = false, sample = false): unknown {
  if (Array.isArray(value)) return value.map(item => scrubExamples(item, secret, sample));
  if (sample && typeof value === 'string' && /^(?:Bearer|Basic)\s+\S+$/i.test(value)) return '[已移除凭据示例]';
  if (!isObject(value)) return value;
  const hidden = secret || (typeof value.name === 'string' && sensitive.test(value.name));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(hidden && ['example', 'examples', 'default'].includes(key))
      && !(sample && (sensitive.test(key) || hidden && key === 'value')))
    .map(([key, item]) => [key, scrubExamples(item, hidden || sensitive.test(key), sample || ['example', 'examples', 'default'].includes(key))]));
}

function pointerKeys(reference: string): string[] {
  if (reference === '#') return [];
  try {
    return reference.slice(2).split('/').map(segment => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'));
  } catch { throw new Error('契约引用编码无效'); }
}

function pointer(document: ApiDocument, keys: string[]): unknown {
  let current: unknown = document;
  for (const key of keys) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as ObjectValue)[key];
  }
  return current;
}

export function parseApiDocument(content: string, apifoxUnusedRequestBodyRefs?: (count: number, requestBodies: string[]) => void): ApiDocument {
  if (Buffer.byteLength(content, 'utf8') > maxContractBytes) throw new Error('接口文件不能超过 10 MB');
  let input: unknown;
  try {
    if (/^\s*[\[{]/.test(content)) { try { input = JSON.parse(content); } catch { /* YAML 也支持花括号流式写法。 */ } }
    if (input === undefined) {
      const parsed = parseDocument(content, { uniqueKeys: true, prettyErrors: false, logLevel: 'silent' });
      if (parsed.errors.length) throw new Error('yaml');
      input = parsed.toJS({ maxAliasCount: 100 });
    }
  } catch { throw new Error('无法解析接口文件，请导入有效的 JSON 或 YAML'); }
  if (!isObject(input) || !(typeof input.openapi === 'string' && /^3\.[01]\.\d+$/.test(input.openapi) || input.swagger === '2.0')) {
    throw new Error('支持 OpenAPI 3.0 / 3.1 或 Swagger 2.0；请先从 Apifox 导出 OpenAPI 文件');
  }
  if (!isObject(input.info) || !text(input.info.title).trim() || !isObject(input.paths)) throw new Error('契约缺少 info.title 或 paths');
  const requestBodies = apifoxUnusedRequestBodyRefs && isObject(input.components?.requestBodies) ? input.components.requestBodies : undefined;
  const usedBodies = new Set<string>();
  const missingBodyRefs: string[] = [];
  let allBodiesUsed = false;
  let nodes = 0;
  const stack: { value: unknown; depth: number; ancestors: Set<object>; requestBody?: string }[] = [{ value: input, depth: 0, ancestors: new Set() }];
  while (stack.length) {
    const { value, depth, ancestors, requestBody } = stack.pop()!;
    if (++nodes > 300_000 || depth > 100) throw new Error('接口文档过于复杂，请拆分后导入');
    if (!value || typeof value !== 'object') continue;
    if (ancestors.has(value)) throw new Error('接口文档包含循环 YAML 锚点，请导出无锚点文件');
    if (isObject(value) && '$ref' in value) {
      if (typeof value.$ref !== 'string' || !(value.$ref === '#' || value.$ref.startsWith('#/'))) {
        throw new Error('包含外部 $ref，请先导出已合并引用的单文件 OpenAPI 文档');
      }
      const keys = pointerKeys(value.$ref);
      if (requestBodies && (!keys.length || keys[0] === 'components' && (keys.length === 1 || keys[1] === 'requestBodies'))) {
        if (keys.length < 3) allBodiesUsed = true;
        else usedBodies.add(keys[2]!);
      }
      if (pointer(input, keys) === undefined) {
        if (requestBody === undefined || keys[0] !== 'components' || keys[1] !== 'schemas' || keys.length < 3) {
          throw new Error('接口文档包含无法解析的内部 $ref');
        }
        missingBodyRefs.push(requestBody);
      }
    }
    const next = new Set(ancestors); next.add(value);
    for (const [key, child] of Object.entries(value)) {
      stack.push({ value: child, depth: depth + 1, ancestors: next, requestBody: value === requestBodies ? key : requestBody });
    }
  }
  // Apifox 的远端预览只兼容完全未被引用的请求体。已被引用的模型与本地导入仍严格校验。
  if (missingBodyRefs.some(name => allBodiesUsed || usedBodies.has(name))) throw new Error('接口文档包含无法解析的内部 $ref');
  if (missingBodyRefs.length) apifoxUnusedRequestBodyRefs?.(missingBodyRefs.length, [...new Set(missingBodyRefs)]);
  const document = scrubExamples(input) as ApiDocument;
  for (const [route, item] of Object.entries(document.paths)) {
    if (route.startsWith('x-')) continue;
    if (!route.startsWith('/') || !isObject(item)) throw new Error('接口 paths 格式不正确');
    const resolved = pathItem(document, route);
    if (!isObject(resolved)) throw new Error('接口路径引用格式不正确');
    for (const method of methods) {
      if (resolved[method] !== undefined && (!isObject(resolved[method]) || !isObject(resolved[method].responses))) {
        throw new Error('接口操作缺少有效的 responses');
      }
    }
  }
  return document;
}

function mergeRegistry(current: ObjectValue = {}, incoming: ObjectValue = {}, group: string) {
  for (const [name, value] of Object.entries(incoming)) {
    if (Object.hasOwn(current, name) && !isDeepStrictEqual(current[name], value)) {
      throw new Error(`契约定义冲突：${group}/${name}。请先处理重名定义，或导入为新项目`);
    }
  }
  return { ...current, ...incoming };
}

/** 追加未匹配的操作，同时保持已有接口的公共配置和引用不变。 */
export function appendApiOperations(current: ApiDocument, incoming: ApiDocument) {
  const operations = apiOperations(incoming);
  const existing = new Set(apiOperations(current).map(operation => operation.key));
  const additions = operations.filter(operation => !existing.has(operation.key));
  if (!additions.length) return { document: current, added: 0, skipped: operations.length };
  const version = (document: ApiDocument) => document.openapi?.split('.').slice(0, 2).join('.') || document.swagger;
  if (version(current) !== version(incoming)) throw new Error('两份契约的 OpenAPI / Swagger 版本不同，请导入为新项目');
  if (!isDeepStrictEqual(current.jsonSchemaDialect, incoming.jsonSchemaDialect)) {
    throw new Error('两份契约的 JSON Schema 方言不同，请导入为新项目');
  }
  const swagger = current.swagger === '2.0';
  if (swagger && ['host', 'basePath', 'schemes', 'consumes', 'produces'].some(key => !isDeepStrictEqual(current[key], incoming[key]))) {
    throw new Error('Swagger 的公共服务地址或媒体类型不同，请导入为新项目');
  }
  const document: ApiDocument = { ...current, paths: { ...current.paths } };
  for (const group of ['definitions', 'parameters', 'responses', 'securityDefinitions']) {
    if (incoming[group]) document[group] = mergeRegistry(current[group], incoming[group], group);
  }
  if (incoming.components) {
    const groups = Object.entries(incoming.components).flatMap(([group, value]) => isObject(value)
      ? [[group, mergeRegistry(current.components?.[group], value, `components/${group}`)]] : []);
    document.components = { ...current.components, ...Object.fromEntries(groups) };
  }
  for (const { path: route, method } of additions) {
    const from = pathItem(incoming, route);
    if (Object.hasOwn(current.paths, route)) {
      const old = pathItem(current, route);
      if (!isDeepStrictEqual(old.parameters ?? [], from.parameters ?? [])) {
        throw new Error(`路径 ${route} 的公共参数不同，请导入为新项目`);
      }
    } else if (!Object.hasOwn(document.paths, route)) {
      document.paths[route] = Object.fromEntries(Object.entries(from).filter(([key]) => !methods.includes(key)));
    }
    const key = method.toLowerCase();
    const operation = { ...from[key] };
    if (operation.security === undefined && !isDeepStrictEqual(current.security ?? [], incoming.security ?? [])) {
      operation.security = incoming.security ?? [];
    }
    if (!swagger && operation.servers === undefined) {
      const servers = from.servers ?? incoming.servers ?? [];
      if (!isDeepStrictEqual(document.paths[route].servers ?? current.servers ?? [], servers)) operation.servers = servers;
    }
    document.paths[route] = { ...document.paths[route], [key]: operation };
  }
  // 路径级引用和自定义引用也必须保留原指向，避免追加时悄悄改变已有接口。
  function checkReferences(value: unknown, original: ApiDocument) {
    if (!value || typeof value !== 'object') return;
    if (isObject(value) && typeof value.$ref === 'string') {
      const keys = pointerKeys(value.$ref);
      if (!isDeepStrictEqual(pointer(original, keys), pointer(document, keys))) {
        throw new Error('合并会改变契约引用的内容，请导入为新项目');
      }
    }
    for (const child of Object.values(value)) checkReferences(child, original);
  }
  checkReferences(current, current);
  checkReferences(incoming, incoming);
  return { document: parseApiDocument(JSON.stringify(document)), added: additions.length, skipped: operations.length - additions.length };
}

/** 单次详情有节点预算；递归模型保留原始引用，避免爆炸展开。 */
export function resolveApiValue(document: ApiDocument, value: unknown): any {
  let nodes = 0;
  function visit(item: unknown, references: Set<string>, depth: number): unknown {
    if (++nodes > 20_000 || depth > 30) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, references, depth + 1));
    if (!isObject(item)) return item;
    if (typeof item.$ref === 'string') {
      if (references.has(item.$ref)) return item;
      const target = pointer(document, pointerKeys(item.$ref));
      if (target === undefined) return item;
      const next = new Set(references); next.add(item.$ref);
      const resolved = visit(target, next, depth + 1);
      const siblings = Object.fromEntries(Object.entries(item).filter(([key]) => key !== '$ref'));
      return isObject(resolved) ? { ...resolved, ...visit(siblings, next, depth + 1) as object } : resolved;
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, references, depth + 1)]));
  }
  return visit(value, new Set(), 0);
}

function pathItem(document: ApiDocument, route: string): ObjectValue {
  const original = document.paths[route];
  if (!isObject(original)) return {};
  let item = original, siblings: ObjectValue = {};
  const visited = new Set<string>();
  while (typeof item.$ref === 'string') {
    if (visited.has(item.$ref) || visited.size >= 50) throw new Error('接口路径引用存在循环或层级过深');
    visited.add(item.$ref);
    siblings = { ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== '$ref')), ...siblings };
    const target = pointer(document, pointerKeys(item.$ref));
    if (!isObject(target)) throw new Error('接口路径引用格式不正确');
    item = target;
  }
  return { ...item, ...siblings };
}

export function apiOperations(document: ApiDocument): ApiOperation[] {
  const result: ApiOperation[] = [];
  for (const route of Object.keys(document.paths)) {
    if (!route.startsWith('/')) continue;
    const item = pathItem(document, route);
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const tags = Array.isArray(operation.tags) ? [...new Set(operation.tags.filter((tag: unknown): tag is string => typeof tag === 'string' && !!tag.trim()))] : [];
      result.push({ key: `${method.toUpperCase()} ${route}`, method: method.toUpperCase(), path: route,
        summary: text(operation.summary) || text(operation.operationId) || route, description: text(operation.description),
        tags: tags.length ? tags : ['未分类'], deprecated: operation.deprecated === true });
    }
  }
  return result;
}

export function apiGroups(operations: ApiOperation[]): ApiGroup[] {
  const groups = new Map<string, number>();
  for (const operation of operations) for (const name of operation.tags) groups.set(name, (groups.get(name) || 0) + 1);
  return [...groups].map(([name, count]) => ({ name, count }));
}

export function apiOperationSignature(document: ApiDocument, operation: ApiOperation) {
  const item = pathItem(document, operation.path);
  return JSON.stringify({ operation: item[operation.method.toLowerCase()], parameters: item.parameters, servers: item.servers });
}

export function apiOperationDetail(document: ApiDocument, key: string): ApiOperationDetail {
  const operation = apiOperations(document).find(item => item.key === key);
  if (!operation) throw new Error('接口不存在');
  const item = pathItem(document, operation.path);
  const raw = item[operation.method.toLowerCase()];
  const detail = resolveApiValue(document, raw);
  const common = resolveApiValue(document, Array.isArray(item.parameters) ? item.parameters : []);
  const specific = Array.isArray(detail.parameters) ? detail.parameters : [];
  const merged = new Map<string, unknown>();
  for (const parameter of [...common, ...specific]) merged.set(isObject(parameter) ? `${parameter.in}:${parameter.name}` : JSON.stringify(parameter), parameter);
  let parameters = [...merged.values()];
  let requestBody = detail.requestBody ?? null;
  let responses = isObject(detail.responses) ? detail.responses : {};
  let servers = detail.servers ?? item.servers ?? document.servers ?? [];
  if (document.swagger === '2.0') {
    const consumes = raw.consumes ?? document.consumes ?? ['application/json'];
    const produces = raw.produces ?? document.produces ?? ['application/json'];
    const body = parameters.find(parameter => isObject(parameter) && parameter.in === 'body') as ObjectValue | undefined;
    const form = parameters.filter(parameter => isObject(parameter) && parameter.in === 'formData') as ObjectValue[];
    if (body) requestBody = { description: body.description, required: body.required, content: Object.fromEntries(consumes.map((type: string) => [type, { schema: body.schema }])) };
    else if (form.length) requestBody = { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: Object.fromEntries(form.map(({ name, ...value }) => [name, value])), required: form.filter(value => value.required).map(value => value.name) } } } };
    parameters = parameters.filter(parameter => !isObject(parameter) || !['body', 'formData'].includes(parameter.in));
    responses = Object.fromEntries(Object.entries(responses).map(([status, value]) => [status, isObject(value) && value.schema ? {
      ...value, content: Object.fromEntries(produces.map((type: string) => [type, { schema: value.schema, ...(value.examples?.[type] !== undefined ? { example: value.examples[type] } : {}) }])),
    } : value]));
    servers = document.host ? (document.schemes || ['https']).map((scheme: string) => ({ url: `${scheme}://${document.host}${document.basePath || ''}` })) : [];
  }
  return { ...operation, parameters, requestBody, responses, servers: Array.isArray(servers) ? servers : [], security: detail.security ?? document.security ?? [], raw };
}

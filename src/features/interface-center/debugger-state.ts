import type { ApiOperationDetail } from '../../../shared/interface-center';
import { isDebugJsonMediaType, parseApiDebugBaseUrl, type ApiDebugBody, type ApiDebugField } from '../../../shared/interface-center-debug';

export interface DebugFieldDraft extends ApiDebugField { id: string; required: boolean; description: string; fixedName: boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sensitive = /authorization|password|passwd|cookie|secret|token|api[-_]?key/i;
let sequence = 0;
export const emptyDebugField = (): DebugFieldDraft => ({ id: `debug-field-${++sequence}`, name: '', value: '', enabled: true, required: false, description: '', fixedName: false });
const fieldValue = (name: string, value: unknown) => sensitive.test(name) || value === undefined || value === null || typeof value === 'object' ? '' : String(value);

export function debugParameterFields(detail: ApiOperationDetail, location: 'path' | 'query' | 'header'): DebugFieldDraft[] {
  const fields = detail.parameters.map(record).filter(parameter => parameter.in === location && typeof parameter.name === 'string').map(parameter => {
    const schema = record(parameter.schema), name = String(parameter.name);
    return { ...emptyDebugField(), name, value: fieldValue(name, parameter.example ?? schema.default ?? parameter.default),
      enabled: location === 'path' || parameter.required === true, required: location === 'path' || parameter.required === true,
      description: typeof parameter.description === 'string' ? parameter.description : '', fixedName: true };
  });
  if (location === 'path') for (const match of detail.path.matchAll(/\{([^{}]+)\}/g)) {
    if (!fields.some(field => field.name === match[1])) fields.push({ ...emptyDebugField(), name: match[1]!, required: true, fixedName: true });
  }
  return fields;
}

export function debugServerOptions(detail: ApiOperationDetail): { url: string; description: string }[] {
  return detail.servers.map(record).flatMap(server => {
    if (typeof server.url !== 'string') return [];
    const variables = record(server.variables);
    const url = server.url.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
      const value = record(variables[name]).default;
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder;
    });
    try { parseApiDebugBaseUrl(url); } catch { return []; }
    return [{ url, description: typeof server.description === 'string' ? server.description : '' }];
  });
}

export function debugBodyDraft(detail: ApiOperationDetail): { kind: ApiDebugBody['kind']; text: string; contentType: string; fields: DebugFieldDraft[] } {
  const content = record(record(detail.requestBody).content), types = Object.keys(content);
  const contentType = types.find(isDebugJsonMediaType) || types[0] || 'text/plain';
  const media = record(content[contentType]), schema = record(media.schema), properties = record(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields = Object.entries(properties).map(([name, value]) => {
    const definition = record(value);
    return { ...emptyDebugField(), name, value: fieldValue(name, definition.example ?? definition.default), enabled: required.includes(name),
      required: required.includes(name), description: typeof definition.description === 'string' ? definition.description : '', fixedName: true };
  });
  const kind = !detail.requestBody || ['GET', 'HEAD', 'TRACE'].includes(detail.method) ? 'none'
    : isDebugJsonMediaType(contentType) ? 'json' : /x-www-form-urlencoded/i.test(contentType) ? 'urlencoded' : 'raw';
  const example = media.example ?? schema.example;
  const text = typeof example === 'string' && kind !== 'json' ? example : example === undefined ? kind === 'json' ? '{}' : '' : JSON.stringify(example, null, 2);
  return { kind, text, contentType, fields };
}

export const debugFieldSensitive = (field: ApiDebugField) => sensitive.test(field.name);
export const debugRequestFields = (fields: DebugFieldDraft[]): ApiDebugField[] => fields.map(({ name, value, enabled }) => ({ name, value, enabled }));

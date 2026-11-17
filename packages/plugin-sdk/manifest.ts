import { z } from 'zod';

export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const capabilitySchema = z.enum([
  'storage.read',
  'storage.write',
  'workspace.todos.read',
  'workspace.todos.write',
  'jira.read',
  'jira.create',
  'conversation.context', 'application.local', 'conversation.compose', 'workspace.open', 'capabilities.call',
]);
export const pluginFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'date',
  'select',
  'number',
  'url',
  'checkbox',
  'tags',
]);
export type PluginFieldType = z.infer<typeof pluginFieldTypeSchema>;

export function isValidPluginDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function isValidPluginNumber(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}

export function isValidPluginUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function normalizePluginTags(value: string): string[] {
  if (!value.trim()) return [];
  return [...new Set(value.split(/[,，\n]+/).map(item => item.trim()).filter(Boolean))];
}

export const pluginFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).refine(key => !['id', 'createdAt', 'updatedAt', '__proto__', 'constructor', 'prototype'].includes(key)),
  label: z.string().min(1).max(80),
  type: pluginFieldTypeSchema,
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string().max(80), label: z.string().min(1).max(80) }).strict()).max(20).optional(),
  maxLength: z.number().int().min(1).max(8000).default(2000),
  default: z.string().max(8000).default(''),
}).strict().refine(field => field.type !== 'select' || !!field.options?.length, '选择字段必须声明选项');

export type CustomPluginField = z.infer<typeof pluginFieldSchema>;

export const pluginConfigurationFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).refine(key => !['constructor', 'prototype', '__proto__'].includes(key)),
  label: z.string().min(1).max(80), type: z.enum(['text', 'password']),
  description: z.string().max(500).optional(), required: z.boolean().default(false),
  default: z.string().max(4000).optional(), resetOnChange: z.array(z.string()).max(20).optional(),
}).strict().refine(field => field.type !== 'password' || field.default === undefined, '密码不得声明默认值');
export const pluginManifestSchema = z.object({
  apiVersion: z.literal(1),
  id: pluginIdSchema,
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  hostApi: z.union([z.literal(1), z.literal(2)]),
  description: z.string().max(1000),
  // Optional only: never inject new defaults into legacy manifests and their signed digests.
  category: z.enum(['capability', 'tool', 'application']).optional(),
  tags: z.array(z.string().min(1).max(40)).max(15).optional(),
  author: z.string().min(1).max(120).optional(),
  homepage: z.url().max(1000).optional(),
  releaseNotes: z.string().max(4000).optional(),
  compatibility: z.object({ protocol: z.literal(1), sdk: z.literal('2.1.0') }).strict().optional(),
  theme: z.enum(['full', 'mode', 'independent']).optional(),
  dependencies: z.array(z.string().max(300)).max(20).optional(),
  provides: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/), version: z.literal(1), methods: z.array(z.string().regex(/^[a-z][a-z0-9/-]{0,80}$/)).min(1).max(30) }).strict()).max(20).optional(),
  consumes: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/), version: z.literal(1), methods: z.array(z.string().regex(/^[a-z][a-z0-9/-]{0,80}$/)).min(1).max(30) }).strict()).max(20).optional(),
  capabilities: z.array(z.object({
    id: capabilitySchema, required: z.boolean(), purpose: z.string().min(1).max(300), scope: z.string().min(1).max(300),
  }).strict()).max(10).optional(),
  permissions: z.array(capabilitySchema).max(10),
  page: z.object({ title: z.string().min(1).max(80), kind: z.enum(['records', 'application']) }).strict(),
  application: z.object({ frontend: z.literal('ui.js'), styles: z.literal('ui.css'), backend: z.literal('server.mjs') }).strict().optional(),
  configuration: z.object({ fields: z.array(pluginConfigurationFieldSchema).min(1).max(20) }).strict().optional(),
  records: z.object({
    storage: z.enum(['private', 'workspace.todos']),
    resourceType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    fields: z.array(pluginFieldSchema).min(1).max(15),
  }).strict(),
  commands: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).max(80),
    action: z.enum(['jira.link', 'jira.create', 'conversation.context']),
  }).strict()).max(10).default([]),
}).strict().superRefine((m, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (m.provides?.length && !m.application) error('公开能力需要应用后端');
  if (m.consumes?.length && !m.permissions.includes('capabilities.call')) error('调用其他插件能力必须声明 capabilities.call');
  if (m.capabilities && (new Set(m.capabilities.map(c => c.id)).size !== m.capabilities.length || m.permissions.some(p => !m.capabilities!.some(c => c.id === p)) || m.capabilities.some(c => !m.permissions.includes(c.id)))) error('能力说明必须与权限清单一一对应');
  if (m.capabilities && m.application && !m.capabilities.some(c => c.id === 'application.local' && c.required)) error('本机应用执行必须声明为必需能力');
  if (m.configuration && new Set(m.configuration.fields.map(f => f.key)).size !== m.configuration.fields.length) error('配置字段不能重复');
  for (const field of m.configuration?.fields || []) if (field.resetOnChange?.some(key => field.type !== 'password' || !m.configuration?.fields.some(f => f.key === key && f.type !== 'password'))) error('密码绑定字段必须是已声明的普通配置字段');
  if (m.page.kind === 'application') {
    if (m.hostApi !== 2 || !m.application || !m.permissions.includes('application.local') || m.records.storage !== 'private') error('应用插件需要 hostApi 2、应用入口、本机执行声明和私有存储');
  } else if (m.hostApi !== 1 || m.application || m.permissions.includes('application.local')) error('记录插件使用 hostApi 1 且不支持可执行入口');
  if (new Set(m.permissions).size !== m.permissions.length || new Set(m.records.fields.map(f => f.key)).size !== m.records.fields.length || new Set(m.commands.map(c => c.id)).size !== m.commands.length) error('标识或权限不能重复');
  if (new Set(m.records.fields.map(f => f.label)).size !== m.records.fields.length) error('字段名称不能重复，以免引用内容丢失');
  if (!m.records.fields.some(f => f.key === 'title' && f.required && f.type === 'text')) error('必须包含必填文本 title 字段');
  const prefix = m.records.storage === 'private' ? 'storage' : 'workspace.todos';
  if (!m.permissions.includes(`${prefix}.read`)) error('缺少数据读取权限');
  for (const command of m.commands) if (!m.permissions.includes(command.action === 'jira.link' ? 'jira.read' : command.action)) error('操作缺少声明的宿主权限');
  for (const f of m.records.fields) {
    if (f.type === 'select' && (new Set(f.options!.map(o => o.value)).size !== f.options!.length || (f.default && !f.options!.some(o => o.value === f.default)))) error('选择字段选项或默认值无效');
    if (f.type === 'date' && f.default && !isValidPluginDate(f.default)) error('日期字段默认值无效');
    if (f.type === 'number' && f.default && !isValidPluginNumber(f.default)) error('数字字段默认值无效');
    if (f.type === 'url' && f.default && !isValidPluginUrl(f.default)) error('链接字段默认值无效');
    if (f.type === 'checkbox' && f.default && f.default !== 'true' && f.default !== 'false') error('布尔字段默认值无效');
    if (f.type === 'tags' && f.default) {
      const tags = normalizePluginTags(f.default);
      if (tags.length > 20 || tags.some(tag => tag.length > 40)) error('标签字段默认值超限');
    }
  }
  if (m.records.storage === 'workspace.todos') {
    const keys = m.records.fields.map(f => f.key).sort().join(',');
    if (keys !== 'details,dueDate,priority,status,title') error('复用个人待办必须包含 title/details/dueDate/priority/status 字段');
  }
});

export type CustomPluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginCapability = z.infer<typeof capabilitySchema>;
export interface PluginRecord { id: string; values: Record<string, string>; createdAt: string; updatedAt: string }
export interface PluginResource { reference: string; pluginId: string; resourceType: string; id: string; title: string; excerpt: string; updatedAt: string; version: string; url: string; content?: string }
export interface CustomPluginInfo { manifest: CustomPluginManifest; enabled: boolean; showInMenu: boolean; grants: PluginCapability[]; source: string; digest: string; error?: string }

export interface CustomPluginUpgradePreview {
  id: string;
  source: string;
  digest: string;
  manifest: CustomPluginManifest;
  fromVersion: string;
  toVersion: string;
  changed: boolean;
  wasRemoved: boolean;
  currentGrants: PluginCapability[];
  showInMenu: boolean;
  recordCount: number;
  addedFields: { key: string; label: string; type: PluginFieldType; required: boolean }[];
  removedFields: { key: string; label: string; type: PluginFieldType }[];
  updatedFields: { key: string; label: string; fromType: PluginFieldType; toType: PluginFieldType; required: boolean }[];
  affectedRemovedFieldCount: number;
  compatible: boolean;
  incompatibleRecords: { id: string; title: string; reason: string }[];
}

export interface PluginRecordProposal {
  pluginId?: string;
  recordId?: string;
  values: Record<string, string>;
}

export function parsePluginRecordProposal(raw: string): PluginRecordProposal | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const rawValues = obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values)
      ? obj.values as Record<string, unknown>
      : Object.fromEntries(Object.entries(obj).filter(([key]) => !['pluginId', 'recordId'].includes(key)));
    const values: Record<string, string> = {};
    for (const [key, item] of Object.entries(rawValues)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (typeof item === 'string') values[key] = item;
      else if (typeof item === 'number' && Number.isFinite(item)) values[key] = String(item);
      else if (typeof item === 'boolean') values[key] = item ? 'true' : 'false';
      else if (Array.isArray(item) && item.every(entry => typeof entry === 'string')) values[key] = item.join(', ');
    }
    if (!Object.keys(values).length) return null;
    return {
      pluginId: typeof obj.pluginId === 'string' && pluginIdSchema.safeParse(obj.pluginId.trim()).success ? obj.pluginId.trim() : undefined,
      recordId: typeof obj.recordId === 'string' && z.uuid().safeParse(obj.recordId.trim()).success ? obj.recordId.trim() : undefined,
      values,
    };
  } catch {
    return null;
  }
}

export const pluginReference = (pluginId: string, type: string, id: string) => `plugin:${pluginId}/${type}/${id}`;
export const pluginReferencePattern = /\bplugin:([a-z][a-z0-9-]{1,63})\/([a-z][a-z0-9-]{0,39})\/([a-zA-Z0-9-]{1,80})\b/g;
export function pluginReferences(text: string) { return [...new Set([...text.matchAll(new RegExp(pluginReferencePattern))].map(match => match[0]))]; }

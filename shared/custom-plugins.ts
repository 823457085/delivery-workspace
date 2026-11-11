import { z } from 'zod';
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const capabilitySchema = z.enum(['storage.read', 'storage.write', 'workspace.todos.read', 'workspace.todos.write', 'jira.read', 'jira.create', 'conversation.context']);
export const pluginFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).refine(key => !['id', 'createdAt', 'updatedAt', '__proto__', 'constructor', 'prototype'].includes(key)),
  label: z.string().min(1).max(80), type: z.enum(['text', 'textarea', 'date', 'select']), required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string().max(80), label: z.string().min(1).max(80) }).strict()).max(20).optional(),
  maxLength: z.number().int().min(1).max(8000).default(2000), default: z.string().max(8000).default(''),
}).strict().refine(field => field.type !== 'select' || !!field.options?.length, '选择字段必须声明选项');
export const pluginManifestSchema = z.object({
  apiVersion: z.literal(1), id: pluginIdSchema, name: z.string().min(1).max(80), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  hostApi: z.literal(1), description: z.string().max(1000),
  permissions: z.array(capabilitySchema).max(7),
  page: z.object({ title: z.string().min(1).max(80), kind: z.literal('records') }).strict(),
  records: z.object({ storage: z.enum(['private', 'workspace.todos']), resourceType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    fields: z.array(pluginFieldSchema).min(1).max(15), }).strict(),
  commands: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), label: z.string().min(1).max(80),
    action: z.enum(['jira.link', 'jira.create', 'conversation.context']) }).strict()).max(10).default([]),
}).strict().superRefine((m, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(m.permissions).size !== m.permissions.length || new Set(m.records.fields.map(f => f.key)).size !== m.records.fields.length || new Set(m.commands.map(c => c.id)).size !== m.commands.length) error('标识或权限不能重复');
  if (new Set(m.records.fields.map(f => f.label)).size !== m.records.fields.length) error('字段名称不能重复，以免引用内容丢失');
  if (!m.records.fields.some(f => f.key === 'title' && f.required && f.type === 'text')) error('必须包含必填文本 title 字段');
  const prefix = m.records.storage === 'private' ? 'storage' : 'workspace.todos';
  if (!m.permissions.includes(`${prefix}.read`)) error('缺少数据读取权限');
  for (const command of m.commands) if (!m.permissions.includes(command.action === 'jira.link' ? 'jira.read' : command.action)) error('操作缺少声明的宿主权限');
  for (const f of m.records.fields) if (f.type === 'select' && (new Set(f.options!.map(o => o.value)).size !== f.options!.length || f.default && !f.options!.some(o => o.value === f.default))) error('选择字段选项或默认值无效');
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
export const pluginReference = (pluginId: string, type: string, id: string) => `plugin:${pluginId}/${type}/${id}`;
export const pluginReferencePattern = /\bplugin:([a-z][a-z0-9-]{1,63})\/([a-z][a-z0-9-]{0,39})\/([a-zA-Z0-9-]{1,80})\b/g;
export function pluginReferences(text: string) { return [...new Set([...text.matchAll(new RegExp(pluginReferencePattern))].map(match => match[0]))]; }

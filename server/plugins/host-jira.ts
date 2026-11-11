/** Host-owned Jira workflow. Plugins never receive credentials or choose remote URLs. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JiraIssueRequest } from '../jira-issue.js';
import { assertIntegrationCapability, pluginBaseUrl } from './definitions.mjs';
import { fingerprint, privateJson, readJson, type CustomPluginRuntime } from './custom-runtime.js';
const keySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const projectSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const typeSchema = z.string().regex(/^\d+$/);
type Raw = Record<string, any>;
export interface JiraPluginField { id: string; name: string; required: boolean; schema: Raw; allowedValues?: Raw[]; defaultValue?: unknown }
interface Link { key: string; url: string; summary: string; linkedAt: string; created?: boolean }
interface Ticket { id: string; pluginId: string; recordId: string; version: string; identity: string; expiresAt: number; fields: Raw; status: 'prepared' | 'sending' | 'unknown' | 'done' | 'failed'; result?: Link; message?: string }
interface State { version: 1; tickets: Ticket[]; links: Record<string, Link[]> }
export async function createPluginJira(directory: string, runtime: CustomPluginRuntime, request: JiraIssueRequest,
  options: { site?: () => string; identity?: () => string } = {}) {
  const file = path.join(directory, 'jira-operations.json');
  const linkSchema = z.object({ key: keySchema, url: z.url(), summary: z.string(), linkedAt: z.iso.datetime(), created: z.boolean().optional() }).strict();
  const ticketSchema = z.object({ id: z.uuid(), pluginId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), recordId: z.uuid(), version: z.string(), identity: z.string(),
    expiresAt: z.number().finite(), fields: z.record(z.string(), z.unknown()), status: z.enum(['prepared', 'sending', 'unknown', 'done', 'failed']), result: linkSchema.optional(), message: z.string().optional(),
  }).strict().refine(ticket => ticket.status !== 'done' || !!ticket.result);
  const stored = z.object({ version: z.literal(1), tickets: z.array(ticketSchema), links: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}\/[a-f0-9-]{36}$/), z.array(linkSchema)) }).strict()
    .refine(value => new Set(value.tickets.map(ticket => ticket.id)).size === value.tickets.length)
    .safeParse(await readJson(file, { version: 1, tickets: [], links: {} }));
  if (!stored.success) throw new Error('插件 Jira 操作记录损坏，未覆盖或自动重试');
  let state: State = stored.data;
  for (const ticket of state.tickets) if (ticket.status === 'sending') { ticket.status = 'unknown'; ticket.message = '服务中断，创建结果待核对，不会自动重发'; }
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const persist = async (next: State) => { await privateJson(file, next); state = next; };
  const site = () => {
    const url = new URL(options.site?.() || pluginBaseUrl('jira'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Jira 站点无效');
    return url.href.replace(/\/+$/, '');
  };
  const identity = () => options.identity?.() || fingerprint([site(), process.env.JIRA_USERNAME, process.env.JIRA_AUTH_HEADER,
    process.env.JIRA_API_TOKEN, process.env.JIRA_COOKIE, process.env.JIRA_KEYCHAIN_SERVICE,
    process.env.JIRA_KEYCHAIN_SERVICE ? process.env.JIRA_KEYCHAIN_ACCOUNT || process.env.USER : undefined]);
  async function json(pluginId: string, resource: string, method = 'GET', body?: unknown): Promise<Raw> {
    runtime.assertCapability(pluginId, method === 'GET' ? 'jira.read' : 'jira.create'); assertIntegrationCapability(method === 'GET' ? 'issues.read' : 'issues.write');
    const response = await request(resource, method, body);
    if (!response.ok) throw Object.assign(new Error(`Jira 请求失败：HTTP ${response.status}`), { statusCode: response.status, definite: response.status >= 400 && response.status < 500 });
    return response.json();
  }
  const publicIssue = (raw: Raw) => ({ key: keySchema.parse(raw.key), summary: z.string().min(1).parse(raw.fields?.summary), url: `${site()}/browse/${raw.key}` });
  async function issue(pluginId: string, key: string) {
    const result = await json(pluginId, `issue/${keySchema.parse(key)}?fields=summary,labels,project,issuetype`);
    if (result.key !== key) throw new Error('Jira 返回了不同的任务编号');
    return result;
  }
  async function page(pluginId: string, resource: string, property: string) {
    const values: Raw[] = [];
    for (let start = 0, count = 0; count < 30; count++) {
      const result = await json(pluginId, `${resource}?startAt=${start}&maxResults=100`);
      const items = result[property] || result.values;
      if (!Array.isArray(items) || result.startAt !== undefined && result.startAt !== start) throw new Error('Jira 元数据分页格式无效');
      values.push(...items); start += items.length;
      if (result.isLast === true || Number.isInteger(result.total) && start >= result.total || !items.length || result.total === undefined && items.length < (result.maxResults || 100)) return values;
    }
    throw new Error('Jira 元数据超过上限，请缩小项目范围');
  }
  async function metadata(pluginId: string, project: string, type = '') {
    projectSchema.parse(project); if (type) typeSchema.parse(type);
    let types: Raw[], rawFields: Raw = {};
    try {
      types = (await page(pluginId, `issue/createmeta/${project}/issuetypes`, 'issueTypes')).filter(item => item.subtask === false);
      if (type) rawFields = Object.fromEntries((await page(pluginId, `issue/createmeta/${project}/issuetypes/${type}`, 'fields')).map(item => [item.fieldId || item.key || item.id, item]));
    } catch (error) {
      if (![404, 405].includes((error as any).statusCode)) throw error;
      const legacy = await json(pluginId, `issue/createmeta?${new URLSearchParams({ projectKeys: project, expand: 'projects.issuetypes.fields' })}`);
      types = (legacy.projects?.find((item: Raw) => item.key === project)?.issuetypes || []).filter((item: Raw) => item.subtask === false);
      if (type) rawFields = types.find(item => String(item.id) === type)?.fields || {};
    }
    if (type && !types.some(item => String(item.id) === type)) throw new Error('当前项目不支持所选事项类型');
    const fields: JiraPluginField[] = Object.entries(rawFields).filter(([id]) => !['project', 'issuetype'].includes(id)).map(([id, value]: [string, any]) => ({ id, name: value.name || id, required: value.required === true, schema: value.schema || {}, ...(value.allowedValues ? { allowedValues: value.allowedValues } : {}), ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue } : {}) }));
    if (type && !fields.some(field => field.id === 'summary')) throw new Error('Jira 创建字段缺少标题，无法安全创建');
    return { types: types.map(item => ({ id: typeSchema.parse(String(item.id)), name: String(item.name) })), fields };
  }
  function validateFields(input: Raw, fields: JiraPluginField[]) {
    const known = new Map(fields.map(field => [field.id, field]));
    if (Object.keys(input).some(key => !known.has(key))) throw new Error('提交了未声明的 Jira 字段');
    const values: Raw = {};
    for (const field of fields) {
      const value = input[field.id] ?? field.defaultValue;
      if (value === undefined || value === null || value === '' || Array.isArray(value) && !value.length) { if (field.required) throw new Error(`请填写 ${field.name}`); continue; }
      const type = field.schema.type;
      if (type === 'array' && !Array.isArray(value) || type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) || type === 'boolean' && typeof value !== 'boolean' || ['string', 'date', 'datetime'].includes(type) && typeof value !== 'string') throw new Error(`${field.name}格式无效`);
      if (type === 'array' && field.schema.items === 'string' && value.some((item: unknown) => typeof item !== 'string')) throw new Error(`${field.name}必须是文本数组`);
      if (field.allowedValues?.length) {
        for (const choice of Array.isArray(value) ? value : [value]) if (!choice || typeof choice !== 'object' || !field.allowedValues.some(item => String(item.id) === String(choice.id))) throw new Error(`${field.name}选项无效或已变化`);
      }
      if (JSON.stringify(value).length > 20000) throw new Error(`${field.name}内容过长`);
      values[field.id] = value;
    }
    if (typeof values.summary !== 'string' || !values.summary.trim() || values.summary.length > 255) throw new Error('请填写有效 Jira 标题（最多255字）');
    return values;
  }
  const bucket = (pluginId: string, recordId: string) => `${pluginId}/${recordId}`;
  function attach(next: State, pluginId: string, recordId: string, link: Link) {
    const key = bucket(pluginId, recordId); next.links[key] = [...(next.links[key] || []).filter(item => item.url !== link.url), link];
  }
  return {
    async projects(pluginId: string) {
      const result = await json(pluginId, 'project');
      if (!Array.isArray(result)) throw new Error('Jira 项目列表格式无效');
      return result.map((p: Raw) => ({ key: projectSchema.parse(p.key), name: String(p.name) }));
    }, metadata,
    async find(pluginId: string, key: string) { return publicIssue(await issue(pluginId, keySchema.parse(key.trim().toUpperCase()))); },
    async status(pluginId: string, recordId: string) {
      await runtime.resource(pluginId, recordId);
      return { links: structuredClone(state.links[bucket(pluginId, recordId)] || []), operations: state.tickets.filter(t => t.pluginId === pluginId && t.recordId === recordId).map(t => ({ id: t.id, status: t.status, result: t.result, message: t.message })) };
    },
    link(pluginId: string, raw: unknown) { return serial(async () => {
      runtime.assertCommand(pluginId, 'jira.link');
      const input = z.object({ recordId: z.uuid(), version: z.string(), key: keySchema, confirmed: z.literal(true) }).strict().parse(raw);
      const record = await runtime.resource(pluginId, input.recordId);
      if (record.version !== input.version) throw new Error('事项内容已变化，请重新核对关联');
      const value = publicIssue(await issue(pluginId, input.key));
      const link = { ...value, linkedAt: new Date().toISOString() }, next = structuredClone(state);
      attach(next, pluginId, input.recordId, link); await persist(next); return link;
    }); },
    prepare(pluginId: string, raw: unknown) { return serial(async () => {
      runtime.assertCommand(pluginId, 'jira.create'); runtime.assertCapability(pluginId, 'jira.read');
      const input = z.object({ recordId: z.uuid(), version: z.string(), project: projectSchema, type: typeSchema, fields: z.record(z.string(), z.unknown()) }).strict().parse(raw);
      const resource = await runtime.resource(pluginId, input.recordId);
      if (resource.version !== input.version) throw new Error('事项内容已变化，请重新打开后预览');
      const prior = state.tickets.find(t => t.pluginId === pluginId && t.recordId === input.recordId && ['sending', 'unknown', 'done'].includes(t.status));
      if (prior) throw new Error(prior.status === 'done' ? `该事项已创建 Jira：${prior.result?.key}，请查看关联记录` : '该事项已有待核对的创建请求，禁止重复创建；请先在 Jira 核对');
      const { fields: definitions } = await metadata(pluginId, input.project, input.type);
      const fields = validateFields(input.fields, definitions);
      const id = randomUUID(), marker = `delivery-plugin-${id}`;
      if (definitions.some(f => f.id === 'labels' && f.schema.type === 'array' && f.schema.items === 'string')) fields.labels = [...new Set([...(fields.labels || []), marker])];
      const ticket: Ticket = { id, pluginId, recordId: input.recordId, version: resource.version, identity: identity(), expiresAt: Date.now() + 600000,
        fields: { ...fields, project: { key: input.project }, issuetype: { id: input.type } }, status: 'prepared' };
      const next = structuredClone(state); next.tickets.push(ticket); await persist(next);
      return { ticketId: id, title: resource.title, fields: ticket.fields, marker, expiresAt: ticket.expiresAt, site: site() };
    }); },
    commit(pluginId: string, raw: unknown) { return serial(async () => {
      runtime.assertCommand(pluginId, 'jira.create');
      const input = z.object({ ticketId: z.uuid(), confirmed: z.literal(true) }).strict().parse(raw);
      const ticket = state.tickets.find(t => t.id === input.ticketId && t.pluginId === pluginId);
      if (!ticket) throw new Error('创建预览不存在');
      if (ticket.status === 'done') return { status: ticket.status, result: ticket.result };
      if (ticket.status !== 'prepared') throw new Error('请求已提交或结果待核对，不能重发');
      if (Date.now() > ticket.expiresAt || identity() !== ticket.identity) throw new Error('创建预览已过期或 Jira 连接已变化，请重新预览');
      const resource = await runtime.resource(pluginId, ticket.recordId);
      if (resource.version !== ticket.version) throw new Error('事项已变化，请重新预览');
      const prior = state.tickets.find(t => t.id !== ticket.id && t.pluginId === pluginId && t.recordId === ticket.recordId && ['sending','unknown','done'].includes(t.status));
      if (prior) throw new Error('该事项已有创建请求，请先核对关联记录');
      const meta = await metadata(pluginId, ticket.fields.project.key, ticket.fields.issuetype.id);
      const { project: _p, issuetype: _t, ...values } = ticket.fields; validateFields(values, meta.fields);
      const next = structuredClone(state), pending = next.tickets.find(t => t.id === ticket.id)!;
      pending.status = 'sending'; await persist(next);
      const finished = structuredClone(state), saved = finished.tickets.find(t => t.id === ticket.id)!;
      let accepted = false;
      try {
        runtime.assertCommand(pluginId, 'jira.create');
        const created = await json(pluginId, 'issue', 'POST', { fields: ticket.fields }); accepted = true;
        const key = keySchema.parse(created.key), remote = await issue(pluginId, key);
        if (remote.fields?.summary !== ticket.fields.summary || remote.fields?.project?.key !== ticket.fields.project.key || String(remote.fields?.issuetype?.id) !== ticket.fields.issuetype.id) throw new Error('创建回读不匹配');
        saved.result = { ...publicIssue(remote), linkedAt: new Date().toISOString(), created: true }; saved.status = 'done';
        attach(finished, pluginId, ticket.recordId, saved.result);
      } catch (error) {
        saved.status = !accepted && (error as any).definite === true ? 'failed' : 'unknown';
        saved.message = saved.status === 'failed' ? 'Jira 明确拒绝本次创建，请检查权限和字段后重新预览' : '创建结果待核对，请在 Jira 按预览中的标记或标题查找；不会自动重发';
      }
      await persist(finished); return { status: saved.status, result: saved.result, message: saved.message };
    }); },
    close: () => queue,
  };
}
export type PluginJira = Awaited<ReturnType<typeof createPluginJira>>;

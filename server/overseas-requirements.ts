import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { overseasRequirementSaveSchema, overseasRequirementStateSchema, overseasSystemNameSchema, type OverseasRequirement } from '../shared/overseas-requirements.js';

export async function createOverseasRequirements(directory: string, hasExecution: (id: string) => boolean = () => false) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  const file = path.join(directory, 'requirements.json');
  async function checkFile() {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('需求台账必须保存在本机普通文件中');
  }
  await checkFile();
  let items: OverseasRequirement[] = [];
  let systems: string[] = [];
  let removedIds: string[] = [];
  try { ({ items, systems, removedIds } = overseasRequirementStateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('需求台账读取失败，请保留原文件并检查格式'); }
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>) {
    const next = pending.then(work); pending = next.catch(() => {}); return next;
  }
  async function persist(nextItems: OverseasRequirement[], nextSystems: string[], nextRemovedIds = removedIds) {
    await checkFile();
    const temporary = path.join(directory, `requirements.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, items: nextItems, systems: nextSystems, removedIds: nextRemovedIds }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      items = nextItems; systems = nextSystems; removedIds = nextRemovedIds;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return {
    list: () => structuredClone(items),
    systems: () => [...new Set([...systems, ...items.flatMap(item => item.systems.map(system => system.name))])],
    removedIds: () => [...removedIds],
    remove(raw: unknown) {
      return exclusive(async () => {
        const { id, expectedRevision } = z.object({ id: z.uuid(), expectedRevision: z.number().int().nonnegative() }).strict().parse(raw);
        const existing = items.find(item => item.id === id);
        if (!existing && removedIds.includes(id)) return { deleted: true, removedIds: [...removedIds] };
        if ((existing?.revision || 0) !== expectedRevision) {
          throw Object.assign(new Error('需求已被更新，请刷新后重新确认删除'), { statusCode: 409 });
        }
        if (!existing && (!hasExecution(id) || items.some(item => item.executionIds.includes(id)))) {
          throw Object.assign(new Error('该需求已不在列表中，请刷新后查看'), { statusCode: 409 });
        }
        // 开发记录仍可独立查看，防止它在下次合并时重新生成需求卡片。
        const nextRemovedIds = [...new Set([...removedIds, id, ...(existing?.executionIds || [])])];
        await persist(items.filter(item => item.id !== id), systems, nextRemovedIds);
        return { deleted: true, removedIds: [...removedIds] };
      });
    },
    addSystem(raw: unknown) {
      return exclusive(async () => {
        const { name } = z.object({ name: overseasSystemNameSchema }).strict().parse(raw);
        if (!systems.some(system => system.toLowerCase() === name.toLowerCase())) await persist(items, [...systems, name]);
        return { systems: [...systems] };
      });
    },
    save(raw: unknown): Promise<OverseasRequirement> {
      return exclusive(async () => {
        const { expectedRevision, ...input } = overseasRequirementSaveSchema.parse(raw);
        const existing = items.find(item => item.id === input.id);
        if ((existing?.revision || 0) !== expectedRevision || (!existing && removedIds.includes(input.id))) throw Object.assign(new Error('需求已被更新，请重新打开详情后保存；当前草稿仍保留'), { statusCode: 409 });
        if (existing && raw && typeof raw === 'object' && !Object.hasOwn(raw, 'groupRoomIds')) input.groupRoomIds = existing.groupRoomIds;
        if (input.issueUrl && items.some(item => item.id !== input.id && item.issueUrl === input.issueUrl)) throw new Error('该 Jira 事项已在需求台账中，请刷新后查看');
        if (items.some(item => item.id !== input.id && item.executionIds.some(id => input.executionIds.includes(id)))) throw new Error('该开发记录已关联其他需求，请先核对关联关系');
        if (items.some(item => item.id !== input.id && item.groupRoomIds.some(id => input.groupRoomIds.includes(id)))) throw new Error('该团队群聊已关联其他需求，请先核对关联关系');
        const now = new Date().toISOString();
        const saved = { ...input, revision: expectedRevision + 1, createdAt: existing?.createdAt || now, updatedAt: now };
        const next = existing ? items.map(item => item.id === saved.id ? saved : item) : [...items, saved];
        await persist(next, [...new Set([...systems, ...input.systems.map(system => system.name)])]);
        return structuredClone(saved);
      });
    },
  };
}

export function createOverseasRequirementRoutes(service: Awaited<ReturnType<typeof createOverseasRequirements>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!['/api/overseas-requirements', '/api/overseas-requirements/systems', '/api/overseas-requirements/delete'].includes(url.pathname)) return false;
    const removing = url.pathname.endsWith('/delete');
    if (request.method === 'GET' && !removing) { io.json(response, 200, { items: service.list(), systems: service.systems(), removedIds: service.removedIds() }); return true; }
    if (request.method !== 'POST') { io.json(response, 405, { message: '请求方法不支持' }); return true; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      || ![`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '')
      || request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
      io.json(response, 403, { message: removing ? '请从本机工作台删除需求' : '请从本机工作台保存需求' }); return true;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      io.json(response, 415, { message: '请发送 JSON' }); return true;
    }
    try {
      const raw = await io.body(request, 150_000);
      const result = removing ? await service.remove(raw)
        : url.pathname.endsWith('/systems') ? await service.addSystem(raw) : await service.save(raw);
      io.json(response, 200, result);
    }
    catch (error) {
      io.json(response, (error as { statusCode?: number }).statusCode === 409 ? 409 : 400,
        { message: error instanceof z.ZodError ? error.issues[0]?.message || '请核对需求内容' : error instanceof Error ? error.message : removing ? '需求删除失败' : '需求保存失败' });
    }
    return true;
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workspaceTodoInputSchema, workspaceTodoRemoveSchema, workspaceTodoSchema, type TodoItem } from '../shared/workspace-todos.js';

const stateSchema = z.object({ version: z.literal(1), items: z.array(workspaceTodoSchema) }).strict()
  .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, '待办事项标识不能重复');

export async function createWorkspaceTodos(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  const file = path.join(directory, 'workspace-todos.json');
  async function checkFile() {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('待办事项文件必须为本机普通文件');
  }
  await checkFile();
  let items: TodoItem[] = [];
  try { items = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).items; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('待办事项文件读取失败，请保留原文件并检查格式'); }
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work); pending = next.catch(() => {}); return next;
  }
  async function persist(next: TodoItem[]) {
    await checkFile();
    const temporary = path.join(directory, `workspace-todos.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, items: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      items = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return {
    list: () => structuredClone(items),
    async save(raw: unknown): Promise<TodoItem> {
      const input = workspaceTodoInputSchema.parse(raw);
      return exclusive(async () => {
        const existing = input.id ? items.find(item => item.id === input.id) : undefined;
        if (input.id && !existing) throw new Error('待办事项不存在，请刷新后重试');
        const now = new Date().toISOString();
        const item: TodoItem = { ...input, id: existing?.id || randomUUID(), createdAt: existing?.createdAt || now, updatedAt: now };
        await persist(existing ? items.map(value => value.id === item.id ? item : value) : [...items, item]);
        return structuredClone(item);
      });
    },
    async remove(raw: unknown): Promise<{ id: string }> {
      const { id } = workspaceTodoRemoveSchema.parse(raw);
      return exclusive(async () => {
        if (!items.some(item => item.id === id)) throw new Error('待办事项不存在，请刷新后重试');
        await persist(items.filter(item => item.id !== id));
        return { id };
      });
    },
  };
}

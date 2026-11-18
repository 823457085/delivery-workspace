import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { workspaceTodoInputSchema, workspaceTodoRemoveSchema, workspaceTodoSchema, type TodoItem } from '../shared/workspace-todos.js';
import type { createWorkspaceTodos } from './workspace-todos.js';

type LocalTodos = Awaited<ReturnType<typeof createWorkspaceTodos>>;
export type TaskflowSession = { url: string; token: string; ca?: string };
export type TaskflowResponse = { status: number; body: any };
export type TaskflowRequest = (session: TaskflowSession, method: string, pathname: string, body?: unknown) => Promise<TaskflowResponse>;
type RemoteTodo = { id: string; title: string; details: string; dueDate: string; priority: TodoItem['priority']; status: TodoItem['status']; version: number; projectId: string | null; createdAt: string; updatedAt: string };

const IMPORT_CHUNK = 500;

export async function readTaskflowSession(home = process.env.TASKFLOW_HOME || path.join(os.homedir(), '.taskflow'), now = Date.now()): Promise<TaskflowSession | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(home, 'state', 'session.json'), 'utf8'));
    const url = new URL(String(value.url));
    if (!['https:', 'http:'].includes(url.protocol) || typeof value.token !== 'string' || !value.token) return undefined;
    if (value.expiresAt && Date.parse(value.expiresAt) <= now) return undefined;
    const ca = await fs.readFile(path.join(home, 'taskflow-ca.pem'), 'utf8').catch(() => undefined);
    return { url: url.origin, token: value.token, ca };
  } catch { return undefined; }
}

export const taskflowRequest: TaskflowRequest = (session, method, pathname, body) => new Promise((resolve, reject) => {
  const target = new URL(pathname, session.url);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const options = { method, timeout: 15_000, headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } };
  const request = target.protocol === 'https:' ? https.request(target, { ...options, ...(session.ca ? { ca: session.ca } : {}) }) : http.request(target, options);
  request.on('timeout', () => request.destroy(new Error('timeout')));
  request.on('error', reject);
  request.on('response', response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve({ status: response.statusCode || 0, body: text ? JSON.parse(text) : undefined }); }
      catch { resolve({ status: response.statusCode || 0, body: undefined }); }
    });
  });
  request.end(payload);
});

const toItem = (todo: RemoteTodo): TodoItem => workspaceTodoSchema.parse({ id: todo.id, title: todo.title, details: todo.details || '',
  dueDate: todo.dueDate || '', priority: todo.priority, status: todo.status, createdAt: todo.createdAt, updatedAt: todo.updatedAt });
const differs = (current: TodoItem | undefined, expected: TodoItem) => !current || Object.entries(expected).some(([key, value]) => current[key as keyof TodoItem] !== value);

/** Personal todos backed by the TaskFlow server once this computer's Bridge is paired; local file otherwise. */
export function createTaskflowTodos(local: LocalTodos, options: {
  markerFile: string; session?: () => Promise<TaskflowSession | undefined>; request?: TaskflowRequest;
  disabled?: boolean; log?: (message: string) => void;
}) {
  const session = options.session || (() => readTaskflowSession());
  const send = options.request || taskflowRequest;
  let items: TodoItem[] = [], versions = new Map<string, number>(), connected: string | undefined, loaded = false;
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work); pending = next.catch(() => {}); return next;
  }
  async function call(current: TaskflowSession, method: string, pathname: string, body?: unknown) {
    const response = await send(current, method, pathname, body).catch(() => { throw new Error('暂时连不上任务中心，请稍后重试'); });
    if (response.status === 401) throw new Error('任务中心登录已失效，请重新连接本机 Bridge');
    if (response.status >= 400) throw new Error(response.body?.error?.message || `任务中心返回 ${response.status}`);
    return response.body;
  }
  async function importLocal(current: TaskflowSession) {
    if (await fs.stat(options.markerFile).then(() => true, () => false)) return;
    const old = local.list();
    let imported = 0, skipped = 0;
    for (let index = 0; index < old.length; index += IMPORT_CHUNK) {
      const result = await call(current, 'POST', '/api/todos/import', { items: old.slice(index, index + IMPORT_CHUNK) });
      imported += result.imported; skipped += result.skipped;
    }
    await fs.writeFile(options.markerFile, JSON.stringify({ url: current.url, imported, skipped, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    if (old.length) options.log?.(`本机待办已导入任务中心：新增 ${imported}，已存在 ${skipped}`);
  }
  function remember(todos: RemoteTodo[]) {
    versions = new Map(todos.map(todo => [todo.id, todo.version]));
    items = todos.map(toItem);
    loaded = true;
  }
  async function active() {
    if (options.disabled) return undefined;
    const current = await session();
    if (current?.url !== connected) { connected = current?.url; loaded = false; items = []; versions.clear(); }
    return current;
  }
  async function fetchAll(current: TaskflowSession) {
    if (!loaded) await importLocal(current);
    remember((await call(current, 'GET', '/api/todos?scope=mine')).todos);
  }
  async function ready() {
    const current = await active();
    if (current && !loaded) await fetchAll(current);
    return current;
  }
  const upsert = (todo: RemoteTodo) => {
    versions.set(todo.id, todo.version);
    const item = toItem(todo);
    items = [...items.filter(value => value.id !== item.id), item];
    return structuredClone(item);
  };

  return {
    list: () => connected && loaded ? structuredClone(items) : local.list(),
    source: () => connected ? { mode: 'taskflow' as const, url: connected, ready: loaded } : { mode: 'local' as const },
    refresh: () => exclusive(async () => { const current = await active(); if (current) await fetchAll(current); }),
    async save(raw: unknown, expected?: TodoItem): Promise<TodoItem> {
      const current = await exclusive(ready);
      if (!current) return local.save(raw, expected);
      const input = workspaceTodoInputSchema.parse(raw);
      return exclusive(async () => {
        const { id, ...fields } = input;
        if (!id) return upsert((await call(current, 'POST', '/api/todos', fields)).todo);
        if (!versions.has(id)) await fetchAll(current);
        const existing = items.find(item => item.id === id);
        if (!existing) throw new Error('待办事项不存在，请刷新后重试');
        if (expected && differs(existing, expected)) throw new Error('待办事项已更新，请刷新后编辑');
        return upsert((await call(current, 'PATCH', `/api/todos/${id}`, { expectedVersion: versions.get(id), ...fields })).todo);
      });
    },
    async remove(raw: unknown, expected?: TodoItem): Promise<{ id: string }> {
      const current = await exclusive(ready);
      if (!current) return local.remove(raw, expected);
      const { id } = workspaceTodoRemoveSchema.parse(raw);
      return exclusive(async () => {
        if (!versions.has(id)) await fetchAll(current);
        const existing = items.find(item => item.id === id);
        if (!existing) throw new Error('待办事项不存在，请刷新后重试');
        if (expected && differs(existing, expected)) throw new Error('待办事项已更新，请刷新后删除');
        await call(current, 'DELETE', `/api/todos/${id}?expectedVersion=${versions.get(id)}`);
        versions.delete(id); items = items.filter(item => item.id !== id);
        return { id };
      });
    },
  };
}

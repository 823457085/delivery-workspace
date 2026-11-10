/** 保存私有用户原话供会话交接核对，避免近期摘要和运行裁剪丢失早期约束。
 * 只记录来源文本及宿主撤回/修订事实，不解析或推定授权；原子合并保留历史，不能用摘要替代。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface AgentUserInput {
  id: string; user: string; createdAt: string; withdrawn?: true; revisesInputId?: string;
}
const queues = new Map<string, Promise<void>>();
function serial<T>(file: string, action: () => Promise<T>): Promise<T> {
  const result = (queues.get(file) || Promise.resolve()).then(action);
  const settled = result.then(() => {}, () => {});
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return result;
}
async function contextFile(directory: string, conversationId: string) {
  if (!conversationId) throw new Error('用户原话记录缺少对话标识');
  const folder = path.join(await fs.realpath(directory), 'agent-user-context');
  await fs.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('用户原话记录目录必须是普通目录');
  await fs.chmod(folder, 0o700);
  return path.join(folder, `${createHash('sha256').update(conversationId).digest('hex')}.json`);
}
function input(value: unknown): AgentUserInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('用户原话记录格式无效');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || typeof item.user !== 'string'
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || item.withdrawn !== undefined && item.withdrawn !== true
    || item.revisesInputId !== undefined && (typeof item.revisesInputId !== 'string' || !item.revisesInputId)) {
    throw new Error('用户原话记录格式无效');
  }
  return { id: item.id, user: item.user, createdAt: item.createdAt,
    ...(item.withdrawn ? { withdrawn: true } : {}), ...(item.revisesInputId ? { revisesInputId: item.revisesInputId as string } : {}) };
}
async function readInputs(file: string): Promise<AgentUserInput[]> {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('用户原话记录必须是普通文件');
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value?.version !== 1 || !Array.isArray(value.inputs)) throw new Error();
    return value.inputs.map(input);
  } catch { throw new Error('用户原话记录损坏，未覆盖已有记录'); }
}
export async function saveAgentUserContext(directory: string, conversationId: string, inputs: AgentUserInput[]): Promise<string> {
  const file = await contextFile(directory, conversationId);
  return serial(file, async () => {
    const merged = new Map<string, AgentUserInput>();
    for (const item of [...await readInputs(file), ...inputs.map(input)]) {
      const old = merged.get(item.id);
      if (old && (old.user !== item.user || old.createdAt !== item.createdAt
        || old.revisesInputId && item.revisesInputId && old.revisesInputId !== item.revisesInputId)) {
        throw new Error('相同用户输入身份的原文冲突，未覆盖已有记录');
      }
      merged.set(item.id, { ...old, ...item, ...(old?.withdrawn || item.withdrawn ? { withdrawn: true } : {}) });
    }
    const ordered = [...merged.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, inputs: ordered }, null, 2), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return file;
  });
}
export async function removeAgentUserContext(directory: string, conversationId: string): Promise<void> {
  const file = await contextFile(directory, conversationId);
  await serial(file, () => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }));
}

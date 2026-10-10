/** 自动克隆目录使用本地日期时间；旧 UUID 路径通过改名时保留的链接兼容历史会话。 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function generatedWorkspaceName(branch: string, createdAt = new Date()) {
  const stem = branch.slice('feature/'.length).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 70);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}`;
  const time = `${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}${pad(createdAt.getSeconds())}`;
  return `${stem}-${date}-${time}`;
}

export async function createGeneratedWorkspace(parent: string, branch: string, signal?: AbortSignal, createdAt = new Date()) {
  const name = generatedWorkspaceName(branch, createdAt);
  for (let index = 1; index <= 1000; index++) {
    signal?.throwIfAborted();
    const directory = path.join(parent, index === 1 ? name : `${name}-${index}`);
    try {
      // 原子占用，秒内并发使用数字后缀，绝不复用或覆盖已有目录。
      await fs.mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('当前时间的工作目录名称已用完，请稍后重试');
}

async function renamedPath(value: string) {
  const match = path.basename(value).match(/^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (!match) return value;
  try {
    const resolved = await fs.realpath(value);
    const name = path.basename(resolved);
    return name.startsWith(`${match[1]}-`) && /^\d{8}-\d{6}(?:-\d+)?$/.test(name.slice(match[1].length + 1)) ? resolved : value;
  } catch { return value; }
}

export async function resolveRenamedWorkspace<T extends { workspacePath: string; sourceWorkspacePath?: string; cursorTrustPath?: string }>(record: T): Promise<T> {
  const workspacePath = await renamedPath(record.workspacePath);
  return { ...record, workspacePath,
    ...(record.sourceWorkspacePath ? { sourceWorkspacePath: await renamedPath(record.sourceWorkspacePath) } : {}),
    ...(record.cursorTrustPath === record.workspacePath ? { cursorTrustPath: workspacePath } : {}),
  };
}

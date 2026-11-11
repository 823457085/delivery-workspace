import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isWorkspaceBuild, type WorkspaceBuild, type WorkspaceVersion } from '../shared/workspace-version.ts';

// 只摘要运行时代码和依赖声明；不扫描工作区、会话、凭据或 .data。
export async function backendSourceHash(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT' && relative === 'plugins') return []; throw error;})) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile() && /\.(?:ts|mjs|json)$/.test(entry.name)) files.push(file);
    }
  }
  await Promise.all(['server', 'shared', 'plugins'].map(collect));
  files.push('package.json');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await fs.readFile(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

/** 构建输入摘要包含前端与依赖配置；public 内的联调报告属于运行数据，不触发应用重建。 */
export async function workspaceBuildSourceHash(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (relative === 'public' && ['catchup', 'integration-runs', 'plans'].includes(entry.name)) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  await Promise.all(['src', 'public', 'plugins'].map(collect));
  const hash = createHash('sha256').update(await backendSourceHash(root));
  for (const file of ['index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    const content = await fs.readFile(path.join(root, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    hash.update(file).update('\0').update(content ?? '<missing>').update('\0');
  }
  for (const file of files.sort()) hash.update(file).update('\0').update(await fs.readFile(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

export async function createWorkspaceBuild(root: string, development = false): Promise<WorkspaceBuild> {
  return { id: randomUUID(), builtAt: new Date().toISOString(), backendSourceHash: await backendSourceHash(root),
    buildSourceHash: await workspaceBuildSourceHash(root), development };
}

export async function createWorkspaceVersionReader(root: string, distDirectory = path.join(root, 'dist')) {
  // 进程启动后固定摘要，不能用后来磁盘上的新源码冒充当前运行版本。
  const backend = { sourceHash: await backendSourceHash(root), startedAt: new Date().toISOString() };
  return async (): Promise<WorkspaceVersion> => {
    const diskSourceHash = await backendSourceHash(root).catch(() => undefined);
    const diskBuildSourceHash = await workspaceBuildSourceHash(root).catch(() => undefined);
    let frontend: WorkspaceBuild | null = null;
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(distDirectory, 'workspace-version.json'), 'utf8'));
      if (isWorkspaceBuild(value)) frontend = value;
    } catch { /* 旧构建或构建中无元信息时明确返回待核验，不影响业务服务。 */ }
    return { frontend, ...(diskBuildSourceHash ? { diskBuildSourceHash } : {}), backend: { ...backend, ...(diskSourceHash ? { diskSourceHash } : {}) } };
  };
}

export function workspaceStaticCacheControl(file: string) {
  return /(?:^|[/\\])assets[/\\].+-[\w-]{8,}\.(?:js|css)$/.test(file)
    ? 'public, max-age=31536000, immutable' : 'no-store';
}

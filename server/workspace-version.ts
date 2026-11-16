import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isWorkspaceBuild, type WorkspaceBuild, type WorkspaceVersion } from '../shared/workspace-version.ts';

async function hashFileEntries(root: string, files: string[], allowMissing = false, prefix = ''): Promise<string> {
  const sorted = [...new Set(files)].sort();
  const contents = await Promise.all(sorted.map(async file => {
    const content = await fs.readFile(path.join(root, file)).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    });
    return [file, content] as const;
  }));
  const hash = createHash('sha256');
  if (prefix) hash.update(prefix);
  for (const [file, content] of contents) {
    hash.update(file).update('\0').update(content ?? '<missing>').update('\0');
  }
  return hash.digest('hex');
}

// 只摘要运行时代码和依赖声明；不扫描工作区、会话、凭据或 .data。
export async function backendSourceHash(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && relative === 'plugins') return [];
      throw error;
    });
    await Promise.all(entries.map(async entry => {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile() && /\.(?:ts|mjs|json)$/.test(entry.name)) files.push(file);
    }));
  }
  await Promise.all(['server', 'shared', 'plugins'].map(collect));
  files.push('package.json');
  return hashFileEntries(root, files);
}

const FRONTEND_REFERENCED_SERVER_TYPES = [
  'server/agent-team-service.ts',
  'server/agent-eval.ts',
  'server/agent-delivery-draft.ts',
  'server/project-git.ts',
] as const;

/** 仅摘要实际参与前端打包与类型检查的输入；用于纯后端改动时跳过冗余的 Vite/Monaco 重建。 */
export async function frontendBuildSourceHash(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    await Promise.all(entries.map(async entry => {
      if (relative === 'public' && ['catchup', 'integration-runs', 'plans'].includes(entry.name)) return;
      if (relative.startsWith('plugins') && entry.isFile() && entry.name === 'server.ts') return;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile()) files.push(file);
    }));
  }
  await Promise.all(['src', 'shared', 'public', 'plugins'].map(collect));
  const configFiles = [
    'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
    '.local/data/yunxiao-deployments.json',
    ...FRONTEND_REFERENCED_SERVER_TYPES,
  ];
  return hashFileEntries(root, [...files, ...configFiles], true);
}

/** 构建输入摘要包含前端与依赖配置；public 内的联调报告属于运行数据，不触发应用重建。 */
export async function workspaceBuildSourceHash(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    await Promise.all(entries.map(async entry => {
      if (relative === 'public' && ['catchup', 'integration-runs', 'plans'].includes(entry.name)) return;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile()) files.push(file);
    }));
  }
  const [, backendHash] = await Promise.all([
    Promise.all(['src', 'public', 'plugins'].map(collect)),
    backendSourceHash(root),
  ]);
  const rootConfigs = ['index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];
  const hash = createHash('sha256').update(backendHash);
  const configContents = await Promise.all(rootConfigs.map(async file => {
    const content = await fs.readFile(path.join(root, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return [file, content] as const;
  }));
  for (const [file, content] of configContents) {
    hash.update(file).update('\0').update(content ?? '<missing>').update('\0');
  }
  const sorted = files.sort();
  const fileContents = await Promise.all(sorted.map(async file => [file, await fs.readFile(path.join(root, file))] as const));
  for (const [file, content] of fileContents) {
    hash.update(file).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

export async function createWorkspaceBuild(root: string, development = false): Promise<WorkspaceBuild> {
  const [backendHash, buildHash, frontendHash] = await Promise.all([
    backendSourceHash(root),
    workspaceBuildSourceHash(root),
    frontendBuildSourceHash(root),
  ]);
  return {
    id: randomUUID(),
    builtAt: new Date().toISOString(),
    backendSourceHash: backendHash,
    buildSourceHash: buildHash,
    frontendSourceHash: frontendHash,
    development,
  };
}

export async function createWorkspaceVersionReader(root: string, distDirectory = path.join(root, 'dist')) {
  // 进程启动后固定摘要，不能用后来磁盘上的新源码冒充当前运行版本。
  const backend = { sourceHash: await backendSourceHash(root), startedAt: new Date().toISOString() };
  return async (): Promise<WorkspaceVersion> => {
    const [diskSourceHash, diskBuildSourceHash, rawFrontend] = await Promise.all([
      backendSourceHash(root).catch(() => undefined),
      workspaceBuildSourceHash(root).catch(() => undefined),
      fs.readFile(path.join(distDirectory, 'workspace-version.json'), 'utf8').catch(() => undefined),
    ]);
    let frontend: WorkspaceBuild | null = null;
    if (rawFrontend) {
      try {
        const value: unknown = JSON.parse(rawFrontend);
        if (isWorkspaceBuild(value)) frontend = value;
      } catch { /* 旧构建或构建中无元信息时明确返回待核验，不影响业务服务。 */ }
    }
    return { frontend, ...(diskBuildSourceHash ? { diskBuildSourceHash } : {}), backend: { ...backend, ...(diskSourceHash ? { diskSourceHash } : {}) } };
  };
}

export function workspaceStaticCacheControl(file: string) {
  return /(?:^|[/\\])assets[/\\].+-[\w-]{8,}\.(?:js|css)$/.test(file)
    ? 'public, max-age=31536000, immutable' : 'no-store';
}

export interface PruneStaleAssetsResult {
  keptCount: number;
  removedCount: number;
  removedBytes: number;
}

/**
 * 清理 dist/assets 中过旧的历史构建产物：
 * 保留本次构建全部产物 + 最近上一轮构建产物（供尚未刷新的旧页面按需加载异步模块），
 * 自动删除第 3 代及更早的陈旧文件，避免 emptyOutDir: false 造成构建目录无限膨胀。
 */
export async function pruneStaleBuildAssets(
  outDir: string,
  currentFiles: Iterable<string>,
  options: { buildStartedAtMs?: number; generationWindowMs?: number } = {},
): Promise<PruneStaleAssetsResult> {
  const assetsDir = path.join(outDir, 'assets');
  const entries = await fs.readdir(assetsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const currentAssetNames = new Set<string>();
  for (const raw of currentFiles) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('assets/')) currentAssetNames.add(normalized.slice('assets/'.length));
    else if (!normalized.includes('/')) currentAssetNames.add(normalized);
  }
  const generationWindowMs = options.generationWindowMs ?? 180_000;
  const currentFloorMs = options.buildStartedAtMs !== undefined ? options.buildStartedAtMs - 2_000 : Number.POSITIVE_INFINITY;

  const candidates: { fullPath: string; mtimeMs: number; size: number }[] = [];
  let keptCount = 0;
  await Promise.all(entries.map(async entry => {
    if (!entry.isFile()) return;
    const fullPath = path.join(assetsDir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) return;
    if (currentAssetNames.has(entry.name) || stat.mtimeMs >= currentFloorMs) {
      keptCount++;
      return;
    }
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
  }));

  if (!candidates.length) return { keptCount, removedCount: 0, removedBytes: 0 };
  const latestPrevMtimeMs = Math.max(...candidates.map(item => item.mtimeMs));
  const keepPrevFloorMs = latestPrevMtimeMs - generationWindowMs;

  let removedCount = 0;
  let removedBytes = 0;
  await Promise.all(candidates.map(async item => {
    if (item.mtimeMs >= keepPrevFloorMs) {
      keptCount++;
      return;
    }
    const removed = await fs.unlink(item.fullPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (removed) {
      removedCount++;
      removedBytes += item.size;
    }
  }));
  return { keptCount, removedCount, removedBytes };
}

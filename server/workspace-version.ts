import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isWorkspaceBuild, type WorkspaceBuild, type WorkspaceVersion } from '../shared/workspace-version.js';

// 摘要后端运行代码与依赖声明；显式补齐跨目录依赖，避免把纯展示源码也算作需要重启。
// 后端增加 scripts/src 的值导入时同步维护此列表；不扫描工作区、会话、凭据或 .data。
export async function backendSourceHash(root: string): Promise<string> {
  const files: string[] = [
    // delivery-acceptance-source -> domain -> task-schedule / conversation。
    'src/features/workbench/domain.ts',
    'src/shared/task-schedule.ts',
    'src/features/agent-workbench/conversation.ts',
    // index -> integration-execution-progress 及其静态、动态导入。
    'scripts/integration-execution-progress.ts',
    'scripts/integration-cleared-issues.ts',
    'src/features/api-integration/review-catalog.ts',
    'src/features/api-integration/page-classification.ts',
    'src/features/api-integration/page-plan.ts',
    'src/features/integration-execution/execution-plan.ts',
  ];
  async function collect(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(file);
      else if (entry.isFile() && /\.(?:ts|mjs|json)$/.test(entry.name)) files.push(file);
    }
  }
  await Promise.all(['server', 'shared'].map(collect));
  files.push('package.json');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await fs.readFile(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

export async function createWorkspaceBuild(root: string, development = false): Promise<WorkspaceBuild> {
  return { id: randomUUID(), builtAt: new Date().toISOString(), backendSourceHash: await backendSourceHash(root), development };
}

export async function createWorkspaceVersionReader(root: string, distDirectory = path.join(root, 'dist')) {
  // 进程启动后固定摘要，不能用后来磁盘上的新源码冒充当前运行版本。
  const backend = { sourceHash: await backendSourceHash(root), startedAt: new Date().toISOString() };
  return async (): Promise<WorkspaceVersion> => {
    let frontend: WorkspaceBuild | null = null;
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(distDirectory, 'workspace-version.json'), 'utf8'));
      if (isWorkspaceBuild(value)) frontend = value;
    } catch { /* 旧构建或构建中无元信息时明确返回待核验，不影响业务服务。 */ }
    return { frontend, backend: { ...backend } };
  };
}

export function workspaceStaticCacheControl(file: string) {
  return /(?:^|[/\\])assets[/\\].+-[\w-]{8,}\.(?:js|css)$/.test(file)
    ? 'public, max-age=31536000, immutable' : 'no-store';
}

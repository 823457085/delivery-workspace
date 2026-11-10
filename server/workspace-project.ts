import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const internalWorkspace = /(?:^|\/)\.data\/agent-runtimes\/(sessions|workspaces)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/|$)/i;

/** 只解析展示归属；执行目录、源目录和分支始终由原记录决定。 */
export function createWorkspaceProjectResolver() {
  const cache = new Map<string, { expiresAt: number; result: Promise<string | undefined> }>();

  async function gitRoot(directory: string) {
    const { stdout } = await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'],
      { timeout: 5000, maxBuffer: 100_000 });
    return fs.realpath(stdout.replace(/\r?\n$/, ''));
  }

  async function gitProject(directory: string) {
    try {
      // Git 自己枚举 common-dir 对应的主工作区，兼容独立 git-dir，不能由 .git 的父目录猜测。
      const { stdout } = await exec('git', ['-C', directory, 'worktree', 'list', '--porcelain', '-z'],
        { timeout: 5000, maxBuffer: 1_000_000 });
      const first = stdout.split('\0')[0];
      if (!first?.startsWith('worktree ')) return undefined;
      // 未配置 core.worktree 的独立 git-dir 可能被列作主目录，必须核验它真的是工作树。
      const project = await gitRoot(first.slice('worktree '.length)).catch(() => gitRoot(directory));
      return internalWorkspace.test(project.replaceAll('\\', '/')) ? undefined : project;
    } catch { return undefined; }
  }

  return async (record: { workspacePath: string; sourceWorkspacePath?: string }): Promise<string> => {
    if (record.sourceWorkspacePath === '') return '';
    const selected = record.sourceWorkspacePath ?? record.workspacePath;
    const internal = internalWorkspace.exec(selected.replaceAll('\\', '/'));
    if (!selected || internal?.[1] === 'sessions') return '';
    const fallback = internal ? '' : selected;
    if (!path.isAbsolute(selected)) return fallback;
    let directory: string;
    try {
      directory = await fs.realpath(selected);
      if (!(await fs.stat(directory)).isDirectory()) return fallback;
    } catch { return fallback; }

    const existing = cache.get(directory);
    let result = existing && existing.expiresAt > Date.now() ? existing.result : undefined;
    if (!result) {
      result = gitProject(directory);
      cache.set(directory, { expiresAt: Date.now() + 60_000, result });
    }
    const project = await result;
    if (!project && cache.get(directory)?.result === result) cache.delete(directory);
    // 普通目录不缓存失败，后续初始化为 Git 仓库时即可重新识别。
    return project || (internal ? '' : directory);
  };
}

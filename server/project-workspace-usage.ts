import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseLsofCwds } from './port-monitor.js';

const exec = promisify(execFile);
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** 删除前检查任务与进程的实际目录；无法核验占用时不允许删除。 */
export function createWorkspaceUsageCheck(activePaths: () => string[], readCwds = async () => {
  try {
    return (await exec('lsof', ['-nP', '-a', '-d', 'cwd', '-Fpn'], { timeout: 10_000, maxBuffer: 4_000_000 })).stdout;
  } catch { throw new Error('无法核验本机进程是否正在使用工作区，请稍后重试'); }
}) {
  return async (directory: string) => {
    const canonical = await fs.realpath(directory);
    for (const candidate of activePaths()) {
      const active = await fs.realpath(candidate).catch(() => path.resolve(candidate));
      if (overlaps(canonical, active)) throw new Error('工作区有运行或排队中的任务，请任务结束后再删除');
    }
    const cwds = parseLsofCwds(await readCwds());
    for (const [pid, cwd] of cwds) {
      const actual = await fs.realpath(cwd).catch(() => cwd);
      // 父目录中的终端不会占用其每个子项目；仅阻止工作区自身或其内部的进程。
      if (actual === canonical || actual.startsWith(canonical + path.sep)) {
        throw new Error(`工作区正在被本机进程 ${pid} 使用，请先停止相关服务`);
      }
    }
  };
}

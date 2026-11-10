/** 检查、预构建或发布页面。候选通过后才替换 dist，失败保留上一版和构建日志。 */
import { execFile } from 'node:child_process';
import { constants, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWorkspaceBuild, type WorkspaceBuild } from '../shared/workspace-version.js';
import { workspaceBuildSourceHash } from './workspace-version.js';

async function readBuild(directory: string): Promise<WorkspaceBuild | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, 'workspace-version.json'), 'utf8'));
    if (!isWorkspaceBuild(value) || value.development) return;
    const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
    // 缺少入口或入口依赖也要修复，不能只相信版本文件。
    const assets = [...html.matchAll(/(?:src|href)=["']\/?(assets\/[^"']+)["']/g)].map(match => match[1]);
    if (!assets.length) return;
    await Promise.all(assets.map(file => fs.access(path.join(directory, file))));
    return value;
  } catch { return; }
}

async function buildWorkspace(root: string, output: string) {
  return promisify(execFile)('pnpm', ['run', 'build'], {
    cwd: root, env: { ...process.env, DELIVERY_BUILD_DIR: output }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
}

async function linkBuildAssets(current: string, candidate: string) {
  const directory = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!directory?.isDirectory()) return false;
  const entries = await fs.readdir(candidate, { withFileTypes: true });
  if (!entries.every(entry => entry.isFile() && /-[\w-]{8,}\.[\w]+$/.test(entry.name))) return false;
  for (const { name } of entries) {
    const source = path.join(candidate, name);
    const destination = path.join(current, name);
    try { await fs.link(source, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(destination)).isFile()) return false;
      const [next, previous] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
      if (!next.equals(previous)) return false;
    }
  }
  return true;
}

export async function ensureWorkspaceBuild(root: string, distDirectory: string,
  options: { logFile?: string; build?: typeof buildWorkspace; prepareOnly?: boolean; backendSourceHash?: string } = {}) {
  const sourceHash = await workspaceBuildSourceHash(root);
  const previous = await readBuild(distDirectory);
  if (previous?.buildSourceHash === sourceHash) {
    if (options.backendSourceHash && previous.backendSourceHash !== options.backendSourceHash) {
      throw new Error('后端源码已变化，请重新点击更新。');
    }
    return { rebuilt: false, build: previous };
  }
  const preparedDirectory = path.join(path.dirname(distDirectory), `.${path.basename(distDirectory)}-prepared`);
  const prepared = await readBuild(preparedDirectory);
  const reusable = prepared?.buildSourceHash === sourceHash ? prepared : undefined;
  if (options.prepareOnly && reusable) return { rebuilt: true, build: reusable };
  const logFile = options.logFile ?? path.join(root, '.data', 'workspace-build.log');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.mkdir(path.dirname(distDirectory), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(distDirectory), '.delivery-build-'));
  const candidate = path.join(temporary, 'candidate'), backup = path.join(temporary, 'previous');
  const currentAssets = path.join(distDirectory, 'assets'), candidateAssets = path.join(candidate, 'assets');
  const backupAssets = path.join(backup, 'assets');
  let movedPrevious = false;
  try {
    if (reusable) {
      await fs.rename(preparedDirectory, candidate);
    } else {
      await fs.mkdir(candidate);
      await fs.writeFile(logFile, `${new Date().toISOString()} 自动构建开始\n`);
      const result = await (options.build ?? buildWorkspace)(root, candidate);
      await fs.appendFile(logFile, `${result.stdout}\n${result.stderr}\n`);
    }
    const next = await readBuild(candidate);
    if (!next || next.buildSourceHash !== sourceHash || await workspaceBuildSourceHash(root) !== sourceHash) {
      throw new Error('构建产物不完整或构建期间源码发生变化，请重试');
    }
    if (options.prepareOnly) {
      await fs.rm(preparedDirectory, { recursive: true, force: true });
      await fs.rename(candidate, preparedDirectory);
      await fs.appendFile(logFile, `${new Date().toISOString()} 页面预构建完成 ${next.id}\n`).catch(() => {});
      return { rebuilt: true, build: next };
    }
    if (options.backendSourceHash && next.backendSourceHash !== options.backendSourceHash) {
      throw new Error('后端源码已变化，请重新点击更新。');
    }
    // 新的带 hash 资源可安全加入原目录。发布时移动整个 assets 目录，省去复制及清理历史资源。
    const reuseAssets = await linkBuildAssets(currentAssets, candidateAssets);
    await fs.cp(distDirectory, candidate, { recursive: true, force: false, mode: constants.COPYFILE_FICLONE,
      filter: source => !reuseAssets || source !== currentAssets })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (await workspaceBuildSourceHash(root) !== sourceHash) throw new Error('切换页面前源码发生变化，请重试');
    // 目录切换连续执行，正在运行的服务不会在切换中读取入口。
    try { renameSync(distDirectory, backup); movedPrevious = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let movedAssets = false;
    try {
      if (reuseAssets && movedPrevious) {
        renameSync(candidateAssets, path.join(temporary, 'generated-assets'));
        renameSync(backupAssets, candidateAssets); movedAssets = true;
      }
      renameSync(candidate, distDirectory);
      movedPrevious = false;
    }
    catch (error) {
      if (movedAssets) renameSync(candidateAssets, backupAssets);
      if (movedPrevious) { renameSync(backup, distDirectory); movedPrevious = false; }
      throw error;
    }
    await fs.appendFile(logFile, `${new Date().toISOString()} 自动构建完成 ${next.id}\n`).catch(() => {});
    return { rebuilt: true, build: next };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    await fs.appendFile(logFile, `${failure.stdout || ''}\n${failure.stderr || ''}\n${failure.message}\n`).catch(() => {});
    throw new Error('页面自动构建失败，已保留上一版页面。修复构建错误后，可安排更新以自动重试。');
  } finally {
    // 回滚失败时留下 previous 供恢复，不删除仅存的上一版。
    if (!movedPrevious) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

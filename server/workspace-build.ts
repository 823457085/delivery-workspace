/** 检查、预构建或发布页面。候选通过后才替换 dist，失败保留上一版和构建日志。 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWorkspaceBuild, type WorkspaceBuild } from '../shared/workspace-version.js';
import { backendSourceHash, frontendBuildSourceHash, workspaceBuildSourceHash } from './workspace-version.js';

const execFileAsync = promisify(execFile);

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

function localBin(root: string, name: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(root, 'node_modules', '.bin', `${name}${ext}`);
}

function tsBuildInfoDir(root: string): string {
  return path.join(os.tmpdir(), 'delivery-tsbuildinfo', createHash('sha256').update(root).digest('hex').slice(0, 16));
}

async function runBackendOnlyFastBuild(root: string, distDirectory: string, output: string, previous: WorkspaceBuild, currentFrontendHash: string) {
  const cacheDir = tsBuildInfoDir(root);
  await fs.mkdir(cacheDir, { recursive: true });
  const tscBin = localBin(root, 'tsc');
  const checkResult = await execFileAsync(tscBin, [
    '--noEmit', '--incremental',
    '--tsBuildInfoFile', path.join(cacheDir, 'tsc-server.tsbuildinfo'),
    '-p', 'tsconfig.server.json',
  ], { cwd: root, env: process.env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' });
  await fs.cp(distDirectory, output, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE });
  const [nextBackendHash, nextBuildHash] = await Promise.all([
    backendSourceHash(root),
    workspaceBuildSourceHash(root),
  ]);
  const updated: WorkspaceBuild = {
    ...previous,
    backendSourceHash: nextBackendHash,
    buildSourceHash: nextBuildHash,
    frontendSourceHash: currentFrontendHash,
  };
  await fs.writeFile(path.join(output, 'workspace-version.json'), JSON.stringify(updated));
  return {
    stdout: `[fast-backend-build] 前端源码未变化，已跳过 Vite 重打包，仅执行后端增量类型检查\n${checkResult.stdout}`,
    stderr: checkResult.stderr,
  };
}

async function buildWorkspace(root: string, output: string, context?: { previous?: WorkspaceBuild; distDirectory?: string }) {
  const vueTscBin = localBin(root, 'vue-tsc');
  const tscBin = localBin(root, 'tsc');
  const viteBin = localBin(root, 'vite');
  if (!existsSync(vueTscBin) || !existsSync(tscBin) || !existsSync(viteBin)) {
    return execFileAsync('pnpm', ['run', 'build'], {
      cwd: root, env: { ...process.env, DELIVERY_BUILD_DIR: output }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    });
  }
  if (context?.previous?.frontendSourceHash && context.distDirectory) {
    const currentFrontendHash = await frontendBuildSourceHash(root);
    if (currentFrontendHash === context.previous.frontendSourceHash) {
      return runBackendOnlyFastBuild(root, context.distDirectory, output, context.previous, currentFrontendHash);
    }
  }
  const cacheDir = tsBuildInfoDir(root);
  await fs.mkdir(cacheDir, { recursive: true });
  const execOpts = { cwd: root, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' };
  const [vueCheck, serverCheck, viteResult] = await Promise.all([
    execFileAsync(vueTscBin, ['--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'vue-tsc.tsbuildinfo')], { ...execOpts, env: process.env }),
    execFileAsync(tscBin, ['--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'tsc-server.tsbuildinfo'), '-p', 'tsconfig.server.json'], { ...execOpts, env: process.env }),
    execFileAsync(viteBin, ['build'], { ...execOpts, env: { ...process.env, DELIVERY_BUILD_DIR: output } }),
  ]);
  return {
    stdout: [vueCheck.stdout, serverCheck.stdout, viteResult.stdout].filter(Boolean).join('\n'),
    stderr: [vueCheck.stderr, serverCheck.stderr, viteResult.stderr].filter(Boolean).join('\n'),
  };
}

/**
 * 历史 hash 资源只为已打开的旧页面保留一段时间；当前构建引用的资源刷新时间戳，
 * 其余超过保留期、或超出非活跃体积预算的旧批次资源自动回收，避免 dist/assets 无限累积。
 */
export async function pruneStaleBuildAssets(
  assetsDirectory: string,
  currentAssets: Iterable<string>,
  retentionMs = 6 * 3600_000,
  maxInactiveBytes = 64 * 1024 * 1024,
) {
  const active = currentAssets instanceof Set ? currentAssets : new Set(currentAssets);
  if (!active.size) return { removed: 0, bytes: 0 };
  const nowMs = Date.now();
  const cutoff = nowMs - retentionMs;
  const protectedRecentMs = nowMs - Math.min(retentionMs, 15 * 60_000);
  const now = new Date(nowMs);
  let removed = 0, bytes = 0;
  let names: string[];
  try { names = await fs.readdir(assetsDirectory); } catch { return { removed, bytes }; }
  const inactiveRecent: { file: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(assetsDirectory, name);
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile()) continue;
    if (active.has(name)) {
      if (stat.mtimeMs < cutoff + retentionMs / 2) await fs.utimes(file, now, now).catch(() => {});
      continue;
    }
    if (!/-[\w-]{8,}\.[\w]+$/.test(name)) continue;
    if (stat.mtimeMs < cutoff) {
      await fs.unlink(file).then(() => { removed += 1; bytes += stat.size; }, () => {});
      continue;
    }
    inactiveRecent.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  inactiveRecent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let keptInactiveBytes = 0;
  for (const item of inactiveRecent) {
    keptInactiveBytes += item.size;
    if (keptInactiveBytes <= maxInactiveBytes || item.mtimeMs >= protectedRecentMs) continue;
    await fs.unlink(item.file).then(() => { removed += 1; bytes += item.size; }, () => {});
  }
  return { removed, bytes };
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
  options: { logFile?: string; build?: (root: string, output: string) => Promise<{ stdout: string; stderr: string }>; prepareOnly?: boolean; backendSourceHash?: string } = {}) {
  const [sourceHash, previous] = await Promise.all([
    workspaceBuildSourceHash(root),
    readBuild(distDirectory),
  ]);
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
      const result = options.build
        ? await options.build(root, candidate)
        : await buildWorkspace(root, candidate, { previous, distDirectory });
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
    const currentBuildAssets = new Set(await fs.readdir(candidateAssets).catch(() => [] as string[]));
    const reuseAssets = await linkBuildAssets(currentAssets, candidateAssets);
    await fs.cp(distDirectory, candidate, { recursive: true, force: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
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
    // 后台清理过期旧资源，不阻塞发布。
    void pruneStaleBuildAssets(currentAssets, currentBuildAssets).then(result => result.removed
      ? fs.appendFile(logFile, `${new Date().toISOString()} 已清理 ${result.removed} 个过期页面资源（${Math.round(result.bytes / 1048576)} MB）\n`) : undefined).catch(() => {});
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

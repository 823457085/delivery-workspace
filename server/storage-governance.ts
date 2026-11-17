import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  workspaceStorageReclaimInputSchema,
  type WorkspaceLedgerFootprint,
  type WorkspaceStorageBucket,
  type WorkspaceStorageReclaimInput,
  type WorkspaceStorageReclaimResult,
  type WorkspaceStorageReport,
} from '../shared/storage-governance.js';
import { localWorkflowWorkspace } from './agent-workflow.js';

const artifactIgnoredDirs = new Set([
  'node_modules', '.git', '.vite', '.next', '.nuxt', '.turbo',
  'dist', '.output', 'coverage', '.parcel-cache',
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache',
  'BrowserMetrics', 'Crashpad', 'Service Worker', 'blob_storage',
]);
const dependencyCacheDirs = new Set([
  'node_modules', '.vite', '.next', '.nuxt', '.turbo',
  'dist', '.output', 'coverage', '.parcel-cache',
]);
const browserTopCacheDirs = new Set([
  'optimization_guide_model_store', 'GraphiteDawnCache', 'BrowserMetrics',
  'GrShaderCache', 'ShaderCache', 'Crashpad', 'DawnCache', 'segmentation_platform',
]);
const browserProfileSubCacheDirs = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'AutofillAiModelCache',
]);
const browserServiceWorkerCacheDirs = new Set(['CacheStorage', 'ScriptCache']);
const maxArtifactFileBytes = 25 * 1024 * 1024;
const ledgerFileNames = [
  'agent-runs.json',
  'collaboration-state.json',
  'team-tasks.json',
  'group-chat.json',
  'agent-usage-daily.json',
];

export interface CompletedVerificationRef {
  runId: string;
  workspacePath: string;
  sourceWorkspacePath: string;
}

export interface FinishedTeamWorkspaceRef {
  workspacePath: string;
  updatedAt: string;
}

export interface StorageGovernanceContext {
  dataDirectory?: string;
  activeTaskIds(): ReadonlySet<string>;
  knownTaskIds(): ReadonlySet<string>;
  activeRunIds(): ReadonlySet<string>;
  activeWorkspacePaths(): ReadonlySet<string>;
  knownWorkspacePaths(): ReadonlySet<string>;
  knownGroupVerifications(): ReadonlyMap<string, CompletedVerificationRef>;
  finishedTeamWorkspaces(): readonly FinishedTeamWorkspaceRef[];
  /** 每个孤儿工作区若能定位源仓库可辅助 git worktree prune。 */
  sourceCandidates?(): Promise<string[]>;
}

function isContainedIn(rootDir: string, candidatePath: string) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(candidatePath);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

async function directoryBytes(targetPath: string): Promise<number> {
  const first = await fs.lstat(targetPath).catch(() => undefined);
  if (!first) return 0;
  if (first.isSymbolicLink()) return 0;
  if (first.isFile()) return first.size;
  if (!first.isDirectory()) return 0;

  let total = 0;
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(fullPath).catch(() => undefined);
        if (stat && !stat.isSymbolicLink()) total += stat.size;
      }
    }
  }
  return total;
}

interface ReclaimTarget {
  kind: 'rm' | 'slim-verification' | 'remove-copy';
  path: string;
  bytes: number;
  sourceWorkspacePath?: string;
}

interface InternalScanResult {
  report: WorkspaceStorageReport;
  targets: {
    artifactBloat: ReclaimTarget[];
    verificationWorktrees: ReclaimTarget[];
    orphanWorkspaces: ReclaimTarget[];
    finishedTeamDependencies: ReclaimTarget[];
    browserAndRetestCaches: ReclaimTarget[];
  };
}

async function isStoppedLocalRetest(retestDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(retestDir, 'runtime.json'), 'utf8');
    const parsed = JSON.parse(raw) as { state?: unknown };
    return parsed?.state === 'stopped';
  } catch {
    return false;
  }
}

async function isBrowserProfileLocked(profileDir: string): Promise<boolean> {
  const socketPath = path.join(profileDir, 'SingletonSocket');
  const socketStat = await fs.lstat(socketPath).catch(() => undefined);
  if (socketStat) {
    if (!socketStat.isSymbolicLink()) return true;
    const socketTarget = await fs.readlink(socketPath).catch(() => '');
    if (socketTarget) {
      const resolvedSocket = path.resolve(profileDir, socketTarget);
      if (await fs.lstat(resolvedSocket).then(() => true, () => false)) return true;
    }
  }
  const lockPath = path.join(profileDir, 'SingletonLock');
  const lockStat = await fs.lstat(lockPath).catch(() => undefined);
  if (!lockStat) return false;
  if (!lockStat.isSymbolicLink()) return true;
  const lockTarget = await fs.readlink(lockPath).catch(() => '');
  const match = /^(.*)-(\d+)$/.exec(lockTarget);
  if (!match || match[1]!.toLowerCase() !== os.hostname().toLowerCase()) return true;
  const pid = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

async function scanBrowserProfileCaches(profileDir: string): Promise<{ totalBytes: number; cacheTargets: ReclaimTarget[] }> {
  const [locked, totalBytes] = await Promise.all([
    isBrowserProfileLocked(profileDir),
    directoryBytes(profileDir),
  ]);
  if (locked) return { totalBytes, cacheTargets: [] };
  const cacheTargets: ReclaimTarget[] = [];
  for (const entry of await fs.readdir(profileDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const fullPath = path.join(profileDir, entry.name);
    if (browserTopCacheDirs.has(entry.name)) {
      const bytes = await directoryBytes(fullPath);
      if (bytes > 0) cacheTargets.push({ kind: 'rm', path: fullPath, bytes });
    } else if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) {
      for (const sub of await fs.readdir(fullPath, { withFileTypes: true }).catch(() => [])) {
        if (sub.isSymbolicLink() || !sub.isDirectory()) continue;
        const subPath = path.join(fullPath, sub.name);
        if (browserProfileSubCacheDirs.has(sub.name)) {
          const bytes = await directoryBytes(subPath);
          if (bytes > 0) cacheTargets.push({ kind: 'rm', path: subPath, bytes });
        } else if (sub.name === 'Service Worker') {
          for (const swName of browserServiceWorkerCacheDirs) {
            const swPath = path.join(subPath, swName);
            const swStat = await fs.lstat(swPath).catch(() => undefined);
            if (swStat && !swStat.isSymbolicLink() && swStat.isDirectory()) {
              const bytes = await directoryBytes(swPath);
              if (bytes > 0) cacheTargets.push({ kind: 'rm', path: swPath, bytes });
            }
          }
        }
      }
    }
  }
  return { totalBytes, cacheTargets };
}

async function isTemporaryViteBuildDir(dirPath: string): Promise<boolean> {
  const [versionStat, indexStat, assetsStat] = await Promise.all([
    fs.lstat(path.join(dirPath, 'workspace-version.json')).catch(() => undefined),
    fs.lstat(path.join(dirPath, 'index.html')).catch(() => undefined),
    fs.lstat(path.join(dirPath, 'assets')).catch(() => undefined),
  ]);
  return !!versionStat && versionStat.isFile() && !versionStat.isSymbolicLink()
    && !!indexStat && indexStat.isFile() && !indexStat.isSymbolicLink()
    && !!assetsStat && assetsStat.isDirectory() && !assetsStat.isSymbolicLink();
}

const nodeLogsManifestPattern = /^([0-9a-f-]{36}-logs)-[0-9a-f]{64}\.json$/i;

async function readAgedLogsManifests(taskDir: string, ageCutoffMs: number): Promise<Map<string, Set<string>>> {
  const grouped = new Map<string, string[]>();
  const entries = await fs.readdir(taskDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const match = nodeLogsManifestPattern.exec(entry.name);
    if (!match) continue;
    const dirName = match[1]!;
    const list = grouped.get(dirName) || [];
    list.push(path.join(taskDir, entry.name));
    grouped.set(dirName, list);
  }
  const resolvedByDir = new Map<string, Set<string>>();
  for (const [dirName, manifestPaths] of grouped) {
    const referenced = new Set<string>();
    let eligible = true;
    for (const manifestPath of manifestPaths) {
      const stat = await fs.lstat(manifestPath).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs > ageCutoffMs) {
        eligible = false;
        break;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { directory?: unknown; files?: unknown };
        if (!Array.isArray(parsed?.files)) {
          eligible = false;
          break;
        }
        for (const item of parsed.files) {
          if (typeof item !== 'string' || !item || path.isAbsolute(item) || item.split(/[\\/]/).includes('..')) {
            eligible = false;
            break;
          }
          referenced.add(path.resolve(taskDir, dirName, item));
          if (typeof parsed.directory === 'string' && parsed.directory) {
            referenced.add(path.resolve(parsed.directory, item));
          }
        }
        if (!eligible) break;
      } catch {
        eligible = false;
        break;
      }
    }
    if (eligible) resolvedByDir.set(dirName, referenced);
  }
  return resolvedByDir;
}

async function scanManifestBackedLogsDir(
  dirPath: string,
  referenced: Set<string>,
  isRoot = true,
): Promise<{ totalBytes: number; hasKept: boolean; targets: ReclaimTarget[] }> {
  let totalBytes = 0;
  let hasKept = false;
  const childTargets: ReclaimTarget[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      hasKept = true;
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (artifactIgnoredDirs.has(entry.name) || await isTemporaryViteBuildDir(fullPath)) {
        const bytes = await directoryBytes(fullPath);
        totalBytes += bytes;
        if (bytes > 0) childTargets.push({ kind: 'rm', path: fullPath, bytes });
      } else {
        const sub = await scanManifestBackedLogsDir(fullPath, referenced, false);
        totalBytes += sub.totalBytes;
        if (sub.hasKept) {
          hasKept = true;
          childTargets.push(...sub.targets);
        } else if (sub.totalBytes > 0) {
          childTargets.push({ kind: 'rm', path: fullPath, bytes: sub.totalBytes });
        }
      }
    } else if (entry.isFile()) {
      const stat = await fs.lstat(fullPath).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) {
        hasKept = true;
        continue;
      }
      totalBytes += stat.size;
      if (stat.size <= maxArtifactFileBytes && referenced.has(path.resolve(fullPath))) {
        hasKept = true;
      } else if (stat.size > 0) {
        childTargets.push({ kind: 'rm', path: fullPath, bytes: stat.size });
      }
    }
  }
  if (!isRoot && !hasKept) {
    return { totalBytes, hasKept: false, targets: totalBytes > 0 ? [{ kind: 'rm', path: dirPath, bytes: totalBytes }] : [] };
  }
  return { totalBytes, hasKept, targets: childTargets };
}

async function scanArtifactTaskDir(taskDir: string, ageCutoffMs: number): Promise<{ totalBytes: number; bloatTargets: ReclaimTarget[] }> {
  let totalBytes = 0;
  const bloatTargets: ReclaimTarget[] = [];
  const agedManifests = await readAgedLogsManifests(taskDir, ageCutoffMs);
  const stack = [taskDir];
  while (stack.length) {
    const current = stack.pop()!;
    const isTaskRoot = current === taskDir;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const manifestRefs = isTaskRoot ? agedManifests.get(entry.name) : undefined;
        if (manifestRefs) {
          const scanned = await scanManifestBackedLogsDir(fullPath, manifestRefs, true);
          totalBytes += scanned.totalBytes;
          bloatTargets.push(...scanned.targets);
        } else if (artifactIgnoredDirs.has(entry.name) || await isTemporaryViteBuildDir(fullPath)) {
          const bytes = await directoryBytes(fullPath);
          totalBytes += bytes;
          if (bytes > 0) bloatTargets.push({ kind: 'rm', path: fullPath, bytes });
        } else {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        const stat = await fs.lstat(fullPath).catch(() => undefined);
        if (!stat || stat.isSymbolicLink()) continue;
        totalBytes += stat.size;
        if (stat.size > maxArtifactFileBytes) {
          bloatTargets.push({ kind: 'rm', path: fullPath, bytes: stat.size });
        }
      }
    }
  }
  return { totalBytes, bloatTargets };
}

async function scanDependencyDirs(workspaceDir: string): Promise<{ totalBytes: number; cacheTargets: ReclaimTarget[] }> {
  let totalBytes = 0;
  const cacheTargets: ReclaimTarget[] = [];
  const stack = [{ dir: workspaceDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dependencyCacheDirs.has(entry.name)) {
          const bytes = await directoryBytes(fullPath);
          totalBytes += bytes;
          if (bytes > 0) cacheTargets.push({ kind: 'rm', path: fullPath, bytes });
        } else if (entry.name === '.git' || depth >= 3) {
          totalBytes += await directoryBytes(fullPath);
        } else {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        const stat = await fs.lstat(fullPath).catch(() => undefined);
        if (stat && !stat.isSymbolicLink()) totalBytes += stat.size;
      }
    }
  }
  return { totalBytes, cacheTargets };
}

async function slimVerificationCopy(workspaceDir: string, sourceWorkspacePath: string) {
  const stat = await fs.lstat(workspaceDir).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  const parentStat = await fs.lstat(path.dirname(workspaceDir)).catch(() => undefined);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) return;

  const artifactsPath = path.join(workspaceDir, '.delivery-artifacts');
  const artifactsStat = await fs.lstat(artifactsPath).catch(() => undefined);
  const keepArtifacts = !!artifactsStat && !artifactsStat.isSymbolicLink() && artifactsStat.isDirectory();
  const stashPath = keepArtifacts ? path.join(path.dirname(workspaceDir), `.keep-artifacts-${process.pid}-${Date.now()}`) : '';

  if (keepArtifacts) {
    await fs.rm(stashPath, { recursive: true, force: true });
    await fs.rename(artifactsPath, stashPath);
  }
  try {
    if (sourceWorkspacePath) {
      await localWorkflowWorkspace.removeCopy(workspaceDir, sourceWorkspacePath).catch(() => {});
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    if (keepArtifacts) {
      await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      await fs.rename(stashPath, artifactsPath);
    }
  } finally {
    if (stashPath) await fs.rm(stashPath, { recursive: true, force: true }).catch(() => {});
  }
}

export function createStorageGovernance(runtimeDirectory: string, context: StorageGovernanceContext) {
  const resolvedRuntimeDir = path.resolve(runtimeDirectory);
  const resolvedDataDir = context.dataDirectory
    ? path.resolve(context.dataDirectory)
    : (path.basename(resolvedRuntimeDir) === 'agent-runtimes' ? path.dirname(resolvedRuntimeDir) : resolvedRuntimeDir);
  const teamArtifactsRoot = path.join(resolvedRuntimeDir, 'team-artifacts');
  const verificationsRoot = path.join(resolvedRuntimeDir, 'group-verifications');
  const teamWorkspacesRoot = path.join(resolvedRuntimeDir, 'team-workspaces');
  const workspacesRoot = path.join(resolvedRuntimeDir, 'workspaces');
  const sessionsRoot = path.join(resolvedRuntimeDir, 'sessions');
  const localRetestsRoot = path.join(resolvedDataDir, 'refactor-control', 'local-retests');
  const browserProfilesRoot = path.join(resolvedDataDir, 'agent-browser', 'profiles');

  let cachedScan: { at: number; minAgeHours: number; value: InternalScanResult } | undefined;
  let runningOp: Promise<unknown> | undefined;

  async function normalizePathSet(paths: Iterable<string>): Promise<Set<string>> {
    const out = new Set<string>();
    for (const item of paths) {
      if (!item) continue;
      const resolved = path.resolve(item);
      out.add(resolved);
      const real = await fs.realpath(resolved).catch(() => undefined);
      if (real) out.add(real);
    }
    return out;
  }

  async function performScan(minAgeHours = 24): Promise<InternalScanResult> {
    const activeTasks = context.activeTaskIds();
    const knownTasks = context.knownTaskIds();
    const activeRuns = context.activeRunIds();
    const [activeWorkspaces, knownWorkspaces] = await Promise.all([
      normalizePathSet(context.activeWorkspacePaths()),
      normalizePathSet(context.knownWorkspacePaths()),
    ]);
    const knownVerifications = context.knownGroupVerifications();
    const finishedTeams = context.finishedTeamWorkspaces();
    const ageCutoffMs = Date.now() - minAgeHours * 3600_000;

    // 1. team-artifacts
    let artifactsTotal = 0;
    let artifactsItems = 0;
    const artifactTargets: ReclaimTarget[] = [];
    for (const entry of await fs.readdir(teamArtifactsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const taskId = entry.name;
      const taskDir = path.join(teamArtifactsRoot, taskId);
      if (!isContainedIn(teamArtifactsRoot, taskDir)) continue;
      artifactsItems++;
      if (activeTasks.has(taskId)) {
        artifactsTotal += await directoryBytes(taskDir);
        continue;
      }
      if (!knownTasks.has(taskId)) {
        const bytes = await directoryBytes(taskDir);
        artifactsTotal += bytes;
        if (bytes > 0) artifactTargets.push({ kind: 'rm', path: taskDir, bytes });
        continue;
      }
      const { totalBytes, bloatTargets } = await scanArtifactTaskDir(taskDir, ageCutoffMs);
      artifactsTotal += totalBytes;
      artifactTargets.push(...bloatTargets);
    }

    // 2. group-verifications
    let verificationsTotal = 0;
    let verificationsItems = 0;
    const verificationTargets: ReclaimTarget[] = [];
    for (const entry of await fs.readdir(verificationsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const runId = entry.name;
      const runDir = path.join(verificationsRoot, runId);
      if (!isContainedIn(verificationsRoot, runDir)) continue;
      verificationsItems++;
      const workspaceDir = path.join(runDir, 'workspace');
      const resolvedWorkspace = path.resolve(workspaceDir);
      if (activeRuns.has(runId) || activeWorkspaces.has(resolvedWorkspace)) {
        verificationsTotal += await directoryBytes(runDir);
        continue;
      }
      const ref = knownVerifications.get(runId);
      if (!ref) {
        const bytes = await directoryBytes(runDir);
        verificationsTotal += bytes;
        if (bytes > 0) verificationTargets.push({ kind: 'rm', path: runDir, bytes });
        continue;
      }
      const totalRunBytes = await directoryBytes(runDir);
      const preservedBytes = await directoryBytes(path.join(workspaceDir, '.delivery-artifacts'));
      verificationsTotal += totalRunBytes;
      const reclaimable = Math.max(0, totalRunBytes - preservedBytes);
      // 至少有高于目录元数据残余的可回收工作树才标记为待瘦身
      if (reclaimable > 4096) {
        verificationTargets.push({
          kind: 'slim-verification',
          path: workspaceDir,
          bytes: reclaimable,
          sourceWorkspacePath: ref.sourceWorkspacePath,
        });
      }
    }

    // 3. orphanWorkspaces & 4. finishedTeamDependencies
    const finishedByPath = new Map<string, number>();
    for (const item of finishedTeams) {
      if (!item.workspacePath) continue;
      const parsed = Date.parse(item.updatedAt);
      const ts = Number.isFinite(parsed) ? parsed : 0;
      const resolved = path.resolve(item.workspacePath);
      finishedByPath.set(resolved, Math.max(finishedByPath.get(resolved) || 0, ts));
    }

    let workspacesTotal = 0;
    let workspacesItems = 0;
    let finishedDepsTotal = 0;
    let finishedDepsItems = 0;
    const orphanTargets: ReclaimTarget[] = [];
    const dependencyTargets: ReclaimTarget[] = [];

    for (const rootDir of [teamWorkspacesRoot, workspacesRoot, sessionsRoot]) {
      for (const entry of await fs.readdir(rootDir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const copyDir = path.join(rootDir, entry.name);
        if (!isContainedIn(rootDir, copyDir)) continue;
        const resolvedCopy = path.resolve(copyDir);
        const realCopy = await fs.realpath(resolvedCopy).catch(() => undefined);
        const isActive = activeRuns.has(entry.name) || activeWorkspaces.has(resolvedCopy) || (!!realCopy && activeWorkspaces.has(realCopy));
        const isKnown = knownWorkspaces.has(resolvedCopy) || (!!realCopy && knownWorkspaces.has(realCopy));

        workspacesItems++;
        if (isActive) {
          const bytes = await directoryBytes(copyDir);
          workspacesTotal += bytes;
          continue;
        }
        if (!isKnown) {
          const bytes = await directoryBytes(copyDir);
          workspacesTotal += bytes;
          if (rootDir === sessionsRoot || bytes > 0) {
            orphanTargets.push({ kind: rootDir === sessionsRoot ? 'rm' : 'remove-copy', path: copyDir, bytes });
          }
          continue;
        }
        const updatedAt = finishedByPath.get(resolvedCopy) ?? (realCopy ? finishedByPath.get(realCopy) : undefined);
        if (updatedAt !== undefined && updatedAt <= ageCutoffMs) {
          finishedDepsItems++;
          const { totalBytes, cacheTargets } = await scanDependencyDirs(copyDir);
          workspacesTotal += totalBytes;
          finishedDepsTotal += totalBytes;
          dependencyTargets.push(...cacheTargets);
          continue;
        }
        workspacesTotal += await directoryBytes(copyDir);
      }
    }

    // 5. browserAndRetestCaches: 已停止本地复测的依赖缓存 + 未占用浏览器运行缓存（绝不触碰 Cookie 与登录态）
    let browserAndRetestTotal = 0;
    let browserAndRetestItems = 0;
    const browserAndRetestTargets: ReclaimTarget[] = [];
    for (const entry of await fs.readdir(localRetestsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const retestId = entry.name;
      const retestDir = path.join(localRetestsRoot, retestId);
      if (!isContainedIn(localRetestsRoot, retestDir)) continue;
      browserAndRetestItems++;
      const workspaceDir = path.join(retestDir, 'workspace');
      const resolvedWorkspace = path.resolve(workspaceDir);
      const realWorkspace = await fs.realpath(resolvedWorkspace).catch(() => undefined);
      const workspaceBusy = activeRuns.has(retestId)
        || activeWorkspaces.has(resolvedWorkspace)
        || (!!realWorkspace && activeWorkspaces.has(realWorkspace));
      if (workspaceBusy || !(await isStoppedLocalRetest(retestDir))) {
        browserAndRetestTotal += await directoryBytes(retestDir);
        continue;
      }
      const [{ totalBytes, cacheTargets }, runtimeBytes, logBytes] = await Promise.all([
        scanDependencyDirs(workspaceDir),
        fs.lstat(path.join(retestDir, 'runtime.json')).then(s => s.isSymbolicLink() ? 0 : s.size, () => 0),
        fs.lstat(path.join(retestDir, 'startup.log')).then(s => s.isSymbolicLink() ? 0 : s.size, () => 0),
      ]);
      browserAndRetestTotal += totalBytes + runtimeBytes + logBytes;
      browserAndRetestTargets.push(...cacheTargets);
    }
    for (const entry of await fs.readdir(browserProfilesRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const profileDir = path.join(browserProfilesRoot, entry.name);
      if (!isContainedIn(browserProfilesRoot, profileDir)) continue;
      browserAndRetestItems++;
      const { totalBytes, cacheTargets } = await scanBrowserProfileCaches(profileDir);
      browserAndRetestTotal += totalBytes;
      browserAndRetestTargets.push(...cacheTargets);
    }

    const ledgers: WorkspaceLedgerFootprint[] = [];
    for (const name of ledgerFileNames) {
      const stat = await fs.lstat(path.join(resolvedRuntimeDir, name)).catch(() => undefined);
      if (stat && stat.isFile() && !stat.isSymbolicLink()) ledgers.push({ name, bytes: stat.size });
    }

    const sumBytes = (items: ReclaimTarget[]) => items.reduce((sum, item) => sum + item.bytes, 0);
    const buckets: WorkspaceStorageBucket[] = [
      {
        id: 'artifactBloat',
        label: '历史任务临时缓存',
        description: '清理历史任务里混入的重复旧日志副本、依赖包、临时打包产物（dist 等）、浏览器缓存与超大临时文件；已登记的报告、日志和截图全部保留。',
        totalBytes: artifactsTotal,
        reclaimableBytes: sumBytes(artifactTargets),
        itemCount: artifactsItems,
        reclaimableCount: artifactTargets.length,
      },
      {
        id: 'verificationWorktrees',
        label: '群聊临时验证目录',
        description: '清理已结束群聊生成的临时验证副本，保留历史验证结果记录。',
        totalBytes: verificationsTotal,
        reclaimableBytes: sumBytes(verificationTargets),
        itemCount: verificationsItems,
        reclaimableCount: verificationTargets.length,
      },
      {
        id: 'orphanWorkspaces',
        label: '工作区与会话目录',
        description: '占用包含当前实例管理的工作区与会话目录；仅清理已删除会话的残留目录，仍有关联或正在使用的目录保留。',
        totalBytes: workspacesTotal,
        reclaimableBytes: sumBytes(orphanTargets),
        itemCount: workspacesItems,
        reclaimableCount: orphanTargets.length,
      },
      {
        id: 'finishedTeamDependencies',
        label: `已完成任务的依赖包缓存（超过 ${minAgeHours} 小时）`,
        description: '清理老任务副本里的依赖安装缓存（node_modules 等），完整保留所有代码改动与提交记录。',
        totalBytes: finishedDepsTotal,
        reclaimableBytes: sumBytes(dependencyTargets),
        itemCount: finishedDepsItems,
        reclaimableCount: dependencyTargets.length,
      },
      {
        id: 'browserAndRetestCaches',
        label: '本地复测与浏览器缓存',
        description: '清理已停止复测留下的依赖包与闲置浏览器图片/模型缓存；浏览器登录状态（Cookie）和复测代码记录全部保留。',
        totalBytes: browserAndRetestTotal,
        reclaimableBytes: sumBytes(browserAndRetestTargets),
        itemCount: browserAndRetestItems,
        reclaimableCount: browserAndRetestTargets.length,
      },
    ];

    const ledgerTotal = ledgers.reduce((sum, item) => sum + item.bytes, 0);
    const totalBytes = artifactsTotal + verificationsTotal + workspacesTotal + browserAndRetestTotal + ledgerTotal;
    const reclaimableBytes = buckets.reduce((sum, item) => sum + item.reclaimableBytes, 0);

    return {
      report: {
        scannedAt: new Date().toISOString(),
        totalBytes,
        reclaimableBytes,
        buckets,
        ledgers,
      },
      targets: {
        artifactBloat: artifactTargets,
        verificationWorktrees: verificationTargets,
        orphanWorkspaces: orphanTargets,
        finishedTeamDependencies: dependencyTargets,
        browserAndRetestCaches: browserAndRetestTargets,
      },
    };
  }

  async function scan(options: { force?: boolean; minAgeHours?: number } = {}): Promise<WorkspaceStorageReport> {
    if (runningOp) await runningOp.catch(() => {});
    const minAgeHours = Math.max(0, Math.min(720, Math.trunc(options.minAgeHours ?? 24)));
    if (!options.force && cachedScan && cachedScan.minAgeHours === minAgeHours && Date.now() - cachedScan.at < 10_000) {
      return cachedScan.value.report;
    }
    const value = await performScan(minAgeHours);
    cachedScan = { at: Date.now(), minAgeHours, value };
    return value.report;
  }

  async function reclaim(rawInput: unknown): Promise<WorkspaceStorageReclaimResult> {
    if (runningOp) throw new Error('正在执行存储空间扫描或清理，请稍候');
    const input: WorkspaceStorageReclaimInput = workspaceStorageReclaimInputSchema.parse(rawInput ?? {});
    const task = (async () => {
      const before = await performScan(input.minAgeHours);
      const selected: { rootGuard: string[]; target: ReclaimTarget }[] = [];
      if (input.artifactBloat) {
        for (const target of before.targets.artifactBloat) selected.push({ rootGuard: [teamArtifactsRoot], target });
      }
      if (input.verificationWorktrees) {
        for (const target of before.targets.verificationWorktrees) selected.push({ rootGuard: [verificationsRoot], target });
      }
      if (input.orphanWorkspaces) {
        for (const target of before.targets.orphanWorkspaces) {
          selected.push({ rootGuard: [teamWorkspacesRoot, workspacesRoot, sessionsRoot], target });
        }
      }
      if (input.finishedTeamDependencies) {
        for (const target of before.targets.finishedTeamDependencies) {
          selected.push({ rootGuard: [teamWorkspacesRoot, workspacesRoot, sessionsRoot], target });
        }
      }
      if (input.browserAndRetestCaches) {
        for (const target of before.targets.browserAndRetestCaches) {
          selected.push({ rootGuard: [localRetestsRoot, browserProfilesRoot], target });
        }
      }

      const activeTasksNow = context.activeTaskIds();
      const activeRunsNow = context.activeRunIds();
      const activeWorkspacesNow = await normalizePathSet(context.activeWorkspacePaths());
      const sourceRepos = selected.some(item => item.target.kind === 'remove-copy') && context.sourceCandidates
        ? await context.sourceCandidates().catch(() => [])
        : [];

      let reclaimedBytes = 0;
      let reclaimedItems = 0;

      for (const { rootGuard, target } of selected) {
        if (!rootGuard.some(root => isContainedIn(root, target.path))) continue;
        const resolved = path.resolve(target.path);
        if (activeWorkspacesNow.has(resolved)) continue;
        // 二次核对最新活跃任务/运行，防止扫描与清理间隙刚启动的任务被误碰
        const relArtifact = isContainedIn(teamArtifactsRoot, resolved) ? path.relative(teamArtifactsRoot, resolved).split(path.sep)[0] : '';
        if (relArtifact && activeTasksNow.has(relArtifact)) continue;
        const relVerify = isContainedIn(verificationsRoot, resolved) ? path.relative(verificationsRoot, resolved).split(path.sep)[0] : '';
        if (relVerify && activeRunsNow.has(relVerify)) continue;
        const relSession = isContainedIn(sessionsRoot, resolved) ? path.relative(sessionsRoot, resolved).split(path.sep)[0] : '';
        if (relSession && activeRunsNow.has(relSession)) continue;
        if (isContainedIn(localRetestsRoot, resolved)) {
          const retestId = path.relative(localRetestsRoot, resolved).split(path.sep)[0];
          if (!retestId || activeRunsNow.has(retestId) || !(await isStoppedLocalRetest(path.join(localRetestsRoot, retestId)))) continue;
        }
        if (isContainedIn(browserProfilesRoot, resolved)) {
          const profileId = path.relative(browserProfilesRoot, resolved).split(path.sep)[0];
          if (!profileId || await isBrowserProfileLocked(path.join(browserProfilesRoot, profileId))) continue;
        }

        const stat = await fs.lstat(resolved).catch(() => undefined);
        if (!stat || stat.isSymbolicLink()) continue;

        if (target.kind === 'slim-verification') {
          await slimVerificationCopy(resolved, target.sourceWorkspacePath || '');
          reclaimedBytes += target.bytes;
          reclaimedItems++;
        } else if (target.kind === 'remove-copy') {
          for (const repo of sourceRepos) {
            await localWorkflowWorkspace.removeCopy(resolved, repo).catch(() => {});
          }
          await fs.rm(resolved, { recursive: true, force: true });
          reclaimedBytes += target.bytes;
          reclaimedItems++;
        } else {
          await fs.rm(resolved, { recursive: true, force: true });
          reclaimedBytes += target.bytes;
          reclaimedItems++;
        }
      }

      const after = await performScan(input.minAgeHours);
      cachedScan = { at: Date.now(), minAgeHours: input.minAgeHours, value: after };
      const mb = (reclaimedBytes / (1024 * 1024)).toFixed(1);
      return {
        reclaimedAt: new Date().toISOString(),
        reclaimedBytes,
        reclaimedItems,
        message: reclaimedItems > 0
          ? `已安全清理 ${reclaimedItems} 项缓存与无引用临时副本（释放约 ${mb} MB），所有会话记录、交付报告与源码提交完整保留。`
          : '当前没有符合条件的可清理缓存或无引用副本。',
        report: after.report,
      };
    })();

    runningOp = task;
    try {
      return await task;
    } finally {
      runningOp = undefined;
    }
  }

  return { scan, reclaim };
}

export function createStorageGovernanceRoutes(
  governance: ReturnType<typeof createStorageGovernance>,
  host: {
    port: number;
    json(response: ServerResponse, status: number, value: unknown): void;
    body(request: IncomingMessage, limit?: number): Promise<unknown>;
  },
) {
  const isLoopback = (address = '') => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  const validHost = (value = '') => [`localhost:${host.port}`, `127.0.0.1:${host.port}`].includes(value);
  const validOrigin = (value = '') => [`http://localhost:${host.port}`, `http://127.0.0.1:${host.port}`].includes(value);

  return async function handleStorageGovernanceRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/workspace/storage' && url.pathname !== '/api/workspace/storage/reclaim') return false;
    if (!isLoopback(request.socket.remoteAddress) || !validHost(request.headers.host)) {
      host.json(response, 403, { message: '仅接受本机工作台存储管理请求' });
      return true;
    }
    const origin = request.headers.origin;
    if (origin && !validOrigin(origin)) {
      host.json(response, 403, { message: '请求来源不匹配' });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/workspace/storage') {
      const force = url.searchParams.get('force') === '1';
      const minAgeHours = url.searchParams.has('minAgeHours') ? Number(url.searchParams.get('minAgeHours')) : 24;
      host.json(response, 200, await governance.scan({ force, minAgeHours: Number.isFinite(minAgeHours) ? minAgeHours : 24 }));
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/workspace/storage/reclaim') {
      if (!origin || !validOrigin(origin) || request.headers['x-delivery-confirmed'] !== 'yes') {
        host.json(response, 403, { message: '请在本机工作台确认存储清理操作' });
        return true;
      }
      if (!request.headers['content-type']?.includes('application/json')) {
        host.json(response, 415, { message: '请发送 JSON' });
        return true;
      }
      const payload = await host.body(request, 16 * 1024);
      host.json(response, 200, await governance.reclaim(payload));
      return true;
    }
    host.json(response, 405, { message: '请求方法不支持' });
    return true;
  };
}

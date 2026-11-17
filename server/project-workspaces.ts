import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ProjectsData } from '../shared/hub.js';
import { workspaceRemovalInputSchema, workspaceRestoreInputSchema, workspaceScheduleInputSchema,
  type SessionWorkspaceReference, type SessionWorkspaceUsage, type WorkspaceCleanupRule,
  type WorkspaceRemovalPreview, type WorkspaceTrashItem } from '../shared/project-workspaces.js';
import { readProjectGitSnapshot, withProjectGitLock } from './project-git.js';

const exec = promisify(execFile);
const error = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const dirtyReason = '工作区有未提交改动，需手动确认丢弃后删除';
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BLOCKED_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DISPOSABLE_IGNORED_PREFIX_RE =
  /^(?:node_modules|\.pnpm-store|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|coverage|target|\.venv|venv|__pycache__|\.pytest_cache|\.gradle|\.DS_Store)(?:\/|$)/i;
const SENSITIVE_IGNORED_FILE_RE =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.local(?:\/|$)|[^/]*\.(?:pem|key|p12|pfx|keystore|jks)|[^/]*(?:secret|credential|token|private)[^/]*\.(?:json|ya?ml|toml|ini|txt))(?:\/|$)/i;

const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const identitySchema = z.object({ dev: z.string(), ino: z.string(), gitDir: z.string(), gitIno: z.string(),
  common: z.string(), commonIno: z.string() }).strict();
type Identity = z.infer<typeof identitySchema>;
const ruleSchema = z.object({ path: z.string().min(1), deleteAt: z.string().datetime({ offset: true }),
  status: z.enum(['scheduled', 'blocked', 'deleted']), message: z.string().optional(), checkedAt: z.string().optional(),
  blockedCount: z.number().int().nonnegative().optional(),
  blockedSince: z.string().datetime({ offset: true }).optional(),
  nextRetryAt: z.string().datetime({ offset: true }).optional(),
  identity: identitySchema }).strict();
type StoredRule = z.infer<typeof ruleSchema>;
const stateSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema) }).strict()
  .refine(value => new Set(value.rules.map(rule => rule.path)).size === value.rules.length);

export interface ProjectWorkspaceOptions {
  readProjects(refresh?: boolean): Promise<ProjectsData>;
  withWorkspace<T>(directory: string, owner: string, action: () => Promise<T>): Promise<T>;
  checkBusy(directory: string): Promise<void>;
  canRun(): boolean;
  protectedPaths: string[];
  workspaceRoots?: string[];
  sessionWorkspaceRoot?: string;
  sessionWorkspaces?(): SessionWorkspaceReference[];
  inventoryUsageCheck?(): ProjectWorkspaceOptions['checkBusy'];
  now?: () => number;
  intervalMs?: number;
  trashRetentionMs?: number;
}

const publicRule = ({
  identity: _identity,
  blockedCount: _blockedCount,
  blockedSince: _blockedSince,
  nextRetryAt: _nextRetryAt,
  ...rule
}: StoredRule): WorkspaceCleanupRule => ({ ...rule });
const sameIdentity = (left: Identity, right: Identity) => JSON.stringify(left) === JSON.stringify(right);
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
async function readMergeHeads(gitDir: string) {
  const content = await fs.readFile(path.join(gitDir, 'MERGE_HEAD'), 'utf8').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  });
  if (content === undefined) return [];
  const heads = content.trim().split(/\s+/);
  if (heads.some(head => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) throw error('无法确认工作区合并状态，未执行删除');
  return heads;
}
async function git(directory: string, args: string[]) {
  try {
    const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args],
      { env: gitEnvironment(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch { throw error('无法完成工作区 Git 校验或删除，请刷新状态后重试'); }
}

/** 逐个工作区显式排程；没有规则时不扫描或删除任何目录。 */
export async function createProjectWorkspaces(rawDirectory: string, options: ProjectWorkspaceOptions) {
  await fs.mkdir(rawDirectory, { recursive: true, mode: 0o700 });
  const directory = await fs.realpath(rawDirectory), file = path.join(directory, 'workspace-cleanup.json');
  const trashDirectory = path.join(directory, 'trash');
  await fs.mkdir(trashDirectory, { recursive: true, mode: 0o700 });
  const retentionMs = options.trashRetentionMs ?? TRASH_RETENTION_MS;
  const useProductionBackoff = (options.intervalMs ?? 60_000) >= 60_000;
  const protectedPaths = await Promise.all([...options.protectedPaths, directory].map(value =>
    fs.realpath(value).catch(() => path.resolve(value))));
  const workspaceRoots = await Promise.all((options.workspaceRoots || []).map(value =>
    fs.realpath(value).catch(() => path.resolve(value))));
  const configuredSessionRoot = options.sessionWorkspaceRoot;
  const sessionRoot = configuredSessionRoot
    ? await fs.realpath(configuredSessionRoot).catch(() => path.resolve(configuredSessionRoot))
    : undefined;
  const now = options.now || Date.now;
  let rules: StoredRule[] = [], pending: Promise<unknown> = Promise.resolve(), active = 0, closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  async function checkStateFile() {
    const value = await fs.lstat(file).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return undefined;
      throw cause;
    });
    if (value && (!value.isFile() || value.isSymbolicLink())) throw error('工作区清理配置必须为本机普通文件');
  }
  await checkStateFile();
  try { rules = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))).rules; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw error('工作区清理配置读取失败，请保留原文件并检查格式'); }
  function exclusive<T>(action: () => Promise<T>) {
    active++;
    const task = pending.then(async () => {
      try { if (closed) throw error('工作区清理服务已关闭'); return await action(); }
      finally { active--; }
    });
    pending = task.catch(() => {});
    return task;
  }
  async function persist(next: StoredRule[]) {
    await checkStateFile();
    const temporary = path.join(directory, `workspace-cleanup.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, rules: next }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file); rules = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  function assertSessionAssociation(folder: string) {
    if (!options.sessionWorkspaces?.().some(session => path.isAbsolute(session.workspacePath)
      && inside(folder, path.resolve(session.workspacePath)))) {
      throw error('该工作区已无关联会话，请重新扫描');
    }
  }
  async function location(raw: string, refresh = false, sessionWorktree = false) {
    if (!path.isAbsolute(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw error('请选择工作区的完整绝对路径', 400);
    const selected = path.resolve(raw);
    const real = await fs.realpath(selected).catch(() => { throw error('工作区已不存在或无法访问', 404); });
    const entry = await fs.lstat(selected);
    if (!entry.isDirectory() || entry.isSymbolicLink() || selected !== real) throw error('不能通过符号链接或别名删除工作区');
    const blocked = ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/dev', '/proc', '/sys', '/private/etc'];
    if (real === path.parse(real).root || real === os.homedir() || real === path.dirname(os.homedir())
      || ['/Users', '/home', '/Volumes', '/private', '/var', '/private/var', '/tmp', '/private/tmp'].includes(real)
      || blocked.some(root => inside(root, real))
      || workspaceRoots.includes(real)
      || protectedPaths.some(root => inside(real, root) || inside(root, real)
        && !workspaceRoots.some(container => inside(root, container) && inside(container, real) && container !== real))) {
      throw error('此目录受保护，不能删除');
    }
    if (sessionWorktree) assertSessionAssociation(real);
    if (!sessionWorktree || path.dirname(real) !== sessionRoot) {
      const projects = await options.readProjects(refresh);
      if (!projects.projects.some(project => path.resolve(project.path) === real)) throw error('该目录不在当前工作区列表中，不能删除');
    }
    const root = await git(real, ['rev-parse', '--show-toplevel']);
    if (await fs.realpath(root.replace(/\r?\n$/, '')) !== real) throw error('只能删除完整的 Git 工作区，不能删除其父目录或子目录');
    return real;
  }
  async function identity(folder: string): Promise<Identity> {
    const [rootStat, gitDir, common] = await Promise.all([
      fs.lstat(folder, { bigint: true }),
      git(folder, ['rev-parse', '--path-format=absolute', '--git-dir']).then(value => fs.realpath(value.trim())),
      git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(value => fs.realpath(value.trim())),
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error('工作区目录已被替换，未执行删除');
    const [gitStat, commonStat] = await Promise.all([fs.stat(gitDir, { bigint: true }), fs.stat(common, { bigint: true })]);
    return { dev: String(rootStat.dev), ino: String(rootStat.ino), gitDir, gitIno: String(gitStat.ino), common, commonIno: String(commonStat.ino) };
  }
  async function inspectIgnoredFiles(folder: string): Promise<{ ignoredFiles: string[]; sensitiveIgnoredFiles: string[] }> {
    const raw = await git(folder, ['status', '--porcelain=v1', '--ignored=matching', '-z']).catch(() => '');
    const ignoredFiles: string[] = [];
    for (const entry of raw.split('\0')) {
      if (!entry.startsWith('!! ')) continue;
      const rel = entry.slice(3).trim();
      if (!rel || DISPOSABLE_IGNORED_PREFIX_RE.test(rel)) continue;
      ignoredFiles.push(rel);
      if (ignoredFiles.length >= 40) break;
    }
    const sensitiveIgnoredFiles = ignoredFiles.filter(item => SENSITIVE_IGNORED_FILE_RE.test(item));
    return { ignoredFiles, sensitiveIgnoredFiles };
  }
  async function inspect(raw: string, refresh = false, sessionWorktree = false, checkBusy = options.checkBusy) {
    const folder = await location(raw, refresh, sessionWorktree), id = await identity(folder);
    const [snapshot, ignoredInfo] = await Promise.all([
      readProjectGitSnapshot(folder, { forRemoval: true }),
      inspectIgnoredFiles(folder),
    ]);
    const linked = id.gitDir !== id.common;
    const worktrees = (await git(folder, ['worktree', 'list', '--porcelain', '-z'])).split('\0').filter(field => field.startsWith('worktree '));
    const structuralReason = !linked && worktrees.length > 1 ? '其他工作区依赖该主仓库，不能删除'
      : !linked && id.gitDir !== path.join(folder, '.git') ? '独立 Git 元数据目录不能自动删除，请在本机手动处理' : '';
    let reason = structuralReason;
    let mergeHeads: string[] = [];
    try {
      if (structuralReason) throw error(structuralReason);
      if (!snapshot.isGit || snapshot.directory !== folder || !snapshot.head) throw error('无法确认工作区 Git 状态，未执行删除');
      await assertGitIdle(id.gitDir, linked);
      mergeHeads = await readMergeHeads(id.gitDir);
      if (!!mergeHeads.length !== snapshot.mergeInProgress) throw error('工作区合并状态已变化，请刷新后重试');
      if ((await git(folder, ['stash', 'list', '--format=%gd'])).trim()) throw error('仓库有暂存的 stash，未执行删除');
      if (!(await git(folder, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).trim()) throw error('无法确认远端已保存提交，未执行删除');
      const unique = await git(folder, ['rev-list', '--count', 'HEAD', ...mergeHeads, ...(!linked ? ['--branches', '--tags'] : []), '--not', '--remotes']);
      if (!/^0\s*$/.test(unique)) throw error('工作区有未推送提交，未执行删除');
      await checkBusy(folder);
    } catch (cause) { reason = cause instanceof Error ? cause.message : '无法确认工作区是否可删除'; }
    const gitDirty = !snapshot.clean || snapshot.mergeInProgress;
    const dirty = gitDirty || ignoredInfo.sensitiveIgnoredFiles.length > 0;
    const revision = createHash('sha256')
      .update(snapshot.revision)
      .update(JSON.stringify(id))
      .update(mergeHeads.join(' '))
      .update(ignoredInfo.ignoredFiles.join('\0'))
      .digest('hex');
    return {
      folder,
      id,
      revision,
      reason,
      structuralReason,
      dirty,
      gitDirty,
      ignoredFiles: ignoredInfo.ignoredFiles,
      sensitiveIgnoredFiles: ignoredInfo.sensitiveIgnoredFiles,
      preservePaths: [...new Set([...snapshot.files.map(f => f.path), ...ignoredInfo.ignoredFiles])],
      snapshotRevision: snapshot.revision,
      mergeHeads,
    };
  }
  async function assertGitIdle(gitDir: string, linked: boolean) {
    for (const name of ['index.lock', 'rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', ...(linked ? ['locked'] : [])]) {
      if (await fs.lstat(path.join(gitDir, name)).then(() => true, (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return false; throw cause;
      })) throw error('工作区有 Git 操作尚未完成，未执行删除');
    }
  }
  async function refsDigest(folder: string) {
    const values = await Promise.all([
      git(folder, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash']),
      git(folder, ['stash', 'list', '--format=%H']),
      git(folder, ['rev-parse', 'HEAD']), git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return createHash('sha256').update(values.join('\0')).digest('hex');
  }
  function dirtyMessage(result: Pick<Awaited<ReturnType<typeof inspect>>, 'gitDirty' | 'sensitiveIgnoredFiles'>) {
    if (!result.gitDirty && result.sensitiveIgnoredFiles.length > 0) {
      return `工作区包含未提交或被 Git 忽略的本地敏感文件（${result.sensitiveIgnoredFiles.slice(0, 3).join('、')}），需手动确认后移入隔离回收区`;
    }
    return dirtyReason;
  }
  function removalPreview(result: Awaited<ReturnType<typeof inspect>>, rule?: StoredRule): WorkspaceRemovalPreview {
    const reason = result.reason || (result.dirty ? dirtyMessage(result) : '');
    return { path: result.folder, revision: result.revision, eligible: !reason, canSchedule: !result.structuralReason,
      ...(result.dirty && !result.reason ? { requiresDiscardChanges: true } : {}), ...(reason ? { reason } : {}),
      ...(result.ignoredFiles.length ? { ignoredFiles: result.ignoredFiles } : {}),
      ...(result.sensitiveIgnoredFiles.length ? { sensitiveIgnoredFiles: result.sensitiveIgnoredFiles } : {}),
      ...(rule ? { rule: publicRule(rule) } : {}) };
  }
  async function assertNoIgnoredFiles(folder: string) {
    if ((await git(folder, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).length) {
      throw error('含被 Git 忽略的文件，清理前请先处理这些文件');
    }
  }
  async function assertCleanSessionWorktree(checked: Awaited<ReturnType<typeof inspect>>) {
    if (checked.id.gitDir === checked.id.common) throw error('仅可清理会话关联的 Git worktree 副本');
    if (checked.reason) throw error(checked.reason);
    if (checked.gitDirty) throw error('有未提交改动或未跟踪文件');
    await assertNoIgnoredFiles(checked.folder);
  }
  async function pruneExpiredTrash() {
    const entries = await fs.readdir(trashDirectory).catch(() => [] as string[]);
    for (const entryName of entries) {
      const itemDir = path.join(trashDirectory, entryName);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(itemDir, 'metadata.json'), 'utf8')) as WorkspaceTrashItem;
        if (Date.parse(meta.expiresAt) <= now()) {
          await fs.rm(itemDir, { recursive: true, force: true });
        }
      } catch {
        /* Keep unrecognizable folders untouched unless expired */
      }
    }
  }
  async function moveIntoTrash(
    quarantinePath: string,
    originalFolder: string,
    linked: boolean,
    checked: Awaited<ReturnType<typeof inspect>>,
  ) {
    await pruneExpiredTrash().catch(() => {});
    const id = `${now()}-${randomUUID().slice(0, 8)}`;
    const itemDir = path.join(trashDirectory, id);
    await fs.mkdir(itemDir, { recursive: true, mode: 0o700 });
    const deletedAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + retentionMs).toISOString();
    const meta: WorkspaceTrashItem = {
      id,
      originalPath: originalFolder,
      name: path.basename(originalFolder),
      linked,
      deletedAt,
      expiresAt,
      ignoredFiles: checked.ignoredFiles,
      restorable: true,
    };
    if (!linked) {
      const targetWorkspace = path.join(itemDir, 'workspace');
      try {
        await fs.rename(quarantinePath, targetWorkspace);
      } catch {
        await fs.cp(quarantinePath, targetWorkspace, { recursive: true });
        await fs.rm(quarantinePath, { recursive: true, force: true });
      }
    } else {
      // Linked worktree 需要通过 git worktree remove 注销元数据，提前归档保留所有未跟踪与被忽略文件
      const preservedDir = path.join(itemDir, 'preserved');
      await fs.mkdir(preservedDir, { recursive: true, mode: 0o700 });
      for (const rel of checked.preservePaths.slice(0, 80)) {
        const cleanRel = rel.replace(/\/+$/, '');
        if (!cleanRel || cleanRel.split(/[\\/]/).includes('..')) continue;
        const src = path.join(quarantinePath, cleanRel);
        const dest = path.join(preservedDir, cleanRel);
        const existsSrc = await fs.lstat(src).then(st => !st.isSymbolicLink(), () => false);
        if (existsSrc) {
          await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await fs.cp(src, dest, { recursive: true }).catch(() => {});
        }
      }
      await git(quarantinePath, ['worktree', 'remove', ...(checked.dirty ? ['--force'] : []), '--', quarantinePath]);
    }
    await fs.writeFile(path.join(itemDir, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  }
  async function listTrash(): Promise<WorkspaceTrashItem[]> {
    await pruneExpiredTrash().catch(() => {});
    const names = await fs.readdir(trashDirectory).catch(() => [] as string[]);
    const items: WorkspaceTrashItem[] = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(trashDirectory, name, 'metadata.json'), 'utf8')) as WorkspaceTrashItem;
        items.push(meta);
      } catch { /* ignore incomplete item */ }
    }
    return items.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  }
  async function restoreTrash(raw: unknown) {
    const { id } = workspaceRestoreInputSchema.parse(raw);
    if (!/^[0-9]+-[a-f0-9]{8}$/i.test(id)) throw error('回收项编号无效', 400);
    return exclusive(async () => {
      const itemDir = path.join(trashDirectory, id);
      const meta = await fs.readFile(path.join(itemDir, 'metadata.json'), 'utf8')
        .then(text => JSON.parse(text) as WorkspaceTrashItem)
        .catch(() => { throw error('找不到该回收项或已过期清理', 404); });
      const targetExists = await fs.lstat(meta.originalPath).then(() => true, () => false);
      if (!meta.linked) {
        if (targetExists) throw error('原工作区路径已存在同名目录，请先移走后再恢复', 409);
        const storedWorkspace = path.join(itemDir, 'workspace');
        await fs.mkdir(path.dirname(meta.originalPath), { recursive: true });
        try {
          await fs.rename(storedWorkspace, meta.originalPath);
        } catch {
          await fs.cp(storedWorkspace, meta.originalPath, { recursive: true });
        }
        await fs.rm(itemDir, { recursive: true, force: true });
        await options.readProjects(true).catch(() => {});
        return { ok: true as const, restoredPath: meta.originalPath, kind: 'workspace' as const };
      }
      const restoreTarget = targetExists ? `${meta.originalPath}.recovered-${id}` : meta.originalPath;
      await fs.cp(path.join(itemDir, 'preserved'), restoreTarget, { recursive: true });
      await fs.rm(itemDir, { recursive: true, force: true });
      return { ok: true as const, restoredPath: restoreTarget, kind: 'preserved-files' as const };
    });
  }
  async function preview(raw: string, sessionWorktree = false, checkBusy = options.checkBusy): Promise<WorkspaceRemovalPreview> {
    const rule = rules.find(value => value.path === path.resolve(raw));
    try {
      const checked = await inspect(raw, false, sessionWorktree, checkBusy);
      if (sessionWorktree) await assertCleanSessionWorktree(checked);
      return removalPreview(checked, rule);
    } catch (cause) {
      return { path: raw, revision: '', eligible: false, canSchedule: false, reason: cause instanceof Error ? cause.message : '工作区读取失败',
        ...(rule ? { rule: publicRule(rule) } : {}) };
    }
  }
  let inventoryInProgress: Promise<SessionWorkspaceUsage[]> | undefined;
  function sessionInventory() {
    if (inventoryInProgress) return inventoryInProgress;
    inventoryInProgress = scanSessionWorkspaces().finally(() => { inventoryInProgress = undefined; });
    return inventoryInProgress;
  }
  async function scanSessionWorkspaces(): Promise<SessionWorkspaceUsage[]> {
    const byPath = new Map<string, SessionWorkspaceReference[]>();
    for (const entry of options.sessionWorkspaces?.() || []) {
      if (!path.isAbsolute(entry.workspacePath) || /[\x00-\x1f\x7f]/.test(entry.workspacePath)) continue;
      const cwd = path.resolve(entry.workspacePath);
      if (!byPath.has(cwd)) byPath.set(cwd, []);
      byPath.get(cwd)!.push(entry);
    }
    const pendingPaths = byPath.entries();
    const worktrees = new Map<string, { branch: string; sessions: SessionWorkspaceReference[] }>();
    // Worktrees are resolved from session paths, including sessions opened in a subdirectory.
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (const [cwd, sessions] of pendingPaths) {
        try {
          if (await fs.realpath(cwd) !== cwd) continue;
          const [folder, gitDir, commonDir, branch] = (await git(cwd, [
            'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD',
          ])).trimEnd().split('\n');
          if (!folder || !gitDir || !commonDir || gitDir === commonDir || !inside(folder, cwd)) continue;
          if (!worktrees.has(folder)) worktrees.set(folder, { branch, sessions: [] });
          worktrees.get(folder)!.sessions.push(...sessions);
        } catch { /* Deleted, inaccessible, or regular directories do not belong in the worktree inventory. */ }
      }
    }));
    const pendingWorktrees = worktrees.entries();
    const items: SessionWorkspaceUsage[] = [];
    const checkBusy = options.inventoryUsageCheck?.() || options.checkBusy;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (const [folder, entry] of pendingWorktrees) {
        const bySession = new Map<string, SessionWorkspaceUsage['sessions'][number]>();
        for (const { id, title, updatedAt } of entry.sessions) {
          const previous = bySession.get(id);
          if (!previous || updatedAt > previous.updatedAt) bySession.set(id, { id, title, updatedAt });
        }
        const sessions = [...bySession.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const [checked, bytes] = await Promise.all([
          preview(folder, true, checkBusy),
          exec('du', ['-skx', folder], { timeout: 15_000, maxBuffer: 64 * 1024 })
            .then(result => {
              const kilobytes = result.stdout.match(/^(\d+)\s/)?.[1];
              return kilobytes === undefined ? null : Number(kilobytes) * 1024;
            }, () => null),
        ]);
        items.push({ path: folder, branch: entry.branch, bytes, sessions, eligible: checked.eligible, reason: checked.reason });
      }
    }));
    return items.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)
      || b.sessions[0].updatedAt.localeCompare(a.sessions[0].updatedAt) || a.path.localeCompare(b.path));
  }
  async function usageTimestamp(folder: string) {
    const stat = await fs.stat(folder);
    const reflog = await git(folder, ['reflog', 'show', '-1', '--date=unix', '--format=%gD']);
    const sessions = (options.sessionWorkspaces?.() || []).filter(s => path.isAbsolute(s.workspacePath) && inside(folder, path.resolve(s.workspacePath)));
    const timestamps = sessions.map(s => Date.parse(s.updatedAt));
    if (!sessions.length || timestamps.some(t => !Number.isFinite(t))) throw error('无法确认会话最后使用时间');
    return Math.max(stat.mtimeMs, stat.birthtimeMs, Number(reflog.match(/@\{(\d+)\}/)?.[1] || 0) * 1000, ...timestamps);
  }
  async function assertIdleSession(folder: string, idleBefore: number) {
    if (path.dirname(folder) !== sessionRoot) throw error('周期清理仅限宿主管理的会话 worktree');
    if (!Number.isFinite(idleBefore) || idleBefore > now() - 86400_000) throw error('周期清理至少保留一天');
    if (await usageTimestamp(folder) > idleBefore) throw error('会话工作区尚未达到闲置时间');
  }
  async function pluginInventory() {
    return Promise.all((await sessionInventory()).map(async item => {
      try { return { ...item, managed: path.dirname(item.path) === sessionRoot, lastUsedAt: new Date(await usageTimestamp(item.path)).toISOString() }; }
      catch (cause) { return { ...item, managed: false, eligible: false, reason: cause instanceof Error ? cause.message : '无法核验使用时间', lastUsedAt: '' }; }
    }));
  }
  async function erase(raw: string, expected: { revision?: string; identity?: Identity; discardChanges?: true; sessionWorktree?: true; idleBefore?: number }, guard = () => {}) {
    guard();
    if (!options.canRun()) throw error('工作台正在停止或重启，请稍后重试');
    const folder = await location(raw, true, expected.sessionWorktree);
    return options.withWorkspace(folder, `workspace-delete:${randomUUID()}`, () => withProjectGitLock(folder, async () => {
      const refsBefore = await refsDigest(folder);
      const checked = await inspect(folder, true, expected.sessionWorktree);
      if (expected.sessionWorktree) await assertCleanSessionWorktree(checked);
      if (checked.reason) throw error(checked.reason);
      if (expected.revision && checked.revision !== expected.revision) throw error('工作区状态已变化，请刷新后重新确认删除');
      if (expected.identity && !sameIdentity(expected.identity, checked.id)) throw error('工作区目录或仓库已被替换，未执行删除');
      if (checked.dirty && !expected.discardChanges) throw error(dirtyMessage(checked));
      // 删除前先确认配置可持久化；保存失败时绝不触碰工作区。
      await persist(rules);
      await options.checkBusy(folder);
      if (expected.sessionWorktree) assertSessionAssociation(folder);
      if (!sameIdentity(checked.id, await identity(folder)) || await fs.realpath(folder) !== folder) throw error('工作区目录已变化，未执行删除');
      if (expected.idleBefore !== undefined) await assertIdleSession(folder, expected.idleBefore);
      guard();
      const quarantine = path.join(path.dirname(folder), `.delivery-delete-${randomUUID()}`);
      const linked = checked.id.gitDir !== checked.id.common;
      let moved = false;
      try {
        if (linked) await git(folder, ['worktree', 'move', '--', folder, quarantine]);
        else await fs.rename(folder, quarantine);
        moved = true;
        const movedStat = await fs.lstat(quarantine, { bigint: true });
        if (String(movedStat.dev) !== checked.id.dev || String(movedStat.ino) !== checked.id.ino || !movedStat.isDirectory()) throw error('工作区目录已被替换，未执行删除');
        if (await refsDigest(quarantine) !== refsBefore) throw error('仓库分支、提交或 stash 已变化，未执行删除');
        const after = await readProjectGitSnapshot(quarantine, { forRemoval: true });
        const gitDir = linked ? checked.id.gitDir : path.join(quarantine, '.git');
        if (after.revision !== checked.snapshotRevision || (await readMergeHeads(gitDir)).join(' ') !== checked.mergeHeads.join(' ')) {
          throw error('工作区状态已变化，未执行删除');
        }
        await assertGitIdle(gitDir, linked);
        if (expected.sessionWorktree) await assertNoIgnoredFiles(quarantine);
        guard();
        await moveIntoTrash(quarantine, folder, linked, checked);
      } catch (cause) {
        if (moved && await fs.lstat(quarantine).then(() => true, () => false)
          && !await fs.lstat(folder).then(() => true, () => false)) {
          try {
            if (linked) await git(quarantine, ['worktree', 'move', '--', quarantine, folder]);
            else await fs.rename(quarantine, folder);
          } catch { throw error(`删除未完成，原工作区内容保留在 ${quarantine}，请在本机检查`); }
        }
        throw cause;
      }
      await options.readProjects(true).catch(() => {});
      return folder;
    }));
  }
  async function processDue(selected: string) {
      if (closed || !options.canRun()) return;
      // 每条排程执行时重新读取；上一条删除期间排队的取消/延期先得到处理。
      const rule = rules.find(value => value.path === selected);
      if (!rule || rule.status === 'deleted' || Date.parse(rule.deleteAt) > now()) return;
      if (rule.nextRetryAt && Date.parse(rule.nextRetryAt) > now()) return;
      const checkedAt = new Date(now()).toISOString();
      let next: StoredRule;
      try {
        await erase(rule.path, { identity: rule.identity });
        next = { ...rule, status: 'deleted', checkedAt, message: '工作区已按计划移入隔离回收区',
          blockedCount: undefined, blockedSince: undefined, nextRetryAt: undefined };
      } catch (cause) {
        const baseMessage = cause instanceof Error ? cause.message : '工作区清理未完成';
        const blockedCount = (rule.blockedCount || 0) + 1;
        const blockedSince = rule.blockedSince || checkedAt;
        if (useProductionBackoff) {
          const blockedDuration = now() - Date.parse(blockedSince);
          if (blockedDuration >= MAX_BLOCKED_RETRY_WINDOW_MS) {
            next = {
              ...rule,
              status: 'blocked',
              checkedAt,
              blockedCount,
              blockedSince,
              nextRetryAt: '9999-12-31T23:59:59.999Z',
              message: `${baseMessage}（已连续受阻超过 24 小时，已暂停自动重试以防误删，请重新设置排程确认）`,
            };
          } else {
            const delayMs = Math.min(60 * 60_000, 2 * 60_000 * 2 ** Math.min(blockedCount - 1, 5));
            next = {
              ...rule,
              status: 'blocked',
              checkedAt,
              blockedCount,
              blockedSince,
              nextRetryAt: new Date(now() + delayMs).toISOString(),
              message: baseMessage,
            };
          }
        } else {
          next = { ...rule, status: 'blocked', checkedAt, blockedCount, blockedSince, message: baseMessage };
        }
      }
      await persist(rules.map(value => value.path === rule.path ? next : value));
  }
  return {
    preview, sessionInventory, pluginInventory,
    async removeSessionWorkspace(raw: unknown, guard: () => void) {
      const input = z.object({ path: z.string().min(1).max(2000), revision: z.string().min(1).max(200),
        confirmName: z.string().min(1).max(255), idleBefore: z.number().finite().optional() }).strict().parse(raw);
      return exclusive(async () => {
        guard();
        if (input.confirmName !== path.basename(input.path)) throw error('请输入当前工作区文件夹名称以确认删除', 400);
        const removed = await erase(input.path, { ...input, sessionWorktree: true }, guard);
        return { path: removed, deleted: true as const };
      });
    },
    list: () => rules.map(publicRule),
    listTrash,
    restoreTrash,
    async remove(raw: unknown) {
      const input = workspaceRemovalInputSchema.parse(raw);
      return exclusive(async () => {
        if (input.confirmName !== path.basename(input.path)) throw error('请输入当前工作区文件夹名称以确认删除', 400);
        if (input.sessionWorktree && input.discardChanges) throw error('会话工作区清理不能丢弃改动', 400);
        const removed = await erase(input.path, input);
        const previous = rules.find(rule => rule.path === removed);
        if (previous) await persist(rules.map(rule => rule.path === removed ? { ...rule, status: 'deleted' as const,
          checkedAt: new Date(now()).toISOString(), message: '工作区已手动删除' } : rule));
        return { path: removed, deleted: true as const };
      });
    },
    async schedule(raw: unknown) {
      const input = workspaceScheduleInputSchema.parse(raw);
      return exclusive(async () => {
        if (input.deleteAt === null) {
          const selected = path.resolve(input.path);
          await persist(rules.filter(rule => rule.path !== selected));
          return preview(selected);
        }
        if (Date.parse(input.deleteAt) <= now()) throw error('请选择未来的自动删除日期和时间', 400);
        if (input.confirmName !== path.basename(input.path)) throw error('请输入当前工作区文件夹名称以确认自动删除', 400);
        const checked = await inspect(input.path, true);
        if (checked.structuralReason) throw error(checked.structuralReason);
        if (checked.revision !== input.revision) throw error('工作区状态已变化，请刷新后重新设置');
        const rule: StoredRule = { path: checked.folder, deleteAt: new Date(input.deleteAt).toISOString(), status: 'scheduled', identity: checked.id };
        await persist([...rules.filter(value => value.path !== rule.path), rule]);
        return removalPreview(checked, rule);
      });
    },
    start() {
      if (timer || closed) return;
      const tick = () => {
        if (closed || active || ticking || !options.canRun()) return;
        const due = rules.filter(rule => rule.status !== 'deleted'
          && Date.parse(rule.deleteAt) <= now()
          && (!rule.nextRetryAt || Date.parse(rule.nextRetryAt) <= now())).map(rule => rule.path);
        if (!due.length) return;
        ticking = (async () => {
          for (const selected of due) {
            if (closed || !options.canRun()) return;
            await exclusive(() => processDue(selected));
          }
        })().catch(() => { /* 持久化失败不继续删除下一条。 */ }).finally(() => { ticking = undefined; });
      };
      timer = setInterval(tick, options.intervalMs || 60_000); timer.unref(); tick();
    },
    isIdle: () => active === 0 && !ticking,
    async close() { if (timer) clearInterval(timer); timer = undefined; closed = true; await ticking; await pending; },
  };
}

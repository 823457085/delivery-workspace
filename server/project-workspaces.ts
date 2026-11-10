import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ProjectsData } from '../shared/hub.js';
import { workspaceRemovalInputSchema, workspaceScheduleInputSchema,
  type WorkspaceCleanupRule, type WorkspaceRemovalPreview } from '../shared/project-workspaces.js';
import { readProjectGitSnapshot, withProjectGitLock } from './project-git.js';

const exec = promisify(execFile);
const error = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const dirtyReason = '工作区有未提交改动，需手动确认丢弃后删除';
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const identitySchema = z.object({ dev: z.string(), ino: z.string(), gitDir: z.string(), gitIno: z.string(),
  common: z.string(), commonIno: z.string() }).strict();
type Identity = z.infer<typeof identitySchema>;
const ruleSchema = z.object({ path: z.string().min(1), deleteAt: z.string().datetime({ offset: true }),
  status: z.enum(['scheduled', 'blocked', 'deleted']), message: z.string().optional(), checkedAt: z.string().optional(),
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
  now?: () => number;
  intervalMs?: number;
}

const publicRule = ({ identity: _identity, ...rule }: StoredRule): WorkspaceCleanupRule => ({ ...rule });
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
  const protectedPaths = await Promise.all([...options.protectedPaths, directory].map(value =>
    fs.realpath(value).catch(() => path.resolve(value))));
  const workspaceRoots = await Promise.all((options.workspaceRoots || []).map(value =>
    fs.realpath(value).catch(() => path.resolve(value))));
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
  async function location(raw: string, refresh = false) {
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
    const projects = await options.readProjects(refresh);
    if (!projects.projects.some(project => path.resolve(project.path) === real)) throw error('该目录不在当前工作区列表中，不能删除');
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
  async function inspect(raw: string, refresh = false) {
    const folder = await location(raw, refresh), id = await identity(folder);
    const snapshot = await readProjectGitSnapshot(folder, { forRemoval: true });
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
      await options.checkBusy(folder);
    } catch (cause) { reason = cause instanceof Error ? cause.message : '无法确认工作区是否可删除'; }
    const revision = createHash('sha256').update(snapshot.revision).update(JSON.stringify(id)).update(mergeHeads.join(' ')).digest('hex');
    return { folder, id, revision, reason, structuralReason, dirty: !snapshot.clean || snapshot.mergeInProgress, snapshotRevision: snapshot.revision, mergeHeads };
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
  function removalPreview(result: Awaited<ReturnType<typeof inspect>>, rule?: StoredRule): WorkspaceRemovalPreview {
    const reason = result.reason || (result.dirty ? dirtyReason : '');
    return { path: result.folder, revision: result.revision, eligible: !reason, canSchedule: !result.structuralReason,
      ...(result.dirty && !result.reason ? { requiresDiscardChanges: true } : {}), ...(reason ? { reason } : {}),
      ...(rule ? { rule: publicRule(rule) } : {}) };
  }
  async function preview(raw: string): Promise<WorkspaceRemovalPreview> {
    const rule = rules.find(value => value.path === path.resolve(raw));
    try {
      return removalPreview(await inspect(raw), rule);
    } catch (cause) {
      return { path: raw, revision: '', eligible: false, canSchedule: false, reason: cause instanceof Error ? cause.message : '工作区读取失败',
        ...(rule ? { rule: publicRule(rule) } : {}) };
    }
  }
  async function erase(raw: string, expected: { revision?: string; identity?: Identity; discardChanges?: true }) {
    if (!options.canRun()) throw error('工作台正在停止或重启，请稍后重试');
    const folder = await location(raw, true);
    return options.withWorkspace(folder, `workspace-delete:${randomUUID()}`, () => withProjectGitLock(folder, async () => {
      const refsBefore = await refsDigest(folder);
      const checked = await inspect(folder, true);
      if (checked.reason) throw error(checked.reason);
      if (expected.revision && checked.revision !== expected.revision) throw error('工作区状态已变化，请刷新后重新确认删除');
      if (expected.identity && !sameIdentity(expected.identity, checked.id)) throw error('工作区目录或仓库已被替换，未执行删除');
      if (checked.dirty && !expected.discardChanges) throw error(dirtyReason);
      // 删除前先确认配置可持久化；保存失败时绝不触碰工作区。
      await persist(rules);
      await options.checkBusy(folder);
      if (!sameIdentity(checked.id, await identity(folder)) || await fs.realpath(folder) !== folder) throw error('工作区目录已变化，未执行删除');
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
        if (linked) await git(quarantine, ['worktree', 'remove', ...(checked.dirty ? ['--force'] : []), '--', quarantine]);
        else await fs.rm(quarantine, { recursive: true });
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
      const checkedAt = new Date(now()).toISOString();
      let next: StoredRule;
      try {
        await erase(rule.path, { identity: rule.identity });
        next = { ...rule, status: 'deleted', checkedAt, message: '工作区已按计划删除' };
      } catch (cause) {
        next = { ...rule, status: 'blocked', checkedAt, message: cause instanceof Error ? cause.message : '工作区清理未完成' };
      }
      await persist(rules.map(value => value.path === rule.path ? next : value));
  }
  return {
    preview,
    list: () => rules.map(publicRule),
    async remove(raw: unknown) {
      const input = workspaceRemovalInputSchema.parse(raw);
      return exclusive(async () => {
        if (input.confirmName !== path.basename(input.path)) throw error('请输入当前工作区文件夹名称以确认删除', 400);
        const removed = await erase(input.path, { revision: input.revision, discardChanges: input.discardChanges });
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
        const due = rules.filter(rule => rule.status !== 'deleted' && Date.parse(rule.deleteAt) <= now()).map(rule => rule.path);
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

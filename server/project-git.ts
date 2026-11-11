import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { hasConflictMarkers } from '../shared/project-code.js';
import { verificationArtifactDirectory } from './agent-workflow.js';
import type { SourceBackend } from './source-backend.js';

const exec = promisify(execFile);
const maxCodeBytes = 2 * 1024 * 1024;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const hiddenDirectories = new Set(['.git', 'node_modules', '.data', '.next', '.nuxt', '.cache', '.venv', 'venv']);
const privateName = (name: string) =>
  (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))
  || /^(?:id_rsa|id_ed25519|credentials\.json)$/.test(name)
  || /\.(?:key|pem|p12|pfx)$/.test(name);

export const redact = (value: unknown) =>
  String(value)
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|glpat-[\w-]+)\b/g, '[redacted]');

async function gitRaw(directory: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
  });
  return stdout;
}

async function runGit(directory: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout, stderr } = await exec('git', ['-C', directory, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
    });
    return stdout || stderr;
  } catch (error: unknown) {
    const err = error as { killed?: boolean; stderr?: string; stdout?: string };
    throw Object.assign(fail(redact(err.killed ? 'Git 操作超时，请刷新仓库状态后查看实际结果。' : err.stderr || err.stdout || 'Git 操作未完成。').slice(0, 5000), 409),
      { gitPushRejected: args[0] === 'push' && !err.killed && /Authentication failed|HTTP Basic: Access denied|requested URL returned error: (?:401|403)|Permission denied \(publickey\)|Repository not found|\[rejected\]|\[remote rejected\]/i.test(`${err.stderr || ''}\n${err.stdout || ''}`) });
  }
}

async function resolveDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()) || value.includes('\0')) {
    throw fail('请选择本机文件夹的完整绝对路径。');
  }
  const real = await fs.realpath(value.trim()).catch(() => {
    throw fail('文件夹不存在或无法访问。', 404);
  });
  if (!(await fs.stat(real)).isDirectory()) throw fail('所选路径不是文件夹。');
  return real;
}

function validateRelativePath(value = '', preview = true): string {
  if (
    typeof value !== 'string'
    || value.length > 2000
    || path.isAbsolute(value)
    || value.includes('\0')
    || value.split(/[\\/]/).some((part) => part === '..' || part === '.git' || (preview && (hiddenDirectories.has(part) || privateName(part))))
  ) {
    throw fail('请选择项目内可浏览的代码文件。', 403);
  }
  return value;
}

async function resolvePreviewTarget(root: string, relative: string): Promise<string> {
  const target = await fs.realpath(path.resolve(root, relative)).catch((error: { code?: string }) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw fail('文件或目录已不存在，请刷新后重新选择。', 404);
    throw fail('文件或目录无法读取，请检查本机访问权限。', 403);
  });
  if (!inside(root, target)) throw fail('文件或目录不在当前项目内。', 403);
  validateRelativePath(path.relative(root, target));
  return target;
}

export interface ProjectGitFileItem {
  status: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  originalPath?: string;
}

export interface ProjectGitBranchItem {
  ref: string;
  name: string;
  remote: boolean;
  sha: string;
  upstream: string;
  current: boolean;
  localBranch?: string;
  multipleTrackingBranches?: boolean;
  upstreamRemote: string;
  upstreamRef: string;
  worktreePaths: string[];
  switchBlockedReason: string;
}

export interface ProjectGitRemoteItem {
  name: string;
  url: string;
  pushUrl: string;
  pushUrls: string[];
  host: string;
  provider: string;
  webUrl: string;
}

export interface ProjectGitCommitItem {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface ProjectGitMergePreview {
  sourceRef: string;
  sourceName: string;
  sourceSha: string;
  targetRef: string;
  targetName: string;
  targetSha: string;
  mergeBase: string;
  ahead: number;
  behind: number;
  alreadyMerged: boolean;
  canFastForward: boolean;
  commits: ProjectGitCommitItem[];
  commitsTruncated: boolean;
  files: { path: string; additions: number | null; deletions: number | null; binary: boolean }[];
  filesTruncated: boolean;
  totals: { files: number; additions: number; deletions: number; binaryFiles: number };
  branchDiff: { files: { path: string; status: string }[]; total: number };
}

export interface ProjectGitSnapshot {
  available: boolean;
  isGit: boolean;
  directory: string;
  branch: string;
  head: string;
  upstream: string;
  ahead: number | null;
  behind: number | null;
  checkedAt: string;
  counts: {
    total: number;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
  };
  clean: boolean;
  files: ProjectGitFileItem[];
  truncated: boolean;
  branches: ProjectGitBranchItem[];
  remotes: ProjectGitRemoteItem[];
  mergeInProgress: boolean;
  log: ProjectGitCommitItem[];
  revision: string;
}

function remoteInfo(name: string, url: string, pushUrl: string): Omit<ProjectGitRemoteItem, 'pushUrls'> {
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    const match = url.match(/^[^@]+@([^:]+):(.+)$/);
    if (match) {
      host = match[1];
      pathname = '/' + match[2];
    }
  }
  return {
    name,
    url: redact(url),
    pushUrl: redact(pushUrl),
    host,
    provider: host === 'codeup.aliyun.com' ? 'Codeup' : host === 'github.com' ? 'GitHub' : /gitlab/i.test(host) ? 'GitLab' : 'Git',
    webUrl: host ? `https://${host}${pathname.replace(/\.git$/, '')}` : '',
  };
}

export function validateRemoteUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\s\x00-\x1f]/.test(value) || value.startsWith('-')) {
    throw fail('请输入有效的 SSH 或 HTTPS 仓库地址。');
  }
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw fail('请输入有效的 SSH 或 HTTPS 仓库地址。');
  }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || (url.protocol === 'https:' && url.username)) {
    throw fail('仓库地址不能包含密码或 Token，请使用本机 Git 凭据。');
  }
  return trimmed;
}

async function validateBranchName(directory: string, value: unknown): Promise<string> {
  const invalidName = '分支名称格式不正确。可参考「feature/APEX-655-fix」，请避开空格、连续斜杠和保留名称 HEAD。';
  if (typeof value !== 'string' || value.length > 200) throw fail(invalidName);
  const branch = value.trim();
  if (!branch || branch === 'HEAD' || branch.startsWith('-') || /[\x00-\x20]/.test(branch)) throw fail(invalidName);
  try {
    await gitRaw(directory, ['check-ref-format', `refs/heads/${branch}`]);
  } catch (error) {
    if ((error as { code?: string | number }).code === 1) throw fail(invalidName);
    throw fail('暂时无法校验分支名称，请刷新仓库状态后重试。', 409);
  }
  return branch;
}

async function ensureNewLocalBranchName(directory: string, branch: string, branches: ProjectGitBranchItem[]) {
  const localBranches = branches.filter(item => !item.remote);
  const findConflict = (ignoreCase: boolean) => {
    const candidate = ignoreCase ? branch.toLowerCase() : branch;
    const conflict = localBranches.find(({ name }) => {
      const existing = ignoreCase ? name.toLowerCase() : name;
      return existing === candidate || candidate.startsWith(`${existing}/`) || existing.startsWith(`${candidate}/`);
    });
    if (conflict) {
      if (conflict.name === branch) return `本地分支「${branch}」已存在，请更换分支名。`;
      if (conflict.name.toLowerCase() === candidate) {
        return `本地分支「${conflict.name}」已存在，与你输入的名称仅大小写不同。要从所选起点新建，请更换分支名。`;
      }
      return `分支名「${branch}」与本地分支「${conflict.name}」存在路径冲突。Git 分支名不能同时作为其他分支的目录，请更换分支名。`;
    }
    if (!ignoreCase) return;

    // 复用已有目录的拼写，避免 HEAD 中的分支名与磁盘上的引用名称不一致。
    const parts = branch.split('/');
    for (const { name } of localBranches) {
      const existing = name.split('/');
      for (let i = 0; i < Math.min(parts.length, existing.length) - 1; i++) {
        if (parts[i].toLowerCase() !== existing[i].toLowerCase()) break;
        if (parts[i] !== existing[i]) return `分支目录仅大小写不同，请沿用已有目录的拼写「${existing.slice(0, i + 1).join('/')}」。`;
      }
    }
  };
  const exact = findConflict(false);
  if (exact) throw fail(exact, 409);
  const caseConflict = findConflict(true);
  if (caseConflict && (await gitRaw(directory, ['config', '--bool', '--get', 'core.ignoreCase']).catch(() => '')).trim() === 'true') {
    throw fail(caseConflict, 409);
  }
}

export async function readProjectGitSnapshot(rawDirectory: string, options: { forRemoval?: boolean; forDelivery?: boolean } = {}): Promise<ProjectGitSnapshot> {
  let directory = await resolveDirectory(rawDirectory);
  let isGit = false;
  try {
    const root = await gitRaw(directory, ['rev-parse', '--show-toplevel']);
    directory = await fs.realpath(root.replace(/\r?\n$/, ''));
    isGit = true;
  } catch {
    isGit = false;
  }
  if (!isGit) {
    return {
      available: true,
      isGit: false,
      directory,
      branch: '',
      head: '',
      upstream: '',
      ahead: null,
      behind: null,
      checkedAt: new Date().toISOString(),
      counts: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
      clean: true,
      files: [],
      truncated: false,
      branches: [],
      remotes: [],
      mergeInProgress: false,
      log: [],
      revision: '',
    };
  }

  const [statusOut, branchOut, headOut, upstreamOut, divergenceOut, refsOut, namesOut, historyOut, mergeOut, indexOut, worktreesOut] = await Promise.all([
    gitRaw(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all',
      ...(options.forDelivery ? ['--', `:(top,exclude,literal)${verificationArtifactDirectory}`] : [])]),
    gitRaw(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    gitRaw(directory, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    gitRaw(directory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    gitRaw(directory, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => ''),
    runGit(directory, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads', 'refs/remotes']),
    runGit(directory, ['remote']),
    runGit(directory, ['log', '-30', '--format=%H%x00%s%x00%an%x00%aI']).catch(() => ''),
    runGit(directory, ['rev-parse', '--verify', 'MERGE_HEAD']).catch(() => ''),
    runGit(directory, ['ls-files', '--stage', '-z']),
    gitRaw(directory, ['worktree', 'list', '--porcelain', '-z']),
  ]);

  const entries = statusOut.split('\0');
  const files: ProjectGitFileItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    const item: ProjectGitFileItem = {
      status: code.trim(),
      path: entry.slice(3),
      staged: !conflict && code[0] !== ' ' && code[0] !== '?',
      unstaged: !conflict && code[1] !== ' ' && code[1] !== '?',
      untracked: code === '??',
      conflict,
    };
    if (/[RC]/.test(code)) {
      item.originalPath = entries[i + 1];
      i++;
    }
    files.push(item);
  }

  const [ahead, behind] = divergenceOut.trim().split(/\s+/).map(Number);
  const upstream = upstreamOut.trim();
  const branches: ProjectGitBranchItem[] = refsOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, branchUpstream, current, upstreamRemote, upstreamRef] = line.split('\0');
      return {
        ref,
        name: ref.replace(/^refs\/(heads|remotes)\//, ''),
        remote: ref.startsWith('refs/remotes/'),
        sha,
        upstream: branchUpstream,
        current: current === '*',
        upstreamRemote,
        upstreamRef,
        worktreePaths: [],
        switchBlockedReason: '',
      };
    })
    .filter((b) => !b.remote || !b.name.endsWith('/HEAD'));

  // NUL-delimited porcelain preserves spaces, Unicode and newlines in worktree paths.
  const worktrees = new Map<string, string[]>();
  let worktreePath = '';
  for (const field of worktreesOut.split('\0')) {
    if (!field) worktreePath = '';
    else if (field.startsWith('worktree ')) worktreePath = field.slice(9);
    else if (field.startsWith('branch ') && worktreePath) {
      const ref = field.slice(7);
      const canonical = await fs.realpath(worktreePath).catch(() => worktreePath);
      worktrees.set(ref, [...(worktrees.get(ref) || []), canonical]);
    }
  }
  for (const branch of branches.filter(b => !b.remote)) {
    branch.worktreePaths = worktrees.get(branch.ref) || [];
    const occupied = branch.worktreePaths.filter(location => location !== directory);
    if (occupied.length) branch.switchBlockedReason = `该分支已在其他工作区检出，请在对应工作区操作：${occupied.join('、')}`;
  }

  for (const branch of branches.filter((b) => b.remote)) {
    const tracked = branches.filter((b) => !b.remote && b.upstream === branch.name);
    const local =
      tracked.find((b) => b.current)
      || tracked.find((b) => b.name === branch.name.slice(branch.name.indexOf('/') + 1))
      || (tracked.length === 1 ? tracked[0] : null);
    branch.localBranch = local?.name || '';
    branch.multipleTrackingBranches = !local && tracked.length > 1;
    branch.worktreePaths = local?.worktreePaths || [];
    branch.switchBlockedReason = local?.switchBlockedReason || (branch.multipleTrackingBranches
      ? '有多个本地分支跟踪此远程分支，请从本地分支列表选择。'
      : !local && branches.some(b => !b.remote && b.name === branch.name.slice(branch.name.indexOf('/') + 1))
        ? '同名本地分支未跟踪此远程分支，请从本地分支列表选择。' : '');
  }

  const remotes: ProjectGitRemoteItem[] = await Promise.all(
    namesOut
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(async (name) => {
        const pushUrls = (await runGit(directory, ['remote', 'get-url', '--push', '--all', name])).trim().split('\n');
        const fetchUrl = (await runGit(directory, ['remote', 'get-url', name])).trim();
        return {
          ...remoteInfo(name, fetchUrl, pushUrls[0] || fetchUrl),
          pushUrls: pushUrls.map(redact),
        };
      }),
  );

  const head = headOut.trim();
  const conflictFiles = files.filter((file) => file.conflict);
  const cappedFiles = [...conflictFiles, ...files.filter((file) => !file.conflict)].slice(0, 200);
  const revisionFiles = options.forRemoval ? files : cappedFiles;
  const workingFiles = await Promise.all(revisionFiles.map(async file => {
    const stat = await fs.lstat(path.join(directory, file.path), { bigint: true }).catch(() => undefined);
    return stat ? `${file.path}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}` : `${file.path}\0missing`;
  }));
  // 删除会先隔离目录，复核时只忽略本工作区的路径变化。
  const revisionWorktrees = options.forRemoval
    ? worktreesOut.split('\0').map(field => field === `worktree ${directory}` ? 'worktree' : field).join('\0')
    : worktreesOut;
  const revision = createHash('sha256')
    .update(`${head}\0${indexOut}\0${statusOut}\0${workingFiles.join('\0')}\0${refsOut}\0${revisionWorktrees}\0${mergeOut}\0${JSON.stringify(remotes)}`)
    .digest('hex');

  return {
    available: true,
    isGit: true,
    directory,
    branch: branchOut.trim(),
    head,
    upstream,
    ahead: upstream && Number.isFinite(ahead) ? ahead : null,
    behind: upstream && Number.isFinite(behind) ? behind : null,
    checkedAt: new Date().toISOString(),
    counts: {
      total: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
      conflicts: conflictFiles.length,
    },
    clean: files.length === 0,
    files: cappedFiles,
    truncated: files.length > 200,
    branches,
    remotes,
    mergeInProgress: Boolean(mergeOut.trim()),
    log: historyOut
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, author, date] = line.split('\0');
        return { sha, subject, author, date };
      }),
    revision,
  };
}

export async function readProjectTree(rawDirectory: string, relative = '') {
  validateRelativePath(relative);
  const root = await resolveDirectory(rawDirectory);
  const target = await resolvePreviewTarget(root, relative);
  if (!(await fs.stat(target)).isDirectory()) throw fail('所选路径不是文件夹。');
  const entries = (await fs.readdir(target, { withFileTypes: true })).filter(
    (entry) => !hiddenDirectories.has(entry.name) && !privateName(entry.name),
  );
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return {
    path: relative,
    parent: relative ? (path.dirname(relative) === '.' ? '' : path.dirname(relative)) : '',
    entries: entries.slice(0, 1000).map((entry) => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      directory: entry.isDirectory(),
      symlink: entry.isSymbolicLink(),
    })),
    truncated: entries.length > 1000,
  };
}

export async function readProjectCode(rawDirectory: string, relative: string) {
  validateRelativePath(relative);
  const root = await resolveDirectory(rawDirectory);
  const filename = await resolvePreviewTarget(root, relative);
  const stat = await fs.stat(filename, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maxCodeBytes)) {
    throw fail('仅支持预览 2 MiB 以内的文本文件。');
  }
  const bytes = await fs.readFile(filename);
  if (bytes.includes(0)) throw fail('该文件不是可预览的文本文件。');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw fail('仅支持 UTF-8 文本文件。');
  const [context, unmerged] = await Promise.all([
    gitRaw(root, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']).catch(() => ''),
    gitRaw(root, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', relative]).catch(() => ''),
  ]);
  const revision = createHash('sha256').update(`${filename}\0${stat.ino}\0${stat.mode}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${context}\0${unmerged}\0`).update(bytes).digest('hex');
  return { path: relative, content, size: bytes.length, revision, conflict: !!unmerged, editable: filename === path.resolve(root, relative) };
}

export async function readProjectDiff(rawDirectory: string, file: string, staged: boolean) {
  validateRelativePath(file, false);
  const snapshot = await readProjectGitSnapshot(rawDirectory);
  const directory = snapshot.directory;
  const item = snapshot.files.find((f) => f.path === file);
  if (!item) throw fail('当前文件没有待提交改动。');
  if (item.untracked) {
    const code = await readProjectCode(directory, file);
    return { patch: code.content.split('\n').map((line) => `+${line}`).join('\n'), truncated: false };
  }
  const patch = await runGit(directory, [
    '--literal-pathspecs',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(staged ? ['--cached'] : []),
    '--',
    file,
    ...(item.originalPath ? [item.originalPath] : []),
  ]);
  return { patch: patch.slice(0, 512 * 1024), truncated: patch.length > 512 * 1024 };
}

const repoLocks = new Set<string>();

/** 工作区清理与编辑、分支、提交等操作共用同一仓库锁。 */
export async function withProjectGitLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const common = (await gitRaw(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (repoLocks.has(common)) throw fail('该仓库有 Git 操作正在执行，请稍后再试。', 409);
  repoLocks.add(common);
  try { return await action(); }
  finally { repoLocks.delete(common); }
}

export async function saveProjectCode(input: Record<string, unknown>) {
  if (typeof input.file !== 'string' || typeof input.content !== 'string' || typeof input.revision !== 'string' || !input.revision) {
    throw fail('请先读取文件后再保存。');
  }
  validateRelativePath(input.file);
  const content = input.content;
  if (Buffer.byteLength(content, 'utf8') > maxCodeBytes || content.includes('\0')) throw fail('仅支持保存 2 MiB 以内的 UTF-8 文本文件。');
  const directory = await resolveDirectory(input.path);
  const common = (await gitRaw(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => {
    throw fail('当前目录不是可用的 Git 仓库。');
  })).trim();
  if (repoLocks.has(common)) throw fail('该仓库有 Git 操作正在执行，请稍后再试。', 409);
  repoLocks.add(common);
  try {
    const current = await readProjectCode(directory, input.file);
    if (!current.editable) throw fail('符号链接文件仅支持预览，请打开原文件编辑。', 403);
    if (current.revision !== input.revision) throw fail('文件或分支已变化，未覆盖磁盘内容。请保留编辑内容并重新打开文件。', 409);
    if (input.resolve === true) {
      if (!current.conflict) throw fail('该文件已不处于冲突状态，请重新打开文件。', 409);
      if (hasConflictMarkers(content)) throw fail('仍有冲突标记，请处理完成后再标记已解决。', 409);
    }
    const filename = await resolvePreviewTarget(directory, input.file);
    const handle = await fs.open(filename, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      const latest = await fs.stat(filename, { bigint: true });
      if (stat.ino !== latest.ino || (await readProjectCode(directory, input.file)).revision !== input.revision) {
        throw fail('文件或分支已变化，未覆盖磁盘内容。请保留编辑内容并重新打开文件。', 409);
      }
      const bytes = Buffer.from(content, 'utf8');
      await handle.writeFile(bytes);
      await handle.truncate(bytes.length);
    } finally {
      await handle.close();
    }
    let resolutionError: string | undefined;
    if (input.resolve === true) {
      try { await runGit(directory, ['--literal-pathspecs', 'add', '--', input.file]); }
      catch (error) { resolutionError = `文件已保存，但标记已解决失败：${(error as Error).message}`; }
    }
    return { ok: true, code: await readProjectCode(directory, input.file), ...(resolutionError ? { resolutionError } : {}) };
  } finally {
    repoLocks.delete(common);
  }
}

export async function executeProjectGitAction(
  input: Record<string, unknown>,
  sourceBackend: SourceBackend,
) {
  const delivery = { remoteStarted: false };
  try { return await executeProjectGitActionInner(input, sourceBackend, delivery); }
  catch (error) {
    if (input.action === 'deliver') throw Object.assign(error instanceof Error ? error : new Error('Git 交付未完成。'),
      { definite: !delivery.remoteStarted, uncertain: delivery.remoteStarted });
    throw error;
  }
}

// Compare immutable commits without switching branches or touching the index.
async function readMergePreview(current: ProjectGitSnapshot, source: ProjectGitBranchItem): Promise<ProjectGitMergePreview> {
  const directory = current.directory;
  const sourceSha = source.sha, targetSha = current.head;
  const mergeBase = (await gitRaw(directory, ['merge-base', targetSha, sourceSha]).catch(() => '')).trim();
  if (!mergeBase) throw fail('来源分支与当前分支没有共同祖先，无法预览合并。', 409);
  const [countsOut, commitsOut, filesOut, branchDiffOut] = await Promise.all([
    gitRaw(directory, ['rev-list', '--left-right', '--count', `${targetSha}...${sourceSha}`]),
    gitRaw(directory, ['log', '-100', '--format=%H%x00%s%x00%an%x00%aI', `${targetSha}..${sourceSha}`]),
    gitRaw(directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', mergeBase, sourceSha, '--']),
    gitRaw(directory, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', targetSha, sourceSha, '--']),
  ]);
  const [behind, ahead] = countsOut.trim().split(/\s+/).map(Number);
  const files = filesOut.split('\0').filter(Boolean).map(record => {
    const firstTab = record.indexOf('\t'), secondTab = record.indexOf('\t', firstTab + 1);
    const additions = record.slice(0, firstTab), deletions = record.slice(firstTab + 1, secondTab);
    return {
      path: record.slice(secondTab + 1),
      additions: additions === '-' ? null : Number(additions),
      deletions: deletions === '-' ? null : Number(deletions),
      binary: additions === '-' || deletions === '-',
    };
  });
  const branchEntries = branchDiffOut.split('\0');
  const branchFiles = [];
  for (let i = 0; i + 1 < branchEntries.length; i += 2) {
    branchFiles.push({ status: branchEntries[i], path: branchEntries[i + 1] });
  }
  return {
    sourceRef: source.ref, sourceName: source.name, sourceSha,
    targetRef: `refs/heads/${current.branch}`, targetName: current.branch, targetSha, mergeBase,
    ahead, behind, alreadyMerged: ahead === 0, canFastForward: ahead > 0 && behind === 0,
    commits: commitsOut.trim().split('\n').filter(Boolean).map(record => {
      const [sha, subject, author, date] = record.split('\0');
      return { sha, subject, author, date };
    }),
    commitsTruncated: ahead > 100,
    files: files.slice(0, 100), filesTruncated: files.length > 100,
    branchDiff: { files: branchFiles.slice(0, 100), total: branchFiles.length },
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
      binaryFiles: files.filter(file => file.binary).length,
    },
  };
}

async function executeProjectGitActionInner(
  input: Record<string, unknown>,
  sourceBackend: SourceBackend,
  delivery: { remoteStarted: boolean },
) {
  const action = String(input.action || '');
  if (action === 'clone') {
    const parent = await resolveDirectory(input.parent);
    const url = validateRemoteUrl(input.url);
    const folder = typeof input.folder === 'string' ? input.folder.trim() : '';
    if (!folder || !/^[\p{L}\p{N}_.-]{1,100}$/u.test(folder) || folder.startsWith('.')) {
      throw fail('请填写新的文件夹名称，不要包含路径分隔符。');
    }
    const destination = path.join(parent, folder);
    try {
      await fs.mkdir(destination);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'EEXIST') throw fail('目标文件夹已存在，请换一个名称。', 409);
      throw error;
    }
    try {
      await runGit(parent, ['clone', '--', url, destination], 120_000);
    } catch (error: unknown) {
      throw fail(`${(error as Error).message}\n目标目录已保留：${destination}。请检查后重试。`, 409);
    }
    await addProjectRootToEnv(parent);
    await sourceBackend.readLocalProjects(true).catch(() => {});
    return {
      ok: true,
      destination,
      snapshot: await readProjectGitSnapshot(destination),
    };
  }

  const selectedDirectory = await resolveDirectory(input.path);
  const root = await gitRaw(selectedDirectory, ['rev-parse', '--show-toplevel']).catch(() => {
    throw fail('当前目录不是可用的 Git 仓库。');
  });
  const directory = await fs.realpath(root.replace(/\r?\n$/, ''));
  const common = (await runGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (repoLocks.has(common)) throw fail('该仓库有 Git 操作正在执行，请稍后再试。', 409);
  repoLocks.add(common);
  try {
    const snapshotOptions = { forDelivery: action === 'deliver' };
    const current = await readProjectGitSnapshot(directory, snapshotOptions);
    if (!current.available || !current.isGit) throw fail('当前目录不是可用的 Git 仓库。');
    if (input.revision && current.revision !== input.revision) {
      throw fail('仓库状态已变化，请刷新后重新操作。', 409);
    }

    const ensureClean = () => {
      if (!current.clean || current.mergeInProgress) {
        throw fail('请先提交当前改动或处理合并，再执行此操作。', 409);
      }
    };
    const ensureRemote = () => {
      const name = typeof input.remote === 'string' ? input.remote.trim() : '';
      if (!name || name.startsWith('-') || !current.remotes.some((r) => r.name === name)) {
        throw fail('请选择已连接的远程仓库。');
      }
      return name;
    };
    const mergeSource = () => {
      if (!current.branch || !current.head) throw fail('请先切换到已有提交的目标分支。');
      if (input.expectedTargetBranch !== undefined && input.expectedTargetBranch !== current.branch) {
        throw fail('当前本地分支与预览目标不一致，请切换到目标分支后重新预览。', 409);
      }
      const branch = current.branches.find(b => b.ref === input.ref);
      if (!branch || branch.current) throw fail('请选择要合入当前分支的来源分支。');
      return branch;
    };

    if (action === 'merge-preview') {
      return { ok: true, snapshot: current, preview: await readMergePreview(current, mergeSource()) };
    }

    let output = '';
    if (action === 'discard') {
      if (input.confirmed !== true || typeof input.revision !== 'string' || !input.revision) {
        throw fail('请从当前改动列表确认要丢弃的文件。');
      }
      const file = typeof input.file === 'string' ? validateRelativePath(input.file, false) : '';
      const item = current.files.find(item => item.path === file && !item.conflict && (item.unstaged || item.untracked));
      if (!file || !item) throw fail('请选择一个未暂存或未跟踪的文件。', 409);
      const target = path.resolve(directory, file);
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw fail('只能丢弃单个文件的改动。', 409);
      const indexed = (await gitRaw(directory, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file]))
        .split('\0').find(entry => entry.slice(entry.indexOf('\t') + 1) === file);
      if (item.untracked) {
        if (!stat || indexed || await fs.realpath(path.dirname(target)) !== path.dirname(target)) {
          throw fail('文件位置或暂存状态已变化，请刷新后重试。', 409);
        }
        await fs.unlink(target);
      } else {
        if (!indexed || indexed.startsWith('160000 ')) throw fail('此改动不是可恢复的单个文件。', 409);
        output = await runGit(directory, ['--literal-pathspecs', 'restore', '--worktree', '--', file]);
      }
    } else if (action === 'stage' || action === 'unstage') {
      const rawFiles = Array.isArray(input.files) ? input.files.map(String) : [];
      if (!rawFiles.length || rawFiles.length > 200 || rawFiles.some((f) => !current.files.some((item) => item.path === f))) {
        throw fail('请选择当前改动列表中的文件。');
      }
      if (current.files.some((item) => item.conflict && rawFiles.includes(item.path))) {
        throw fail('请先打开冲突文件，处理后保存并标记为已解决。', 409);
      }
      for (const file of rawFiles) validateRelativePath(file, false);
      const files = [
        ...new Set(
          rawFiles.flatMap((file) => {
            const item = current.files.find((f) => f.path === file);
            return action === 'unstage' && item?.originalPath ? [file, item.originalPath] : [file];
          }),
        ),
      ];
      output = await runGit(
        directory,
        action === 'stage'
          ? ['--literal-pathspecs', 'add', '--', ...files]
          : current.head
            ? ['--literal-pathspecs', 'restore', '--staged', '--', ...files]
            : ['--literal-pathspecs', 'rm', '--cached', '-f', '--', ...files],
      );
    } else if (action === 'stage-all') {
      if (current.counts.conflicts) throw fail('请先逐个处理冲突文件，再全部暂存。', 409);
      if (current.truncated) throw fail('改动列表超过展示上限，请先缩小本次改动范围后再暂存。');
      output = await runGit(directory, ['add', '-A']);
    } else if (action === 'unstage-all') {
      if (current.mergeInProgress || current.counts.conflicts) throw fail('请先完成或中止合并，再全部取消暂存。', 409);
      output = current.head
        ? await runGit(directory, ['restore', '--staged', '.'])
        : await runGit(directory, ['rm', '-r', '--cached', '-f', '--', '.']);
    } else if (action === 'commit') {
      if (current.truncated) throw fail('改动列表超过展示上限，请先缩小本次改动范围后再提交。');
      if (current.counts.conflicts) throw fail('请先解决冲突，再提交。', 409);
      if (!current.counts.staged && !current.mergeInProgress) throw fail('请先暂存要提交的文件。');
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message || message.length > 4000) throw fail('请填写提交说明。');
      if (current.mergeInProgress) {
        const changes = await gitRaw(directory, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames',
          '--diff-filter=ACMT', '--numstat', '-z', '--']);
        for (const record of changes.split('\0').filter(Boolean)) {
          const firstTab = record.indexOf('\t'), secondTab = record.indexOf('\t', firstTab + 1);
          if (record.slice(0, firstTab) === '-') continue;
          const file = record.slice(secondTab + 1);
          // Check the staged blob, not the working copy: fixing a file without
          // staging it again must not commit the old conflict markers.
          const content = await gitRaw(directory, ['show', `:${file}`]);
          if (hasConflictMarkers(content)) throw fail(`暂存文件仍有合并冲突标记，请解决并重新暂存后提交：${file}`, 409);
        }
      }
      output = await runGit(directory, ['commit', '-m', message], 120_000);
    } else if (action === 'create-branch') {
      ensureClean();
      const branch = await validateBranchName(directory, input.branch);
      await ensureNewLocalBranchName(directory, branch, current.branches);
      const start = input.startRef ? current.branches.find(item => item.ref === input.startRef) : undefined;
      if (input.startRef && !start) throw fail('基准分支已不存在，请刷新后重新选择。', 409);
      output = await runGit(directory, ['switch', '--no-track', '-c', branch, ...(start ? [start.sha] : [])]);
    } else if (action === 'switch') {
      const branch = current.branches.find((b) => b.ref === input.ref);
      if (!branch) throw fail('分支已不存在，请刷新。');
      const target = branch.remote ? branch.localBranch : branch.name;
      if (target && target === current.branch) output = `当前已在分支 ${target}，无需重复切换。`;
      else {
        if (branch.switchBlockedReason) throw fail(branch.switchBlockedReason, 409);
        ensureClean();
        if (branch.remote) {
          const name = branch.name.slice(branch.name.indexOf('/') + 1);
          await validateBranchName(directory, name);
          if (branch.localBranch) {
            output = await runGit(directory, ['switch', branch.localBranch]);
          } else {
            await ensureNewLocalBranchName(directory, name, current.branches);
            output = await runGit(directory, ['switch', '--track', '-c', name, branch.ref]);
          }
        } else {
          output = await runGit(directory, ['switch', branch.name]);
        }
      }
    } else if (action === 'merge') {
      ensureClean();
      const branch = mergeSource();
      if ((input.expectedSourceSha !== undefined && input.expectedSourceSha !== branch.sha)
        || (input.expectedTargetSha !== undefined && input.expectedTargetSha !== current.head)) {
        throw fail('来源或目标分支已变化，请重新预览后再合并。', 409);
      }
      const strategy = input.strategy === undefined ? 'ff' : input.strategy;
      if (!['ff', 'no-ff', 'ff-only'].includes(String(strategy))) throw fail('请选择有效的合并方式。');
      if (input.message !== undefined && (typeof input.message !== 'string' || input.message.trim().length > 4000)) {
        throw fail('合并提交说明不能超过 4000 字符。');
      }
      const message = typeof input.message === 'string' && input.message.trim()
        ? input.message.trim() : `合并 ${branch.name} 到 ${current.branch}`;
      try {
        output = await runGit(directory, ['merge', `--${strategy}`, '--no-edit', '-m', message, '--', branch.sha], 120_000);
      } catch (error) {
        const snapshot = await readProjectGitSnapshot(directory).catch(() => undefined);
        if (!snapshot?.mergeInProgress || !snapshot.counts.conflicts) throw error;
        await sourceBackend.readLocalProjects(true).catch(() => {});
        return { ok: true, outcome: 'merge-conflicts', snapshot };
      }
    } else if (action === 'abort-merge') {
      if (!current.mergeInProgress) throw fail('当前没有进行中的合并。');
      output = await runGit(directory, ['merge', '--abort']);
    } else if (action === 'fetch') {
      const remote = ensureRemote();
      if (input.branches === undefined) {
        output = await runGit(directory, ['fetch', remote], 120_000);
      } else {
        if (!Array.isArray(input.branches) || input.branches.length !== 2 || input.branches[0] === input.branches[1]) {
          throw fail('请选择不同的远端来源分支和目标分支。');
        }
        const branches = await Promise.all(input.branches.map(branch => validateBranchName(directory, branch)));
        const refspecs = branches.map(branch => `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
        output = await runGit(directory, ['fetch', '--atomic', '--no-tags', '--no-prune', '--no-recurse-submodules', '--refmap=', '--', remote, ...refspecs], 120_000);
      }
    } else if (action === 'pull') {
      ensureClean();
      if (!current.branch || !current.upstream) throw fail('当前分支未配置跟踪分支，请先推送并建立跟踪。');
      const trackedBranch = current.branches.find(b => !b.remote && b.current);
      const trackedRemote = current.remotes.find(r => r.name === trackedBranch?.upstreamRemote);
      if (!trackedRemote) throw fail('找不到跟踪分支对应的远程仓库。');
      output = await runGit(directory, ['fetch', trackedRemote.name], 120_000);
      output += await runGit(directory, ['merge', '--ff-only', '--', `refs/remotes/${current.upstream}`]);
    } else if (action === 'deliver') {
      const expectedBranch = typeof input.branch === 'string' ? input.branch : '';
      if (!expectedBranch || current.branch !== expectedBranch || current.mergeInProgress || current.counts.conflicts || current.truncated) {
        throw fail('任务分支或改动已变化，请刷新交付预览。', 409);
      }
      const name = ensureRemote(), targetRemote = current.remotes.find(item => item.name === name)!;
      if (targetRemote.pushUrls.length !== 1) throw fail('请先明确唯一的 Git 推送地址。');
      const files = Array.isArray(input.files) ? [...new Set(input.files.map(String))] : [];
      if (files.length > 200 || files.some(file => !current.files.some(item => item.path === file))) throw fail('请选择当前预览中的改动文件。');
      for (const file of files) validateRelativePath(file);
      for (const file of files) {
        const original = current.files.find(item => item.path === file)?.originalPath;
        if (original) validateRelativePath(original);
      }
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (files.length && (!message || message.length > 4000)) throw fail('请填写提交说明。');
      if (await gitRaw(directory, ['diff', '--cached', '--name-only', '-z', '--', verificationArtifactDirectory])) {
        throw fail('暂存区包含本地验证产物，请取消暂存后重新预览。', 409);
      }
      if (current.files.some(item => item.staged && !files.includes(item.path))) throw fail('暂存区存在本次未选择的文件，请先核对后重新预览。', 409);
      if (files.length) {
        // 暂存的重命名已包含旧路径删除；上面的暂存区检查保证这里只提交选定条目。
        await runGit(directory, ['--literal-pathspecs', 'add', '--', ...files]);
        output += await runGit(directory, ['commit', '-m', message], 120_000);
      }
      const committed = await readProjectGitSnapshot(directory, snapshotOptions);
      if (committed.branch !== expectedBranch) throw fail('提交后分支发生变化，已停止推送，请核对仓库。', 409);
      const targetRef = `refs/heads/${expectedBranch}`;
      const pushUrl = (await runGit(directory, ['remote', 'get-url', '--push', name])).trim();
      const readRemoteSha = async () => (await runGit(directory, ['ls-remote', '--heads', pushUrl, targetRef], 120_000)).trim().split(/\s+/)[0];
      delivery.remoteStarted = true;
      try {
        output += await runGit(directory, ['push', '--no-force', '--no-mirror', '--porcelain', '--set-upstream', name, `HEAD:${targetRef}`], 120_000);
      } catch (error) {
        // 连接中断也可能发生在服务端接收之后；只读核对，绝不自动重发 push。
        const remoteSha = await readRemoteSha().catch(() => undefined);
        if (remoteSha === committed.head) output += '推送命令未正常返回，已回读确认远端任务分支为本次提交。';
        else if (remoteSha !== undefined) {
          delivery.remoteStarted = false;
          throw fail(`${error instanceof Error ? error.message : 'Git 推送未完成。'}\n已核对远端尚未指向本次提交，本地提交已保留；请重新预览后重试推送。`, 409);
        } else if ((error as { gitPushRejected?: boolean }).gitPushRejected) {
          delivery.remoteStarted = false;
          throw error;
        } else throw error;
      }
      const remoteSha = await readRemoteSha();
      if (!remoteSha || remoteSha !== committed.head) throw fail('Git 已请求推送，但远端回读未能核对，请先核对目标分支，勿重复提交。', 409);
    } else if (action === 'push') {
      if (!current.branch || current.mergeInProgress || current.counts.conflicts) {
        throw fail('请先完成当前分支与冲突处理。');
      }
      const name = ensureRemote();
      const targetRemote = current.remotes.find((r) => r.name === name);
      if (!targetRemote || targetRemote.pushUrls.length !== 1) {
        throw fail('此远程配置了多个推送地址，请先在 Git 中明确唯一目标。');
      }
      const trackedBranch = current.branches.find(b => !b.remote && b.current);
      const targetRef = trackedBranch?.upstreamRemote === name && trackedBranch.upstreamRef.startsWith('refs/heads/')
        ? trackedBranch.upstreamRef : `refs/heads/${current.branch}`;
      output = await runGit(
        directory,
        ['push', '--no-force', '--no-mirror', '--porcelain', '--set-upstream', name, `HEAD:${targetRef}`],
        120_000,
      );
    } else if (action === 'connect' || action === 'update-remote') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(name)) throw fail('远程名称格式不正确。');
      const existing = current.remotes.some((r) => r.name === name);
      if (action === 'connect' && existing) throw fail('该远程名称已存在，请使用修改连接。');
      if (action === 'update-remote' && !existing) throw fail('要修改的远程仓库已不存在，请刷新后重试。');
      const url = validateRemoteUrl(input.url);
      await runGit(directory, ['ls-remote', '--heads', url], 120_000);
      output = await runGit(directory, ['remote', action === 'connect' ? 'add' : 'set-url', name, url]);
    } else if (action === 'test-remote') {
      const branchesCount = (await runGit(directory, ['ls-remote', '--heads', ensureRemote()], 120_000))
        .split('\n')
        .filter(Boolean).length;
      output = `${branchesCount} 个远端分支，连接成功。`;
    } else {
      throw fail('不支持该 Git 操作。');
    }

    await sourceBackend.readLocalProjects(true).catch(() => {});
    return {
      ok: true,
      output: redact(output).slice(0, 10_000),
      snapshot: await readProjectGitSnapshot(directory, snapshotOptions),
    };
  } finally {
    repoLocks.delete(common);
  }
}

function getEnvFilePath(): string {
  return process.env.DELIVERY_CREDENTIALS_FILE || path.resolve(process.cwd(), '.env.local');
}

function getConfiguredRoots(): string[] {
  const raw = String(process.env.LOCAL_PROJECT_ROOTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const roots = raw.length ? raw : [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents')];
  return [...new Set(roots.map((item) => path.resolve(item)))];
}

async function persistEnvUpdates(updates: Record<string, string | undefined>) {
  const envFile = getEnvFilePath();
  let content = '';
  try {
    content = await fs.readFile(envFile, 'utf8');
  } catch {
    content = '';
  }
  const lines = content ? content.split(/\r?\n/) : [];
  const handled = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!Object.hasOwn(updates, key)) return line;
    handled.add(key);
    const val = updates[key];
    return val === undefined ? line : `${key}=${val}`;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!handled.has(key) && val !== undefined) {
      nextLines.push(`${key}=${val}`);
    }
  }
  await fs.mkdir(path.dirname(envFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(envFile, `${nextLines.filter((line, idx, arr) => idx < arr.length - 1 || line !== '').join('\n')}\n`, { mode: 0o600 });
}

async function addProjectRootToEnv(directory: string) {
  const roots = getConfiguredRoots();
  if (!roots.includes(directory)) {
    const nextRoots = [...roots, directory];
    process.env.LOCAL_PROJECT_ROOTS = nextRoots.join(path.delimiter);
    await persistEnvUpdates({ LOCAL_PROJECT_ROOTS: process.env.LOCAL_PROJECT_ROOTS });
  }
}

export function readShareConfig() {
  const hasJiraToken = Boolean(
    process.env.JIRA_API_TOKEN
    || process.env.JIRA_AUTH_HEADER
    || process.env.JIRA_COOKIE
    || process.env.JIRA_KEYCHAIN_SERVICE,
  );
  return {
    jiraBaseUrl: (process.env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
    jiraUsername: process.env.JIRA_USERNAME || '',
    hasJiraToken,
    projectRoots: getConfiguredRoots(),
    credentialsFile: getEnvFilePath(),
  };
}

function shareJiraOrigin(value: string) {
  const parsed = URL.parse(value);
  if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw fail('请输入有效的 Jira 地址（例如 https://jira.example.com）。');
  }
  return parsed.origin;
}

export async function updateShareConfig(
  input: Record<string, unknown>,
  sourceBackend: SourceBackend,
) {
  const action = String(input.action || 'save');
  if (!['add-root', 'remove-root'].includes(action) && process.env.DELIVERY_PLUGIN_JIRA_MANAGED === 'true') {
    throw fail('Jira 已由接入插件管理，请在设置中的插件卡片修改连接。');
  }

  if (action === 'add-root') {
    const directory = await resolveDirectory(input.path);
    await addProjectRootToEnv(directory);
    const projects = await sourceBackend.readLocalProjects(true);
    return {
      ok: true,
      message: `已添加项目目录：${directory}`,
      config: readShareConfig(),
      projectCount: projects.projects.length,
    };
  }

  if (action === 'remove-root') {
    const target = typeof input.path === 'string' ? path.resolve(input.path.trim()) : '';
    const roots = getConfiguredRoots().filter((item) => item !== target);
    if (!roots.length) throw fail('至少需要保留一个本地项目扫描目录。');
    process.env.LOCAL_PROJECT_ROOTS = roots.join(path.delimiter);
    await persistEnvUpdates({ LOCAL_PROJECT_ROOTS: process.env.LOCAL_PROJECT_ROOTS });
    const projects = await sourceBackend.readLocalProjects(true);
    return {
      ok: true,
      message: `已移除扫描目录：${target}`,
      config: readShareConfig(),
      projectCount: projects.projects.length,
    };
  }

  if (action === 'test-jira') {
    const rawUrl = typeof input.jiraBaseUrl === 'string' && input.jiraBaseUrl.trim()
      ? input.jiraBaseUrl.trim()
      : process.env.JIRA_BASE_URL || '';
    const baseUrl = shareJiraOrigin(rawUrl);
    const useSavedAuth = baseUrl === URL.parse(process.env.JIRA_BASE_URL || '')?.origin;
    const username = typeof input.jiraUsername === 'string' ? input.jiraUsername.trim() : (useSavedAuth ? process.env.JIRA_USERNAME || '' : '');
    const token = typeof input.jiraApiToken === 'string' && input.jiraApiToken.trim()
      ? input.jiraApiToken.trim()
      : (useSavedAuth ? process.env.JIRA_API_TOKEN || '' : '');

    let authorization = useSavedAuth ? process.env.JIRA_AUTH_HEADER || '' : '';
    if (token) {
      authorization = username
        ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
        : `Bearer ${token}`;
    }
    if (!authorization) throw fail('请先填写 Jira API Token 或密码。');

    const response = await fetch(`${baseUrl}/rest/api/2/myself`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    }).catch((error: Error) => {
      throw fail(`连接 Jira 失败：${error.message}`);
    });
    if (!response.ok) {
      throw fail(`Jira 认证未通过（HTTP ${response.status}），请检查地址、用户名和 Token。`);
    }
    const profile = (await response.json()) as { displayName?: string; name?: string; emailAddress?: string };
    return {
      ok: true,
      message: `Jira 连接成功：${profile.displayName || profile.name || '已认证'}${profile.emailAddress ? ` (${profile.emailAddress})` : ''}`,
      user: profile,
    };
  }

  const updates: Record<string, string | undefined> = {};
  if (typeof input.jiraBaseUrl === 'string' && input.jiraBaseUrl.trim()) {
    const nextOrigin = shareJiraOrigin(input.jiraBaseUrl.trim());
    if (nextOrigin !== URL.parse(process.env.JIRA_BASE_URL || '')?.origin) {
      for (const key of ['JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_AUTH_HEADER', 'JIRA_COOKIE', 'JIRA_KEYCHAIN_SERVICE', 'JIRA_KEYCHAIN_ACCOUNT']) {
        delete process.env[key];
        updates[key] = '';
      }
    }
    process.env.JIRA_BASE_URL = nextOrigin;
    updates.JIRA_BASE_URL = nextOrigin;
  }
  if (typeof input.jiraUsername === 'string') {
    process.env.JIRA_USERNAME = input.jiraUsername.trim();
    updates.JIRA_USERNAME = process.env.JIRA_USERNAME;
  }
  if (typeof input.jiraApiToken === 'string' && input.jiraApiToken.trim()) {
    process.env.JIRA_API_TOKEN = input.jiraApiToken.trim();
    updates.JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
    if (!process.env.JIRA_USERNAME) {
      process.env.JIRA_AUTH_HEADER = `Bearer ${process.env.JIRA_API_TOKEN}`;
      updates.JIRA_AUTH_HEADER = process.env.JIRA_AUTH_HEADER;
    } else {
      delete process.env.JIRA_AUTH_HEADER;
      updates.JIRA_AUTH_HEADER = '';
    }
  }
  if (Array.isArray(input.projectRoots)) {
    const validRoots: string[] = [];
    for (const item of input.projectRoots) {
      if (typeof item === 'string' && item.trim()) {
        validRoots.push(await resolveDirectory(item));
      }
    }
    if (validRoots.length) {
      process.env.LOCAL_PROJECT_ROOTS = [...new Set(validRoots)].join(path.delimiter);
      updates.LOCAL_PROJECT_ROOTS = process.env.LOCAL_PROJECT_ROOTS;
    }
  }

  await persistEnvUpdates(updates);
  if (updates.LOCAL_PROJECT_ROOTS) {
    await sourceBackend.readLocalProjects(true);
  }
  return {
    ok: true,
    message: '连接与目录配置已保存并立即生效。',
    config: readShareConfig(),
  };
}

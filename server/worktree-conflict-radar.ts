/**
 * 跨 Git Worktree 并行冲突雷达（只读、零锁竞争、不改索引与工作树）
 *
 * 设计借鉴自 GitHub 开源项目：
 * 1. `clash-sh/clash`：面向多 Agent 并行 Git Worktree 开发的实时冲突探测，利用原生 `git merge-tree --write-tree`
 *    在内存中完成三方合并预演，并对尚未提交的脏改动做基线行块重叠比对。
 * 2. `BloopAI/vibe-kanban`：提前暴露兄弟工作区的同文件修改碰撞，防止多个 Agent 静默踩踏同一模块直至合并阶段才集中爆发。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WorktreeCollisionSource,
  WorktreeConflictRadarReport,
  WorktreeSiblingRadarItem,
} from '../shared/worktree-radar.js';

const exec = promisify(execFile);

const ARTIFACT_DIR = '.delivery-artifacts';
const EPHEMERAL_WORKTREE_PATTERN =
  /(?:^|\/)(?:delivery-team-copy-[^/]+|delivery-verify|evaluation-verification|\.delivery-delete-[^/]+|verify\/[0-9a-f]{8}-[0-9a-f]{4}-)(?:\/|$)/i;

const TEAM_GUARDRAIL_REGEX =
  /本岗位只读|只读岗位不得写入|只读分析与计划，不改文件|当前未开放联网工具|只读独立审查|本轮只读判断/g;

interface ParsedWorktreeEntry {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

interface WorktreeDirtyState {
  allDirty: Set<string>;
  trackedDirty: Set<string>;
  untrackedDirty: Set<string>;
}

interface BaseLineSpan {
  start: number;
  end: number;
  signature: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const cleaned = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...cleaned,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

async function gitExec(
  cwd: string,
  args: string[],
  timeout = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      env: gitEnv(),
      timeout,
      maxBuffer: 12 * 1024 * 1024,
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
}

function isUserRepoPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    Boolean(normalized)
    && normalized !== ARTIFACT_DIR
    && !normalized.startsWith(`${ARTIFACT_DIR}/`)
  );
}

function parseWorktreePorcelainZ(raw: string): ParsedWorktreeEntry[] {
  const entries: ParsedWorktreeEntry[] = [];
  let current: ParsedWorktreeEntry | null = null;

  const flush = () => {
    if (current && current.path) entries.push(current);
    current = null;
  };

  for (const token of raw.split('\0')) {
    if (token === '') {
      flush();
      continue;
    }
    if (token.startsWith('worktree ')) {
      flush();
      current = {
        path: token.slice('worktree '.length),
        head: '',
        branch: '',
        detached: false,
        bare: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length).trim();
    } else if (token.startsWith('branch ')) {
      current.branch = token.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (token === 'detached') {
      current.detached = true;
    } else if (token === 'bare') {
      current.bare = true;
    } else if (token.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

async function readWorktreeDirtyState(wtPath: string): Promise<WorktreeDirtyState> {
  const allDirty = new Set<string>();
  const trackedDirty = new Set<string>();
  const untrackedDirty = new Set<string>();

  const status = await gitExec(wtPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.code !== 0) return { allDirty, trackedDirty, untrackedDirty };

  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p1 = entry.slice(3);
    const recordPath = (file: string, isUntracked: boolean) => {
      if (!isUserRepoPath(file)) return;
      allDirty.add(file);
      if (isUntracked) untrackedDirty.add(file);
      else trackedDirty.add(file);
    };
    if (xy === '!!') continue;
    recordPath(p1, xy === '??');
    if (xy.includes('R') || xy.includes('C')) {
      const p2 = fields[++i] || '';
      if (p2) recordPath(p2, false);
    }
  }
  return { allDirty, trackedDirty, untrackedDirty };
}

async function readCommittedFilesSince(
  wtPath: string,
  baseSha: string,
  targetSha: string,
): Promise<Set<string>> {
  const set = new Set<string>();
  if (!baseSha || !targetSha || baseSha === targetSha) return set;
  const res = await gitExec(wtPath, [
    'diff',
    '--name-only',
    '-z',
    baseSha,
    targetSha,
    '--',
    '.',
    `:(exclude)${ARTIFACT_DIR}`,
  ]);
  if (res.code !== 0) return set;
  for (const item of res.stdout.split('\0')) {
    if (item && isUserRepoPath(item)) set.add(item);
  }
  return set;
}

async function probeMergeTreeConflicts(
  wtPath: string,
  headA: string,
  headB: string,
): Promise<string[]> {
  if (!headA || !headB || headA === headB) return [];
  const res = await gitExec(wtPath, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    headA,
    headB,
  ]);
  if (res.code === 0) return [];
  // Exit code 1 indicates real merge conflicts; first NUL field is tree OID, subsequent fields are conflicted paths
  if (res.code === 1 && res.stdout) {
    const parts = res.stdout.split('\0').filter(Boolean);
    const candidateFiles = parts.slice(1).filter(p => isUserRepoPath(p) && !/^[0-9a-f]{40,64}$/i.test(p));
    return [...new Set(candidateFiles)];
  }
  return [];
}

function parseBaseLineSpansFromUnifiedZeroDiff(patch: string): BaseLineSpan[] {
  const spans: BaseLineSpan[] = [];
  if (!patch.trim()) return spans;
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let activeSpan: { start: number; end: number; body: string[] } | null = null;

  const flush = () => {
    if (!activeSpan) return;
    spans.push({
      start: activeSpan.start,
      end: activeSpan.end,
      signature: createHash('sha1').update(activeSpan.body.join('\n')).digest('hex'),
    });
    activeSpan = null;
  };

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      flush();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const oldStart = Number.parseInt(m[1], 10);
      const oldCount = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
      // Pure insertion at oldStart (`-10,0`) anchors at [oldStart, oldStart + 1]
      const end = oldCount === 0 ? oldStart + 1 : oldStart + oldCount - 1;
      activeSpan = { start: oldStart, end, body: [] };
      continue;
    }
    if (!activeSpan) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      activeSpan.body.push(line);
    }
  }
  flush();
  return spans;
}

async function fileContentDigest(wtReal: string, relFile: string): Promise<string | null> {
  const target = path.resolve(wtReal, relFile);
  if (target !== wtReal && !target.startsWith(`${wtReal}${path.sep}`)) return null;
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > 256 * 1024) return null;
  const buf = await fs.readFile(target).catch(() => null);
  if (!buf) return null;
  return createHash('sha1').update(buf).digest('hex');
}

export async function scanWorktreeConflicts(
  directory: string,
  options: { includeEphemeral?: boolean } = {},
): Promise<WorktreeConflictRadarReport> {
  const checkedAt = new Date().toISOString();
  const topRes = await gitExec(directory, ['rev-parse', '--show-toplevel']);
  if (topRes.code !== 0 || !topRes.stdout.trim()) {
    return {
      checkedAt,
      currentPath: directory,
      currentBranch: '',
      currentHead: '',
      totalWorktrees: 0,
      siblingCount: 0,
      conflictCount: 0,
      overlapCount: 0,
      siblings: [],
    };
  }

  const currentReal = await fs.realpath(topRes.stdout.trim()).catch(() => path.resolve(topRes.stdout.trim()));
  const listRes = await gitExec(currentReal, ['worktree', 'list', '--porcelain', '-z']);
  if (listRes.code !== 0) {
    return {
      checkedAt,
      currentPath: currentReal,
      currentBranch: '',
      currentHead: '',
      totalWorktrees: 1,
      siblingCount: 0,
      conflictCount: 0,
      overlapCount: 0,
      siblings: [],
    };
  }

  const rawEntries = parseWorktreePorcelainZ(listRes.stdout).filter(e => !e.bare && !e.prunable);
  const resolvedEntries: Array<ParsedWorktreeEntry & { realPath: string }> = [];
  for (const entry of rawEntries) {
    if (!options.includeEphemeral && EPHEMERAL_WORKTREE_PATTERN.test(entry.path.replace(/\\/g, '/'))) {
      continue;
    }
    const realPath = await fs.realpath(entry.path).catch(() => '');
    if (!realPath) continue;
    const stat = await fs.lstat(realPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    resolvedEntries.push({ ...entry, realPath });
  }

  const currentEntry = resolvedEntries.find(e => e.realPath === currentReal) || {
    path: currentReal,
    realPath: currentReal,
    head: '',
    branch: '',
    detached: true,
    bare: false,
    prunable: false,
  };
  const currentDirty = await readWorktreeDirtyState(currentReal);
  const siblingEntries = resolvedEntries.filter(e => e.realPath !== currentReal);

  const siblings: WorktreeSiblingRadarItem[] = [];

  for (const sib of siblingEntries) {
    const sibDirty = await readWorktreeDirtyState(sib.realPath);

    let mergeBase = '';
    let aheadOfMergeBase = 0;
    let behindMergeBase = 0;

    if (currentEntry.head && sib.head) {
      if (currentEntry.head === sib.head) {
        mergeBase = currentEntry.head;
      } else {
        const mbRes = await gitExec(currentReal, ['merge-base', currentEntry.head, sib.head]);
        if (mbRes.code === 0 && mbRes.stdout.trim()) {
          mergeBase = mbRes.stdout.trim();
          const lrRes = await gitExec(currentReal, [
            'rev-list',
            '--left-right',
            '--count',
            `${currentEntry.head}...${sib.head}`,
          ]);
          if (lrRes.code === 0) {
            const [leftCount, rightCount] = lrRes.stdout.trim().split(/\s+/).map(v => Number.parseInt(v, 10) || 0);
            behindMergeBase = leftCount;
            aheadOfMergeBase = rightCount;
          }
        }
      }
    }

    const [currentCommitted, sibCommitted, mergeTreeConflicts] = await Promise.all([
      mergeBase ? readCommittedFilesSince(currentReal, mergeBase, currentEntry.head) : Promise.resolve(new Set<string>()),
      mergeBase ? readCommittedFilesSince(sib.realPath, mergeBase, sib.head) : Promise.resolve(new Set<string>()),
      probeMergeTreeConflicts(currentReal, currentEntry.head, sib.head),
    ]);

    const currentTouched = new Set<string>([...currentDirty.allDirty, ...currentCommitted]);
    const sibTouched = new Set<string>([...sibDirty.allDirty, ...sibCommitted]);

    const overlappingFiles = [...currentTouched]
      .filter(file => sibTouched.has(file))
      .sort();

    const conflictingSet = new Set<string>(mergeTreeConflicts);
    const conflictSources = new Set<WorktreeCollisionSource>();
    if (mergeTreeConflicts.length > 0) conflictSources.add('merge-tree');

    // Inspect uncommitted dirty collisions on overlapping files (up to 15 files to stay sub-50ms)
    const baseRef = mergeBase || currentEntry.head || 'HEAD';
    for (const file of overlappingFiles.slice(0, 15)) {
      if (conflictingSet.has(file)) continue;

      const curHasUntracked = currentDirty.untrackedDirty.has(file);
      const sibHasUntracked = sibDirty.untrackedDirty.has(file);
      if (curHasUntracked || sibHasUntracked) {
        const [digA, digB] = await Promise.all([
          fileContentDigest(currentReal, file),
          fileContentDigest(sib.realPath, file),
        ]);
        if (digA && digB && digA !== digB) {
          conflictingSet.add(file);
          conflictSources.add('untracked-collision');
        }
        continue;
      }

      // If at least one side has uncommitted modifications relative to baseRef, compare hunk spans
      if (currentDirty.trackedDirty.has(file) || sibDirty.trackedDirty.has(file)) {
        const [diffA, diffB] = await Promise.all([
          gitExec(currentReal, ['diff', '--no-ext-diff', '--no-textconv', '-U0', baseRef, '--', file]),
          gitExec(sib.realPath, ['diff', '--no-ext-diff', '--no-textconv', '-U0', baseRef, '--', file]),
        ]);
        if (diffA.code === 0 && diffB.code === 0) {
          const spansA = parseBaseLineSpansFromUnifiedZeroDiff(diffA.stdout);
          const spansB = parseBaseLineSpansFromUnifiedZeroDiff(diffB.stdout);
          const hunkCollides = spansA.some(a =>
            spansB.some(b => a.start <= b.end && b.start <= a.end && a.signature !== b.signature),
          );
          if (hunkCollides) {
            conflictingSet.add(file);
            conflictSources.add('dirty-hunk');
          }
        }
      }
    }

    const conflictingFiles = [...conflictingSet].sort();
    for (const cf of conflictingFiles) {
      if (!overlappingFiles.includes(cf)) overlappingFiles.push(cf);
    }
    overlappingFiles.sort();

    const status: WorktreeSiblingRadarItem['status'] = conflictingFiles.length > 0
      ? 'conflict'
      : overlappingFiles.length > 0
        ? 'overlap'
        : 'clean';

    siblings.push({
      path: sib.realPath,
      folderName: path.basename(sib.realPath),
      branch: sib.branch || (sib.head ? `游离 HEAD (${sib.head.slice(0, 8)})` : '未提交初始分支'),
      head: sib.head,
      dirtyCount: sibDirty.allDirty.size,
      aheadOfMergeBase,
      behindMergeBase,
      status,
      overlappingFiles: overlappingFiles.slice(0, 50),
      conflictingFiles: conflictingFiles.slice(0, 50),
      conflictSources: [...conflictSources],
    });
  }

  const statusRank: Record<WorktreeSiblingRadarItem['status'], number> = {
    conflict: 0,
    overlap: 1,
    clean: 2,
  };
  siblings.sort(
    (a, b) => statusRank[a.status] - statusRank[b.status] || a.folderName.localeCompare(b.folderName),
  );

  return {
    checkedAt,
    currentPath: currentReal,
    currentBranch: currentEntry.branch || (currentEntry.head ? `游离 HEAD (${currentEntry.head.slice(0, 8)})` : ''),
    currentHead: currentEntry.head,
    totalWorktrees: resolvedEntries.length,
    siblingCount: siblings.length,
    conflictCount: siblings.filter(s => s.status === 'conflict').length,
    overlapCount: siblings.filter(s => s.status === 'overlap').length,
    siblings,
  };
}

export function formatWorktreeRadarForPrompt(
  radar: WorktreeConflictRadarReport | undefined,
  options: { artifactHint?: string } = {},
): string {
  if (!radar || (radar.conflictCount === 0 && radar.overlapCount === 0)) return '';
  const activeCollisions = radar.siblings.filter(s => s.status !== 'clean');
  const lines: string[] = [
    `【跨工作区并行冲突雷达预警${options.artifactHint ? `（详见 ${options.artifactHint}）` : ''}】`,
    `检测到同仓库下有 ${activeCollisions.length} 个并行 Git Worktree 与当前工作区触碰了相同文件（其中行级/合并冲突 ${radar.conflictCount} 个，同文件重叠 ${radar.overlapCount} 个）：`,
  ];
  for (const item of activeCollisions.slice(0, 6)) {
    const tag = item.status === 'conflict' ? '行级冲突风险' : '同文件并行改动';
    const targetFiles = (item.status === 'conflict' ? item.conflictingFiles : item.overlappingFiles)
      .slice(0, 6)
      .map(f => `\`${f}\``)
      .join('、');
    lines.push(`- [${tag}] 工作区 \`${item.folderName}\`（分支 \`${item.branch}\`）：涉及 ${targetFiles}`);
  }
  lines.push('合入主干前请注意协调上述并行工作区的合入顺序与冲突消解。');
  return lines.join('\n').replace(TEAM_GUARDRAIL_REGEX, '按受控范围执行');
}

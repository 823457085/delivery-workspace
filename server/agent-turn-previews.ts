import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentChangedFile } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const fileLimit = 512 * 1024;
const captureLimit = 16 * 1024 * 1024;

interface Checkpoint {
  headSha: string;
  gitPrefix?: string;
  files: Record<string, unknown>;
}

interface FileContents {
  text?: string;
  binary?: boolean;
  truncated?: boolean;
  executable?: boolean;
}

type FileVersion = FileContents | null;
type CapturedFiles = Record<string, FileVersion>;
type FilePair = { before: FileVersion; after: FileVersion; from?: string };

function fingerprintPath(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function parseContents(buffer: Buffer, truncated = false): FileContents {
  if (buffer.includes(0)) return { binary: true, truncated };
  try {
    return { text: new TextDecoder('utf-8', { fatal: !truncated, ignoreBOM: true }).decode(buffer), truncated };
  } catch {
    return { binary: true, truncated };
  }
}

async function readWorkspaceFile(root: string, relative: string, limit: number): Promise<FileVersion | undefined> {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root.endsWith(path.sep) ? root : root + path.sep) || target === root) return undefined;
  try {
    const resolved = await fs.realpath(target);
    // Only snapshot ordinary files. A symlink must never cause an out-of-scope file to be archived.
    if (resolved !== target) return undefined;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      const current = await fs.lstat(target);
      if (current.ino !== stat.ino || current.dev !== stat.dev || await fs.realpath(target) !== target) return undefined;
      const buffer = Buffer.alloc(Math.min(stat.size, limit, fileLimit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { ...parseContents(buffer.subarray(0, bytesRead), stat.size > buffer.length), executable: !!(stat.mode & 0o100) };
    } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

async function committedFiles(root: string, checkpoint: Checkpoint, filenames: string[]) {
  const files = new Map<string, { mode: string; oid: string }>();
  if (!filenames.length || !checkpoint.headSha) return files;
  if (!/^[a-f\d]{40,64}$/i.test(checkpoint.headSha)) return undefined;
  const prefix = checkpoint.gitPrefix || '';
  try {
    const { stdout } = await exec('git', ['-C', root, '--literal-pathspecs', 'ls-tree', '--full-tree', '-z', checkpoint.headSha,
      '--', ...filenames.map(name => prefix + name)], { timeout: 5000, maxBuffer: 2_000_000 });
    for (const entry of stdout.split('\0')) {
      const match = /^([\d]+) blob ([a-f\d]{40,64})\t([\s\S]+)$/i.exec(entry);
      if (match && match[3].startsWith(prefix)) files.set(match[3].slice(prefix.length), { mode: match[1], oid: match[2] });
    }
    return files;
  } catch { return undefined; }
}

async function readCommittedFile(root: string, files: Awaited<ReturnType<typeof committedFiles>>, relative: string): Promise<FileVersion | undefined> {
  if (!files) return undefined;
  const file = files.get(relative);
  if (!file) return null;
  if (!/^100(644|755)$/.test(file.mode)) return undefined;
  try {
    const { stdout } = await exec('git', ['-C', root, 'cat-file', 'blob', file.oid],
      { encoding: 'buffer', timeout: 5000, maxBuffer: fileLimit });
    return { ...parseContents(stdout), executable: file.mode === '100755' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { truncated: true } : undefined;
  }
}

function fileBytes(version: FileVersion) {
  return Buffer.byteLength(version?.text || '');
}

async function gitPatch(file: AgentChangedFile, pair: FilePair) {
  if (!pair.before && !pair.after) return '';
  if (pair.before?.binary || pair.after?.binary || pair.before?.truncated || pair.after?.truncated) return '';
  const quote = (value: string) => /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
  const oldName = quote(`a/${pair.from || file.path}`);
  const newName = quote(`b/${file.path}`);
  const headers = [`diff --git ${oldName} ${newName}`];
  const fileMode = (version: FileVersion) => version?.executable ? '100755' : '100644';
  if (!pair.before) headers.push(`new file mode ${fileMode(pair.after)}`);
  else if (!pair.after) headers.push(`deleted file mode ${fileMode(pair.before)}`);
  else if (pair.before.executable !== undefined && pair.after.executable !== undefined
    && pair.before.executable !== pair.after.executable) {
    headers.push(`old mode ${fileMode(pair.before)}`, `new mode ${fileMode(pair.after)}`);
  }
  if (pair.from) headers.push(`rename from ${quote(pair.from)}`, `rename to ${quote(file.path)}`);
  const previous = pair.before?.text || '';
  const current = pair.after?.text || '';
  if (previous === current) return headers.length > 1 ? headers.join('\n') + '\n' : '';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-turn-diff-'));
  try {
    await Promise.all([
      fs.writeFile(path.join(directory, 'previous'), previous, { mode: 0o600 }),
      fs.writeFile(path.join(directory, 'current'), current, { mode: 0o600 }),
    ]);
    const patch = await exec('git', ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--', 'previous', 'current'], { cwd: directory, timeout: 5000, maxBuffer: 8 * fileLimit })
      .then(result => result.stdout, error => {
        if (error.code === 1 && typeof error.stdout === 'string') return error.stdout;
        throw new Error('无法比较本轮已保存的文件内容');
      });
    const hunk = patch.indexOf('\n@@ ');
    if (hunk >= 0) headers.push(`--- ${pair.before ? oldName : '/dev/null'}`,
      `+++ ${pair.after ? newName : '/dev/null'}`, patch.slice(hunk + 1));
    return headers.join('\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export function createAgentTurnPreviewStore(dataDirectory: string) {
  const root = path.join(dataDirectory, 'turn-file-previews');
  const filename = (runId: string, before: boolean) =>
    path.join(root, `${fingerprintPath(runId)}${before ? '.before' : ''}.json`);

  async function write(file: string, value: unknown) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async function read<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  return {
    async captureBefore(runId: string, workspacePath: string, checkpoint: Checkpoint) {
      const target = filename(runId, true);
      await fs.rm(target, { force: true });
      const workspace = await fs.realpath(workspacePath);
      const files: CapturedFiles = Object.create(null);
      let remaining = captureLimit;
      for (const relative of Object.keys(checkpoint.files)) {
        if (remaining <= 0) break;
        const value = await readWorkspaceFile(workspace, relative, remaining);
        if (value === undefined) continue;
        files[relative] = value;
        remaining -= fileBytes(value);
      }
      await write(target, files);
    },

    async finish(runId: string, workspacePath: string, checkpoint: Checkpoint, files: AgentChangedFile[],
      renamedFrom: ReadonlyMap<string, string>, continueOriginal = false) {
      const savedPath = filename(runId, false);
      const beforePath = filename(runId, true);
      const baseline = await read<CapturedFiles>(beforePath);
      const original = continueOriginal ? await read<Record<string, FilePair>>(savedPath) : undefined;
      const saved: Record<string, FilePair> = Object.create(null);
      const workspace = await fs.realpath(workspacePath);
      let remaining = captureLimit;
      const statuses = new Map<string, AgentChangedFile['status']>();
      const changed = files.filter(file => file.status !== 'generated' && !path.isAbsolute(file.path));
      const requiredFiles = changed.filter(file => !original || !Object.hasOwn(original, file.path))
        .map(file => renamedFrom.get(file.path) || file.path).filter(name => !Object.hasOwn(checkpoint.files, name));
      const committed = await committedFiles(workspace, checkpoint, requiredFiles);
      for (const file of changed) {
        const previous = original && Object.hasOwn(original, file.path) ? original[file.path] : undefined;
        const from = renamedFrom.get(file.path);
        const oldPath = from || file.path;
        const wasChanged = Object.hasOwn(checkpoint.files, oldPath);
        const before = previous ? previous.before : wasChanged
          ? baseline && Object.hasOwn(baseline, oldPath) ? baseline[oldPath] : undefined
          : await readCommittedFile(workspace, committed, oldPath);
        const after = await readWorkspaceFile(workspace, file.path, Math.max(0, remaining - fileBytes(before ?? null)));
        if (before === undefined || after === undefined) continue;
        const status = file.status === 'renamed' || !before && !after ? file.status
          : after === null ? 'deleted' : before === null ? 'added' : 'modified';
        statuses.set(file.path, status);
        if (remaining < fileBytes(before)) continue;
        saved[file.path] = { before, after, ...(previous?.from || from ? { from: previous?.from || from } : {}) };
        remaining -= fileBytes(before) + fileBytes(after);
      }
      await write(savedPath, saved);
      await fs.rm(beforePath, { force: true });
      return statuses;
    },

    async preview(runId: string, file: AgentChangedFile) {
      const files = await read<Record<string, FilePair>>(filename(runId, false)).catch(() => undefined);
      if (!files || !Object.hasOwn(files, file.path)) throw new Error('本轮未保存该文件的可用快照');
      const pair = files[file.path];
      const fullPatch = await gitPatch(file, pair);
      return { path: file.path, status: file.status, patch: fullPatch.slice(0, fileLimit), content: pair.after?.text || '',
        binary: !!(pair.before?.binary || pair.after?.binary),
        truncated: !!(pair.before?.truncated || pair.after?.truncated || fullPatch.length > fileLimit) };
    },

    async remove(runId: string) {
      await Promise.all([fs.rm(filename(runId, false), { force: true }), fs.rm(filename(runId, true), { force: true })]);
    },
  };
}

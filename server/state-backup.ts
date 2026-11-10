/** 关键 JSON 的逐文件备份；不备份工作区、凭据或数据库，不自动重放任务。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { groupStateSchema } from '../shared/agent-group-chat.js';
import { normalizeTeamAccessModes, profileConfigSchema } from '../shared/agent-team.js';
import { collaborationStateSchema } from './agent-collaboration.js';
import { deliveryAcceptanceRecordSchema } from '../shared/delivery-acceptance.js';
import { requirementProgressSchema } from '../shared/requirement-development.js';
import { overseasRequirementStateSchema } from '../shared/overseas-requirements.js';
import { jiraCommentSavedDraftSchema } from '../shared/jira-fix-handoff.js';

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDirectory = '.state-backups';
const leaseFile = '.state-access.json';
const uuid = '[0-9a-f-]{36}';
const recordFile = new RegExp(`^(jira-fix|requirement-development)/${uuid}\\.json$`);
const handoffFile = new RegExp(`^jira-fix-handoffs/${uuid}(\\.status)?\\.json$`);
const handoffDraftFile = new RegExp(`^jira-fix-handoffs/${uuid}\\.${uuid}\\.draft\\.json$`);
const acceptanceFile = /^delivery-acceptance\/[a-f0-9]{64}\.json$/;
export const stateBackupFiles = [
  'agent-runtimes/agent-runs.json', 'agent-runtimes/custom-models.json',
  'agent-runtimes/codex-sessions.json', 'agent-runtimes/hidden-codex-sessions.json',
  'agent-runtimes/group-chat.json', 'agent-runtimes/team-tasks.json', 'agent-runtimes/agent-profiles.json', 'agent-runtimes/collaboration-state.json',
  'agent-runtimes/agent-usage-daily.json', 'agent-runtimes/agent-evaluations.json', 'agent-runtimes/agent-delivery-drafts.json',
  'agent-runtimes/conversation-titles.json', 'agent-runtimes/agent-workflows.json', 'cli-queue.json', 'api-integration.json',
  'apex-bff-review.json', 'jira-fix/projects.json', 'agent-notes/vault.json', 'refactor-control/state.json', 'overseas-requirements/requirements.json',
] as const;
const dynamicDirectories = ['jira-fix', 'requirement-development', 'jira-fix-handoffs', 'delivery-acceptance'];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const arrayOf = (value: unknown, validate: (item: unknown) => boolean) => Array.isArray(value) && value.every(validate);
const recordOf = (value: unknown, validate: (item: unknown) => boolean) => isObject(value) && Object.values(value).every(validate);
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function assertManaged(relative: string) {
  if (relative.includes('\\') || path.posix.normalize(relative) !== relative || path.isAbsolute(relative)
    || !(stateBackupFiles.includes(relative as typeof stateBackupFiles[number]) || recordFile.test(relative) || handoffFile.test(relative) || handoffDraftFile.test(relative) || acceptanceFile.test(relative))) {
    throw new Error(`不在关键状态文件清单中：${relative}`);
  }
}

export function validateStateJson(relative: string, value: unknown): void {
  assertManaged(relative);
  let valid = false;
  switch (relative) {
    case 'overseas-requirements/requirements.json': valid = overseasRequirementStateSchema.safeParse(value).success; break;
    case 'agent-runtimes/group-chat.json': valid = groupStateSchema.safeParse(value).success; break;
    case 'agent-runtimes/agent-profiles.json': valid = profileConfigSchema.safeParse(normalizeTeamAccessModes(value)).success; break;
    case 'agent-runtimes/collaboration-state.json': valid = collaborationStateSchema.safeParse(value).success; break;
    case 'agent-runtimes/team-tasks.json': valid = isObject(value) && value.version === 1 && typeof value.revision === 'number'
      && arrayOf(value.tasks, item => isObject(item) && strings(item, ['id', 'objective', 'state']) && Array.isArray(item.nodes)); break;
    case 'agent-runtimes/agent-usage-daily.json': valid = isObject(value) && value.version === 1 && Array.isArray(value.records) && Array.isArray(value.daily); break;
    case 'agent-runtimes/agent-evaluations.json': valid = isObject(value) && value.version === 1 && Array.isArray(value.records); break;
    case 'agent-runtimes/agent-delivery-drafts.json': valid = isObject(value) && value.version === 1 && Array.isArray(value.drafts) && Array.isArray(value.opinions); break;
    case 'agent-runtimes/agent-runs.json':
      valid = arrayOf(value, item => isObject(item) && strings(item, ['id', 'createdAt', 'workspacePath'])
        && ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(item.status)));
      break;
    case 'agent-runtimes/custom-models.json':
      valid = arrayOf(value, item => isObject(item) && strings(item, ['id', 'modelId', 'label']) && ['codex', 'cursor', 'claude', 'kiro', 'antigravity', 'api', 'deepseek', 'workbuddy', 'grok'].includes(String(item.provider))
        && (!['api', 'grok', 'deepseek'].includes(String(item.provider)) || (isObject(item.api) && typeof item.api.baseUrl === 'string' && !('apiKey' in item.api))));
      break;
    case 'agent-runtimes/codex-sessions.json':
      valid = isObject(value) && arrayOf(value.sessions, item => isObject(item) && typeof item.id === 'string')
        && (value.details === undefined || recordOf(value.details, item => isObject(item) && Array.isArray(item.turns)));
      break;
    case 'agent-runtimes/hidden-codex-sessions.json': valid = arrayOf(value, item => typeof item === 'string'); break;
    case 'agent-runtimes/conversation-titles.json': valid = recordOf(value, item => typeof item === 'string'); break;
    case 'agent-runtimes/agent-workflows.json':
      valid = arrayOf(value, item => isObject(item) && strings(item, ['id', 'templateId', 'parentConversationId', 'objective', 'createdAt'])
        && Array.isArray(item.decisions));
      break;
    case 'cli-queue.json': valid = isObject(value) && typeof value.enabled === 'boolean'; break;
    case 'api-integration.json': valid = isObject(value) && recordOf(value.stages, isObject) && recordOf(value.operations, isObject); break;
    case 'refactor-control/state.json': valid = isObject(value) && value.version === 1 && typeof value.revision === 'string' && isObject(value.config)
      && strings(value.config, ['sourceRoot', 'workspacePath', 'baseUrl', 'environment', 'assignee'])
      && arrayOf(value.jobs, item => isObject(item) && strings(item, ['id', 'moduleId', 'action', 'status', 'createdAt'])) && Array.isArray(value.batches); break;
    case 'apex-bff-review.json': valid = recordOf(value, item => isObject(item) && strings(item, ['evidence', 'blocker', 'confirmedAt', 'updatedAt'])); break;
    case 'jira-fix/projects.json': valid = arrayOf(value, item => isObject(item) && strings(item, ['projectKey', 'repository', 'parentDirectory', 'baseBranch'])); break;
    case 'agent-notes/vault.json': valid = isObject(value) && typeof value.path === 'string'; break;
    default:
      if (recordFile.test(relative)) valid = isObject(value) && strings(value, ['id', 'status', 'createdAt']) && isObject(value.input)
        && (!relative.startsWith('requirement-development/') || value.progress === undefined || requirementProgressSchema.safeParse(value.progress).success);
      if (handoffFile.test(relative)) {
        const handoff = (item: unknown) => isObject(item) && isObject(item.input) && strings(item, ['status', 'updatedAt']);
        valid = relative.endsWith('.status.json') ? arrayOf(value, handoff) : handoff(value);
      }
      if (handoffDraftFile.test(relative)) {
        const saved = jiraCommentSavedDraftSchema.safeParse(value);
        valid = saved.success && path.basename(relative) === `${saved.data.recordId}.${saved.data.runId}.draft.json`;
      }
      if (acceptanceFile.test(relative)) {
        const record = deliveryAcceptanceRecordSchema.safeParse(value);
        valid = record.success && path.basename(relative) === `${hash(record.data.recordId)}.json`;
      }
  }
  if (!valid) throw new Error(`状态结构校验失败：${relative}`);
}

/** 所有路径都在已确认的数据目录内；拒绝符号链接，避免带出凭据或写到外部。 */
async function safePath(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('状态路径不合法');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`状态路径不能是符号链接：${relative}`); }
    catch (error) { if (!missing(error)) throw error; }
  }
  return current;
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

interface BackupEnvelope { version: 1; path: string; createdAt: string; sha256: string; content: string }
export interface StateBackupEntry { path: string; id: string; valid: boolean; createdAt?: string; sha256?: string; bytes?: number; error?: string }
export interface StateBackupManifest {
  version: 1; startedAt: string; finishedAt: string; consistency: 'per-file';
  entries: { path: string; status: 'backed-up' | 'missing' | 'failed'; backup?: StateBackupEntry; error?: string }[];
}
export interface StateBackupOptions { keep?: number; maxBytes?: number; onWarning?: (text: string) => void }

export async function createStateBackupStore(dataDirectory: string, options: StateBackupOptions = {}) {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(dataDirectory);
  const keep = options.keep ?? 5;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('备份保留数量或大小限制不合法');
  const warn = options.onWarning ?? (text => console.warn(text));
  let writes: Promise<unknown> = Promise.resolve();
  function exclusive<T>(action: () => Promise<T>) { const result = writes.then(action); writes = result.catch(() => {}); return result; }
  function folder(relative: string) { assertManaged(relative); return `${backupDirectory}/${Buffer.from(relative).toString('base64url')}`; }
  function parse(relative: string, content: string) {
    if (Buffer.byteLength(content) > maxBytes) throw new Error(`状态文件超过备份大小限制：${relative}`);
    const value: unknown = JSON.parse(content);
    validateStateJson(relative, value);
    return value;
  }
  async function readContent(relative: string) {
    const file = await safePath(root, relative);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error(`状态文件类型或大小不合法：${relative}`);
      const content = await handle.readFile('utf8');
      parse(relative, content);
      return content;
    } finally { await handle.close(); }
  }
  async function readEnvelope(relative: string, id: string) {
    if (!/^[0-9TZ.-]+-[0-9a-f-]{36}\.json$/.test(id)) throw new Error('备份编号不合法');
    const file = await safePath(root, `${folder(relative)}/${id}`);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > maxBytes * 6 + 4096) throw new Error('备份文件类型或大小不合法');
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!isObject(value) || value.version !== 1 || value.path !== relative || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.content !== 'string' || typeof value.sha256 !== 'string'
      || hash(value.content) !== value.sha256) throw new Error('备份清单或 SHA256 校验失败');
    parse(relative, value.content);
    return value as unknown as BackupEnvelope;
  }
  async function list(relative: string): Promise<StateBackupEntry[]> {
    const directory = await safePath(root, folder(relative));
    let names: string[];
    try { names = await fs.readdir(directory); } catch (error) { if (missing(error)) return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().reverse().map(async id => {
      try {
        const envelope = await readEnvelope(relative, id);
        return { path: relative, id, valid: true, createdAt: envelope.createdAt, sha256: envelope.sha256, bytes: Buffer.byteLength(envelope.content) };
      } catch (error) { return { path: relative, id, valid: false, error: message(error) }; }
    }));
  }
  async function saveBackup(relative: string, content: string): Promise<StateBackupEntry> {
    parse(relative, content);
    const sha256 = hash(content);
    const previous = await list(relative);
    if (previous[0]?.valid && previous[0].sha256 === sha256) return previous[0];
    // 连续写入可能落在同一毫秒，不能让随机 UUID 决定哪一版是 latest。
    const latestTime = Math.max(0, ...previous.filter(item => item.valid).map(item => Date.parse(item.createdAt!)));
    const createdAt = new Date(Math.max(Date.now(), latestTime + 1)).toISOString();
    const id = `${createdAt.replace(/:/g, '-')}-${randomUUID()}.json`;
    const target = await safePath(root, `${folder(relative)}/${id}`);
    await atomicWrite(target, JSON.stringify({ version: 1, path: relative, createdAt, sha256, content } satisfies BackupEnvelope));
    await readEnvelope(relative, id);
    // 损坏副本保留用于诊断；仅清理多余的已校验副本。
    for (const entry of previous.filter(item => item.valid).slice(keep - 1)) {
      const obsolete = await safePath(root, `${folder(relative)}/${entry.id}`);
      try { await fs.unlink(obsolete); }
      // 另一个备份实例可能已清理同一旧副本；其他删除故障仍需报告。
      catch (error) { if (!missing(error)) throw error; }
    }
    return { path: relative, id, valid: true, createdAt, sha256, bytes: Buffer.byteLength(content) };
  }
  async function managedFiles() {
    const files = new Set<string>(stateBackupFiles);
    for (const directory of dynamicDirectories) {
      let names: string[];
      try { names = await fs.readdir(await safePath(root, directory)); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of names) {
        const relative = `${directory}/${name}`;
        if (recordFile.test(relative) || handoffFile.test(relative) || handoffDraftFile.test(relative) || acceptanceFile.test(relative)) files.add(relative);
      }
    }
    // 被误删的业务文件仍可通过备份目录找到。
    let folders: string[] = [];
    try { folders = await fs.readdir(await safePath(root, backupDirectory)); } catch (error) { if (!missing(error)) throw error; }
    for (const name of folders) {
      const relative = Buffer.from(name, 'base64url').toString();
      try { assertManaged(relative); if (Buffer.from(relative).toString('base64url') === name) files.add(relative); } catch { /* 非状态目录。 */ }
    }
    return [...files].sort();
  }
  async function readJson<T = unknown>(relative: string): Promise<T> {
    assertManaged(relative);
    try { return parse(relative, await readContent(relative)) as T; }
    catch (error) {
      const backups = await list(relative);
      const latest = backups.find(item => item.valid);
      if (missing(error) && !backups.length) throw error;
      throw new Error(`状态文件不可读，原件未覆盖：${relative}。${latest ? `可停止服务后恢复备份 ${latest.id}` : '没有已校验的备份可用'}。${message(error)}`);
    }
  }
  function writeJson(relative: string, value: unknown) {
    return exclusive(async () => {
      assertManaged(relative);
      const content = JSON.stringify(value, null, 2) + '\n';
      parse(relative, content);
      let original: string | undefined;
      try { original = await readContent(relative); }
      catch (error) {
        if (!missing(error)) throw new Error(`写入已取消，原状态及备份未覆盖：${relative}。${message(error)}`);
        if ((await list(relative)).length) throw new Error(`状态文件已缺失但存在历史备份，写入已取消，请停止服务后核对恢复：${relative}`);
      }
      if (original !== undefined) {
        try { await saveBackup(relative, original); }
        catch (error) { throw new Error(`写入已取消，旧版本备份失败：${relative}。${message(error)}`); }
      }
      await atomicWrite(await safePath(root, relative), content);
      // 写入成功后的备份失败不能谎称业务写入失败，避免调用方重复执行副作用。
      try { await saveBackup(relative, content); }
      catch (error) { warn(`状态已保存，但新版本备份失败：${relative}。${message(error)}`); }
    });
  }
  function snapshot() {
    return exclusive(async (): Promise<StateBackupManifest> => {
      const manifest: StateBackupManifest = { version: 1, startedAt: new Date().toISOString(), finishedAt: '', consistency: 'per-file', entries: [] };
      for (const relative of await managedFiles()) {
        let content: string;
        try { content = await readContent(relative); }
        catch (error) {
          if (missing(error)) {
            try {
              manifest.entries.push((await list(relative)).length
                ? { path: relative, status: 'failed', error: '状态文件已缺失，历史备份仍保留，请停止服务后核对恢复' }
                : { path: relative, status: 'missing' });
            } catch (lookupError) { manifest.entries.push({ path: relative, status: 'failed', error: message(lookupError) }); }
          } else manifest.entries.push({ path: relative, status: 'failed', error: message(error) });
          continue;
        }
        try { manifest.entries.push({ path: relative, status: 'backed-up', backup: await saveBackup(relative, content) }); }
        catch (error) { manifest.entries.push({ path: relative, status: 'failed', error: message(error) }); }
      }
      manifest.finishedAt = new Date().toISOString();
      await atomicWrite(await safePath(root, `${backupDirectory}/latest-snapshot.json`), JSON.stringify(manifest, null, 2) + '\n');
      return manifest;
    });
  }
  async function restore(relative: string, id: string, offline: OfflineCheckOptions = {}) {
    assertManaged(relative);
    await assertStateOffline(root, offline);
    const release = await acquireStateServiceLease(root, 'restore');
    try {
      await assertStateOffline(root, { ...offline, ignoreOwnLease: true });
      const selected = id === 'latest' ? (await list(relative)).find(entry => entry.valid)?.id : id;
      if (!selected) throw new Error(`没有已校验的备份可恢复：${relative}`);
      const backup = await readEnvelope(relative, selected);
      const target = await safePath(root, relative);
      let original: string | undefined;
      let originalExists = false;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile()) throw new Error('原件不是普通文件，拒绝恢复');
        originalExists = true;
      } catch (error) { if (!missing(error)) throw error; }
      if (originalExists) {
        original = `${backupDirectory}/recovery-originals/${randomUUID()}`;
        const preserved = await safePath(root, original);
        await fs.mkdir(preserved, { recursive: true, mode: 0o700 });
        await fs.copyFile(target, path.join(preserved, 'original'));
        await fs.chmod(path.join(preserved, 'original'), 0o600);
        await atomicWrite(path.join(preserved, 'manifest.json'), JSON.stringify({ path: relative, backup: selected, preservedAt: new Date().toISOString() }));
      }
      // 再次确认旧版本进程未在校验期间启动，新版本启动由 lease 互斥。
      await assertStateOffline(root, { ...offline, ignoreOwnLease: true });
      await atomicWrite(target, backup.content);
      const actual = await readContent(relative);
      if (hash(actual) !== backup.sha256) throw new Error('恢复后回读不一致，已保留原件供排查');
      return { path: relative, backup: selected, sha256: backup.sha256, original, restoredAt: new Date().toISOString() };
    } finally { await release(); }
  }
  return { root, managedFiles, readJson, writeJson, list, snapshot, restore, verify: async (relative: string, id: string) => {
    const value = await readEnvelope(relative, id);
    return { path: relative, id, valid: true, createdAt: value.createdAt, sha256: value.sha256, bytes: Buffer.byteLength(value.content) } satisfies StateBackupEntry;
  }, close: () => writes };
}

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('状态锁 PID 不合法，拒绝继续');
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

/** 服务启动前持有直到正常退出；异常退出后的死 PID 锁可安全识别，原锁留档。 */
export async function acquireStateServiceLease(dataDirectory: string, kind: 'service' | 'restore' = 'service') {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(dataDirectory);
  const file = await safePath(root, leaseFile);
  const token = randomUUID();
  const owner = JSON.stringify({ pid: process.pid, token, kind, createdAt: new Date().toISOString() });
  try { await fs.writeFile(file, owner, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number };
    if (processAlive(previous.pid)) throw new Error('该数据目录正在运行服务或恢复操作，拒绝并发访问');
    // 独占回收锁防止两个新进程同时清理死 PID 的主锁。
    const reclaim = await safePath(root, `${leaseFile}.reclaim`);
    await fs.mkdir(reclaim, { mode: 0o700 });
    try {
      const current = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number };
      if (processAlive(current.pid)) throw new Error('状态锁已被运行进程接管');
      await fs.rename(file, await safePath(root, `${leaseFile}.stale-${randomUUID()}`));
      await fs.writeFile(file, owner, { flag: 'wx', mode: 0o600 });
    } finally { await fs.rmdir(reclaim); }
  }
  return async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as { token: string };
    if (current.token === token) await fs.unlink(file);
  };
}

export interface OfflineCheckOptions { port?: number; applicationRoot?: string; ignoreOwnLease?: boolean }
export type StateBackupStore = Awaited<ReturnType<typeof createStateBackupStore>>;
export async function assertStateOffline(dataDirectory: string, options: OfflineCheckOptions = {}) {
  const root = await fs.realpath(dataDirectory);
  const port = options.port ?? 5199;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务端口不合法');
  for (const relative of [leaseFile, 'design-executor/executor.lock']) {
    try {
      const owner = JSON.parse(await fs.readFile(await safePath(root, relative), 'utf8')) as { pid: number; kind?: string };
      if (relative === leaseFile && options.ignoreOwnLease && owner.pid === process.pid && owner.kind === 'restore') continue;
      if (processAlive(owner.pid)) throw new Error(`服务或执行器仍在运行，禁止恢复：${relative}`);
    } catch (error) { if (!missing(error)) throw error; }
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); reject(new Error(`端口 ${port} 仍有服务监听，禁止恢复`)); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('无法确认服务已离线，禁止恢复')); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('无法确认服务已离线，禁止恢复')));
  });
  const { stdout } = await exec('ps', ['-axo', 'pid=,command='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const applicationRoot = path.resolve(options.applicationRoot ?? appRoot);
  if (stdout.split('\n').some(line => {
    const row = line.trim().match(/^(\d+)\s+(.+)$/);
    return row && Number(row[1]) !== process.pid && row[2].includes(applicationRoot) && /(?:tsx|node).*server\/index\.(?:ts|js)(?:\s|$)/.test(row[2]);
  })) throw new Error('检测到本应用服务进程，禁止恢复');
}

export function startPeriodicStateBackup(store: Pick<Awaited<ReturnType<typeof createStateBackupStore>>, 'snapshot'>,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {}) {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(interval) || interval < 1) throw new Error('备份间隔不合法');
  const onError = options.onError ?? (error => console.error('关键状态备份失败：', message(error)));
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = store.snapshot().then(manifest => {
      const failed = manifest.entries.filter(entry => entry.status === 'failed');
      if (failed.length) onError(new Error(failed.map(entry => `${entry.path}: ${entry.error}`).join('\n')));
    }).catch(onError).finally(() => { pending = undefined; });
  }, interval);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}

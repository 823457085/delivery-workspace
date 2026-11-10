/** 独立克隆和幂等启动由服务保证；业务流程交给现有 Agent，旧桌面方案领取链保持不变。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirementDevelopmentStartSchema, requirementDevelopmentPrompt, requirementProgressInputSchema, requirementProgressImportSchema, requirementProgressSchema,
  readRequirementProgressReport, type RequirementDevelopmentRecord, type RequirementDevelopmentInput, type RequirementProgressData } from '../shared/requirement-development.js';
import type { AgentRun, StartAgentRunInput } from '../shared/agent-runtime.js';
import { createGeneratedWorkspace, resolveRenamedWorkspace } from './generated-workspace.js';
import { groupRunStatus, type GroupJiraExecution } from '../shared/agent-group-chat.js';

const exec = promisify(execFile);
export async function prepareRequirementWorkspace(input: Pick<RequirementDevelopmentInput, 'repository' | 'parentDirectory' | 'branch'> & { baseBranch?: string }, _id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(input.parentDirectory)) throw new Error('保存目录必须为本机绝对路径');
  const parent = await fs.realpath(input.parentDirectory);
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('保存目录不是文件夹');
  await exec('git', ['check-ref-format', '--branch', input.branch], { timeout: 5000, signal });
  const baseBranch = input.baseBranch || 'master';
  await exec('git', ['check-ref-format', `refs/heads/${baseBranch}`], { timeout: 5000, signal });
  const workspacePath = await createGeneratedWorkspace(parent, input.branch, signal);
  let step = '克隆仓库';
  try {
    await exec('git', ['clone', '--no-checkout', '--origin', 'origin', '--', input.repository, workspacePath],
      { timeout: 120_000, maxBuffer: 2_000_000, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    step = `读取远端基准分支 ${baseBranch}`;
    const { stdout } = await exec('git', ['-C', workspacePath, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`], { timeout: 5000, signal });
    const headSha = stdout.trim();
    step = `创建分支 ${input.branch}`;
    await exec('git', ['-C', workspacePath, 'switch', '--no-track', '-c', input.branch, headSha], { timeout: 30_000, signal });
    return { workspacePath, headSha };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string; killed?: boolean };
    const detail = (failure.stderr?.trim() || failure.message || String(error))
      .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[已隐藏]@').slice(-4000);
    const reason = signal?.aborted ? '操作已取消' : failure.killed ? 'Git 命令执行超时' : detail;
    throw new Error(`${step}失败：${reason}；新目录已保留：${workspacePath}`);
  }
}

interface Runtime {
  startRequirementDevelopment(input: StartAgentRunInput, sourceId: string, title: string): Promise<AgentRun>;
  findRequirementDevelopment(sourceId: string): AgentRun | undefined;
  getRun?(id: string): AgentRun | undefined;
  jiraDevRuns?(id: string, workflow: 'requirement', conversationId?: string): AgentRun[];
  subscribe?(subscriber: (revision: number, run?: AgentRun, finalized?: boolean) => void): () => void;
}
export async function createRequirementDevelopmentService(directory: string, runtime: Runtime,
  prepare: (input: RequirementDevelopmentInput, id: string, signal?: AbortSignal) => ReturnType<typeof prepareRequirementWorkspace> = prepareRequirementWorkspace,
  options: { writeJson?: (relative: string, value: unknown) => Promise<void>; groupExecution?: (taskId: string) => GroupJiraExecution | undefined } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const records = new Map<string, RequirementDevelopmentRecord>();
  for (const name of await fs.readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const record = await resolveRenamedWorkspace(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as RequirementDevelopmentRecord);
    if (record.progress !== undefined) record.progress = requirementProgressSchema.parse(record.progress);
    records.set(record.id, record);
  }
  const pending = new Map<string, Promise<RequirementDevelopmentRecord>>();
  const progressWrites = new Map<string, Promise<RequirementDevelopmentRecord>>();
  const deleting = new Map<string, Promise<{ deleted: boolean }>>();
  const shutdown = new AbortController();
  async function save(record: RequirementDevelopmentRecord) {
    if (options.writeJson) { await options.writeJson(`requirement-development/${record.id}.json`, record); return; }
    const file = path.join(directory, `${record.id}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  const findRun = (record: RequirementDevelopmentRecord) => runtime.findRequirementDevelopment(record.id)
    || (record.runId ? runtime.getRun?.(record.runId) : undefined);
  function reconcile(record: RequirementDevelopmentRecord): RequirementDevelopmentRecord {
    if (record.groupRoomId) {
      const group = options.groupExecution?.(record.id), progress = group?.groupProgress || { roomId: record.groupRoomId, state: 'paused' as const, completed: 0, total: 0, activeMember: '', error: '关联群聊暂不可核对，请恢复原群聊记录；不会自动重建任务。' };
      return { ...record, conversationMissing: !group, runId: group?.run?.id || '', groupProgress: progress, runStatus: progress ? groupRunStatus(progress) : undefined,
        runError: progress?.error || '', error: '' };
    }
    const run = findRun(record);
    if (run) return { ...record, conversationMissing: false, runId: run.id, status: 'started', error: '', runStatus: run.status, runError: run.error || '' };
    if (record.runId) return { ...record, conversationMissing: true, runStatus: undefined, runError: '' };
    if (['preparing', 'starting'].includes(record.status) && !pending.has(record.id)) {
      return { ...record, status: 'uncertain', error: '服务曾中断，未自动重放。请检查已创建目录和会话后再决定后续操作。' };
    }
    return record;
  }
  async function execute(record: RequirementDevelopmentRecord) {
    await save(record);
    try {
      Object.assign(record, await prepare(record.input, record.id, shutdown.signal));
      shutdown.signal.throwIfAborted();
      record.status = 'starting'; await save(record);
      const run = await runtime.startRequirementDevelopment({
        provider: 'codex', mode: 'agent', accessMode: 'full', model: 'gpt-6-astra', reasoningEffort: 'xhigh',
        workspacePath: record.workspacePath, branch: record.input.branch,
        objective: requirementDevelopmentPrompt(record.input, record.workspacePath, record.headSha),
      }, record.id, record.input.title);
      record.runId = run.id; record.status = 'started';
    } catch (error) {
      const accepted = runtime.findRequirementDevelopment(record.id);
      if (accepted) { record.runId = accepted.id; record.status = 'started'; }
      else { record.status = 'failed'; record.error = error instanceof Error ? error.message : '启动失败'; }
    }
    await save(record);
    return { ...record };
  }
  function start(raw: unknown) {
    if (shutdown.signal.aborted) throw new Error('服务正在退出，暂不接受新的需求开发任务');
    const { requestId, input } = requirementDevelopmentStartSchema.parse(raw);
    const existing = records.get(requestId);
    if (existing) {
      if (existing.deletedAt || deleting.has(requestId)) throw new Error('该启动记录已删除或正在删除，请使用新的启动请求');
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('该启动请求已使用，请先核对已有记录');
      return pending.get(requestId) || Promise.resolve(reconcile(existing));
    }
    const duplicate = [...records.values()].find(item => !item.deletedAt && JSON.stringify(item.input) === JSON.stringify(input)
      && !['failed'].includes(reconcile(item).status));
    if (duplicate) return pending.get(duplicate.id) || Promise.resolve(reconcile(duplicate));
    const identity = (value: RequirementDevelopmentInput) => value.issueKey
      ? value.issueKey.replace(/\/$/, '').split('/').at(-1)!.toUpperCase() : value.prdUrl || value.requirement;
    const active = [...records.values()].find(item => !item.deletedAt && item.input.repository === input.repository && identity(item.input) === identity(input)
      && (pending.has(item.id) || ['running', 'queued'].includes(runtime.findRequirementDevelopment(item.id)?.status || '') || reconcile(item).status === 'uncertain'));
    if (active) throw new Error('该需求已有运行中或待核对的开发记录，请打开原会话继续，不要重复启动');
    const record: RequirementDevelopmentRecord = { id: requestId, input, status: 'preparing', workspacePath: '', headSha: '', runId: '', error: '', createdAt: new Date().toISOString() };
    records.set(requestId, record);
    const promise = execute(record).finally(() => pending.delete(requestId));
    pending.set(requestId, promise);
    return promise;
  }
  function saveProgress(id: string, runId: string, expectedRevision: number | undefined,
    data: RequirementProgressData | undefined): Promise<RequirementDevelopmentRecord> {
    const automatic = expectedRevision === undefined;
    const previous = progressWrites.get(id) || Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
      if (automatic) await pending.get(id);
      else if (shutdown.signal.aborted) throw fail('服务正在退出，暂不能更新需求进度');
      const record = records.get(id);
      if (!record || record.deletedAt || deleting.has(id)) throw fail('需求开发记录不存在或正在删除', 404);
      if (pending.has(id)) throw fail('开发会话仍在准备，请稍后再记录进度');
      const run = findRun(record);
      // 人工进度始终优先；队列内复查当前轮，避免迟到的报告覆盖人工修改或新一轮。
      if (automatic && (record.progress?.source === 'manual' || !run || run.id !== runId
        || run.status !== 'completed' || run.pausedForEdit)) return structuredClone(reconcile(record));
      if (!run || run.id !== runId) throw fail('需求关联的运行已变化，请刷新后核对进度');
      const revision = record.progress?.revision || 0;
      if (!automatic && revision !== expectedRevision) throw fail('需求进度已更新，请重新读取后再保存');
      if (!data && run.status !== 'completed') throw fail('本轮尚未结束，不能导入未完成的结果；可手动记录当前进度');
      let progress: RequirementProgressData;
      try { progress = data || readRequirementProgressReport(run.result); }
      catch (error) {
        if (!automatic) throw error;
        const next = { ...record, progressSyncError: '最近一次报告未能自动同步，请打开阶段记录核对或手动导入。' };
        await save(next); records.set(id, next);
        return structuredClone(reconcile(next));
      }
      const source = data ? 'manual' as const : 'agent-result' as const;
      if (record.progress?.sourceRunId === runId && record.progress.source === source
        && !record.progressSyncError
        && JSON.stringify({ issueKeys: record.progress.issueKeys, stages: record.progress.stages }) === JSON.stringify(progress)) {
        return structuredClone(reconcile(record));
      }
      const next: RequirementDevelopmentRecord = { ...record, progressSyncError: '', progress: { ...progress, source, sourceRunId: runId,
        revision: revision + 1, updatedAt: new Date().toISOString() } };
      await save(next);
      records.set(id, next);
      return structuredClone(reconcile(next));
    });
    progressWrites.set(id, work);
    void work.finally(() => { if (progressWrites.get(id) === work) progressWrites.delete(id); }).catch(() => undefined);
    return work;
  }
  function updateProgress(id: string, raw: unknown) {
    const input = requirementProgressInputSchema.parse(raw);
    return saveProgress(id, input.runId, input.expectedRevision, input.progress);
  }
  function importProgress(id: string, raw: unknown) {
    const input = requirementProgressImportSchema.parse(raw);
    return saveProgress(id, input.runId, input.expectedRevision, undefined);
  }
  // 复用本轮结构化报告和串行保存；仅订阅新完成事件，不扫描历史、不启动模型、不写验收结论。
  const unsubscribe = runtime.subscribe?.((_revision, run, finalized) => {
    const sourceId = run?.task?.sourceId;
    if (!finalized || !run || run.status !== 'completed' || !sourceId?.startsWith('requirement:') || shutdown.signal.aborted) return;
    const id = sourceId.slice('requirement:'.length);
    if (!records.has(id) || records.get(id)?.deletedAt || deleting.has(id)) return;
    void saveProgress(id, run.id, undefined, undefined).catch(error => {
      console.error(`需求 ${id} 的报告自动同步失败，原进度已保留：`, error instanceof Error ? error.message : error);
    });
  });
  /** Jira 研发助手流程已自行建好工作区并启动会话；这里只登记记录，复用阶段报告导入与验收。 */
  async function adopt(record: RequirementDevelopmentRecord) {
    if (records.has(record.id)) return structuredClone(reconcile(records.get(record.id)!));
    await save(record);
    records.set(record.id, record);
    return structuredClone(reconcile(record));
  }
  async function remove(id: string) {
    const removal = deleting.get(id);
    if (removal) return removal;
    const record = records.get(id);
    if (!record || record.deletedAt) return { deleted: true };
    const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
    if (shutdown.signal.aborted || pending.has(id) || progressWrites.has(id)) {
      throw conflict('开发记录正在处理，请稍后重试');
    }
    const group = record.groupRoomId ? options.groupExecution?.(id) : undefined;
    const run = findRun(record);
    const active = (status?: string) => status === 'queued' || status === 'running';
    if (active(group?.groupProgress.state) || active(run?.status)
      || (group?.runs || runtime.jiraDevRuns?.(id, 'requirement', run?.conversationId || run?.id) || []).some(item => active(item.status))) {
      throw conflict('开发会话仍在执行或排队，请在结束后删除记录');
    }
    const work = (async () => {
      // 保留删除标记，防止迟到的群聊同步重新登记同一条记录。
      const next = { ...record, deletedAt: new Date().toISOString() };
      await save(next);
      records.set(id, next);
      return { deleted: true };
    })().finally(() => { deleting.delete(id); });
    deleting.set(id, work);
    return work;
  }
  return { start, adopt, updateProgress, importProgress, remove,
    synchronizeGroup: async (id: string) => { const record = records.get(id); const run = record && findRun(record);
      if (record && !record.deletedAt && !deleting.has(id) && run?.status === 'completed') await saveProgress(id, run.id, undefined, undefined); },
    isIdle: () => !pending.size && !progressWrites.size && !deleting.size, close: async () => {
    unsubscribe?.(); shutdown.abort(); await Promise.allSettled([...pending.values(), ...progressWrites.values(), ...deleting.values()]);
  }, list: () => [...records.values()].filter(record => !record.deletedAt)
    .map(record => structuredClone(reconcile(record))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

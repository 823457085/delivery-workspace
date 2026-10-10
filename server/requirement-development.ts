/** 独立克隆和幂等启动由服务保证；业务流程交给现有 Agent，旧桌面方案领取链保持不变。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirementDevelopmentStartSchema, requirementDevelopmentPrompt, type RequirementDevelopmentRecord, type RequirementDevelopmentInput } from '../shared/requirement-development.js';
import type { AgentRun, StartAgentRunInput } from '../shared/agent-runtime.js';
import { createGeneratedWorkspace, resolveRenamedWorkspace } from './generated-workspace.js';

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
}
export async function createRequirementDevelopmentService(directory: string, runtime: Runtime,
  prepare: (input: RequirementDevelopmentInput, id: string, signal?: AbortSignal) => ReturnType<typeof prepareRequirementWorkspace> = prepareRequirementWorkspace) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const records = new Map<string, RequirementDevelopmentRecord>();
  for (const name of await fs.readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const record = await resolveRenamedWorkspace(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as RequirementDevelopmentRecord);
    records.set(record.id, record);
  }
  const pending = new Map<string, Promise<RequirementDevelopmentRecord>>();
  const shutdown = new AbortController();
  async function save(record: RequirementDevelopmentRecord) {
    const file = path.join(directory, `${record.id}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  function reconcile(record: RequirementDevelopmentRecord): RequirementDevelopmentRecord {
    const run = runtime.findRequirementDevelopment(record.id);
    if (run) return { ...record, runId: run.id, status: 'started', error: '' };
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
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('该启动请求已使用，请先核对已有记录');
      return pending.get(requestId) || Promise.resolve(reconcile(existing));
    }
    const duplicate = [...records.values()].find(item => JSON.stringify(item.input) === JSON.stringify(input)
      && !['failed'].includes(reconcile(item).status));
    if (duplicate) return pending.get(duplicate.id) || Promise.resolve(reconcile(duplicate));
    const identity = (value: RequirementDevelopmentInput) => value.issueKey
      ? value.issueKey.replace(/\/$/, '').split('/').at(-1)!.toUpperCase() : value.prdUrl || value.requirement;
    const active = [...records.values()].find(item => item.input.repository === input.repository && identity(item.input) === identity(input)
      && (pending.has(item.id) || ['running', 'queued'].includes(runtime.findRequirementDevelopment(item.id)?.status || '') || reconcile(item).status === 'uncertain'));
    if (active) throw new Error('该需求已有运行中或待核对的开发记录，请打开原会话继续，不要重复启动');
    const record: RequirementDevelopmentRecord = { id: requestId, input, status: 'preparing', workspacePath: '', headSha: '', runId: '', error: '', createdAt: new Date().toISOString() };
    records.set(requestId, record);
    const promise = execute(record).finally(() => pending.delete(requestId));
    pending.set(requestId, promise);
    return promise;
  }
  return { start, close: async () => { shutdown.abort(); await Promise.allSettled([...pending.values()]); }, list: () => [...records.values()].map(record => {
    const run = runtime.findRequirementDevelopment(record.id);
    return { ...reconcile(record), runStatus: run?.status, runError: run?.error || '' };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

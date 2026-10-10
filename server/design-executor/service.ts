/** Mastra 串行编排真实阶段；独立目录保存授权、会话和证据，重试沿用同一任务并跳过已通过阶段。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { EXECUTION_STAGES, designInputSchema, emptyArtifacts, executionStartSchema, executionResumeSchema, desktopClaimSchema, desktopSubmissionSchema, type DesignExecution, type ExecutionDashboard } from '../../shared/design-execution.js';
import type { PhaseExecutor } from './codex.js';
import { allowedTools, validateStage } from './policy.js';
import { desktopHealth, desktopPacket } from './desktop.js';

export async function createDesignExecutor(directory: string, executor?: PhaseExecutor) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const indexFile = path.join(directory, 'executions.json');
  const lockFile = path.join(directory, 'executor.lock');
  const lockToken = randomUUID();
  async function claimLock() {
    try { await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, token: lockToken }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('执行器锁格式异常，已拒绝启动以保护运行记录');
      try { process.kill(lock.pid, 0); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(lockFile); return claimLock(); }
      }
      throw new Error('该数据目录已有执行器运行，请勿重复启动');
    }
  }
  await claimLock();
  let records: DesignExecution[] = [];
  try {
    const data = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { version: number; runs: DesignExecution[] };
    if (data.version !== 1 || !Array.isArray(data.runs) || data.runs.some((run) => !/^[0-9a-f-]{36}$/.test(run.id) || !Array.isArray(run.steps))) throw new Error('执行记录格式异常，未覆盖原数据');
    records = data.runs.map((run) => ({ ...run, input: designInputSchema.parse(run.input) }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await fs.unlink(lockFile); throw error; } }
  let writeLock = Promise.resolve();
  function persist() {
    const content = JSON.stringify({ version: 1, runs: records }, null, 2);
    const task = writeLock.then(async () => {
      await fs.writeFile(`${indexFile}.tmp`, content, { mode: 0o600 });
      await fs.rename(`${indexFile}.tmp`, indexFile);
    });
    writeLock = task.catch(() => {});
    return task;
  }
  function find(id: string) {
    const run = records.find((item) => item.id === id);
    if (!run) throw new Error('找不到该自动执行任务');
    return run;
  }
  function event(run: DesignExecution, message: string) {
    run.updatedAt = new Date().toISOString();
    run.events.push({ at: run.updatedAt, message });
    run.events = run.events.slice(-150);
  }
  // A crash must not silently rerun a possibly successful remote write.
  for (const run of records.filter((item) => item.status === 'running')) {
    run.status = 'blocked'; run.error = '服务在执行中断开；外部操作可能已完成，请确认后续跑以查重恢复'; run.revision++;
    delete run.desktopClaim;
    for (const step of run.steps.filter((item) => item.status === 'running')) { step.status = 'blocked'; step.summary = run.error; }
    event(run, run.error);
  }
  await persist();
  const store = new LibSQLStore({ id: 'tech-design-executor', url: `file:${path.join(directory, 'mastra.db')}` });
  await store.init();
  const frame = z.object({ jobId: z.string() });
  let active: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
  let closed = false;
  const steps = EXECUTION_STAGES.map((definition) => createStep({
    id: definition.id, inputSchema: frame, outputSchema: frame, suspendSchema: z.object({ reason: z.string() }),
    execute: async ({ inputData, suspend }) => {
      const run = find(inputData.jobId);
      const step = run.steps.find((item) => item.id === definition.id)!;
      if (step.status === 'passed') return inputData;
      step.status = 'running'; step.attempts++; step.startedAt = new Date().toISOString(); step.summary = '';
      delete step.endedAt;
      event(run, `开始：${definition.title}`);
      await persist();
      try {
        if (!active || active.id !== run.id || active.controller.signal.aborted) throw new Error('运行已停止');
        const output = await executor!.execute({ stage: definition.id, run: structuredClone(run), directory: path.join(directory, run.id), signal: active.controller.signal,
          onThread: async (threadId) => { if (run.threadId && run.threadId !== threadId) throw new Error('会话标识变化，已停止以防止重复执行'); run.threadId = threadId; await persist(); },
          onEvent: (message) => event(run, message),
        });
        step.result = output.result; step.proof = output.proof; step.resultAttempt = step.attempts;
        if (active.controller.signal.aborted) throw new Error('已请求停止；本阶段结果留作恢复查重，不继续后续步骤');
        const gaps = validateStage(definition.id, output.result, output.proof, run);
        if (gaps.length) throw new Error(gaps.join('；'));
        step.status = 'passed'; step.summary = output.result.summary; step.endedAt = new Date().toISOString();
        run.artifacts = output.result.artifacts;
        if (definition.id === 'design') {
          await fs.mkdir(path.join(directory, run.id), { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(directory, run.id, 'tech-design.md'), output.result.markdown, { mode: 0o600 });
        }
        event(run, `通过：${definition.title}`); await persist();
        return inputData;
      } catch (error) {
        step.status = 'blocked'; step.endedAt = new Date().toISOString();
        step.summary = error instanceof z.ZodError ? 'Codex 返回的阶段结果不符合约定结构' : error instanceof Error ? error.message : '未知执行错误';
        run.status = 'blocked'; run.error = step.summary; run.revision++;
        event(run, `阻塞：${definition.title} · ${step.summary}`); await persist();
        return suspend({ reason: step.summary });
      }
    },
  }));
  const definition = createWorkflow({ id: 'frontend-tech-design-delivery', inputSchema: frame, outputSchema: frame });
  for (const step of steps) definition.then(step);
  const workflowDefinition = definition.commit();
  const mastra = new Mastra({ storage: store, workflows: { techDesign: workflowDefinition } });
  const workflow = mastra.getWorkflow('techDesign');

  function pump() {
    if (!executor || active || closed) return;
    const run = records.find((item) => item.status === 'queued');
    if (!run) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      run.status = 'running'; run.error = ''; run.revision++;
      const attemptId = randomUUID(); run.attemptIds.push(attemptId);
      event(run, '执行开始；关闭浏览器不会停止本机后台'); await persist();
      try {
        const attempt = await workflow.createRun({ runId: attemptId, resourceId: run.id });
        await attempt.start({ inputData: { jobId: run.id } });
        if (run.steps.every((step) => step.status === 'passed')) {
          run.status = 'completed'; run.error = ''; event(run, '文档与 Jira 自动回读完成；G2a 仍需人工签署');
        } else { run.status = 'blocked'; run.error ||= '流程未完成所有阶段，请核对检查点后续跑'; }
      } catch (error) {
        run.status = 'blocked'; run.error = error instanceof Error ? error.message : 'Mastra 执行失败'; event(run, run.error);
      } finally { run.revision++; await persist(); }
    }).catch((error: unknown) => {
      // Keep failures visible in memory even if disk persistence itself failed.
      run.status = 'blocked'; run.error = error instanceof Error ? error.message : '执行记录保存失败';
    }).finally(() => { active = undefined; pump(); });
    active = { id: run.id, controller, promise };
  }
  async function start(value: unknown) {
    const { input } = executionStartSchema.parse(value);
    input.issueKey = input.issueKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(input.issueKey) || !input.title.trim()) throw new Error('请填写 Jira Key 和标题');
    if (!path.isAbsolute(input.workspacePath)) throw new Error('请填写仓库绝对路径');
    const workspace = await fs.realpath(input.workspacePath);
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error('指定工作区不是目录');
    if (workspace === path.parse(workspace).root || workspace === path.dirname(directory) || directory.startsWith(`${workspace}${path.sep}`)) throw new Error('工作区必须是具体产品仓库，不能是执行器或上级目录');
    input.workspacePath = workspace;
    const target = new URL(input.confluenceParentUrl);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('请填写准确的 Confluence 目标父页面链接');
    const health = await (executor ? executor.health() : desktopHealth());
    if (!health.ready) throw new Error(health.message);
    // No await between duplicate check and insertion: concurrent requests cannot create two jobs.
    if (records.some((run) => run.input.issueKey === input.issueKey)) throw new Error('此 Jira 事项已有自动执行记录，请打开该记录续跑，不能重复启动');
    const now = new Date().toISOString();
    const run: DesignExecution = { id: randomUUID(), input, status: 'queued', createdAt: now, updatedAt: now,
      authorizedAt: now, revision: 1, threadId: '', attemptIds: [], error: '', clarification: '', artifacts: emptyArtifacts(),
      steps: EXECUTION_STAGES.map((step) => ({ id: step.id, status: 'pending', attempts: 0, summary: '', proof: [] })),
      events: [{ at: now, message: '用户已确认：发布指定 Confluence 方案并创建/复用 Jira 交付任务；不包含产品代码、状态流转或 G2a 签署' }],
    };
    if (!executor) event(run, '等待 Codex 会话领取；看板不启动 CLI 或其他会话');
    records.push(run);
    try { await persist(); } catch (error) { records = records.filter((item) => item !== run); throw error; }
    pump(); return { id: run.id };
  }
  async function resume(id: string, value: unknown) {
    const data = executionResumeSchema.parse(value);
    const run = find(id);
    if (run.revision !== data.revision) throw new Error('运行记录已变化，请刷新后重试');
    if (run.status !== 'blocked' || active?.id === id) throw new Error('只有已结束本轮处理的阻塞任务可以续跑');
    run.clarification = data.clarification; run.status = 'queued'; run.error = ''; run.revision++;
    event(run, '用户确认续跑：沿用原任务和会话，保留已通过阶段；先核对可能已经产生的外部结果');
    await persist(); pump(); return { id };
  }
  async function stop(id: string, revision: number) {
    const run = find(id);
    if (run.revision !== revision) throw new Error('运行记录已变化，请刷新后重试');
    if (!['queued', 'running'].includes(run.status)) throw new Error('此任务当前未运行');
    if (active?.id === id) { active.controller.abort(); event(run, '已请求停止当前进程；不能撤销已经发送的远端请求'); }
    else {
      run.status = 'blocked'; run.error = '已停止领取与回写；不能中断 Codex 会话或撤销远端请求'; run.revision++;
      delete run.desktopClaim;
      for (const step of run.steps.filter(item => item.status === 'running')) { step.status = 'blocked'; step.summary = run.error; step.endedAt = new Date().toISOString(); }
      event(run, run.error);
    }
    await persist(); return { id };
  }
  async function dashboard(): Promise<ExecutionDashboard> {
    return { health: await (executor ? executor.health() : desktopHealth()), runs: structuredClone(records).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  async function claim(id: string, value: unknown) {
    if (closed) throw new Error('服务正在关闭');
    if (executor) throw new Error('当前不是 Codex 会话执行模式');
    const data = desktopClaimSchema.parse(value);
    const run = find(id);
    if (run.threadId && run.threadId !== data.threadId) throw new Error('必须沿用原 Codex 会话');
    if (run.desktopClaim && run.status === 'running') return desktopPacket(run);
    if (run.revision !== data.revision) throw new Error('运行记录已变化，请重新读取');
    if (run.status !== 'queued') throw new Error('任务未等待领取，请先核对阻塞原因并续跑');
    if (records.some(item => item.status === 'running')) throw new Error('已有任务正在 Codex 中执行');
    const step = run.steps.find(item => item.status !== 'passed');
    if (!step) throw new Error('所有阶段已完成');
    run.threadId = data.threadId; run.status = 'running'; run.error = ''; run.revision++;
    step.status = 'running'; step.attempts++; step.startedAt = new Date().toISOString(); step.summary = 'Codex 会话已领取，等待阶段结果回写'; delete step.endedAt;
    run.desktopClaim = { id: randomUUID(), stage: step.id, threadId: data.threadId, claimedAt: step.startedAt };
    run.attemptIds.push(run.desktopClaim.id);
    event(run, `Codex 会话领取：${step.id} · 第 ${step.attempts} 次尝试`);
    await persist(); return desktopPacket(run);
  }
  // Serialize result commits so duplicate or delayed callbacks cannot advance another stage.
  let submissionLock = Promise.resolve();
  async function submit(id: string, value: unknown) {
    const task = submissionLock.then(async () => {
      if (closed) throw new Error('服务正在关闭');
      if (executor) throw new Error('当前不是 Codex 会话执行模式');
      const data = desktopSubmissionSchema.parse(value);
      const run = find(id);
      if (run.threadId !== data.threadId) throw new Error('回写会话不匹配');
      const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (run.desktopSubmission?.claimId === data.claimId) {
        if (run.desktopSubmission.digest !== digest) throw new Error('已提交阶段不能用不同结果覆盖');
        return desktopPacket(run);
      }
      if (run.status !== 'running' || run.desktopClaim?.id !== data.claimId || run.desktopClaim.stage !== data.stage) throw new Error('领取已失效或回写阶段不匹配');
      const tools = ['command_execution', ...allowedTools(data.stage)];
      if (data.proof.some(proof => !tools.includes(proof.tool))) throw new Error('包含本阶段未授权的工具凭证');
      const step = run.steps.find(item => item.id === data.stage)!;
      const gaps = validateStage(data.stage, data.result, data.proof, run);
      if (!gaps.length && data.stage === 'design') {
        await fs.mkdir(path.join(directory, run.id), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, run.id, 'tech-design.md'), data.result.markdown, { mode: 0o600 });
      }
      if (run.status !== 'running' || run.desktopClaim?.id !== data.claimId) throw new Error('领取已停止，结果未推进阶段');
      step.result = data.result; step.resultAttempt = step.attempts; step.proof = data.proof; step.proofSource = 'codex-desktop'; step.endedAt = new Date().toISOString();
      step.status = gaps.length ? 'blocked' : 'passed'; step.summary = gaps.join('；') || data.result.summary;
      run.error = gaps.join('；'); run.revision++;
      if (!gaps.length) run.artifacts = data.result.artifacts;
      run.status = gaps.length ? 'blocked' : run.steps.every(item => item.status === 'passed') ? 'completed' : 'queued';
      run.desktopSubmission = { claimId: data.claimId, digest }; delete run.desktopClaim;
      event(run, `Codex 会话回写：${data.stage} · ${step.status === 'passed' ? '通过阶段校验' : step.summary}`);
      await persist(); return desktopPacket(run);
    });
    submissionLock = task.then(() => {}, () => {});
    return task;
  }
  async function close() {
    closed = true; active?.controller.abort(); await active?.promise; await submissionLock; await writeLock; await mastra.shutdown();
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { token: string };
    if (lock.token === lockToken) await fs.unlink(lockFile);
  }
  pump();
  return { start, resume, stop, dashboard, close, claim, submit, desktop: (id: string) => desktopPacket(find(id)), idle: async () => { while (active) await active.promise; },
    snapshot: async (id: string) => { const run = find(id); if (!executor) return structuredClone(run); const last = run.attemptIds.at(-1); return last ? workflow.getWorkflowRunById(last) : null; },
  };
}

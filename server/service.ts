/** 目录只保存运行索引；步骤、审批及结果以 Mastra 的持久化快照为准。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDeliveryEngine, frameSchema } from './workflow.js';
import { readSource } from './source.js';
import { WORKFLOW_STEPS, type RunRecord, type RunView, type Scenario, type SourceSnapshot, type Dashboard, type WorkflowRunContext } from '../shared/types.js';

const gateParser = z.object({ kind: z.enum(['evidence', 'review', 'conflict']), title: z.string(), reason: z.string(), checks: frameSchema.shape.checks.removeDefault().optional() });

export async function createService(dataDirectory: string, options: { delayMs?: number; model?: string; source?: SourceSnapshot; readSource?: () => Promise<unknown> } = {}) {
  await fs.mkdir(dataDirectory, { recursive: true });
  const { mastra, workflow, storage } = createDeliveryEngine(dataDirectory, options);
  await storage.init();
  const cataloguePath = path.join(dataDirectory, 'runs.json');
  let records: RunRecord[];
  try { records = JSON.parse(await fs.readFile(cataloguePath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; records = []; }
  const readCurrentSource = options.readSource ?? (() => Promise.reject(new Error('未配置交付数据源')));
  let source = options.source ?? await readSource(dataDirectory, readCurrentSource);
  let indexLock = Promise.resolve();
  const busy = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const subscribers = new Set<(revision: number) => void>();
  let revision = Date.now();

  function publish() {
    revision += 1;
    for (const subscriber of subscribers) subscriber(revision);
  }

  async function saveRecord(record: RunRecord) {
    const operation = indexLock.then(async () => {
      const next = [record, ...records];
      await fs.writeFile(`${cataloguePath}.tmp`, JSON.stringify(next, null, 2));
      await fs.rename(`${cataloguePath}.tmp`, cataloguePath);
      records = next;
    });
    indexLock = operation.catch(() => {});
    await operation;
  }

  function execute(runId: string, operation: () => Promise<unknown>) {
    if (busy.has(runId)) throw new Error('当前运行正在处理，请稍候');
    let pulse: ReturnType<typeof setInterval> | undefined;
    const promise = Promise.resolve().then(operation).then(() => {}).catch((error: unknown) => {
      errors.set(runId, error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (pulse) clearInterval(pulse);
      busy.delete(runId);
      publish();
    });
    busy.set(runId, promise);
    pulse = setInterval(publish, 500);
    publish();
  }

  async function view(record: RunRecord): Promise<RunView> {
    const snapshot = await workflow.getWorkflowRunById(record.runId);
    const stepEntries = snapshot?.steps ?? {};
    const steps = WORKFLOW_STEPS.map((step) => {
      const raw = stepEntries[step.id];
      const item = Array.isArray(raw) ? raw[0] : raw;
      return {
        ...step,
        status: item?.status === 'success' ? 'success' as const
          : item?.status === 'suspended' ? 'suspended' as const
            : item?.status === 'running' ? 'running' as const
              : item?.status === 'failed' ? 'failed' as const : 'pending' as const,
        startedAt: item?.startedAt, endedAt: item?.endedAt,
      };
    });
    let frame = frameSchema.parse({ requirement: record.requirement, scenario: record.scenario });
    let gate: RunView['gate'] = null;
    for (const step of WORKFLOW_STEPS) {
      const raw = stepEntries[step.id];
      const item = Array.isArray(raw) ? raw[0] : raw;
      const output = frameSchema.safeParse(item?.output);
      if (output.success) frame = output.data;
      if (item?.status === 'suspended') {
        const parsed = gateParser.safeParse(item.suspendPayload);
        if (parsed.success) { gate = parsed.data; if (parsed.data.checks) frame.checks = parsed.data.checks; }
      }
    }
    const abandoned = snapshot?.status === 'running' && !busy.has(record.runId);
    const error = errors.get(record.runId) ?? snapshot?.error?.message ?? (abandoned ? '服务中断发生在执行期间，请开始新一轮演示。已保存的步骤仍可查看。' : '');
    const status = busy.has(record.runId) ? 'running'
      : error || snapshot?.status === 'failed' ? 'failed'
        : snapshot?.status === 'suspended' ? 'suspended'
          : snapshot?.status === 'success' ? 'success'
            : snapshot?.status === 'canceled' ? 'cancelled' : 'running';
    return { ...record, status, steps, gate: status === 'suspended' ? gate : null,
      analysis: frame.analysis, analysisMode: frame.analysisMode, checks: frame.checks,
      result: frame.receipt, error, updatedAt: snapshot?.updatedAt?.toISOString() ?? record.createdAt };
  }

  async function getRun(runId: string) {
    const record = records.find((item) => item.runId === runId);
    if (!record) throw new Error('找不到该运行');
    return view(record);
  }

  async function start(requirementId: string, scenario: Scenario, parentRunId?: string, context?: WorkflowRunContext) {
    const requirement = source.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error('找不到需求，请刷新来源');
    const runId = randomUUID();
    const run = await workflow.createRun({ runId, resourceId: requirement.id });
    await saveRecord({ runId, requirement, scenario, createdAt: new Date().toISOString(), ...(parentRunId ? { parentRunId } : {}),
      ...(context ? { context } : {}) });
    execute(runId, () => run.start({ inputData: frameSchema.parse({ requirement, scenario }) }));
    return { runId };
  }

  async function resume(runId: string, action: 'approve' | 'retest') {
    if (busy.has(runId)) throw new Error('当前运行正在处理，请稍候');
    const current = await getRun(runId);
    if (current.status !== 'suspended') throw new Error('只有暂停中的运行可以继续');
    if (action === 'approve' && current.gate?.kind !== 'review') throw new Error('当前证据未进入审核阶段');
    if (action === 'retest' && current.gate?.kind !== 'evidence') throw new Error('当前运行不在补测阶段');
    const run = await workflow.createRun({ runId });
    execute(runId, () => run.resume(action === 'approve'
      ? { step: 'human-review', resumeData: { approved: true } }
      : { step: 'verify-evidence', resumeData: { evidenceReady: true } }));
    return { runId };
  }

  async function rework(runId: string) {
    const current = await getRun(runId);
    if (!['suspended', 'failed'].includes(current.status)) throw new Error('当前运行不能退回预演');
    const run = await workflow.createRun({ runId });
    await run.cancel();
    publish();
    return start(current.requirement.id, 'standard', runId, current.context);
  }

  async function dashboard(): Promise<Dashboard> {
    return { revision, source, runs: await Promise.all(records.map(view)), engine: {
      name: 'Mastra', version: '1.64.0', storage: 'libSQL · 本地持久化', model: options.model ?? null,
    } };
  }

  return { start, resume, rework, getRun, dashboard,
    subscribe: (subscriber: (revision: number) => void) => { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    revision: () => revision,
    refreshSource: async () => { source = await readSource(dataDirectory, readCurrentSource); publish(); return source; },
    rawSnapshot: (runId: string) => workflow.getWorkflowRunById(runId),
    idle: () => Promise.all([...busy.values()]),
    close: async () => { await Promise.all([...busy.values()]); await mastra.shutdown(); },
  };
}

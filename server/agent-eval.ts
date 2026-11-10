/** 已验收样本的成对评测；每个变体从同一 Git base 独立运行，结果只建议、不修改岗位默认值。 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentProvider, AgentWorkspaceVersion } from '../shared/agent-runtime.js';
import type { AgentUsage } from '../shared/agent-usage.js';
import { usageTokenCount } from '../shared/agent-usage.js';
import type { TeamProfileConfig } from '../shared/agent-team.js';
import { localWorkflowWorkspace } from './agent-workflow.js';

const exec = promisify(execFile);
export interface AgentEvaluationModel { provider: AgentProvider; model: string; reasoningEffort?: string }
export interface AgentEvaluationSample {
  id: string; workflowId: string; status: 'accepted'; sourcePath: string; baseHead: string;
  objective: string; acceptanceCriteria: { id: string; text: string; stage?: 'verify' | 'review' }[]; allowedPaths: string[];
  rolePrompt: string; verificationCommands: string[]; knownFindingIds?: string[];
  profileId?: string; profileConfig?: TeamProfileConfig;
  candidatePatch?: string; candidatePatchHash?: string; candidate?: AgentWorkspaceVersion;
}
export interface AgentEvaluationFinding {
  id: string; problem: string; file?: string; line?: number; knownFindingId?: string;
  annotation?: 'true_issue' | 'false_positive'; annotationNote?: string;
}
export interface AgentEvaluationResult {
  passed: boolean; acceptance: { id: string; status: 'passed' | 'failed' | 'not_run'; evidence: string }[];
  reworkRounds: number; verificationCommands: string[]; verificationPassed: boolean; reviewApproved: boolean;
  findings: AgentEvaluationFinding[]; usage?: AgentUsage; evidence: string[];
  executions?: { runId: string; profileId: string; provider: AgentProvider; requestedModel: string }[];
  comparisonWarnings?: string[];
}
export interface AgentEvaluationVariant {
  id: string; sampleId: string; modelIndex: number; model: AgentEvaluationModel;
  attempt: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs_reconciliation';
  workspacePath?: string; result?: AgentEvaluationResult; startedAt?: string; completedAt?: string; error?: string;
  attemptHistory?: { attempt: number; status: AgentEvaluationVariant['status']; result?: AgentEvaluationResult; startedAt?: string; completedAt?: string; error?: string }[];
}
export interface AgentEvaluation {
  id: string; requestId: string; confirmedAt: string; createdAt: string; updatedAt: string;
  status: 'confirmed' | 'running' | 'completed' | 'failed' | 'needs_reconciliation';
  samples: AgentEvaluationSample[]; models: [AgentEvaluationModel, AgentEvaluationModel]; variants: AgentEvaluationVariant[];
  estimatedExecutions: number; recommendation?: string;
}
export interface AgentEvaluationRunContext {
  evaluationId: string; variantId: string; sample: AgentEvaluationSample; model: AgentEvaluationModel;
  attempt: number;
  workspacePath: string; blindReviewMaterials: Record<string, unknown>;
}

/** 白名单构造审查材料，不把作者/执行器/模型元数据交给盲审；代码内容和需求原文保留。 */
export function blindAgentEvaluationMaterials(input: Record<string, unknown>) {
  const keys = ['objective', 'acceptanceCriteria', 'allowedPaths', 'rolePrompt', 'verificationCommands', 'diff', 'files', 'verificationEvidence'] as const;
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, structuredClone(input[key])]));
}
function validateSample(sample: AgentEvaluationSample) {
  if (!sample.id || !sample.workflowId || sample.status !== 'accepted' || !sample.sourcePath || !/^[a-f0-9]{40,64}$/i.test(sample.baseHead)
    || !sample.objective.trim() || !sample.rolePrompt.trim() || !Array.isArray(sample.acceptanceCriteria) || !Array.isArray(sample.verificationCommands)) {
    throw new Error('评测只支持有固定 Git base、目标与岗位指令的已验收样本');
  }
  if (sample.allowedPaths.some(value => path.isAbsolute(value) || value.replace(/\\/g, '/').split('/').includes('..'))) throw new Error('评测允许路径必须位于工作区内');
  if (sample.verificationCommands.some(command => !command.trim() || command.length > 2000)) throw new Error('评测验证命令无效');
  if (sample.profileId === 'reviewer' && (typeof sample.candidatePatch !== 'string' || !sample.candidatePatch.trim()
    || Buffer.byteLength(sample.candidatePatch) > 50_000_000
    || createHash('sha256').update(sample.candidatePatch).digest('hex') !== sample.candidatePatchHash
    || sample.candidate?.kind !== 'git-tree' || !/^[a-f0-9]{40,64}$/i.test(sample.candidate.value))) {
    throw new Error('审查评测须绑定非空候选补丁、SHA256 与 Git 候选版本，不能使用旧 base');
  }
}
function validateModel(model: AgentEvaluationModel) {
  if (!['codex', 'claude', 'cursor', 'kiro', 'antigravity'].includes(model.provider) || !model.model.trim() || ['max', 'ultra'].includes(model.reasoningEffort || '')) throw new Error('评测模型配置无效');
}
function resultForSample(raw: AgentEvaluationResult, sample: AgentEvaluationSample): AgentEvaluationResult {
  if (typeof raw.passed !== 'boolean' || typeof raw.verificationPassed !== 'boolean' || typeof raw.reviewApproved !== 'boolean'
    || !Array.isArray(raw.acceptance) || !Array.isArray(raw.findings) || !Array.isArray(raw.evidence)
    || !Number.isInteger(raw.reworkRounds) || raw.reworkRounds < 0
    || JSON.stringify(raw.verificationCommands) !== JSON.stringify(sample.verificationCommands)) throw new Error('评测结果或验证命令与固定样本不一致');
  const ids = new Set(raw.acceptance.map(item => item.id));
  if (sample.acceptanceCriteria.some(item => !ids.has(item.id))) throw new Error('评测结果缺少验收标准');
  if (raw.passed && (!raw.verificationPassed || !raw.reviewApproved || raw.acceptance.some(item => item.status !== 'passed'))) throw new Error('评测未全部通过，不能报告成功');
  // findings 的真伪必须由人工标注，不采信模型自报的 annotation。
  return { ...structuredClone(raw), findings: raw.findings.map(({ annotation: _annotation, annotationNote: _note, ...finding }) => finding) };
}

export function agentEvaluationMetrics(evaluation: AgentEvaluation) {
  const reviewOnly = evaluation.samples.every(sample => sample.profileId === 'reviewer');
  return evaluation.models.map((model, modelIndex) => {
    const finished = evaluation.variants.filter(variant => variant.modelIndex === modelIndex && ['completed', 'failed'].includes(variant.status));
    const variants = finished.filter(variant => variant.status === 'completed' && variant.result);
    const comparable = variants.filter(variant => !variant.result!.comparisonWarnings?.length);
    const findings = variants.flatMap(variant => variant.result!.findings);
    const acceptance = variants.flatMap(variant => variant.result!.acceptance);
    const tokens = variants.map(variant => variant.result!.usage ? usageTokenCount(variant.result!.usage!) : null).filter((value): value is number => value !== null);
    const cost = variants.map(variant => variant.result!.usage?.costUsd).filter((value): value is number => value !== undefined && value !== null);
    const known = finished.flatMap(variant => evaluation.samples.find(sample => sample.id === variant.sampleId)?.knownFindingIds || []);
    const knownDetected = variants.reduce((total, variant) => {
      const expected = evaluation.samples.find(sample => sample.id === variant.sampleId)?.knownFindingIds || [];
      const detected = new Set(variant.result!.findings.filter(finding => finding.annotation === 'true_issue').map(finding => finding.knownFindingId));
      return total + expected.filter(id => detected.has(id)).length;
    }, 0);
    const acceptanceTotal = finished.reduce((sum, variant) => sum + (evaluation.samples.find(sample => sample.id === variant.sampleId)?.acceptanceCriteria.length || 0), 0);
    return { model, samples: finished.length, completedSamples: variants.length, failedSamples: finished.length - variants.length,
      comparableSamples: comparable.length, comparisonWarnings: [...new Set(variants.flatMap(variant => variant.result!.comparisonWarnings || []))],
      firstPassRate: !reviewOnly && comparable.length === variants.length && finished.length ? comparable.filter(variant => variant.result!.passed && !variant.result!.reworkRounds).length / finished.length : null,
      acceptanceRate: !reviewOnly && acceptanceTotal ? acceptance.filter(item => item.status === 'passed').length / acceptanceTotal : null,
      averageRounds: variants.length ? variants.reduce((sum, variant) => sum + variant.result!.reworkRounds, 0) / variants.length : null,
      elapsedMs: finished.reduce((sum, variant) => sum + Math.max(0, Date.parse(variant.completedAt!) - Date.parse(variant.startedAt!)), 0),
      tokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null, unknownUsageVariants: finished.length - tokens.length,
      costUsd: cost.length ? cost.reduce((a, b) => a + b, 0) : null,
      trueIssues: findings.filter(finding => finding.annotation === 'true_issue').length,
      falsePositives: findings.filter(finding => finding.annotation === 'false_positive').length,
      unannotated: findings.filter(finding => !finding.annotation).length,
      knownFindings: known.length, knownDetected };
  });
}

export async function createAgentEvalService(directory: string, options: {
  runSample: (context: AgentEvaluationRunContext) => Promise<AgentEvaluationResult>;
  reconcileVariant?: (variant: AgentEvaluationVariant, evaluation: AgentEvaluation) => Promise<'safe' | 'active' | 'unknown'>;
  writeJson?: (relative: string, value: unknown) => Promise<void>;
}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  const file = path.join(directory, 'agent-evaluations.json'), copyRoot = path.join(directory, 'evaluation-workspaces');
  let records: AgentEvaluation[] = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error('评测记录格式无效');
    records = saved.records;
    for (const record of records) for (const variant of record.variants) variant.attempt ||= variant.status === 'pending' ? 0 : 1;
    for (const record of records) if (record.status === 'running') {
      record.status = 'needs_reconciliation';
      for (const variant of record.variants) if (variant.status === 'running') variant.status = 'needs_reconciliation';
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let writing: Promise<unknown> = Promise.resolve(), creating: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<AgentEvaluation>>();
  let closing = false;
  function save() {
    const value = { version: 1, records: structuredClone(records) };
    const next = writing.then(async () => {
      if (options.writeJson) await options.writeJson('agent-runtimes/agent-evaluations.json', value);
      else { await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
    }); writing = next.catch(() => undefined); return next;
  }
  function find(id: string) { const record = records.find(record => record.id === id); if (!record) throw new Error('找不到评测'); return record; }
  async function create(input: { requestId: string; confirmed: true; samples: AgentEvaluationSample[]; models: [AgentEvaluationModel, AgentEvaluationModel] }) {
    if (closing) throw new Error('评测服务正在关闭');
    if (input.confirmed !== true || !input.requestId || !Array.isArray(input.samples) || !input.samples.length || input.samples.length > 10
      || !Array.isArray(input.models) || input.models.length !== 2) throw new Error('评测须人工确认，选择 1 至 10 个已验收样本与两个模型');
    input.models.forEach(validateModel);
    if (JSON.stringify(input.models[0]) === JSON.stringify(input.models[1])) throw new Error('请选择两个不同的模型配置');
    if (new Set(input.samples.map(sample => sample.id)).size !== input.samples.length) throw new Error('评测样本不能重复');
    input.samples.forEach(validateSample);
    const samples: AgentEvaluationSample[] = [];
    for (const sample of input.samples) {
      const sourcePath = await fs.realpath(sample.sourcePath);
      const resolved = (await exec('git', ['-C', sourcePath, 'rev-parse', '--verify', `${sample.baseHead}^{commit}`], { timeout: 10_000 })).stdout.trim();
      if (resolved !== sample.baseHead) throw new Error('评测 base 必须是固定的完整提交');
      samples.push({ ...structuredClone(sample), sourcePath });
    }
    const previous = records.find(record => record.requestId === input.requestId);
    if (previous) {
      if (JSON.stringify(previous.samples) !== JSON.stringify(samples) || JSON.stringify(previous.models) !== JSON.stringify(input.models)) throw new Error('同一评测请求不能更改样本或模型');
      return structuredClone(previous);
    }
    const now = new Date().toISOString(), id = randomUUID();
    const record: AgentEvaluation = { id, requestId: input.requestId, confirmedAt: now, createdAt: now, updatedAt: now, status: 'confirmed',
      samples, models: structuredClone(input.models), estimatedExecutions: samples.length * 2,
      variants: samples.flatMap(sample => input.models.map((model, modelIndex): AgentEvaluationVariant => ({
        id: randomUUID(), sampleId: sample.id, modelIndex, model: structuredClone(model), attempt: 0, status: 'pending' }))) };
    records.push(record); await save(); return structuredClone(record);
  }
  async function removeCopy(sourcePath: string, target: string) {
    if (!target.startsWith(`${copyRoot}${path.sep}`)) throw new Error('评测副本路径越界');
    await exec('git', ['-C', sourcePath, 'worktree', 'remove', '--force', target], { timeout: 60_000 }).catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true });
    await exec('git', ['-C', sourcePath, 'worktree', 'prune'], { timeout: 10_000 });
  }
  function run(id: string, input: { confirmedResume?: boolean } = {}): Promise<AgentEvaluation> {
    if (pending.has(id)) return pending.get(id)!;
    if (closing) return Promise.reject(new Error('评测服务正在关闭'));
    const record = find(id);
    if (record.status === 'completed') return Promise.resolve(structuredClone(record));
    record.samples.forEach(validateSample);
    if (record.status === 'needs_reconciliation' && input.confirmedResume !== true) return Promise.reject(new Error('上次评测运行状态未知，核对后确认恢复，不自动重放'));
    const task = (async () => {
      for (const variant of record.variants.filter(variant => variant.status !== 'completed' && variant.attempt > 0)) {
        const state = await options.reconcileVariant?.(structuredClone(variant), structuredClone(record)) || 'unknown';
        if (state !== 'safe') throw new Error(state === 'active' ? '原评测进程仍在运行，不能重复启动' : '原评测进程尚未核对，不能重放');
      }
      record.status = 'running'; record.updatedAt = new Date().toISOString(); await save();
      for (const variant of record.variants) {
        if (closing || variant.status === 'completed') continue;
        const sample = record.samples.find(sample => sample.id === variant.sampleId)!;
        const target = path.join(copyRoot, `${record.id}-${variant.id}`);
        await fs.mkdir(copyRoot, { recursive: true, mode: 0o700 });
        if (variant.workspacePath) await removeCopy(sample.sourcePath, variant.workspacePath);
        if (variant.attempt) variant.attemptHistory = [...(variant.attemptHistory || []), {
          attempt: variant.attempt, status: variant.status, result: variant.result ? structuredClone(variant.result) : undefined,
          startedAt: variant.startedAt, completedAt: variant.completedAt, error: variant.error }];
        variant.attempt = (variant.attempt || 0) + 1;
        delete variant.result; delete variant.completedAt;
        variant.status = 'running'; variant.startedAt = new Date().toISOString(); variant.workspacePath = target; variant.error = ''; await save();
        try {
          await exec('git', ['-C', sample.sourcePath, 'worktree', 'add', '--detach', target, sample.baseHead], { timeout: 120_000 });
          if (sample.profileId === 'reviewer') {
            const patchFile = path.join(copyRoot, `${record.id}-${variant.id}.candidate.patch`);
            try {
              await fs.writeFile(patchFile, sample.candidatePatch!, { mode: 0o600 });
              await exec('git', ['-C', target, 'apply', '--binary', patchFile], { timeout: 60_000, maxBuffer: 5_000_000 });
              const candidate = await localWorkflowWorkspace.version(target, []);
              if (candidate.kind !== sample.candidate!.kind || candidate.value !== sample.candidate!.value) throw new Error('审查评测重放后的候选版本与已验收版本不符');
            } finally { await fs.rm(patchFile, { force: true }); }
          }
          const dependency = path.join(sample.sourcePath, 'node_modules');
          if (await fs.lstat(dependency).then(stat => stat.isDirectory(), () => false)) {
            try { await exec('cp', ['-cR', dependency, path.join(target, 'node_modules')], { timeout: 600_000 }); }
            catch { await fs.rm(path.join(target, 'node_modules'), { recursive: true, force: true }); await fs.cp(dependency, path.join(target, 'node_modules'), { recursive: true }); }
          }
          const blindReviewMaterials = blindAgentEvaluationMaterials(sample as unknown as Record<string, unknown>);
          variant.result = resultForSample(await options.runSample({ evaluationId: id, variantId: variant.id, attempt: variant.attempt,
            sample: structuredClone(sample), model: structuredClone(variant.model), workspacePath: target, blindReviewMaterials }), sample);
          variant.status = 'completed';
        } catch (error) { variant.status = 'failed'; variant.error = error instanceof Error ? error.message : String(error); }
        finally {
          try { await removeCopy(sample.sourcePath, target); delete variant.workspacePath; }
          catch (error) { variant.status = 'failed'; variant.error = `评测副本清理失败：${error instanceof Error ? error.message : String(error)}`; }
          variant.completedAt = new Date().toISOString(); record.updatedAt = variant.completedAt; await save();
        }
      }
      record.status = record.variants.every(variant => variant.status === 'completed') ? 'completed' : 'failed';
      record.updatedAt = new Date().toISOString();
      record.recommendation = `本次比较 ${record.samples.length} 个项目样本；结果仅用于本项目配置选择。请结合首轮通过率、用量和人工 finding 标注决定是否调整默认配置，系统未自动更改配置。`;
      await save(); return structuredClone(record);
    })();
    pending.set(id, task); void task.finally(() => pending.delete(id)).catch(() => undefined); return task;
  }
  async function annotate(id: string, variantId: string, findingId: string, annotation: 'true_issue' | 'false_positive', note = '') {
    if (!['true_issue', 'false_positive'].includes(annotation) || note.length > 2000) throw new Error('finding 标注无效');
    const record = find(id), variant = record.variants.find(item => item.id === variantId);
    const finding = variant?.result?.findings.find(item => item.id === findingId);
    if (!finding || variant?.status !== 'completed') throw new Error('找不到可标注的 finding');
    finding.annotation = annotation; finding.annotationNote = note; record.updatedAt = new Date().toISOString(); await save(); return structuredClone(record);
  }
  return { create: (input: Parameters<typeof create>[0]) => {
    const next = creating.then(() => create(input)); creating = next.catch(() => undefined); return next;
  }, run, annotate, get: (id: string) => structuredClone(find(id)), list: () => structuredClone(records),
    metrics: (id: string) => agentEvaluationMetrics(find(id)), close: async () => { closing = true; await creating; await Promise.allSettled(pending.values()); await writing; } };
}

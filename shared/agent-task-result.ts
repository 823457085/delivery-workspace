/**
 * 设计说明：团队流程只依据 delivery-report 中的 taskResult 放行，不从普通文字推断“已完成”。
 * 判定是纯函数：输入运行结果与流程约束，输出 passed / failed / blocked 及原因，供服务端调度和前端展示共用。
 */
import { z } from 'zod';
import { readAgentDeliveryReport as readDeliveryReport } from './delivery-report.js';
import { agentDeliveryEvidenceSchema, type DeliveryEvidence } from './delivery-acceptance.js';
import type { AgentChangedFile } from './agent-runtime.js';

const text = (limit: number) => z.string().trim().max(limit).catch('');
const acceptanceStatuses = ['passed', 'failed', 'blocked', 'not_run', 'not_applicable'] as const;
export const agentTaskResultSchema = z.object({
  role: z.enum(['implementer', 'verifier', 'reviewer']),
  status: z.enum(['succeeded', 'failed', 'blocked']),
  summary: text(4000).default(''),
  // partial 只证明部分完成，按尚未完成整项验收处理，不能转成 passed。
  acceptance: z.array(z.object({ id: z.string().trim().min(1).max(40), status: z.preprocess(value => value === 'partial' ? 'not_run' : value, z.enum(acceptanceStatuses)),
    evidence: text(4000).default('') })).max(50).default([]),
  selfTests: z.array(z.object({ command: text(500).default(''), exitCode: z.number().int().nullable().catch(null) })).max(30).default([]),
  verdict: z.enum(['approved', 'changes_requested', 'blocked']).optional(),
  findings: z.array(z.object({ id: z.string().trim().min(1).max(40), severity: z.enum(['blocker', 'major', 'minor']),
    file: text(1000).default(''), line: z.number().int().nonnegative().nullable().catch(null).default(null),
    problem: text(4000).default(''), expectation: text(4000).default('') })).max(50).default([]),
  blockers: z.array(text(1000)).max(20).default([]),
});
export type AgentTaskResult = z.infer<typeof agentTaskResultSchema>;
export type AgentTaskFinding = AgentTaskResult['findings'][number];

const reportSchema = z.object({ taskResult: agentTaskResultSchema, validationEvidence: z.unknown().optional() }).passthrough();

export interface ParsedAgentTaskReport { taskResult: AgentTaskResult; validationEvidence?: DeliveryEvidence; evidenceError?: string }

export function readAgentTaskReport(result: string): ParsedAgentTaskReport {
  let report: unknown;
  try { report = readDeliveryReport(result); }
  catch (error) { throw new Error(error instanceof Error ? error.message : '缺少 delivery-report'); }
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.map((part, index) => typeof part === 'number' ? `[${part}]` : `${index ? '.' : ''}${String(part)}`).join('');
    throw new Error(`delivery-report 的 ${field || 'taskResult'} 无效：${issue.message}`);
  }
  if (parsed.data.validationEvidence === undefined) return { taskResult: parsed.data.taskResult };
  const evidence = agentDeliveryEvidenceSchema.safeParse(parsed.data.validationEvidence);
  if (evidence.success) return { taskResult: parsed.data.taskResult, validationEvidence: evidence.data };
  const issue = evidence.error.issues[0];
  const field = ['validationEvidence', ...issue.path].map((part, index) => typeof part === 'number' ? `[${part}]` : `${index ? '.' : ''}${String(part)}`).join('');
  return { taskResult: parsed.data.taskResult, evidenceError: `${field} 无效：${issue.message}` };
}

/** 支持 `**`（任意层目录）、`*`（单层任意字符）和 `?`；路径统一为正斜杠相对路径。 */
export function globToRegExp(pattern: string) {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      const slash = normalized[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // 以目录名结尾的模式视为整个目录。
  return new RegExp(`^${source}${normalized.endsWith('/') ? '.*' : '(?:/.*)?'}$`);
}

/** 事后范围检查：生成的产物链接不算代码改动；不做执行时拦截，越界只阻止放行。 */
export function scopeViolations(files: Pick<AgentChangedFile, 'path' | 'status'>[], allowedPaths: string[]) {
  const patterns = allowedPaths.map(item => item.trim()).filter(Boolean).map(globToRegExp);
  if (!patterns.length) return [];
  return files.filter(file => file.status !== 'generated')
    .map(file => file.path.replace(/\\/g, '/'))
    .filter(filePath => !patterns.some(pattern => pattern.test(filePath)));
}

export interface AgentStepOutcome {
  outcome: 'passed' | 'failed' | 'blocked';
  reason: string;
  requiresDiagnosis?: boolean;
  failedCriteria: { id: string; status: string; evidence: string }[];
  findings: AgentTaskFinding[];
}

const blocked = (reason: string): AgentStepOutcome => ({ outcome: 'blocked', reason, failedCriteria: [], findings: [] });
type AcceptanceCriterion = { id: string; text?: string; stage?: 'verify' | 'review' };
function incompleteReason(items: AgentTaskResult['acceptance'], criteria: AcceptanceCriterion[]) {
  return items.map(item => {
    const criterion = criteria.find(value => value.id === item.id);
    return `${item.id}（${item.status}）${criterion?.text ? `：${criterion.text}` : ''}${item.evidence ? `；已有证据：${item.evidence}` : ''}`;
  }).join('\n');
}

/** stepFiles 为本步所有运行的改动（用于范围检查）；hasChanges 看整个流程的累计改动，返工可以只改部分文件。 */
export function evaluateImplementation(result: string, stepFiles: AgentChangedFile[], hasChanges: boolean, allowedPaths: string[], noChangeCriteria: AcceptanceCriterion[] = []): AgentStepOutcome {
  let report: ParsedAgentTaskReport;
  try { report = readAgentTaskReport(result); } catch (error) { return blocked(`实现结果无效：${(error as Error).message}`); }
  const { taskResult } = report;
  if (taskResult.role !== 'implementer') return blocked('实现结果的 role 不是 implementer');
  if (taskResult.status !== 'succeeded') {
    return blocked(`实现岗位回报 ${taskResult.status}${taskResult.blockers.length ? `：${taskResult.blockers.join('；')}` : ''}`);
  }
  if (!hasChanges) {
    noChangeCriteria = noChangeCriteria.filter(item => item.stage !== 'review');
    const byId = new Map(taskResult.acceptance.map(item => [item.id, item]));
    const evidenced = noChangeCriteria.length && taskResult.summary && !taskResult.blockers.filter(Boolean).length
      && noChangeCriteria.every(({ id }) => byId.get(id)?.status === 'passed' && byId.get(id)?.evidence)
      && taskResult.selfTests.length && taskResult.selfTests.every(item => item.command && item.exitCode === 0);
    if (!evidenced) return blocked('实现岗位回报成功，但工作区没有任何代码改动');
    // 这里只准许进入独立验证，不能据实现者的自报直接认定任务已完成。
    return { outcome: 'passed', reason: '无需代码改动的结果已有逐项证据，交由独立验证', failedCriteria: [], findings: [] };
  }
  const outside = scopeViolations(stepFiles, allowedPaths);
  if (outside.length) return blocked(`改动超出允许范围（未自动回滚）：${outside.slice(0, 20).join('、')}`);
  return { outcome: 'passed', reason: '实现完成，范围检查通过', failedCriteria: [], findings: [] };
}

export function evaluateVerification(result: string, criteria: AcceptanceCriterion[]): AgentStepOutcome {
  let report: ParsedAgentTaskReport;
  try { report = readAgentTaskReport(result); } catch (error) { return blocked(`验证结果无效：${(error as Error).message}`); }
  const { taskResult, validationEvidence, evidenceError } = report;
  if (taskResult.role !== 'verifier') return blocked('验证结果的 role 不是 verifier');
  if (!validationEvidence) return blocked(evidenceError || '验证结果缺少 validationEvidence');
  const byId = new Map(taskResult.acceptance.map(item => [item.id, item]));
  const missing = criteria.filter(item => item.stage !== 'review' && !byId.has(item.id)).map(item => item.id);
  const failedCriteria = taskResult.acceptance.filter(item => item.status === 'failed')
    .map(item => ({ id: item.id, status: item.status, evidence: item.evidence }));
  const plannedIds = new Set(criteria.map(item => item.id));
  const reviewIds = new Set(criteria.filter(item => item.stage === 'review').map(item => item.id));
  const additionalFailures = failedCriteria.filter(item => !plannedIds.has(item.id));
  const unassignedTestFailure = !failedCriteria.length && validationEvidence.tests.status === 'failed';
  if ((additionalFailures.length || unassignedTestFailure) && !failedCriteria.some(item => plannedIds.has(item.id))) {
    // 汇总检查失败却未指向验收项时，先查清原因，不能把已通过的实现反复退回。
    if (unassignedTestFailure) failedCriteria.push({ id: 'tests', status: 'failed', evidence: validationEvidence.tests.evidence });
    const verifyCriteria = criteria.filter(item => item.stage !== 'review');
    const complete = verifyCriteria.length > 0
      && (!unassignedTestFailure || !!validationEvidence.tests.evidence)
      && verifyCriteria.every(item => byId.get(item.id)?.status === 'passed' && byId.get(item.id)?.evidence)
      && byId.size === taskResult.acceptance.length
      && taskResult.acceptance.every(item => item.status === 'passed' && !!item.evidence
        || item.status === 'not_run' && reviewIds.has(item.id)
        || item.status === 'failed' && !plannedIds.has(item.id) && !!item.evidence);
    const details = [taskResult.summary, ...taskResult.blockers, incompleteReason(failedCriteria, criteria)].filter(Boolean).join('\n');
    return { outcome: 'blocked', ...(complete ? { requiresDiagnosis: true } : {}),
      reason: `${complete ? '计划内验证项已通过，但附加门禁未通过，需负责人诊断' : '附加检查未通过，且已确认验收证据不完整，需补齐核验'}${details ? `：\n${details}` : ''}`,
      failedCriteria, findings: [] };
  }
  if (failedCriteria.length || validationEvidence.tests.status === 'failed' || taskResult.status === 'failed') {
    const reason = failedCriteria.length ? `验收标准未通过：${failedCriteria.map(item => item.id).join('、')}`
      : validationEvidence.tests.status === 'failed' ? '测试 / 检查未通过' : '验证岗位回报失败';
    if (!failedCriteria.length && validationEvidence.tests.status === 'failed') {
      failedCriteria.push({ id: 'tests', status: 'failed', evidence: validationEvidence.tests.evidence });
    }
    return { outcome: 'failed', reason, failedCriteria, findings: [] };
  }
  if (taskResult.status === 'blocked') return blocked(`验证受阻：${taskResult.blockers.join('；') || taskResult.summary || '未说明原因'}`);
  if (missing.length) return blocked(`验证结果缺少验收标准：${missing.join('、')}`);
  // 只有已确认计划明确交给审查的 not_run 可以等待下一阶段；失败、阻塞及未知项仍拦截。
  const incomplete = taskResult.acceptance.filter(item => item.status === 'blocked' || item.status === 'not_run' && !reviewIds.has(item.id));
  if (incomplete.length) return blocked(`验收标准未能验证：${incompleteReason(incomplete, criteria)}`);
  return { outcome: 'passed', reason: '验证通过', failedCriteria: [], findings: [] };
}

export function evaluateReview(result: string, criteria: AcceptanceCriterion[] = []): AgentStepOutcome {
  let report: ParsedAgentTaskReport;
  try { report = readAgentTaskReport(result); } catch (error) { return blocked(`审查结果无效：${(error as Error).message}`); }
  const { taskResult } = report;
  if (taskResult.role !== 'reviewer') return blocked('审查结果的 role 不是 reviewer');
  if (!taskResult.verdict) return blocked('审查结果缺少 verdict');
  const impediments = taskResult.blockers.filter(Boolean);
  if (taskResult.status === 'blocked' || taskResult.verdict === 'blocked' || impediments.length) {
    return blocked(`审查受阻：${impediments.join('；') || taskResult.summary || '未说明原因'}`);
  }
  if (taskResult.status === 'failed') {
    return { outcome: 'failed', reason: `审查岗位回报失败：${taskResult.summary || '未说明原因'}`,
      failedCriteria: [], findings: taskResult.findings };
  }
  const reviewCriteria = criteria.filter(item => item.stage === 'review');
  const failedCriteria = taskResult.acceptance.filter(item => item.status === 'failed');
  if (failedCriteria.length) return { outcome: 'failed', reason: `审查验收标准未通过：${failedCriteria.map(item => item.id).join('、')}`,
    failedCriteria, findings: taskResult.findings };
  const blockers = taskResult.findings.filter(item => item.severity === 'blocker');
  if (taskResult.verdict === 'approved' && !blockers.length) {
    const byId = new Map(taskResult.acceptance.map(item => [item.id, item]));
    const missing = reviewCriteria.filter(item => !byId.has(item.id));
    if (missing.length) return blocked(`审查结果缺少验收标准：${missing.map(item => item.id).join('、')}`);
    const incomplete = reviewCriteria.map(item => byId.get(item.id)!).filter(item => item.status !== 'passed' || !item.evidence);
    if (incomplete.length) return blocked(`审查验收标准未能验证：${incompleteReason(incomplete, reviewCriteria)}`);
    return { outcome: 'passed', reason: '审查批准', failedCriteria: [], findings: taskResult.findings };
  }
  return { outcome: 'failed', reason: blockers.length && taskResult.verdict === 'approved'
    ? '审查批准但仍有 blocker，按退回处理' : `审查退回：${taskResult.findings.length} 个问题`,
  failedCriteria: [], findings: taskResult.findings };
}

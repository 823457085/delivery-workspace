/**
 * 设计说明：团队流程状态完全由流程记录与已持久化的运行推导，不另存“当前阶段”，避免两份状态漂移。
 * 每一步（step）单调递增；同一步的续接、恢复或重试共享 step，取最新一次作为该步结果。
 * 本模块只做判定，返回下一步动作；创建副本、计算版本和启动运行由服务端执行。
 */
import type {
  AgentProfileId, AgentProviderFallback, AgentRun, AgentTeamTemplateId, AgentWorkflowAction, AgentWorkflowStage, AgentWorkflowState,
  AgentWorkflowStepSummary, AgentWorkflowSummary, AgentWorkspaceVersion,
} from './agent-runtime.js';
import { agentTeamTemplates } from './agent-roles.js';
import { evaluateImplementation, evaluateReview, evaluateVerification, type AgentStepOutcome } from './agent-task-result.js';

export interface AgentWorkflowDecision {
  requestId: string;
  action: AgentWorkflowAction;
  step: number;
  at: string;
}

export interface AgentWorkflowRecord {
  id: string;
  templateId: AgentTeamTemplateId;
  parentConversationId: string;
  objective: string;
  acceptanceCriteria: { id: string; text: string }[];
  allowedPaths: string[];
  attachmentIds: string[];
  maxRounds: number | null;
  escalated: boolean;
  closed?: { action: 'cancel' | 'takeover'; at: string };
  /** 推进到 step 时失败（如副本创建、版本计算或模型预检失败）；成功派发后清除。 */
  dispatchError?: { step: number; message: string; at: string };
  providerFallback?: AgentProviderFallback;
  decisions: AgentWorkflowDecision[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkflowNextStep {
  stage: AgentWorkflowStage;
  round: number;
  step: number;
  reason: string;
}

export interface AgentWorkflowEvaluation {
  summary: AgentWorkflowSummary;
  /** 调度器应执行的下一步；为空表示等待运行、等待用户或流程已结束。 */
  next?: AgentWorkflowNextStep;
  /** 实现或审查完成后需要先由服务端计算版本标识。 */
  needsSnapshot?: { runId: string; stage: AgentWorkflowStage };
  /** 进入下一轮返工时需要交给实现者的问题。 */
  feedback?: AgentStepOutcome;
}

export const workflowStageLabels: Record<AgentWorkflowStage, string> = { implement: '实现', verify: '验证', review: '审查' };
export const workflowStateLabels: Record<AgentWorkflowState, string> = {
  implementing: '实现中', verifying: '验证中', reviewing: '审查中', reworking: '返工中', awaiting_acceptance: '待你验收',
  needs_decision: '需要你决定', blocked: '已阻塞', cancelled: '已取消', taken_over: '已由你接手',
};
const runStatusLabels: Record<AgentRun['status'], string> = {
  queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消',
};

export function workflowRuns(runs: AgentRun[], workflowId: string) {
  return runs.filter(run => run.task?.workflow?.id === workflowId);
}

export function sameWorkspaceVersion(left?: AgentWorkspaceVersion, right?: AgentWorkspaceVersion) {
  return !!left && !!right && left.kind === right.kind && left.value === right.value;
}

function latestAttempt(runs: AgentRun[]) {
  return [...runs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

function cumulativeChangedFiles(runs: AgentRun[]) {
  const files = new Map<string, NonNullable<AgentRun['changedFiles']>[number]>();
  for (const run of [...runs].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
    for (const file of run.changedFiles || []) files.set(file.path, file);
  }
  return [...files.values()];
}

export function implementationProfile(record: Pick<AgentWorkflowRecord, 'templateId'>): AgentProfileId {
  return agentTeamTemplates[record.templateId].implementer;
}

export function evaluateWorkflowStep(record: AgentWorkflowRecord, run: AgentRun, implementationRuns: AgentRun[]): AgentStepOutcome {
  const stage = run.task!.workflow!.stage;
  if (stage === 'implement') {
    const stepRuns = implementationRuns.filter(item => item.task?.workflow?.step === run.task?.workflow?.step);
    const hasChanges = cumulativeChangedFiles(implementationRuns).some(file => file.status !== 'generated');
    return evaluateImplementation(run.result, cumulativeChangedFiles(stepRuns), hasChanges, record.allowedPaths);
  }
  if (stage === 'verify') return evaluateVerification(run.result, record.acceptanceCriteria);
  return evaluateReview(run.result);
}

function stateFor(stage: AgentWorkflowStage, round: number): AgentWorkflowState {
  if (stage === 'implement') return round > 0 ? 'reworking' : 'implementing';
  return stage === 'verify' ? 'verifying' : 'reviewing';
}

export function evaluateWorkflow(record: AgentWorkflowRecord, allRuns: AgentRun[]): AgentWorkflowEvaluation {
  const runs = workflowRuns(allRuns, record.id);
  const byStep = new Map<number, AgentRun[]>();
  for (const run of runs) {
    const step = run.task!.workflow!.step;
    byStep.set(step, [...(byStep.get(step) || []), run]);
  }
  const stepNumbers = [...byStep.keys()].sort((left, right) => left - right);
  const implementationRuns = runs.filter(run => run.task?.workflow?.stage === 'implement');
  const outcomes = new Map<number, AgentStepOutcome>();
  const steps: AgentWorkflowStepSummary[] = stepNumbers.map(step => {
    const run = latestAttempt(byStep.get(step)!);
    const link = run.task!.workflow!;
    let outcome: AgentWorkflowStepSummary['outcome'] = 'pending';
    let reason = runStatusLabels[run.status];
    if (run.status === 'completed' && run.resultReady) {
      const evaluated = evaluateWorkflowStep(record, run, implementationRuns);
      outcomes.set(step, evaluated);
      outcome = evaluated.outcome;
      reason = evaluated.reason;
    } else if (['failed', 'interrupted', 'cancelled'].includes(run.status)) {
      outcome = 'blocked';
      reason = `${runStatusLabels[run.status]}${run.error ? `：${run.error}` : ''}`;
    }
    return { step, stage: link.stage, round: link.round, runId: run.id, conversationId: run.conversationId || run.id,
      profileId: run.task!.profileId || (link.stage === 'implement' ? implementationProfile(record) : link.stage === 'verify' ? 'verifier' : 'reviewer'),
      provider: run.provider, model: run.model, reasoningEffort: run.reasoningEffort, status: run.status, outcome, reason };
  });
  const latestImplementation = steps.filter(step => step.stage === 'implement').at(-1);
  const base = {
    id: record.id, templateId: record.templateId, parentConversationId: record.parentConversationId, objective: record.objective,
    acceptanceCriteria: record.acceptanceCriteria, allowedPaths: record.allowedPaths, maxRounds: null, escalated: record.escalated,
    steps, implementationConversationId: latestImplementation?.conversationId || '', createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.providerFallback ? { providerFallback: record.providerFallback } : {}),
  };
  const current = steps.at(-1);
  const summary = (state: AgentWorkflowState, reason: string, nextStep: string, actions: AgentWorkflowAction[] = ['takeover', 'cancel'],
    snapshot?: AgentWorkspaceVersion): AgentWorkflowSummary => ({
    ...base, state, stage: current?.stage || 'implement', round: current?.round || 0, reason, nextStep, actions,
    ...(snapshot ? { snapshot } : {}),
  });
  if (record.closed) {
    return { summary: summary(record.closed.action === 'cancel' ? 'cancelled' : 'taken_over',
      record.closed.action === 'cancel' ? '流程已取消，已有改动保留' : '你已接手，流程不再自动推进', '无', []) };
  }
  if (!current) return { summary: summary('blocked', '流程尚未创建任何运行', '可取消后重新发起', ['cancel']) };
  const run = latestAttempt(byStep.get(current.step)!);
  const stageLabel = workflowStageLabels[current.stage];
  if (run.status === 'queued' || run.status === 'running' || (run.status === 'completed' && !run.resultReady)) {
    return { summary: summary(stateFor(current.stage, current.round),
      run.status === 'queued' ? `${stageLabel}排队中` : run.status === 'running' ? `${stageLabel}运行中` : `${stageLabel}结果落盘中`,
      `等待${stageLabel}岗位完成`) };
  }
  if (record.dispatchError && record.dispatchError.step > current.step) {
    return { summary: summary('blocked', `无法进入下一步：${record.dispatchError.message}`, '处理原因后重试、接手或取消',
      ['retry', 'takeover', 'cancel']) };
  }
  if (current.outcome === 'blocked' && run.status !== 'completed') {
    return { summary: summary('blocked', `${stageLabel}${current.reason}`, '可重试本步、接手或取消', ['retry', 'takeover', 'cancel']) };
  }
  const outcome = outcomes.get(current.step)!;
  const nextStepNumber = current.step + 1;
  const rework = (feedbackOutcome: AgentStepOutcome): AgentWorkflowEvaluation => {
    const round = current.round + 1;
    return { summary: summary('reworking', feedbackOutcome.reason, `进入第 ${round} 轮返工`),
      next: { stage: 'implement', round, step: nextStepNumber, reason: feedbackOutcome.reason }, feedback: feedbackOutcome };
  };
  if (current.stage === 'implement') {
    if (outcome.outcome !== 'passed') return { summary: summary('blocked', outcome.reason, '可重试本步、接手或取消', ['retry', 'takeover', 'cancel']) };
    if (!run.workflowSnapshot) {
      return { summary: summary(stateFor('implement', current.round), '实现完成，正在计算版本标识', '创建验证副本'),
        needsSnapshot: { runId: run.id, stage: 'implement' } };
    }
    return { summary: summary('verifying', '实现完成，范围检查通过', '在一次性副本中验证', undefined, run.workflowSnapshot),
      next: { stage: 'verify', round: current.round, step: nextStepNumber, reason: '实现完成' } };
  }
  if (current.stage === 'verify') {
    if (outcome.outcome === 'blocked') return { summary: summary('blocked', outcome.reason, '可重试验证、接手或取消', ['retry', 'takeover', 'cancel']) };
    if (outcome.outcome === 'failed') return rework(outcome);
    return { summary: summary('reviewing', '验证通过', '跨模型审查', undefined, run.workflowSnapshot),
      next: { stage: 'review', round: current.round, step: nextStepNumber, reason: '验证通过' } };
  }
  if (outcome.outcome === 'blocked') return { summary: summary('blocked', outcome.reason, '可重试审查、接手或取消', ['retry', 'takeover', 'cancel']) };
  if (outcome.outcome === 'failed') return rework(outcome);
  const verified = steps.filter(step => step.stage === 'verify' && step.step < current.step).at(-1);
  const verifiedRun = verified ? latestAttempt(byStep.get(verified.step)!) : undefined;
  if (!run.workflowSnapshot) {
    return { summary: summary('reviewing', '审查批准，正在核对代码版本', '核对版本后进入验收'),
      needsSnapshot: { runId: run.id, stage: 'review' } };
  }
  if (!sameWorkspaceVersion(run.workflowSnapshot, verifiedRun?.workflowSnapshot)) {
    return { summary: summary('verifying', '审查期间代码版本已变化，原验证证据失效', '重新验证（不计入返工轮数）'),
      next: { stage: 'verify', round: current.round, step: nextStepNumber, reason: '代码版本已变化' } };
  }
  return { summary: summary('awaiting_acceptance', '验证与审查均通过，绑定同一代码版本', '在实现会话的“交付”中人工验收',
    ['takeover', 'cancel'], run.workflowSnapshot) };
}

/** 决定动作的可用性与效果；返回更新后的记录与需要派发的步骤。 */
export function applyWorkflowDecision(record: AgentWorkflowRecord, evaluation: AgentWorkflowEvaluation, action: AgentWorkflowAction,
  requestId: string, now: string): { record: AgentWorkflowRecord; dispatch?: AgentWorkflowNextStep; advance?: boolean; stopActive?: boolean } {
  const { summary } = evaluation;
  if (!summary.actions.includes(action)) throw new Error(`当前状态（${workflowStateLabels[summary.state]}）不能执行此操作`);
  const current = summary.steps.at(-1);
  const step = current?.step || 0;
  const decided = { ...record, decisions: [...record.decisions, { requestId, action, step, at: now }], updatedAt: now };
  if (action === 'cancel') return { record: { ...decided, closed: { action: 'cancel', at: now } }, stopActive: true };
  if (action === 'takeover') return { record: { ...decided, closed: { action: 'takeover', at: now } }, stopActive: true };
  if (action === 'retry') {
    // 卡在“进入下一步”时，清除错误后重新推进；否则重新执行当前这一步。
    if (record.dispatchError) {
      const { dispatchError: _cleared, ...rest } = decided;
      return { record: rest, advance: true };
    }
    if (!current) throw new Error('没有可重试的步骤');
    return { record: decided, dispatch: { stage: current.stage, round: current.round, step: current.step, reason: '用户选择重试本步' } };
  }
  if (!current) throw new Error('没有可返工的步骤');
  const round = current.round + 1;
  return { record: { ...decided, maxRounds: null, escalated: record.escalated || action === 'escalate' },
    dispatch: { stage: 'implement', round, step: current.step + 1,
      reason: action === 'escalate' ? '用户选择升级模型继续' : '用户选择继续' } };
}

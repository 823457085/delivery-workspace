/** 高级团队使用独立查询键和固定接口；读取状态不会启动任何模型。 */
import type { AgentAccessMode, AgentRun } from '../../../shared/agent-runtime';
import type { TeamTask, TeamProfileConfig, TeamModelChoice, TeamProfileId } from '../../../shared/agent-team';
import type { AgentTaskPlan, TeamTemplateId } from '../../../shared/agent-task-plan';
import type { AgentUsageSummary } from '../../../shared/agent-usage';
import type { TeamRoom as ServerTeamRoom } from '../../../server/agent-team-service';
import type { AgentEvaluation, agentEvaluationMetrics } from '../../../server/agent-eval';
import type { AgentSecondOpinion } from '../../../server/agent-delivery-draft';
import { deliveryAcceptanceStatus } from '../../../shared/delivery-acceptance';
import { evaluateReview, readAgentTaskReport } from '../../../shared/agent-task-result';
import type { DeliveryRecord } from '../workbench/domain';

const base = '/api/agent-runtimes';
export type AdvancedTeamTask = TeamTask & { baseHead?: string; candidateEvidenceAt?: string; legacy?: true; legacyAcceptanceRecordId?: string };
export type TeamRoom = ServerTeamRoom & { runs: AgentRun[]; opinions?: AgentSecondOpinion[] };
export type TeamEvaluation = AgentEvaluation & { metrics?: ReturnType<typeof agentEvaluationMetrics> };
export interface TeamProfileResponse { config: TeamProfileConfig; instructions: Partial<Record<TeamProfileId, string>> }
export interface TeamDraft { revision: number; text: string; evidenceHashes?: string[]; jiraHandoffUrl?: string;
  jiraHandoff?: { path: string; recordId: string; requiresConfirmation: true } }
export interface TeamArtifactContent { kind: string; hash: string; content: string; truncated: boolean }
async function request<T>(route: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}${route}`, { method, signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) }) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('团队接口返回无效内容，请重新读取'); }
  if (!response.ok) throw new Error((value as { message?: string })?.message || '团队操作失败');
  return value as T;
}
export async function readTeamTasks(signal?: AbortSignal): Promise<AdvancedTeamTask[]> {
  const value = await request<{ tasks: AdvancedTeamTask[] } | AdvancedTeamTask[]>('/team-tasks', 'GET', undefined, signal);
  const tasks = Array.isArray(value) ? value : value.tasks;
  if (!Array.isArray(tasks)) throw new Error('团队任务响应缺少 tasks');
  return tasks;
}
export async function createTeamTask(runId: string, input: { objective: string; attachmentIds: string[]; requestId: string; templateId?: TeamTemplateId }) {
  const value = await request<AdvancedTeamTask | { task: AdvancedTeamTask }>(`/runs/${encodeURIComponent(runId)}/team-task`, 'POST', input);
  return 'task' in value ? value.task : value;
}
export async function createTeamTaskAtWorkspace(input: { objective: string; workspacePath: string; attachmentIds: string[]; requestId: string; templateId?: TeamTemplateId }) {
  const value = await request<AdvancedTeamTask | { task: AdvancedTeamTask }>('/team-tasks', 'POST', input);
  return 'task' in value ? value.task : value;
}
export interface TeamChatRequest { objective: string; attachmentIds: string[]; requestId: string; parentRunId?: string; taskId?: string; workspacePath?: string; accessMode?: AgentAccessMode }
export interface TeamChatResponse { task: AdvancedTeamTask; runId: string; conversationId: string }
export const sendTeamChat = (input: TeamChatRequest) => request<TeamChatResponse>('/team-chat', 'POST', input);
/** 只展示宿主核对过的验证与审查结果；团队聊天不再把人工确认作为继续会话的门槛。 */
export function teamRoomAcceptanceRecord(room: TeamRoom | undefined): DeliveryRecord | undefined {
  const task = room?.task;
  if (!room || !task?.candidateEvidenceAt) return undefined;
  const sourceNode = task.nodes.filter(node => node.stage === 'implement').at(-1)
    || task.nodes.filter(node => node.stage === 'diagnose' && node.purpose !== 'answer').at(-1)
    || task.nodes.filter(node => node.stage === 'architect' && node.purpose !== 'answer').at(-1)
    || task.nodes.filter(node => node.stage === 'analyst' && node.purpose !== 'answer').at(-1);
  if (!sourceNode?.runId) return undefined;
  const source = { runId: sourceNode.runId, updatedAt: task.candidateEvidenceAt };
  const currentNodes = task.nodes.filter(node => node.round === task.round);
  const verification = currentNodes.filter(node => node.stage === 'verify').at(-1);
  const active = !['awaiting_acceptance', 'accepted', 'rejected', 'completed'].includes(task.state) || room.stale;
  const resultOf = (result?: string) => {
    try { return result ? readAgentTaskReport(result).taskResult : undefined; } catch { return undefined; }
  };
  const verified = verification?.status === 'completed' ? resultOf(verification.result) : undefined;
  const reviews = currentNodes.filter(node => node.stage === 'review' && node.status !== 'skipped');
  const reviewed = reviews.length > 0 && reviews.every(node => node.status === 'completed' && node.result
    && evaluateReview(node.result, task.plan?.acceptanceCriteria).outcome === 'passed');
  const implementation = sourceNode.round === task.round ? resultOf(sourceNode.result) : undefined;
  const acceptanceOverview = !active ? {
    summary: implementation?.summary || verified?.summary || '',
    reviews: currentNodes.filter(node => node.stage === 'review' && node.status === 'completed')
      .map(node => resultOf(node.result)?.summary || '').filter(Boolean),
    criteria: (task.plan?.acceptanceCriteria || []).map(item => {
      if (item.stage === 'review') {
        const checks = reviews.flatMap(node => resultOf(node.result)?.acceptance.filter(check => check.id === item.id) || []);
        return { id: item.id, text: item.text, status: reviewed ? 'passed' as const : 'not_run' as const,
          evidence: checks.map(check => check.evidence).filter(Boolean).join('；') };
      }
      const checked = verified?.acceptance.find(check => check.id === item.id);
      return { id: item.id, text: item.text, status: checked?.status || 'not_run', evidence: checked?.evidence || '' };
    }),
  } : undefined;
  return { id: task.legacyAcceptanceRecordId || `team:${task.id}`, source: '团队任务', sourceKind: 'agent', issueKeys: [], title: task.objective, status: task.state,
    threadId: '', workspacePath: task.workspacePath || task.sourceWorkspacePath, branch: '', updatedAt: source.updatedAt, result: '', error: '',
    detailPath: `/agent?run=${encodeURIComponent(source.runId)}`, links: [], runId: source.runId, agentRuns: room.runs,
    agentStateKnown: true, sourceKnown: true,
    reportedEvidence: !active && verification?.status === 'completed' ? room.evidence : undefined,
    acceptanceOverview, workflowActive: active,
    acceptance: room.acceptance, acceptanceKnown: true, acceptanceStatus: deliveryAcceptanceStatus(room.acceptance, source) };
}
export const readTeamRoom = (id: string, signal?: AbortSignal) => request<TeamRoom>(`/team-tasks/${encodeURIComponent(id)}`, 'GET', undefined, signal);
export const readTeamArtifact = (id: string, artifactId: string, signal?: AbortSignal) =>
  request<TeamArtifactContent>(`/team-tasks/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`, 'GET', undefined, signal);
export const saveTeamPlan = (id: string, input: { expectedRevision: number; action: 'confirm' | 'replan' | 'cancel'; plan?: AgentTaskPlan;
  answers?: { questionId: string; text: string }[]; requestId: string }) => request<AdvancedTeamTask>(`/team-tasks/${encodeURIComponent(id)}/plan`, 'POST', input);
export type TeamDecision = 'retry' | 'retry_review_codex' | 'extend' | 'escalate' | 'takeover' | 'cancel' | 'resolve_conflicts' | 'ask_leader';
export const decideTeamTask = (id: string, input: { action: TeamDecision; nodeId?: string; requestId: string; accessMode?: AgentAccessMode }) =>
  request<AdvancedTeamTask>(`/team-tasks/${encodeURIComponent(id)}/decision`, 'POST', input);
export const answerTeamMessage = (id: string, input: { correlationId: string; text: string; requestId: string; attachmentIds?: string[]; accessMode?: AgentAccessMode }) =>
  request<TeamRoom>(`/team-tasks/${encodeURIComponent(id)}/messages`, 'POST', input);
export async function readTeamProfiles(signal?: AbortSignal): Promise<TeamProfileResponse> {
  const value = await request<TeamProfileConfig | TeamProfileResponse>('/agent-profiles', 'GET', undefined, signal);
  return 'config' in value ? value : { config: value, instructions: {} };
}
export const saveTeamProfiles = (config: TeamProfileConfig) => request<TeamProfileConfig>('/agent-profiles', 'PUT', {
  expectedRevision: config.revision, profiles: config.profiles, reviewRouting: config.reviewRouting, options: config.options });
export async function readTeamUsage(signal?: AbortSignal): Promise<AgentUsageSummary> {
  const value = await request<AgentUsageSummary | { summary: AgentUsageSummary }>('/agent-usage', 'GET', undefined, signal);
  return 'summary' in value ? value.summary : value;
}
export async function readTeamEvaluations(signal?: AbortSignal) {
  const value = await request<{ evaluations: TeamEvaluation[] }>('/agent-evaluations', 'GET', undefined, signal);
  if (!Array.isArray(value.evaluations)) throw new Error('评测响应缺少 evaluations');
  return value.evaluations;
}
export const createTeamEvaluation = (input: { taskIds: string[]; profileId: Extract<TeamProfileId, 'engineer' | 'frontend' | 'batch' | 'reviewer'>;
  models: [TeamModelChoice, TeamModelChoice]; confirmed: true; requestId: string }) =>
  request<TeamEvaluation>('/agent-evaluations', 'POST', input);
export const annotateTeamEvaluation = (id: string, input: { variantId: string; findingId: string; annotation: 'true_issue' | 'false_positive'; note?: string }) =>
  request<TeamEvaluation>(`/agent-evaluations/${encodeURIComponent(id)}/annotate`, 'POST', input);
export const resumeTeamEvaluation = (id: string) => request<TeamEvaluation>(`/agent-evaluations/${encodeURIComponent(id)}/resume`, 'POST', { confirmedResume: true });
export async function readTeamDraft(id: string, signal?: AbortSignal): Promise<TeamDraft | null> {
  const value = await request<TeamDraft | null>(`/team-tasks/${encodeURIComponent(id)}/draft`, 'GET', undefined, signal);
  if (!value || value.revision === 0) return null;
  return { ...value, ...(value.jiraHandoff?.path ? { jiraHandoffUrl: value.jiraHandoff.path } : {}) };
}
export const createTeamDraft = (id: string, requestId: string) => request<TeamDraft>(`/team-tasks/${encodeURIComponent(id)}/draft`, 'POST', { requestId });
export const saveTeamDraft = (id: string, expectedRevision: number, text: string) => request<TeamDraft>(`/team-tasks/${encodeURIComponent(id)}/draft`, 'PUT', { expectedRevision, text });
export const requestSecondOpinion = (id: string, requestId: string) => request<AgentSecondOpinion>(`/team-tasks/${encodeURIComponent(id)}/second-opinion`, 'POST', { requestId });

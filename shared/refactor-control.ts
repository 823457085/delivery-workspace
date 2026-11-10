/** 重构管理区分来源台账、执行状态与实测结论；任务结束不会自动成为人工验收。 */
import type { AgentProvider, AgentReasoningEffort, AgentRunStatus } from './agent-runtime.js';
import type { ExecutionIssue } from '../src/features/integration-execution/execution-plan.js';
import type { TeamNode, TeamProfileConfig, TeamTaskState } from './agent-team.js';
import type { GroupConfig } from './agent-group-chat.js';
import type { RefactorLocalPlan, RefactorLocalRuntime } from './refactor-local-retest.js';

export const refactorActions = ['develop', 'integrate', 'style-check', 'style-fix', 'retest'] as const;
export const refactorTeamProfileIds = ['leader', 'frontend', 'verifier', 'reviewer', 'reporter'] as const;
export type RefactorAction = typeof refactorActions[number];
export const refactorActionLabels: Record<RefactorAction, string> = {
  develop: '开发实现', integrate: '触发联调', 'style-check': '检查样式', 'style-fix': '修改样式', retest: '复测问题',
};
export interface RefactorConfig {
  sourceRoot: string; workspacePath: string; baseUrl: string; environment: string; assignee: string;
}
export interface RefactorInterface {
  id: string; name: string; method: string; path: string; page: string; route: string;
  category: string; reviewStatus: string; previousStatus: string; previousResult: string; checkedAt: string;
  request?: string; parameters?: string; expected?: string; notes?: string;
  document?: { id: string; name: string; sheet: string; row: number; originalFile: string };
}
export interface RefactorIssue extends ExecutionIssue {
  moduleId: string; moduleTitle: string; eligibility: string;
}
export interface RefactorModule {
  id: string; title: string; module: string; deferred: boolean;
  interfaces: RefactorInterface[]; issues: RefactorIssue[]; pages: string[];
  updatedAt: string; previousStatus: string;
}
export interface RefactorSource {
  modules: RefactorModule[]; sourceRoot: string; sourceUpdatedAt: string;
  workspace: { path: string; branch: string; head: string; dirty: boolean };
}
export type RefactorConclusion = 'passed' | 'failed' | 'blocked' | 'not_run' | 'partial';
export const refactorConclusionLabels: Record<RefactorConclusion, string> = {
  passed: '检查通过，待验收', failed: '检查未通过', blocked: '验证阻塞', not_run: '未执行', partial: '部分完成',
};
export interface RefactorResult {
  jobId: string; environment: string; version: string; summary: string; status: RefactorConclusion;
  items: { targetId: string; status: Exclude<RefactorConclusion, 'partial'>; actual: string; expected?: string; evidence: string[] }[];
  checks: { name: string; status: Exclude<RefactorConclusion, 'partial'>; detail: string }[];
  changedFiles: string[];
}
export interface RefactorJob {
  id: string; batchId: string; moduleId: string; moduleTitle: string; action: RefactorAction;
  targetIds: string[]; issueIds: string[]; environment: string; version: string; sourceHead: string;
  provider: AgentProvider; model: string; reasoningEffort?: AgentReasoningEffort | '';
  createdAt: string; startedAt: string; runId: string; status: 'queued' | 'started' | 'failed' | 'cancelled'; error: string;
  runStatus?: AgentRunStatus; runResult?: string; currentStep?: string; report?: RefactorResult; reportError?: string;
  collaborationMode?: 'automatic' | 'manual'; teamTaskId?: string; teamRevision?: number; team?: RefactorTeam;
  teamSource?: 'group' | 'profiles'; teamName?: string; groupRoomId?: string;
  retestMode?: 'local' | 'deployed'; localPlan?: RefactorLocalPlan; localRuntime?: RefactorLocalRuntime;
}
export interface RefactorTeam {
  id: string; state: TeamTaskState; reason?: string; conversationId: string; workspacePath?: string; profileRevision: number;
  nodes: (Pick<TeamNode, 'id' | 'stage' | 'profileId' | 'status' | 'runId' | 'startedAt' | 'finishedAt' | 'error'> & {
    label: string; provider: AgentProvider; model: string; actual: boolean;
  })[];
}
export interface RefactorDashboard {
  config: RefactorConfig; revision: string; source?: RefactorSource; sourceError?: string; jobs: RefactorJob[];
  teamConfig?: TeamProfileConfig;
  groupConfig?: GroupConfig;
}
export interface RefactorLaunch {
  action: RefactorAction; moduleIds: string[]; issueIds: string[]; version: string; notes: string;
  provider: AgentProvider; model: string; reasoningEffort?: AgentReasoningEffort | '';
  revision: string;
  collaborationMode?: 'automatic' | 'manual'; teamRevision?: number;
  interfaceIds?: string[];
  retestMode?: 'local' | 'deployed'; branches?: { workspacePath: string; ref: string }[];
}
export interface RefactorPreview {
  scopeHash: string; action: RefactorAction; environment: string; version: string; sourceHead: string;
  collaborationMode?: 'automatic' | 'manual'; teamRevision?: number;
  teamSource?: 'group' | 'profiles'; teamName?: string;
  jobs: { moduleId: string; moduleTitle: string; targetIds: string[]; issueIds: string[]; pages: string[];
    workspacePath?: string; baseUrl?: string; sourceHead?: string; projectId?: string; localPlan?: RefactorLocalPlan }[];
}
export function refactorJobActive(job: RefactorJob) {
  return job.status === 'queued' || job.status === 'started' && (job.team ? refactorTeamActive(job.team.state) : ['queued', 'running'].includes(job.runStatus || 'queued'));
}
export const refactorTeamActive = (state: TeamTaskState) => !['completed', 'accepted', 'rejected', 'cancelled', 'taken_over', 'awaiting_acceptance'].includes(state);
export const refactorTeamStateLabels: Record<TeamTaskState, string> = {
  planning: '团队规划中', awaiting_plan: '待确认团队计划', running: '团队执行中', waiting_input: '团队等待回复', blocked: '团队遇到阻碍',
  needs_decision: '团队待决策', needs_reconciliation: '团队待核对', awaiting_acceptance: '团队完成，待验收', accepted: '团队已验收',
  rejected: '团队结果已退回', cancelled: '团队已停止', taken_over: '已人工接管', completed: '团队执行结束，待核对结果',
};
export function refactorJobLabel(job: RefactorJob) {
  if (job.status === 'cancelled' || job.runStatus === 'cancelled') return '已停止';
  if (job.status === 'queued') return '排队中';
  if (job.team && (refactorTeamActive(job.team.state) || ['cancelled', 'rejected', 'taken_over'].includes(job.team.state))) return refactorTeamStateLabels[job.team.state];
  if (job.status === 'failed' || job.runStatus === 'failed') return '执行失败';
  if (job.runStatus === 'interrupted') return '执行中断';
  if (job.report && ['queued', 'running'].includes(job.runStatus || '')) return '执行中';
  if (job.report) return refactorConclusionLabels[job.report.status];
  return job.team ? refactorTeamStateLabels[job.team.state] : job.runStatus === 'completed' ? '执行结束，待核对结果' : '执行中';
}
export function refactorReportMarkdown(dashboard: RefactorDashboard, moduleIds: string[] = []) {
  const modules = (dashboard.source?.modules || []).filter(module => !moduleIds.length || moduleIds.includes(module.id));
  const jobs = dashboard.jobs.filter(job => !moduleIds.length || moduleIds.includes(job.moduleId));
  const line = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return [`# 重构交付结果`, '', `导出时间：${new Date().toISOString()}`, `环境：${dashboard.config.environment}`,
    `工作区：${dashboard.config.workspacePath}`, `来源：${dashboard.config.sourceRoot}`, '',
    '## 模块进度', '', '| 模块 | 本轮接口 | 历史检查通过 | 人工确认 | 问题 |', '| --- | ---: | ---: | ---: | ---: |',
    ...modules.map(module => `| ${line(module.title)} | ${module.interfaces.filter(item => item.category === '本轮联调').length} | ${module.interfaces.filter(item => ['已通过', '已修复'].includes(item.previousStatus)).length} | ${module.interfaces.filter(item => item.reviewStatus === '已联调').length} | ${module.issues.length} |`),
    '', '## 执行结果', '', ...jobs.flatMap(job => [`### ${refactorActionLabels[job.action]} · ${job.moduleTitle}`, '',
      `- 状态：${refactorJobLabel(job)}`, `- 任务：${job.id}`, `- 环境 / 版本：${job.environment} / ${job.version || '未填写'}`,
      `- 代码基准：${job.sourceHead || '非 Git 工作区'}`, `- 结果：${job.report?.summary || job.error || job.reportError || '尚无可核对报告'}`,
      ...(job.localPlan ? [`- 复测分支：${job.localPlan.branch}`, `- 独立工作区：${job.localRuntime?.workspacePath || '尚未准备'}`,
        `- 本地地址：${job.localRuntime?.baseUrl || '尚未启动'}`] : []),
      ...(job.team ? [`- 团队：${job.team.id}；岗位配置版本 ${job.team.profileRevision}；${refactorTeamStateLabels[job.team.state]}`,
        ...job.team.nodes.map(node => `  - ${node.label}：${node.status}；${node.provider} / ${node.model}${node.actual ? '（运行配置）' : '（计划配置）'}`)] : []),
      ...(job.report?.items.flatMap(item => [`- ${item.targetId}：${refactorConclusionLabels[item.status]}；${item.actual}`,
        ...item.evidence.map(file => `  - 证据：${file}`)]) || []), '']),
    '历史台账、任务执行结果与人工验收分别记录；没有本轮证据的项目不视为通过。', ''].join('\n');
}

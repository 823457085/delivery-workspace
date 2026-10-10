/** 自动执行的前后端契约：授权、阶段结果和工具回读证据独立于人工看板记录。 */
import { z } from 'zod';

const optionalJiraDateSchema = z.union([z.literal(''), z.iso.date()]).default('');
export const designInputSchema = z.object({
  issueKey: z.string().max(500), title: z.string().max(300), project: z.string().max(120), fixVersion: z.string().max(200),
  assignee: z.string().max(120), jiraStartDate: optionalJiraDateSchema, jiraEndDate: optionalJiraDateSchema,
  prdUrl: z.string().max(2000), prototypeUrl: z.string().max(2000),
  workspacePath: z.string().max(1000), branch: z.string().max(300), confluenceParentUrl: z.string().max(2000), notes: z.string().max(12000),
});
export type DesignExecutionInput = z.infer<typeof designInputSchema>;
export const EXECUTION_STAGES = [
  { id: 'intake', title: '读取需求与定位目录', checks: ['requirement-read', 'project-version', 'target-directory', 'workspace-identity'] },
  { id: 'research', title: '分析 PRD、原型与代码', checks: ['prd-read', 'repository-read', 'scope-boundary'] },
  { id: 'design', title: '生成方案与覆盖矩阵', checks: ['template', 'coverage', 'api-evidence', 'unsigned-g2a'] },
  { id: 'publish', title: '发布 Confluence', checks: ['publication-dedup', 'publication-readback'] },
  { id: 'jira', title: '创建 / 复用 Jira 层级', checks: ['jira-dedup', 'jira-hierarchy', 'jira-fields'] },
  { id: 'verify', title: '独立回读与交付回执', checks: ['document-readback', 'jira-readback', 'no-product-change', 'unsigned-g2a'] },
] as const;
export type ExecutionStage = typeof EXECUTION_STAGES[number]['id'];
export const artifactsSchema = z.object({
  requirementKey: z.string(), project: z.string(), fixVersion: z.string(), assignee: z.string(),
  parentPageId: z.string(), spaceKey: z.string(), documentId: z.string(), documentUrl: z.string(),
  documentTitle: z.string(), documentVersion: z.number().int().nonnegative(),
  devParentKey: z.string(), designTaskKey: z.string(), implementationTaskKey: z.string(),
});
export const stageResultSchema = z.object({
  outcome: z.enum(['passed', 'blocked']), summary: z.string(),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })),
  evidence: z.array(z.object({ kind: z.enum(['jira', 'confluence', 'code', 'document']), ref: z.string(), detail: z.string() })),
  artifacts: artifactsSchema, markdown: z.string(),
});
export type StageResult = z.infer<typeof stageResultSchema>;
export type ExecutionArtifacts = z.infer<typeof artifactsSchema>;
export function emptyArtifacts(): ExecutionArtifacts {
  return { requirementKey: '', project: '', fixVersion: '', assignee: '', parentPageId: '', spaceKey: '', documentId: '', documentUrl: '', documentTitle: '', documentVersion: 0, devParentKey: '', designTaskKey: '', implementationTaskKey: '' };
}
export interface ToolProof { tool: string; target: string; succeeded: boolean }
export interface ExecutionStep {
  id: ExecutionStage; status: 'pending' | 'running' | 'passed' | 'blocked'; attempts: number;
  startedAt?: string; endedAt?: string; summary: string; result?: StageResult; resultAttempt?: number; proof: ToolProof[];
  proofSource?: 'codex-desktop';
}
export function isCurrentStepResult(step: ExecutionStep): boolean {
  return !!step.result && (step.resultAttempt === step.attempts || (step.resultAttempt === undefined && step.status === 'passed'));
}
export function desktopHandoff(run: DesignExecution, origin: string): string {
  return `请在当前 Codex 会话执行技术方案交付 ${run.input.issueKey}，不启动 Codex CLI，不创建或委托其他会话。${run.threadId ? `沿用会话 ${run.threadId}。` : '首次领取时绑定当前实际会话 ID。'}\n读取 ${origin}/api/design-executor/runs/${run.id}/desktop 获取当前阶段、冻结输入和回写 Schema。任务若为 blocked，先核对阻塞及可能已产生的外部结果，再通过 resume 接口恢复；若 queued，使用 revision 和实际 threadId POST claim 领取。只执行领取阶段并 POST submit 回写真实结果，通过后再领取下一阶段。所有 POST 使用 Content-Type: application/json、Origin: ${origin}、X-Delivery-Confirmed: yes。不得把旧结果或模型声明充当本次工具回读，不修改产品代码，不变更 Jira 状态，不签署 G2a。停止或回写拒绝时停止后续动作。`;
}
export interface DesignExecution {
  id: string; input: DesignExecutionInput; status: 'queued' | 'running' | 'blocked' | 'completed';
  createdAt: string; updatedAt: string; authorizedAt: string; revision: number; threadId: string;
  attemptIds: string[]; steps: ExecutionStep[]; events: { at: string; message: string }[];
  error: string; clarification: string; artifacts: ExecutionArtifacts;
  desktopClaim?: { id: string; stage: ExecutionStage; threadId: string; claimedAt: string };
  desktopSubmission?: { claimId: string; digest: string };
}
export interface ExecutorHealth {
  mode?: 'codex-desktop';
  ready: boolean; cli: string; authenticated: boolean; atlassianConfigured: boolean; skillsReady: boolean;
  message: string; checkedAt: string;
}
export interface ExecutionDashboard { health: ExecutorHealth; runs: DesignExecution[] }
export const executionStartSchema = z.object({
  input: designInputSchema, authorization: z.literal('publish-confluence-and-create-jira'),
}).strict().superRefine(({ input }, context) => {
  if (!input.jiraStartDate) context.addIssue({ code: 'custom', path: ['input', 'jiraStartDate'], message: '请填写 Jira 开始日期' });
  if (!input.jiraEndDate) context.addIssue({ code: 'custom', path: ['input', 'jiraEndDate'], message: '请填写 Jira 结束日期' });
  if (input.jiraStartDate && input.jiraEndDate && input.jiraStartDate > input.jiraEndDate) {
    context.addIssue({ code: 'custom', path: ['input', 'jiraStartDate'], message: 'Jira 开始日期不能晚于结束日期' });
  }
});
export const executionResumeSchema = z.object({
  revision: z.number().int(), clarification: z.string().max(12000), authorization: z.literal('publish-confluence-and-create-jira'),
}).strict();
export const desktopClaimSchema = z.object({ revision: z.number().int(), threadId: z.string().uuid() }).strict();
export const desktopSubmissionSchema = z.object({
  claimId: z.string().uuid(), threadId: z.string().uuid(), stage: z.enum(['intake', 'research', 'design', 'publish', 'jira', 'verify']),
  result: stageResultSchema,
  proof: z.array(z.object({ tool: z.string().max(120), target: z.string().max(500), succeeded: z.boolean() }).strict()).max(500),
}).strict();

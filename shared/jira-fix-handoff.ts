/** 交接独立于修复执行：用户确认四段评论和工作流目标后才允许写 Jira。 */
import { z } from 'zod';

const draftText = z.string().trim().min(1).max(6000);
const text = z.string().trim().min(1, '请填写完整交接说明').max(6000)
  .refine(value => !/【待开发(?:填写|确认)】/.test(value), '请先确认并补全交接说明');
export const jiraCommentDraftSchema = z.object({ cause: text, impact: text, suggestion: text, conclusion: text }).strict();
export type JiraCommentDraft = z.infer<typeof jiraCommentDraftSchema>;
const transitionFields = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/), z.iso.date()).optional();
export const jiraCommentGenerateSchema = z.object({
  // 旧草稿允许带占位文字参与重写，生成结果与正式评论均不允许保留。
  runId: z.uuid(), draft: z.object({ cause: draftText, impact: draftText, suggestion: draftText, conclusion: draftText }).partial().strict(), feedback: z.string().trim().max(6000),
  authorization: z.literal('generate-jira-comment'),
}).strict();

export const jiraFixHandoffInputSchema = z.object({
  runId: z.uuid(), transitionId: z.string().trim().max(100), targetStatusId: z.string().trim().min(1).max(100),
  reporterId: z.string().trim().min(1).max(200),
  cause: text, impact: text, suggestion: text, conclusion: text,
  transitionFields,
  authorization: z.literal('comment-transition-assign-reporter'),
}).strict();
export type JiraFixHandoffInput = z.infer<typeof jiraFixHandoffInputSchema>;
export const jiraStatusChangeInputSchema = z.object({
  requestId: z.uuid(), runId: z.uuid(), fromStatusId: z.string().trim().min(1).max(100),
  transitionId: z.string().trim().min(1).max(100), targetStatusId: z.string().trim().min(1).max(100),
  viaStatusIds: z.array(z.string().trim().min(1).max(100)).min(1).max(2).optional(),
  transitionFields,
  authorization: z.literal('transition-jira-status'),
}).strict();
export interface JiraStatusChangeState {
  input: z.infer<typeof jiraStatusChangeInputSchema>;
  status: 'submitting' | 'completed' | 'failed' | 'uncertain';
  error: string; updatedAt: string; result?: JiraHandoffIssue;
  inFlightStatusId?: string;
}
export interface JiraHandoffUser { id: string; name: string; kind: 'name' | 'accountId'; active: boolean }
export interface JiraHandoffIssue {
  key: string; summary: string; status: { id: string; name: string }; reporter: JiraHandoffUser | null;
  assignee: JiraHandoffUser | null;
}
export interface JiraHandoffDateField { id: string; name: string; required: boolean }
export interface JiraHandoffTransition { id: string; name: string; to: { id: string; name: string }; dateFields?: JiraHandoffDateField[] }
/** 只允许本次流转表单声明可写的日期，不开放任意 Jira 业务字段。 */
export function validateJiraTransitionFields(transition: JiraHandoffTransition, fields: Record<string, string> = {}) {
  const allowed = transition.dateFields || [];
  for (const id of Object.keys(fields)) {
    if (!allowed.some(field => field.id === id)) throw new Error('日期字段已不在当前流转表单中，请重新打开核对');
  }
  const missing = allowed.find(field => field.required && !fields[field.id]);
  if (missing) throw new Error(`请填写${missing.name}`);
}
export interface JiraHandoffStatus { id: string; name: string }
export type JiraHandoffStep = 'comment' | 'transition' | 'assign' | 'verify';
export interface JiraFixHandoffState {
  input: JiraFixHandoffInput; status: 'submitting' | 'failed' | 'uncertain' | 'completed';
  commentId: string; transitioned: boolean; assigned: boolean; inFlight?: JiraHandoffStep;
  error: string; updatedAt: string; result?: JiraHandoffIssue;
}
export interface JiraFixHandoffContext {
  issue: JiraHandoffIssue; transitions: JiraHandoffTransition[]; runId: string; result: string;
  handoff?: JiraFixHandoffState;
  statuses?: JiraHandoffStatus[];
  statusWarning?: string;
  statusChange?: JiraStatusChangeState;
  testingPath?: JiraTestingPath;
}
export interface JiraTestingPath { transitionId: string; statuses: JiraHandoffStatus[] }
/** 已核对的提测顺序仅规划目标，不猜测流转 ID；服务端每一步仍须查询当前事项的真实 transitions。 */
export function jiraTestingPath(issue: JiraHandoffIssue, statuses: JiraHandoffStatus[], transitions: JiraHandoffTransition[]): JiraTestingPath | undefined {
  const order = ['待开始', '设计中', '开发中', '测试中'];
  const index = order.indexOf(issue.status.name);
  if (index < 0 || index >= 2 || transitions.some(item => item.to.name === '测试中')) return;
  const remaining = order.slice(index + 1).map(name => statuses.filter(item => item.name === name));
  if (remaining.some(items => items.length !== 1)) return;
  const path = remaining.map(items => items[0]!);
  const first = transitions.filter(item => item.to.id === path[0]!.id);
  if (first.length !== 1) return;
  return { transitionId: first[0]!.id, statuses: path };
}
export function jiraFixHandoffComment(input: JiraCommentDraft) {
  return `问题原因：${input.cause}\n\n影响范围：${input.impact}\n\n测试建议：${input.suggestion}\n\n自测结论：${input.conclusion}`;
}

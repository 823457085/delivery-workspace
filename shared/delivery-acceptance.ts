/** 验收是人工核对后的独立记录；Jira、Agent 和历史执行状态都不能替代验收结论。 */
import { z } from 'zod';
import { readDeliveryReport } from './delivery-report.js';

export const deliveryEvidenceKinds = ['tests', 'browser', 'remote', 'deployment'] as const;
export type DeliveryEvidenceKind = typeof deliveryEvidenceKinds[number];
export const deliveryEvidenceLabels: Record<DeliveryEvidenceKind, string> = {
  tests: '测试 / 检查', browser: '浏览器验证', remote: '远端提交', deployment: '部署验证',
};
export const deliveryEvidenceStatuses = ['pending', 'passed', 'failed', 'not_applicable'] as const;
export const deliveryEvidenceStatusLabels = { pending: '未验证', passed: '通过', failed: '未通过', not_applicable: '不适用' };
const evidenceSchema = z.object({
  status: z.enum(deliveryEvidenceStatuses), evidence: z.string().trim().max(6000), sha: z.string().trim().max(64),
}).strict().superRefine((value, context) => {
  if (value.status !== 'pending' && !value.evidence) context.addIssue({ code: 'custom', path: ['evidence'],
    message: value.status === 'not_applicable' ? '不适用时填写理由' : '填写验证结果和可核对的证据' });
});
export const deliveryEvidenceSchema = z.object({
  tests: evidenceSchema, browser: evidenceSchema, remote: evidenceSchema, deployment: evidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.remote.status === 'passed' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.remote.sha)) {
    context.addIssue({ code: 'custom', path: ['remote', 'sha'], message: '远端提交通过时需填写回读确认的完整 SHA' });
  }
});
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;
export function emptyDeliveryEvidence(): DeliveryEvidence {
  return Object.fromEntries(deliveryEvidenceKinds.map(kind => [kind, { status: 'pending', evidence: '', sha: '' }])) as DeliveryEvidence;
}
// 只读取报告中的验证事实，业务进度和交接字段各自校验；不从普通结果文本推断通过，也不写人工验收。
const deliveryEvidenceReportSchema = z.object({
  version: z.literal(1), validationEvidence: deliveryEvidenceSchema,
  requirementProgress: z.unknown().optional(), jiraHandoff: z.unknown().optional(),
}).strict();
export function readDeliveryEvidenceReport(result: string): DeliveryEvidence | undefined {
  try { return deliveryEvidenceReportSchema.parse(readDeliveryReport(result)).validationEvidence; }
  catch { return undefined; }
}
export const deliveryEvidenceReportPrompt = `在上面的同一个 delivery-report JSON 中另填 validationEvidence，结构为 ${JSON.stringify(emptyDeliveryEvidence())}。
tests / browser / remote / deployment 分别记录测试检查、浏览器验证、远端提交回读、部署验证。status 只能为 pending / passed / failed / not_applicable；每项 evidence 写明本轮实际命令、结果、日志/截图路径或回读链接，并保留真实联调、部署等未验证范围。未执行或证据不足用 pending 并说明缺项；失败用 failed；not_applicable 必须说明范围理由，不能将未执行写成不适用或通过。remote 只有真实远端回读成功才可 passed，sha 填完整 40 或 64 位提交 SHA；其余 sha 填空字符串。每项 evidence 不超过 6000 字。
该字段仅用于预填待人工核对的验收证据；不填写人工验收结论、不新增执行或外部写入授权，不为填报告而提交、推送、部署。整个最终答复仍只提供一个 delivery-report 代码块。`;
export const deliveryRecordIdSchema = z.string().max(260)
  .regex(/^(?:requirement|jira-fix|agent|job|design|catchup|merge):[A-Za-z0-9][A-Za-z0-9:._-]*$/, '交付记录标识无效');
export const deliveryAcceptanceSourceSchema = z.object({
  runId: z.string().trim().max(200), updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type DeliveryAcceptanceSource = z.infer<typeof deliveryAcceptanceSourceSchema>;
export interface ResolvedDeliveryAcceptanceSource extends DeliveryAcceptanceSource { active: boolean }
const acceptanceFields = {
  recordId: deliveryRecordIdSchema, source: deliveryAcceptanceSourceSchema, checks: deliveryEvidenceSchema,
  decision: z.enum(['pending', 'accepted', 'rejected']), summary: z.string().trim().max(6000),
};
function validateDecision(value: { decision: string; summary: string; checks: DeliveryEvidence }, context: z.RefinementCtx) {
  if (value.decision !== 'pending' && !value.summary) context.addIssue({ code: 'custom', path: ['summary'], message: '填写人工验收结论' });
  if (value.decision === 'accepted' && deliveryEvidenceKinds.some(kind => !['passed', 'not_applicable'].includes(value.checks[kind].status))) {
    context.addIssue({ code: 'custom', path: ['decision'], message: '所有适用项通过，或填写不适用理由后，才能确认验收通过' });
  }
}
export const deliveryAcceptanceInputSchema = z.object({
  ...acceptanceFields, expectedRevision: z.number().int().min(0), authorization: z.literal('record-delivery-acceptance'),
}).strict().superRefine(validateDecision);
export type DeliveryAcceptanceInput = z.infer<typeof deliveryAcceptanceInputSchema>;
export const deliveryAcceptanceRecordSchema = z.object({
  ...acceptanceFields, revision: z.number().int().min(1), updatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine(validateDecision);
export type DeliveryAcceptanceRecord = z.infer<typeof deliveryAcceptanceRecordSchema>;
export type DeliveryAcceptanceStatus = 'pending' | 'accepted' | 'rejected' | 'stale';
export function sameDeliverySource(left: DeliveryAcceptanceSource, right: DeliveryAcceptanceSource) {
  return left.runId === right.runId && left.updatedAt === right.updatedAt;
}
export function deliveryAcceptanceStatus(record: DeliveryAcceptanceRecord | undefined, source: DeliveryAcceptanceSource): DeliveryAcceptanceStatus {
  if (!record || record.decision === 'pending') return 'pending';
  return sameDeliverySource(record.source, source) ? record.decision : 'stale';
}
export const deliveryAcceptanceLabels: Record<DeliveryAcceptanceStatus, string> = {
  pending: '未验收', accepted: '人工验收通过', rejected: '人工验收未通过', stale: '需重新验收',
};

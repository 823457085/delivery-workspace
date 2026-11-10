/** 高级团队的计划与资料契约；模型只能提出计划，确认与派发由工作台控制。 */
import { z } from 'zod';
import { readDeliveryReport } from './delivery-report.js';
import { globToRegExp } from './agent-task-result.js';

export const teamTemplateIds = ['engineering', 'frontend', 'verification', 'diagnosis', 'research_design', 'complex_delivery', 'complex_delivery_parallel', 'batch'] as const;
export type TeamTemplateId = typeof teamTemplateIds[number];
const text = (max = 4000) => z.string().trim().min(1).max(max);
export const teamRelativePathSchema = text(500).refine(value => !value.replace(/\\/g, '/').startsWith('/') && !/^[A-Za-z]:/.test(value)
  && !value.includes('\0') && !value.replace(/\\/g, '/').split('/').some(part => part === '..'), '路径必须是工作区内的相对路径');
export const planAcceptanceSchema = z.object({ id: text(40), text: text(), source: text(1000),
  // 旧计划未注明阶段时仍须由验证岗位核验，不能按自然语言猜测并放行。
  stage: z.enum(['verify', 'review']).optional() }).strict();
export const planOwnershipSchema = z.object({ owner: z.enum(['engineer', 'frontend']), paths: z.array(teamRelativePathSchema).min(1).max(100) }).strict();
export const sharedOwnershipSchema = z.object({ path: teamRelativePathSchema, owner: z.enum(['engineer', 'frontend']),
  consumers: z.array(z.enum(['engineer', 'frontend'])).max(2).default([]) }).strict();
export const transformSpecSchema = z.object({
  rule: text(8000), examples: z.array(z.object({ before: text(8000), after: z.string().max(8000) }).strict()).min(1).max(30),
  include: z.array(teamRelativePathSchema).min(1).max(100), exclude: z.array(teamRelativePathSchema).max(100).default([]),
  knownExceptions: z.array(teamRelativePathSchema).max(200).default([]), checks: z.array(text(1000)).max(30).default([]),
  residual: z.object({ kind: z.enum(['literal', 'regex']).default('literal'), pattern: text(2000),
    flags: z.string().max(5).regex(/^[gimsu]*$/).default('g') }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.residual?.kind === 'regex') {
    try { new RegExp(value.residual.pattern, value.residual.flags); }
    catch { context.addIssue({ code: 'custom', path: ['residual'], message: '残留检查正则无效' }); }
  }
});
export type TransformSpec = z.infer<typeof transformSpecSchema>;

/** 保守判断两组 glob 是否可能交叠；不同固定目录或互斥扩展名可证明不交叠，其余要求计划明确拆分。 */
export function ownershipPatternsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**');
  const a = normalize(left), b = normalize(right);
  if (!/[?*]/.test(a)) return globToRegExp(b).test(a) || globToRegExp(a).test(b);
  if (!/[?*]/.test(b)) return globToRegExp(a).test(b) || globToRegExp(b).test(a);
  const prefix = (value: string) => value.split(/[?*]/)[0];
  const pa = prefix(a), pb = prefix(b);
  if (!pa.startsWith(pb) && !pb.startsWith(pa)) return false;
  const extension = (value: string) => /\.([A-Za-z0-9_-]+)$/.exec(value)?.[1];
  const ea = extension(a), eb = extension(b);
  return !(ea && eb && ea !== eb);
}

export function validatePlanOwnership(plan: { ownership?: { owner: string; paths: string[] }[];
  shared?: { path: string; owner: string; consumers: string[] }[] }): string[] {
  const issues: string[] = [];
  const ownership = plan.ownership || [];
  for (let a = 0; a < ownership.length; a += 1) for (let b = a + 1; b < ownership.length; b += 1) {
    if (ownership[a].owner === ownership[b].owner) continue;
    for (const left of ownership[a].paths) for (const right of ownership[b].paths) {
      if (ownershipPatternsOverlap(left, right)) issues.push(`文件归属重叠：${ownership[a].owner} ${left} / ${ownership[b].owner} ${right}`);
    }
  }
  const sharedPaths = new Set<string>();
  for (const item of plan.shared || []) {
    if (sharedPaths.has(item.path)) issues.push(`共享文件重复：${item.path}`);
    sharedPaths.add(item.path);
    if (!ownership.some(owner => owner.owner === item.owner && owner.paths.some(pattern => globToRegExp(pattern).test(item.path)))) {
      issues.push(`共享文件缺少对应负责人允许范围：${item.path}`);
    }
    if (item.consumers.includes(item.owner)) issues.push(`共享文件消费者不能包含负责人：${item.path}`);
  }
  return issues;
}

export const taskPlanSchema = z.object({
  templateId: z.enum(teamTemplateIds), reason: text(), risk: z.enum(['low', 'medium', 'high']),
  acceptanceCriteria: z.array(planAcceptanceSchema).min(1).max(50), allowedPaths: z.array(teamRelativePathSchema).max(100),
  needsAnalyst: z.boolean().default(false), needsArchitect: z.boolean().default(false),
  questions: z.array(z.object({ id: text(40), text: text(), blocking: z.boolean() }).strict()).max(30).default([]),
  risks: z.array(text()).max(30).default([]), ownership: z.array(planOwnershipSchema).max(10).default([]),
  shared: z.array(sharedOwnershipSchema).max(100).default([]), transformSpec: transformSpecSchema.optional(),
}).strict().superRefine((value, context) => {
  for (const key of ['acceptanceCriteria', 'questions'] as const) {
    if (new Set(value[key].map(item => item.id)).size !== value[key].length) context.addIssue({ code: 'custom', path: [key], message: '标识不能重复' });
  }
  for (const message of validatePlanOwnership(value)) context.addIssue({ code: 'custom', path: ['ownership'], message });
  if (value.templateId === 'complex_delivery_parallel' && !['engineer', 'frontend'].every(owner => value.ownership.some(item => item.owner === owner))) {
    context.addIssue({ code: 'custom', path: ['ownership'], message: '并行计划必须明确工程与前端的文件归属' });
  }
  if (value.templateId === 'batch' && !value.transformSpec) context.addIssue({ code: 'custom', path: ['transformSpec'], message: '批量计划必须包含变换规则' });
  if (value.templateId === 'diagnosis' && value.acceptanceCriteria.some(item => item.stage === 'review')) {
    context.addIssue({ code: 'custom', path: ['acceptanceCriteria'], message: '诊断模板没有独立审查阶段，不能安排审查阶段验收' });
  }
});
export type AgentTaskPlan = z.infer<typeof taskPlanSchema>;
export function canConfirmTeamPlan(plan: AgentTaskPlan) { return !plan.questions.some(item => item.blocking) && validatePlanOwnership(plan).length === 0; }

/** 兼容模型把顶层问题路由字段误写进 taskPlan.questions 的历史输出。 */
function normalizeTaskPlanQuestions(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const report = value as Record<string, unknown>;
  if (!report.taskPlan || typeof report.taskPlan !== 'object' || Array.isArray(report.taskPlan)) return value;
  const taskPlan = report.taskPlan as Record<string, unknown>;
  if (!Array.isArray(taskPlan.questions)) return value;

  const usedIds = new Set(taskPlan.questions.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' && id.trim() ? [id] : [];
  }));
  let nextId = 1;
  const questions = taskPlan.questions.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const normalized = { ...(item as Record<string, unknown>) };
    // `to` 只属于顶层 questions 的岗位路由；计划问题由宿主直接展示给用户。
    delete normalized.to;
    if (typeof normalized.id !== 'string' || !normalized.id.trim()) {
      while (usedIds.has(`Q-${nextId}`)) nextId += 1;
      const id = `Q-${nextId}`;
      normalized.id = id;
      usedIds.add(id);
      nextId += 1;
    }
    return normalized;
  });
  return { ...report, taskPlan: { ...taskPlan, questions } };
}

const sourcedStatement = z.object({ text: text(), source: text(1000) }).strict();
export const requirementBriefSchema = z.object({
  facts: z.array(sourcedStatement).max(100), inferences: z.array(sourcedStatement).max(100), gaps: z.array(sourcedStatement).max(100),
  acceptanceCriteria: z.array(planAcceptanceSchema).max(50), sources: z.array(text(1000)).max(100),
}).strict();
export type RequirementBrief = z.infer<typeof requirementBriefSchema>;
export const technicalDesignSchema = z.object({
  decisions: z.array(z.object({ id: text(40), decision: text(), reason: text(), source: text(1000) }).strict()).max(100),
  contracts: z.array(z.object({ name: text(200), description: text(8000), source: text(1000) }).strict()).max(100),
  tasks: z.array(z.object({ id: text(40), profileId: z.enum(['engineer', 'frontend', 'batch']), summary: text(),
    paths: z.array(teamRelativePathSchema).max(100), dependsOn: z.array(text(40)).max(100).default([]),
    acceptanceIds: z.array(text(40)).max(50).default([]) }).strict()).max(100),
  sharedFiles: z.array(sharedOwnershipSchema).max(100), risks: z.array(text()).max(50), rollback: z.array(text()).max(50),
}).strict();
export type TechnicalDesign = z.infer<typeof technicalDesignSchema>;
export const batchResultSchema = z.object({ changes: z.array(z.object({ path: teamRelativePathSchema, summary: text() }).strict()).max(10000),
  exceptions: z.array(z.object({ path: teamRelativePathSchema, reason: text() }).strict()).max(10000) }).strict();
export type BatchResult = z.infer<typeof batchResultSchema>;
const diagnosisEvidenceSchema = z.union([text(8000), z.object({
  acceptanceId: text(40).optional(), status: z.enum(['passed', 'failed', 'blocked', 'not_run', 'not_applicable']).optional(),
  finding: text(8000), command: text(8000).optional(), exitCode: z.number().int().nullable().optional(),
  output: z.string().max(16000).optional(), sources: z.array(text(1000)).max(100).optional(),
}).strict().transform(value => [
  value.acceptanceId === undefined ? '' : `验收项：${value.acceptanceId}`,
  value.status === undefined ? '' : `报告状态：${value.status}`,
  value.finding,
  value.command === undefined ? '' : `命令：${value.command}`,
  value.exitCode === undefined ? '' : `退出码：${value.exitCode}`,
  value.output === undefined ? '' : `输出：${value.output}`,
  value.sources?.length ? `来源：\n${value.sources.join('\n')}` : '',
].filter(Boolean).join('\n'))]);
const diagnosisBaselineSchema = z.object({ cwd: text(2000), head: text(200).optional(), headState: text(200).optional(),
  comparisonRef: text(1000).optional(), comparisonCommit: text(200).optional(), workingTree: text(8000).optional() }).strict();
/** 诊断证据兼容命令与输出对象，归一为原有文本列表；状态只保留为报告事实，不提升为验证通过。 */
export const diagnosisResultSchema = z.object({ summary: text(8000), rootCause: text(16000), evidence: z.array(diagnosisEvidenceSchema).min(1).max(100),
  baseline: diagnosisBaselineSchema.optional(), unverified: z.array(text()).max(100), suggestions: z.array(text(8000)).max(100) }).strict();
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;
export const deliveryDraftSchema = z.object({ draft: text(40000), evidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(200) }).strict();
export type TeamDeliveryDraft = z.infer<typeof deliveryDraftSchema>;
export const secondOpinionSchema = diagnosisResultSchema.omit({ rootCause: true });

export function readTaskPlan(result: string): AgentTaskPlan {
  const report = z.object({ version: z.literal(1), taskPlan: taskPlanSchema }).passthrough()
    .parse(normalizeTaskPlanQuestions(readDeliveryReport(result)));
  return report.taskPlan;
}

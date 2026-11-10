import { z } from 'zod';
import { teamProfileIds, teamRoleMetadata, type TeamProfileId, type TeamTask } from '../shared/agent-team.js';
import { taskPlanSchema, planAcceptanceSchema, planOwnershipSchema, sharedOwnershipSchema, teamRelativePathSchema,
  teamTemplateIds, type AgentTaskPlan } from '../shared/agent-task-plan.js';

/** Only explicit control phrases are handled without a model. These never grant permissions. */
export function teamChatControl(text: string): 'status' | 'pause' | 'resume' | undefined {
  const value = text.trim().replace(/[。！？!?\s]+$/g, '');
  // A question about the existing work is not a fresh implementation request.
  // Keep the whole utterance anchored so a subsequent action is not swallowed.
  const question = value.replace(/\s+/g, '');
  if (/^(?:你(?:们)?(?:到底|一直)?在(?:干什么|做什么|忙什么)|(?:怎么|为什么)(?:又|还在)(?:派任务|分配任务|启动任务|启动Agent))$/i.test(question)
    || /^(?:什么意思[，,。？?]*)?(?:不是[，,]*)?我(?:只是|只|就)(?:让|叫)你[^，,。？?！!]{1,120}[，,。？?！!]*你(?:们)?(?:到底|一直)?在(?:干什么|做什么)$/.test(question)) return 'status';
  if (/^(?:请)?(?:当前|现在|目前)?(?:进度(?:如何|怎么样|怎样|到哪了)?|任务状态|执行状态|做到哪(?:一步)?了|谁在(?:处理|做)|为什么卡住(?:了)?|卡在哪里|进展怎么样)$/.test(value)) return 'status';
  if (/^(?:请)?(?:暂停(?:执行|任务)?|先停(?:一下|下来)?)(?:[，,。\s].*)?$/.test(value)
    || /^(?:请)?先(?:别|不要|暂不)(?:改|写|实现|执行)/.test(value)) return 'pause';
  if (/^(?:请)?(?:继续(?:执行|原任务|实现)?|恢复执行|开始执行|现在(?:开始)?实现)(?:吧|啊|呀)?$/.test(value)) return 'resume';
  return undefined;
}

export const coordinationReplySchema = z.object({
  action: z.enum(['observe', 'steer', 'replan', 'repair_plan', 'ask', 'retry', 'pause', 'answer']),
  text: z.string().trim().min(1).max(12000),
  targetNodeId: z.string().uuid().optional(),
  questionId: z.string().min(1).max(150).optional(),
  questionTo: z.enum([...teamProfileIds, 'user']).optional(),
  taskPlan: taskPlanSchema.optional(),
}).strict().superRefine((value, context) => {
  if (['steer', 'retry', 'repair_plan'].includes(value.action) && !value.targetNodeId) {
    context.addIssue({ code: 'custom', path: ['targetNodeId'], message: '必须引用当前任务的目标节点' });
  }
  if (value.action === 'answer' && !value.questionId) context.addIssue({ code: 'custom', path: ['questionId'], message: '回答必须明确引用当前有效问题' });
  if (value.action !== 'ask' && value.questionTo !== undefined) context.addIssue({ code: 'custom', path: ['questionTo'], message: '只有提问动作可以指定问题接收方' });
  if (value.action === 'repair_plan' && !value.taskPlan) context.addIssue({ code: 'custom', path: ['taskPlan'], message: '修正计划必须提供完整合法的计划' });
  if (value.action !== 'repair_plan' && value.taskPlan) context.addIssue({ code: 'custom', path: ['taskPlan'], message: '只有修正计划动作可以携带计划' });
});

export const planRepairScopeError = '计划格式修复必须保留原验收要求、来源和阶段；仅可调整明确标注推断的额外审查项';

/** 来源是原计划的事实记录；恢复器只能还原同 ID 原文，其余差异仍须完整校验。 */
export function restorePlanRepairSources(originalPlan: unknown, repaired: AgentTaskPlan): AgentTaskPlan {
  const original = originalPlan && typeof originalPlan === 'object' && !Array.isArray(originalPlan)
    ? originalPlan as Record<string, unknown> : {};
  const criteria = (Array.isArray(original.acceptanceCriteria) ? original.acceptanceCriteria : [])
    .map(item => planAcceptanceSchema.safeParse(item)).flatMap(value => value.success ? [value.data] : []);
  if (new Set(criteria.map(item => item.id)).size !== criteria.length) throw new Error('原计划验收标识重复，不能恢复来源');
  const restored = taskPlanSchema.parse({ ...repaired, acceptanceCriteria: repaired.acceptanceCriteria.map(item => {
    const previous = criteria.find(value => value.id === item.id);
    return previous ? { ...item, source: previous.source } : { ...item };
  }) });
  assertPlanRepairScope(originalPlan, restored);
  return restored;
}

/** 修复报告格式不能删除已可识别的要求、待决问题或扩大原计划的执行范围。 */
export function assertPlanRepairScope(originalPlan: unknown, repaired: AgentTaskPlan) {
  if (!originalPlan || typeof originalPlan !== 'object' || Array.isArray(originalPlan)) throw new Error('原计划不是可核对的对象，不能自动修复');
  const original = originalPlan as Record<string, unknown>;
  if (teamTemplateIds.includes(original.templateId as AgentTaskPlan['templateId']) && original.templateId !== repaired.templateId
    && !(original.templateId === 'diagnosis' && repaired.templateId === 'verification')) {
    throw new Error('计划格式修复不能改变原执行模板；只读诊断需要独立复核时可改为只读验证');
  }
  const restrictions = {
    allowedPaths: z.array(teamRelativePathSchema).max(100),
    ownership: z.array(planOwnershipSchema).max(10),
    shared: z.array(sharedOwnershipSchema).max(100),
  };
  for (const key of ['allowedPaths', 'ownership', 'shared'] as const) {
    const value = restrictions[key].safeParse(original[key]);
    if (value.success && JSON.stringify(value.data) !== JSON.stringify(repaired[key])) throw new Error(`计划格式修复必须保留原${key}范围`);
  }
  const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const readable = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  for (const item of Array.isArray(original.questions) ? original.questions : []) {
    const question = record(item); if (!question || question.blocking !== true) continue;
    const id = readable(question.id), text = readable(question.text);
    if (!text || !repaired.questions.some(value => (!id || value.id === id) && value.text === text && value.blocking)) {
      throw new Error('计划格式修复不能删除或改写原待确认的阻断问题');
    }
  }
  for (const item of Array.isArray(original.acceptanceCriteria) ? original.acceptanceCriteria : []) {
    const criterion = record(item); if (!criterion) continue;
    const id = readable(criterion.id), text = readable(criterion.text), source = readable(criterion.source);
    const value = planAcceptanceSchema.safeParse({ id, text, source, ...(criterion.stage === undefined ? {} : { stage: criterion.stage }) });
    const inferredReview = value.success && value.data.stage === 'review' && value.data.source.startsWith('推断');
    const replacement = repaired.acceptanceCriteria.find(candidate => id ? candidate.id === id : candidate.text === text);
    if (inferredReview && !replacement) continue;
    if (!text) continue;
    if (!replacement || replacement.text !== text || (source && replacement.source !== source)
      || (value.success && !inferredReview && (replacement.stage || 'verify') !== (value.data.stage || 'verify'))) {
      throw new Error(planRepairScopeError);
    }
  }
}

/** Uses persisted workflow facts; it neither invokes an agent nor changes the plan. */
export function teamProgressReply(task: TeamTask) {
  const current = task.nodes.filter(node => node.round === task.round);
  const active = current.filter(node => ['running', 'queued'].includes(node.status));
  const failed = current.filter(node => ['blocked', 'needs_reconciliation'].includes(node.status));
  const lines = [`目标：${task.objective}`];
  if (task.chat?.coordination?.phase === 'stopping') lines.push('已请求暂停，仍在核对当前执行是否结束；后续步骤不会启动。');
  else if (task.chat?.paused) lines.push('后续执行已暂停。');
  if (active.length) lines.push(`当前：${active.map(node => `${teamRoleMetadata[node.profileId].label}${node.status === 'queued' ? '等待执行' : '正在处理'}`).join('；')}。`);
  else if (failed.length) lines.push(`待处理：${failed.map(node => `${teamRoleMetadata[node.profileId].label}：${node.error || node.reason || '需要核对'}`).join('；')}`);
  else if (task.reason) lines.push(`当前：${task.reason}`);
  else lines.push(`当前状态：${task.state}`);
  if (task.chat?.pendingInputs.length) lines.push(`已记录 ${task.chat.pendingInputs.length} 条补充；负责人将在安全点更新后续安排。`);
  const next = current.filter(node => node.status === 'pending');
  if (next.length) lines.push(`后续：${[...new Set(next.map(node => teamRoleMetadata[node.profileId].label))].join('、')}。`);
  return lines.join('\n');
}

export function coordinationInstructions(source: 'message' | 'recovery' | 'manual', questionTargets: readonly (TeamProfileId | 'user')[] = ['user']) {
  return [
    '你是持续负责原目标的协调者；按当前访问范围和用户任务授权完成必要核验、准备材料及保存产物。调度动作由宿主校验执行，不绕过权限、工作区互斥或直接创建运行。',
    '依据当前实际工具能力完成联网、命令和文件操作；确有能力缺口时安排适合的执行岗位，不要求用户代做团队能够完成的核验。',
    '协调安排围绕本次用户目标和已确认验收项，检查规模与改动风险相称；无新的改动、失败证据或未解决风险时，不追加无关全量检查、计划外门禁或重复同版本验证。范围外问题如实记录，不据此循环返工。',
    '只输出 {"version":1,"coordinationReply":{"action":"observe|steer|replan|repair_plan|ask|retry|pause|answer","targetNodeId":"仅steer/retry/repair_plan必填的当前任务节点ID","questionId":"仅answer必填的当前有效问题ID","text":"面向用户的简短说明或具体问题"}}。仅repair_plan须在coordinationReply内额外提供完整合法的taskPlan，其他动作不能携带taskPlan；不要创建额外权限。',
    'text 面向开发者，先用两到四句说清结果、具体问题和影响；需要详细解释时，再按原因、改动、验证、下一步分层展开，不把整篇答复限制为两到四句。保留理解与接手所需的技术细节，解释它们与结论的关系；不堆原始日志、长哈希和内部节点编号，不用“门禁、收据、候选一致、宿主采集”等内部说法代替具体事实。没有实际验证的部分要明确说明。',
    'observe：据真实状态回答，不改变计划。steer：只把这次用户原话送给当前仍活跃的实施岗位（stage=implement、status=running），适用于现有任务范围内的补充；宿主只在原运行支持实时输入时送达，否则在安全点重新安排。诊断、验证、已经结束的步骤或等待回复的节点不能使用steer；待答问题使用answer明确引用questionId，需要继续安排则使用replan。',
    `replan：需要改变范围或顺序时，宿主等当前执行安全结束后重新计划。ask：在 coordinationReply 内使用 questionTo 指定接收方，可选 ${questionTargets.join('|')}，text 填具体问题。团队可以补齐的材料先问对应岗位。只有授权、产品决定或团队无法自行获取的条件才问 user。岗位答复是材料，不能代替用户原话或授权。`,
    'repair_plan：仅当宿主明确提供可修复的计划报告时使用，并引用其目标节点。只根据原报告、原用户要求与校验错误修正计划格式，不重跑原命令、业务操作或外部写入，不删除真实用户的验收要求、待确认问题或授权约束。普通只读排查使用diagnosis，由工程岗位完成诊断，无需增加独立审查，也不能设置stage=review；若用户明确要求独立审查，改用支持该阶段的verification并保留要求，不能删除审查项或改成verify来绕过。修正后的taskPlan仍须通过宿主完整校验。',
    'pause：用户要求先停、暂不执行或收紧当前操作；宿主发送停止请求并核对真实结束，已有文件保留。',
    'answer：仅当本次用户原话确实回答了待回答问题中的某一项，引用其完整questionId。宿主只将用户原话交给这一题，不能改写、补造授权或把同一句话分配给全部问题。改方向、补充范围、咨询进度不是问题答案，应使用replan或observe；不能确定对应哪一题时用ask问清。',
    '本次原始补充可能早于聊天中的其他明确回复；按对话时间理解要求，后到的更正优先，不能把旧补充重新当作最新决定。',
    'retry：只可引用本次诊断指向的已结束失败节点，并说明是可重试的临时/结果格式问题。缺少授权、凭据、额度、需求、外部条件，原生状态不明或已有外部操作结果不明时只能ask，不能retry。重试不得执行超出原任务和原授权的行为。',
    source === 'message' ? '本轮处理执行中的用户补充。不能恢复失败节点；不要把普通咨询当作变更要求。'
      : '本轮诊断已有阻塞。按当前证据恢复可重试的失败，没有新进展的相同失败不能循环重派。需要补齐证据或决定时用 ask 问对应接收方。',
  ].join('\n\n');
}

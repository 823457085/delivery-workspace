/** 团队收尾仅归纳已登记的事实，不增加模型调用，也不代替人工验收。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TeamTask, TeamChatMessage, TeamNode } from '../shared/agent-team.js';
import { readAgentTaskReport, evaluateReview } from '../shared/agent-task-result.js';
import { deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatusLabels } from '../shared/delivery-acceptance.js';
import { readAgentDeliveryReport } from '../shared/delivery-report.js';

type DeliveryTask = TeamTask & { candidateEvidenceAt?: string };
function result(node: TeamNode | undefined) {
  try { return node?.result ? readAgentTaskReport(node.result) : undefined; } catch { return undefined; }
}
// Build is optional model evidence, not a replacement for tests or manual acceptance.
function buildEvidence(node: TeamNode | undefined) {
  try {
    const report = z.object({ validationEvidence: z.object({ build: z.object({
      status: z.enum(['pending', 'passed', 'failed', 'not_applicable']), evidence: z.string().trim().min(1).max(6000),
    }) }) }).safeParse(readAgentDeliveryReport(node?.result || ''));
    return report.success ? report.data.validationEvidence.build : undefined;
  } catch { return undefined; }
}

export function teamDeliveryMessage(task: DeliveryTask): TeamChatMessage | undefined {
  if (!task.chat || task.state !== 'completed' || !task.candidateEvidenceAt) return;
  const nodes = task.nodes.filter(node => node.round === task.round && node.status === 'completed');
  const implementations = nodes.filter(node => node.stage === 'implement');
  const verification = nodes.filter(node => node.stage === 'verify').at(-1);
  const diagnosis = nodes.find(node => node.stage === 'diagnose');
  const reviews = nodes.filter(node => node.stage === 'review');
  const verified = result(verification);
  const build = verified && !verified.evidenceError ? buildEvidence(verification) : undefined;
  const reviewed = reviews.length > 0 && reviews.every(node => node.result && evaluateReview(node.result, task.plan?.acceptanceCriteria).outcome === 'passed');
  if (!diagnosis && !reviewed) return;
  const summaries = [...new Set(implementations.map(node => result(node)?.taskResult.summary).filter((text): text is string => !!text))];
  if (!summaries.length && diagnosis && task.diagnosis?.summary) summaries.push(task.diagnosis.summary);
  if (!summaries.length && task.plan?.templateId === 'research_design') {
    summaries.push('调研与方案已完成独立审查。');
  }
  // 阶段汇报可能写着“等待独立审查”，收尾结论必须使用当前已确认的最终状态。
  if (!summaries.length && verified && reviewed) summaries.push(build?.status === 'passed'
    ? '构建检查已通过，独立审查已完成。' : '本轮验证与独立审查均已通过。');
  else if (!summaries.length && verified?.taskResult.summary) summaries.push(verified.taskResult.summary);
  const sections = [summaries.length ? summaries.join('\n\n') : '本轮结果已生成。'];
  sections.push(`成果位置：${task.workspacePath || task.sourceWorkspacePath}`);
  const checks: string[] = [];
  if (build) checks.push(`构建：${deliveryEvidenceStatusLabels[build.status]}。${build.evidence}`);
  if (verified) {
    const criteria = task.plan?.acceptanceCriteria || [];
    for (const criterion of criteria) {
      const reviewChecks = criterion.stage === 'review' ? reviews.flatMap(node => result(node)?.taskResult.acceptance.filter(item => item.id === criterion.id) || []) : [];
      const check = criterion.stage === 'review' && reviewed
        ? { status: 'passed' as const, evidence: [...new Set(reviewChecks.map(item => item.evidence))].join('；') }
        : verified.taskResult.acceptance.find(item => item.id === criterion.id);
      const label = check ? ({ passed: '通过', failed: '未通过', blocked: '受阻', not_run: '未执行', not_applicable: '不适用' } as const)[check.status] : '未验证';
      checks.push(`${criterion.text}：${label}${check?.evidence ? `。${check.evidence}` : ''}`);
    }
    if (verified.validationEvidence) {
      for (const kind of deliveryEvidenceKinds) {
        const evidence = verified.validationEvidence[kind];
        checks.push(`${deliveryEvidenceLabels[kind]}：${deliveryEvidenceStatusLabels[evidence.status]}${evidence.evidence ? `。${evidence.evidence}` : ''}${kind === 'remote' && evidence.sha ? `（${evidence.sha}）` : ''}`);
      }
    }
  }
  if (diagnosis) checks.push('本轮完成只读诊断，未据此认定修复或验证通过。');
  if (reviewed) checks.push(`独立审查：${reviews.length} 项通过。`);
  if (checks.length) sections.push(`验证情况：\n${checks.map(text => `- ${text}`).join('\n')}`);
  const remaining = diagnosis ? task.diagnosis?.unverified || [] : [];
  if (remaining.length) sections.push(`尚未核实：\n${remaining.map(text => `- ${text}`).join('\n')}`);
  // candidateEvidenceAt 可能在状态回读时刷新，不能用它作为消息去重键。
  const evidenceKey = createHash('sha256').update(JSON.stringify(nodes.filter(node => ['implement', 'verify', 'review', 'diagnose', 'analyst', 'architect'].includes(node.stage))
    .map(node => [node.id, node.attempt, node.runId, node.artifactHash]))).digest('hex').slice(0, 20);
  return { id: `delivery:${task.id}:${task.round}:${evidenceKey}`, role: 'assistant', profileId: 'leader', kind: 'delivery',
    text: sections.join('\n\n'), createdAt: task.candidateEvidenceAt };
}

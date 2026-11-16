/**
 * 本地独立审查结果到 TaskFlow `report_submit` 协议与可读 Markdown 评审报告的纯函数桥接器。
 * 严格遵循本地自报边界（source = LOCAL_TOOL），不虚构云端 AI 审批状态，也不自动触发外部写入。
 */
import { readAgentTaskReport, type AgentTaskFinding, type AgentTaskResult } from './agent-task-result.js';
import { formatInlineReviewChecklistMarkdown } from './diff-review-hygiene.js';

export type TaskFlowReportTool = 'codex' | 'codex-cli' | 'claude-code' | 'cursor' | 'custom';
export type TaskFlowReportSeverity = 'CRITICAL' | 'WARN' | 'INFO';

export interface TaskFlowReportFinding {
  severity: TaskFlowReportSeverity;
  title: string;
  detail: string;
  location?: string;
}

export interface TaskFlowReviewReportPayload {
  source: 'LOCAL_TOOL';
  tool: TaskFlowReportTool;
  summary: string;
  findings: TaskFlowReportFinding[];
  evidence?: string;
}

export interface TaskFlowReportSubmitInput {
  jobId: string;
  report: TaskFlowReviewReportPayload;
}

export interface BuildReviewReportBridgeInput {
  result: string | AgentTaskResult;
  provider?: string;
  model?: string;
  objective?: string;
  round?: number;
  snapshotValue?: string;
  verificationSummary?: string;
}

const severityMap: Record<AgentTaskFinding['severity'], TaskFlowReportSeverity> = {
  blocker: 'CRITICAL',
  major: 'WARN',
  minor: 'INFO',
};

const severityOrder: Record<TaskFlowReportSeverity, number> = {
  CRITICAL: 0,
  WARN: 1,
  INFO: 2,
};

const verdictLabels: Record<NonNullable<AgentTaskResult['verdict']>, string> = {
  approved: '审查通过',
  changes_requested: '退回修改',
  blocked: '审查受阻',
};

function clip(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  if (maxLength <= 3) return trimmed.slice(0, maxLength);
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

export function mapProviderToTaskFlowTool(provider?: string): TaskFlowReportTool {
  const normalized = (provider || '').trim().toLowerCase();
  if (normalized === 'codex') return 'codex-cli';
  if (normalized === 'claude') return 'claude-code';
  if (normalized === 'cursor') return 'cursor';
  return 'custom';
}

function resolveTaskResult(result: string | AgentTaskResult): AgentTaskResult {
  if (typeof result !== 'string') return result;
  return readAgentTaskReport(result).taskResult;
}

function buildFindingTitle(finding: AgentTaskFinding): string {
  const firstLine = (finding.problem || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[。；;\n]/)[0]
    ?.trim() || '审查发现问题';
  const raw = `[${finding.id}] ${firstLine}`;
  return clip(raw, 200) || `[${clip(finding.id || 'F', 32)}] 审查发现问题`;
}

function buildFindingDetail(finding: AgentTaskFinding): string {
  const parts = [
    finding.problem?.trim() ? `问题与证据：${finding.problem.trim()}` : '',
    finding.expectation?.trim() ? `修改期望：${finding.expectation.trim()}` : '',
  ].filter(Boolean);
  return clip(parts.join('\n') || '详见对应源码位置与审查记录。', 4000);
}

function buildFindingLocation(finding: AgentTaskFinding): string | undefined {
  const file = (finding.file || '').trim();
  if (!file) return undefined;
  const raw = finding.line && finding.line > 0 ? `${file}:${finding.line}` : file;
  return clip(raw, 500);
}

export function buildTaskFlowReviewReport(input: BuildReviewReportBridgeInput): TaskFlowReviewReportPayload {
  const taskResult = resolveTaskResult(input.result);
  const sortedFindings = [...(taskResult.findings || [])]
    .map(finding => {
      const severity = severityMap[finding.severity] || 'WARN';
      const location = buildFindingLocation(finding);
      return {
        severity,
        title: buildFindingTitle(finding),
        detail: buildFindingDetail(finding),
        ...(location ? { location } : {}),
      } satisfies TaskFlowReportFinding;
    })
    .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity])
    .slice(0, 50);

  const criticalCount = sortedFindings.filter(item => item.severity === 'CRITICAL').length;
  const warnCount = sortedFindings.filter(item => item.severity === 'WARN').length;
  const infoCount = sortedFindings.filter(item => item.severity === 'INFO').length;
  const verdictLabel = taskResult.verdict ? verdictLabels[taskResult.verdict] : `状态 ${taskResult.status}`;
  const roundLabel = typeof input.round === 'number' ? `（第 ${input.round} 轮）` : '';

  const summaryHeader = `本地工作台独立审查${roundLabel}结论：${verdictLabel}；共记录 ${sortedFindings.length} 项发现（CRITICAL ${criticalCount} / WARN ${warnCount} / INFO ${infoCount}）。`;
  const summaryBody = [
    summaryHeader,
    taskResult.summary?.trim() || '',
    taskResult.blockers?.filter(Boolean).length ? `阻塞说明：${taskResult.blockers.filter(Boolean).join('；')}` : '',
  ].filter(Boolean).join('\n');

  const evidenceLines: string[] = [];
  if (input.provider || input.model) {
    evidenceLines.push(`本地审查执行器：${[input.provider, input.model].filter(Boolean).join(' · ')}（本地成员自报，非云端 AI 审批）`);
  }
  if (input.snapshotValue) {
    evidenceLines.push(`候选快照标识：${input.snapshotValue}`);
  }
  if (input.objective?.trim()) {
    evidenceLines.push(`关联目标：${clip(input.objective.replace(/\s+/g, ' '), 300)}`);
  }
  if (input.verificationSummary?.trim()) {
    evidenceLines.push(`前置验证摘要：${clip(input.verificationSummary, 1500)}`);
  }
  for (const item of (taskResult.acceptance || []).slice(0, 20)) {
    if (item.evidence?.trim()) {
      evidenceLines.push(`验收项 ${item.id}（${item.status}）：${clip(item.evidence, 300)}`);
    }
  }
  for (const check of (taskResult.selfTests || []).slice(0, 15)) {
    if (check.command?.trim()) {
      evidenceLines.push(`核验命令：${check.command.trim()}（exitCode=${check.exitCode ?? 'null'}）`);
    }
  }
  const evidence = clip(evidenceLines.join('\n'), 8000);

  return {
    source: 'LOCAL_TOOL',
    tool: mapProviderToTaskFlowTool(input.provider),
    summary: clip(summaryBody, 8000) || summaryHeader,
    findings: sortedFindings,
    ...(evidence ? { evidence } : {}),
  };
}

export function buildTaskFlowReportSubmitEnvelope(
  jobId: string,
  input: BuildReviewReportBridgeInput,
): TaskFlowReportSubmitInput {
  const normalizedJobId = jobId.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(normalizedJobId)) {
    throw new Error('TaskFlow jobId 格式无效（须为 1-80 位字母、数字、下划线或短横线）');
  }
  return {
    jobId: normalizedJobId,
    report: buildTaskFlowReviewReport(input),
  };
}

export function formatReviewReportMarkdown(input: BuildReviewReportBridgeInput): string {
  const taskResult = resolveTaskResult(input.result);
  const verdictLabel = taskResult.verdict ? verdictLabels[taskResult.verdict] : taskResult.status;
  const lines: string[] = [
    `### 独立代码审查报告（${verdictLabel}）`,
  ];

  const meta: string[] = [];
  if (typeof input.round === 'number') meta.push(`轮次：第 ${input.round} 轮`);
  if (input.provider || input.model) meta.push(`审查模型：\`${[input.provider, input.model].filter(Boolean).join(' · ')}\``);
  if (input.snapshotValue) meta.push(`代码快照：\`${input.snapshotValue.slice(0, 12)}\``);
  if (meta.length) lines.push(`- ${meta.join(' ｜ ')}`);

  if (taskResult.summary?.trim()) {
    lines.push('', taskResult.summary.trim());
  }

  if (taskResult.blockers?.filter(Boolean).length) {
    lines.push('', '#### 阻塞项');
    for (const blocker of taskResult.blockers.filter(Boolean)) {
      lines.push(`- ${blocker}`);
    }
  }

  if (taskResult.findings?.length) {
    lines.push('', `#### 审查发现（${taskResult.findings.length}）`);
    for (const finding of taskResult.findings) {
      const loc = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ''}\`` : '';
      lines.push(`- **[${finding.severity.toUpperCase()} · ${finding.id}]**${loc}：${finding.problem}`);
      if (finding.expectation?.trim()) {
        lines.push(`  - 期望修改：${finding.expectation.trim()}`);
      }
    }
  } else {
    lines.push('', '- 未发现需退回的代码问题。');
  }

  return `${lines.join('\n')}\n`;
}

export function formatReviewChecklistFromResult(input: BuildReviewReportBridgeInput & { patch?: string }): string {
  const taskResult = resolveTaskResult(input.result);
  return formatInlineReviewChecklistMarkdown({
    findings: taskResult.findings || [],
    patch: input.patch,
    objective: input.objective,
    round: input.round,
    snapshotValue: input.snapshotValue,
  });
}

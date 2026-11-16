/**
 * 跨执行器交接包与会话上下文蒸馏引擎（纯函数，无 Node I/O 依赖，前后端通用）。
 *
 * 设计借鉴自 GitHub 开源项目：
 * - Moonfold / relayhistory / ai-hist：跨 CLI Agent（Codex / Claude Code / Cursor / Antigravity）切换时的结构化交接简报与凭据自动脱敏
 * - thedotmack/claude-mem：渐进式会话里程碑压缩、累计文件账本与未决错误蒸馏（避免跨 Agent 接力时从零盲猜或泄露早期隐私上下文）
 */
import { agentProviderLabels, type AgentChangedFile, type AgentProvider, type AgentRunEvent, type AgentRunStatus } from './agent-runtime.js';
import { distillVerificationOutput } from './verification-log-distiller.js';

export interface HandoffTurnInput {
  id: string;
  provider: AgentProvider;
  model?: string;
  status: AgentRunStatus | 'history';
  objective: string;
  supplements?: { objective: string; createdAt?: string }[];
  result?: string;
  error?: string;
  events?: Pick<AgentRunEvent, 'type' | 'message'>[];
  changedFiles?: AgentChangedFile[];
  revisesRunId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CrossAgentHandoffInput {
  conversationTitle?: string;
  workspacePath?: string;
  branch?: string;
  targetProvider?: AgentProvider;
  reason?: string;
  turns: HandoffTurnInput[];
  /** 仅从最近 N 轮提取原话与回复摘要，严格遵守早期轮次隐私隔离窗口（默认 6）。 */
  maxTextWindowTurns?: number;
  /** 提示词交接简报最大字符预算（默认 2400）。 */
  maxPromptChars?: number;
}

export interface HandoffChangedFileSummary {
  path: string;
  latestStatus: AgentChangedFile['status'];
  touchCount: number;
  lastTouchedByProvider: AgentProvider;
}

export interface HandoffMilestoneItem {
  round: number;
  providerLabel: string;
  status: AgentRunStatus | 'history';
  objectiveDigest: string;
  outcomeDigest: string;
}

export interface CrossAgentHandoffPacket {
  title: string;
  workspacePath: string;
  branch: string;
  reason: string;
  sourceProviders: AgentProvider[];
  targetProvider?: AgentProvider;
  totalTurns: number;
  windowTurnCount: number;
  latestGoal: string;
  completedMilestones: HandoffMilestoneItem[];
  cumulativeChangedFiles: HandoffChangedFileSummary[];
  unresolvedBlockers: string[];
  distilledFailureSnippet: string;
  nextStepHints: string[];
}

const pemKeyPattern = new RegExp(
  '-----BEGIN ' + '(?:[A-Z0-9]+ )*' + 'PRIVATE KEY-----[\\s\\S]*?-----END ' + '(?:[A-Z0-9]+ )*' + 'PRIVATE KEY-----',
  'g',
);
const skTokenPattern = new RegExp('\\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\\b', 'g');
const ghTokenPattern = new RegExp('\\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\\b', 'g');
const jwtTokenPattern = new RegExp('\\beyJ[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}\\b', 'g');
const bearerPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const urlCredentialsPattern = /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const kvSecretPattern = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|x-yunxiao-token)\s*[:=]\s*['"]?)([^'"\s,;]{8,})(['"]?)/gi;

/**
 * 对跨执行器交接或导出的文本做确定性敏感凭据脱敏，防止 API Key / Token / 私钥在切换模型或剪贴板分享时外泄。
 */
export function redactSensitiveHandoffText(input: string): string {
  if (!input) return '';
  return input
    .replace(pemKeyPattern, '[REDACTED_PRIVATE_KEY]')
    .replace(skTokenPattern, '[REDACTED_API_KEY]')
    .replace(ghTokenPattern, '[REDACTED_GITHUB_TOKEN]')
    .replace(jwtTokenPattern, '[REDACTED_JWT]')
    .replace(bearerPattern, '$1[REDACTED_TOKEN]')
    .replace(urlCredentialsPattern, '$1[REDACTED_USER]:[REDACTED_SECRET]@')
    .replace(kvSecretPattern, '$1[REDACTED_SECRET]$3');
}

function compactSingleLine(input: string, maxChars: number): string {
  const cleaned = redactSensitiveHandoffText(input)
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(16, maxChars - 1))}…`;
}

function providerShortLabel(provider: AgentProvider): string {
  return (agentProviderLabels[provider] || provider).replace(/\s*CLI$/i, '');
}

function isTestLikePath(filePath: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec)\//i.test(filePath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function isSourceLikePath(filePath: string): boolean {
  if (isTestLikePath(filePath)) return false;
  return /\.(?:[cm]?[jt]sx?|vue|py|go|rs|java|kt|swift|rb|php|cs)$/i.test(filePath);
}

/**
 * 从会话轮次链构建跨 Agent 交接数据包。
 */
export function buildCrossAgentHandoffPacket(input: CrossAgentHandoffInput): CrossAgentHandoffPacket {
  const maxTextWindowTurns = Math.max(1, Math.min(12, input.maxTextWindowTurns ?? 6));
  const supersededIds = new Set(
    input.turns
      .map(turn => turn.revisesRunId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const activeTurns = input.turns.filter(turn => !supersededIds.has(turn.id));

  // 1. 统计全会话净改动文件账本（仅包含文件路径与变更状态，不携带早期原话）
  const fileMap = new Map<string, HandoffChangedFileSummary>();
  const providerSet = new Set<AgentProvider>();
  for (const turn of activeTurns) {
    providerSet.add(turn.provider);
    for (const file of turn.changedFiles || []) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
      if (!normalized || normalized === '.delivery-artifacts' || normalized.startsWith('.delivery-artifacts/')) continue;
      const existing = fileMap.get(normalized);
      fileMap.set(normalized, {
        path: normalized,
        latestStatus: file.status,
        touchCount: (existing?.touchCount || 0) + 1,
        lastTouchedByProvider: turn.provider,
      });
    }
  }
  const cumulativeChangedFiles = [...fileMap.values()].sort(
    (left, right) => right.touchCount - left.touchCount || left.path.localeCompare(right.path),
  );

  // 2. 严格在最近 N 轮窗口内提取目标、里程碑与失败阻塞诊断
  const startOffset = Math.max(0, activeTurns.length - maxTextWindowTurns);
  const windowTurns = activeTurns.slice(startOffset);

  const completedMilestones: HandoffMilestoneItem[] = [];
  const unresolvedBlockers: string[] = [];
  let distilledFailureSnippet = '';

  windowTurns.forEach((turn, idx) => {
    const roundNumber = startOffset + idx + 1;
    const combinedObjective = [
      turn.objective,
      ...(turn.supplements || []).map(item => item.objective),
    ].filter(Boolean).join('；');
    const objectiveDigest = compactSingleLine(combinedObjective, 140);
    const outcomeSource = turn.result || turn.error || '';
    const outcomeDigest = compactSingleLine(outcomeSource, 180);

    if (turn.status === 'completed' || turn.status === 'history') {
      if (objectiveDigest || outcomeDigest) {
        completedMilestones.push({
          round: roundNumber,
          providerLabel: providerShortLabel(turn.provider),
          status: turn.status,
          objectiveDigest: objectiveDigest || '（无文本指令）',
          outcomeDigest: outcomeDigest || '已完成执行',
        });
      }
    } else if (['failed', 'interrupted', 'cancelled'].includes(turn.status)) {
      const blockerText = compactSingleLine(
        turn.error || turn.result || `第 ${roundNumber} 轮（${providerShortLabel(turn.provider)}）状态为 ${turn.status}`,
        200,
      );
      if (blockerText) {
        unresolvedBlockers.push(`第 ${roundNumber} 轮 [${providerShortLabel(turn.provider)} · ${turn.status}]：${blockerText}`);
      }
    }
  });

  // 若最近一轮处于失败或中断状态，用验证日志蒸馏器提取核心报错行
  const lastTurn = windowTurns.at(-1);
  if (lastTurn && ['failed', 'interrupted'].includes(lastTurn.status)) {
    const rawFailureLog = [
      lastTurn.error || '',
      ...(lastTurn.events || [])
        .filter(ev => ev.type === 'diagnostic' || ev.type === 'tool' || ev.type === 'lifecycle')
        .slice(-8)
        .map(ev => ev.message),
      lastTurn.result || '',
    ].filter(Boolean).join('\n');
    const sanitizedFailureLog = redactSensitiveHandoffText(rawFailureLog);
    if (sanitizedFailureLog.trim()) {
      const distilled = distillVerificationOutput(sanitizedFailureLog, {
        changedFiles: cumulativeChangedFiles.map(item => item.path),
        maxDiagnostics: 6,
      });
      distilledFailureSnippet = redactSensitiveHandoffText(distilled.compactSummary || '').slice(0, 900).trim();
    }
  }

  const latestObjectiveSource = lastTurn
    ? [lastTurn.objective, ...(lastTurn.supplements || []).map(item => item.objective)].filter(Boolean).join('；')
    : '';
  const latestGoal = compactSingleLine(latestObjectiveSource, 220);

  // 3. 生成确定性接力建议
  const nextStepHints: string[] = [];
  if (cumulativeChangedFiles.length > 0) {
    nextStepHints.push(`先核对已改动的 ${cumulativeChangedFiles.length} 个工作区文件当前内容，避免重复修改或覆盖前序执行器成果。`);
  }
  if (distilledFailureSnippet || unresolvedBlockers.length > 0) {
    nextStepHints.push('优先针对最近未决报错定位根因并最小化修复，修复后运行针对性验证命令确认收敛。');
  }
  const touchedSources = cumulativeChangedFiles.filter(item => item.latestStatus !== 'deleted' && isSourceLikePath(item.path));
  const touchedTests = cumulativeChangedFiles.filter(item => item.latestStatus !== 'deleted' && isTestLikePath(item.path));
  if (touchedSources.length > 0 && touchedTests.length === 0) {
    nextStepHints.push(`当前已改动 ${touchedSources.length} 个源码文件但尚无测试文件更新，完成实现后建议补齐对应单元/回归测试。`);
  }
  if (!nextStepHints.length) {
    nextStepHints.push('沿用当前工作区真实文件状态继续推进，按需小步验证。');
  }

  return {
    title: compactSingleLine(input.conversationTitle || latestGoal || '未命名会话', 120),
    workspacePath: input.workspacePath || '',
    branch: input.branch || '',
    reason: input.reason || '跨执行器交接',
    sourceProviders: [...providerSet],
    ...(input.targetProvider ? { targetProvider: input.targetProvider } : {}),
    totalTurns: activeTurns.length,
    windowTurnCount: windowTurns.length,
    latestGoal,
    completedMilestones,
    cumulativeChangedFiles,
    unresolvedBlockers,
    distilledFailureSnippet,
    nextStepHints,
  };
}

/**
 * 格式化为注入 `providerSwitchContext` 的紧凑结构化交接摘要。
 */
export function formatHandoffPacketForPrompt(packet: CrossAgentHandoffPacket, maxChars = 2200): string {
  const sections: string[] = [];
  const headerParts = [
    `【结构化交接简报 · ${packet.reason}】`,
    packet.branch ? `当前分支: ${packet.branch}` : '',
    packet.sourceProviders.length
      ? `历史执行器: ${packet.sourceProviders.map(providerShortLabel).join(' → ')}${packet.targetProvider ? ` ⇒ 当前接手: ${providerShortLabel(packet.targetProvider)}` : ''}`
      : '',
  ].filter(Boolean);
  sections.push(headerParts.join(' | '));

  if (packet.cumulativeChangedFiles.length > 0) {
    const fileLines = packet.cumulativeChangedFiles.slice(0, 18).map(
      item => `- [${item.latestStatus}] ${item.path}${item.touchCount > 1 ? ` (${item.touchCount}轮触及)` : ''}`,
    );
    if (packet.cumulativeChangedFiles.length > 18) {
      fileLines.push(`- …其余 ${packet.cumulativeChangedFiles.length - 18} 个文件已省略`);
    }
    sections.push(`累计已改动文件（共 ${packet.cumulativeChangedFiles.length} 个，接手前请先核实最新文件内容）：\n${fileLines.join('\n')}`);
  }

  if (packet.unresolvedBlockers.length > 0) {
    sections.push(`待解决阻塞项：\n${packet.unresolvedBlockers.slice(-3).map(item => `- ${item}`).join('\n')}`);
  }

  if (packet.distilledFailureSnippet) {
    sections.push(`最近失败诊断精炼：\n${packet.distilledFailureSnippet.slice(0, 750)}`);
  }

  if (packet.completedMilestones.length > 0) {
    const milestoneLines = packet.completedMilestones.slice(-4).map(
      item => `- 第 ${item.round} 轮 (${item.providerLabel})：${item.objectiveDigest} -> ${item.outcomeDigest}`,
    );
    sections.push(`近期已完成里程碑：\n${milestoneLines.join('\n')}`);
  }

  const combined = sections.join('\n');
  return combined.length <= maxChars ? combined : `${combined.slice(0, Math.max(200, maxChars - 12))}\n…(交接摘要已截断)`;
}

/**
 * 格式化为可供用户一键复制或导出的跨 Agent 交接 Markdown 文档（支持粘贴至任意外部 CLI / IDE / 协作成员）。
 */
export function formatHandoffPacketMarkdown(packet: CrossAgentHandoffPacket): string {
  const statusLabelMap: Record<AgentChangedFile['status'], string> = {
    added: '新增',
    modified: '修改',
    deleted: '删除',
    renamed: '重命名',
    generated: '生成产物',
  };
  const lines: string[] = [
    `# 跨 Agent 交接简报 · ${packet.title}`,
    '',
    `- **交接场景**：${packet.reason}`,
    ...(packet.workspacePath ? [`- **工作区路径**：\`${packet.workspacePath}\``] : []),
    ...(packet.branch ? [`- **当前分支**：\`${packet.branch}\``] : []),
    `- **参与执行器**：${packet.sourceProviders.length ? packet.sourceProviders.map(providerShortLabel).join(' → ') : '未记录'}${packet.targetProvider ? ` ⇒ **接手方**：${providerShortLabel(packet.targetProvider)}` : ''}`,
    `- **有效轮次**：共 ${packet.totalTurns} 轮（摘要覆盖最近 ${packet.windowTurnCount} 轮，敏感凭据已自动脱敏）`,
    '',
  ];

  if (packet.latestGoal) {
    lines.push('## 1. 当前核心诉求', '', packet.latestGoal, '');
  }

  lines.push('## 2. 近期推进里程碑', '');
  if (packet.completedMilestones.length > 0) {
    for (const item of packet.completedMilestones) {
      lines.push(`- **第 ${item.round} 轮（${item.providerLabel}）**：${item.objectiveDigest}`);
      lines.push(`  - 结果：${item.outcomeDigest}`);
    }
    lines.push('');
  } else {
    lines.push('- 暂无已完成的轮次记录。', '');
  }

  lines.push(`## 3. 累计改动文件账本（${packet.cumulativeChangedFiles.length}）`, '');
  if (packet.cumulativeChangedFiles.length > 0) {
    for (const file of packet.cumulativeChangedFiles.slice(0, 40)) {
      lines.push(`- \`${file.path}\` — ${statusLabelMap[file.latestStatus] || file.latestStatus}（最近由 ${providerShortLabel(file.lastTouchedByProvider)} 改动${file.touchCount > 1 ? `，累计 ${file.touchCount} 次` : ''}）`);
    }
    if (packet.cumulativeChangedFiles.length > 40) {
      lines.push(`- …其余 ${packet.cumulativeChangedFiles.length - 40} 个文件已折叠`);
    }
    lines.push('');
  } else {
    lines.push('- 当前会话尚未记录到工作区文件修改。', '');
  }

  if (packet.unresolvedBlockers.length > 0 || packet.distilledFailureSnippet) {
    lines.push('## 4. 待解决阻塞与错误诊断', '');
    for (const blocker of packet.unresolvedBlockers) {
      lines.push(`- ${blocker}`);
    }
    if (packet.distilledFailureSnippet) {
      lines.push('', '```text', packet.distilledFailureSnippet, '```');
    }
    lines.push('');
  }

  lines.push('## 5. 接手执行建议', '');
  for (const hint of packet.nextStepHints) {
    lines.push(`- ${hint}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Composer Preflight Guard & Context Budget Meter
 *
 * 借鉴 Zed Agent Panel (zed-industries/zed) 上下文预算与 80%/100% 压缩预警、
 * Cursor Composer 发送前安全护栏与 Gitleaks (gitleaks/gitleaks) 凭据模式识别：
 * - 在本地零延迟检测输入框草稿中误粘贴的 API Key、私钥、JWT 与带密码的连接串，支持一键原地脱敏；
 * - 在可写 Agent 模式下识别高爆炸半径指令（如 `rm -rf`、`git reset --hard`、`git push --force`、`DROP TABLE`），
 *   给出先建 Git Stash 快照或切换只读 Plan 模式的防御提醒；
 * - 结合真实 CLI 上报的 `inputTokens` 与多语种字符估算当前会话上下文负载，提前预防长会话注意力退化。
 */

import type { AgentAccessMode, AgentRun, AgentRunMode } from './agent-runtime.js';
import { summarizeRunTelemetry } from './agent-session-telemetry.js';

export type PreflightIssueKind = 'secret_leak' | 'destructive_command';
export type PreflightSeverity = 'high' | 'medium';

export interface ComposerPreflightIssue {
  kind: PreflightIssueKind;
  severity: PreflightSeverity;
  code: string;
  label: string;
  advice: string;
  matchCount: number;
}

export interface ComposerPreflightReport {
  hasSecrets: boolean;
  hasDestructiveCommands: boolean;
  issues: ComposerPreflightIssue[];
}

export type ContextLoadLevel = 'fresh' | 'moderate' | 'heavy' | 'compaction_needed';

export interface ConversationContextMeter {
  estimatedTokens: number;
  budgetTokens: number;
  usageRatio: number;
  usagePercent: number;
  turnCount: number;
  level: ContextLoadLevel;
  usedNativeTelemetry: boolean;
  advice: string;
}

interface SecretPatternRule {
  code: string;
  label: string;
  regex: RegExp;
  replacement: string;
}

const SECRET_RULES: SecretPatternRule[] = [
  {
    code: 'pem-private-key',
    label: 'PEM 私钥块',
    regex: /-{5}BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-{5}[\s\S]*?-{5}END (?:[A-Z0-9]+ )?PRIVATE KEY-{5}/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    code: 'openai-or-vendor-sk',
    label: 'API Secret Key (sk-*)',
    regex: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{24,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    code: 'github-gitlab-token',
    label: 'Git 平台访问令牌',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{28,}|github_pat_[A-Za-z0-9_]{28,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replacement: '[REDACTED_GIT_TOKEN]',
  },
  {
    code: 'aws-access-key',
    label: '云访问密钥 (AKIA*)',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_CLOUD_KEY]',
  },
  {
    code: 'jwt-token',
    label: 'JWT 鉴权令牌',
    regex: /\beyJ[A-Za-z0-9_-]{14,}\.[A-Za-z0-9_-]{14,}\.[A-Za-z0-9_-]{14,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    code: 'credential-url',
    label: '含明文密码的连接地址',
    regex: /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:)(?!\[REDACTED_)([^@\s/]+)(@[^\s]+)/gi,
    replacement: '$1[REDACTED_PASSWORD]$3',
  },
];

interface DestructiveRule {
  code: string;
  label: string;
  advice: string;
  regex: RegExp;
}

const DESTRUCTIVE_RULES: DestructiveRule[] = [
  {
    code: 'rm-rf',
    label: '递归强制删除指令 (rm -rf)',
    advice: '建议明确限定相对子目录，或先在 Git 抽屉创建 Stash 快照后再执行。',
    regex: /(?:^|[\s;|&`])rm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/g,
  },
  {
    code: 'git-destructive',
    label: '不可逆 Git 重置/强推 (reset --hard / push --force / clean -fd)',
    advice: '强推或硬重置可能丢失未备份提交，建议先用 Git 贮藏栈备份工作区。',
    regex: /\bgit\s+(?:reset\s+--hard|push\s+(?:--force(?!-with-lease)|-f\b)|clean\s+-[a-zA-Z]*f)/g,
  },
  {
    code: 'sql-drop-truncate',
    label: '高危数据库表清理 (DROP / TRUNCATE TABLE)',
    advice: '请确认仅针对本地测试库，或先切换至只读 Plan 模式评估迁移脚本。',
    regex: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/gi,
  },
];

/**
 * 扫描当前输入框草稿中的明文敏感凭据与高破坏性操作指令。
 */
export function scanPromptPreflight(
  draft: string,
  options: { mode?: AgentRunMode; accessMode?: AgentAccessMode } = {},
): ComposerPreflightReport {
  if (!draft || !draft.trim()) {
    return { hasSecrets: false, hasDestructiveCommands: false, issues: [] };
  }

  const issues: ComposerPreflightIssue[] = [];
  let hasSecrets = false;
  let hasDestructiveCommands = false;

  for (const rule of SECRET_RULES) {
    const matches = draft.match(rule.regex);
    if (matches && matches.length > 0) {
      hasSecrets = true;
      issues.push({
        kind: 'secret_leak',
        severity: 'high',
        code: rule.code,
        label: rule.label,
        advice: '发送前建议点击「一键脱敏草稿」，避免明文密钥进入模型上下文或会话记录。',
        matchCount: matches.length,
      });
    }
  }

  const writableMode = !options.mode || options.mode === 'agent';
  if (writableMode) {
    for (const rule of DESTRUCTIVE_RULES) {
      const matches = draft.match(rule.regex);
      if (matches && matches.length > 0) {
        hasDestructiveCommands = true;
        issues.push({
          kind: 'destructive_command',
          severity: options.accessMode === 'full' ? 'high' : 'medium',
          code: rule.code,
          label: rule.label,
          advice: rule.advice,
          matchCount: matches.length,
        });
      }
    }
  }

  return {
    hasSecrets,
    hasDestructiveCommands,
    issues,
  };
}

/**
 * 将草稿中的私钥、API Key、JWT 与连接串密码原地替换为安全占位符，保留周边代码与指令结构。
 */
export function redactPromptSecrets(draft: string): string {
  if (!draft) return '';
  let next = draft;
  for (const rule of SECRET_RULES) {
    next = next.replace(rule.regex, rule.replacement);
  }
  return next;
}

/**
 * 多语种轻量 Token 估算：中日韩字符约 0.65 tok/字，ASCII 代码与英文约 0.28 tok/字符。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3000 && code <= 0x303f)
      || (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.ceil(cjkCount * 0.65 + otherCount * 0.28);
}

export type ContextMeterRunInput = Pick<AgentRun, 'id' | 'status' | 'objective'>
  & Partial<Pick<AgentRun, 'provider' | 'model' | 'createdAt' | 'updatedAt' | 'usage' | 'events' | 'changedFiles' | 'result' | 'error' | 'revisesRunId' | 'supplements'>>;

/**
 * 评估当前会话的有效上下文水位（默认以 120k tokens 为高质量代码专注窗口基准）。
 */
export function estimateConversationContextMeter(
  runs: readonly ContextMeterRunInput[],
  draft = '',
  recommendedBudgetTokens = 120_000,
): ConversationContextMeter {
  const budgetTokens = Math.max(16_000, recommendedBudgetTokens);
  const supersededIds = new Set<string>();
  for (const run of runs) {
    if (run.revisesRunId) supersededIds.add(run.revisesRunId);
  }
  const activeRuns = runs.filter(run => !supersededIds.has(run.id));
  const draftTokens = estimateTextTokens(draft);

  // 优先检查最近一轮已完成的原生 CLI Telemetry 是否上报了真实上下文 inputTokens
  let latestReportedContextTokens = 0;
  for (let idx = activeRuns.length - 1; idx >= 0; idx--) {
    const candidate = activeRuns[idx]!;
    const telemetry = summarizeRunTelemetry({
      id: candidate.id,
      provider: candidate.provider || 'codex',
      model: candidate.model || '',
      status: candidate.status,
      createdAt: candidate.createdAt || '',
      updatedAt: candidate.updatedAt || '',
      usage: candidate.usage,
      events: candidate.events || [],
      changedFiles: candidate.changedFiles,
    });
    if (telemetry.usageKnown && typeof telemetry.inputTokens === 'number' && telemetry.inputTokens > 0) {
      // 若单轮包含多步工具循环，inputTokens 是累计值；结合 totalActions 折算单步近似窗口规模
      const actionCount = telemetry.tools.totalActions;
      const stepDivisor = Math.max(1, actionCount > 1 ? Math.min(actionCount, 6) : 1);
      latestReportedContextTokens = Math.round(telemetry.inputTokens / stepDivisor) + (telemetry.outputTokens ?? 0);
      break;
    }
  }

  let charEstimatedHistory = 0;
  for (const run of activeRuns) {
    charEstimatedHistory += estimateTextTokens(run.objective || '');
    for (const sup of run.supplements || []) {
      charEstimatedHistory += estimateTextTokens(sup.objective || '');
    }
    charEstimatedHistory += estimateTextTokens(run.result || run.error || '');
  }

  const usedNativeTelemetry = latestReportedContextTokens > charEstimatedHistory && latestReportedContextTokens <= budgetTokens * 4;
  const baseHistoryTokens = usedNativeTelemetry ? latestReportedContextTokens : charEstimatedHistory;
  const estimatedTokens = baseHistoryTokens + draftTokens;
  const usageRatio = estimatedTokens / budgetTokens;
  const usagePercent = Math.min(999, Math.round(usageRatio * 100));

  let level: ContextLoadLevel = 'fresh';
  let advice = '上下文窗口充裕，注意力集中度高。';
  if (usageRatio >= 1) {
    level = 'compaction_needed';
    advice = '上下文已超出推荐专注窗口，长程指令易漂移；建议点击右上菜单「导出跨 Agent 交接简报」或「基于此会话新建」分叉精简。';
  } else if (usageRatio >= 0.8) {
    level = 'heavy';
    advice = '会话上下文已达高负载区间（>=80%），复杂重构建议分叉新会话继承关键结论以降低延迟与幻觉。';
  } else if (usageRatio >= 0.45) {
    level = 'moderate';
    advice = '上下文处于适中水位，建议配合 @符号: 或 @file:line 精确引用以节省窗口预算。';
  }

  return {
    estimatedTokens,
    budgetTokens,
    usageRatio,
    usagePercent,
    turnCount: activeRuns.length,
    level,
    usedNativeTelemetry,
    advice,
  };
}

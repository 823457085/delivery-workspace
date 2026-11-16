/**
 * Agent 运行失败根因分析（RCA）与智能恢复建议引擎（纯函数，无 Node I/O 依赖，前后端通用）。
 *
 * 设计借鉴自 GitHub 开源项目：
 * - `lmnr-ai/lmnr`（Laminar）：基于轨迹事件链（Span / Tool / Diagnostic）的失败根因分类与因果证据链提取
 * - `SWE-agent/SWE-agent`：将冗长原始堆栈蒸馏为高信噪比的编译器/单测诊断反馈，避免盲目原样重试
 * - `cline/cline` & `RooCodeInc/Roo-Code`：感知额度限流、上下文溢出、沙箱权限受限与锁冲突的自适应恢复指引
 */
import {
  agentProviderLabels,
  type AgentAccessMode,
  type AgentChangedFile,
  type AgentProvider,
  type AgentRunEvent,
  type AgentRunMode,
  type AgentRunStatus,
} from './agent-runtime.js';
import { redactSensitiveHandoffText } from './agent-handoff-packet.js';
import { distillVerificationOutput, stripAnsiCodes, type DistilledDiagnostic } from './verification-log-distiller.js';

export type AgentFailureCategory =
  | 'quota_or_rate_limit'
  | 'auth_or_account'
  | 'context_overflow'
  | 'permission_or_sandbox'
  | 'session_or_lock_conflict'
  | 'git_or_merge_conflict'
  | 'verification_or_compile'
  | 'network_or_timeout'
  | 'unknown_runtime_error';

export type AgentFailureSeverity = 'warning' | 'danger';

export interface AgentFailureRcaInput {
  id?: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  accessMode: AgentAccessMode;
  model?: string;
  status: AgentRunStatus;
  objective?: string;
  error: string;
  events?: Pick<AgentRunEvent, 'type' | 'message' | 'createdAt'>[];
  changedFiles?: AgentChangedFile[];
}

export interface AgentFailureRcaReport {
  category: AgentFailureCategory;
  categoryLabel: string;
  severity: AgentFailureSeverity;
  /** 是否建议直接原样盲重试（如配额耗尽、权限不足、上下文超长时盲重试大概率继续失败） */
  blindRetryAdvisable: boolean;
  blindRetryHint: string;
  summary: string;
  /** 触发失败前最近一次关键工具动作或诊断事件 */
  causalTrigger?: string;
  /** 从错误与诊断事件中提炼的结构化编译器/测试报错（精确到 file:line） */
  diagnostics: DistilledDiagnostic[];
  failingTests: string[];
  /** 建议用户在工作台执行的具体恢复步骤 */
  recoverySteps: string[];
  /** 是否建议切换到备用 CLI 执行器继续接力 */
  suggestSwitchProvider: boolean;
  /** 是否建议放宽运行模式或工作区访问权限 */
  suggestUpgradeAccess: boolean;
  /** 可一键填入输入框的带诊断纠偏指令（已自动脱敏） */
  smartRetryPrompt?: string;
}

interface ClassificationRule {
  category: AgentFailureCategory;
  label: string;
  severity: AgentFailureSeverity;
  blindRetryAdvisable: boolean;
  blindRetryHint: string;
  patterns: RegExp[];
}

const FAILURE_RULES: readonly ClassificationRule[] = [
  {
    category: 'quota_or_rate_limit',
    label: '额度耗尽或接口限流',
    severity: 'warning',
    blindRetryAdvisable: false,
    blindRetryHint: '当前通道受配额或速率限制，立即原样重试通常仍会失败',
    patterns: [
      /\b429\b/i,
      /rate[_\s-]?limit/i,
      /too many requests/i,
      /insufficient[_\s-]?quota/i,
      /quota[_\s-]?(?:exceeded|exhausted)/i,
      /usage[_\s-]?limit/i,
      /billing[_\s-]?hard[_\s-]?limit/i,
      /overloaded_error|\b529\b/i,
      /额度(?:已)?(?:用尽|耗尽|不足)|请求过于频繁|触发限流|超出配额/,
    ],
  },
  {
    category: 'auth_or_account',
    label: '登录态失效或鉴权失败',
    severity: 'danger',
    blindRetryAdvisable: false,
    blindRetryHint: '需先恢复本机 CLI 登录态或检查模型鉴权后再试',
    patterns: [
      /\b(?:401|403)\b.*(?:unauthori[sz]ed|forbidden|auth|token|key)/i,
      /\bunauthori[sz]ed\b/i,
      /authentication[_\s-]?(?:failed|error|required)/i,
      /invalid[_\s-]?api[_\s-]?key/i,
      /not\s+logged\s+in|login\s+required|please\s+run\s+.*login/i,
      /token\s+(?:has\s+)?expired/i,
      /未登录|登录已过期|认证失败|鉴权失败|无效的?\s*API\s*Key/i,
    ],
  },
  {
    category: 'context_overflow',
    label: '上下文窗口超限',
    severity: 'warning',
    blindRetryAdvisable: false,
    blindRetryHint: '原会话累计上下文已触及模型上限，建议分叉精简或按文件缩窄范围',
    patterns: [
      /context[_\s-]?length[_\s-]?exceeded/i,
      /maximum\s+context\s+length/i,
      /prompt\s+is\s+too\s+long/i,
      /input\s+is\s+too\s+long/i,
      /request\s+too\s+large|\b413\b/i,
      /token\s+limit\s+exceeded/i,
      /上下文(?:长度)?超(?:限|长)|提示词过长|超出最大上下文/,
    ],
  },
  {
    category: 'permission_or_sandbox',
    label: '沙箱或访问权限受限',
    severity: 'warning',
    blindRetryAdvisable: false,
    blindRetryHint: '操作被当前只读模式或工作区沙箱拦截，调整模式/权限后再执行',
    patterns: [
      /\b(?:EPERM|EACCES|EROFS)\b/,
      /operation\s+not\s+permitted/i,
      /permission\s+denied/i,
      /read-only\s+file\s+system/i,
      /sandbox\s+(?:violation|blocked|denied|restriction)/i,
      /blocked\s+by\s+(?:policy|sandbox)/i,
      /只读(?:会话|模式).*(?:不得|不能|禁止)|越界访问|拒绝访问|权限不足|无权写入/,
    ],
  },
  {
    category: 'session_or_lock_conflict',
    label: '会话正忙或工作区锁冲突',
    severity: 'warning',
    blindRetryAdvisable: true,
    blindRetryHint: '等待占用进程释放或清理陈旧锁文件后可安全重试',
    patterns: [
      /session\s+is\s+(?:currently\s+)?busy/i,
      /already\s+running\s+on\s+this\s+session/i,
      /index\.lock['":\s]|another\s+git\s+process\s+seems\s+to\s+be\s+running/i,
      /resource\s+temporarily\s+unavailable|\bEBUSY\b/i,
      /会话正忙|正在执行其他轮次|锁文件冲突|已被其他进程占用/,
    ],
  },
  {
    category: 'git_or_merge_conflict',
    label: 'Git 分支或合并冲突',
    severity: 'warning',
    blindRetryAdvisable: false,
    blindRetryHint: '工作区存在未解决的 Git 冲突或基线分叉，建议附带冲突上下文修复',
    patterns: [
      /CONFLICT\s*\((?:content|modify\/delete|add\/add|rename)\)/,
      /Automatic\s+merge\s+failed/i,
      /unmerged\s+paths|you\s+have\s+unmerged\s+paths/i,
      /non-fast-forward|failed\s+to\s+push\s+some\s+refs/i,
      /local\s+changes\s+.*\s+would\s+be\s+overwritten/i,
      /合并冲突|存在未合并的文件|分支落后于远端/,
    ],
  },
  {
    category: 'verification_or_compile',
    label: '编译类型或单测验证未通过',
    severity: 'danger',
    blindRetryAdvisable: false,
    blindRetryHint: '携带下方蒸馏后的精确文件行号报错继续修复，比原样盲跑更高效',
    patterns: [
      /\berror\s+TS\d{4,5}:/,
      /\b(?:AssertionError|ReferenceError|TypeError|SyntaxError):/,
      /ERR_MODULE_NOT_FOUND|Cannot\s+find\s+module/i,
      /\bFAIL\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/,
      /Test\s+failed|tests?\s+failed|✖\s+.*failed/i,
      /Command\s+failed.*(?:tsc|vue-tsc|vite|vitest|jest|pytest|cargo\s+test|go\s+test)/i,
      /编译失败|类型检查未通过|测试未通过|构建失败/,
    ],
  },
  {
    category: 'network_or_timeout',
    label: '网络抖动或执行超时',
    severity: 'warning',
    blindRetryAdvisable: true,
    blindRetryHint: '属于瞬态连接中断或响应超时，可直接重新执行或断点续跑',
    patterns: [
      /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
      /socket\s+hang\s+up/i,
      /fetch\s+failed|network\s+error/i,
      /timed?\s*out\s+after/i,
      /\b(?:502|503|504)\b.*(?:bad\s+gateway|service\s+unavailable|gateway\s+timeout)/i,
      /连接超时|网络异常|请求超时|连接被重置/,
    ],
  },
];

function compactLine(raw: string, maxChars = 180): string {
  const cleaned = redactSensitiveHandoffText(stripAnsiCodes(raw))
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function extractCausalTrigger(events: readonly Pick<AgentRunEvent, 'type' | 'message'>[] = []): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || (event.type !== 'tool' && event.type !== 'diagnostic')) continue;
    const line = compactLine(event.message, 160);
    if (!line) continue;
    return line;
  }
  return undefined;
}

function buildSmartRetryPrompt(input: {
  category: AgentFailureCategory;
  errorSnippet: string;
  causalTrigger?: string;
  diagnostics: readonly DistilledDiagnostic[];
  failingTests: readonly string[];
}): string | undefined {
  if (
    input.category === 'quota_or_rate_limit'
    || input.category === 'auth_or_account'
    || input.category === 'session_or_lock_conflict'
    || input.category === 'network_or_timeout'
  ) {
    return undefined;
  }

  const lines: string[] = [];
  if (input.category === 'verification_or_compile') {
    lines.push('上一轮执行在编译或验证阶段未通过，请针对以下精确诊断定位根因并修复，改完后重新运行对应验证确认通过：');
  } else if (input.category === 'git_or_merge_conflict') {
    lines.push('当前工作区存在 Git 分支或合并冲突，请先检查冲突标记与双端改动意图，安全消解冲突后再验证：');
  } else if (input.category === 'permission_or_sandbox') {
    lines.push('上一轮因访问范围或只读限制中断，请仅在当前允许的工作区目录内完成修改（或说明需要放宽的具体命令）：');
  } else if (input.category === 'context_overflow') {
    lines.push('上一轮上下文过长，请聚焦核心涉及文件直接定位处理，避免全仓大范围读取无关文件：');
  } else {
    lines.push('上一轮执行遇到以下异常中断，请先排查报错原因并采取稳妥方案继续完成任务：');
  }

  if (input.causalTrigger) {
    lines.push(`- 触发动作：\`${input.causalTrigger}\``);
  }
  if (input.diagnostics.length > 0) {
    lines.push('- 关键报错定位：');
    for (const diag of input.diagnostics.slice(0, 5)) {
      const loc = diag.line ? `${diag.file}:${diag.line}` : diag.file;
      const codePrefix = diag.code ? `[${diag.code}] ` : '';
      lines.push(`  - \`${loc}\` — ${codePrefix}${compactLine(diag.message, 140)}`);
    }
  } else if (input.errorSnippet) {
    lines.push(`- 错误摘要：\`${input.errorSnippet}\``);
  }

  if (input.failingTests.length > 0) {
    lines.push(`- 失败用例：${input.failingTests.slice(0, 4).map(name => `\`${compactLine(name, 80)}\``).join('、')}`);
  }

  return lines.join('\n');
}

/**
 * 分析失败或中断的 Agent 运行记录，返回确定性根因分类、因果证据链与恢复动作。
 * 若运行未失败且无错误文本，返回 `null`。
 */
export function analyzeAgentRunFailure(run: AgentFailureRcaInput): AgentFailureRcaReport | null {
  const hasFailureStatus = run.status === 'failed' || run.status === 'interrupted';
  const rawError = stripAnsiCodes(run.error || '').trim();
  if (!hasFailureStatus && !rawError) return null;

  const recentDiagnosticMessages = (run.events || [])
    .filter(event => event.type === 'diagnostic' || event.type === 'tool')
    .slice(-12)
    .map(event => stripAnsiCodes(event.message || ''));

  const combinedEvidence = [rawError, ...recentDiagnosticMessages].filter(Boolean).join('\n');
  const distilled = distillVerificationOutput(combinedEvidence, {
    changedFiles: (run.changedFiles || []).map(file => file.path),
    maxDiagnostics: 6,
  });

  let matchedRule: ClassificationRule | undefined;
  for (const rule of FAILURE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(rawError))) {
      matchedRule = rule;
      break;
    }
  }
  if (!matchedRule) {
    for (const rule of FAILURE_RULES) {
      if (rule.patterns.some(pattern => pattern.test(combinedEvidence))) {
        matchedRule = rule;
        break;
      }
    }
  }
  if (!matchedRule && (distilled.diagnostics.length > 0 || distilled.failingTests.length > 0)) {
    matchedRule = FAILURE_RULES.find(rule => rule.category === 'verification_or_compile');
  }

  const category: AgentFailureCategory = matchedRule?.category ?? 'unknown_runtime_error';
  const categoryLabel = matchedRule?.label ?? (run.status === 'interrupted' ? '执行过程意外中断' : '运行异常退出');
  const severity: AgentFailureSeverity = matchedRule?.severity ?? (run.status === 'interrupted' ? 'warning' : 'danger');
  const blindRetryAdvisable = matchedRule?.blindRetryAdvisable ?? (run.status === 'interrupted');
  const blindRetryHint = matchedRule?.blindRetryHint ?? (
    run.status === 'interrupted'
      ? '运行在完成前被中断，可先核对已改动文件再决定续跑或重试'
      : '建议先结合最近失败事件核对原因，或附带报错摘要定向重试'
  );

  const providerLabel = agentProviderLabels[run.provider] || run.provider;
  const causalTrigger = extractCausalTrigger(run.events);
  const errorSnippet = compactLine(rawError || combinedEvidence, 180);

  let summary = '';
  const recoverySteps: string[] = [];
  let suggestSwitchProvider = false;
  let suggestUpgradeAccess = false;

  switch (category) {
    case 'quota_or_rate_limit':
      summary = `${providerLabel} 当前触发配额窗口或接口速率限制，请求被服务端拒绝。`;
      suggestSwitchProvider = true;
      recoverySteps.push(
        `在下方输入栏切换备用执行器（例如从 ${providerLabel} 切换至其他就绪 CLI），工作台会自动注入跨 Agent 交接简报无缝续接`,
        '若需继续使用原执行器，请等待限流窗口恢复或检查账户 Credits 余额',
      );
      break;
    case 'auth_or_account':
      summary = `${providerLabel} 本机登录凭证已失效、未登录或自定义模型密钥无效。`;
      suggestSwitchProvider = true;
      recoverySteps.push(
        `在终端执行对应 CLI 登录命令刷新本机授权，或在「执行器状态」面板核对健康检查`,
        '急需推进任务时，可先切换至已就绪的其他 CLI 执行器接力完成',
      );
      break;
    case 'context_overflow':
      summary = '当前会话累计提示词与工具回读内容超出所选模型的最大上下文窗口。';
      recoverySteps.push(
        '点击右上角菜单「基于此会话新建」或「导出跨 Agent 交接简报」开启轻量化新会话',
        '提问时用 `@目录:` 或 `@符号:` 精确锚定目标模块，避免让模型通读大体积无关文件',
      );
      break;
    case 'permission_or_sandbox':
      summary = run.mode !== 'agent'
        ? `当前处于只读模式（${run.mode === 'plan' ? 'Plan' : 'Ask'}），写入或命令操作被宿主安全边界拦截。`
        : run.accessMode !== 'full'
          ? '当前为「仅工作区访问」沙箱权限，涉及工作区外路径、本机环境或受限网络的操作被拦截。'
          : '目标路径或系统命令返回操作系统级权限拒绝（EPERM / EACCES）。';
      suggestUpgradeAccess = run.mode !== 'agent' || run.accessMode !== 'full';
      if (run.mode !== 'agent') {
        recoverySteps.push('在输入栏左下角将模式切换为「Agent 模式」后再发送修改指令');
      } else if (run.accessMode !== 'full') {
        recoverySteps.push('若确需访问本机依赖缓存或网络，在输入栏将访问权限切换为「完全访问」后重试');
      } else {
        recoverySteps.push('检查目标文件是否只读、被系统保护，或改用工作区本地目录完成操作');
      }
      break;
    case 'session_or_lock_conflict':
      summary = '底层会话正在处理其他轮次，或 Git 工作区存在未释放的 `.git/index.lock` 锁文件。';
      recoverySteps.push(
        '稍候几秒待活跃进程自然退出后点击「重新执行」',
        '若确认无后台 Git 进程仍在运行，可检查工作区是否存在残留的 `.git/index.lock`',
      );
      break;
    case 'git_or_merge_conflict':
      summary = 'Git 合并、变基或推送阶段检测到未消解冲突或远端非快进分叉。';
      recoverySteps.push(
        '打开「项目 Git 抽屉」查看工作树冲突雷达与冲突文件列表',
        '点击下方「填入带诊断修复指令」，让 Agent 定向消解冲突标记并跑通验证',
      );
      break;
    case 'verification_or_compile':
      summary = distilled.diagnostics.length > 0
        ? `从输出中提取到 ${distilled.diagnostics.length} 处编译/验证错误${distilled.counts.inChangedFile > 0 ? `（其中 ${distilled.counts.inChangedFile} 处位于本轮改动文件）` : ''}。`
        : '代码构建、类型检查或自动化测试命令返回非零退出码。';
      recoverySteps.push(
        '使用下方「填入带诊断修复指令」，把精确到文件与行号的报错摘要直接喂给下一轮定点修复',
        '若连续多轮卡在同一报错，可先切回 Plan 模式梳理依赖影响面',
      );
      break;
    case 'network_or_timeout':
      summary = `${providerLabel} 与远端服务通信时发生瞬态网络中断或响应超时。`;
      recoverySteps.push(
        '检查本机网络连接与代理状态是否正常，随后可直接点击「重新执行」',
        '若单轮任务耗时过长导致超时，可将大任务拆分为按模块的增量小步骤执行',
      );
      break;
    default:
      summary = errorSnippet
        ? `${providerLabel} 运行未正常完成：${errorSnippet}`
        : `${providerLabel} 运行中途结束，尚未生成完整最终回复。`;
      recoverySteps.push(
        '展开「最近执行记录」查看中断前最后一条工具输出',
        '可使用下方「填入带诊断修复指令」补充约束后继续执行',
      );
      break;
  }

  const smartRetryPrompt = buildSmartRetryPrompt({
    category,
    errorSnippet,
    causalTrigger,
    diagnostics: distilled.diagnostics,
    failingTests: distilled.failingTests,
  });

  return {
    category,
    categoryLabel,
    severity,
    blindRetryAdvisable,
    blindRetryHint,
    summary,
    ...(causalTrigger ? { causalTrigger } : {}),
    diagnostics: distilled.diagnostics,
    failingTests: distilled.failingTests,
    recoverySteps,
    suggestSwitchProvider,
    suggestUpgradeAccess,
    ...(smartRetryPrompt ? { smartRetryPrompt } : {}),
  };
}

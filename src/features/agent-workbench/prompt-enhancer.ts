/**
 * 设计说明：借鉴 GitHub 标杆项目 Roo Code / Dify / Open WebUI 的「一键完善提问（Prompt Enhancer）」：
 * 平时随手敲半句大白话（如“把订单列表导出慢修一下”），无需等待远端模型耗时请求，
 * 本地零延迟自动按意图（修 Bug / 加功能 / 性能优化 / 只读排查 / 方案设计）补齐上下文核对、防回归约束与测试验证要求；
 * 同时完整保留已引用的 `@文件` / `@任务` 标签，并支持一键「撤回原话」。
 */
import type { AgentRunMode } from '../../../shared/agent-runtime';

export interface EnhancedPromptResult {
  enhanced: string;
  intentLabel: string;
}

const ALREADY_STRUCTURED_RE = /(?:^|\n)\s*(?:[-*]\s+\*\*|\d+\.\s+\*\*|###?\s+|【目标|请按以下要求执行)/;

export function canEnhancePromptDraft(draft: string): boolean {
  const trimmed = (draft || '').trim();
  if (trimmed.length < 4 || trimmed.length > 800) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('```')) return false;
  if (ALREADY_STRUCTURED_RE.test(trimmed)) return false;
  return true;
}

type PromptIntent = 'bugfix' | 'perf' | 'review' | 'feature';

function detectPromptIntent(text: string): PromptIntent {
  if (/(报错|异常|失败|不生效|白屏|崩溃|卡死|不对|修一下|修复|bug|error|fail|fix)/i.test(text)) {
    return 'bugfix';
  }
  if (/(慢|卡顿|耗时|性能|内存|体积|优化加载|提速|perf|slow)/i.test(text)) {
    return 'perf';
  }
  if (/(看下|看看|解释|为什么|怎么回事|检查|审查|review|评估|风险)/i.test(text)) {
    return 'review';
  }
  return 'feature';
}

export function enhancePromptDraft(
  draft: string,
  mode: AgentRunMode = 'agent',
): EnhancedPromptResult {
  const core = draft.trim();
  if (!canEnhancePromptDraft(core)) {
    return { enhanced: draft, intentLabel: '原样保留' };
  }

  if (mode === 'plan') {
    return {
      intentLabel: '方案规划',
      enhanced: [
        core,
        '',
        '请按以下要求先输出清晰方案（暂不直接改代码）：',
        '1. **现状与范围定位**：先核对相关模块、上下游调用链与受影响文件；',
        '2. **分步实施计划**：列出最小化改动步骤、关键边界情况与兼容策略；',
        '3. **验证方式**：说明改完后应运行哪些测试或检查来确认无误。',
      ].join('\n'),
    };
  }

  if (mode === 'ask') {
    return {
      intentLabel: '只读分析',
      enhanced: [
        core,
        '',
        '请结合当前项目真实代码进行只读分析：',
        '1. **核心结论先行**：先用大白话直接给出结论或原因；',
        '2. **代码依据**：指出具体涉及的文件路径、关键函数与调用关系；',
        '3. **潜在注意点**：如有容易踩坑的边界条件或改进建议请一并说明。',
      ].join('\n'),
    };
  }

  const intent = detectPromptIntent(core);
  if (intent === 'bugfix') {
    return {
      intentLabel: '缺陷排查修复',
      enhanced: [
        core,
        '',
        '请按以下标准闭环处理：',
        '1. **定位根因**：先阅读相关代码定位真实触发原因，避免只做表面掩盖；',
        '2. **最小化安全修复**：保持周边既有逻辑与调用契约不受影响，兼顾空值与异常边界；',
        '3. **验证闭环**：运行相关单元测试与类型/构建检查，确认问题修复且无新增报错。',
      ].join('\n'),
    };
  }

  if (intent === 'perf') {
    return {
      intentLabel: '性能优化',
      enhanced: [
        core,
        '',
        '请按以下标准闭环优化：',
        '1. **找出瓶颈**：先定位造成耗时、重复请求或多余渲染的具体位置；',
        '2. **稳妥优化**：在不改变原有业务结果与数据一致性的前提下完成优化；',
        '3. **验证对比**：运行相关测试与构建检查，并简明说明优化点与预期效果。',
      ].join('\n'),
    };
  }

  if (intent === 'review') {
    return {
      intentLabel: '代码走查',
      enhanced: [
        core,
        '',
        '请结合当前代码重点检查：',
        '1. **潜在缺陷与边界**：并发竞态、空值处理、权限安全与异常兜底是否完备；',
        '2. **定位与建议**：按重要程度列出具体文件位置与可直接落地的修改建议。',
      ].join('\n'),
    };
  }

  return {
    intentLabel: '需求实现',
    enhanced: [
      core,
      '',
      '请按以下标准闭环实现：',
      '1. **遵循既有规范**：先参考项目同类模块的代码风格、类型定义与复用组件；',
      '2. **完整实现与防回归**：补齐正常流程与常见边界状态，不破坏现有功能与测试；',
      '3. **自测验证**：运行相关单元测试与生产构建检查，确保零报错可用。',
    ].join('\n'),
  };
}

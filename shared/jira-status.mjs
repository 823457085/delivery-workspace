/**
 * 单一权威 Jira 状态判定引擎（修复 P0-4：消除未锚定 `/完成/` 误判「未完成 / 待完成 / 开发完成」及多处口径分裂）。
 * 优先依据 Jira `statusCategory`（key / name），`status` 仅做整词匹配并显式排除否定词与中间阶段词。
 */

function extractStatusText(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object') {
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    return key || name;
  }
  return String(raw).trim();
}

const NEGATED_OR_INTERMEDIATE_DONE_RE =
  /(?:未完成|待完成|未关闭|未解决|重新打开|重开|开发完成|编码完成|设计完成|评审完成|联调完成|自测完成|测试完成|提测完成|待提测|待测试|待联调|待验收|待上线|待发布|待合入|待审核|not\s+done|incomplete|unresolved|reopened|in\s+review|qa\s+ready)/i;

const EXACT_DONE_CATEGORY_RE =
  /^(?:done|complete|completed|closed|resolved|完成|已完成|关闭|已关闭|已解决)$/i;

const EXACT_NON_DONE_CATEGORY_RE =
  /^(?:new|undefined|indeterminate|in[_\s-]?progress|to[_\s-]?do|todo|open|待办|待开始|处理中|进行中)$/i;

const EXACT_DONE_STATUS_RE =
  /^(?:done|closed|resolved|completed|released|完成|已完成|关闭|已关闭|已解决|已上线|已发布|已投产|已归档|验收通过)$/i;

const EXACT_TODO_CATEGORY_RE =
  /^(?:new|to[_\s-]?do|todo|open|待办|待开始|未开始)$/i;

const EXACT_TODO_STATUS_RE =
  /^(?:open|to[_\s-]?do|todo|backlog|new|reopened|待开始|未开始|待办|待处理|重新打开)$/i;

export function isJiraIssueDone(issue) {
  if (!issue || typeof issue !== 'object') return false;
  const status = extractStatusText(issue.status);
  const categoryKey =
    issue.statusCategory && typeof issue.statusCategory === 'object' && typeof issue.statusCategory.key === 'string'
      ? issue.statusCategory.key.trim()
      : '';
  const categoryText = extractStatusText(issue.statusCategory);

  // 1. 状态名明确带有否定词或研发中间阶段（如「未完成」「待完成」「开发完成」）时，绝不判为终态完成
  if (status && NEGATED_OR_INTERMEDIATE_DONE_RE.test(status)) {
    return false;
  }

  // 2. 优先信任 Jira 标准 statusCategory（如 key === 'done' 或整词 'Done' / '完成'）
  if (categoryKey && EXACT_DONE_CATEGORY_RE.test(categoryKey)) {
    return true;
  }
  if (categoryText && EXACT_DONE_CATEGORY_RE.test(categoryText)) {
    return true;
  }

  // 若 statusCategory 已明确声明为进行中/待办，且 status 不是明确的终态整词，直接返回 false
  if (
    (categoryKey && EXACT_NON_DONE_CATEGORY_RE.test(categoryKey))
    || (categoryText && EXACT_NON_DONE_CATEGORY_RE.test(categoryText))
  ) {
    return Boolean(status && EXACT_DONE_STATUS_RE.test(status));
  }

  // 3. 兜底使用整词锚定的状态名判定
  return Boolean(status && EXACT_DONE_STATUS_RE.test(status));
}

export function isJiraIssueTodo(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (isJiraIssueDone(issue)) return false;

  const status = extractStatusText(issue.status);
  const categoryKey =
    issue.statusCategory && typeof issue.statusCategory === 'object' && typeof issue.statusCategory.key === 'string'
      ? issue.statusCategory.key.trim()
      : '';
  const categoryText = extractStatusText(issue.statusCategory);

  // 若状态名已进入研发/测试/验收中间态（即使 category 仍未配置），不视为纯待开始
  if (
    status
    && /(?:开发中|进行中|处理中|联调|测试中|验收|审核|阻塞|in[_\s-]?progress|review|testing|blocked)/i.test(status)
  ) {
    return false;
  }

  if (categoryKey && EXACT_TODO_CATEGORY_RE.test(categoryKey)) return true;
  if (categoryText && EXACT_TODO_CATEGORY_RE.test(categoryText)) return true;
  return Boolean(status && EXACT_TODO_STATUS_RE.test(status));
}

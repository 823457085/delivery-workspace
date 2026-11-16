/**
 * Virtual Atomic Commit Lane Planner
 *
 * 借鉴 GitButler (gitbutlerapp/gitbutler) Virtual Commit Lanes 与 semantic-review 的关注点聚类思想：
 * - 当工作区 / 暂存区同时堆叠了跨领域改动（共享契约、后端逻辑、前端界面、自动化测试、文档/工程配置）时，
 *   自动将其规划为互不耦合的「原子提交泳道 (Atomic Commit Lanes)」；
 * - 自动剔除敏感凭据文件（`.env*`、私钥证书等），避免一键暂存误提交机密；
 * - 为每条泳道生成符合 Conventional Commits 规范且长度受控的中文标题建议。
 */

import { isSensitiveCommitPath } from './diff-review-hygiene.js';

export type CommitLaneCategory =
  | 'shared-contract'
  | 'backend-core'
  | 'frontend-ui'
  | 'verification-tests'
  | 'docs-config';

export interface CommitLaneFileInput {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict?: boolean;
  originalPath?: string;
}

export interface AtomicCommitLane {
  id: CommitLaneCategory;
  label: string;
  conventionalType: 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore';
  scope: string;
  suggestedSubject: string;
  rationale: string;
  files: string[];
  stagedCount: number;
  /** 当前仓库的已暂存文件集合是否恰好等于该泳道 */
  isExactStagedMatch: boolean;
}

export interface AtomicCommitLanePlan {
  lanes: AtomicCommitLane[];
  excludedSensitiveFiles: string[];
  conflictFiles: string[];
  totalEligibleFiles: number;
  /** 当存在 >= 2 条独立关注点泳道时建议拆分提交 */
  shouldSuggestSplit: boolean;
}

const LANE_ORDER: CommitLaneCategory[] = [
  'shared-contract',
  'backend-core',
  'frontend-ui',
  'verification-tests',
  'docs-config',
];

const LANE_META: Record<CommitLaneCategory, { label: string; rationale: string }> = {
  'shared-contract': {
    label: '共享契约与数据模型',
    rationale: '先行独立提交类型定义与跨端契约，便于上下游演进与回溯',
  },
  'backend-core': {
    label: '服务端与核心逻辑',
    rationale: '聚焦接口路由、Git/Agent 运行时与业务服务实现',
  },
  'frontend-ui': {
    label: '前端界面与交互体验',
    rationale: '聚合视图组件、样式与状态交互，保持 UI 改动边界清晰',
  },
  'verification-tests': {
    label: '自动化测试与回归守护',
    rationale: '将单元/集成测试独立成组（或紧随功能提交），方便 CI 审阅',
  },
  'docs-config': {
    label: '工程配置与说明文档',
    rationale: '隔离构建脚本、依赖配置与文档更新，避免混入业务 Diff',
  },
};

function normalizePath(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function classifyCommitLaneCategory(rawPath: string): CommitLaneCategory {
  const filePath = normalizePath(rawPath);
  const lower = filePath.toLowerCase();

  // 1. 测试文件最优先识别（无论位于 test/ 还是 src/**/__tests__/*.spec.ts）
  if (
    /^(?:test|tests|__tests__|e2e|cypress|playwright)\//i.test(filePath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(lower)
    || /\/__tests__\//i.test(filePath)
  ) {
    return 'verification-tests';
  }

  // 2. 文档与构建/工程配置文件
  if (
    /^(?:docs?|documentation|\.github|\.husky|\.vscode|tools)\//i.test(filePath)
    || /\.(?:md|mdx|txt|rst)$/i.test(lower)
    || /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\.[^/]+)?\.json|vite\.config\.[^/]+|eslint\.config\.[^/]+|\.eslintrc[^/]*|\.prettierrc[^/]*|dockerfile|makefile|\.gitignore)$/i.test(
      filePath.split('/').pop() || '',
    )
  ) {
    return 'docs-config';
  }

  // 3. 共享契约 / Schema / 类型层
  if (
    /^(?:shared|common|packages\/shared|types|schemas?|prisma|migrations|proto)\//i.test(filePath)
    || /\.d\.ts$/i.test(lower)
  ) {
    return 'shared-contract';
  }

  // 4. 服务端 / CLI / 核心运行时
  if (
    /^(?:server|backend|api|services|workers|scripts|cli|bin)\//i.test(filePath)
    || /^delivery\.mjs$/i.test(filePath)
  ) {
    return 'backend-core';
  }

  // 5. 前端视图与交互组件
  if (
    /^(?:src|client|web|app|components|pages|views|styles|public)\//i.test(filePath)
    || /\.(?:vue|tsx|jsx|css|scss|less|html|svg)$/i.test(lower)
  ) {
    return 'frontend-ui';
  }

  return 'docs-config';
}

function inferLaneScope(category: CommitLaneCategory, paths: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of paths) {
    const parts = normalizePath(raw).split('/').filter(Boolean);
    let candidate = '';
    if (parts[0] === 'src' && parts[1] === 'features' && parts[2]) {
      candidate = parts[2];
    } else if (parts[0] === 'src' && parts[1] && parts.length > 2) {
      candidate = parts[1];
    } else if ((parts[0] === 'server' || parts[0] === 'shared' || parts[0] === 'test') && parts[1]) {
      const stem = parts[1].replace(/\.(?:test|spec)?\.?[A-Za-z0-9]+$/g, '');
      const prefix = stem.split('-').slice(0, 2).join('-');
      candidate = prefix || parts[0];
    } else if (parts.length > 1 && parts[0]) {
      candidate = parts[0];
    }
    const cleaned = candidate.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (cleaned && cleaned.length <= 22) {
      counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
    }
  }

  let topScope = '';
  let topCount = 0;
  for (const [scope, count] of counts) {
    if (count > topCount) {
      topScope = scope;
      topCount = count;
    }
  }
  if (topScope && (topCount === paths.length || topCount >= Math.ceil(paths.length * 0.6))) {
    return topScope;
  }

  const fallbackScopes: Record<CommitLaneCategory, string> = {
    'shared-contract': 'shared',
    'backend-core': 'server',
    'frontend-ui': 'ui',
    'verification-tests': 'test',
    'docs-config': '',
  };
  return fallbackScopes[category];
}

function shortBaseName(rawPath: string): string {
  const base = normalizePath(rawPath).split('/').pop() || rawPath;
  return base.replace(/\.(?:vue|tsx?|jsx?|mjs|cjs|json|md)$/i, '');
}

function buildLaneSubject(
  category: CommitLaneCategory,
  scope: string,
  items: CommitLaneFileInput[],
): { conventionalType: AtomicCommitLane['conventionalType']; suggestedSubject: string } {
  const hasAdded = items.some(item => item.untracked || item.status.includes('A'));
  const allDocs = category === 'docs-config' && items.every(item => /\.(?:md|mdx|txt|rst)$/i.test(item.path));

  let conventionalType: AtomicCommitLane['conventionalType'] = 'feat';
  if (category === 'verification-tests') conventionalType = 'test';
  else if (category === 'docs-config') conventionalType = allDocs ? 'docs' : 'chore';
  else if (category === 'shared-contract') conventionalType = hasAdded ? 'feat' : 'refactor';
  else conventionalType = 'feat';

  const prefix = scope && conventionalType !== 'docs'
    ? `${conventionalType}(${scope}): `
    : `${conventionalType}: `;

  const primary = shortBaseName(items[0]!.path);
  const actionVerb = hasAdded ? '新增并完善' : '更新';
  let summary = '';
  if (items.length === 1) {
    const nounMap: Record<CommitLaneCategory, string> = {
      'shared-contract': `${actionVerb} ${primary} 共享模型契约`,
      'backend-core': `${actionVerb} ${primary} 服务端逻辑`,
      'frontend-ui': `${actionVerb} ${primary} 界面与交互`,
      'verification-tests': `${ hasAdded ? '补充' : '更新' } ${primary} 自动化测试`,
      'docs-config': allDocs ? `更新 ${primary} 文档说明` : `调整 ${primary} 工程配置`,
    };
    summary = nounMap[category];
  } else {
    const second = shortBaseName(items[1]!.path);
    const pair = items.length === 2 ? `${primary} 与 ${second}` : `${primary} 等 ${items.length} 个文件`;
    const multiMap: Record<CommitLaneCategory, string> = {
      'shared-contract': `${actionVerb} ${pair} 契约定义`,
      'backend-core': `${actionVerb} ${pair} 服务端能力`,
      'frontend-ui': `${actionVerb} ${pair} 界面交互`,
      'verification-tests': `${hasAdded ? '新增' : '更新'} ${pair} 回归测试`,
      'docs-config': allDocs ? `完善 ${pair} 说明文档` : `更新 ${pair} 工程配置`,
    };
    summary = multiMap[category];
  }

  const full = `${prefix}${summary}`;
  return {
    conventionalType,
    suggestedSubject: Array.from(full).length > 50 ? `${Array.from(full).slice(0, 49).join('')}…` : full,
  };
}

/**
 * 根据当前 Git 文件列表规划可一键独立暂存的原子提交泳道。
 */
export function planAtomicCommitLanes(files: CommitLaneFileInput[]): AtomicCommitLanePlan {
  const excludedSensitiveFiles: string[] = [];
  const conflictFiles: string[] = [];
  const eligible: CommitLaneFileInput[] = [];

  for (const item of files) {
    if (!item?.path || item.path.endsWith('/')) continue;
    if (item.conflict) {
      conflictFiles.push(item.path);
      continue;
    }
    if (!item.staged && !item.unstaged && !item.untracked) continue;
    if (isSensitiveCommitPath(item.path)) {
      excludedSensitiveFiles.push(item.path);
      continue;
    }
    eligible.push(item);
  }

  const allCurrentlyStaged = new Set(
    files.filter(item => !item.conflict && item.staged).map(item => item.path),
  );

  const buckets = new Map<CommitLaneCategory, CommitLaneFileInput[]>();
  for (const item of eligible) {
    const category = classifyCommitLaneCategory(item.path);
    const list = buckets.get(category) || [];
    list.push(item);
    buckets.set(category, list);
  }

  const lanes: AtomicCommitLane[] = [];
  for (const category of LANE_ORDER) {
    const items = buckets.get(category);
    if (!items?.length) continue;
    const paths = items.map(item => item.path);
    const scope = inferLaneScope(category, paths);
    const { conventionalType, suggestedSubject } = buildLaneSubject(category, scope, items);
    const stagedCount = items.filter(item => item.staged && !item.unstaged).length;
    const isExactStagedMatch = allCurrentlyStaged.size === paths.length
      && paths.every(filePath => allCurrentlyStaged.has(filePath))
      && items.every(item => item.staged && !item.unstaged);

    lanes.push({
      id: category,
      label: LANE_META[category].label,
      conventionalType,
      scope,
      suggestedSubject,
      rationale: LANE_META[category].rationale,
      files: paths,
      stagedCount,
      isExactStagedMatch,
    });
  }

  return {
    lanes,
    excludedSensitiveFiles,
    conflictFiles,
    totalEligibleFiles: eligible.length,
    shouldSuggestSplit: lanes.length >= 2,
  };
}

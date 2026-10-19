/** 9.30 源码增量只进入展示投影；原执行事实、会话、调度缓存保持独立。 */
import type { CatchupData, CatchupRequirement } from '../../../shared/hub';

export interface CatchupIncrement {
  groupCount: number;
  baseline: { sourceBase: string; target: string; generatedAt: string };
  requirements: {
    id: string; title: string; domain: string; category: string; description: string;
    demoState: string; acceptance: string[]; issues: string[];
    evidence: NonNullable<CatchupRequirement['sourceIncrement']>['evidence'];
    commits: NonNullable<CatchupRequirement['sourceIncrement']>['commits'];
  }[];
  sourceConflicts: (NonNullable<CatchupRequirement['sourceIncrement']>['conflicts'][number] & { issue: string })[];
}

export async function readCatchupIncrement(signal?: AbortSignal): Promise<CatchupIncrement> {
  const response = await fetch('/catchup/apex-930.json', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`读取 9.30 追平清单失败 (${response.status})`);
  const data: CatchupIncrement = await response.json();
  if (!Array.isArray(data.requirements) || data.groupCount !== data.requirements.length
    || new Set(data.requirements.map(item => item.id)).size !== data.requirements.length
    || !data.baseline?.sourceBase || !data.baseline?.target || !Array.isArray(data.sourceConflicts)
    || data.requirements.some(item => !/^REQ-930-\d{3}$/.test(item.id) || !item.title
      || !Array.isArray(item.acceptance) || !Array.isArray(item.issues)
      || !Array.isArray(item.evidence) || !Array.isArray(item.commits))) {
    throw new Error('9.30 追平清单结构校验失败');
  }
  return data;
}

export function displayCatchupBoard(board: CatchupData, increment?: CatchupIncrement): CatchupData {
  if (!increment) return board;
  const existingIds = new Set(board.requirements.map(item => item.id));
  if (increment.requirements.some(item => existingIds.has(item.id))) throw new Error('9.30 追平编号与冻结需求重复');
  const additions: CatchupRequirement[] = increment.requirements.map(item => ({
    id: item.id, title: item.title, slug: item.id.toLowerCase(), goal: item.description,
    businessDomain: item.domain, wave: '未分波次', sourceBatch: '9.30 增量',
    deliveryStatus: '待核验', pageStatus: '待核验', demoApiStatus: '待核验', gap: item.demoState,
    nextAction: '核对重构版覆盖，确认追平范围并补齐接口与页面验证',
    acceptanceCriteria: item.acceptance.map((text, index) => ({ id: `CP-${index + 1}`, text })),
    acceptanceCriteriaCount: item.acceptance.length, workPackageCount: 0,
    readinessGaps: ['重构覆盖核验', '追平任务登记'], deliveryFollowups: [],
    execution: { status: '待核验', exclusionReason: '', allowedActions: [], updatedAt: '', startedAt: '' },
    session: { status: '未建会话', jiraKey: '', jiraUrl: '', threadId: '', branch: '', workspacePath: '', result: '', error: '', updatedAt: '' },
    sourceIncrement: {
      category: item.category, demoState: item.demoState, issues: item.issues,
      generatedAt: increment.baseline.generatedAt, demoCommit: increment.baseline.sourceBase,
      targetCommit: increment.baseline.target, evidence: item.evidence, commits: item.commits,
      conflicts: increment.sourceConflicts.filter(conflict => item.issues.includes(conflict.issue)),
    },
  }));
  const requirements = [...additions, ...board.requirements.map(item => ({ ...item, sourceBatch: '8.26 冻结' }))];
  return {
    ...board,
    counts: { ...board.counts, requirements: requirements.length, frozenRequirements: board.counts.requirements,
      incrementalRequirements: additions.length, sourceCheckpoints: additions.reduce((total, item) => total + item.acceptanceCriteriaCount, 0) },
    domains: [...new Set(requirements.map(item => item.businessDomain))],
    waves: [...new Set(requirements.map(item => item.wave))],
    requirements,
  };
}

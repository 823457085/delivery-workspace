/** 工作簿计划、契约快照与本机人工审核分别记录；只有人工点击确认才算已联调。 */
export interface ApexBffInterface {
  id: string;
  sourceRow: number;
  module: string;
  pageModule: string;
  platform: string;
  priority: string;
  name: string;
  path: string;
  planNote: string;
  completion: string;
  remark: string;
  contract: { method: string; status: string; operationId: string } | null;
  /** 自有项目可显式提供页面归属，避免套用内置兼容映射。 */
  ui?: { module: string; page: string; route: string; kind: 'route' | 'shared' | 'multiple' | 'unmapped' };
}

export const reviewStatuses = ['待人工审核', '已联调', '已替代', '不再使用'] as const;
export type ApexBffReviewStatus = typeof reviewStatuses[number];

export interface ApexBffAssignee {
  name: string;
  displayName: string;
}

export interface ApexBffReviewRecord {
  status?: ApexBffReviewStatus;
  assignee?: ApexBffAssignee;
  evidence: string;
  blocker: string;
  confirmedAt: string;
  updatedAt: string;
}

export type ApexBffReviewState = Record<string, ApexBffReviewRecord>;

export function reviewLabel(record?: ApexBffReviewRecord) {
  return record?.status ?? (record?.confirmedAt ? '已联调' : '待人工审核');
}

export function matchesReviewAssignee(record: ApexBffReviewRecord | undefined, filter: string) {
  return !filter || (filter === ':unassigned' ? !record?.assignee : record?.assignee?.name === filter);
}

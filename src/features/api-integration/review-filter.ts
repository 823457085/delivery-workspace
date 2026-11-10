/** 菜单、统计与表格共用审核展示状态；只派生延期项的待审标签，不改写历史审核记录，避免各入口口径不一致。 */
import { matchesReviewAssignee, reviewLabel, type ApexBffReviewRecord, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';
import { integrationScopeCategory, type IntegrationScopeCategory } from '../../../shared/apex-integration-scope';

export function reviewDisplayStatus(item: ReviewCatalogItem, record?: ApexBffReviewRecord) {
  if (item.archived) return '暂不使用';
  const status = reviewLabel(record);
  const category = integrationScopeCategory(item);
  return status === '待人工审核' && category !== '本轮联调' ? category : status;
}

export function filterReviewCatalog(items: ReviewCatalogItem[], records: ApexBffReviewState, filters: { status: string; assignee: string; search: string; category?: IntegrationScopeCategory | '' }) {
  const term = filters.search.trim().toLowerCase();
  return items.filter(item => {
    if (filters.category && integrationScopeCategory(item) !== filters.category) return false;
    if (filters.status && reviewDisplayStatus(item, records[item.id]) !== filters.status) return false;
    if (!matchesReviewAssignee(records[item.id], filters.assignee)) return false;
    return !term || [item.name, item.path, item.ui.module, item.ui.page, item.workbook?.module, item.workbook?.pageModule, item.plan?.stageTitle]
      .some(value => value?.toLowerCase().includes(term));
  });
}

/** 菜单与表格共用人员、审核和搜索条件；模块/页面选择由容器单独处理，避免导航被当前页面限制。 */
import { matchesReviewAssignee, reviewLabel, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';
import { integrationScopeCategory, type IntegrationScopeCategory } from '../../../shared/apex-integration-scope';

export function filterReviewCatalog(items: ReviewCatalogItem[], records: ApexBffReviewState, filters: { status: string; assignee: string; search: string; category?: IntegrationScopeCategory | '' }) {
  const term = filters.search.trim().toLowerCase();
  return items.filter(item => {
    if (filters.category && integrationScopeCategory(item) !== filters.category) return false;
    if (filters.status && reviewLabel(records[item.id]) !== filters.status) return false;
    if (!matchesReviewAssignee(records[item.id], filters.assignee)) return false;
    return !term || [item.name, item.path, item.ui.module, item.ui.page, item.workbook?.module, item.workbook?.pageModule, item.plan?.stageTitle]
      .some(value => value?.toLowerCase().includes(term));
  });
}

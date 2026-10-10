/** 按看板当前菜单名称拆分剩余接口；批量分配只涉及待人工审核项，不把分页或界面筛选当作任务边界。 */
import { reviewLabel, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';

export function reviewMenuKey(item: ReviewCatalogItem) { return `${item.ui.module}/${item.ui.page}`; }

export function pendingMenuItems(items: ReviewCatalogItem[], records: ApexBffReviewState, menus: string[]) {
  const selected = new Set(menus);
  return items.filter(item => selected.has(reviewMenuKey(item)) && reviewLabel(records[item.id]) === '待人工审核');
}

export function reviewAssignmentMenus(items: ReviewCatalogItem[], records: ApexBffReviewState) {
  const groups = new Map<string, Map<string, number>>();
  for (const item of items) {
    if (reviewLabel(records[item.id]) !== '待人工审核') continue;
    const pages = groups.get(item.ui.module) ?? new Map<string, number>();
    pages.set(item.ui.page, (pages.get(item.ui.page) ?? 0) + 1);
    groups.set(item.ui.module, pages);
  }
  return [...groups].map(([module, pages]) => ({ value: module, label: module,
    children: [...pages].map(([page, count]) => ({ value: `${module}/${page}`, label: `${page}（${count} 条）` })),
  }));
}

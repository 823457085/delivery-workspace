/**
 * 为什么需要：两份清单有重合但范围不同，审核页必须按路径去重并保留各自来源。
 * 边界：这里只整理接口与页面归属，不根据旧计划状态推断联调完成。
 * 替代方案：不迁移或覆盖旧记录；工作簿接口沿用原审核 ID，旧清单独有接口使用稳定 ID。
 */
import inventory from '../../../shared/apex-bff-interface-inventory.json';
import plan from '../../../shared/refactor-integration-plan.json';
import type { ApexBffInterface } from '../../../shared/apex-bff-review';
import type { IntegrationCatalog } from '../../../shared/integration-catalog';
import { classifyApexInterface, type InterfacePage } from './page-classification';
import { buildMenuPagePlans, type PlannedOperation } from './page-plan';

export interface ReviewCatalogItem {
  id: string;
  path: string;
  method: string;
  name: string;
  source: 'workbook' | 'plan';
  workbook?: ApexBffInterface;
  plan?: PlannedOperation;
  ui: InterfacePage;
}

export const planOnlyReviewId = (operationId: string) => `plan:${operationId}`;

export function buildReviewCatalog(source: IntegrationCatalog = { plan, inventory }): ReviewCatalogItem[] {
  const { plan, inventory } = source;
  const operations = plan.stages.flatMap(stage => stage.operations.map(operation => ({ ...operation, stageId: stage.id, stageTitle: stage.title })));
  const byPath = new Map(operations.map(operation => [operation.path, operation]));
  const planPages = new Map<string, ReturnType<typeof buildMenuPagePlans>>();
  for (const page of buildMenuPagePlans(plan.stages)) {
    for (const operation of page.operations) {
      const associated = planPages.get(operation.operationId) ?? [];
      associated.push(page);
      planPages.set(operation.operationId, associated);
    }
  }
  const workbook = (inventory.items as ApexBffInterface[]).map(item => ({
    id: item.id,
    path: item.path,
    method: item.contract?.method || byPath.get(item.path)?.method || '',
    name: item.name,
    source: 'workbook' as const,
    workbook: item,
    plan: byPath.get(item.path),
    ui: item.ui || classifyApexInterface(item),
  }));
  const workbookPaths = new Set(workbook.map(item => item.path));
  const planOnly = operations.filter(operation => !workbookPaths.has(operation.path)).map(operation => {
    const matches = planPages.get(operation.operationId) ?? [];
    const match = matches[0];
    let ui: InterfacePage;
    if (matches.length > 1) ui = { module: '公共能力', page: '关联多个页面', route: '', kind: 'multiple' };
    else if (!match?.routes.length) ui = { module: '待定位模块', page: match?.title || '待定位页面', route: '', kind: 'unmapped' };
    else ui = { module: match.menu.split(' / ')[0] === '登录' ? '账号与权限' : match.menu.split(' / ')[0], page: match.title, route: match.routes[0], kind: 'route' };
    return {
      id: planOnlyReviewId(operation.operationId), path: operation.path, method: operation.method,
      name: operation.summary, source: 'plan' as const, plan: operation, ui,
    };
  });
  return [...workbook, ...planOnly];
}

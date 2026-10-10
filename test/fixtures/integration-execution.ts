import type { ReviewCatalogItem } from '../../src/features/api-integration/review-catalog';
import type { ApexBffReviewState } from '../../shared/apex-bff-review';
import type { AgentRuntimeHealth } from '../../shared/agent-runtime';
import { buildExecutionTasks, taskInterfaces, type ExecutionProgress } from '../../src/features/integration-execution/execution-plan';

export const assignee = 'fixture-owner';
export const catalog: ReviewCatalogItem[] = [
  ['read', 'GET', '运营管理', '商家管理', '/OperateManage/MerchantList'],
  ['detail', 'GET', '运营管理', '商家详情', '/OperateManage/MerchantDetail'],
  ['write', 'POST', '运营管理', '商家管理', '/OperateManage/MerchantList'],
  ['finance', 'GET', '财务管理', '付款单', '/FinancialManagement/PayOrderList'],
  ['bill', 'GET', '财务管理', '账单管理', '/FinancialManagement/billManagement/list'],
  ['monitor', 'GET', '数据监控', '数据监控', '/DataMonitoring'],
].map(([id, method, module, page, route]) => ({ id, method, path: `/api/v1/fixture/${id}`, name: `测试 ${id}`, source: 'workbook', ui: { module, page, route, kind: 'route' } }));
export const records: ApexBffReviewState = Object.fromEntries(catalog.map(item => [item.id, {
  assignee: { name: assignee, displayName: '测试负责人' }, evidence: '', blocker: '', confirmedAt: '', updatedAt: '',
}]));
export const runtime = { provider: 'codex', ready: true, models: [{ id: 'gpt-6.1-sol', efforts: ['max'], defaultEffort: 'max' }] } as AgentRuntimeHealth;
export const requestId = '11111111-1111-4111-8111-111111111111';
export function progress(taskId = 'merchant'): ExecutionProgress {
  const task = buildExecutionTasks(catalog, records, assignee).find(item => item.id === taskId)!;
  return { status: '待执行', current: '', startedAt: '', updatedAt: '', environment: 'TEST',
    automation: { workspacePath: '/fixture/workspace', deliveryRoot: '/fixture/delivery', baseUrl: 'http://127.0.0.1:6000', environment: 'TEST', assignee },
    interfaces: taskInterfaces(task, undefined, records), pages: [{ name: '测试页面', status: '待执行', result: '' }], issues: [],
  };
}

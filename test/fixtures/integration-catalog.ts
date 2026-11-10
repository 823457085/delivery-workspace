import examplePlan from '../../shared/refactor-integration-plan.json';
import exampleInventory from '../../shared/apex-bff-interface-inventory.json';
import type { IntegrationCatalog } from '../../shared/integration-catalog';

// Synthetic rows exercise menu classification, catalog joins and historical IDs.
const workbookRows = [
  ['roles', '/admin/v1/system/roles/detail', '角色管理'],
  ['users', '/admin/v1/system/users/detail', '后台用户'],
  ['time', '/admin/v1/system/time-formats', '系统配置', '时间格式'],
  ['currency', '/admin/v1/system/currency-formats', '系统配置', '货币格式'],
  ['address', '/admin/v1/system/address-formats', '系统配置', '地址格式'],
  ['area-tree', '/admin/v1/system/areas/tree', '系统配置', '区域管理'],
  ['area-create', '/admin/v1/system/areas/create', '系统配置', '区域管理'],
  ['merchant', '/admin/v1/merchants/detail', '商家管理'],
  ['equipment', '/admin/v1/devices/detail', '设备监控'],
  ['installment', '/api/fixtures/installment', '商家分期计划'],
  ['errors', '/api/fixtures/error-codes', '错误码配置'],
  ['shared', '/api/fixtures/shared', '公共依赖'],
  ...['detail', 'list', 'update', 'remove'].map(action => [`fees-${action}`, `/admin/v1/system/country-fee-rules/${action}`, '系统配置', '国家费率规则']),
  ...Array.from({ length: 7 }, (_, i) => [`pricing-${i}`, `/admin/v1/pricing/charge-rules/fixture-${i}`, '商家收费规则']),
  ...Array.from({ length: 2 }, (_, i) => [`activity-${i}`, `/admin/v1/activities/fixture-${i}`, '活动管理']),
];
const contractOnly = [
  ...Array.from({ length: 4 }, (_, i) => [`pos-${i}`, `/admin/v1/system/error-display-rules/fixture-${i}`]),
  ...Array.from({ length: 2 }, (_, i) => [`pricing-batch-${i}`, `/admin/v1/pricing/charge-rules/batch/fixture-${i}`]),
  ...Array.from({ length: 5 }, (_, i) => [`activity-trades-${i}`, `/admin/v1/activity-trades/activities/fixture-${i}`]),
  ['languages', '/admin/v1/platform/languages'],
];
const rows = [...workbookRows, ['legacy', '待定义示例', '历史模块']];
const operations = [...workbookRows, ...contractOnly].map(([id, path]) => ({
  ...examplePlan.stages[0].operations[0],
  operationId: `fixture-${id}`, path, summary: `合成契约 ${id}`, contractStatus: 'fixture',
}));

export const integrationCatalogFixture: IntegrationCatalog = {
  plan: { ...examplePlan, stages: [{ ...examplePlan.stages[0], operations }] },
  inventory: { ...exampleInventory, items: rows.map(([id, path, module, pageModule = module], index) => {
    const contract = operations.find(item => item.path === path);
    return { ...exampleInventory.items[0], id: `fixture-${id}`, sourceRow: index + 1, path, module, pageModule,
      name: `合成工作簿 ${id}`, contract: contract ? { method: contract.method, status: contract.contractStatus, operationId: contract.operationId } : null };
  }) },
};

import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationDeferral, integrationScopeCategory } from '../shared/apex-integration-scope';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog';
import { filterReviewCatalog, reviewDisplayStatus } from '../src/features/api-integration/review-filter';
import { pendingMenuItems, reviewAssignmentMenus } from '../src/features/api-integration/review-assignment';
import { buildExecutionTasks, createExecutionInput, taskInterfaces, executionScope, type ExecutionProgress } from '../src/features/integration-execution/execution-plan';
import type { ApexBffReviewState } from '../shared/apex-bff-review';
import type { AgentRuntimeHealth } from '../shared/agent-runtime';

const catalog = buildReviewCatalog();
const records: ApexBffReviewState = Object.fromEntries(catalog.map(item => [item.id, {
  assignee: { name: 'lizirui', displayName: '李子锐' }, evidence: '历史证据', blocker: '', confirmedAt: '', updatedAt: '',
}]));
const runtime = { provider: 'codex', ready: true, models: [{ id: 'gpt-6.1-sol', efforts: ['ultra'], defaultEffort: 'ultra' }] } as AgentRuntimeHealth;
const requestId = '11111111-1111-4111-8111-111111111111';
test('暂不联调独立展示，不进入待人工审核筛选和菜单分配，原始记录保持不变', () => {
  const before = structuredClone(records);
  const deferred = catalog.filter(item => integrationScopeCategory(item) === '暂不联调');
  assert.ok(deferred.length > 0);
  for (const item of deferred) {
    assert.equal(reviewDisplayStatus(item), '暂不联调');
    assert.equal(reviewDisplayStatus(item, records[item.id]), '暂不联调');
  }
  const pending = filterReviewCatalog(catalog, records, { status: '待人工审核', assignee: 'lizirui', search: '' });
  assert.deepEqual(pending, catalog.filter(item => integrationScopeCategory(item) === '本轮联调'));
  assert.ok(pending.every(item => integrationScopeCategory(item) === '本轮联调'));
  assert.deepEqual(filterReviewCatalog(catalog, records, { category: '暂不联调', status: '待人工审核', assignee: '', search: '' }), []);
  assert.deepEqual(filterReviewCatalog(catalog, records, { category: '暂不联调', status: '', assignee: 'lizirui', search: '' }), deferred);
  const menus = catalog.map(item => `${item.ui.module}/${item.ui.page}`);
  assert.deepEqual(pendingMenuItems(catalog, records, menus), pending);
  assert.deepEqual(reviewAssignmentMenus(deferred, records), []);
  assert.deepEqual(records, before);
});

test('延期接口保留人工确认和停用状态，旧版确认时间仍然有效', () => {
  const item = catalog.find(item => integrationScopeCategory(item) === '暂不联调')!;
  const legacy = { ...records[item.id], confirmedAt: '2026-10-01T00:00:00Z' };
  assert.equal(reviewDisplayStatus(item, legacy), '已联调');
  for (const status of ['已联调', '已替代', '不再使用'] as const) {
    const record = { ...legacy, status };
    assert.equal(reviewDisplayStatus(item, record), status);
    assert.deepEqual(filterReviewCatalog([item], { [item.id]: record }, { category: '暂不联调', status, assignee: '', search: '' }), [item]);
  }
  assert.equal(reviewDisplayStatus(item, { ...legacy, status: '待人工审核' }), '暂不联调');
  const archived = catalog.find(item => item.archived)!;
  assert.equal(reviewDisplayStatus(archived, legacy), '暂不使用');
});

test('广告目录保留23条暂不使用记录，历史和新执行均跳过', () => {
  assert.equal(integrationDeferral({ path: '/admin/v1/advertising/plans/list', ui: { module: '运营管理', page: '广告管理' } }), '广告暂不使用');
  assert.equal(integrationDeferral({ path: '', ui: { module: '系统配置', page: '带屏设备配置 · 待定位' } }), '广告暂不使用');
  const archived = catalog.filter(item => item.archived);
  assert.equal(archived.length, 23);
  assert.ok(archived.every(item => integrationScopeCategory(item) === '暂不使用'));
  assert.ok(executionScope(catalog, records).every(item => !item.archived));
  assert.equal(filterReviewCatalog(catalog, records, { category: '暂不使用', status: '暂不使用', assignee: '', search: '' }).length, 23);
  assert.ok(filterReviewCatalog(catalog, records, { status: '待人工审核', assignee: '', search: '' }).every(item => !item.archived));
  assert.equal(integrationDeferral({ path: '/admin/v1/common/enums', ui: { module: '运营管理', page: '商家进件' } }), '');
  assert.equal(integrationDeferral({ path: '/admin/v1/consumer-users/list', ui: { module: '运营管理', page: '消费用户' } }), '');
});
function progress(taskId: string): ExecutionProgress {
  const task = buildExecutionTasks(catalog, records).find(item => item.id === taskId)!;
  return { status: '待执行', current: '', startedAt: '', updatedAt: '', environment: 'DEV',
    automation: { workspacePath: '/test/apex-live', deliveryRoot: '/test/delivery', baseUrl: 'http://127.0.0.1:6791', environment: 'DEV', assignee: 'lizirui' },
    interfaces: taskInterfaces(task, undefined, records), pages: [], issues: [],
  };
}

test('真实菜单与业务路径分类，混合财务页面逐接口判断且不误暂停付款单和活动文案配置', () => {
  for (const item of catalog.filter(item => item.ui.module === '数据监控' || ['活动管理', '订单管理', '账单管理', '余额统计'].includes(item.ui.page))) {
    assert.equal(integrationScopeCategory(item), '暂不联调', item.path);
  }
  for (const path of ['/finance/profit-statistics/list', '/finance/collection-statistics/list', '/merchants/function-config/activity-limit-devices/list']) {
    assert.ok(integrationDeferral(catalog.find(item => item.path === '/admin/v1' + path)!));
  }
  for (const path of ['/payments/orders/list', '/finance/receipts/list', '/finance/withdrawals/list', '/system/activity-fail-node-messages/list', '/finance/receipts/export']) {
    assert.equal(integrationScopeCategory(catalog.find(item => item.path === '/admin/v1' + path)!), '本轮联调', path);
  }
  assert.equal(integrationScopeCategory(catalog.find(item => item.id === 'plan:exportAdminBills')!), '暂不联调');
  const deferred = filterReviewCatalog(catalog, records, { category: '暂不联调', status: '', assignee: 'lizirui', search: '' });
  const current = filterReviewCatalog(catalog, records, { category: '本轮联调', status: '', assignee: 'lizirui', search: '' });
  const unused = filterReviewCatalog(catalog, records, { category: '暂不使用', status: '', assignee: 'lizirui', search: '' });
  assert.equal(deferred.length + current.length + unused.length, catalog.length);
  assert.ok(deferred.every(item => !!integrationDeferral(item)));
  assert.deepEqual(filterReviewCatalog(catalog, records, { category: '暂不联调', status: '', assignee: 'liangshilong', search: '' }), []);
});

test('延期不覆盖历史结论，普通执行和回测排除延期接口及商家账单页', () => {
  const copy = structuredClone(records);
  const finance = buildExecutionTasks(catalog, copy).find(item => item.id === 'finance')!;
  const ledger = progress('finance');
  const bill = ledger.interfaces.find(item => item.id === 'apex-bff-127')!;
  bill.status = '已通过'; bill.result = '历史实测通过'; bill.checkedAt = '2026-10-09T01:00:00Z';
  const row = taskInterfaces(finance, ledger, copy).find(item => item.id === bill.id)!;
  assert.equal(row.category, '暂不联调');
  assert.equal(row.status, bill.status); assert.equal(row.result, bill.result); assert.equal(row.checkedAt, bill.checkedAt);
  const input = createExecutionInput(ledger, finance.items, copy, runtime, { requestId, taskId: 'finance', kind: 'integration' });
  assert.ok(input.objective.includes('"id":"apex-bff-101"'));
  for (const item of finance.items.filter(integrationDeferral)) assert.ok(!input.objective.includes(`"id":"${item.id}"`), item.path);
  const onlyDeferred = finance.items.filter(integrationDeferral);
  assert.ok(buildExecutionTasks(onlyDeferred, copy)[0].deferred);
  assert.throws(() => createExecutionInput(ledger, onlyDeferred, copy, runtime, { requestId, taskId: 'finance', kind: 'integration' }), /没有待执行/);
  ledger.issues.push({ id: 'FINANCE-BILL', summary: '账单阻塞', kind: '后端', status: '待修复', retest: {
    interfaceIds: [bill.id], pages: ['账单管理'], request: bill.request, headers: {}, requiredFields: [],
  } });
  assert.throws(() => createExecutionInput(ledger, finance.items, copy, runtime, { requestId, taskId: 'finance', kind: 'retest', issueId: 'FINANCE-BILL', environment: 'DEV', version: 'v2' }), /暂不联调/);
  const merchant = progress('merchant-20261009');
  merchant.issues.push({ id: 'MERCHANT-BILL', summary: '商家账单详情', kind: '后端', status: '待修复', retest: {
    interfaceIds: ['apex-bff-47'], pages: ['账单详情'], request: 'GET /admin/v1/merchants/detail', headers: {}, requiredFields: [],
  } });
  assert.throws(() => createExecutionInput(merchant, catalog, copy, runtime, { requestId, kind: 'retest', issueId: 'MERCHANT-BILL', environment: 'DEV', version: 'v2' }), /暂不联调/);
  assert.deepEqual(copy, records);
});

test('版本发布恢复本轮联调，工单31条和语料1条仍延期，已有审核结果不变', () => {
  const workOrders = catalog.filter(item => /^\/admin\/v1\/(?:work-orders|customer-service\/(?:after-sales|merchant-abnormal-orders|no-video-work-orders))(?:\/|$)/.test(item.path));
  const versions = catalog.filter(item => /^\/admin\/v1\/system\/(?:versions|version-release-plans)(?:\/|$)/.test(item.path));
  const translations = catalog.filter(item => item.path.startsWith('/admin/v1/system/translations/'));
  assert.equal(workOrders.length, 31); assert.equal(versions.length, 11); assert.equal(translations.length, 1);
  assert.equal(translations[0].ui.page, '语料管理');
  assert.equal(translations[0].ui.route, '/SystemConfig/MultilanguageManage');
  for (const item of [...workOrders, ...translations]) assert.equal(integrationScopeCategory(item), '暂不联调', item.path);
  const before = structuredClone(records);
  const pending = filterReviewCatalog(catalog, records, { category: '本轮联调', status: '待人工审核', assignee: 'lizirui', search: '' });
  const interfaces = buildExecutionTasks(catalog, records).flatMap(task => taskInterfaces(task, undefined, records));
  for (const item of versions) {
    assert.equal(integrationScopeCategory(item), '本轮联调', item.path);
    assert.equal(reviewDisplayStatus(item, records[item.id]), '待人工审核', item.path);
    assert.ok(pending.some(row => row.id === item.id), item.path);
    assert.equal(interfaces.find(row => row.id === item.id)?.category, '本轮联调', item.path);
    assert.equal(reviewDisplayStatus(item, { ...records[item.id], confirmedAt: '2026-10-01T00:00:00Z' }), '已联调', item.path);
  }
  assert.deepEqual(records, before);
  for (const path of ['/admin/v1/devices/versions/detail', '/admin/v1/devices/versions/upgrade', '/admin/v1/system/time-formats']) {
    assert.equal(integrationScopeCategory(catalog.find(item => item.path === path)!), '本轮联调', path);
  }
});

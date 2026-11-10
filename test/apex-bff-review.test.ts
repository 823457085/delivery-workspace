import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchesReviewAssignee, reviewLabel } from '../shared/apex-bff-review.js';
import { createApexBffReviewStore } from '../server/apex-bff-review.js';
import { createIntegrationStore } from '../server/api-integration.js';
import { loadIntegrationCatalog } from '../server/integration-catalog.js';
import { integrationCatalogFixture } from './fixtures/integration-catalog';
import { classifyApexInterface } from '../src/features/api-integration/page-classification.js';
import { buildReviewCatalog, planOnlyReviewId } from '../src/features/api-integration/review-catalog.js';
import { pendingMenuItems, reviewAssignmentMenus } from '../src/features/api-integration/review-assignment.js';
import { filterReviewCatalog } from '../src/features/api-integration/review-filter.js';

const { plan, inventory } = integrationCatalogFixture;
const operations = plan.stages.flatMap(stage => stage.operations);

test('使用本机配置的计划和库存，保留自定义页面归属与仓库标识', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-catalog-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const planFile = path.join(directory, 'plan.json'), inventoryFile = path.join(directory, 'inventory.json');
  const ui = { module: '示例菜单', page: '自定义页面', route: '/example/custom', kind: 'route' };
  await fs.writeFile(planFile, JSON.stringify(plan));
  await fs.writeFile(inventoryFile, JSON.stringify({ ...inventory, items: [{ ...inventory.items[0], ui }, ...inventory.items.slice(1)] }));
  const loaded = await loadIntegrationCatalog({ DELIVERY_INTEGRATION_PLAN_FILE: planFile,
    DELIVERY_INTERFACE_INVENTORY_FILE: inventoryFile, DELIVERY_REFACTOR_REPOSITORY: 'example-org/example-project' });
  assert.equal(loaded.refactorRepository, 'example-org/example-project');
  assert.deepEqual(buildReviewCatalog(loaded).find(item => item.id === inventory.items[0].id)?.ui, ui);
  const store = await createApexBffReviewStore(directory, loaded);
  await store.update({ action: 'confirm', id: inventory.items[0].id });
  assert.equal(reviewLabel(store.snapshot()[inventory.items[0].id]), '已联调');
  await store.close();
});

test('APEX 工作簿保留原接口及页面归属，契约元数据与最新快照一致', () => {
  assert.equal(new Set(inventory.items.map(item => item.path)).size, inventory.items.length);
  assert.ok(inventory.items.every(item => item.module && item.pageModule && item.name && item.path));
  for (const item of inventory.items) {
    const operation = operations.find(operation => operation.path === item.path);
    assert.deepEqual(item.contract, operation ? {
      method: operation.method, status: operation.contractStatus, operationId: operation.operationId,
    } : null);
  }
  assert.ok(inventory.items.some(item => item.path.startsWith('待定义') && !item.contract));
});

test('接口按导航模块和具体页面分组，跨页面及未定位接口不误归属单页', () => {
  const classified = inventory.items.map(item => ({ item, page: classifyApexInterface(item) }));
  assert.deepEqual(new Set(classified.map(({ page }) => page.kind)), new Set(['route', 'shared', 'multiple', 'unmapped']));
  assert.equal(classified.find(({ item }) => item.id === 'fixture-shared')?.page.kind, 'shared');
  assert.equal(classified.find(({ item }) => item.id === 'fixture-legacy')?.page.route, '');
  assert.equal(classified.find(({ item }) => item.module === '后台用户')?.page.route, '/SystemConfig/BackendUserList');
  assert.equal(classified.find(({ item }) => item.module === '商家分期计划')?.page.page, '商家详情 · 分期计划');
  assert.equal(classified.find(({ item }) => item.module === '错误码配置')?.page.kind, 'multiple');
  assert.ok(classified.filter(({ page }) => page.kind === 'route').every(({ page }) => page.route));
});

test('当前目录完整覆盖最新契约并沿用审核 ID，契约外历史记录保留但不进入目录', async t => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const active = catalog.filter(item => !item.archived);
  assert.equal(active.length, operations.length);
  assert.deepEqual(new Set(active.map(item => `${item.method} ${item.path}`)), new Set(operations.map(operation => `${operation.method} ${operation.path}`)));
  assert.equal(new Set(catalog.map(item => item.path)).size, catalog.length);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  for (const operation of operations) {
    const item = active.find(item => item.path === operation.path)!;
    const workbook = inventory.items.find(item => item.path === operation.path);
    assert.equal(item.id, workbook?.id ?? planOnlyReviewId(operation.operationId));
    assert.equal(item.name, operation.summary);
  }
  const historical = inventory.items.filter(item => !operations.some(operation => operation.path === item.path));
  assert.ok(historical.length);
  assert.ok(historical.every(item => !catalog.some(row => row.id === item.id)));
  assert.equal(catalog.find(item => item.path === '/admin/v1/system/roles/detail')?.source, 'workbook');
  const planOnly = catalog.find(item => item.source === 'plan');
  assert.ok(planOnly?.plan);
  assert.equal(planOnly.id, planOnlyReviewId(planOnly.plan.operationId));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const legacy = { evidence: '旧契约审核证据', blocker: '历史备注', confirmedAt: '', updatedAt: '', assignee: { name: 'original-owner', displayName: '原负责人' } };
  await fs.writeFile(path.join(directory, 'apex-bff-review.json'), JSON.stringify({ [historical[0].id]: legacy }));
  const store = await createApexBffReviewStore(directory, integrationCatalogFixture);
  assert.equal(reviewLabel(store.snapshot()[planOnly.id]), '待人工审核');
  await store.update({ action: 'save', id: planOnly.id, evidence: '真实环境请求、响应与页面回读', blocker: '' });
  assert.equal(reviewLabel(store.snapshot()[planOnly.id]), '待人工审核');
  await store.update({ action: 'confirm', id: planOnly.id });
  assert.equal(reviewLabel(store.snapshot()[planOnly.id]), '已联调');
  assert.deepEqual((await createApexBffReviewStore(directory, integrationCatalogFixture)).snapshot()[historical[0].id], legacy);
});

test('日期货币和地址入口独立显示，重新归类不改变接口审核 ID', () => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const cases = [
    ['/admin/v1/system/time-formats', '日期样式', '1'],
    ['/admin/v1/system/currency-formats', '货币样式', '2'],
    ['/admin/v1/system/address-formats', '地址管理', '3'],
    ['/admin/v1/system/areas/tree', '地址管理', '3'],
    ['/admin/v1/system/areas/create', '地址管理', '3'],
  ];
  for (const [path, page, tab] of cases) {
    const rows = catalog.filter(item => item.path === path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, inventory.items.find(item => item.path === path)?.id);
    assert.deepEqual(rows[0].ui, {
      module: '系统配置', page, route: `/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=${tab}`, kind: 'route',
    });
  }
  assert.equal(catalog.filter(item => item.ui.page === '地址管理').length, 3);
});

test('原待定位的 11 条接口并入已有真实菜单，保持接口 ID 并与同页任务归组', () => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const planOnly = catalog.filter(item => item.source === 'plan');
  const cases = [
    ['/admin/v1/system/error-display-rules/', 4, '系统配置', 'POS 报错时间', '/SystemConfig/GlobalConfig/PosErrorTime'],
    ['/admin/v1/pricing/charge-rules/batch/', 2, '运营管理', '商家详情 · 收费规则', '/OperateManage/MerchantDetail'],
    ['/admin/v1/activity-trades/activities/', 5, '运营管理', '活动管理', '/OperateManage/ActivityList'],
  ] as const;
  for (const [prefix, count, module, page, route] of cases) {
    const matched = planOnly.filter(item => item.path.startsWith(prefix));
    assert.equal(matched.length, count);
    for (const item of matched) {
      assert.equal(item.id, planOnlyReviewId(item.plan!.operationId));
      assert.deepEqual(item.ui, { module, page, route, kind: 'route' });
    }
  }
  assert.ok(catalog.filter(item => cases.some(([prefix]) => item.path.startsWith(prefix))).every(item => item.ui.kind === 'route'));
  const languages = catalog.find(item => item.path === '/admin/v1/platform/languages')!;
  assert.equal(languages.ui.kind, 'unmapped');
  assert.equal(languages.ui.route, '');
  assert.equal(catalog.filter(item => item.ui.module === '运营管理' && item.ui.page === '商家详情 · 收费规则').length, 9);
  assert.equal(catalog.filter(item => item.ui.module === '运营管理' && item.ui.page === '活动管理').length, 7);
});

test('旧联调记录即使标记通过，也不会自动变成人工已联调', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-independent-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const operation = plan.stages[0].operations[0];
  const oldStore = await createIntegrationStore(directory, integrationCatalogFixture);
  await oldStore.update({ kind: 'operation', id: operation.operationId, record: {
    bffStatus: '已接入', status: '通过', evidence: '旧联调记录', notes: '',
  } });
  const reviewStore = await createApexBffReviewStore(directory, integrationCatalogFixture);
  const item = buildReviewCatalog(integrationCatalogFixture).find(item => item.path === operation.path);
  assert.ok(item);
  assert.equal(reviewLabel(reviewStore.snapshot()[item.id]), '待人工审核');
  assert.equal(oldStore.snapshot().operations[operation.operationId].status, '通过');
});

test('无需填写证据即可人工确认；旧记录的变更和撤回会清除确认', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-review-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const store = await createApexBffReviewStore(directory, integrationCatalogFixture);
  const id = inventory.items[0].id;
  assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  await store.update({ action: 'confirm', id });
  assert.equal(reviewLabel(store.snapshot()[id]), '已联调');
  await store.update({ action: 'save', id, evidence: 'US dev 请求响应和页面回读记录', blocker: '' });
  assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  await store.update({ action: 'confirm', id });
  assert.equal(reviewLabel(store.snapshot()[id]), '已联调');
  await store.update({ action: 'save', id, evidence: 'US dev 请求响应和页面回读记录', blocker: '' });
  assert.equal(reviewLabel(store.snapshot()[id]), '已联调');
  await store.update({ action: 'save', id, evidence: 'US dev 请求响应和页面回读记录', blocker: '回读异常' });
  assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  await store.update({ action: 'confirm', id });
  assert.equal(store.snapshot()[id].blocker, '回读异常');
  await store.update({ action: 'reopen', id });
  assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  await store.close();
  const restored = await createApexBffReviewStore(directory, integrationCatalogFixture);
  assert.equal(restored.snapshot()[id].evidence, 'US dev 请求响应和页面回读记录');
  await assert.rejects(restored.update({ action: 'save', id: '../other', evidence: 'x', blocker: '' }));
});

test('手动状态兼容旧记录，保留证据并持久化，停用状态不再视为联调通过', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-status-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const id = inventory.items[0].id;
  const legacy = { evidence: '原验证证据', blocker: '原备注', confirmedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' };
  await fs.writeFile(path.join(directory, 'apex-bff-review.json'), JSON.stringify({ [id]: legacy }));
  const store = await createApexBffReviewStore(directory, integrationCatalogFixture);
  assert.equal(reviewLabel(store.snapshot()[id]), '已联调');
  for (const status of ['已替代', '不再使用', '待人工审核', '已联调'] as const) {
    await store.update({ action: 'status', id, status });
    const restored = await createApexBffReviewStore(directory, integrationCatalogFixture);
    const record = restored.snapshot()[id];
    assert.equal(reviewLabel(record), status);
    assert.equal(!!record.confirmedAt, status === '已联调');
    assert.equal(record.evidence, legacy.evidence);
    assert.equal(record.blocker, legacy.blocker);
  }
  await store.update({ action: 'status', id, status: '已替代' });
  await store.update({ action: 'save', id, evidence: '新证据', blocker: '' });
  assert.equal(reviewLabel(store.snapshot()[id]), '已替代');
  await store.update({ action: 'confirm', id });
  assert.equal(reviewLabel(store.snapshot()[id]), '已联调');
  await store.update({ action: 'reopen', id });
  assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  const before = store.snapshot();
  await assert.rejects(store.update({ action: 'status', id, status: '未知状态' }));
  await assert.rejects(store.update({ action: 'status', id: 'missing', status: '已替代' }));
  assert.deepEqual(store.snapshot(), before);
});

test('分配兼容旧记录，保留审核证据和确认时间，持久化、取消分配及审核变更互不覆盖', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-assignment-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const id = inventory.items[0].id;
  const legacy = { evidence: '真实请求响应', blocker: '原备注', confirmedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
  await fs.writeFile(path.join(directory, 'apex-bff-review.json'), JSON.stringify({ [id]: legacy }));
  const assignee = { name: 'fixture-reviewer', displayName: '示例人员' };
  const store = await createApexBffReviewStore(directory, integrationCatalogFixture);
  await store.update({ action: 'assign', ids: [id], assignee });
  const assigned = store.snapshot()[id];
  assert.equal(reviewLabel(assigned), '已联调');
  assert.equal(assigned.confirmedAt, legacy.confirmedAt);
  assert.equal(assigned.evidence, legacy.evidence);
  assert.equal(assigned.blocker, legacy.blocker);
  assert.deepEqual((await createApexBffReviewStore(directory, integrationCatalogFixture)).snapshot()[id].assignee, assignee);
  for (const update of [
    { action: 'status', id, status: '不再使用' },
    { action: 'save', id, evidence: '更新证据', blocker: '' },
    { action: 'confirm', id }, { action: 'reopen', id },
  ]) {
    await store.update(update);
    assert.deepEqual(store.snapshot()[id].assignee, assignee);
  }
  const beforeClear = store.snapshot()[id];
  await store.update({ action: 'assign', ids: [id], assignee: null });
  const cleared = store.snapshot()[id];
  assert.equal(cleared.assignee, undefined);
  assert.equal(cleared.evidence, beforeClear.evidence);
  assert.equal(cleared.confirmedAt, beforeClear.confirmedAt);
  assert.equal(reviewLabel(cleared), reviewLabel(beforeClear));
  assert.equal((await createApexBffReviewStore(directory, integrationCatalogFixture)).snapshot()[id].assignee, undefined);
});

test('整批分配原子校验，工作簿和旧清单可同时分配，非法请求不能部分保存', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-bff-batch-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const store = await createApexBffReviewStore(directory, integrationCatalogFixture);
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const workbook = catalog.find(item => item.source === 'workbook')!;
  const oldOnly = catalog.find(item => item.source === 'plan')!;
  const assignee = { name: 'test-operator', displayName: 'Jira 测试人员' };
  await store.update({ action: 'assign', ids: [workbook.id, oldOnly.id, workbook.id], assignee });
  assert.equal(Object.keys(store.snapshot()).length, 2);
  for (const id of [workbook.id, oldOnly.id]) {
    assert.deepEqual(store.snapshot()[id].assignee, assignee);
    assert.equal(reviewLabel(store.snapshot()[id]), '待人工审核');
  }
  const before = store.snapshot();
  for (const input of [
    { action: 'assign', ids: [workbook.id, 'missing'], assignee: null },
    { action: 'assign', ids: [], assignee },
    { action: 'assign', ids: [workbook.id], assignee: { name: '', displayName: '姓名' } },
    { action: 'assign', ids: [workbook.id], assignee: { name: 'test', displayName: ' ' } },
    { action: 'assign', ids: [workbook.id], assignee, extra: true },
  ]) {
    await assert.rejects(store.update(input));
    assert.deepEqual(store.snapshot(), before);
  }
});

test('菜单分工沿用真实菜单名称且仅覆盖待审核接口，人员按账号区分同名用户', () => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const menu = catalog.filter(item => item.ui.module === '系统配置' && item.ui.page === '费用规则');
  assert.equal(menu.length, 4);
  const makeRecord = (status: '已联调' | '已替代' | '不再使用') => ({ status, evidence: '', blocker: '', confirmedAt: '', updatedAt: '' });
  const records = {
    [menu[0].id]: makeRecord('已联调'), [menu[1].id]: makeRecord('已替代'), [menu[2].id]: makeRecord('不再使用'),
  };
  assert.deepEqual(pendingMenuItems(catalog, records, ['系统配置/费用规则']).map(item => item.id), [menu[3].id]);
  assert.equal(reviewAssignmentMenus(catalog, records).find(group => group.label === '系统配置')?.children.find(child => child.value === '系统配置/费用规则')?.label, '费用规则（1 条）');
  assert.deepEqual(pendingMenuItems(catalog, records, ['不存在的菜单']), []);
  const assigned = { ...makeRecord('已联调'), assignee: { name: 'person-one', displayName: '同名人员' } };
  assert.equal(matchesReviewAssignee(assigned, ''), true);
  assert.equal(matchesReviewAssignee(assigned, 'person-one'), true);
  assert.equal(matchesReviewAssignee(assigned, 'person-two'), false);
  assert.equal(matchesReviewAssignee(assigned, ':unassigned'), false);
  assert.equal(matchesReviewAssignee(undefined, ':unassigned'), true);
});

test('合成归档保留工作簿与契约 ID，不重新进入批量分配', () => {
  const active = buildReviewCatalog(integrationCatalogFixture);
  const archived = [active.find(item => item.source === 'workbook')!, active.find(item => item.source === 'plan')!]
    .map((item, index) => ({ ...item, archived: true, ui: { ...item.ui, module: '历史模块', page: `归档示例 ${index + 1}` } }));
  const catalog = [...active.filter(item => !archived.some(entry => entry.id === item.id)), ...archived];
  assert.equal(catalog.length, operations.length);
  assert.equal(archived[0].id, archived[0].workbook?.id);
  assert.equal(archived[1].id, planOnlyReviewId(archived[1].plan!.operationId));
  const records = Object.fromEntries(archived.map(item => [item.id, {
    assignee: { name: 'fixture-reviewer', displayName: '示例人员' }, evidence: '历史接口证据', blocker: '历史问题', confirmedAt: '', updatedAt: '2026-10-01T00:00:00Z',
  }]));
  const before = structuredClone(records);
  const menus = archived.map(item => `${item.ui.module}/${item.ui.page}`);
  assert.deepEqual(pendingMenuItems(catalog, records, menus), []);
  assert.deepEqual(reviewAssignmentMenus(archived, records), []);
  assert.ok(reviewAssignmentMenus(catalog, records).every(group => group.children.every(item => !menus.includes(item.value))));
  assert.deepEqual(records, before);
});

test('菜单与接口共用人员和审核筛选，保留跨模块结果且不改动完整菜单分配范围', () => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const fees = catalog.filter(item => item.ui.module === '系统配置' && item.ui.page === '费用规则');
  const operations = catalog.find(item => item.ui.module === '运营管理')!;
  const person = { name: 'person-one', displayName: '同名人员' };
  const record = { evidence: '', blocker: '', confirmedAt: '', updatedAt: '' };
  const records = {
    [fees[0].id]: { ...record, assignee: person },
    [fees[1].id]: { ...record, assignee: { name: 'person-two', displayName: '同名人员' } },
    [fees[2].id]: { ...record, assignee: person, confirmedAt: '2026-10-08T00:00:00Z' },
    [operations.id]: { ...record, assignee: person },
  };
  const matching = filterReviewCatalog(catalog, records, { status: '待人工审核', assignee: person.name, search: '' });
  assert.deepEqual(new Set(matching.map(item => item.id)), new Set([fees[0].id, operations.id]));
  assert.deepEqual(new Set(matching.map(item => item.ui.module)), new Set(['系统配置', '运营管理']));
  assert.deepEqual(filterReviewCatalog(catalog, records, { status: '已联调', assignee: person.name, search: '' }).map(item => item.id), [fees[2].id]);
  assert.deepEqual(filterReviewCatalog(fees, records, { status: '待人工审核', assignee: ':unassigned', search: '' }).map(item => item.id), [fees[3].id]);
  assert.deepEqual(pendingMenuItems(catalog, records, ['系统配置/费用规则']).map(item => item.id), [fees[0].id, fees[1].id, fees[3].id]);
});

test('搜索与人员和状态取交集，菜单名和路径搜索支持空白与大小写，清空恢复完整清单', () => {
  const catalog = buildReviewCatalog(integrationCatalogFixture);
  const fees = catalog.filter(item => item.ui.module === '系统配置' && item.ui.page === '费用规则');
  const person = { name: 'person-one', displayName: '人员' };
  const record = { evidence: '', blocker: '', confirmedAt: '', updatedAt: '', assignee: person };
  const records = Object.fromEntries(fees.map(item => [item.id, record]));
  const filters = { status: '待人工审核', assignee: person.name, search: '  费用规则  ' };
  assert.deepEqual(filterReviewCatalog(catalog, records, filters).map(item => item.id), fees.map(item => item.id));
  assert.deepEqual(filterReviewCatalog(catalog, records, { ...filters, search: ' /ADMIN/V1/SYSTEM/COUNTRY-FEE-RULES/DETAIL ' }).map(item => item.id), [fees.find(item => item.path.endsWith('/detail'))!.id]);
  assert.deepEqual(filterReviewCatalog(catalog, records, { ...filters, search: '不存在的接口' }), []);
  assert.deepEqual(filterReviewCatalog(catalog, records, { status: '', assignee: '', search: '' }), catalog);
});

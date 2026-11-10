import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationDeferral, integrationScopeCategory } from '../shared/apex-integration-scope';
import { filterReviewCatalog } from '../src/features/api-integration/review-filter';
import { buildExecutionTasks, createExecutionInput, currentExecutionProgress, executionScope, taskInterfaces } from '../src/features/integration-execution/execution-plan';
import { catalog, records, assignee, runtime, requestId, progress } from './fixtures/integration-execution';

test('延期分类独立于负责人和历史结论，保留原人工记录', () => {
  assert.equal(integrationScopeCategory(catalog.find(item => item.id === 'finance')!), '本轮联调');
  assert.ok(integrationDeferral(catalog.find(item => item.id === 'bill')!));
  assert.ok(integrationDeferral(catalog.find(item => item.id === 'monitor')!));
  const deferred = filterReviewCatalog(catalog, records, { category: '暂不联调', status: '', assignee, search: '' });
  const current = filterReviewCatalog(catalog, records, { category: '本轮联调', status: '', assignee, search: '' });
  assert.equal(deferred.length + current.length, catalog.length);
  assert.deepEqual(filterReviewCatalog(catalog, records, { category: '', status: '', assignee: 'other-owner', search: '' }), []);
  const task = buildExecutionTasks(catalog, records, assignee).find(item => item.id === 'finance')!;
  const ledger = progress('finance');
  const bill = ledger.interfaces.find(item => item.id === 'bill')!;
  bill.status = '已通过'; bill.result = '历史结论'; bill.checkedAt = '2026-01-01T00:00:00Z';
  const saved = taskInterfaces(task, ledger, records).find(item => item.id === 'bill')!;
  assert.equal(saved.category, '暂不联调');
  assert.equal(saved.result, '历史结论');
  const input = createExecutionInput(ledger, catalog, records, runtime, { requestId, taskId: 'finance', kind: 'integration' });
  assert.ok(input.objective.includes('"id":"finance"'));
  assert.ok(!input.objective.includes('"id":"bill"'));
  ledger.issues.push({ id: 'ISSUE-BILL', summary: '账单问题', kind: '后端', status: '待修复', retest: { interfaceIds: ['bill'], pages: ['账单管理'], request: bill.request, headers: {}, requiredFields: [] } });
  assert.throws(() => createExecutionInput(ledger, catalog, records, runtime, { requestId, taskId: 'finance', kind: 'retest', issueId: 'ISSUE-BILL', environment: 'TEST', version: 'v2' }), /暂不联调/);
});

test('合成广告历史从执行范围和当前结果中排除，原台账仍保留', () => {
  const archived = { ...catalog[0], id: 'archive-fixture', archived: true, path: '/admin/v1/advertising/example',
    ui: { ...catalog[0].ui, page: '广告管理' } };
  assert.equal(integrationScopeCategory(archived), '暂不使用');
  assert.deepEqual(executionScope([archived], { [archived.id]: records.read }, assignee), []);
  const ledger = progress();
  ledger.pages.push({ name: archived.ui.page, status: '已通过', result: '历史结论' });
  ledger.issues.push({ id: 'ARCHIVE-1', summary: '合成历史问题', kind: '后端', status: '待处理', pages: [archived.ui.page] });
  const visible = currentExecutionProgress(ledger)!;
  assert.equal(visible.pages.some(page => page.name === archived.ui.page), false);
  assert.deepEqual(visible.issues, []);
  assert.equal(ledger.issues.length, 1);
});

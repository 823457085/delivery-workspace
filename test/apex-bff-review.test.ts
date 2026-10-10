import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import inventory from '../shared/apex-bff-interface-inventory.json';
import { createApexBffReviewStore } from '../server/apex-bff-review';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog';
import { matchesReviewAssignee, reviewLabel } from '../shared/apex-bff-review';
import { loadIntegrationCatalog } from '../server/integration-catalog';
import { createIntegrationStore } from '../server/api-integration';
import { createWecomIntegration } from '../server/wecom-integration';

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('示例库存未标为已联调，计划重合接口按路径去重', () => {
  const catalog = buildReviewCatalog();
  assert.equal(inventory.items.length, 2);
  assert.equal(catalog.length, 2);
  assert.ok(catalog.every(item => item.source === 'workbook' && item.plan));
  assert.equal(reviewLabel(), '待人工审核');
});
test('负责人分配、人工确认与证据修改分别持久化，并发更新不丢记录', async t => {
  const directory = await fixture(t);
  const store = await createApexBffReviewStore(directory);
  const ids = inventory.items.map(item => item.id);
  await store.update({ action: 'assign', ids, assignee: { name: 'test-owner', displayName: '测试负责人' } });
  assert.ok(matchesReviewAssignee(store.snapshot()[ids[0]], 'test-owner'));
  await Promise.all(ids.map(id => store.update({ action: 'save', id, evidence: `fixture-${id}`, blocker: '' })));
  await store.update({ action: 'confirm', id: ids[0] });
  assert.equal(reviewLabel(store.snapshot()[ids[0]]), '已联调');
  await store.update({ action: 'assign', ids: [ids[0]], assignee: null });
  assert.equal(reviewLabel(store.snapshot()[ids[0]]), '已联调');
  await store.update({ action: 'save', id: ids[0], evidence: '新证据', blocker: '' });
  assert.equal(reviewLabel(store.snapshot()[ids[0]]), '待人工审核');
  await store.close();
  assert.deepEqual((await createApexBffReviewStore(directory)).snapshot(), JSON.parse(JSON.stringify(store.snapshot())));
  await assert.rejects(store.update({ action: 'confirm', id: 'unknown' }));
});
test('配置自有计划与库存文件，结构错误和重复 ID 在加载时拒绝', async t => {
  const directory = await fixture(t);
  const custom = await loadIntegrationCatalog({});
  custom.inventory.items[0].id = 'custom-interface';
  custom.inventory.items[0].ui = { module: '自有模块', page: '自有页面', route: '/custom/list', kind: 'route' };
  const planFile = path.join(directory, 'plan.json');
  const inventoryFile = path.join(directory, 'inventory.json');
  await fs.writeFile(planFile, JSON.stringify(custom.plan));
  await fs.writeFile(inventoryFile, JSON.stringify(custom.inventory));
  const env = { DELIVERY_INTEGRATION_PLAN_FILE: planFile, DELIVERY_INTERFACE_INVENTORY_FILE: inventoryFile };
  const result = await loadIntegrationCatalog(env);
  assert.equal(buildReviewCatalog(result)[0].id, 'custom-interface');
  assert.equal(buildReviewCatalog(result)[0].ui.route, '/custom/list');
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const review = await createApexBffReviewStore(path.join(directory, 'review'));
    await review.update({ action: 'confirm', id: 'custom-interface' });
    assert.equal(reviewLabel(review.snapshot()['custom-interface']), '已联调');
    await assert.rejects(review.update({ action: 'confirm', id: 'example-1' }));
    const integration = await createIntegrationStore(path.join(directory, 'integration'));
    assert.equal(integration.catalog.inventory.items[0].id, 'custom-interface');
    const feedback = await createWecomIntegration(path.join(directory, 'feedback'));
    const preview = feedback.preview({ interfaceId: 'custom-interface', summary: '测试反馈', environment: 'fixture', parameters: '{}',
      actual: 'fixture response', expected: 'fixture result', contractReference: 'fixture contract', traceId: '' });
    assert.equal(preview.request, 'GET /api/v1/examples/list');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  custom.inventory.items.push(custom.inventory.items[0]);
  await fs.writeFile(inventoryFile, JSON.stringify(custom.inventory));
  await assert.rejects(loadIntegrationCatalog(env), /重复 ID/);
  await fs.writeFile(inventoryFile, '{"items":[{}]}');
  await assert.rejects(loadIntegrationCatalog(env));
});

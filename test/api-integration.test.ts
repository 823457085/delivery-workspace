import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationStore } from '../server/api-integration.js';
import { bffIntegrationProgress, integrationCategory, integrationCategoryProgress, integrationProgress } from '../shared/api-integration.js';
import plan from '../shared/refactor-integration-plan.json';
import { buildMenuPagePlans } from '../src/features/api-integration/page-plan.js';

test('批次和接口保存后可从磁盘恢复，并发更新不同记录不相互覆盖', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const store = await createIntegrationStore(directory);
  const [first, second] = plan.stages[0].operations;
  await Promise.all([
    store.update({ kind: 'stage', id: '01', record: { owner: '联调负责人', startDate: '2026-09-11', endDate: '2026-09-12', notes: '账号待就绪' } }),
    store.update({ kind: 'operation', id: first.operationId, record: { bffStatus: '已接入', status: '阻塞', notes: '依赖未部署', evidence: 'traceId=test-first' } }),
    store.update({ kind: 'operation', id: second.operationId, record: { bffStatus: '已接入', status: '联调中', notes: '', evidence: 'traceId=test-second' } }),
  ]);
  await store.close();
  const restored = (await createIntegrationStore(directory)).snapshot();
  assert.equal(restored.stages['01'].owner, '联调负责人');
  assert.equal(restored.operations[first.operationId].status, '阻塞');
  assert.equal(restored.operations[first.operationId].bffStatus, '已接入');
  assert.equal(restored.operations[second.operationId].evidence, 'traceId=test-second');
  const snapshot = store.snapshot();
  snapshot.operations[first.operationId].status = '通过';
  assert.equal(store.snapshot().operations[first.operationId].status, '阻塞');
});

test('非法记录或状态不覆盖已有数据，失败后仍可继续保存', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const store = await createIntegrationStore(directory);
  const record = { bffStatus: '待接入' as const, status: '待联调' as const, notes: '', evidence: '' };
  for (const id of ['missing', '__proto__', '../../other']) await assert.rejects(store.update({ kind: 'operation', id, record }));
  const id = plan.stages[0].operations[0].operationId;
  await assert.rejects(store.update({ kind: 'operation', id, record: { ...record, status: '自动通过' as never } }));
  await assert.rejects(store.update({ kind: 'operation', id, record: { ...record, contractStatus: 'formal' } }));
  assert.deepEqual(store.snapshot(), { stages: {}, operations: {} });
  await store.update({ kind: 'operation', id, record });
  assert.equal(store.snapshot().operations[id].status, '待联调');
});

test('批次汇总区分通过、不适用与阻塞，空记录不生成已完成进度', () => {
  assert.equal(integrationProgress(['one'], { stages: {}, operations: {} }).status, '待联调');
  const state = { stages: {}, operations: {
    one: { bffStatus: '已接入' as const, status: '通过' as const, notes: '', evidence: '验证记录', updatedAt: '' },
    two: { bffStatus: '不适用' as const, status: '不适用' as const, notes: '范围已确认', evidence: '', updatedAt: '' },
    three: { bffStatus: '已接入' as const, status: '阻塞' as const, notes: '待部署', evidence: '', updatedAt: '' },
  } };
  const partial = integrationProgress(['one', 'two', 'three'], state);
  assert.equal(partial.passed, 1); assert.equal(partial.skipped, 1); assert.equal(partial.blocked, 1); assert.equal(partial.status, '阻塞');
  assert.equal(integrationProgress(['one', 'two'], state).status, '已处理');
  assert.equal(integrationProgress([], state).status, '待联调');
  assert.deepEqual(bffIntegrationProgress(['one', 'two', 'three'], state), { connected: 2, skipped: 1, pending: 0, total: 3 });
  assert.equal(integrationCategory(), '待 BFF 接入');
  assert.equal(integrationCategory(state.operations.one), '真实环境已通过');
  assert.equal(integrationCategory({ ...state.operations.one, status: '待联调' }), 'BFF 已接入，待环境联调');
  assert.deepEqual(integrationCategoryProgress(['one', 'two', 'three', 'missing'], state), {
    '待 BFF 接入': 1,
    'BFF 已接入，待环境联调': 0,
    '真实环境联调中': 0,
    '真实环境已通过': 1,
    '真实环境阻塞': 1,
    '不适用': 1,
  });
});

test('菜单页面计划保留页面接口和未绑定接口，状态仍由同一操作记录计算', () => {
  const pages = buildMenuPagePlans([
    { id: '02', title: '系统配置', operations: [
      { operationId: 'listErrorCodes', method: 'GET', path: '/admin/v1/system/error-codes/list', summary: '错误码列表', contractStatus: 'formal' },
      { operationId: 'unknownEndpoint', method: 'GET', path: '/admin/v1/unknown/items/list', summary: '未知资源', contractStatus: 'formal' },
    ] },
  ]);
  const errorCodes = pages.find(page => page.id === 'error-codes');
  assert.deepEqual(errorCodes?.operations.map(operation => operation.operationId), ['listErrorCodes']);
  const unbound = pages.find(page => page.menu === '未绑定本地菜单');
  assert.deepEqual(unbound?.operations.map(operation => operation.operationId), ['unknownEndpoint']);
});

test('格式与行政区域操作归属独立全局配置页面，不误归类为平台或国家配置', () => {
  const paths = ['time-formats', 'currency-formats', 'address-formats', 'areas/tree', 'areas/create'];
  const pages = buildMenuPagePlans([{ id: '02', title: '系统配置', operations: paths.map(path => ({
    operationId: path, method: 'GET', path: `/admin/v1/system/${path}`, summary: path, contractStatus: 'formal',
  })) }]);
  assert.deepEqual(pages.map(page => [page.title, page.operations.length]), [
    ['日期样式', 1], ['货币样式', 1], ['地址管理', 3],
  ]);
  assert.deepEqual(pages.map(page => page.routes[0]), ['1', '2', '3'].map(tab =>
    `/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=${tab}`));
});

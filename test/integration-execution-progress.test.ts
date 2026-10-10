import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateExecutionProgress, initializeExecutionProgress } from '../scripts/integration-execution-progress';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog';
import type { ExecutionProgress } from '../src/features/integration-execution/execution-plan';

const requestId = '11111111-1111-4111-8111-111111111111';
const original = { interfaceIds: ['api-1'], pages: ['页面一'], request: 'GET /admin/v1/test/detail?id=fixture', headers: { 'X-Region': 'NA' }, requiredFields: ['name'] };
function ledger(): ExecutionProgress {
  return { status: '待执行', current: '', startedAt: '', updatedAt: '', environment: 'DEV',
    automation: { workspacePath: '/fixture/apex', deliveryRoot: '/fixture/delivery', baseUrl: 'http://127.0.0.1:6791', environment: 'DEV', assignee: 'fixture-owner' },
    interfaces: [{ id: 'api-1', operationId: 'detail', page: '页面一', request: original.request, status: '已通过', result: '旧结论' }],
    pages: [{ name: '页面一', status: '已通过', result: '旧结论' }],
    issues: [{ id: 'TEST-BE-001', summary: '测试问题', kind: '后端', status: '待处理', retest: original }],
  };
}
async function fixture(t: TestContext, progress = ledger()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-task-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'public/integration-runs'), { recursive: true });
  await fs.writeFile(path.join(directory, 'public/integration-runs/equipment.json'), JSON.stringify(progress));
  return directory;
}
async function saved(directory: string, filename = 'equipment.json') {
  return JSON.parse(await fs.readFile(path.join(directory, 'public/integration-runs', filename), 'utf8'));
}

test('同批次并发更新不丢结论，两份发布文件完整一致且不同批次独立', async t => {
  const run = ledger();
  for (let i = 0; i < 24; i++) run.interfaces.push({ id: `api-${i + 2}`, operationId: '', page: '页面一', request: 'GET /admin/v1/test/list', status: '待执行', result: '' });
  const root = await fixture(t, run);
  await fs.writeFile(path.join(root, 'public/integration-runs/finance.json'), JSON.stringify(ledger()));
  await Promise.all([
    ...run.interfaces.map(item => updateExecutionProgress(root, 'equipment', 'interface', { id: item.id, status: '已通过', result: item.id })),
    updateExecutionProgress(root, 'finance', 'step', { status: '执行中', current: '独立财务批次' }),
  ]);
  const result = await saved(root);
  assert.equal(result.interfaces.length, 25);
  assert.ok(result.interfaces.every((item: { id: string; status: string; result: string; checkedAt: string }) => item.status === '已通过' && item.result === item.id && Number.isFinite(Date.parse(item.checkedAt))));
  assert.equal((await saved(root, 'finance.json')).current, '独立财务批次');
  assert.equal(await fs.readFile(path.join(root, 'public/integration-runs/equipment.json'), 'utf8'), await fs.readFile(path.join(root, 'dist/integration-runs/equipment.json'), 'utf8'));
  assert.deepEqual(await fs.readdir(path.join(root, '.data/integration-execution-locks')), []);
  assert.ok((await fs.readdir(path.join(root, 'public/integration-runs'))).every(name => !name.endsWith('.tmp')));
});

test('拒绝不存在的批次、接口、页面和跨批次问题引用，原记录不变', async t => {
  const root = await fixture(t);
  const originalFile = await fs.readFile(path.join(root, 'public/integration-runs/equipment.json'), 'utf8');
  await assert.rejects(updateExecutionProgress(root, '../finance', 'step', { status: '执行中' }), /未知执行批次/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'interface', { id: 'other-api', status: '已通过', result: '错误归属' }), /不属于本批次/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'page', { name: '其他页面', status: '已通过', result: '错误归属' }), /不属于本批次/);
  const issue = { id: 'TEST-002', summary: '问题', kind: '前端', status: '待处理' };
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', issue), /必须关联/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, retest: { ...original, interfaceIds: ['other-api'] } }), /必须属于本批次/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, interfaceIds: ['api-1'], pages: ['其他页面'] }), /必须属于本批次/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'interface', { id: 'api-1', status: '已通过', result: '伪造时间', checkedAt: '2099-01-01' }), /不可写/);
  assert.equal(await fs.readFile(path.join(root, 'public/integration-runs/equipment.json'), 'utf8'), originalFile);
  await updateExecutionProgress(root, 'equipment', 'issue', { ...issue, interfaceIds: ['api-1'], pages: [] });
  assert.equal((await saved(root)).issues.length, 2);
  await updateExecutionProgress(root, 'equipment', 'issue', { id: issue.id, status: '已修复', notification: '更新既有问题通知' });
  assert.equal((await saved(root)).issues[1].status, '已修复');
  assert.deepEqual((await saved(root)).issues[1].interfaceIds, ['api-1']);
});

test('拒绝敏感头、Token 和越界证据，非敏感上下文头可以保留', async t => {
  const root = await fixture(t);
  const issue = { id: 'TEST-002', summary: '问题', kind: '后端', status: '待处理', retest: original };
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, retest: { ...original, headers: { Authorization: 'fixture' } } }), /非敏感上下文/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, retest: { ...original, headers: { 'X-Custom-Auth': 'fixture' } } }), /非敏感上下文/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, retest: { ...original, request: 'GET /admin/v1/test?access_token=fixture' } }), /Token/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, summary: 'Authorization: fixture' }), /鉴权/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, report: '/integration-runs/../outside.html' }), /相对文件/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', { ...issue, retest: { ...original, request: 'POST /admin/v1/test/update' } }), /原 GET/);
  await updateExecutionProgress(root, 'equipment', 'issue', issue);
  assert.deepEqual((await saved(root)).issues[1].retest.headers, original.headers);
});

test('回测只接受本次开始后的接口、页面通过和存在的 HTML 证据，同请求只更新一条', async t => {
  const root = await fixture(t);
  const retest = { requestId, issueId: 'TEST-BE-001', environment: 'DEV', version: 'fixture-commit', status: '回测中', result: '重新检查' };
  const passing = { ...retest, status: '回测通过，待人工验收', result: '本次通过', report: '/integration-runs/equipment-retest.html' };
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', passing), /本次回测/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', { ...retest, environment: 'PROD' }), /环境或版本/);
  await updateExecutionProgress(root, 'equipment', 'retest', retest);
  const startedAt = (await saved(root)).retests[0].startedAt;
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', passing), /本次回测/);
  await updateExecutionProgress(root, 'equipment', 'interface', { id: 'api-1', status: '已通过', result: '本次接口验证' });
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', passing), /本次回测/);
  await updateExecutionProgress(root, 'equipment', 'page', { name: '页面一', status: '已修复', result: '本次页面验证' });
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', { ...passing, report: '/integration-runs/equipment.jpg' }), /相对文件/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', passing), /ENOENT/);
  await fs.writeFile(path.join(root, 'public/integration-runs/equipment-retest.html'), '<p>本次完整现场证据</p>');
  await updateExecutionProgress(root, 'equipment', 'retest', passing);
  await updateExecutionProgress(root, 'equipment', 'retest', passing);
  const result = await saved(root);
  assert.equal(result.retests.length, 1);
  assert.equal(result.retests[0].startedAt, startedAt);
  assert.equal(result.retests[0].status, passing.status);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', { ...passing, version: 'other-version' }), /不能更换/);
});

test('回测证据不能通过符号链接指向公开目录之外', async t => {
  const root = await fixture(t);
  const retest = { requestId, issueId: 'TEST-BE-001', environment: 'DEV', version: 'fixture', status: '回测中', result: '重新检查' };
  await updateExecutionProgress(root, 'equipment', 'retest', retest);
  await updateExecutionProgress(root, 'equipment', 'interface', { id: 'api-1', status: '已通过', result: '通过' });
  await updateExecutionProgress(root, 'equipment', 'page', { name: '页面一', status: '已通过', result: '通过' });
  await fs.writeFile(path.join(root, 'private.html'), '<p>不得公开的测试文件</p>');
  await fs.symlink(path.join(root, 'private.html'), path.join(root, 'public/integration-runs/outside.html'));
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', { ...retest, status: '回测通过，待人工验收', report: '/integration-runs/outside.html' }), /不存在或越界/);
});

test('init 从用户配置生成独立台账，无历史数据也可初始化且保留已有结果', async t => {
  const root = await fixture(t);
  const catalog = buildReviewCatalog();
  const records = Object.fromEntries(catalog.map(item => [item.id, { assignee: { name: 'fixture-owner', displayName: '测试负责人' }, evidence: '', blocker: '', confirmedAt: '', updatedAt: '' }]));
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  await fs.writeFile(path.join(root, '.data/apex-bff-review.json'), JSON.stringify(records));
  await fs.writeFile(path.join(root, '.data/integration-execution-config.json'), JSON.stringify(ledger().automation));
  const plan = await initializeExecutionProgress(root);
  assert.deepEqual(plan.tasks.map(task => task.id), ['configuration']);
  const generated = await saved(root, 'configuration.json');
  assert.equal(generated.interfaces.length, 2);
  assert.ok(generated.interfaces.every((item: { status: string }) => item.status === '待执行'));
  await updateExecutionProgress(root, 'configuration', 'interface', { id: catalog[0].id, status: '已通过', result: '测试通过' });
  await initializeExecutionProgress(root);
  assert.equal((await saved(root, 'configuration.json')).interfaces[0].result, '测试通过');
  assert.equal(await fs.readFile(path.join(root, 'public/integration-runs/execution-plan.json'), 'utf8'), await fs.readFile(path.join(root, 'dist/integration-runs/execution-plan.json'), 'utf8'));
});

test('用户已清理的问题不能被并行会话恢复或回测，新问题和接口进度仍可保存', async t => {
  const run = ledger(); run.issues = [];
  const root = await fixture(t, run);
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  await fs.writeFile(path.join(root, '.data/integration-cleared-issues.json'), JSON.stringify({ issueIds: ['TEST-BE-001'] }));
  const originalFile = await fs.readFile(path.join(root, 'public/integration-runs/equipment.json'), 'utf8');
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', ledger().issues[0]), /用户清理/);
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'retest', { requestId, issueId: 'TEST-BE-001', environment: 'DEV', version: 'fixture', status: '回测中', result: '旧问题' }), /用户清理/);
  assert.equal(await fs.readFile(path.join(root, 'public/integration-runs/equipment.json'), 'utf8'), originalFile);
  await updateExecutionProgress(root, 'equipment', 'issue', { ...ledger().issues[0], id: 'TEST-NEW' });
  await updateExecutionProgress(root, 'equipment', 'interface', { id: 'api-1', status: '已通过', result: '本次验证' });
  assert.deepEqual((await saved(root)).issues.map((issue: { id: string }) => issue.id), ['TEST-NEW']);
  assert.equal((await saved(root)).interfaces[0].result, '本次验证');
});

test('明确重启只接受本轮新报告，保留清理记录和原问题ID并允许后续通知更新', async t => {
  const run = ledger(); run.issues = [];
  const root = await fixture(t, run);
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  const policy = { issueIds: ['TEST-BE-001'], recheck: { startedAt: new Date(Date.now() - 1000).toISOString(), requestIds: [requestId] } };
  await fs.writeFile(path.join(root, '.data/integration-cleared-issues.json'), JSON.stringify(policy));
  const report = '/integration-runs/equipment-new.html';
  const file = path.join(root, 'public', report);
  const issue = { ...ledger().issues[0], report };
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', issue), /新实测报告/);
  await fs.writeFile(file, 'TEST-BE-001 来自历史报告，无本轮请求编号');
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', issue), /新实测报告/);
  await fs.writeFile(file, `TEST-BE-001 本轮请求 ${requestId}：真实请求和结果`);
  await fs.utimes(file, new Date('2026-01-01'), new Date('2026-01-01'));
  await assert.rejects(updateExecutionProgress(root, 'equipment', 'issue', issue), /新实测报告/);
  await fs.writeFile(file, `TEST-BE-001 本轮请求 ${requestId}：真实请求和结果`);
  await updateExecutionProgress(root, 'equipment', 'issue', issue);
  await updateExecutionProgress(root, 'equipment', 'issue', { id: issue.id, notification: '关键截图待采集，未推送' });
  assert.deepEqual((await saved(root)).issues.map((entry: { id: string }) => entry.id), ['TEST-BE-001']);
  assert.equal((await saved(root)).issues[0].notification, '关键截图待采集，未推送');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.data/integration-cleared-issues.json'), 'utf8')), policy);
});

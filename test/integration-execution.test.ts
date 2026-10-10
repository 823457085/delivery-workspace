import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import { activeExecution, buildExecutionTasks, createExecutionInput, executionRequest, executionScope, taskInterfaces } from '../src/features/integration-execution/execution-plan';
import { catalog, records, assignee, runtime, requestId, progress } from './fixtures/integration-execution';

test('执行只包含所选负责人、当前模块和待执行 GET，未配置负责人不派发', () => {
  const copy = structuredClone(records);
  copy.detail.assignee!.name = 'other-owner';
  const scope = executionScope(catalog, copy, assignee);
  assert.equal(executionScope(catalog, copy).length, 0);
  const input = createExecutionInput(progress(), scope, copy, runtime, { requestId, kind: 'integration' });
  assert.equal(input.model, 'gpt-6.1-sol');
  assert.equal(input.reasoningEffort, 'max');
  assert.equal(input.workspacePath, '/fixture/workspace');
  assert.ok(input.objective.includes('"request":"GET /api/v1/fixture/read"'));
  assert.ok(!input.objective.includes('"request":"POST /api/v1/fixture/write"'));
  assert.ok(!input.objective.includes('"id":"detail"'));
  assert.match(input.objective, /缺合格原生Network图时不发群/);
  assert.match(input.objective, /HTTP200也要检查必填字段/);
  assert.ok(input.objective.includes('"baseUrl":"http://127.0.0.1:6000"'));
  assert.doesNotMatch(input.objective, /本批专用登录账号：/);
  copy.read.status = '已联调';
  assert.throws(() => createExecutionInput(progress(), scope, copy, runtime, { requestId, kind: 'integration' }), /没有待执行/);
});

test('回测要求 GET 原请求、当前负责人、环境和版本', () => {
  const ledger = progress();
  ledger.issues.push({ id: 'ISSUE-1', summary: '测试', kind: '后端', status: '待修复', retest: { interfaceIds: ['detail'], pages: ['测试页面'], request: 'GET /api/v1/fixture/detail?id=fixture', headers: {}, requiredFields: ['name'] } });
  const request = { requestId, kind: 'retest' as const, issueId: 'ISSUE-1', environment: 'TEST', version: 'v1' };
  const input = createExecutionInput(ledger, catalog, records, runtime, request);
  assert.equal(executionRequest(input)?.issueId, 'ISSUE-1');
  assert.throws(() => createExecutionInput(ledger, catalog, records, runtime, { ...request, version: '' }), /部署版本/);
  assert.throws(() => createExecutionInput(ledger, catalog, records, runtime, { ...request, environment: 'OTHER' }), /部署版本/);
  ledger.issues[0].retest!.request = 'POST /api/v1/fixture/detail';
  assert.throws(() => createExecutionInput(ledger, catalog, records, runtime, request), /安全复验/);
});

test('并行会话按模块去重，结束不等于通过，人工确认独立保存', () => {
  const tasks = buildExecutionTasks(catalog, records, assignee);
  assert.equal(new Set(tasks.flatMap(task => task.items.map(item => item.id))).size, catalog.length);
  assert.ok(tasks.find(task => task.id === 'monitoring')?.deferred);
  const input = createExecutionInput(progress(), catalog, records, runtime, { requestId, kind: 'integration' });
  const complete = { objective: input.objective, status: 'completed' } as AgentRun;
  const running = { objective: input.objective, status: 'running' } as AgentRun;
  assert.equal(activeExecution([complete]), undefined);
  assert.equal(activeExecution([complete, running], 'merchant'), running);
  assert.equal(activeExecution([running], 'finance'), undefined);
  assert.equal(executionRequest({ objective: '普通会话' }), undefined);
  const copy = structuredClone(records); copy.read.status = '已联调';
  const rows = taskInterfaces(tasks[0], progress(), copy);
  assert.equal(rows.find(item => item.id === 'read')?.status, '人工已确认');
  assert.equal(rows.find(item => item.id === 'write')?.status, '需测试数据');
});

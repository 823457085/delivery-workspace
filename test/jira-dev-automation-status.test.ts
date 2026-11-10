import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceJiraDevStatus } from '../server/jira-dev-automation-status.js';
import type { JiraDevClient } from '../server/jira-dev/index.mjs';

const site = 'https://jira.example.test';
const binding = { key: 'DEMO-42', url: `${site}/browse/DEMO-42` };
const child = { key: 'DEMO-43', url: `${site}/browse/DEMO-43` };
const todo = { id: '1', name: '待开始', statusCategory: { key: 'new' } };
const inProgress = { id: '2', name: '开发中', statusCategory: { key: 'indeterminate' } };
const testing = { id: '3', name: '测试中', statusCategory: { key: 'indeterminate' } };
const done = { id: '4', name: '已完成', statusCategory: { key: 'done' } };

async function fixture() {
  const modulePath = '../server/jira-dev/jira-client.mjs';
  const { createJiraClient } = await import(modulePath);
  const fields = { summary: '开发事项', status: todo, assignee: { accountId: 'developer' }, subtasks: [] as { key: string }[] };
  const writes: string[] = [];
  const lookups: string[] = [];
  const targetFields: Record<string, unknown> = {};
  const client: JiraDevClient = createJiraClient({
    env: { JIRA_BASE_URL: site, JIRA_USERNAME: 'test', JIRA_API_TOKEN: 'test-only' },
    fetchImpl: async (url: string, init: RequestInit) => {
      const match = new URL(url).pathname.match(/^\/rest\/api\/2\/issue\/(DEMO-4[23])(\/transitions)?$/);
      assert.ok(match, '请求只应访问已绑定 Jira 事项或其子任务');
      const [, key, isTransition] = match;
      const currentFields = key === child.key ? { ...fields, status: testing } : fields;
      if (!isTransition) {
        lookups.push(key!);
        return Response.json({ key, fields: currentFields });
      }
      const target = fields.status.id === todo.id ? inProgress : done;
      if (init.method === 'POST') {
        const { transition } = JSON.parse(String(init.body));
        assert.deepEqual(transition, { id: target.id });
        writes.push(transition.id);
        fields.status = target;
        return new Response(null, { status: 204 });
      }
      return Response.json({ transitions: [{ id: target.id, name: '工作流操作', to: target, fields: targetFields }] });
    },
  });
  return { client, fields, targetFields, writes, lookups };
}

test('开始和验证后的完成流转核对 Jira 目标状态，重复请求不再提交', async () => {
  const f = await fixture();
  assert.equal((await advanceJiraDevStatus(f.client, binding, '开发中', 'start')).status, 'updated');
  assert.equal((await advanceJiraDevStatus(f.client, binding, '已完成', 'complete')).status, 'updated');
  assert.equal((await advanceJiraDevStatus(f.client, binding, '已完成', 'complete')).status, 'skipped');
  assert.deepEqual(f.writes, ['2', '4']);
  assert.equal(f.lookups.length, 7, '每次写入前重新读取当前状态，写入后读取实际状态');
});

test('开始流转保留提测中状态，完成流转保留未完成子任务的父项状态', async () => {
  const f = await fixture();
  f.fields.status = testing;
  assert.equal((await advanceJiraDevStatus(f.client, binding, '开发中', 'start')).status, 'skipped');
  f.fields.subtasks = [{ key: child.key }];
  await assert.rejects(advanceJiraDevStatus(f.client, binding, '已完成', 'complete'), /DEMO-43 尚未确认完成/);
  assert.deepEqual(f.writes, []);
  assert.ok(f.lookups.includes(child.key));
});

test('阻止非绑定事项、工作流必填字段以及写入前经办人变化', async () => {
  const f = await fixture();
  await assert.rejects(advanceJiraDevStatus(f.client, { ...binding, key: child.key }, '开发中', 'start'), /任务绑定不一致/);
  f.targetFields.resolution = { name: '解决结果', required: true };
  await assert.rejects(advanceJiraDevStatus(f.client, binding, '开发中', 'start'), /必填字段/);
  delete f.targetFields.resolution;
  const readTransitions = f.client.readTransitions!;
  f.client.readTransitions = async source => {
    const result = await readTransitions(source);
    f.fields.assignee.accountId = 'another-developer';
    return result;
  };
  await assert.rejects(advanceJiraDevStatus(f.client, binding, '开发中', 'start'), /经办人已变化/);
  f.client.readTransitions = readTransitions;
  const priorReads = f.lookups.length;
  await assert.rejects(advanceJiraDevStatus(f.client, binding, '开发中', 'start', async () => {
    assert.equal(f.lookups.length - priorReads, 1, '权限守卫在 Jira 重新读取当前状态后执行');
    throw new Error('自动流转授权已撤销');
  }), /授权已撤销/);
  assert.deepEqual(f.writes, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentDeliveryDraftService, agentDeliveryDraftInput, type AgentDeliveryDraftSource } from '../server/agent-delivery-draft.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';

function source(): AgentDeliveryDraftSource {
  const candidate = { kind: 'git-tree' as const, value: 'candidate-current' };
  const evidence = emptyDeliveryEvidence();
  evidence.tests = { status: 'passed', evidence: 'npm test exit 0', sha: '' };
  evidence.browser = { status: 'not_applicable', evidence: '无页面', sha: '' };
  evidence.remote = { status: 'not_applicable', evidence: '用户本轮未要求提交', sha: '' };
  evidence.deployment = { status: 'not_applicable', evidence: '本轮为本地源码修复', sha: '' };
  const currentSource = { runId: 'implement-1', updatedAt: '2026-10-26T10:00:00.000Z' };
  return { taskId: 'task-1', objective: '修复计算', candidate, currentSource,
    implementation: { runId: 'implement-1', summary: '修复加法', files: ['src/add.js'] },
    verification: { runId: 'verify-1', candidate, passed: true, evidence, refs: ['/evidence/tests.log'] },
    reviews: [{ runId: 'review-1', candidate, approved: true, summary: '独立审查批准', refs: ['/evidence/review.json'] }],
    acceptance: { recordId: 'agent:implementation', revision: 1, source: currentSource, checks: evidence, decision: 'accepted', summary: '已人工核对本地修复', updatedAt: currentSource.updatedAt },
    jiraFixId: 'jira-fix-local-record' };
}
const generated = () => ({ reason: '加法误用减法', changes: ['改为相加'], unverified: [], risks: [] });

test('整理仅消费当前同版本已验收证据，验证区逐项含链接，Jira保持本地待确认草稿', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-draft-'));
  const current = source(); let calls = 0;
  const service = await createAgentDeliveryDraftService(directory, { currentSource: () => current, generate: async input => {
    calls += 1; assert.deepEqual(Object.keys(input).sort(), ['acceptance', 'candidate', 'implementation', 'objective', 'reviews', 'taskId', 'validation']);
    assert.equal('history' in input, false); return generated();
  } });
  try {
    const [draft, duplicate] = await Promise.all([service.generate('task-1'), service.generate('task-1')]);
    assert.deepEqual(draft, duplicate); assert.equal(calls, 1);
    assert.match(draft.text, /npm test exit 0.*\[证据\]\(\/evidence\/tests.log\)/);
    assert.match(draft.text, /独立审查批准.*\[审查证据\]\(\/evidence\/review.json\)/);
    assert.deepEqual(draft.jiraHandoff, { path: '/agent?view=jira-fix', recordId: 'jira-fix-local-record', requiresConfirmation: true });
    assert.equal(draft.jiraDraft.cause, '加法误用减法');
    const edited = await service.save('task-1', 1, draft.text + '\n人工补充');
    assert.equal(edited.revision, 2);
    assert.equal((await service.generate('task-1')).revision, 2, '自动触发不覆盖人工已编辑稿');
    await assert.rejects(service.save('task-1', 1, '旧修订写入'), /已更新/);
    await service.close();
    const reopened = await createAgentDeliveryDraftService(directory, { currentSource: () => current, generate: async () => generated() });
    assert.match(reopened.get('task-1')!.text, /人工补充/);
    await reopened.close();
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('未验收、旧版本、缺证据或生成期间变更都不能落为当前交付草稿', async () => {
  for (const mutate of [
    (value: AgentDeliveryDraftSource) => { value.acceptance = undefined; },
    (value: AgentDeliveryDraftSource) => { value.acceptance!.decision = 'pending'; },
    (value: AgentDeliveryDraftSource) => { value.currentSource = { ...value.currentSource, updatedAt: '2026-10-26T10:01:00.000Z' }; },
    (value: AgentDeliveryDraftSource) => { value.verification.candidate = { kind: 'git-tree', value: 'old' }; },
    (value: AgentDeliveryDraftSource) => { value.reviews[0].approved = false; },
    (value: AgentDeliveryDraftSource) => { value.verification.refs = []; },
  ]) { const current = source(); mutate(current); assert.throws(() => agentDeliveryDraftInput(current)); }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-draft-stale-'));
  const current = source();
  const service = await createAgentDeliveryDraftService(directory, { currentSource: () => current, generate: async () => {
    current.objective = '生成期间目标变化'; return generated();
  } });
  try {
    await assert.rejects(service.generate('task-1'), /生成期间/);
    assert.equal(service.list().length, 0);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('手动第二意见只读留存在本机，不改变流程或人工验收', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-opinion-'));
  const current = source(); current.acceptance = undefined;
  const before = structuredClone(current);
  const service = await createAgentDeliveryDraftService(directory, { currentSource: () => current, generate: async () => generated() });
  try {
    const result = await service.secondOpinion('task-1', async input => {
      assert.equal('acceptance' in input, false); return '仅建议核对状态机边界';
    });
    assert.equal(result.readOnly, true);
    assert.deepEqual(current, before);
    assert.equal(service.list().length, 0);
    assert.equal(service.opinions('task-1').length, 1);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

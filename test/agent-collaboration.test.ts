import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentCollaborationStore } from '../server/agent-collaboration.js';

const profile = (profileId: string) => ({ kind: 'profile' as const, profileId });
const user = { kind: 'user' as const };
const ask = (key: string, overrides: Record<string, unknown> = {}) => ({ workflowId: 'flow', nodeId: 'implement:0', type: 'ask' as const,
  from: profile('engineer'), to: profile('architect'), text: '接口边界如何处理？', dedupeKey: key, ...overrides });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-collaboration-'));
  const store = await createAgentCollaborationStore(root);
  return { root, store, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('消息持久去重、按接收方串行领取，回执不等于回答', async () => {
  const { root, store, cleanup } = await fixture();
  try {
    const first = await store.send(ask('one'));
    const repeated = await store.send(ask('one'));
    assert.equal(first.id, repeated.id);
    await assert.rejects(store.send(ask('one', { text: '不同正文' })), /不同内容/);
    const second = await store.send(ask('two', { text: '第二个问题' }));
    assert.equal((await store.claim('flow', profile('architect')))?.id, first.id);
    assert.equal(await store.claim('flow', profile('architect')), undefined, '同目标已有问题处理中时不能领取第二条');
    const acknowledged = await store.acknowledge(first.id);
    assert.equal(acknowledged.delivery, 'acknowledged');
    assert.equal(acknowledged.processing, 'processing');
    const reply = await store.answer(first.id, { from: profile('architect'), text: '以契约为准', dedupeKey: 'reply-one' });
    assert.equal(reply.answerTo, first.id);
    assert.equal((await store.answer(first.id, { from: profile('architect'), text: '以契约为准', dedupeKey: 'reply-one' })).id, reply.id);
    await assert.rejects(store.answer(first.id, { from: profile('architect'), text: '另一个答案', dedupeKey: 'reply-other' }), /已经回答/);
    assert.equal((await store.claim('flow', profile('architect')))?.id, second.id);
    const reopened = await createAgentCollaborationStore(root);
    assert.equal(reopened.messages('flow').length, 3);
    assert.deepEqual(reopened.events('flow').map(item => item.eventId), [...new Set(reopened.events('flow').map(item => item.eventId))]);
    const since = reopened.events('flow', reopened.snapshot().revision);
    assert.deepEqual(since, []);
  } finally { await cleanup(); }
});

test('提问无累计次数限制，仍校验路由、循环与转交；用户回答后原问题才完成', async () => {
  const { store, cleanup } = await fixture();
  try {
    await assert.rejects(store.send(ask('bad', { from: profile('reviewer'), to: profile('reviewer') })), /不允许/);
    await store.send(ask('leader-architect', { from: profile('leader'), to: profile('architect'), nodeId: 'plan' }));
    await assert.rejects(store.send(ask('architect-leader', { from: profile('architect'), to: profile('leader'), nodeId: 'design' })), /循环/);
    for (let index = 0; index < 3; index += 1) await store.send(ask(`limit-${index}`, { nodeId: 'limited', to: user }));
    assert.ok(await store.send(ask('limit-four', { nodeId: 'limited', to: user })));
    const original = await store.send(ask('product', { nodeId: 'question', to: profile('analyst') }));
    const forwarded = await store.forward(original.id, { from: profile('analyst'), to: user, text: '请决定产品规则', dedupeKey: 'forward-product' });
    assert.equal(store.messages('flow').find(item => item.id === original.id)?.processing, 'processing');
    await assert.rejects(store.forward(forwarded.id, { from: user, to: profile('leader'), text: '再转交', dedupeKey: 'forward-again' }), /最多转交一次/);
    await store.answer(forwarded.id, { from: user, text: '按已有原型', dedupeKey: 'user-product' });
    const originalAfter = store.messages('flow').find(item => item.id === original.id)!;
    assert.equal(originalAfter.processing, 'answered');
    const back = store.messages('flow').find(item => item.type === 'back' && item.answerTo === original.id)!;
    assert.equal(back.body.text, '按已有原型');
    assert.deepEqual(back.to, profile('engineer'));
  } finally { await cleanup(); }
});

test('取消立即让待回答问题过期，不会把 ack 当回答', async () => {
  const { store, cleanup } = await fixture();
  try {
    const question = await store.send(ask('cancel', { to: user }));
    await store.acknowledge(question.id);
    await store.cancelWorkflow('flow');
    assert.equal(store.messages('flow')[0].processing, 'expired');
    assert.equal(await store.claim('flow', user), undefined);
    await assert.rejects(store.answer(question.id, { from: user, text: '晚到回答', dedupeKey: 'late' }), /过期/);
    assert.equal(store.events('flow').at(-1)?.type, 'workflow.cancel');
  } finally { await cleanup(); }
});

test('验证可向负责人补充材料，问答持久化并保留循环及身份限制', async () => {
  const { root, store, cleanup } = await fixture();
  try {
    const input = ask('verification-material', { from: profile('verifier'), to: profile('leader'), nodeId: 'verify:1', text: '请确认测试账号及原始接口证据路径' });
    const question = await store.send(input);
    assert.equal((await store.send(input)).id, question.id);
    await assert.rejects(store.send(ask('unknown-recipient', { from: profile('verifier'), to: profile('unknown-role') })), /不允许/);
    await assert.rejects(store.send(ask('verification-self', { from: profile('verifier'), to: profile('verifier') })), /不允许/);
    const forwarded = await store.forward(question.id, { from: profile('leader'), to: user, text: '现有材料缺少测试账号，请提供', dedupeKey: 'leader-user' });
    const reopened = await createAgentCollaborationStore(root);
    await assert.rejects(reopened.send(ask('verification-cycle', { from: user, to: profile('verifier') })), /循环/);
    await reopened.answer(forwarded.id, { from: user, text: '使用已有测试账号，证据见 tests/login.json', dedupeKey: 'user-material' });
    const back = reopened.messages('flow').find(item => item.type === 'back' && item.answerTo === question.id)!;
    assert.deepEqual(back.to, profile('verifier'));
    assert.equal(back.body.text, '使用已有测试账号，证据见 tests/login.json');
    assert.equal(reopened.messages('flow').find(item => item.id === question.id)?.processing, 'answered');
  } finally { await cleanup(); }
});

test('已知岗位可双向问答，仍只允许指定接收人回答并拒绝待答环路', async () => {
  const { store, cleanup } = await fixture();
  try {
    const engineer = profile('engineer'), reviewer = profile('reviewer'), verifier = profile('verifier');
    const first = await store.send(ask('review-to-author', { from: reviewer, to: engineer }));
    await assert.rejects(store.send(ask('author-to-review-while-waiting', { from: engineer, to: reviewer })), /循环/);
    await assert.rejects(store.answer(first.id, { from: verifier, text: '未经指定的回答', dedupeKey: 'wrong-answerer' }), /指定接收方/);
    const reply = await store.answer(first.id, { from: engineer, text: '实现证据在原始日志中', dedupeKey: 'author-evidence' });
    assert.deepEqual(reply.to, reviewer);
    const second = await store.send(ask('author-to-review-after-answer', { from: engineer, to: reviewer }));
    const secondReply = await store.answer(second.id, { from: reviewer, text: '核对原始日志与候选代码', dedupeKey: 'review-evidence' });
    assert.deepEqual(secondReply.to, engineer);
    assert.equal(store.messages('flow').filter(item => item.type === 'ask' && item.processing === 'answered').length, 2);
  } finally { await cleanup(); }
});

test('转交请求重试保留已经回答或过期的原问题终态', async () => {
  const { root, store, cleanup } = await fixture();
  let current = store;
  try {
    for (const terminal of ['answered', 'expired'] as const) {
      const original = await current.send(ask(`original-${terminal}`, { to: profile('analyst') }));
      const input = { from: profile('analyst'), to: user, text: '请确认产品规则', dedupeKey: `forward-${terminal}` };
      const forwarded = await current.forward(original.id, input);
      if (terminal === 'answered') await current.answer(forwarded.id, { from: user, text: '按原型', dedupeKey: 'confirmed-answer' });
      else await current.cancelWorkflow('flow');
      const reopened = await createAgentCollaborationStore(root);
      current = reopened;
      const count = reopened.messages('flow').length;
      assert.equal((await reopened.forward(original.id, input)).id, forwarded.id);
      assert.equal(reopened.messages('flow').find(message => message.id === original.id)?.processing, terminal);
      assert.equal(reopened.messages('flow').length, count);
      await assert.rejects(reopened.forward(original.id, { ...input, text: '不同内容' }), /不同内容/);
      assert.equal(reopened.messages('flow').find(message => message.id === original.id)?.processing, terminal);
    }
  } finally { await cleanup(); }
});

test('派发只计数不设上限，重启按相同 stageKey 对账，未知启动状态不自动重做', async () => {
  const { root, store, cleanup } = await fixture();
  try {
    const first = await store.reserveDispatch({ workflowId: 'flow', stageKey: 'implement:0', attempt: 1, limit: 3 });
    assert.equal((await store.reserveDispatch({ workflowId: 'flow', stageKey: 'implement:0', attempt: 1, limit: 100 })).id, first.id);
    const second = await store.reserveDispatch({ workflowId: 'flow', stageKey: 'verify:0', attempt: 1, limit: 100 });
    await store.markStarted(second.id);
    const third = await store.reserveDispatch({ workflowId: 'flow', stageKey: 'review:0', attempt: 1, limit: 100 });
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'collaboration-state.json'), 'utf8'));
    persisted.budgets.flow.limit = 3;
    await fs.writeFile(path.join(root, 'collaboration-state.json'), JSON.stringify(persisted));
    const reopened = await createAgentCollaborationStore(root);
    assert.equal(reopened.snapshot().budgets.flow.limit, null);
    const result = await reopened.reconcileIntents('flow', async intent => intent.id === first.id ? { kind: 'found', runId: 'run-1' }
      : { kind: 'absent' });
    assert.deepEqual(result.map(item => item.action), ['linked', 'needs_reconciliation', 'dispatch']);
    assert.equal(reopened.snapshot().intents.find(item => item.id === third.id)?.id, third.id);
    assert.ok(await reopened.reserveDispatch({ workflowId: 'flow', stageKey: 'replan', attempt: 1, limit: 3 }));
    await reopened.settleIntent(first.id);
    await reopened.settleIntent(first.id);
    assert.deepEqual(reopened.snapshot().budgets.flow, { reservedRuns: 3, usedRuns: 1, limit: null });
    await assert.rejects(reopened.settleIntent(second.id, true), /不能自动放弃/);
    await reopened.extendBudget('flow', 4);
    assert.ok(await reopened.reserveDispatch({ workflowId: 'flow', stageKey: 'replan', attempt: 1, limit: 100 }));
  } finally { await cleanup(); }
});

test('启动对账会核对刚入队的派发意图，已结算后再次对账不改账本', async () => {
  const { store, cleanup } = await fixture();
  try {
    const reserve = store.reserveDispatch({ workflowId: 'flow', stageKey: 'implement:0', attempt: 1, limit: null });
    const reconcile = store.reconcileIntents('flow', async () => ({ kind: 'found', runId: 'original-run' }));
    const [intent, result] = await Promise.all([reserve, reconcile]);
    assert.deepEqual(result, [{ intentId: intent.id, action: 'linked' }]);
    await store.settleIntent(intent.id);
    const revision = store.snapshot().revision;
    assert.deepEqual(await store.reconcileIntents('flow', async () => assert.fail('已结算的意图无需再次查询')), []);
    assert.equal(store.snapshot().revision, revision);
  } finally { await cleanup(); }
});

test('租约规范化、未知进程不释放、fencing 拒绝旧来源', async () => {
  const { root, store, cleanup } = await fixture();
  const workspace = path.join(root, 'workspace'), alias = path.join(root, 'alias');
  await fs.mkdir(path.join(workspace, 'nested'), { recursive: true }); await fs.symlink(workspace, alias);
  try {
    const lease = await store.acquireLease(alias, 'node-1', 'node-1');
    assert.equal(lease.path, await fs.realpath(workspace));
    await assert.rejects(store.acquireLease(workspace, 'other'), /已有写入者/);
    await assert.rejects(store.acquireLease(path.join(workspace, 'nested'), 'nested-writer'), /已有写入者/);
    const bound = await store.bindLeaseRun(workspace, 'node-1', 'run-1', lease.fencingToken);
    assert.equal(bound.ownerRunId, 'run-1');
    await store.reconcileLeases(async () => 'unknown');
    await assert.rejects(store.acquireLease(workspace, 'run-2'), /需要核对/);
    const reopened = await createAgentCollaborationStore(root);
    await assert.rejects(reopened.assertLease(alias, 'run-1', lease.fencingToken), /需要核对/);
    await reopened.reconcileLeases(async () => 'exited');
    await reopened.assertLease(workspace, 'run-1', lease.fencingToken);
    const second = await reopened.acquireLease(workspace, 'run-2');
    assert.ok(second.fencingToken > lease.fencingToken);
    await assert.rejects(reopened.assertLease(workspace, 'run-1', lease.fencingToken), /过期/);
    const unknown = await reopened.releaseLease(workspace, 'run-2', second.fencingToken, false);
    assert.equal(unknown.state, 'needs_reconciliation');
  } finally { await cleanup(); }
});

test('账本写入失败不会发布未落盘的消息或预算', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-ledger-write-fail-'));
  try {
    const store = await createAgentCollaborationStore(root, { writeJson: async () => { throw new Error('disk failed'); } });
    await assert.rejects(store.send(ask('failed')), /disk failed/);
    assert.equal(store.snapshot().messages.length, 0);
    await assert.rejects(store.reserveDispatch({ workflowId: 'flow', stageKey: 'plan', attempt: 1, limit: 1 }), /disk failed/);
    assert.deepEqual(store.snapshot().budgets, {});
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('仅归档已结束且保留超过30天的消息，预算和fencing不清零', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-ledger-archive-'));
  let current = '2026-01-01T00:00:00.000Z';
  try {
    const store = await createAgentCollaborationStore(root, { now: () => current });
    await store.send(ask('archive', { to: user }));
    const intent = await store.reserveDispatch({ workflowId: 'flow', stageKey: 'old', attempt: 1, limit: 2 });
    await store.linkIntent(intent.id, 'old-run'); await store.settleIntent(intent.id);
    assert.deepEqual(await store.archiveCompleted(['flow']), []);
    current = '2026-02-02T00:00:00.000Z';
    assert.deepEqual(await store.archiveCompleted(['flow']), ['flow']);
    assert.deepEqual(store.messages('flow'), []);
    assert.deepEqual(store.snapshot().budgets.flow, { reservedRuns: 0, usedRuns: 1, limit: null });
    const archives = await fs.readdir(path.join(root, 'collaboration-archive'));
    const archive = JSON.parse(await fs.readFile(path.join(root, 'collaboration-archive', archives[0]), 'utf8'));
    assert.equal(archive.messages[0].body.text, '接口边界如何处理？');
    assert.equal(archive.intents[0].runId, 'old-run');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

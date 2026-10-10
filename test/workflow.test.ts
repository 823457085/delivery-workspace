import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.js';
import { normalizeSource } from '../server/source.js';

const source = normalizeSource({
  revision: 7, target: { branch: 'master', remoteSha: 'target-sha' },
  items: [{
    requirementId: 'REQ-001', title: '测试需求', jiraKey: 'DEMO-1', status: 'BLOCKED',
    sourceBranch: 'feature/demo', sourceRemoteSha: 'source-sha',
    acceptanceCriteria: [{ id: 'AC-1', text: '保留证据且必须审核' }],
    pipeline: { result: '已完成两项检查', error: '真实来源缺少测试数据' },
    reviewGate: { passed: false, passedTestCaseIds: ['TC-1', 'TC-2'], missingTestCaseIds: ['TC-3'] },
  }],
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mastra-delivery-test-'));
  const service = await createService(directory, { source, delayMs: 0 });
  return { directory, service };
}

test('normalizes original facts without promoting source status or gate', () => {
  assert.equal(source.requirements[0].sourceStatus, 'BLOCKED');
  assert.equal(source.requirements[0].evidence.passed, 2);
  assert.equal(source.requirements[0].evidence.missing, 1);
  assert.equal(source.requirements[0].evidence.gatePassed, false);
  assert.equal(source.requirements[0].targetSha, 'target-sha');
  assert.throws(() => normalizeSource({ items: [] }));
});

test('real Mastra run suspends for review and finishes only after approval', async () => {
  const { service } = await fixture();
  try {
    const { runId } = await service.start('REQ-001', 'standard');
    await service.idle();
    const waiting = await service.getRun(runId);
    assert.equal(waiting.status, 'suspended');
    assert.equal(waiting.gate?.kind, 'review');
    assert.equal(waiting.steps[3].status, 'suspended');
    assert.equal(waiting.steps[4].status, 'pending');
    assert.equal(waiting.analysisMode, 'rules');
    assert.equal(waiting.checks.length, 3);
    await assert.rejects(service.resume(runId, 'retest'), /不在补测/);
    await service.resume(runId, 'approve');
    await service.idle();
    const done = await service.getRun(runId);
    assert.equal(done.status, 'success');
    assert.equal(done.steps.filter((step) => step.status === 'success').length, 6);
    assert.match(done.result, /未运行 Git 合入、推送或 Jira 回写/);
    assert.equal(done.requirement.evidence.gatePassed, false);
    await assert.rejects(service.resume(runId, 'approve'), /只有暂停/);
  } finally { await service.close(); }
});

test('missing evidence survives engine restart, cannot skip to approval', async () => {
  const { directory, service } = await fixture();
  const { runId } = await service.start('REQ-001', 'missing-evidence');
  await service.idle();
  const blocked = await service.getRun(runId);
  assert.equal(blocked.gate?.kind, 'evidence');
  assert.equal(blocked.checks.length, 3);
  assert.equal(blocked.checks.filter((check) => check.passed).length, 2);
  await assert.rejects(service.resume(runId, 'approve'), /未进入审核/);
  await service.close();

  const recovered = await createService(directory, { source, delayMs: 0 });
  try {
    const restored = await recovered.getRun(runId);
    assert.equal(restored.status, 'suspended');
    assert.deepEqual(restored.checks, blocked.checks);
    assert.equal(restored.gate?.kind, 'evidence');
    await recovered.resume(runId, 'retest');
    await recovered.idle();
    const review = await recovered.getRun(runId);
    assert.equal(review.gate?.kind, 'review');
    assert.equal(review.checks.every((check) => check.passed), true);
    await recovered.resume(runId, 'approve');
    await recovered.idle();
    assert.equal((await recovered.getRun(runId)).status, 'success');
  } finally { await recovered.close(); }
});

test('conflict creates a new reviewed round and preserves the cancelled run', async () => {
  const { service } = await fixture();
  try {
    const { runId } = await service.start('REQ-001', 'merge-conflict');
    await service.idle();
    await service.resume(runId, 'approve');
    await service.idle();
    assert.equal((await service.getRun(runId)).gate?.kind, 'conflict');
    assert.equal((await service.getRun(runId)).checks.length, 3);
    await assert.rejects(service.resume(runId, 'approve'), /未进入审核/);
    const next = await service.rework(runId);
    await service.idle();
    assert.notEqual(next.runId, runId);
    const newRun = await service.getRun(next.runId);
    assert.equal(newRun.parentRunId, runId);
    assert.equal(newRun.gate?.kind, 'review');
    const oldRun = await service.getRun(runId);
    assert.equal(oldRun.status, 'cancelled');
    assert.equal(oldRun.checks.length, 3);
    assert.equal((await service.dashboard()).runs.length, 2);
    await service.resume(next.runId, 'approve');
    await service.idle();
    assert.equal((await service.getRun(next.runId)).status, 'success');
  } finally { await service.close(); }
});

test('separate requirements and repeated rounds have independent run IDs', async () => {
  const { service } = await fixture();
  try {
    await assert.rejects(service.start('REQ-999', 'standard'), /找不到需求/);
    const [first, second] = await Promise.all([
      service.start('REQ-001', 'standard'), service.start('REQ-001', 'missing-evidence'),
    ]);
    await service.idle();
    assert.notEqual(first.runId, second.runId);
    assert.equal((await service.getRun(first.runId)).gate?.kind, 'review');
    assert.equal((await service.getRun(second.runId)).gate?.kind, 'evidence');
    assert.equal((await service.dashboard()).runs.length, 2);
  } finally { await service.close(); }
});

test('workflow run keeps its Agent conversation context and publishes realtime revisions', async () => {
  const { directory, service } = await fixture();
  const revisions: number[] = [];
  const unsubscribe = service.subscribe((revision) => revisions.push(revision));
  const context = {
    conversationId: 'conversation-1', agentRunId: 'agent-run-1', workspacePath: '/tmp/apex-admin',
    branch: 'feature/demo', provider: 'codex' as const,
  };
  try {
    const { runId } = await service.start('REQ-001', 'standard', undefined, context);
    await service.idle();
    assert.deepEqual((await service.getRun(runId)).context, context);
    assert.ok(revisions.length >= 2);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));

    await service.resume(runId, 'approve');
    await service.idle();
    assert.equal((await service.getRun(runId)).status, 'success');
    assert.ok(revisions.length >= 4);
  } finally {
    unsubscribe();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

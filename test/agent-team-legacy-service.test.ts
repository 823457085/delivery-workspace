import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTeamService, type AdvancedTeamTask } from '../server/agent-team-service.js';
import { localWorkflowWorkspace } from '../server/agent-workflow.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { emptyDeliveryEvidence, type DeliveryAcceptanceRecord } from '../shared/delivery-acceptance.js';
import type { AgentRun, AgentWorkflowSummary } from '../shared/agent-runtime.js';

type Runtime = Parameters<typeof createAgentTeamService>[1];
const at = '2026-10-26T10:00:00.000Z';
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
function readOnlyRuntime(workflows: AgentWorkflowSummary[] = [], runs: AgentRun[] = []): Runtime {
  return {
    workflows: () => workflows,
    getRun: (id: string) => runs.find(run => run.id === id),
    teamRuns: () => [],
    subscribe: () => () => {},
    health: async () => { assert.fail('读取旧流程不应刷新模型或派发'); },
    startTeamNode: async () => { assert.fail('读取旧流程不应创建第二个执行器'); },
  } as unknown as Runtime;
}

test('V1 服务投影沿用真实 Run 与人工验收来源，禁止高级控制器写入；版本变化后拒绝草稿和评测', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-legacy-service-'));
  const workspace = path.join(root, 'workspace'), directory = path.join(root, 'data');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src/value.js'), 'export const value = 2;\n');
  const snapshot = await localWorkflowWorkspace.version(workspace, ['src/value.js']);
  const evidence = emptyDeliveryEvidence();
  evidence.tests = { status: 'passed', evidence: 'npm test 退出码0，旧验证日志', sha: '' };
  for (const kind of ['browser', 'remote', 'deployment'] as const) evidence[kind] = { status: 'not_applicable', evidence: '临时函数夹具不涉及该项', sha: '' };
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const results = [
    report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '修复数值' } }),
    report({ validationEvidence: evidence, verificationCommands: ['npm test'], taskResult: { role: 'verifier', status: 'succeeded',
      acceptance: [{ id: 'AC-1', status: 'passed', evidence: '旧副本检查通过' }] } }),
    report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [] } }),
  ];
  const stages = ['implement', 'verify', 'review'] as const;
  const profiles = ['engineer', 'verifier', 'reviewer'] as const;
  const runs: AgentRun[] = ids.map((id, index) => ({ id, conversationId: index === 0 ? 'implementation-conversation' : `conversation-${index}`,
    provider: index === 2 ? 'claude' : 'codex', model: index === 2 ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    mode: index === 2 ? 'ask' : 'agent', accessMode: 'workspace', reasoningEffort: index === 1 ? 'medium' : 'high',
    objective: stages[index], workspacePath: workspace, sourceWorkspacePath: workspace, branch: '', headSha: 'a'.repeat(40),
    status: 'completed', resultReady: true, sessionId: `native-${index}`, pid: null, result: results[index], error: '', events: [],
    changedFiles: index === 0 ? [{ path: 'src/value.js', status: 'modified' }] : [],
    workflowSnapshot: snapshot, createdAt: at, updatedAt: at }));
  const workflow: AgentWorkflowSummary = { id: randomUUID(), templateId: 'engineering', parentConversationId: 'parent-conversation',
    objective: '修复数值', acceptanceCriteria: [{ id: 'AC-1', text: '数值为2' }], allowedPaths: ['src/**'], state: 'awaiting_acceptance',
    stage: 'review', round: 0, maxRounds: 2, escalated: false, reason: '等待人工验收', nextStep: '人工验收', actions: [],
    steps: ids.map((runId, index) => ({ step: index + 1, stage: stages[index], profileId: profiles[index], round: 0, runId,
      conversationId: runs[index].conversationId!, provider: runs[index].provider, model: runs[index].model,
      reasoningEffort: runs[index].reasoningEffort, status: 'completed', outcome: 'passed', reason: '旧证据通过' })),
    implementationConversationId: 'implementation-conversation', snapshot, createdAt: at, updatedAt: at };
  const canonicalId = 'agent:implementation-conversation';
  const acceptance: DeliveryAcceptanceRecord = { recordId: canonicalId, revision: 3, source: { runId: ids[0], updatedAt: at },
    checks: evidence, decision: 'accepted', summary: '历史人工验收', updatedAt: at };
  const reads: string[] = [], writes: string[] = [], original = JSON.stringify({ workflow, runs });
  const service = await createAgentTeamService(directory, readOnlyRuntime([workflow], runs), {
    readAcceptance: id => { reads.push(id); return id === canonicalId ? acceptance : undefined; },
    readLegacyAcceptanceSource: async id => { assert.equal(id, canonicalId); return { ...acceptance.source, active: false }; },
    writeJson: async relative => { writes.push(relative); },
  });
  try {
    assert.equal(service.list().length, 1);
    const task = service.getTask(workflow.id);
    assert.equal(task.legacy, true);
    assert.equal(task.state, 'accepted');
    assert.equal(task.legacyAcceptanceRecordId, canonicalId);
    assert.deepEqual(task.nodes.map(node => node.runId), ids);
    assert.equal(task.nodes[2].effectiveChoice?.model, 'claude-opus-5-5');
    const room = await service.room(workflow.id);
    assert.deepEqual(room.runs.map(run => run.id), ids, '历史 Run 从原运行器读取，不从 advanced teamRuns 猜测');
    assert.equal(room.acceptance?.revision, 3);
    assert.deepEqual(room.evidence, evidence);
    assert.equal(room.stale, false);
    const artifact = await service.readArtifact(workflow.id, ids[1]);
    assert.deepEqual(artifact, { kind: 'verify', hash: digest(results[1]), content: results[1], truncated: false });
    await assert.rejects(service.readArtifact(workflow.id, randomUUID()), /找不到已登记产物/);

    const draft = await service.draftSource(workflow.id);
    assert.equal(draft?.acceptance?.recordId, canonicalId);
    assert.equal(draft?.verification.passed, true);
    assert.equal(draft?.reviews[0].approved, true);
    const sample = await service.evaluationSample(workflow.id, 'engineer');
    assert.equal(sample.workflowId, workflow.id);
    assert.deepEqual(sample.verificationCommands, ['npm test']);

    await assert.rejects(service.plan(workflow.id, { expectedRevision: 0, action: 'confirm', requestId: 'legacy-plan' }), /V1.*只读/);
    await assert.rejects(service.decide(workflow.id, { action: 'retry', requestId: 'legacy-retry' }), /V1.*只读/);
    await assert.rejects(service.answer(workflow.id, { correlationId: 'question', text: '回答原文', requestId: 'legacy-answer' }), /V1.*只读/);
    assert.ok(reads.length > 0 && reads.every(id => id === canonicalId), '所有读取均复用原验收记录');
    assert.equal(writes.includes('agent-runtimes/team-tasks.json'), false, '只读投影不迁移或重写旧流程');
    assert.equal(service.ledger.snapshot().intents.length, 0);
    assert.equal(JSON.stringify({ workflow, runs }), original);

    await fs.writeFile(path.join(workspace, 'src/value.js'), 'export const value = 3;\n');
    assert.equal((await service.acceptanceSource(workflow.id))?.active, true);
    assert.equal(await service.draftSource(workflow.id), undefined);
    await assert.rejects(service.evaluationSample(workflow.id, 'engineer'), /当前版本已人工验收/);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('产物读取限制到登记的任务目录并核对哈希，拒绝篡改文件与跨目录符号链接', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-artifact-reader-'));
  const id = randomUUID(), directory = path.join(root, 'data'), artifactRoot = path.join(directory, 'team-artifacts', id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const content = 'L987654\n原文检查日志', file = path.join(artifactRoot, 'result.json');
  await fs.writeFile(file, content);
  const outside = path.join(root, 'outside.json'), link = path.join(artifactRoot, 'external.json');
  await fs.writeFile(outside, 'private outside content'); await fs.symlink(outside, link);
  const longContent = 'a'.repeat(300001), longFile = path.join(artifactRoot, 'long.json');
  await fs.writeFile(longFile, longContent);
  const artifactIds = [randomUUID(), randomUUID(), randomUUID()];
  const task: AdvancedTeamTask = { id, parentConversationId: id, sourceWorkspacePath: root, objective: '只读产物夹具', attachmentIds: [],
    profileConfig: defaultTeamProfileConfig(), nodes: [], state: 'cancelled', planRevision: 0, round: 0, maxRounds: 2,
    createdAt: at, updatedAt: at, budgetLimit: 10, reverifyCount: 0, requestIds: {}, upgradedProfiles: [],
    artifacts: [file, link, longFile].map((entry, index) => ({ id: artifactIds[index], kind: 'tests', path: entry,
      hash: digest([content, 'private outside content', longContent][index]), createdAt: at, nodeId: 'fixture-node' })) };
  await fs.writeFile(path.join(directory, 'team-tasks.json'), JSON.stringify({ version: 1, revision: 1, tasks: [task] }));
  const service = await createAgentTeamService(directory, readOnlyRuntime());
  try {
    assert.deepEqual(await service.readArtifact(id, artifactIds[0]), { kind: 'tests', hash: digest(content), content, truncated: false });
    await assert.rejects(service.readArtifact(id, randomUUID()), /找不到已登记产物/);
    await assert.rejects(service.readArtifact(id, artifactIds[1]), /产物路径越界/);
    const truncated = await service.readArtifact(id, artifactIds[2]);
    assert.equal(truncated.content.length, 300000);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.hash, digest(longContent), '哈希核对完整内容后才截断显示');
    await fs.writeFile(file, 'modified after registration');
    await assert.rejects(service.readArtifact(id, artifactIds[0]), /哈希不匹配/);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createAgentEvalService, blindAgentEvaluationMaterials, type AgentEvaluationSample, type AgentEvaluationResult } from '../server/agent-eval.js';
import { localWorkflowWorkspace } from '../server/agent-workflow.js';
const exec = promisify(execFile);

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-eval-')), sourcePath = path.join(directory, 'source');
  await fs.mkdir(sourcePath); await fs.writeFile(path.join(sourcePath, 'value.txt'), 'base');
  await exec('git', ['-C', sourcePath, 'init', '-q', '-b', 'main']); await exec('git', ['-C', sourcePath, 'add', '.']);
  await exec('git', ['-C', sourcePath, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const baseHead = (await exec('git', ['-C', sourcePath, 'rev-parse', 'HEAD'])).stdout.trim();
  // 接受后的当前工作区有脏文件；评测必须仍从固定base起步。
  await fs.writeFile(path.join(sourcePath, 'value.txt'), 'current-uncommitted');
  const sample: AgentEvaluationSample = { id: 'sample-1', workflowId: 'flow-1', status: 'accepted', sourcePath, baseHead,
    objective: '修改值', acceptanceCriteria: [{ id: 'AC-1', text: '值正确' }], allowedPaths: ['value.txt'], rolePrompt: '只改值，运行验证',
    verificationCommands: ['node verify.mjs'], knownFindingIds: ['known-1'] };
  return { directory, sourcePath, sample, models: [{ provider: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    { provider: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'high' }] as const };
}
const passed = (): AgentEvaluationResult => ({ passed: true, acceptance: [{ id: 'AC-1', status: 'passed', evidence: '验证通过' }], reworkRounds: 0,
  verificationCommands: ['node verify.mjs'], verificationPassed: true, reviewApproved: true,
  findings: [{ id: 'F-1', problem: '发现已知问题', knownFindingId: 'known-1', annotation: 'true_issue' }], evidence: ['verify.log'] });

test('成对评测固定base、相同验证命令、独立副本和盲审，人工标注不采信模型自报', async () => {
  const { directory, sourcePath, sample, models } = await fixture();
  const paths: string[] = [], calls: string[] = [];
  const service = await createAgentEvalService(path.join(directory, 'data'), { runSample: async context => {
    assert.equal(await fs.readFile(path.join(context.workspacePath, 'value.txt'), 'utf8'), 'base');
    assert.deepEqual(context.sample.verificationCommands, sample.verificationCommands);
    assert.equal(JSON.stringify(context.blindReviewMaterials).includes('gpt-6'), false);
    assert.equal('sourcePath' in context.blindReviewMaterials, false);
    paths.push(context.workspacePath); calls.push(context.model.model);
    await fs.writeFile(path.join(context.workspacePath, 'value.txt'), context.model.model);
    return passed();
  } });
  try {
    const input = { requestId: 'request-1', confirmed: true as const, samples: [sample], models: [...models] as [typeof models[0], typeof models[1]] };
    const [created, duplicate] = await Promise.all([service.create(input), service.create(input)]);
    assert.equal(created.id, duplicate.id);
    const result = await service.run(created.id);
    assert.equal(result.status, 'completed');
    assert.notEqual(paths[0], paths[1]);
    assert.deepEqual(calls, models.map(model => model.model));
    assert.equal(await fs.readFile(path.join(sourcePath, 'value.txt'), 'utf8'), 'current-uncommitted');
    for (const target of paths) await assert.rejects(fs.access(target));
    assert.equal(service.metrics(created.id)[0].firstPassRate, 1);
    assert.equal(service.metrics(created.id)[0].trueIssues, 0);
    assert.equal(service.metrics(created.id)[0].unannotated, 1);
    await service.annotate(created.id, result.variants[0].id, 'F-1', 'true_issue', '已人工核对');
    assert.equal(service.metrics(created.id)[0].trueIssues, 1);
    assert.equal(service.metrics(created.id)[0].knownDetected, 1);
    assert.match(result.recommendation || '', /系统未自动更改配置/);
    assert.equal((await service.run(created.id)).status, 'completed');
    assert.equal(calls.length, 2, '已完成评测不会重复调用模型');
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('评测确认/样本门禁与失败清理，重启的未知运行不自动重放', async () => {
  const { directory, sample, models } = await fixture();
  const data = path.join(directory, 'data');
  const service = await createAgentEvalService(data, { runSample: async () => { throw new Error('环境不可用'); } });
  try {
    const input = { requestId: 'request-2', confirmed: true as const, samples: [sample], models: [...models] as [typeof models[0], typeof models[1]] };
    await assert.rejects(service.create({ ...input, confirmed: false as true }), /人工确认/);
    await assert.rejects(service.create({ ...input, samples: Array.from({ length: 11 }, (_, id) => ({ ...sample, id: `${id}` })) }), /1 至 10/);
    await assert.rejects(service.create({ ...input, samples: [{ ...sample, status: 'pending' as 'accepted' }] }), /已验收/);
    const created = await service.create(input), failed = await service.run(created.id);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(await fs.readdir(path.join(data, 'evaluation-workspaces')), []);
    await service.close();
    const file = path.join(data, 'agent-evaluations.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.records[0].status = 'running'; saved.records[0].variants[0].status = 'running';
    await fs.writeFile(file, JSON.stringify(saved));
    let calls = 0;
    const reopened = await createAgentEvalService(data, { runSample: async context => { calls += 1; assert.equal(context.attempt, 2); return passed(); }, reconcileVariant: async () => 'safe' });
    assert.equal(reopened.get(created.id).status, 'needs_reconciliation');
    await assert.rejects(reopened.run(created.id), /不自动重放/);
    assert.equal(calls, 0);
    assert.equal((await reopened.run(created.id, { confirmedResume: true })).status, 'completed');
    await reopened.close();
    const blind = blindAgentEvaluationMaterials({ objective: '原始目标', diff: 'actual code', model: 'secret-model', author: { provider: 'claude' } });
    assert.deepEqual(blind, { objective: '原始目标', diff: 'actual code' });
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('审查评测持久绑定已验收补丁，两模型读取相同候选而非旧base；缺失或不符时不调用runner', async () => {
  const { directory, sourcePath, sample, models } = await fixture();
  const candidatePatch = await localWorkflowWorkspace.diff(sourcePath, sample.baseHead);
  const candidate = await localWorkflowWorkspace.version(sourcePath, []);
  const reviewSample = { ...sample, profileId: 'reviewer', candidatePatch, candidatePatchHash: createHash('sha256').update(candidatePatch).digest('hex'), candidate };
  const beforeIndex = await fs.readFile(path.join(sourcePath, '.git', 'index'));
  const paths: string[] = [];
  const service = await createAgentEvalService(path.join(directory, 'data'), { runSample: async context => {
    paths.push(context.workspacePath);
    assert.equal(await fs.readFile(path.join(context.workspacePath, 'value.txt'), 'utf8'), 'current-uncommitted');
    assert.equal((await localWorkflowWorkspace.version(context.workspacePath, [])).value, candidate.value);
    assert.equal(context.sample.candidatePatchHash, reviewSample.candidatePatchHash);
    return passed();
  } });
  try {
    const input = { requestId: 'review-pair', confirmed: true as const, samples: [reviewSample], models: [...models] as [typeof models[0], typeof models[1]] };
    await assert.rejects(service.create({ ...input, samples: [{ ...reviewSample, candidatePatch: '' }] }), /非空候选补丁/);
    await assert.rejects(service.create({ ...input, samples: [{ ...reviewSample, candidatePatchHash: '0'.repeat(64) }] }), /SHA256/);
    await assert.rejects(service.create({ ...input, samples: [{ ...reviewSample, candidate: undefined }] }), /候选版本/);
    const created = await service.create(input);
    assert.equal((await service.run(created.id)).status, 'completed');
    assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
    const metrics = service.metrics(created.id);
    assert.ok(metrics.every(item => item.firstPassRate === null && item.acceptanceRate === null), '审查评测不把AC未执行显示成实现失败率');
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'data/agent-evaluations.json'), 'utf8'));
    assert.equal(stored.records[0].samples[0].candidatePatch, candidatePatch);
    assert.equal(stored.records[0].samples[0].candidatePatchHash, reviewSample.candidatePatchHash);
    const mismatch = await service.create({ ...input, requestId: 'review-mismatch', samples: [{ ...reviewSample, candidate: { ...candidate, value: 'a'.repeat(40) } }] });
    const failed = await service.run(mismatch.id);
    assert.ok(failed.variants.every(variant => variant.status === 'failed' && /候选版本.*不符/.test(variant.error || '')));
    assert.equal(paths.length, 2, '版本不符在任何模型runner之前阻断');
    assert.equal(await fs.readFile(path.join(sourcePath, 'value.txt'), 'utf8'), 'current-uncommitted');
    assert.deepEqual(await fs.readFile(path.join(sourcePath, '.git', 'index')), beforeIndex);
    assert.deepEqual(await fs.readdir(path.join(directory, 'data/evaluation-workspaces')), []);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureIntegrationSource, createAgentCandidate, resolveCandidateConflict, finalizeCandidate, removeAgentCandidate } from '../server/agent-integration.js';
import { createAgentCollaborationStore } from '../server/agent-collaboration.js';

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec('git', ['-C', root, ...args], { maxBuffer: 5_000_000 })).stdout.trim();
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-integration-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  for (const name of ['server.js', 'frontend.js', 'shared.js', 'third.js']) await fs.writeFile(path.join(repo, name), `export const value = '${name}:base';\n`);
  await fs.writeFile(path.join(repo, '.gitignore'), '.delivery-artifacts/\n');
  await git(repo, 'add', '.'); await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '初始化临时集成测试');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const one = path.join(root, 'one'), two = path.join(root, 'two'), three = path.join(root, 'three');
  for (const workspace of [one, two, three]) await git(repo, 'worktree', 'add', '--detach', workspace, base);
  return { root, repo, base, one, two, three, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const ownership = [{ owner: 'engineer', paths: ['server.js', 'shared.js', 'third.js'] }, { owner: 'frontend', paths: ['frontend.js'] }];

test('真实 Git 并行改动集成为统一候选，来源文件与真实索引不变', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.one, 'server.js'), "export const value = 'engineer';\n");
    await fs.writeFile(path.join(f.two, 'frontend.js'), "export const value = 'frontend';\n");
    const originalIndex = await fs.readFile(await git(f.one, 'rev-parse', '--git-path', 'index'));
    const first = await captureIntegrationSource({ workspacePath: f.one, baseHead: f.base, runId: 'run-a', profileId: 'engineer' });
    const second = await captureIntegrationSource({ workspacePath: f.two, baseHead: f.base, runId: 'run-b', profileId: 'frontend' });
    assert.deepEqual(await fs.readFile(await git(f.one, 'rev-parse', '--git-path', 'index')), originalIndex);
    const candidate = await createAgentCandidate({ repositoryPath: f.repo, targetPath: path.join(f.root, 'candidate'), workflowId: 'flow', round: 0,
      baseHead: f.base, sources: [first, second], ownership });
    assert.ok(candidate.final.tree);
    assert.deepEqual(candidate.integration.appliedOrder, ['run-a', 'run-b']);
    assert.deepEqual(candidate.integration.conflicts, []);
    assert.equal(await fs.readFile(path.join(candidate.integration.worktree, 'server.js'), 'utf8'), "export const value = 'engineer';\n");
    assert.equal(await fs.readFile(path.join(candidate.integration.worktree, 'frontend.js'), 'utf8'), "export const value = 'frontend';\n");
    assert.equal(await git(f.repo, 'status', '--porcelain'), '', '原项目不变');
    assert.equal(await fs.readFile(path.join(f.one, 'frontend.js'), 'utf8'), "export const value = 'frontend.js:base';\n");
    assert.equal(await git(candidate.integration.worktree, 'rev-parse', 'HEAD'), f.base, '集成没有创建提交');
    await removeAgentCandidate(candidate);
    await assert.rejects(fs.access(candidate.integration.worktree));
  } finally { await f.cleanup(); }
});

test('冲突只交给文件负责人，解决后继续集成其余来源并绑定新树', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.one, 'shared.js'), "export const value = 'from-a';\n");
    await fs.writeFile(path.join(f.two, 'shared.js'), "export const value = 'from-b';\n");
    await fs.writeFile(path.join(f.three, 'third.js'), "export const value = 'third';\n");
    const sources = await Promise.all([f.one, f.two, f.three].map((workspacePath, index) => captureIntegrationSource({ workspacePath, baseHead: f.base,
      runId: `run-${index}`, profileId: index === 1 ? 'frontend' : 'engineer' })));
    const candidate = await createAgentCandidate({ repositoryPath: f.repo, targetPath: path.join(f.root, 'candidate'), workflowId: 'flow', round: 1,
      baseHead: f.base, sources, ownership, shared: [{ path: 'shared.js', owner: 'engineer' }], supersedes: 'candidate-old' });
    assert.equal(candidate.final.tree, '');
    assert.deepEqual(candidate.integration.pendingRunIds, ['run-2']);
    assert.equal(candidate.integration.conflicts[0].path, 'shared.js');
    assert.equal(candidate.integration.conflicts[0].owner, 'engineer');
    await assert.rejects(resolveCandidateConflict(candidate, { owner: 'frontend', runId: 'wrong-author', paths: ['shared.js'] }), /负责人/);
    await assert.rejects(finalizeCandidate(candidate, { ownership }), /未解决冲突/);
    await assert.rejects(resolveCandidateConflict(candidate, { owner: 'engineer', runId: 'resolve', paths: ['shared.js'] }), /标记/);
    await fs.writeFile(path.join(candidate.integration.worktree, 'shared.js'), "export const value = 'resolved';\n");
    const resolved = await resolveCandidateConflict(candidate, { owner: 'engineer', runId: 'resolve', paths: ['shared.js'] });
    const finalized = await finalizeCandidate(resolved, { ownership });
    assert.ok(finalized.final.tree);
    assert.equal(finalized.supersedes, 'candidate-old');
    assert.equal(finalized.integration.conflicts[0].resolvedByRunId, 'resolve');
    assert.deepEqual(finalized.integration.appliedOrder, ['run-0', 'run-1', 'run-2']);
    assert.equal(await fs.readFile(path.join(finalized.integration.worktree, 'third.js'), 'utf8'), "export const value = 'third';\n");
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('旧 fencing token 或被篡改补丁在创建候选之前被拒绝', async () => {
  const f = await fixture();
  try {
    const ledger = await createAgentCollaborationStore(path.join(f.root, 'state'));
    const lease = await ledger.acquireLease(f.one, 'run-one');
    await fs.writeFile(path.join(f.one, 'server.js'), "export const value = 'one';\n");
    const source = await captureIntegrationSource({ workspacePath: f.one, baseHead: f.base, runId: 'run-one', profileId: 'engineer',
      lease: { path: lease.path, ownerRunId: lease.ownerRunId, fencingToken: lease.fencingToken } });
    await ledger.releaseLease(f.one, 'run-one', lease.fencingToken, true);
    await ledger.acquireLease(f.one, 'run-two');
    const targetPath = path.join(f.root, 'candidate');
    await assert.rejects(createAgentCandidate({ repositoryPath: f.repo, targetPath, workflowId: 'flow', round: 0, baseHead: f.base, sources: [source], ownership,
      assertLease: item => ledger.assertLease(item.path, item.ownerRunId, item.fencingToken) }), /过期/);
    await assert.rejects(fs.access(targetPath));
    await assert.rejects(createAgentCandidate({ repositoryPath: f.repo, targetPath, workflowId: 'flow', round: 0, baseHead: f.base,
      sources: [{ ...source, patch: `${source.patch}\nforged` }], ownership }), /哈希/);
    await assert.rejects(fs.access(targetPath));
  } finally { await f.cleanup(); }
});

test('非 Git 和不同 base 明确拒绝，冲突处理越界不能生成 final.tree', async () => {
  const f = await fixture();
  try {
    const plain = path.join(f.root, 'plain'); await fs.mkdir(plain);
    await assert.rejects(captureIntegrationSource({ workspacePath: plain, baseHead: f.base, runId: 'plain', profileId: 'engineer' }), /只支持 Git/);
    await fs.writeFile(path.join(f.one, 'server.js'), "export const value = 'one';\n");
    const source = await captureIntegrationSource({ workspacePath: f.one, baseHead: f.base, runId: 'one', profileId: 'engineer' });
    await assert.rejects(createAgentCandidate({ repositoryPath: f.repo, targetPath: path.join(f.root, 'wrong-base'), workflowId: 'flow', round: 0,
      baseHead: f.base, sources: [{ ...source, baseHead: 'a'.repeat(40) }], ownership }), /同一 base/);
    const candidate = await createAgentCandidate({ repositoryPath: f.repo, targetPath: path.join(f.root, 'candidate'), workflowId: 'flow', round: 0,
      baseHead: f.base, sources: [source], ownership });
    await fs.writeFile(path.join(candidate.integration.worktree, 'outside.js'), 'unexpected');
    await assert.rejects(finalizeCandidate(candidate, { ownership }), /超出候选来源/);
  } finally { await f.cleanup(); }
});

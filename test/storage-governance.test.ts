import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStorageGovernance, createStorageGovernanceRoutes } from '../server/storage-governance.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';

test('存储治理扫描与清理：无损保留活跃任务、交付报告、历史验证证据与源码提交，仅回收缓存与孤儿副本', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-gov-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1. team-artifacts: 活跃任务、已完成任务（含报告 + node_modules 膨胀）、孤儿任务
  const activeArtifactCache = path.join(root, 'team-artifacts', 'task-active', 'node_modules', 'pkg.js');
  const settledReport = path.join(root, 'team-artifacts', 'task-done', 'report.json');
  const settledBloat = path.join(root, 'team-artifacts', 'task-done', 'logs', 'Cache', 'blob.bin');
  const settledDistBloat = path.join(root, 'team-artifacts', 'task-done', 'logs', 'round-3', 'dist', 'bundle.js');
  const settledViteCandidate = path.join(root, 'team-artifacts', 'task-done', 'logs', 'candidate');
  const nodeLogsName = '802c7559-f31d-47c4-ad8b-ff5d1bc9585e-logs';
  const nodeLogsDir = path.join(root, 'team-artifacts', 'task-done', nodeLogsName);
  const nodeKeptLog = path.join(nodeLogsDir, 'kept', 'check.log');
  const nodeInheritedBloat = path.join(nodeLogsDir, 'inherited-stale', 'old.json');
  const nodeLogsManifest = path.join(root, 'team-artifacts', 'task-done', `${nodeLogsName}-${'a'.repeat(64)}.json`);
  const orphanArtifact = path.join(root, 'team-artifacts', 'task-deleted', 'stale.bin');
  await fs.mkdir(path.dirname(activeArtifactCache), { recursive: true });
  await fs.mkdir(path.dirname(settledBloat), { recursive: true });
  await fs.mkdir(path.dirname(settledDistBloat), { recursive: true });
  await fs.mkdir(path.join(settledViteCandidate, 'assets'), { recursive: true });
  await fs.mkdir(path.dirname(nodeKeptLog), { recursive: true });
  await fs.mkdir(path.dirname(nodeInheritedBloat), { recursive: true });
  await fs.mkdir(path.dirname(orphanArtifact), { recursive: true });
  await fs.writeFile(activeArtifactCache, 'x'.repeat(2048));
  await fs.writeFile(settledReport, '{"ok":true}');
  await fs.writeFile(settledBloat, 'b'.repeat(8192));
  await fs.writeFile(settledDistBloat, 'u'.repeat(4096));
  await fs.writeFile(path.join(settledViteCandidate, 'workspace-version.json'), '{"id":"temp"}');
  await fs.writeFile(path.join(settledViteCandidate, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(settledViteCandidate, 'assets', 'app.js'), 'v'.repeat(4096));
  await fs.writeFile(nodeKeptLog, 'KEPT_NODE_LOG');
  await fs.writeFile(nodeInheritedBloat, 'i'.repeat(8192));
  await fs.writeFile(nodeLogsManifest, JSON.stringify({ directory: nodeLogsDir, files: ['kept/check.log'] }));
  const agedSec = Math.floor((Date.now() - 48 * 3600_000) / 1000);
  await fs.utimes(nodeLogsManifest, agedSec, agedSec);
  await fs.writeFile(orphanArtifact, 'o'.repeat(4096));

  // 2. group-verifications: 已完成验证轮次（含工作树与 .delivery-artifacts 证据）与活跃轮次
  const doneVerifyEvidence = path.join(root, 'group-verifications', 'run-done', 'workspace', '.delivery-artifacts', 'check.log');
  const doneVerifyWorktreeFile = path.join(root, 'group-verifications', 'run-done', 'workspace', 'node_modules', 'heavy.js');
  const activeVerifyFile = path.join(root, 'group-verifications', 'run-active', 'workspace', 'src.ts');
  await fs.mkdir(path.dirname(doneVerifyEvidence), { recursive: true });
  await fs.mkdir(path.dirname(doneVerifyWorktreeFile), { recursive: true });
  await fs.mkdir(path.dirname(activeVerifyFile), { recursive: true });
  await fs.writeFile(doneVerifyEvidence, 'PASSED');
  await fs.writeFile(doneVerifyWorktreeFile, 'v'.repeat(16384));
  await fs.writeFile(activeVerifyFile, 'export const live = 1;');

  // 3. workspaces & team-workspaces: 现有会话工作树、孤儿工作树、已完结团队副本与已完结独立工作流副本（含源码 + node_modules + dist）
  const referencedConvWorktree = path.join(root, 'workspaces', 'conv-1');
  const finishedIsolatedCopy = path.join(root, 'workspaces', 'workflow-done');
  const orphanWorktree = path.join(root, 'workspaces', 'orphan-conv');
  const keptSessionDir = path.join(root, 'sessions', 'session-kept');
  const orphanSessionDir = path.join(root, 'sessions', 'session-orphan');
  const emptyOrphanSessionDir = path.join(root, 'sessions', 'session-empty-orphan');
  const finishedTeamCopy = path.join(root, 'team-workspaces', 'node-done');
  await fs.mkdir(path.join(referencedConvWorktree, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(finishedIsolatedCopy, 'src'), { recursive: true });
  await fs.mkdir(path.join(finishedIsolatedCopy, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(finishedIsolatedCopy, 'dist'), { recursive: true });
  await fs.mkdir(orphanWorktree, { recursive: true });
  await fs.mkdir(keptSessionDir, { recursive: true });
  await fs.mkdir(orphanSessionDir, { recursive: true });
  await fs.mkdir(emptyOrphanSessionDir, { recursive: true });
  await fs.mkdir(path.join(finishedTeamCopy, 'src'), { recursive: true });
  await fs.mkdir(path.join(finishedTeamCopy, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(referencedConvWorktree, 'node_modules', 'keep.js'), 'k'.repeat(4096));
  await fs.writeFile(path.join(finishedIsolatedCopy, 'src', 'main.ts'), 'export const ok = 1;');
  await fs.writeFile(path.join(finishedIsolatedCopy, 'node_modules', 'heavy.js'), 'h'.repeat(4096));
  await fs.writeFile(path.join(finishedIsolatedCopy, 'dist', 'bundle.js'), 'd'.repeat(4096));
  await fs.writeFile(path.join(orphanWorktree, 'orphan.txt'), 'z'.repeat(4096));
  await fs.writeFile(path.join(keptSessionDir, 'notes.md'), 'KEPT_SESSION_NOTE');
  await fs.writeFile(path.join(orphanSessionDir, 'stale.bin'), 's'.repeat(16384));
  await fs.writeFile(path.join(finishedTeamCopy, 'src', 'index.ts'), 'export const preserved = true;');
  await fs.writeFile(path.join(finishedTeamCopy, 'node_modules', 'dep.js'), 'd'.repeat(8192));

  await fs.writeFile(path.join(root, 'agent-runs.json'), '[]');

  // 4. browserAndRetestCaches: 已停止/运行中本地复测 + 空闲/活跃浏览器配置（验证 Cookie 与源码 100% 无损）
  const stoppedRetestDir = path.join(root, 'refactor-control', 'local-retests', 'retest-stopped');
  const runningRetestDir = path.join(root, 'refactor-control', 'local-retests', 'retest-running');
  await fs.mkdir(path.join(stoppedRetestDir, 'workspace', 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(stoppedRetestDir, 'workspace', 'src'), { recursive: true });
  await fs.mkdir(path.join(runningRetestDir, 'workspace', 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(stoppedRetestDir, 'runtime.json'), JSON.stringify({ state: 'stopped' }));
  await fs.writeFile(path.join(stoppedRetestDir, 'workspace', 'src', 'app.ts'), 'export const clean = 1;');
  await fs.writeFile(path.join(stoppedRetestDir, 'workspace', 'node_modules', 'bundle.js'), 'r'.repeat(8192));
  await fs.writeFile(path.join(runningRetestDir, 'runtime.json'), JSON.stringify({ state: 'running' }));
  await fs.writeFile(path.join(runningRetestDir, 'workspace', 'node_modules', 'live.js'), 'l'.repeat(8192));

  const idleProfileDir = path.join(root, 'agent-browser', 'profiles', 'profile-idle');
  const activeProfileDir = path.join(root, 'agent-browser', 'profiles', 'profile-active');
  await fs.mkdir(path.join(idleProfileDir, 'optimization_guide_model_store'), { recursive: true });
  await fs.mkdir(path.join(idleProfileDir, 'Default', 'Code Cache'), { recursive: true });
  await fs.mkdir(path.join(idleProfileDir, 'Default', 'Service Worker', 'CacheStorage'), { recursive: true });
  await fs.mkdir(path.join(idleProfileDir, 'Default', 'Local Storage'), { recursive: true });
  await fs.writeFile(path.join(idleProfileDir, 'optimization_guide_model_store', 'model.bin'), 'm'.repeat(8192));
  await fs.writeFile(path.join(idleProfileDir, 'Default', 'Code Cache', 'wasm.bin'), 'c'.repeat(4096));
  await fs.writeFile(path.join(idleProfileDir, 'Default', 'Service Worker', 'CacheStorage', 'entry.bin'), 's'.repeat(2048));
  await fs.writeFile(path.join(idleProfileDir, 'Default', 'Cookies'), 'SESSION_COOKIE_PRESERVED');
  await fs.writeFile(path.join(idleProfileDir, 'Default', 'Local Storage', 'state.ldb'), 'LOCAL_STORAGE_PRESERVED');
  // 模拟已退出的历史 Chrome 遗留的陈旧 SingletonLock 软链（超大不存在 PID）
  await fs.symlink(`${os.hostname()}-99999999`, path.join(idleProfileDir, 'SingletonLock'));

  await fs.mkdir(path.join(activeProfileDir, 'optimization_guide_model_store'), { recursive: true });
  await fs.writeFile(path.join(activeProfileDir, 'optimization_guide_model_store', 'active.bin'), 'a'.repeat(8192));
  // 绑定当前存活进程 PID，模拟正在运行中的浏览器配置
  await fs.symlink(`${os.hostname()}-${process.pid}`, path.join(activeProfileDir, 'SingletonLock'));

  const governance = createStorageGovernance(root, {
    activeTaskIds: () => new Set(['task-active']),
    knownTaskIds: () => new Set(['task-active', 'task-done']),
    activeRunIds: () => new Set(['run-active']),
    activeWorkspacePaths: () => new Set(),
    knownWorkspacePaths: () => new Set([referencedConvWorktree, finishedIsolatedCopy, finishedTeamCopy, keptSessionDir]),
    knownGroupVerifications: () => new Map([
      ['run-done', { runId: 'run-done', workspacePath: path.join(root, 'group-verifications', 'run-done', 'workspace'), sourceWorkspacePath: '' }],
    ]),
    finishedTeamWorkspaces: () => [
      { workspacePath: finishedTeamCopy, updatedAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
      { workspacePath: finishedIsolatedCopy, updatedAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
    ],
  });

  const before = await governance.scan({ force: true, minAgeHours: 24 });
  assert.ok(before.reclaimableBytes >= 8192 + 4096 + 16384 + 4096 + 8192);
  assert.equal(before.ledgers.some(item => item.name === 'agent-runs.json'), true);

  const reclaimed = await governance.reclaim({
    artifactBloat: true,
    verificationWorktrees: true,
    orphanWorkspaces: true,
    finishedTeamDependencies: true,
    browserAndRetestCaches: true,
    minAgeHours: 24,
  });
  assert.equal(reclaimed.reclaimedItems >= 9, true);
  assert.equal(reclaimed.report.reclaimableBytes, 0);

  // 验证受保护文件 100% 完好，膨胀目录与孤儿目录已被精确移除
  assert.equal(await fs.readFile(activeArtifactCache, 'utf8'), 'x'.repeat(2048));
  assert.equal(await fs.readFile(settledReport, 'utf8'), '{"ok":true}');
  await assert.rejects(fs.stat(settledBloat));
  await assert.rejects(fs.stat(settledDistBloat));
  await assert.rejects(fs.stat(settledViteCandidate));
  assert.equal(await fs.readFile(nodeKeptLog, 'utf8'), 'KEPT_NODE_LOG');
  assert.equal((await fs.stat(nodeLogsManifest)).isFile(), true);
  await assert.rejects(fs.stat(path.dirname(nodeInheritedBloat)));
  await assert.rejects(fs.stat(orphanArtifact));

  assert.equal(await fs.readFile(doneVerifyEvidence, 'utf8'), 'PASSED');
  await assert.rejects(fs.stat(doneVerifyWorktreeFile));
  assert.equal(await fs.readFile(activeVerifyFile, 'utf8'), 'export const live = 1;');

  assert.equal(await fs.readFile(path.join(referencedConvWorktree, 'node_modules', 'keep.js'), 'utf8'), 'k'.repeat(4096));
  assert.equal(await fs.readFile(path.join(finishedIsolatedCopy, 'src', 'main.ts'), 'utf8'), 'export const ok = 1;');
  await assert.rejects(fs.stat(path.join(finishedIsolatedCopy, 'node_modules')));
  await assert.rejects(fs.stat(path.join(finishedIsolatedCopy, 'dist')));
  await assert.rejects(fs.stat(orphanWorktree));
  assert.equal(await fs.readFile(path.join(keptSessionDir, 'notes.md'), 'utf8'), 'KEPT_SESSION_NOTE');
  await assert.rejects(fs.stat(orphanSessionDir));
  await assert.rejects(fs.stat(emptyOrphanSessionDir));
  assert.equal(await fs.readFile(path.join(finishedTeamCopy, 'src', 'index.ts'), 'utf8'), 'export const preserved = true;');
  await assert.rejects(fs.stat(path.join(finishedTeamCopy, 'node_modules', 'dep.js')));
  assert.equal(await fs.readFile(path.join(root, 'agent-runs.json'), 'utf8'), '[]');

  // 已停止复测瘦身 node_modules 但保留源码，运行中复测不动
  assert.equal(await fs.readFile(path.join(stoppedRetestDir, 'workspace', 'src', 'app.ts'), 'utf8'), 'export const clean = 1;');
  await assert.rejects(fs.stat(path.join(stoppedRetestDir, 'workspace', 'node_modules')));
  assert.equal(await fs.readFile(path.join(runningRetestDir, 'workspace', 'node_modules', 'live.js'), 'utf8'), 'l'.repeat(8192));

  // 空闲浏览器仅清理缓存，Cookies 与 Local Storage 完好；活跃浏览器缓存不动
  assert.equal(await fs.readFile(path.join(idleProfileDir, 'Default', 'Cookies'), 'utf8'), 'SESSION_COOKIE_PRESERVED');
  assert.equal(await fs.readFile(path.join(idleProfileDir, 'Default', 'Local Storage', 'state.ldb'), 'utf8'), 'LOCAL_STORAGE_PRESERVED');
  await assert.rejects(fs.stat(path.join(idleProfileDir, 'optimization_guide_model_store')));
  await assert.rejects(fs.stat(path.join(idleProfileDir, 'Default', 'Code Cache')));
  await assert.rejects(fs.stat(path.join(idleProfileDir, 'Default', 'Service Worker', 'CacheStorage')));
  assert.equal(await fs.readFile(path.join(activeProfileDir, 'optimization_guide_model_store', 'active.bin'), 'utf8'), 'a'.repeat(8192));
});

test('存储治理路由强制校验本机回环、同源 Origin 与显式确认头', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const governance = createStorageGovernance(root, {
    activeTaskIds: () => new Set(),
    knownTaskIds: () => new Set(),
    activeRunIds: () => new Set(),
    activeWorkspacePaths: () => new Set(),
    knownWorkspacePaths: () => new Set(),
    knownGroupVerifications: () => new Map(),
    finishedTeamWorkspaces: () => [],
  });
  let status = 0;
  let bodyValue: unknown;
  const handle = createStorageGovernanceRoutes(governance, {
    port: 5288,
    json: (_res, code, value) => { status = code; bodyValue = value; },
    body: async () => ({}),
  });

  const invoke = (method: string, pathname: string, remoteAddress: string, headers: Record<string, string>) =>
    handle(
      { method, socket: { remoteAddress }, headers } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:5288${pathname}`),
    );

  // 非本机回环拒绝
  await invoke('GET', '/api/workspace/storage', '192.168.1.20', { host: '127.0.0.1:5288' });
  assert.equal(status, 403);

  // 跨源 POST 拒绝
  await invoke('POST', '/api/workspace/storage/reclaim', '127.0.0.1', {
    host: '127.0.0.1:5288',
    origin: 'https://evil.example',
    'content-type': 'application/json',
    'x-delivery-confirmed': 'yes',
  });
  assert.equal(status, 403);

  // 缺少确认头拒绝
  await invoke('POST', '/api/workspace/storage/reclaim', '127.0.0.1', {
    host: '127.0.0.1:5288',
    origin: 'http://127.0.0.1:5288',
    'content-type': 'application/json',
  });
  assert.equal(status, 403);

  // 合法确认放行
  await invoke('POST', '/api/workspace/storage/reclaim', '127.0.0.1', {
    host: '127.0.0.1:5288',
    origin: 'http://127.0.0.1:5288',
    'content-type': 'application/json',
    'x-delivery-confirmed': 'yes',
  });
  assert.equal(status, 200);
  assert.equal(typeof (bodyValue as { reclaimedBytes: number }).reclaimedBytes, 'number');
});

test('删除无项目会话时自动清理对应 sessions/<runId> 残留目录，不影响其余会话目录', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-cascade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter: AgentRuntimeAdapter = {
    id: 'codex',
    health: async () => ({
      provider: 'codex', label: 'Codex', binary: '/test/codex', version: 'test',
      authenticated: true, ready: true, message: 'ready',
      modes: ['agent', 'plan', 'ask'], models: [{ id: '', label: '默认' }],
      defaultModel: '', writable: true, checkedAt: new Date().toISOString(),
    }),
    execute: async context => {
      context.onSession(`codex-session-${context.run.id}`);
      await fs.writeFile(path.join(context.run.workspacePath, 'artifact.txt'), context.run.id);
      return 'ok';
    },
  };
  const service = await createAgentRuntimeService(root, { adapters: [adapter] });
  try {
    const first = await service.start({ provider: 'codex', model: '', mode: 'agent', objective: '会话一', workspacePath: '' });
    const second = await service.start({ provider: 'codex', model: '', mode: 'agent', objective: '会话二', workspacePath: '' });
    for (let i = 0; i < 100 && (!first.resultReady || !second.resultReady); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await fs.readFile(path.join(first.workspacePath, 'artifact.txt'), 'utf8'), first.id);
    assert.equal(await fs.readFile(path.join(second.workspacePath, 'artifact.txt'), 'utf8'), second.id);

    await service.removeConversation(first.id);
    await assert.rejects(fs.stat(first.workspacePath));
    assert.equal(await fs.readFile(path.join(second.workspacePath, 'artifact.txt'), 'utf8'), second.id);
  } finally {
    await service.close();
  }
});

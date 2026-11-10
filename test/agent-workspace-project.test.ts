import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { CodexSessionSource } from '../server/codex-session-source.js';
import type { AgentRun, CodexSessionSummary } from '../shared/agent-runtime.js';
import { agentRunContextPath, agentRunProjectPath, buildAgentConversations, buildSyncedCodexConversation } from '../src/features/agent-workbench/conversation.js';
import { workflowContext } from '../src/features/agent-workbench/agent-workflow-context.js';

const exec = promisify(execFile);
const timestamp = '2026-10-24T00:00:00.000Z';

function historicalRun(id: string, workspacePath: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
    objective: '历史工作区会话', workspacePath, branch: 'feature/legacy', headSha: '', status: 'completed',
    sessionId: '', pid: null, result: '历史结果', error: '', events: [], createdAt: timestamp, updatedAt: timestamp, ...extra };
}

function fixtureAdapter(executed: AgentRun[]): AgentRuntimeAdapter {
  return { id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture', binary: '', version: '',
    authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'default' }],
    defaultModel: '', writable: false, checkedAt: timestamp }), execute: async context => {
    executed.push({ ...context.run });
    await context.onSession(`fixture-${context.run.id}`);
    context.onOutput?.('fixture output');
    return 'fixture completed';
  } };
}

async function waitForResult(run: AgentRun) {
  for (let attempt = 0; attempt < 200 && !run.resultReady; attempt++) await delay(10);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true, '等待运行最终结果落盘');
}

test('历史和新建 worktree 会话按真实主项目归组，执行目录、SSE 与磁盘元数据保持一致', { timeout: 15000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-project-')));
  const repository = path.join(directory, 'Apex 项目');
  const runtimeDirectory = path.join(directory, '.data', 'agent-runtimes');
  const legacyWorkspace = path.join(runtimeDirectory, 'workspaces', '11111111-1111-1111-1111-111111111111');
  const selectedWorkspace = path.join(runtimeDirectory, 'workspaces', '22222222-2222-2222-2222-222222222222');
  const executed: AgentRun[] = [];
  const adapter = fixtureAdapter(executed);
  let service: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    await fs.mkdir(repository);
    await fs.mkdir(path.dirname(legacyWorkspace), { recursive: true });
    await exec('git', ['init', '-b', 'feature/base', repository]);
    await exec('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '--allow-empty', '-m', '创建临时测试仓库']);
    await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/legacy', legacyWorkspace]);
    await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/direct', selectedWorkspace]);
    const session: CodexSessionSummary = { id: '33333333-3333-3333-3333-333333333333', title: '同步会话', preview: '同步预览',
      workspacePath: legacyWorkspace, branch: 'feature/legacy', headSha: '', model: '', reasoningEffort: '',
      archived: false, createdAt: timestamp, updatedAt: timestamp };
    const legacy = historicalRun('legacy-run', legacyWorkspace, { sessionId: session.id,
      isolatedWorkspace: true, baseBranch: 'feature/base' });
    const source: CodexSessionSource = { listSessions: async () => [session], session: async () => ({ ...session,
      turns: [{ id: 'history-turn', userMessage: '历史问题', agentMessage: '历史回答', createdAt: timestamp, updatedAt: timestamp }] }) };
    const runFile = path.join(runtimeDirectory, 'agent-runs.json');
    await fs.writeFile(runFile, JSON.stringify([legacy]));
    service = await createAgentRuntimeService(runtimeDirectory, { adapters: [adapter], codexSessionSource: source });
    const reloaded = (await service.dashboard()).runs[0];
    assert.equal(reloaded.projectWorkspacePath, repository);
    assert.equal(agentRunProjectPath(reloaded), repository);
    assert.equal(reloaded.workspacePath, legacyWorkspace);
    assert.equal(reloaded.sourceWorkspacePath, undefined);
    assert.equal(reloaded.baseBranch, legacy.baseBranch);
    assert.equal(reloaded.isolatedWorkspace, true);
    assert.equal(reloaded.branch, legacy.branch);

    const streamed: AgentRun[] = [];
    service.subscribe((_revision, run) => { if (run) streamed.push(JSON.parse(JSON.stringify(run))); });
    const started = await service.start({ provider: 'codex', mode: 'ask', model: '',
      objective: '直接选择第二个工作树', workspacePath: selectedWorkspace });
    await waitForResult(started);
    assert.equal(started.projectWorkspacePath, repository);
    assert.equal(started.workspacePath, selectedWorkspace);
    assert.equal(started.sourceWorkspacePath, undefined);
    assert.equal(started.baseBranch, undefined);
    assert.equal(started.isolatedWorkspace, undefined);
    assert.equal(started.branch, 'feature/direct');
    assert.equal(agentRunContextPath(started), selectedWorkspace, '日报和文件查询沿用选择的工作树');
    assert.equal(workflowContext(buildAgentConversations([started])[0])?.workspacePath, selectedWorkspace,
      '项目归组不能改变工作流绑定目录');
    assert.deepEqual(executed.map(run => run.workspacePath), [selectedWorkspace], '执行器仍在选中的工作树执行');
    assert.ok(streamed.some(run => run.id === started.id && run.status === 'running'));
    assert.ok(streamed.some(run => run.id === started.id && run.resultReady));
    assert.ok(streamed.every(run => run.projectWorkspacePath === repository && run.workspacePath === selectedWorkspace));
    const dashboard = await service.dashboard();
    assert.deepEqual(new Set(dashboard.runs.map(agentRunProjectPath)), new Set([repository]));
    assert.equal(dashboard.runs.find(run => run.id === started.id)?.projectWorkspacePath, streamed.at(-1)?.projectWorkspacePath);

    await service.syncCodexSessions();
    const summary = (await service.dashboard()).codexSessions[0];
    const detail = await service.codexSession(session.id);
    assert.equal(summary.projectWorkspacePath, repository);
    assert.equal(detail.projectWorkspacePath, repository);
    assert.equal(summary.workspacePath, legacyWorkspace);
    assert.equal(detail.workspacePath, legacyWorkspace);
    for (const conversation of [buildSyncedCodexConversation(summary), buildSyncedCodexConversation(summary, detail)]) {
      assert.equal(agentRunProjectPath(conversation.latest), repository);
      assert.equal(conversation.latest.workspacePath, legacyWorkspace);
    }
    assert.equal(session.projectWorkspacePath, undefined, '来源记录不被展示投影改写');
    const saved: AgentRun[] = JSON.parse(await fs.readFile(runFile, 'utf8'));
    assert.ok(saved.every(run => !Object.hasOwn(run, 'projectWorkspacePath')));
    const savedLegacy = saved.find(run => run.id === legacy.id)!;
    assert.equal(savedLegacy.workspacePath, legacyWorkspace);
    assert.equal(Object.hasOwn(savedLegacy, 'sourceWorkspacePath'), false);
    assert.equal(savedLegacy.baseBranch, 'feature/base');
    assert.equal(savedLegacy.isolatedWorkspace, true);
    assert.ok(!(await fs.readFile(path.join(runtimeDirectory, 'codex-sessions.json'), 'utf8')).includes('projectWorkspacePath'));

    await service.close();
    service = await createAgentRuntimeService(runtimeDirectory, { adapters: [adapter], codexSessionSource: source });
    assert.deepEqual(new Set((await service.dashboard()).runs.map(agentRunProjectPath)), new Set([repository]));
    assert.equal((await service.codexSession(session.id)).projectWorkspacePath, repository);
    assert.equal(executed.length, 1, '重载历史记录不会重新执行任务');
  } finally {
    await service?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('普通目录仍按原目录分组，显式未绑定和旧内部会话目录保持未绑定', { timeout: 10000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-unbound-')));
  const plain = path.join(directory, '普通项目');
  const runtimeDirectory = path.join(directory, '.data', 'agent-runtimes');
  const internal = path.join(runtimeDirectory, 'sessions', '44444444-4444-4444-4444-444444444444');
  const executed: AgentRun[] = [];
  let service: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    await fs.mkdir(plain);
    await fs.mkdir(internal, { recursive: true });
    await fs.writeFile(path.join(runtimeDirectory, 'agent-runs.json'), JSON.stringify([
      historicalRun('old-internal', internal),
      historicalRun('explicit-unbound', plain, { sourceWorkspacePath: '', projectWorkspacePath: plain }),
    ]));
    service = await createAgentRuntimeService(runtimeDirectory, { adapters: [fixtureAdapter(executed)] });
    for (const run of (await service.dashboard()).runs) assert.equal(agentRunProjectPath(run), '');
    const normal = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '普通目录', workspacePath: plain });
    const unbound = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '未指定工作区', workspacePath: '' });
    await Promise.all([waitForResult(normal), waitForResult(unbound)]);
    assert.equal(agentRunProjectPath(normal), plain);
    assert.equal(normal.workspacePath, plain);
    assert.equal(agentRunProjectPath(unbound), '');
    assert.equal(unbound.sourceWorkspacePath, '');
    assert.equal(path.dirname(unbound.workspacePath), path.join(runtimeDirectory, 'sessions'));
    assert.deepEqual(executed.map(run => run.workspacePath).sort(), [plain, unbound.workspacePath].sort());
    assert.equal(agentRunProjectPath({ ...normal, sourceWorkspacePath: '' }), '', '显式未绑定优先于派生项目目录');
    const saved: AgentRun[] = JSON.parse(await fs.readFile(path.join(runtimeDirectory, 'agent-runs.json'), 'utf8'));
    assert.ok(saved.every(run => !Object.hasOwn(run, 'projectWorkspacePath')));
    assert.equal(saved.find(run => run.id === unbound.id)?.sourceWorkspacePath, '');
  } finally {
    await service?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

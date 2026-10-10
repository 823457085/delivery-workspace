import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  agentCliFailureMessage, changedFilesSince, codexForkArguments, codexRunArguments, createAgentRuntimeService, cursorModels, cursorRunArguments,
  isAgentSessionBusyDiagnostic, listGitBranches, resolveWorkspace, snapshotGitWorkspace, switchGitWorkspaceBranch,
  resultArtifactFiles,
  type AgentRuntimeAdapter,
} from '../server/agent-runtime.js';
import { createCodexSessionSource, type CodexSessionSource } from '../server/codex-session-source.js';
import { codexChildEnvironment } from '../server/cli-runtime.js';
import { buildAgentConversationList } from '../src/features/agent-workbench/conversation.js';
import type { AgentRun, CodexSessionSummary, CodexSessionTurn } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const workspace = { workspacePath: '/test/repository', branch: 'feature/test', headSha: 'abc123' };
const health = (provider: 'codex' | 'cursor') => ({ provider, label: `${provider} test`, binary: `/test/${provider}`,
  version: 'test', authenticated: true, ready: true, message: 'ready', modes: ['agent', 'plan', 'ask'] as ('agent' | 'plan' | 'ask')[],
  models: [{ id: '', label: '默认', ...(provider === 'codex' ? { efforts: ['low', 'high'] as ('low' | 'high')[], defaultEffort: 'high' as const } : {}) },
    { id: 'test-model', label: 'Test Model', ...(provider === 'codex' ? { efforts: ['low', 'high'] as ('low' | 'high')[], defaultEffort: 'high' as const } : {}) },
    { id: 'second-model', label: 'Second Model', ...(provider === 'codex' ? { efforts: ['low', 'high'] as ('low' | 'high')[], defaultEffort: 'high' as const } : {}) }], defaultModel: '', writable: true,
  checkedAt: new Date().toISOString() });

function controlledAdapter(provider: 'codex' | 'cursor') {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const adapter: AgentRuntimeAdapter = { id: provider, health: async () => health(provider),
    execute: async (context) => {
      context.onPid(provider === 'codex' ? 101 : 202);
      context.onSession(`${provider}-session-1234`);
      context.onEvent('lifecycle', `${provider} started`);
      context.signal.addEventListener('abort', () => fail(new Error('stopped')), { once: true });
      return completion;
    } };
  return { adapter, finish };
}

type RuntimeService = Awaited<ReturnType<typeof createAgentRuntimeService>>;
type RuntimeDashboard = Awaited<ReturnType<RuntimeService['dashboard']>>;
function waitForAgentState(service: RuntimeService, predicate: (dashboard: RuntimeDashboard) => boolean, description: string) {
  return new Promise<RuntimeDashboard>((resolve, reject) => {
    let settled = false;
    const finish = (dashboard?: RuntimeDashboard, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error); else resolve(dashboard!);
    };
    const observe = async () => {
      try {
        const dashboard = await service.dashboard();
        if (predicate(dashboard)) finish(dashboard);
      } catch (error) { finish(undefined, error); }
    };
    const unsubscribe = service.subscribe(() => { void observe(); });
    const timer = setTimeout(() => finish(undefined, new Error(`等待 ${description} 超时`)), 10_000);
    void observe();
  });
}
function waitForSettledRun(service: RuntimeService, runId: string, status: AgentRun['status'] = 'completed') {
  // 完成通知早于 Git 变更收尾；会话锁释放后才能继续分叉、删除或核对最终结果。
  return waitForAgentState(service, dashboard => dashboard.runs.find(run => run.id === runId)?.status === status
    && !dashboard.activeWorkspaceLocks.some(lock => lock.runId === runId), `${runId} ${status} 并释放会话锁`);
}

test('Cursor 信任只绑定确认后的实际隔离目录；旧失败会话可确认重试，不向新目录继承', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-trust-'));
  const received: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'cursor', health: async () => health('cursor'),
    execute: async context => { received.push(context.run); throw new Error('fixture failure'); } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter],
    resolveWorkspace: async workspacePath => ({ ...workspace, workspacePath }),
    createIsolatedWorkspace: async workspacePath => ({ ...workspace, workspacePath: '/test/isolated', sourceWorkspacePath: workspacePath,
      isolatedWorkspace: true, baseBranch: workspace.branch }) });
  try {
    const input = { provider: 'cursor' as const, mode: 'agent' as const, model: 'test-model', objective: 'test', workspacePath: workspace.workspacePath };
    await assert.rejects(service.start({ ...input, cursorTrustPath: '/unconfirmed' }), /信任确认/);
    const isolated = await service.start({ ...input, isolateWorkspace: true, cursorTrustPath: input.workspacePath });
    assert.equal(isolated.cursorTrustPath, '/test/isolated');
    assert.equal(isolated.accessMode, 'workspace');
    for (let attempt = 0; attempt < 50 && isolated.status !== 'failed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(isolated.status, 'failed');
    await assert.rejects(service.retry(isolated.id, input.workspacePath), /当前会话目录不一致/);
    const retried = await service.retry(isolated.id, isolated.workspacePath);
    assert.equal(retried.cursorTrustPath, isolated.workspacePath);
    assert.equal(retried.parentRunId, isolated.id);
    const fresh = await service.start(input);
    assert.equal(fresh.cursorTrustPath, undefined);
    assert.ok(received.some(run => run.cursorTrustPath === '/test/isolated'));
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Codex 失败重试沿用会话速度选择', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-speed-retry-'));
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async context => {
    context.onSession('codex-speed-session');
    throw new Error('fixture failure');
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const first = await service.start({ provider: 'codex', mode: 'ask', model: 'test-model', serviceTier: 'default',
      objective: '失败运行', workspacePath: '/selected' });
    for (let i = 0; i < 50 && first.status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(first.status, 'failed');
    const retried = await service.retry(first.id);
    assert.equal(retried.serviceTier, 'default');
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('两种执行器收到发送时的笔记快照；引用解析失败不创建运行', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-context-'));
  const received: AgentRun[] = [];
  let complete!: () => void;
  const executed = new Promise<void>(resolve => { complete = resolve; });
  const adapters: AgentRuntimeAdapter[] = (['codex', 'cursor'] as const).map(provider => ({
    id: provider, health: async () => health(provider), execute: async context => { received.push(context.run); if (received.length === 2) complete(); return '已读取'; },
  }));
  const service = await createAgentRuntimeService(directory, { adapters, resolveWorkspace: async () => workspace,
    resolveKnowledge: async objective => { if (objective === '无效引用') throw new Error('笔记未绑定'); return '发送时的笔记资料'; } });
  try {
    for (const provider of ['codex', 'cursor'] as const) {
      const run = await service.start({ provider, mode: 'ask', model: 'test-model', objective: '参考笔记', workspacePath: workspace.workspacePath });
      assert.equal(run.objective, '参考笔记');
      assert.equal(run.knowledgeContext, '发送时的笔记资料');
    }
    await assert.rejects(service.start({ provider: 'codex', mode: 'ask', model: 'test-model', objective: '无效引用', workspacePath: workspace.workspacePath }), /笔记未绑定/);
    await executed;
    assert.equal(received.length, 2);
    assert.ok(received.every(run => run.knowledgeContext === '发送时的笔记资料'));
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('双 CLI 默认限制在工作区，仅在显式选择时开启完全访问', () => {
  const codex = codexRunArguments('/repo', 'ask', 'test-model', 'high', '', ['/private/image-a.png', '/private/image-b.webp']);
  assert.deepEqual(codex.slice(0, 3), ['exec', '--cd', '/repo']);
  assert.ok(codex.includes('sandbox_mode="read-only"'));
  assert.ok(codex.includes('approval_policy="never"'));
  assert.ok(!codex.includes('sandbox_workspace_write.network_access=true'));
  assert.deepEqual(codex.slice(codex.indexOf('--model'), codex.indexOf('--model') + 2), ['--model', 'test-model']);
  assert.ok(codex.includes('model_reasoning_effort="high"'));
  assert.deepEqual(codex.filter((value) => value === '--image').length, 2);
  assert.ok(codex.includes('/private/image-a.png'));
  assert.ok(!codex.some((value) => /dangerously|bypass/i.test(value)));
  const forkedCodex = codexForkArguments('agent', 'test-model', 'high', 'codex-session-1234');
  assert.deepEqual(forkedCodex.slice(0, 4), ['exec', 'fork', 'codex-session-1234', '-c']);
  assert.ok(forkedCodex.includes('sandbox_mode="workspace-write"'));
  assert.ok(forkedCodex.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!forkedCodex.some((value) => /dangerously|bypass/i.test(value)));
  const resumedCodex = codexRunArguments('/repo', 'agent', 'test-model', 'xhigh', 'codex-session-1234', ['/private/resume.png']);
  assert.deepEqual(resumedCodex.slice(0, 3), ['exec', 'resume', 'codex-session-1234']);
  assert.ok(resumedCodex.includes('sandbox_mode="workspace-write"'));
  assert.ok(resumedCodex.includes('sandbox_workspace_write.network_access=true'));
  assert.deepEqual(resumedCodex.slice(-3), ['--image', '/private/resume.png', '-']);
  const fullCodex = codexRunArguments('/repo', 'agent', 'test-model', 'high', '', [], 'full');
  assert.ok(fullCodex.includes('sandbox_mode="danger-full-access"'));
  assert.ok(fullCodex.includes('approval_policy="never"'));
  assert.ok(!fullCodex.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!fullCodex.some((value) => /dangerously|bypass/i.test(value)));
  const readOnlyCodex = codexRunArguments('/repo', 'ask', 'test-model', 'high', '', [], 'full');
  assert.ok(readOnlyCodex.includes('sandbox_mode="read-only"'));

  const cursor = cursorRunArguments('/repo', 'plan', 'test-model', 'cursor-session-1234', '只读分析');
  assert.deepEqual(cursor.slice(0, 5), ['-p', '--output-format', 'stream-json', '--mode', 'plan']);
  assert.ok(cursor.includes('enabled'));
  assert.deepEqual(cursor.slice(cursor.indexOf('--model'), cursor.indexOf('--model') + 2), ['--model', 'test-model']);
  assert.ok(cursor.includes('cursor-session-1234'));
  assert.ok(!cursor.some((value) => ['--force', '--yolo', '--trust'].includes(value)));
  const cursorAgent = cursorRunArguments('/repo', 'agent', 'test-model');
  assert.ok(cursorAgent.includes('--auto-review'));
  assert.ok(!cursorAgent.includes('--mode'));
  assert.ok(!cursorAgent.some((value) => ['--force', '--yolo', '--trust'].includes(value)));
  const fullCursor = cursorRunArguments('/repo', 'agent', 'test-model', '', '', 'full');
  assert.ok(fullCursor.includes('--force'));
  assert.deepEqual(fullCursor.slice(fullCursor.indexOf('--sandbox'), fullCursor.indexOf('--sandbox') + 2), ['--sandbox', 'disabled']);
  assert.ok(!fullCursor.includes('--auto-review'));
});

test('Codex 子进程不继承桌面父会话和工具管道', () => {
  const environment = codexChildEnvironment({ PATH: '/bin', CODEX_SESSION_ID: 'parent-session',
    CODEX_THREAD_ID: 'parent-thread', CODEX_APP_TOOLS_PIPE_PATH: '/tmp/desktop.sock',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop', CODEX_PERMISSION_PROFILE: ':danger-full-access', CODEX_CI: '1' });
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.CODEX_CI, '1');
  assert.equal(environment.CODEX_SESSION_ID, undefined);
  assert.equal(environment.CODEX_THREAD_ID, undefined);
  assert.equal(environment.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  assert.equal(environment.CODEX_PERMISSION_PROFILE, undefined);
});

test('Cursor 模型解析忽略 CLI 提示并保留真实和参数化模型', () => {
  const output = [
    'Available models', '',
    '\x1b[32mauto\x1b[0m - Auto (current, default)',
    'composer-2.5 - Composer 2.5',
    '- cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast',
    'claude-opus-4-8[context=1m,effort=high,fast=false] - Claude Opus',
    'custom:model',
    'composer-2.5 - Composer 2.5', '',
    "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.",
  ].join('\r\n');
  assert.deepEqual(cursorModels(output).map(({ id }) => id), [
    '', 'auto', 'composer-2.5', 'cursor-grok-4.6-high-fast',
    'claude-opus-4-8[context=1m,effort=high,fast=false]', 'custom:model',
  ]);
  assert.deepEqual(cursorModels('Available models\nTip: use --model <id> to switch.'), cursorModels(''));
});

test('Agent 工作区快照只返回本轮真实改动的文件', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-changed-files-'));
  try {
    await exec('git', ['init', '-b', 'main', repository]);
    await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
    await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
    await fs.writeFile(path.join(repository, 'modified.ts'), 'before\n');
    await fs.writeFile(path.join(repository, 'deleted.ts'), 'delete me\n');
    await exec('git', ['-C', repository, 'add', '.']);
    await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
    await fs.writeFile(path.join(repository, 'preexisting.ts'), 'dirty before\n');
    const before = await snapshotGitWorkspace(repository);

    await fs.writeFile(path.join(repository, 'modified.ts'), 'after\n');
    await fs.rm(path.join(repository, 'deleted.ts'));
    await fs.writeFile(path.join(repository, 'added.ts'), 'new\n');
    await fs.writeFile(path.join(repository, 'preexisting.ts'), 'dirty after\n');
    await exec('git', ['-C', repository, 'add', '.']);
    await exec('git', ['-C', repository, 'commit', '-m', 'agent changes']);

    assert.deepEqual(await changedFilesSince(repository, before), [
      { path: 'added.ts', status: 'added' },
      { path: 'deleted.ts', status: 'deleted' },
      { path: 'modified.ts', status: 'modified' },
      { path: 'preexisting.ts', status: 'added' },
    ]);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('普通文件夹可作为 Agent 工作区并保留文件候选与改动记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-plain-runtime-'));
  const plainWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-plain-workspace-'));
  await fs.mkdir(path.join(plainWorkspace, 'assets'), { recursive: true });
  await fs.mkdir(path.join(plainWorkspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(plainWorkspace, 'assets', 'icon.svg'), '<svg />');
  await fs.writeFile(path.join(plainWorkspace, 'src', 'payment.ts'), 'const title = "支付渠道";\nconst fallback = "渠道";\n');
  await fs.writeFile(path.join(plainWorkspace, '.env.test'), 'PRIVATE_LABEL=支付渠道\n');
  await fs.writeFile(path.join(plainWorkspace, 'remove.txt'), 'remove');
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '已完成' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const identity = await resolveWorkspace(plainWorkspace);
    assert.deepEqual(identity, { workspacePath: await fs.realpath(plainWorkspace), branch: '', headSha: '' });
    assert.deepEqual(await service.workspaceBranches(plainWorkspace), {
      workspacePath: await fs.realpath(plainWorkspace), current: '', branches: [],
    });
    assert.deepEqual((await service.workspaceFiles(plainWorkspace, 'icon')).files, ['assets/icon.svg']);
    const knowledge = await service.workspaceKnowledge(plainWorkspace, '支付渠道');
    assert.deepEqual(knowledge.matches, [{ path: 'src/payment.ts', line: 1, excerpt: 'const title = "支付渠道";' }]);
    assert.equal(knowledge.scannedFiles > 0, true);
    assert.equal(knowledge.matches.some((item) => item.path === '.env.test'), false);

    const before = await snapshotGitWorkspace(plainWorkspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(path.join(plainWorkspace, 'assets', 'icon.svg'), '<svg>changed</svg>');
    await fs.writeFile(path.join(plainWorkspace, 'added.txt'), 'added');
    await fs.rm(path.join(plainWorkspace, 'remove.txt'));
    assert.deepEqual(await changedFilesSince(plainWorkspace, before), [
      { path: 'added.txt', status: 'added' },
      { path: 'assets/icon.svg', status: 'modified' },
      { path: 'remove.txt', status: 'deleted' },
    ]);

    const run = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '整理图片资源',
      workspacePath: plainWorkspace });
    assert.equal(run.workspacePath, await fs.realpath(plainWorkspace));
    assert.equal(run.branch, '');
    assert.equal(run.headSha, '');
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(plainWorkspace, { recursive: true, force: true });
  }
});

test('Agent 最终回复中的本地文件链接会记录为生成产物', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-artifact-'));
  const workspace = await fs.realpath(directory);
  const artifact = path.join(directory, 'openapi.json');
  try {
    await fs.writeFile(artifact, '{}\n');
    assert.deepEqual(await resultArtifactFiles('/repo', `已生成：[下载 openapi.json](${artifact})`), [
      { path: artifact, status: 'generated' },
    ]);
    assert.deepEqual(await resultArtifactFiles('/repo', '[过期文件](/private/tmp/not-found.json)'), []);
    assert.deepEqual(await resultArtifactFiles(workspace,
      `[带行号的 openapi.json](${artifact}:53368) [尖括号路径](<${artifact}:12:3>)`), [
      { path: 'openapi.json', status: 'generated' },
    ]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI 诊断只在明确占用时标记会话忙，并区分会话不存在', () => {
  assert.equal(isAgentSessionBusyDiagnostic('thread already running with an active turn'), true);
  assert.match(agentCliFailureMessage('codex', 1, 'session is locked by another process'), /其他 Codex 窗口运行/);
  assert.match(agentCliFailureMessage('codex', 1, 'no session found for id'), /找不到原会话/);
  assert.doesNotMatch(agentCliFailureMessage('codex', 1, 'failed to parse session metadata'), /其他 Codex 窗口运行/);
});

test('服务端拒绝不属于当前执行器的模型', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-test-'));
  const adapter = controlledAdapter('codex');
  const service = await createAgentRuntimeService(directory, { adapters: [adapter.adapter], resolveWorkspace: async () => workspace });
  try {
    await assert.rejects(service.start({ provider: 'codex', mode: 'agent', model: 'unknown-model',
      objective: '执行任务', workspacePath: '/selected' }), /所选模型不受当前执行器支持/);
    await assert.rejects(service.start({ provider: 'codex', mode: 'agent', model: 'test-model', reasoningEffort: 'ultra',
      objective: '执行任务', workspacePath: '/selected' }), /所选推理强度不受当前模型支持/);
    await assert.rejects(service.start({ provider: 'codex', mode: 'ask', accessMode: 'full', model: 'test-model',
      objective: '只读问题', workspacePath: '/selected' }), /只有 Agent 模式可使用完全访问/);
  } finally { adapter.finish('done'); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('两种 CLI 都接收纯图片，Cursor 使用验证后的文件路径且共享附件不被提前清理', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-image-runtime-test-'));
  const receivedImages: string[][] = [];
  const removedIds: string[][] = [];
  const codex: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    receivedImages.push(context.imagePaths);
    context.onSession('codex-image-session');
    return '图片已处理';
  } };
  const cursorFiles: { name: string; path: string }[][] = [];
  const cursor: AgentRuntimeAdapter = { id: 'cursor', health: async () => health('cursor'), execute: async context => {
    cursorFiles.push(context.fileAttachments); context.onSession('cursor-image-session'); return '图片已处理';
  } };
  const attachment = { id: '11111111-1111-1111-1111-111111111111', name: '页面截图.png', mimeType: 'image/png' as const,
    size: 128, url: '/api/agent-runtimes/attachments/11111111-1111-1111-1111-111111111111' };
  const service = await createAgentRuntimeService(directory, { adapters: [codex, cursor], resolveWorkspace: async () => workspace,
    resolveAttachments: async (ids) => ids.map(() => ({ attachment, filePath: '/private/validated-image.png' })),
    removeAttachments: async (ids) => { removedIds.push(ids); } });
  try {
    const run = await service.start({ provider: 'codex', mode: 'ask', model: 'test-model', objective: '', workspacePath: '/selected',
      attachmentIds: [attachment.id] });
    await waitForSettledRun(service, run.id);
    assert.equal(run.objective, '请分析已附加的图片。');
    assert.deepEqual(run.attachments, [attachment]);
    assert.deepEqual(receivedImages, [['/private/validated-image.png']]);
    const cursorRun = await service.start({ provider: 'cursor', mode: 'ask', model: 'test-model', objective: '',
      workspacePath: '/selected', attachmentIds: [attachment.id] });
    await waitForSettledRun(service, cursorRun.id);
    assert.equal(cursorRun.objective, '请分析已附加的图片。');
    assert.deepEqual(cursorFiles, [[{ name: attachment.name, path: '/private/validated-image.png' }]]);
    assert.deepEqual(await service.removeConversation(run.id), { deleted: 1 });
    assert.ok(removedIds.every(ids => !ids.includes(attachment.id)));
    assert.deepEqual(await service.removeConversation(cursorRun.id), { deleted: 1 });
    assert.deepEqual(removedIds.at(-1), [attachment.id]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('XLSX 附件作为本地文件路径传给 Codex，不混入图片输入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-runtime-test-'));
  const received: { images: string[]; files: { name: string; path: string }[] }[] = [];
  const attachment = { id: '22222222-2222-2222-2222-222222222222', name: '报表.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const,
    size: 128, url: '/api/agent-runtimes/attachments/22222222-2222-2222-2222-222222222222' };
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async context => {
    received.push({ images: context.imagePaths, files: context.fileAttachments });
    context.onSession('codex-file-session');
    return '文件已处理';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace,
    resolveAttachments: async () => [{ attachment, filePath: '/private/validated-report.xlsx' }] });
  try {
    const run = await service.start({ provider: 'codex', mode: 'ask', model: 'test-model', objective: '',
      workspacePath: '/selected', attachmentIds: [attachment.id] });
    await waitForSettledRun(service, run.id);
    assert.equal(run.objective, '请分析已附加的文件。');
    assert.deepEqual(run.attachments, [attachment]);
    assert.deepEqual(received, [{ images: [], files: [{ name: '报表.xlsx', path: '/private/validated-report.xlsx' }] }]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('当前会话插入文件时把已验证路径送达同一轮', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-live-file-test-'));
  const attachment = { id: '33333333-3333-3333-3333-333333333333', name: '数据.csv', mimeType: 'text/csv',
    size: 5, url: '/api/agent-runtimes/attachments/33333333-3333-3333-3333-333333333333' };
  let finish!: () => void;
  let received: { text: string; imagePaths: string[] } | undefined;
  const completion = new Promise<string>(resolve => { finish = () => resolve('完成'); });
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async context => {
    context.onSession('codex-live-file-session');
    context.onSteer?.(async input => { received = input; });
    return completion;
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace,
    resolveAttachments: async () => [{ attachment, filePath: '/private/validated-data.csv' }] });
  try {
    const run = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '先处理任务', workspacePath: '/selected' });
    for (let attempt = 0; attempt < 50 && !run.liveInputReady; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.liveInputReady, true);
    await service.resume(run.id, '', 'test-model', 'high', [attachment.id], undefined, 'next');
    assert.match(received?.text || '', /数据\.csv/);
    assert.match(received?.text || '', /\/private\/validated-data\.csv/);
    assert.deepEqual(received?.imagePaths, []);
    assert.deepEqual(run.supplements?.[0].attachments, [attachment]);
  } finally { finish(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('自定义模型按 CLI 隔离持久化，且不允许覆盖内置模型', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-custom-model-test-'));
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    await assert.rejects(service.addCustomModel({ provider: 'codex', modelId: 'test-model', label: '重复' }), /已在执行器列表/);
    const created = await service.addCustomModel({ provider: 'codex', modelId: 'team-model-v1', label: '团队模型' });
    const option = (await service.dashboard()).runtimes[0].models.find((model) => model.id === 'team-model-v1');
    assert.equal(option?.label, '团队模型');
    assert.equal(option?.customId, created.id);
    assert.ok(option?.efforts?.includes('ultra'));
  } finally { await service.close(); }
  const recovered = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const option = (await recovered.dashboard()).runtimes[0].models.find((model) => model.id === 'team-model-v1');
    assert.ok(option?.customId);
    await recovered.removeCustomModel(option!.customId!);
    assert.equal((await recovered.dashboard()).runtimes[0].models.some((model) => model.id === 'team-model-v1'), false);
  } finally { await recovered.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('会话标题支持修改并在服务重启后保留', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-conversation-title-test-'));
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '完成' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  let runId = '';
  try {
    const run = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '原始标题', workspacePath: '/selected' });
    runId = run.id;
    assert.deepEqual(await service.updateConversationTitle(run.id, '  自定义标题  '), { id: run.id, title: '自定义标题' });
    assert.equal((await service.dashboard()).conversationTitles[run.id], '自定义标题');
    await assert.rejects(service.updateConversationTitle('missing-session', '无效标题'), /找不到该 Agent 会话/);
  } finally { await service.close(); }
  const recovered = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    assert.equal((await recovered.dashboard()).conversationTitles[runId], '自定义标题');
  } finally { await recovered.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('@ 文件候选只返回当前 Git 工作区的相对路径', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-files-test-'));
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-repository-test-'));
  await exec('git', ['init', repository]);
  await fs.mkdir(path.join(repository, 'src'), { recursive: true });
  await fs.writeFile(path.join(repository, 'src', 'main.ts'), 'export {};');
  await fs.writeFile(path.join(repository, 'src', '中文 文件.ts'), 'const value = "路径检索";\n');
  await fs.writeFile(path.join(repository, 'README.md'), '# test');
  await exec('git', ['-C', repository, 'add', '.']);
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const result = await service.workspaceFiles(repository, 'main');
    assert.equal(result.workspacePath, await fs.realpath(repository));
    assert.deepEqual(result.files, ['src/main.ts']);
    assert.ok(result.files.every((file) => !path.isAbsolute(file)));
    assert.deepEqual((await service.workspaceKnowledge(repository, 'export')).matches,
      [{ path: 'src/main.ts', line: 1, excerpt: 'export {};' }]);
    assert.deepEqual((await service.workspaceFiles(repository, '中文')).files, ['src/中文 文件.ts']);
    assert.deepEqual((await service.workspaceKnowledge(repository, '路径检索')).matches,
      [{ path: 'src/中文 文件.ts', line: 1, excerpt: 'const value = "路径检索";' }]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); await fs.rm(repository, { recursive: true, force: true }); }
});

test('新会话可读取本地分支并在启动前安全切换', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-branch-test-'));
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-branch-repository-'));
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# main\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  await exec('git', ['-C', repository, 'switch', '-c', 'feature/demo']);
  await exec('git', ['-C', repository, 'switch', 'main']);
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '已完成' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const state = await listGitBranches(repository);
    assert.equal(state.current, 'main');
    assert.deepEqual(state.branches, ['feature/demo', 'main']);

    await fs.writeFile(path.join(repository, 'README.md'), '# dirty\n');
    await assert.rejects(switchGitWorkspaceBranch(repository, 'feature/demo'), /存在未提交改动/);
    await fs.writeFile(path.join(repository, 'README.md'), '# main\n');

    const run = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '在所选分支工作',
      workspacePath: repository, branch: 'feature/demo' });
    assert.equal(run.branch, 'feature/demo');
    assert.equal((await exec('git', ['-C', repository, 'branch', '--show-current'])).stdout.trim(), 'feature/demo');
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(repository, { recursive: true, force: true });
  }
});

test('新会话从所选分支创建隔离工作区，不切换或覆盖源仓库改动', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-isolated-runtime-'));
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-isolated-repository-'));
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# main\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  await exec('git', ['-C', repository, 'switch', '-c', 'feature/demo']);
  await fs.writeFile(path.join(repository, 'README.md'), '# feature\n');
  await exec('git', ['-C', repository, 'commit', '-am', 'feature']);
  await exec('git', ['-C', repository, 'switch', 'main']);
  await fs.writeFile(path.join(repository, 'README.md'), '# dirty main\n');
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    context.onSession(context.resumeSessionId || `session-${context.run.id}`);
    return '已完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const first = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '隔离执行第一项任务',
      workspacePath: repository, branch: 'feature/demo', isolateWorkspace: true });
    assert.equal(first.sourceWorkspacePath, await fs.realpath(repository));
    assert.equal(first.baseBranch, 'feature/demo');
    assert.equal(first.isolatedWorkspace, true);
    assert.notEqual(first.workspacePath, await fs.realpath(repository));
    assert.match(first.branch, /^codex\/delivery-agent-feature-demo-/);
    assert.equal(await fs.readFile(path.join(first.workspacePath, 'README.md'), 'utf8'), '# feature\n');
    assert.equal((await exec('git', ['-C', repository, 'branch', '--show-current'])).stdout.trim(), 'main');
    assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# dirty main\n');
    assert.match((await exec('git', ['-C', repository, 'status', '--porcelain'])).stdout, /README\.md/);

    await waitForSettledRun(service, first.id);
    const resumed = await service.resume(first.id, '继续同一会话');
    assert.equal(resumed.workspacePath, first.workspacePath);
    assert.equal(resumed.sourceWorkspacePath, first.sourceWorkspacePath);
    assert.equal(resumed.baseBranch, first.baseBranch);
    assert.equal(resumed.isolatedWorkspace, true);

    const second = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '隔离执行第二项任务',
      workspacePath: repository, branch: 'feature/demo', isolateWorkspace: true });
    assert.notEqual(second.workspacePath, first.workspacePath);
    assert.notEqual(second.branch, first.branch);
    assert.equal((await exec('git', ['-C', repository, 'branch', '--show-current'])).stdout.trim(), 'main');
    assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# dirty main\n');
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(repository, { recursive: true, force: true });
  }
});

test('同一工作区的不同 Agent 会话并行执行，分支切换仍受保护', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-test-'));
  const codex = controlledAdapter('codex');
  const cursor = controlledAdapter('cursor');
  const service = await createAgentRuntimeService(directory, { adapters: [codex.adapter, cursor.adapter], resolveWorkspace: async () => workspace });
  try {
    const run = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '审查并修改当前模块', workspacePath: '/selected' });
    assert.equal(run.status, 'running');
    await waitForAgentState(service, dashboard => dashboard.runs.find(item => item.id === run.id)?.sessionId === 'codex-session-1234', 'Codex 会话启动');
    assert.equal((await service.dashboard()).runs.find((item) => item.id === run.id)?.sessionId, 'codex-session-1234');
    assert.equal((await service.dashboard()).activeWorkspaceLocks.length, 1);
    const parallel = await service.start({ provider: 'cursor', mode: 'agent', model: '', objective: '新开第二个 Agent', workspacePath: '/selected' });
    assert.equal(parallel.status, 'running');
    await waitForAgentState(service, dashboard => dashboard.runs.find(item => item.id === parallel.id)?.sessionId === 'cursor-session-1234', 'Cursor 会话启动');
    assert.equal(parallel.sessionId, 'cursor-session-1234');
    assert.equal((await service.dashboard()).activeWorkspaceLocks.length, 2);
    await assert.rejects(service.start({ provider: 'cursor', mode: 'agent', model: '', objective: '并发时切换分支',
      workspacePath: '/selected', branch: 'feature/other' }), /已有 Agent 运行或排队/);
    await service.stop(run.id);
    await waitForSettledRun(service, run.id, 'cancelled');
    const stopped = (await service.dashboard()).runs.find((item) => item.id === run.id)!;
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.sessionId, 'codex-session-1234');
    const stillRunning = (await service.dashboard()).runs.find((item) => item.id === parallel.id)!;
    assert.equal(stillRunning.status, 'running');
    assert.equal(stillRunning.sessionId, 'cursor-session-1234');
    assert.equal((await service.dashboard()).activeWorkspaceLocks[0]?.runId, parallel.id);
    await service.stop(parallel.id);
    await waitForSettledRun(service, parallel.id, 'cancelled');
    assert.equal((await service.dashboard()).activeWorkspaceLocks.length, 0);
  } finally { codex.finish('done'); cursor.finish('done'); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('真实 Agent 模板创建隔离执行节点，并在依赖完成后自动调度复核节点', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-task-graph-runtime-'));
  const executions = new Map<string, () => void>();
  const receivedImages = new Map<string, string[]>();
  const attachment = { id: '11111111-1111-1111-1111-111111111111', name: '需求.png', mimeType: 'image/png' as const,
    size: 128, url: '/attachments/requirement' };
  const isolatedIdentities = new Map<string, { workspacePath: string; branch: string; headSha: string }>();
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => new Promise<string>((resolve) => {
    context.onSession(`session-${context.run.id}`);
    receivedImages.set(context.run.id, context.imagePaths);
    executions.set(context.run.id, () => resolve(`完成 ${context.run.objective}`));
  }) };
  const service = await createAgentRuntimeService(directory, {
    adapters: [adapter],
    resolveAttachments: async (ids) => ids.map(() => ({ attachment, filePath: '/private/requirement.png' })),
    resolveWorkspace: async (workspacePath) => isolatedIdentities.get(workspacePath) || ({ ...workspace, workspacePath }),
    createIsolatedWorkspace: async (_workspacePath, branch, workspaceId) => {
      const identity = { workspacePath: `/isolated/${workspaceId}`, branch: `codex/${workspaceId.slice(0, 8)}`, headSha: 'def456' };
      isolatedIdentities.set(identity.workspacePath, identity);
      return { ...identity, sourceWorkspacePath: workspace.workspacePath,
        baseBranch: branch || workspace.branch, isolatedWorkspace: true };
    },
  });
  const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('等待 Agent 任务调度超时');
  };
  try {
    const main = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', reasoningEffort: 'high',
      objective: '主任务', workspacePath: workspace.workspacePath });
    await waitFor(() => executions.has(main.id));
    const { worker, reviewer } = await service.orchestrate(main.id, { templateId: 'implement-review', objective: '完成实现',
      model: 'second-model', reasoningEffort: 'low', accessMode: 'full', attachmentIds: [attachment.id] });
    assert.deepEqual(worker.attachments, [attachment]);
    assert.deepEqual(reviewer.attachments, [attachment]);
    assert.equal(worker.model, 'second-model');
    assert.equal(worker.reasoningEffort, 'low');
    assert.equal(worker.accessMode, 'full');
    assert.equal(reviewer.model, 'second-model');
    assert.equal(reviewer.reasoningEffort, 'low');
    assert.equal(reviewer.mode, 'ask');
    assert.equal(reviewer.accessMode, 'workspace');
    await waitFor(() => executions.has(worker.id));
    assert.equal(worker.status, 'running');
    assert.equal(worker.task?.parentConversationId, main.id);
    assert.equal(worker.task?.role, 'worker');
    assert.equal(worker.task?.source, 'workflow');
    assert.equal(worker.task?.sourceId, 'implement-review');
    assert.equal(worker.sourceWorkspacePath, workspace.workspacePath);
    assert.notEqual(worker.workspacePath, main.workspacePath);
    assert.equal(reviewer.status, 'queued');
    assert.equal(executions.has(reviewer.id), false);
    executions.get(worker.id)!();
    await waitFor(() => executions.has(reviewer.id));
    assert.deepEqual(receivedImages.get(worker.id), ['/private/requirement.png']);
    assert.deepEqual(receivedImages.get(reviewer.id), ['/private/requirement.png']);
    assert.equal((await service.dashboard()).runs.find((run) => run.id === reviewer.id)?.status, 'running');
    executions.get(reviewer.id)!();
    executions.get(main.id)!();
    await waitFor(async () => (await service.dashboard()).runs.filter((run) => [main.id, worker.id, reviewer.id].includes(run.id))
      .every((run) => run.status === 'completed'));
  } finally {
    for (const finish of executions.values()) finish();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('当前轮运行中可连续排入多条消息，并按顺序续接同一 CLI 会话', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-message-queue-test-'));
  const executions: { runId: string; resumeSessionId: string; finish: () => void }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      context.onSession(context.resumeSessionId || 'codex-session-queued');
      resolve(`完成 ${context.run.objective}`);
    };
    executions.push({ runId: context.run.id, resumeSessionId: context.resumeSessionId || '', finish });
    context.signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      reject(new Error('stopped'));
    }, { once: true });
  }) };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('等待排队状态超时');
  };
  try {
    const first = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '第一条', workspacePath: '/selected' });
    await waitFor(() => executions.length === 1);
    assert.equal(first.sessionId, '');

    const second = await service.resume(first.id, '第二条', 'test-model', 'high');
    const third = await service.resume(second.id, '第三条', 'test-model', 'high');
    await assert.rejects(service.resume(first.id, '插入的消息', 'test-model', 'high', [], undefined, 'next'), /没有实时输入连接/);
    assert.equal(second.status, 'queued');
    assert.equal(third.status, 'queued');
    assert.equal(second.parentRunId, first.id);
    assert.equal(third.parentRunId, second.id);
    assert.match(second.events.at(-1)?.message || '', /加入当前会话队列/);
    assert.equal(executions.length, 1);

    executions[0].finish();
    await waitFor(() => executions.length === 2);
    assert.equal(executions[1].runId, second.id);
    assert.equal(executions[1].resumeSessionId, 'codex-session-queued');
    executions[1].finish();
    await waitFor(() => executions.length === 3);
    assert.equal(executions[2].runId, third.id);
    assert.equal(executions[2].resumeSessionId, 'codex-session-queued');
    executions[2].finish();
    await waitFor(async () => (await service.dashboard()).runs.find((run) => run.id === third.id)?.status === 'completed');
  } finally {
    executions.forEach((execution) => execution.finish());
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('历史运行截断后仍按同一会话排队，服务重载后队列身份不变', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-truncated-queue-test-'));
  const sessionId = 'codex-session-truncated-queue';
  const history: AgentRun[] = Array.from({ length: 100 }, (_, index) => ({
    id: `history-${index}`, parentRunId: index ? `history-${index - 1}` : 'removed-root',
    provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: `历史消息 ${index}`, workspacePath: workspace.workspacePath, branch: workspace.branch, headSha: workspace.headSha,
    status: 'completed', sessionId, pid: null, result: '完成', error: '', events: [],
    createdAt: new Date(Date.parse('2026-10-02T00:00:00Z') + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-02T00:00:00Z') + index * 1000).toISOString(),
  }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(history.reverse()));
  const executions: { runId: string; finish: () => void }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: context => new Promise<string>((resolve, reject) => {
    context.onSession(context.resumeSessionId || sessionId);
    executions.push({ runId: context.run.id, finish: () => resolve('完成') });
    context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }) };
  const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('等待会话队列状态超时');
  };
  try {
    let parentId = 'history-99';
    for (let phase = 0; phase < 2; phase++) {
      const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
      try {
        const before = executions.length;
        const current = await service.resume(parentId, `当前轮 ${phase}`);
        await waitFor(() => executions.length === before + 1);
        const next = await service.resume(current.id, `后续轮 ${phase}`);
        assert.equal(next.status, 'queued');
        assert.equal(executions.length, before + 1);
        executions[before].finish();
        await waitFor(() => executions.length === before + 2);
        assert.equal(executions[before + 1].runId, next.id);
        executions[before + 1].finish();
        await waitFor(async () => (await service.dashboard()).runs.find(run => run.id === next.id)?.status === 'completed');
        parentId = next.id;
      } finally {
        executions.forEach(execution => execution.finish());
        await service.close();
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('最近 50 条都来自同一会话时，看板仍返回另两条已保存会话的最新消息', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-conversations-test-'));
  const conversationIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc'];
  const baseTime = Date.parse('2026-10-09T00:00:00Z');
  const makeRun = (id: string, conversationId: string, offset: number): AgentRun => ({
    id, conversationId, queueRootId: conversationId, provider: 'codex', mode: 'ask', accessMode: 'workspace',
    model: 'test-model', reasoningEffort: 'high', objective: id, workspacePath: workspace.workspacePath,
    branch: workspace.branch, headSha: workspace.headSha, status: 'completed', sessionId: `session-${conversationId}`,
    pid: null, result: '完成', error: '', events: [],
    createdAt: new Date(baseTime + offset * 1000).toISOString(),
    updatedAt: new Date(baseTime + offset * 1000).toISOString(),
  });
  const firstConversation = Array.from({ length: 60 }, (_, index) => makeRun(`first-${index}`, conversationIds[0], index + 10)).reverse();
  const stored = [...firstConversation, makeRun('third-latest', conversationIds[2], 2),
    makeRun('second-latest', conversationIds[1], 1)];
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(stored));
  const service = await createAgentRuntimeService(directory, { adapters: [] });
  try {
    const dashboard = await service.dashboard();
    assert.deepEqual(dashboard.runs.slice(0, 50).map((run) => run.id), stored.slice(0, 50).map((run) => run.id));
    assert.deepEqual(dashboard.runs.slice(50).map((run) => run.id), ['third-latest', 'second-latest']);
    const sidebar = buildAgentConversationList(dashboard.runs, [], {});
    assert.deepEqual(new Set(sidebar.map((conversation) => conversation.id)), new Set(conversationIds));
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('超过 100 条历史上限时保留运行中及排队父链，仍从同一物理线程续接', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-active-cap-test-'));
  const sharedSession = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  let finishFirst: () => void = () => {};
  const firstCompletion = new Promise<void>(resolve => { finishFirst = resolve; });
  const executions: { objective: string; resumeSessionId: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    executions.push({ objective: context.run.objective, resumeSessionId: context.resumeSessionId || '' });
    await context.onSession(context.resumeSessionId || (context.run.objective === '持久运行' ? sharedSession : `session-${context.run.id}`));
    if (context.run.objective === '持久运行') await firstCompletion;
    return '完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const first = await service.start({ provider: 'codex', mode: 'ask', model: 'test-model',
      objective: '持久运行', workspacePath: '/selected' });
    const second = await service.resume(first.id, '排队续聊');
    for (let index = 0; index < 101; index++) {
      await service.start({ provider: 'codex', mode: 'ask', model: 'test-model',
        objective: `独立运行 ${index}`, workspacePath: '/selected' });
    }
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8')) as AgentRun[];
    assert.ok(saved.some((run) => run.id === first.id));
    assert.ok(saved.some((run) => run.id === second.id));
    assert.equal(second.status, 'queued');
    finishFirst();
    for (let attempt = 0; attempt < 100 && !executions.some((item) => item.objective === '排队续聊'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(executions.find((item) => item.objective === '排队续聊'),
      { objective: '排队续聊', resumeSessionId: sharedSession });
  } finally { finishFirst(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('超过 100 条仍保留每个显式会话的最新消息与取消会话的已完成轮次锚点', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-explicit-conversation-cap-test-'));
  const file = path.join(directory, 'agent-runs.json');
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const firstConversationId = '22222222-2222-2222-2222-222222222222';
  const secondConversationId = '33333333-3333-3333-3333-333333333333';
  const base: AgentRun = { id: '', queueRootId: '', provider: 'cursor', mode: 'ask', accessMode: 'workspace',
    model: 'test-model', reasoningEffort: '', objective: '历史消息', workspacePath: '/repo/old', branch: 'main', headSha: 'abc',
    status: 'completed', sessionId: '', pid: null, result: '', error: '', events: [],
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:01.000Z' };
  const filler = Array.from({ length: 105 }, (_, index): AgentRun => {
    const id = `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
    return { ...base, id, queueRootId: id, sessionId: `cursor-session-${index}` };
  });
  const anchor = { ...base, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    queueRootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'codex' as const,
    conversationId: firstConversationId, sessionId, codexTurnId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    createdAt: '2026-10-09T00:01:00.000Z' };
  const unverified = { ...anchor, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    queueRootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', codexTurnId: undefined,
    createdAt: '2026-10-09T00:02:00.000Z' };
  const cancelled = { ...anchor, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    queueRootId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', codexTurnId: undefined,
    status: 'cancelled' as const, requiresIsolation: true, objective: '取消的最新消息',
    createdAt: '2026-10-09T00:03:00.000Z' };
  const otherLatest = { ...anchor, id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    queueRootId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', conversationId: secondConversationId,
    codexTurnId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', createdAt: '2026-10-09T00:04:00.000Z',
    updatedAt: '2026-10-09T00:05:00.000Z' };
  const otherPhysicalTail = { ...otherLatest, id: '99999999-9999-9999-9999-999999999999',
    createdAt: '2026-10-09T00:03:30.000Z', updatedAt: '2026-10-09T00:06:00.000Z' };
  await fs.writeFile(file, JSON.stringify([...filler, anchor, unverified, cancelled, otherLatest, otherPhysicalTail]));
  const adapter: AgentRuntimeAdapter = { id: 'cursor', health: async () => health('cursor'), execute: async () => '完成' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    await service.start({ provider: 'cursor', mode: 'ask', model: 'test-model', objective: '触发历史裁剪', workspacePath: '/selected' });
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as AgentRun[];
    const ids = new Set(saved.map((run) => run.id));
    assert.ok(ids.has(anchor.id), '保留最新已验证的 completed-turn 锚点');
    assert.ok(ids.has(cancelled.id), '保留取消会话的最新消息');
    assert.ok(ids.has(otherPhysicalTail.id), '保留较早创建但最后完成的会话消息');
    assert.ok(!ids.has(otherLatest.id), '较晚创建但先完成的消息不应取代物理尾轮');
    assert.ok(saved.length <= 104, `裁剪后运行数量应有界，实际为 ${saved.length}`);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('调整方向会停止当前轮并立即执行指定的排队消息', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-steer-test-'));
  const executions: { runId: string; resumeSessionId: string; finish: () => void }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      context.onSession(context.resumeSessionId || 'codex-session-steer');
      resolve(`完成 ${context.run.objective}`);
    };
    executions.push({ runId: context.run.id, resumeSessionId: context.resumeSessionId || '', finish });
    context.onSession(context.resumeSessionId || 'codex-session-steer');
    context.signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      reject(new Error('stopped'));
    }, { once: true });
  }) };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('等待调整方向状态超时');
  };
  try {
    const first = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', objective: '第一条', workspacePath: '/selected' });
    await waitFor(() => executions.length === 1);
    const second = await service.resume(first.id, '第二条', 'test-model', 'high');
    const third = await service.resume(second.id, '第三条', 'test-model', 'high');

    await service.steer(third.id);
    await waitFor(() => executions.length === 2);
    const dashboard = await service.dashboard();
    assert.equal(dashboard.runs.find((run) => run.id === first.id)?.status, 'cancelled');
    assert.equal(dashboard.runs.find((run) => run.id === second.id)?.status, 'queued');
    assert.equal(executions[1].runId, third.id);
    assert.equal(executions[1].resumeSessionId, 'codex-session-steer');
    assert.match(dashboard.runs.find((run) => run.id === third.id)?.events.at(-2)?.message || '', /调整方向/);

    executions[1].finish();
    await waitFor(() => executions.length === 3);
    assert.equal(executions[2].runId, second.id);
    executions[2].finish();
    await waitFor(async () => (await service.dashboard()).runs.find((run) => run.id === second.id)?.status === 'completed');
  } finally {
    executions.forEach((execution) => execution.finish());
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('运行成功后保存结果，并按精确 session id 创建续接运行', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-resume-test-'));
  const adapter: AgentRuntimeAdapter = { id: 'cursor', health: async () => health('cursor'), execute: async (context) => {
    context.onPid(303);
    context.onSession(context.resumeSessionId || 'cursor-session-5678');
    context.onEvent('message', '已读取仓库');
    return context.resumeSessionId ? '续接结果' : '初次结果';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const first = await service.start({ provider: 'cursor', mode: 'agent', model: 'test-model', objective: '解释并修改模块', workspacePath: '/selected' });
    await waitForSettledRun(service, first.id);
    assert.equal((await service.dashboard()).runs[0].result, '初次结果');
    const resumed = await service.resume(first.id, '继续解释边界', 'second-model');
    await waitForSettledRun(service, resumed.id);
    const runs = (await service.dashboard()).runs;
    assert.equal(resumed.parentRunId, first.id);
    assert.equal(runs[0].sessionId, 'cursor-session-5678');
    assert.equal(runs[0].result, '续接结果');
    assert.equal(runs[0].mode, 'agent');
    assert.equal(runs[0].model, 'second-model');
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('基于已完成的 Codex 会话创建独立分叉，不归入原会话链', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-fork-test-'));
  const repository = path.join(directory, 'repository');
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), 'initial\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  const sourceTurnId = '11111111-1111-1111-1111-111111111111';
  const executions: { resumeSessionId?: string; forkSessionId?: string; forkLastTurnId?: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ ...health('codex'),
    models: health('codex').models.map(model => ({ ...model, serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] })) }), execute: async (context) => {
    executions.push({ resumeSessionId: context.resumeSessionId, forkSessionId: context.forkSessionId,
      forkLastTurnId: context.forkLastTurnId });
    await context.onSession(context.forkSessionId ? 'forked-session-5678' : 'source-session-1234');
    await context.onTurn?.(context.forkSessionId ? '22222222-2222-2222-2222-222222222222' : sourceTurnId);
    return context.forkSessionId ? '分叉完成' : '原会话完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const source = await service.start({ provider: 'codex', mode: 'agent', model: 'test-model', reasoningEffort: 'high', serviceTier: 'priority',
      objective: '原会话任务', workspacePath: repository });
    await waitForSettledRun(service, source.id);
    const forked = await service.fork(source.id, '新会话继续处理');
    await waitForSettledRun(service, forked.id);
    assert.equal(forked.parentRunId, undefined);
    assert.equal(forked.sessionId, 'forked-session-5678');
    assert.match(forked.branch, /^feature\//);
    assert.notEqual(forked.workspacePath, source.workspacePath);
    assert.equal(forked.serviceTier, 'priority');
    const standard = await service.resume(source.id, '常速继续', undefined, undefined, [], undefined, 'append', 'default');
    await waitForSettledRun(service, standard.id);
    assert.equal(standard.serviceTier, 'default');
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8')) as AgentRun[];
    assert.equal(stored.find(run => run.id === source.id)?.serviceTier, 'priority');
    assert.equal(stored.find(run => run.id === standard.id)?.serviceTier, 'default');
    assert.deepEqual(executions, [
      { resumeSessionId: '', forkSessionId: '', forkLastTurnId: '' },
      { resumeSessionId: '', forkSessionId: 'source-session-1234', forkLastTurnId: sourceTurnId },
      { resumeSessionId: 'source-session-1234', forkSessionId: '', forkLastTurnId: '' },
    ]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

function codexSourceFromRuns(sessionId: string, completedRuns: AgentRun[]): CodexSessionSource {
  const first = completedRuns[0];
  const summary: CodexSessionSummary = { id: sessionId, title: '历史 Codex 会话', preview: '历史回答',
    workspacePath: first.workspacePath, branch: first.branch, headSha: first.headSha, model: first.model,
    reasoningEffort: first.reasoningEffort, archived: false, createdAt: first.createdAt,
    updatedAt: completedRuns.at(-1)?.updatedAt || first.updatedAt };
  return { listSessions: async () => [summary], session: async (id) => {
    if (id !== sessionId) throw new Error('找不到该 Codex 会话');
    return { ...summary, turns: completedRuns.map((run) => ({ id: run.codexTurnId!, userMessage: run.objective,
      agentMessage: run.result, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.updatedAt })) };
  } };
}

function legacyExplicitMigrationFixture() {
  const legacyRoot = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const secondRunId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const thirdRunId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const fourthRunId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const foreignRunId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const firstSessionId = '11111111-1111-1111-1111-111111111111';
  const secondSessionId = '22222222-2222-2222-2222-222222222222';
  const turnIds = ['33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
    '55555555-5555-5555-5555-555555555555', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb'];
  const conversationIds = ['66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777',
    '88888888-8888-8888-8888-888888888888'];
  const first: AgentRun = { id: legacyRoot, queueRootId: legacyRoot,
    provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: '旧问题一', workspacePath: '/repo/isolated', sourceWorkspacePath: '/repo/base', baseBranch: 'main',
    isolatedWorkspace: true, branch: 'feature/old', headSha: 'abc', status: 'completed', sessionId: firstSessionId,
    pid: null, result: '旧回答一', error: '', events: [], createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:30.000Z' };
  const second: AgentRun = { ...first, id: secondRunId, conversationId: legacyRoot,
    parentRunId: legacyRoot, objective: '旧问题二',
    result: '旧回答二', createdAt: '2026-10-09T00:01:00.000Z', updatedAt: '2026-10-09T00:01:30.000Z' };
  const third: AgentRun = { ...first, id: thirdRunId, objective: '旧问题三',
    result: '旧回答三', createdAt: '2026-10-09T00:02:00.000Z', updatedAt: '2026-10-09T00:02:30.000Z' };
  const fourth: AgentRun = { ...first, id: fourthRunId, conversationId: legacyRoot,
    parentRunId: thirdRunId, objective: '旧问题四',
    result: '旧回答四', createdAt: '2026-10-09T00:03:00.000Z', updatedAt: '2026-10-09T00:03:30.000Z' };
  const foreign: AgentRun = { ...first, id: foreignRunId, conversationId: legacyRoot,
    sessionId: secondSessionId, objective: '另一线程旧问题',
    result: '另一线程旧回答', createdAt: '2026-10-09T00:04:00.000Z', updatedAt: '2026-10-09T00:04:30.000Z' };
  const turns: CodexSessionTurn[] = [
    { id: turnIds[0], userMessage: first.objective, agentMessage: first.result,
      createdAt: '2026-10-09T00:00:05.000Z', updatedAt: '2026-10-09T00:00:20.000Z', completedAt: '2026-10-09T00:00:20.000Z' },
    { id: turnIds[1], userMessage: second.objective, agentMessage: second.result,
      createdAt: '2026-10-09T00:01:05.000Z', updatedAt: '2026-10-09T00:01:20.000Z', completedAt: '2026-10-09T00:01:20.000Z' },
    { id: turnIds[2], userMessage: third.objective, agentMessage: third.result,
      createdAt: '2026-10-09T00:02:05.000Z', updatedAt: '2026-10-09T00:02:20.000Z', completedAt: '2026-10-09T00:02:20.000Z' },
    { id: turnIds[3], userMessage: fourth.objective, agentMessage: fourth.result,
      createdAt: '2026-10-09T00:03:05.000Z', updatedAt: '2026-10-09T00:03:20.000Z', completedAt: '2026-10-09T00:03:20.000Z' },
    { id: turnIds[4], userMessage: foreign.objective, agentMessage: foreign.result,
      createdAt: '2026-10-09T00:04:05.000Z', updatedAt: '2026-10-09T00:04:20.000Z', completedAt: '2026-10-09T00:04:20.000Z' },
  ];
  const source: CodexSessionSource = { listSessions: async () => [], session: async (id) => ({ id,
    title: '旧会话', preview: '预览', workspacePath: '/repo/isolated', branch: 'feature/old', headSha: 'abc',
    model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:03:00.000Z',
    turns: (id === firstSessionId ? turns.slice(0, 4) : turns.slice(4)).map((turn) => ({ ...turn })) }) };
  const assignments = [first, second, third, fourth].map((run, index) => ({ runId: run.id,
    conversationId: conversationIds[index < 2 ? 0 : 1], codexTurnId: turnIds[index] }));
  return { legacyRoot, first, second, third, fourth, foreign, firstSessionId, secondSessionId,
    turnIds, conversationIds, source, assignments };
}

test('旧显式根可按同一 Codex 线程完整拆分，写盘失败后原归属可重试', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-legacy-root-migration-test-'));
  const file = path.join(directory, 'agent-runs.json');
  const fixture = legacyExplicitMigrationFixture();
  await fs.writeFile(file, JSON.stringify([fixture.first, fixture.second, fixture.third, fixture.fourth]));
  const service = await createAgentRuntimeService(directory, { adapters: [], codexSessionSource: fixture.source });
  try {
    const diskBefore = await fs.readFile(file, 'utf8');
    const memoryBefore = structuredClone((await service.dashboard()).runs);
    await assert.rejects(service.migrateConversationIds([fixture.assignments[0]]), /全部已保存运行|映射不完整/);
    assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
    assert.deepEqual((await service.dashboard()).runs, memoryBefore);

    const blockedTemporary = `${file}.${process.pid}.tmp`;
    await fs.mkdir(blockedTemporary);
    try {
      await assert.rejects(service.migrateConversationIds(fixture.assignments), /EISDIR|directory/);
      assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
      assert.deepEqual((await service.dashboard()).runs, memoryBefore);
    } finally { await fs.rmdir(blockedTemporary); }

    assert.deepEqual(await service.migrateConversationIds(fixture.assignments), { updated: 4 });
    const migrated = (await service.dashboard()).runs;
    for (const [index, run] of migrated.entries()) {
      assert.equal(run.conversationId, fixture.conversationIds[index < 2 ? 0 : 1]);
      assert.equal(run.queueRootId, fixture.legacyRoot);
      assert.equal(run.codexTurnId, fixture.turnIds[index]);
      assert.equal(run.isolatedWorkspace, true);
      assert.equal(run.requiresIsolation, true);
    }
    assert.deepEqual((JSON.parse(await fs.readFile(file, 'utf8')) as AgentRun[])
      .map((run) => run.conversationId), [fixture.conversationIds[0], fixture.conversationIds[0],
      fixture.conversationIds[1], fixture.conversationIds[1]]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('旧显式根重映射拒绝外部归属、既有 continuation 和跨 Codex 线程复用', async () => {
  const fixture = legacyExplicitMigrationFixture();
  const externalId = '99999999-9999-9999-9999-999999999999';
  const cases: { label: string; runs: AgentRun[]; assignments: typeof fixture.assignments }[] = [
    { label: '外部显式 ID', runs: [fixture.first, { ...fixture.second, conversationId: externalId }, fixture.third, fixture.fourth],
      assignments: fixture.assignments },
    { label: '既有 continuation', runs: [fixture.first, { ...fixture.second, continuation: { sessionId: externalId,
      workspacePath: '/repo/prepared', branch: 'feature/prepared', headSha: 'abc', sourceWorkspacePath: '/repo/isolated',
      baseBranch: 'feature/old', isolatedWorkspace: true } }, fixture.third, fixture.fourth],
      assignments: fixture.assignments },
    { label: '最近父链跨 A/B', runs: [fixture.first, fixture.second, fixture.third,
      { ...fixture.fourth, parentRunId: fixture.second.id }], assignments: fixture.assignments },
    { label: '旧根跨线程复用', runs: [fixture.first, fixture.second, fixture.third, fixture.fourth, fixture.foreign],
      assignments: [...fixture.assignments, { runId: fixture.foreign.id,
        conversationId: fixture.conversationIds[2], codexTurnId: fixture.turnIds[4] }] },
  ];
  for (const scenario of cases) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-legacy-root-rejection-test-'));
    const file = path.join(directory, 'agent-runs.json');
    await fs.writeFile(file, JSON.stringify(scenario.runs));
    const service = await createAgentRuntimeService(directory, { adapters: [], codexSessionSource: fixture.source });
    try {
      const diskBefore = await fs.readFile(file, 'utf8');
      const memoryBefore = structuredClone((await service.dashboard()).runs);
      await assert.rejects(service.migrateConversationIds(scenario.assignments), `${scenario.label} 应拒绝重映射`);
      assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
      assert.deepEqual((await service.dashboard()).runs, memoryBefore);
    } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
  }
});

test('显式会话迁移须完整且精确核对原生已完成轮次，失败不修改内存或磁盘', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-conversation-migration-test-'));
  const file = path.join(directory, 'agent-runs.json');
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const runIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  const conversationIds = ['cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd'];
  const turnIds = ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  const startedAt = '2026-10-09T00:00:00.000Z';
  const finishedAt = '2026-10-09T00:00:40.000Z';
  const stored: AgentRun[] = runIds.map((id) => ({ id, queueRootId: id,
    provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: '分析迁移', workspacePath: '/repo/migrate', branch: 'main', headSha: 'abc', status: 'completed',
    sessionId, pid: null, result: '完成', error: '', events: [], createdAt: startedAt, updatedAt: finishedAt }));
  await fs.writeFile(file, JSON.stringify(stored));
  const summary: CodexSessionSummary = { id: sessionId, title: '旧会话', preview: '预览', workspacePath: '/repo/migrate',
    branch: 'main', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: startedAt, updatedAt: finishedAt };
  const turns: CodexSessionTurn[] = turnIds.map((id, index) => ({ id, userMessage: '分析迁移', agentMessage: '完成',
    createdAt: `2026-10-09T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
    updatedAt: `2026-10-09T00:00:${String(index + 20).padStart(2, '0')}.000Z`,
    completedAt: `2026-10-09T00:00:${String(index + 20).padStart(2, '0')}.000Z` }));
  const source: CodexSessionSource = { listSessions: async () => [summary],
    session: async () => ({ ...summary, turns: turns.map((turn) => ({ ...turn })) }) };
  const service = await createAgentRuntimeService(directory, { adapters: [], codexSessionSource: source });
  const assignments = runIds.map((runId, index) => ({ runId, conversationId: conversationIds[index], codexTurnId: turnIds[index] }));
  try {
    const diskBefore = await fs.readFile(file, 'utf8');
    const memoryBefore = structuredClone((await service.dashboard()).runs);
    const rejectWithoutChanges = async (input: typeof assignments, message: RegExp) => {
      await assert.rejects(service.migrateConversationIds(input), message);
      assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
      assert.deepEqual((await service.dashboard()).runs, memoryBefore);
    };

    await rejectWithoutChanges([assignments[0]], /全部已保存运行|映射不完整/);
    await rejectWithoutChanges([assignments[0], assignments[0]], /重复运行/);
    await rejectWithoutChanges([assignments[0], { ...assignments[1], codexTurnId: turnIds[0] }], /重复.*轮次|轮次.*重复/);

    turns[1].userMessage = '另一条消息';
    await rejectWithoutChanges(assignments, /轮次.*无法核对/);
    turns[1].userMessage = '分析迁移';

    turns[1].completedAt = null;
    await rejectWithoutChanges(assignments, /轮次.*未完成|已完成.*轮次|轮次.*无法核对/);
    delete turns[1].completedAt;
    await rejectWithoutChanges(assignments, /轮次.*未完成|已完成.*轮次|轮次.*无法核对/);
    turns[1].completedAt = turns[1].updatedAt;

    const blockedTemporary = `${file}.${process.pid}.tmp`;
    await fs.mkdir(blockedTemporary);
    try { await rejectWithoutChanges(assignments, /EISDIR|directory/); }
    finally { await fs.rmdir(blockedTemporary); }

    assert.deepEqual(await service.migrateConversationIds(assignments), { updated: 2 });
    const migrated = (await service.dashboard()).runs;
    assert.deepEqual(migrated.map((run) => run.conversationId), conversationIds);
    assert.deepEqual(migrated.map((run) => run.codexTurnId), turnIds);
    assert.ok(migrated.every((run) => run.requiresIsolation));
    assert.deepEqual((JSON.parse(await fs.readFile(file, 'utf8')) as AgentRun[])
      .map((run) => [run.conversationId, run.codexTurnId, run.requiresIsolation]),
    conversationIds.map((id, index) => [id, turnIds[index], true]));
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('最新消息取消时从本组已验证完成轮次预分叉，续聊不重发取消的消息', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cancelled-isolation-test-'));
  const repository = path.join(directory, 'repository');
  const prepared = path.join(directory, 'prepared');
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), 'initial\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/cancelled', prepared, 'main']);
  const actualRepository = await fs.realpath(repository);
  const actualPrepared = await fs.realpath(prepared);
  const headSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const oldSessionId = '11111111-1111-1111-1111-111111111111';
  const conversationId = '22222222-2222-2222-2222-222222222222';
  const otherConversationId = '33333333-3333-3333-3333-333333333333';
  const anchorId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const cancelledId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const anchorTurnId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const newSessionId = '99999999-9999-9999-9999-999999999999';
  const base: AgentRun = { id: anchorId, conversationId, queueRootId: anchorId, provider: 'codex', mode: 'agent',
    accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high', objective: '已完成的旧消息',
    workspacePath: actualRepository, branch: 'main', headSha, status: 'completed', sessionId: oldSessionId,
    codexTurnId: anchorTurnId, pid: null, result: '旧回复', error: '', events: [], requiresIsolation: true,
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:30.000Z' };
  const cancelled: AgentRun = { ...base, id: cancelledId, queueRootId: anchorId, objective: '已取消的消息',
    status: 'cancelled', codexTurnId: undefined, result: '', error: '',
    events: [
      { id: 'queued', type: 'lifecycle', message: '消息已加入当前会话队列，正在等待上一轮完成',
        createdAt: '2026-10-09T00:03:01.000Z' },
      { id: 'cancelled', type: 'lifecycle', message: '已取消排队中的 Agent',
        createdAt: '2026-10-09T00:03:02.000Z' },
    ],
    createdAt: '2026-10-09T00:03:00.000Z', updatedAt: '2026-10-09T00:03:30.000Z' };
  const other: AgentRun = { ...base, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    conversationId: otherConversationId, queueRootId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    codexTurnId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', objective: '另一组旧消息',
    createdAt: '2026-10-09T00:01:00.000Z', updatedAt: '2026-10-09T00:01:30.000Z' };
  const unverified: AgentRun = { ...base, id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    objective: '较新的未核对完成消息', codexTurnId: undefined,
    createdAt: '2026-10-09T00:02:00.000Z', updatedAt: '2026-10-09T00:02:30.000Z' };
  const file = path.join(directory, 'agent-runs.json');
  const forks: { sessionId: string; lastTurnId: string; workspacePath: string }[] = [];
  const executions: { objective: string; resumeSessionId: string; workspacePath: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    executions.push({ objective: context.run.objective, resumeSessionId: context.resumeSessionId || '',
      workspacePath: context.run.workspacePath });
    await context.onSession(context.resumeSessionId || 'unexpected');
    await context.onTurn?.('12345678-1234-1234-1234-123456789abc');
    return '新回复';
  } };
  const createService = (nativeRuns: AgentRun[] = [base, other]) => createAgentRuntimeService(directory, { adapters: [adapter],
    codexSessionSource: codexSourceFromRuns(oldSessionId, nativeRuns),
    forkCodexThread: async (_binary, input) => {
      forks.push({ sessionId: input.sessionId, lastTurnId: input.lastTurnId, workspacePath: input.workspacePath });
      return newSessionId;
    } });
  try {
    const unsafeCases: { runs: AgentRun[]; error: RegExp }[] = [
      { runs: [base, unverified, cancelled, other], error: /无法核对物理轮次|缺少可验证的最新已完成 Codex 轮次/ },
      { runs: [base, { ...unverified, status: 'failed', error: '执行失败', events: [
        { id: 'started', type: 'lifecycle', message: '已进入执行器', createdAt: unverified.createdAt },
      ] }, cancelled, other], error: /无法核对物理轮次|可能进入执行器|缺少可核对的 Codex 轮次/ },
      { runs: [base, { ...cancelled, codexTurnId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        events: [{ id: 'started', type: 'lifecycle', message: '已进入执行器', createdAt: cancelled.createdAt }] }, other],
      error: /无法核对物理轮次|可能进入执行器/ },
    ];
    for (const unsafe of unsafeCases) {
      await fs.writeFile(file, JSON.stringify(unsafe.runs));
      const blocked = await createService();
      try {
        await assert.rejects(blocked.prepareConversationIsolation(conversationId, prepared), unsafe.error);
        assert.deepEqual(forks, []);
      } finally { await blocked.close(); }
    }

    const historicalFailure: AgentRun = { ...base, id: '77777777-7777-7777-7777-777777777777',
      status: 'failed', codexTurnId: undefined, objective: '旧失败消息', result: '', error: '历史执行失败',
      events: [{ id: 'historical-error', type: 'diagnostic', message: '历史执行失败',
        createdAt: '2026-10-08T00:00:30.000Z' }], changedFiles: [],
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:30.000Z' };
    const historicalFailedTurn: AgentRun = { ...historicalFailure, id: '88888888-8888-8888-8888-888888888888',
      codexTurnId: '99999999-1111-1111-1111-111111111111', objective: '较早且原生已结束的失败轮次' };
    const historicalCompleted: AgentRun = { ...historicalFailure, id: '99999999-2222-2222-2222-222222222222',
      status: 'completed', error: '', objective: '旧已完成但未记录轮次',
      createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:00:30.000Z' };
    const nativeHistoricalCompleted = { ...historicalCompleted, codexTurnId: '99999999-3333-3333-3333-333333333333' };
    await fs.writeFile(file, JSON.stringify([base, cancelled, other, historicalFailure, historicalFailedTurn, historicalCompleted]));
    const service = await createService([historicalFailedTurn, nativeHistoricalCompleted, base, other]);
    try {
      const isolation = await service.prepareConversationIsolation(conversationId, prepared);
      assert.equal(isolation.sourceRunId, anchorId);
      assert.equal(isolation.continuation.forkSourceRunId, anchorId);
      assert.equal(isolation.continuation.forkSourceTurnId, anchorTurnId);
      assert.equal(isolation.continuation.sessionId, newSessionId);
      assert.deepEqual(forks, [{ sessionId: oldSessionId, lastTurnId: anchorTurnId, workspacePath: actualPrepared }]);
      assert.deepEqual(executions, []);
      const before = JSON.parse(await fs.readFile(file, 'utf8')) as AgentRun[];
      assert.equal(before.find((run) => run.id === cancelledId)?.continuation?.sessionId, newSessionId);
      assert.equal(before.find((run) => run.id === anchorId)?.continuation, undefined);

      const resumed = await service.resume(cancelledId, '新的问题');
      for (let attempt = 0; attempt < 50 && !executions.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(resumed.parentRunId, cancelledId);
      assert.equal(resumed.conversationId, conversationId);
      assert.deepEqual(executions, [{ objective: '新的问题', resumeSessionId: newSessionId, workspacePath: actualPrepared }]);
      const oldCancelled = (await service.dashboard()).runs.find((run) => run.id === cancelledId);
      assert.equal(oldCancelled?.objective, '已取消的消息');
      assert.equal(oldCancelled?.status, 'cancelled');
      assert.equal(oldCancelled?.error, '');
      assert.deepEqual(oldCancelled?.events, cancelled.events);
    } finally { await service.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('队列乱序完成时按原生最后物理轮次分叉，后续未知或未完成轮次阻止分叉', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-out-of-order-fork-test-'));
  const repository = path.join(directory, 'repository');
  const prepared = path.join(directory, 'prepared');
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), 'initial\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/out-of-order', prepared, 'main']);
  const actualRepository = await fs.realpath(repository);
  const actualPrepared = await fs.realpath(prepared);
  const headSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const conversationId = '22222222-2222-2222-2222-222222222222';
  const earlyRunId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const lateRunId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const earlyTurnId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const lateTurnId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const early: AgentRun = { id: earlyRunId, conversationId, queueRootId: earlyRunId, provider: 'codex',
    mode: 'agent', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high', objective: '先创建后完成',
    workspacePath: actualRepository, branch: 'main', headSha, status: 'completed', sessionId,
    codexTurnId: earlyTurnId, pid: null, result: '先创建的结果', error: '', events: [], requiresIsolation: true,
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:03:00.000Z' };
  const late: AgentRun = { ...early, id: lateRunId, parentRunId: earlyRunId, objective: '后创建先完成',
    codexTurnId: lateTurnId, result: '后创建的结果', createdAt: '2026-10-09T00:01:00.000Z',
    updatedAt: '2026-10-09T00:02:00.000Z' };
  const file = path.join(directory, 'agent-runs.json');
  await fs.writeFile(file, JSON.stringify([early, late]));
  const nativeDetail = await codexSourceFromRuns(sessionId, [late, early]).session(sessionId);
  let nativeTurns = nativeDetail.turns;
  const source: CodexSessionSource = { listSessions: async () => [],
    session: async () => ({ ...nativeDetail, turns: nativeTurns.map((turn) => ({ ...turn })) }) };
  const forks: { sessionId: string; lastTurnId: string; workspacePath: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: source,
    forkCodexThread: async (_binary, input) => {
      forks.push({ sessionId: input.sessionId, lastTurnId: input.lastTurnId, workspacePath: input.workspacePath });
      return '99999999-9999-9999-9999-999999999999';
    } });
  try {
    const diskBefore = await fs.readFile(file, 'utf8');
    const unknown: CodexSessionTurn = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', userMessage: '未知的后续消息',
      agentMessage: '未知回复', createdAt: '2026-10-09T00:04:00.000Z', updatedAt: '2026-10-09T00:04:20.000Z',
      completedAt: '2026-10-09T00:04:20.000Z' };
    for (const extra of [unknown, { ...unknown, id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', completedAt: null }]) {
      nativeTurns = [...nativeDetail.turns, extra];
      await assert.rejects(service.prepareConversationIsolation(conversationId, prepared), /未归属或未完成/);
      assert.deepEqual(forks, []);
      assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
    }

    nativeTurns = nativeDetail.turns;
    const isolation = await service.prepareConversationIsolation(conversationId, prepared);
    assert.equal(isolation.sourceRunId, earlyRunId);
    assert.equal(isolation.continuation.forkSourceRunId, earlyRunId);
    assert.equal(isolation.continuation.forkSourceTurnId, earlyTurnId);
    assert.deepEqual(forks, [{ sessionId, lastTurnId: earlyTurnId, workspacePath: actualPrepared }]);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as AgentRun[];
    assert.equal(saved.find((run) => run.id === earlyRunId)?.continuation?.forkSourceRunId, earlyRunId);
    assert.equal(saved.find((run) => run.id === lateRunId)?.continuation, undefined);
    await assert.rejects(service.resume(lateRunId, '不能续接较早完成的轮次'), /旧 Codex 线程/);
    const resumed = await service.resume(earlyRunId, '从物理尾轮继续');
    assert.equal(resumed.parentRunId, earlyRunId);
    assert.equal(resumed.workspacePath, actualPrepared);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('显式会话预分叉不生成用户轮次，旧记录保留原路径，后续只使用各自新线程与工作区', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-prepared-isolation-test-'));
  const repository = path.join(directory, 'repository');
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), 'initial\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  const [firstWorkspace, secondWorkspace] = ['first', 'second'].map((name) => path.join(directory, name));
  await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/first', firstWorkspace, 'main']);
  await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/second', secondWorkspace, 'main']);
  const [actualRepository, actualFirstWorkspace, actualSecondWorkspace] = await Promise.all(
    [repository, firstWorkspace, secondWorkspace].map((item) => fs.realpath(item)));
  await fs.writeFile(path.join(repository, 'README.md'), 'dirty source\n');
  const headSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const oldSessionId = '11111111-1111-1111-1111-111111111111';
  const runIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  const conversationIds = ['cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd'];
  const turnIds = ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  const stored: AgentRun[] = runIds.map((id, index) => ({ id, conversationId: conversationIds[index], queueRootId: id,
    provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: `旧消息 ${index}`, workspacePath: actualRepository, branch: 'main', headSha, status: 'completed',
    sessionId: oldSessionId, codexTurnId: turnIds[index], pid: null, result: '完成', error: '', events: [],
    createdAt: new Date(Date.parse('2026-10-09T00:00:00Z') + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-09T00:00:30Z') + index * 1000).toISOString() }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(stored));
  const forks: { sessionId: string; lastTurnId: string; workspacePath: string }[] = [];
  const executions: { sessionId: string; workspacePath: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    executions.push({ sessionId: context.resumeSessionId || '', workspacePath: context.run.workspacePath });
    await context.onSession(context.resumeSessionId || 'unexpected');
    await context.onTurn?.('12345678-1234-1234-1234-123456789abc');
    return '新线程续聊完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter],
    codexSessionSource: codexSourceFromRuns(oldSessionId, stored),
    forkCodexThread: async (_binary, input) => {
      forks.push({ sessionId: input.sessionId, lastTurnId: input.lastTurnId, workspacePath: input.workspacePath });
      return input.lastTurnId === turnIds[0] ? '11111111-2222-3333-4444-555555555555' : '66666666-7777-8888-9999-aaaaaaaaaaaa';
    } });
  try {
    await assert.rejects(service.prepareConversationIsolation(conversationIds[0]), /未提交或未跟踪/);
    assert.deepEqual(forks, []);
    await assert.rejects(service.prepareConversationIsolation(conversationIds[0], firstWorkspace), /文件清单不一致/);
    await fs.writeFile(path.join(firstWorkspace, 'README.md'), 'wrong snapshot\n');
    await assert.rejects(service.prepareConversationIsolation(conversationIds[0], firstWorkspace), /快照.*不一致/);
    await fs.copyFile(path.join(repository, 'README.md'), path.join(firstWorkspace, 'README.md'));
    await fs.copyFile(path.join(repository, 'README.md'), path.join(secondWorkspace, 'README.md'));
    await fs.writeFile(path.join(repository, 'draft.txt'), 'untracked snapshot\n');
    await assert.rejects(service.prepareConversationIsolation(conversationIds[0], firstWorkspace), /文件清单不一致/);
    await fs.copyFile(path.join(repository, 'draft.txt'), path.join(firstWorkspace, 'draft.txt'));
    await fs.copyFile(path.join(repository, 'draft.txt'), path.join(secondWorkspace, 'draft.txt'));
    const first = await service.prepareConversationIsolation(conversationIds[0], firstWorkspace);
    const second = await service.prepareConversationIsolation(conversationIds[1], secondWorkspace);
    assert.deepEqual(forks, [
      { sessionId: oldSessionId, lastTurnId: turnIds[0], workspacePath: actualFirstWorkspace },
      { sessionId: oldSessionId, lastTurnId: turnIds[1], workspacePath: actualSecondWorkspace },
    ]);
    assert.deepEqual(executions, []);
    assert.equal(first.continuation.workspacePath, actualFirstWorkspace);
    assert.equal(second.continuation.workspacePath, actualSecondWorkspace);
    const before = (await service.dashboard()).runs;
    assert.ok(before.every((run) => run.workspacePath === actualRepository && run.sessionId === oldSessionId));
    const resumed = await service.resume(runIds[0], '第一组续聊');
    const resumedSecond = await service.resume(runIds[1], '第二组续聊');
    for (let attempt = 0; attempt < 50 && executions.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(executions, [
      { sessionId: first.continuation.sessionId, workspacePath: actualFirstWorkspace },
      { sessionId: second.continuation.sessionId, workspacePath: actualSecondWorkspace },
    ]);
    assert.equal(resumed.conversationId, conversationIds[0]);
    assert.equal(resumedSecond.conversationId, conversationIds[1]);
    assert.equal(resumed.queueRootId, resumed.id);
    assert.equal(resumedSecond.queueRootId, resumedSecond.id);
    assert.notEqual(resumed.queueRootId, resumedSecond.queueRootId);
    await assert.rejects(service.resume(runIds[0], '旧消息不能回流'), /旧 Codex 线程/);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('一支预分叉后另一支发送仍从自身历史轮次分叉，不续写共享旧线程', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-partial-isolation-test-'));
  const repository = path.join(directory, 'repository');
  const prepared = path.join(directory, 'prepared');
  await exec('git', ['init', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'delivery@example.test']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  await fs.writeFile(path.join(repository, 'README.md'), 'initial\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'initial']);
  await exec('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/prepared', prepared, 'main']);
  const actualRepository = await fs.realpath(repository);
  const headSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const oldSessionId = '11111111-1111-1111-1111-111111111111';
  const runIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  const conversationIds = ['cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd'];
  const turnIds = ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  const stored: AgentRun[] = runIds.map((id, index) => ({ id, conversationId: conversationIds[index], queueRootId: id,
    provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: `旧消息 ${index}`, workspacePath: actualRepository, branch: 'main', headSha, status: 'completed',
    sessionId: oldSessionId, codexTurnId: turnIds[index], pid: null, result: '完成', error: '', events: [],
    createdAt: new Date(Date.parse('2026-10-09T00:00:00Z') + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-09T00:00:30Z') + index * 1000).toISOString() }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(stored));
  const executions: { forkSessionId: string; forkLastTurnId: string; resumeSessionId: string; workspacePath: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    executions.push({ forkSessionId: context.forkSessionId || '', forkLastTurnId: context.forkLastTurnId || '',
      resumeSessionId: context.resumeSessionId || '', workspacePath: context.run.workspacePath });
    await context.onSession('33333333-3333-3333-3333-333333333333');
    await context.onTurn?.('44444444-4444-4444-4444-444444444444');
    return '完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter],
    codexSessionSource: codexSourceFromRuns(oldSessionId, stored),
    forkCodexThread: async () => '22222222-2222-2222-2222-222222222222' });
  try {
    await service.prepareConversationIsolation(conversationIds[0], prepared);
    const resumed = await service.resume(runIds[1], '另一支继续');
    for (let attempt = 0; attempt < 50 && !executions.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resumed.conversationId, conversationIds[1]);
    assert.equal(resumed.queueRootId, resumed.id);
    assert.equal(executions[0].forkSessionId, oldSessionId);
    assert.equal(executions[0].forkLastTurnId, turnIds[1]);
    assert.equal(executions[0].resumeSessionId, '');
    assert.notEqual(executions[0].workspacePath, actualRepository);
    assert.match(resumed.branch, /^feature\//);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('同步的历史 Codex 会话可按原 session id 续接并保留来源关系', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-resume-test-'));
  const session: CodexSessionSummary = { id: '77777777-7777-7777-7777-777777777777', title: '历史任务', preview: '历史回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const source: CodexSessionSource = { listSessions: async () => [session], session: async () => ({ ...session, turns: [] }) };
  const resumedIds: string[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    resumedIds.push(context.resumeSessionId || '');
    context.onSession(context.resumeSessionId || 'unexpected-session');
    return '续接完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace, codexSessionSource: source });
  try {
    await service.syncCodexSessions();
    const first = await service.resumeCodexSession(session.id, '继续处理', 'test-model', 'high', [], 'workspace', 'default');
    await waitForSettledRun(service, first.id);
    assert.equal(resumedIds[0], session.id);
    assert.equal(first.originSessionId, session.id);
    assert.equal(first.sessionId, session.id);
    assert.equal(first.mode, 'agent');
    assert.equal(first.serviceTier, 'default');
    const second = await service.resume(first.id, '再次继续', 'second-model', 'high');
    await waitForSettledRun(service, second.id);
    assert.equal(second.parentRunId, first.id);
    assert.equal(second.serviceTier, 'default');
    assert.equal(second.originSessionId, session.id);
    assert.equal(resumedIds[1], session.id);
    assert.deepEqual(await service.removeConversation(first.id), { deleted: 2 });
    assert.deepEqual((await service.dashboard()).codexSessions, []);
    assert.equal((await service.dashboard()).codexSync.hidden, 1);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Agent 运行变化会通知已订阅的实时客户端，取消订阅后停止通知', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-subscribe-test-'));
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    context.onPid(404);
    context.onSession('codex-session-live');
    context.onEvent('message', '实时结果');
    return '执行完成';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  const revisions: number[] = [];
  const unsubscribe = service.subscribe((revision) => revisions.push(revision));
  try {
    const first = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '验证实时更新', workspacePath: '/selected' });
    await waitForSettledRun(service, first.id);
    assert.ok(revisions.length >= 4);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));
    unsubscribe();
    const received = revisions.length;
    const second = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '取消订阅后的运行', workspacePath: '/selected' });
    await waitForSettledRun(service, second.id);
    assert.equal(revisions.length, received);
  } finally { unsubscribe(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('删除进行中的会话先取消全部续聊排队并等待退出，不影响其他运行或复活记录', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-delete-running-test-'));
  const executions: string[] = [];
  const finishes = new Map<string, () => void>();
  const aborted = new Set<string>();
  let onFirstStarted!: () => void, onOtherStarted!: () => void, onStopped!: () => void;
  const firstStarted = new Promise<void>(resolve => { onFirstStarted = resolve; });
  const otherStarted = new Promise<void>(resolve => { onOtherStarted = resolve; });
  const stopped = new Promise<void>(resolve => { onStopped = resolve; });
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async context => {
    executions.push(context.run.id);
    context.onSession(`session-${context.run.id}`);
    const completion = new Promise<string>(resolve => { finishes.set(context.run.id, () => {
      context.onOutput?.('退出前的最后一次输出');
      resolve('执行收尾完成');
    }); });
    context.signal.addEventListener('abort', () => { aborted.add(context.run.id); onStopped(); }, { once: true });
    if (context.run.objective === '待删除') onFirstStarted(); else onOtherStarted();
    return completion;
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const first = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '待删除', workspacePath: '/selected' });
    await firstStarted;
    const second = await service.resume(first.id, '第二条');
    const third = await service.resume(second.id, '第三条');
    assert.equal(second.status, 'queued');
    assert.equal(third.status, 'queued');
    const other = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '保留会话', workspacePath: '/selected' });
    await otherStarted;
    let removed = false;
    const removal = service.removeConversation(third.id).then(result => { removed = true; return result; });
    await stopped;
    assert.equal(removed, false);
    assert.deepEqual([...aborted], [first.id]);
    assert.equal(second.status, 'cancelled');
    assert.equal(third.status, 'cancelled');
    assert.ok((await service.dashboard()).runs.some(run => run.id === first.id));
    finishes.get(first.id)!();
    assert.deepEqual(await removal, { deleted: 3 });
    const dashboard = await service.dashboard();
    assert.deepEqual(executions, [first.id, other.id]);
    assert.deepEqual(dashboard.runs.map(run => run.id), [other.id]);
    assert.equal(dashboard.runs[0].status, 'running');
    assert.deepEqual(dashboard.activeWorkspaceLocks.map(lock => lock.runId), [other.id]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8')).map((run: AgentRun) => run.id), [other.id]);
    await assert.rejects(service.resume(first.id, '删除后的续聊'), /找不到/);
  } finally {
    for (const finish of finishes.values()) finish();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('删除一条排队续聊会阻止其执行，并让后续消息接回上一轮', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-delete-queued-run-test-'));
  const executions: string[] = [];
  const finishes = new Map<string, (value: string) => void>();
  const removedAttachments: string[][] = [];
  let firstStarted!: () => void, thirdStarted!: () => void;
  const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve; });
  const thirdRunning = new Promise<void>((resolve) => { thirdStarted = resolve; });
  const attachment = { id: '11111111-1111-1111-1111-111111111111', name: '待删除.png', mimeType: 'image/png' as const,
    size: 128, url: '/api/agent-runtimes/attachments/11111111-1111-1111-1111-111111111111' };
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async (context) => {
    executions.push(context.run.id);
    context.onSession('codex-delete-queued-session');
    if (executions.length === 1) firstStarted();
    else thirdStarted();
    return new Promise<string>((resolve) => { finishes.set(context.run.id, resolve); });
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace,
    resolveAttachments: async () => [{ attachment, filePath: '/private/queued-image.png' }],
    removeAttachments: async (ids) => { removedAttachments.push(ids); } });
  try {
    const first = await service.start({ provider: 'codex', mode: 'ask', model: 'test-model', objective: '第一条', workspacePath: '/selected' });
    await firstRunning;
    const second = await service.resume(first.id, '删除这条', undefined, undefined, [attachment.id]);
    const third = await service.resume(second.id, '保留这条');
    assert.equal(second.status, 'queued');
    assert.equal(third.status, 'queued');
    assert.deepEqual(await service.removeQueuedRun(second.id), { deleted: true });
    const afterDelete = await service.dashboard();
    assert.equal(afterDelete.runs.some((run) => run.id === second.id), false);
    assert.equal(afterDelete.runs.find((run) => run.id === third.id)?.parentRunId, first.id);
    assert.deepEqual(removedAttachments, [[attachment.id]]);
    await assert.rejects(service.removeQueuedRun(first.id), /只有排队中的续聊消息/);
    finishes.get(first.id)!('第一条完成');
    await thirdRunning;
    assert.deepEqual(executions, [first.id, third.id]);
    finishes.get(third.id)!('第三条完成');
  } finally {
    for (const finish of finishes.values()) finish('测试收尾');
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('删除会话会清理根运行和全部续接运行，不影响其他会话', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-delete-test-'));
  const stored = [
    { id: 'root', provider: 'codex', mode: 'agent', model: 'test-model', objective: '根会话', createdAt: '2026-09-16T00:00:00.000Z' },
    { id: 'child', parentRunId: 'root', provider: 'codex', mode: 'agent', model: 'test-model', objective: '续聊', createdAt: '2026-09-16T00:01:00.000Z' },
    { id: 'other', provider: 'codex', mode: 'ask', model: '', objective: '其他会话', createdAt: '2026-09-16T00:02:00.000Z' },
  ].map((run) => ({ ...run, workspacePath: workspace.workspacePath, branch: workspace.branch, headSha: workspace.headSha,
    status: 'completed', sessionId: run.id === 'other' ? 'other-codex-session' : 'codex-session-1234',
    pid: null, result: '', error: '', events: [], updatedAt: run.createdAt }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(stored));
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    assert.deepEqual(await service.removeConversation('child'), { deleted: 2 });
    assert.deepEqual((await service.dashboard()).runs.map((run) => run.id), ['other']);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('删除已隔离会话不会隐藏仍共享的旧线程，独占的新线程同步后也不复活', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-delete-isolated-test-'));
  const oldSessionId = '11111111-1111-1111-1111-111111111111';
  const newSessionId = '22222222-2222-2222-2222-222222222222';
  const conversationIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  const stored: AgentRun[] = conversationIds.map((conversationId, index) => ({
    id: index ? 'dddddddd-dddd-dddd-dddd-dddddddddddd' : 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    conversationId, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'test-model', reasoningEffort: 'high',
    objective: `会话 ${index}`, workspacePath: workspace.workspacePath, branch: workspace.branch, headSha: workspace.headSha,
    status: 'completed', sessionId: oldSessionId, pid: null, result: '', error: '', events: [],
    ...(index ? {} : { continuation: { sessionId: newSessionId, workspacePath: '/isolated', branch: 'feature/isolated',
      headSha: workspace.headSha, sourceWorkspacePath: workspace.workspacePath, baseBranch: workspace.branch,
      isolatedWorkspace: true as const } }),
    createdAt: new Date(Date.parse('2026-10-09T00:00:00Z') + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-09T00:00:00Z') + index * 1000).toISOString(),
  }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(stored));
  const sessions: CodexSessionSummary[] = [oldSessionId, newSessionId].map((id) => ({ id, title: id, preview: '',
    workspacePath: workspace.workspacePath, branch: workspace.branch, headSha: workspace.headSha,
    model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' }));
  const source: CodexSessionSource = { listSessions: async () => sessions,
    session: async (id) => ({ ...sessions.find((item) => item.id === id)!, turns: [] }) };
  const service = await createAgentRuntimeService(directory, { adapters: [], codexSessionSource: source,
    resolveWorkspace: async (workspacePath) => ({ ...workspace, workspacePath }) });
  try {
    await service.syncCodexSessions();
    assert.deepEqual((await service.dashboard()).codexSessions.map((session) => session.id), [oldSessionId, newSessionId]);
    assert.deepEqual(await service.removeConversation(conversationIds[0]), { deleted: 1 });
    await service.syncCodexSessions();
    assert.deepEqual((await service.dashboard()).codexSessions.map((session) => session.id), [oldSessionId]);
    assert.deepEqual(await service.removeConversation(conversationIds[1]), { deleted: 1 });
    await service.syncCodexSessions();
    assert.deepEqual((await service.dashboard()).codexSessions, []);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Codex 会话同步排除归档记录，重复执行且删除后不会再次出现', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-sync-test-'));
  const sessions: CodexSessionSummary[] = [
    { id: '11111111-1111-1111-1111-111111111111', title: '当前会话', preview: '预览一', workspacePath: '/repo/one',
      branch: 'feature/one', headSha: 'abc', model: 'gpt-5.6-sol', reasoningEffort: 'high', archived: false,
      createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T01:00:00.000Z' },
    { id: '22222222-2222-2222-2222-222222222222', title: '归档会话', preview: '预览二', workspacePath: '/repo/two',
      branch: 'main', headSha: 'def', model: 'gpt-5.5', reasoningEffort: 'xhigh', archived: true,
      createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T01:00:00.000Z' },
  ];
  const source: CodexSessionSource = { listSessions: async () => sessions, session: async (id) => ({
    ...sessions.find((item) => item.id === id)!, turns: [{ id: 'turn-1', userMessage: '问题', agentMessage: '回答',
      createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' }],
  }) };
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: source });
  try {
    assert.deepEqual(await service.syncCodexSessions(), { syncedAt: (await service.dashboard()).codexSync.syncedAt, total: 1, hidden: 0 });
    await service.syncCodexSessions();
    assert.equal((await service.dashboard()).codexSessions.length, 1);
    await service.updateConversationTitle(sessions[0].id, '同步会话自定义标题');
    await service.syncCodexSessions();
    assert.equal((await service.dashboard()).conversationTitles[sessions[0].id], '同步会话自定义标题');
    assert.equal((await service.codexSession(sessions[0].id)).turns[0].agentMessage, '回答');
    assert.deepEqual(await service.removeCodexSession(sessions[0].id), { deleted: true });
    await service.syncCodexSessions();
    const dashboard = await service.dashboard();
    assert.deepEqual(dashboard.codexSessions.map((session) => session.id), []);
    assert.equal(dashboard.codexSync.hidden, 1);
    assert.equal(dashboard.conversationTitles[sessions[0].id], undefined);
  } finally { await service.close(); }
  const recovered = await createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: source });
  try {
    await recovered.syncCodexSessions();
    assert.deepEqual((await recovered.dashboard()).codexSessions.map((session) => session.id), []);
  } finally { await recovered.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Codex 会话同步会持久化完整对话并在服务重启后读取本地缓存', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-detail-cache-test-'));
  const session: CodexSessionSummary = {
    id: '77777777-7777-7777-7777-777777777777', title: '完整会话', preview: '会话预览', workspacePath: '/repo/detail',
    branch: 'feature/detail', headSha: '789', model: 'gpt-5.6-sol', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T01:00:00.000Z',
  };
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => '' };
  const source: CodexSessionSource = { listSessions: async () => [session], session: async () => ({
    ...session,
    turns: [{ id: 'turn-1', userMessage: '同步完整问题', agentMessage: '同步完整回答',
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:01:00.000Z' }],
  }) };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: source });
  try { await service.syncCodexSessions(); } finally { await service.close(); }

  const unavailableSource: CodexSessionSource = {
    listSessions: async () => { throw new Error('重启后不应重新读取摘要'); },
    session: async () => { throw new Error('重启后不应重新读取对话源'); },
  };
  const recovered = await createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: unavailableSource });
  try {
    const detail = await recovered.codexSession(session.id);
    assert.equal(detail.turns[0].userMessage, '同步完整问题');
    assert.equal(detail.turns[0].agentMessage, '同步完整回答');
  } finally { await recovered.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Codex 会话源只同步未归档用户、CLI 和旧版会话，并按需读取最终回复', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-source-test-'));
  const state = path.join(codexHome, 'state_5.sqlite');
  const history = path.join(codexHome, 'thread_history_1.sqlite');
  const sessionId = '33333333-3333-3333-3333-333333333333';
  await exec('sqlite3', [state, `CREATE TABLE threads(id TEXT,title TEXT,preview TEXT,cwd TEXT,git_branch TEXT,git_sha TEXT,model TEXT,reasoning_effort TEXT,archived INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,source TEXT,thread_source TEXT);
    INSERT INTO threads VALUES('${sessionId}','会话标题','会话预览','/repo','feature/test','abc','gpt-5.6-sol','high',0,1789516800000,1789520400000,'vscode','user');
    INSERT INTO threads VALUES('44444444-4444-4444-4444-444444444444','内部任务','内部任务','/repo','','','gpt-5.6-sol','high',0,1789516800000,1789520500000,'{"subagent":{"other":"guardian"}}','subagent');
    INSERT INTO threads VALUES('55555555-5555-5555-5555-555555555555','审查任务','审查任务','/repo','','','gpt-5.6-sol','high',0,1789516800000,1789520600000,'vscode','guardian_review');
    INSERT INTO threads VALUES('66666666-6666-6666-6666-666666666666','归档会话','归档会话','/repo','','','gpt-5.6-sol','high',1,1789516800000,1789520700000,'vscode','user');`]);
  await exec('sqlite3', [history, `CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,started_at INTEGER,completed_at INTEGER,first_user_item_id TEXT,final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_json TEXT);
    INSERT INTO thread_turns VALUES('${sessionId}','turn-1',1,1789516800,1789516860,'user-1','agent-1');
    INSERT INTO thread_items VALUES('${sessionId}','user-1','{"type":"userMessage","content":[{"type":"text","text":"用户问题"}]}');
    INSERT INTO thread_items VALUES('${sessionId}','agent-1','{"type":"agentMessage","text":"最终回答"}');`]);
  try {
    const source = createCodexSessionSource(codexHome);
    assert.deepEqual((await source.listSessions()).map((session) => session.id), [sessionId]);
    const detail = await source.session(sessionId);
    assert.equal(detail.turns[0].userMessage, '用户问题');
    assert.equal(detail.turns[0].agentMessage, '最终回答');
  } finally { await fs.rm(codexHome, { recursive: true, force: true }); }
});

test('服务重启把未完成运行标为 interrupted，绝不自动重复派发', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-recovery-test-'));
  const stored = { id: 'run-1', provider: 'codex', mode: 'plan', objective: '旧任务', workspacePath: workspace.workspacePath,
    branch: workspace.branch, headSha: workspace.headSha, status: 'running', sessionId: 'codex-session-9999', pid: 999,
    result: '', error: '', events: [], createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' } as unknown as AgentRun;
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([stored]));
  let executions = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => { executions++; return ''; } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => workspace });
  try {
    const recovered = (await service.dashboard()).runs[0];
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.pid, null);
    assert.equal(recovered.model, '');
    assert.match(recovered.error, /未自动重复执行/);
    assert.equal(executions, 0);
    const resumed = await service.retry(recovered.id);
    await waitForSettledRun(service, resumed.id);
    assert.equal(resumed.parentRunId, recovered.id);
    assert.equal((await service.dashboard()).runs.find((run) => run.id === resumed.id)?.status, 'completed');
    assert.equal(executions, 1);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('浏览器仅打开本轮记录中的 HTML/SVG 文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-browser-file-test-'));
  const directory = path.join(root, 'data');
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspacePath, 'outputs'), { recursive: true });
  await fs.mkdir(directory);
  await fs.writeFile(path.join(workspacePath, 'outputs', 'demo.html'), '<html></html>');
  await fs.writeFile(path.join(workspacePath, 'outputs', 'drawing.SVG'), '<svg></svg>');
  await fs.writeFile(path.join(workspacePath, 'outputs', 'notes.txt'), 'text');
  const run = { id: 'run-browser', provider: 'codex', mode: 'agent', objective: '生成文件', workspacePath,
    branch: 'feature/test', headSha: 'abc123', status: 'completed', result: '', error: '', events: [],
    changedFiles: [
      { path: 'outputs/demo.html', status: 'generated' },
      { path: 'outputs/drawing.SVG', status: 'generated' },
      { path: 'outputs/notes.txt', status: 'generated' },
      { path: 'outputs/removed.html', status: 'deleted' },
    ], createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' } as unknown as AgentRun;
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([run]));
  const opened: string[] = [];
  const service = await createAgentRuntimeService(directory, { adapters: [], openBrowserFile: async filePath => { opened.push(filePath); } });
  try {
    assert.deepEqual(await service.openChangedFileInBrowser(run.id, 'outputs/demo.html'), { opened: true, path: 'outputs/demo.html' });
    assert.deepEqual(await service.openChangedFileInBrowser(run.id, 'outputs/drawing.SVG'), { opened: true, path: 'outputs/drawing.SVG' });
    await assert.rejects(service.openChangedFileInBrowser(run.id, 'outputs/notes.txt'), /仅支持在浏览器中打开 HTML 或 SVG 文件/);
    await assert.rejects(service.openChangedFileInBrowser(run.id, 'outputs/removed.html'), /已删除/);
    await assert.rejects(service.openChangedFileInBrowser(run.id, 'outputs/unknown.html'), /不属于本轮改动/);
    assert.deepEqual(opened, [
      await fs.realpath(path.join(workspacePath, 'outputs', 'demo.html')),
      await fs.realpath(path.join(workspacePath, 'outputs', 'drawing.SVG')),
    ]);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

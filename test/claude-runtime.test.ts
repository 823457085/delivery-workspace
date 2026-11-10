/** Local child-process checks only: no model request, browser login or account store. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeRunArguments, createClaudeAdapter, isAgentQuotaExhaustedError } from '../server/agent-runtime.js';
import { normalizeClaudeModels, requestClaudeModels } from '../server/claude-models.js';
import { claudeChildEnvironment } from '../server/cli-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const sample: AgentRun = { id: 'claude-test', provider: 'claude', mode: 'agent', accessMode: 'workspace', model: 'sonnet', reasoningEffort: '',
  objective: 'fixture-success', workspacePath: '', branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

async function fixture(t: TestContext, variant = 'claude-peer') {
  const directory = await fs.mkdtemp(path.resolve('.claude-runtime-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, `${variant}.mjs`);
  await fs.copyFile(path.resolve('test/fixtures/claude-runtime.mjs'), binary);
  await fs.chmod(binary, 0o700);
  return { directory, binary, marker: path.join(directory, 'claude-fixture-started.json'),
    context: { run: { ...sample, workspacePath: directory }, fileAttachments: [], imagePaths: [],
      signal: new AbortController().signal, onPid(_pid: number) {}, onSession(_sessionId: string) {}, onEvent(_type: string, _message: string) {} } };
}

function option(args: string[], name: string) { return args[args.indexOf(name) + 1]; }

test('Claude health requires both login and restricted noninteractive capabilities', async t => {
  for (const variant of ['claude-peer', 'workspace-only', 'logged-out', 'old-cli']) {
    const f = await fixture(t, variant);
    const health = await createClaudeAdapter(f.binary).health();
    assert.equal(health.ready, variant === 'claude-peer' || variant === 'workspace-only');
    assert.equal(health.authenticated, variant !== 'logged-out');
    assert.deepEqual(health.accessModes, variant === 'old-cli' || variant === 'workspace-only' ? ['workspace'] : ['workspace', 'full']);
    if (variant === 'logged-out') assert.match(health.message, /尚未登录/);
    if (variant === 'old-cli') assert.match(health.message, /更新/);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});

test('Claude arguments enforce read-only tools, sandbox boundaries and explicit resume', () => {
  const childEnv = claudeChildEnvironment({ CLAUDECODE: 'parent-session', PATH: '/bin', CLAUDE_CONFIG_DIR: '/config' });
  assert.equal(childEnv.CLAUDECODE, undefined);
  assert.equal(childEnv.PATH, '/bin');
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, '/config');
  assert.equal(childEnv.DISABLE_AUTOUPDATER, '1');
  for (const mode of ['ask', 'plan'] as const) {
    const args = claudeRunArguments('/workspace', mode);
    assert.equal(args.includes('--effort'), false);
    assert.equal(option(args, '--tools'), 'Read,Glob,Grep');
    assert.equal(option(args, '--permission-mode'), mode === 'plan' ? 'plan' : 'dontAsk');
    assert.equal(option(args, '--permission-prompts'), 'none');
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(option(args, '--mcp-config')), { mcpServers: {} });
  }
  const args = claudeRunArguments('/workspace', 'agent', 'opus', 'claude-original', 'workspace', ['/attachments'], ['/shared/git']);
  const settings = JSON.parse(option(args, '--settings'));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, []);
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, ['/attachments', '/shared/git']);
  assert.deepEqual(settings.permissions.deny, ['Edit(//attachments/**)', 'Edit(//shared/git/**)']);
  assert.equal(option(args, '--resume'), 'claude-original');
  assert.equal(option(args, '--model'), 'opus');
  assert.equal(option(args, '--permission-mode'), 'acceptEdits');
  assert.ok(!args.some(value => /bypassPermissions|dangerously-skip-permissions/.test(value)));
  for (const mode of ['ask', 'plan'] as const) assert.throws(() => claudeRunArguments('/workspace', mode, '', '', 'full'), /只有 Agent 模式可使用完全访问/);
});

test('Claude full Agent arguments bypass permissions without the workspace sandbox or deny rules', () => {
  const args = claudeRunArguments('/workspace', 'agent', 'opus', 'claude-original', 'full', ['/attachments'], ['/shared/git']);
  assert.equal(option(args, '--permission-mode'), 'bypassPermissions');
  assert.deepEqual(JSON.parse(option(args, '--settings')), { sandbox: { enabled: false } });
  assert.equal(args.includes('--restricted'), false);
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--mcp-config', '--tools', '--disable-slash-commands', '--no-chrome']) {
    assert.equal(args.includes(flag), false, `full access preserves native customizations instead of ${flag}`);
  }
  assert.equal(option(args, '--resume'), 'claude-original');
  assert.equal(option(args, '--model'), 'opus');
});

test('Claude uses SDK user input and resumed session, displaying only assistant text and final result', async t => {
  const f = await fixture(t);
  const messages: string[] = [], sessions: string[] = [];
  const result = await createClaudeAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'claude-original',
    run: { ...f.context.run, reasoningEffort: 'xhigh' },
    onSession(sessionId) { sessions.push(sessionId); }, onEvent(type, message) { if (type === 'message') messages.push(message); } });
  assert.equal(result, 'fixture-final');
  assert.deepEqual(sessions, ['claude-original']);
  assert.deepEqual(messages, ['fixture-progress', 'fixture-final']);
  const received = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.equal(option(received.args, '--resume'), 'claude-original');
  assert.equal(option(received.args, '--effort'), 'xhigh');
  assert.equal(received.messages[0].parent_tool_use_id, null);
  assert.match(received.messages[0].message.content[0].text, /fixture-success/);
  assert.ok(!messages.some(message => message.includes('fixture-private-thinking')));
});

test('Claude executes full Agent access through the local CLI protocol peer', async t => {
  const f = await fixture(t);
  const result = await createClaudeAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, accessMode: 'full' } });
  assert.equal(result, 'fixture-final');
  const received = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.equal(received.args.includes('--effort'), false);
  assert.equal(option(received.args, '--permission-mode'), 'bypassPermissions');
  assert.deepEqual(JSON.parse(option(received.args, '--settings')), { sandbox: { enabled: false } });
  assert.match(received.messages[0].message.content[0].text, /fixture-success/);
});

test('Claude rejects full access for Ask and Plan before starting a CLI', async t => {
  for (const mode of ['ask', 'plan'] as const) {
    const f = await fixture(t);
    await assert.rejects(createClaudeAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, mode, accessMode: 'full' } }), /只有 Agent 模式可使用完全访问/);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});

test('Claude recognizes quota errors from result.errors without exposing the raw diagnostic', async t => {
  const f = await fixture(t);
  await assert.rejects(createClaudeAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, objective: 'quota-errors' } }), (error: Error) => {
    assert.equal(isAgentQuotaExhaustedError(error.message), true);
    assert.doesNotMatch(error.message, /fixture-private-quota-detail/);
    return true;
  });
});

test('Claude rejects an absent native session ID and any changed resumed session ID', async t => {
  for (const objective of ['missing-session', 'session-mismatch']) {
    const f = await fixture(t);
    await assert.rejects(createClaudeAdapter(f.binary).execute({ ...f.context,
      ...(objective === 'session-mismatch' ? { resumeSessionId: 'claude-original' } : {}),
      run: { ...f.context.run, objective } }), /会话 ID/);
  }
});

test('Claude nonzero exit, error result, missing final and denied permissions all fail', async t => {
  for (const [objective, expected] of [
    ['exit-seven', /退出码 7/], ['error-result', /未成功完成/],
    ['missing-result', /未返回.*成功结束/], ['permission-denied', /工具权限被拒绝/],
  ] as const) {
    const f = await fixture(t);
    await assert.rejects(createClaudeAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective } }), expected);
  }
});

test('Claude never starts the CLI until PID persistence succeeds; a rejected save collects the gate', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let gatePid = 0, entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const settled = createClaudeAdapter(f.binary).execute({ ...f.context, signal: controller.signal,
    async onPid(pid) { gatePid = pid; entered(); await held; throw new Error('fixture-save-failed'); } }).catch(error => error as Error);
  try {
    await saving;
    await delay(75);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
    release();
    assert.match(String(await settled), /进程记录保存失败/);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
    assert.throws(() => process.kill(gatePid, 0), { code: 'ESRCH' });
  } finally { release(); controller.abort(); await settled; }
});

test('Claude Abort stops the live CLI and collects both CLI and gate PIDs', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let gatePid = 0, started!: () => void;
  const initialized = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  const settled = createClaudeAdapter(f.binary).execute({ ...f.context, signal: controller.signal,
    run: { ...f.context.run, objective: 'hold-open' }, onPid(pid) { gatePid = pid; }, onSession() { started(); } }).catch(error => error as Error);
  try {
    await initialized;
    const { pid } = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.ok(pid > 0 && gatePid > 0 && pid !== gatePid);
    controller.abort();
    assert.match(String(await settled), /运行已停止/);
    for (const stoppedPid of [gatePid, pid]) assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await settled; }
});

test('Claude model directory preserves CLI IDs and labels without exposing account data', async t => {
  const f = await fixture(t);
  const models = await requestClaudeModels(f.binary);
  assert.deepEqual(models, [
    { id: '', label: 'Claude Code 默认' }, { id: 'default', label: 'Default (recommended)' },
    { id: 'opus', label: 'Opus fixture-version', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'custom-model', label: 'L123456' },
  ]);
  for (const model of models) {
    const args = claudeRunArguments('/workspace', 'ask', model.id);
    if (model.id) assert.equal(option(args, '--model'), model.id);
    else assert.equal(args.includes('--model'), false);
  }
  assert.deepEqual(normalizeClaudeModels([null, {}, { value: '', displayName: 'Invalid' },
    { value: 'x', displayName: 'L0001' }, { value: 'x', displayName: 'L0001' }]),
  [{ id: '', label: 'Claude Code 默认' }, { id: 'x', label: 'L0001' }]);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('Claude effort choices follow catalog capabilities without inventing a default', () => {
  assert.deepEqual(normalizeClaudeModels([
    { value: 'limited', displayName: 'L0001', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max', 'ultra', 'max', null] },
    { value: 'unsupported', displayName: 'Unsupported', supportsEffort: false, supportedEffortLevels: ['high'] },
    { value: 'unknown', displayName: 'Unknown', supportedEffortLevels: ['high'] },
    { value: 'malformed', displayName: 'Malformed', supportsEffort: true, supportedEffortLevels: 'high' },
  ]), [
    { id: '', label: 'Claude Code 默认' },
    { id: 'limited', label: 'L0001', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'unsupported', label: 'Unsupported' },
    { id: 'unknown', label: 'Unknown' },
    { id: 'malformed', label: 'Malformed' },
  ]);
});

test('Claude model query handles failure, malformed catalogs, exit and timeout', async t => {
  for (const [variant, expected] of [
    ['catalog-error', /查询失败/], ['catalog-empty', /未返回可用模型/],
    ['catalog-exit', /提前结束/], ['catalog-timeout', /超时/],
  ] as const) {
    const f = await fixture(t, variant);
    await assert.rejects(requestClaudeModels(f.binary, variant === 'catalog-timeout' ? 500 : 8000), expected);
  }
  const f = await fixture(t, 'catalog-error');
  const health = await createClaudeAdapter(f.binary).health();
  assert.equal(health.ready, true);
  assert.deepEqual(health.models, [{ id: '', label: 'Claude Code 默认' }]);
  assert.match(health.message, /模型同步失败/);
});

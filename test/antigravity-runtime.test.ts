import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createAntigravityAdapter, antigravityModels, antigravitySettings, antigravityRunArguments,
  antigravityWorktreeReadDirectories } from '../server/antigravity-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';
const sample: AgentRun = { id: 'antigravity-test', provider: 'antigravity', mode: 'ask', accessMode: 'workspace', model: 'test-medium', reasoningEffort: '',
  objective: 'success', workspacePath: '', branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };
async function fixture(t: TestContext, variant = 'antigravity-peer') {
  const directory = await fs.mkdtemp(path.resolve('.antigravity-runtime-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, `${variant}.mjs`);
  await fs.copyFile(path.resolve('test/fixtures/antigravity-runtime.mjs'), binary); await fs.chmod(binary, 0o700);
  return { directory, binary, marker: path.join(directory, 'antigravity-fixture-started.json'), context: {
    run: { ...sample, workspacePath: directory }, fileAttachments: [], imagePaths: [], attachmentDirectory: path.join(directory, 'private'),
    signal: new AbortController().signal, onPid(_pid: number) {}, onSession(_id: string) {}, onEvent(_type: string, _message: string) {} } };
}
test('Antigravity health uses zero-model headless status and real model catalog without exposing account data', async t => {
  for (const variant of ['antigravity-peer', 'stderr-help', 'logged-out', 'old-cli']) {
    const f = await fixture(t, variant); const health = await createAntigravityAdapter(f.binary).health();
    assert.equal(health.ready, ['antigravity-peer', 'stderr-help'].includes(variant)); assert.equal(health.authenticated, variant !== 'logged-out');
    assert.equal(JSON.stringify(health).includes('private@example.invalid'), false);
    assert.deepEqual(health.models, [{ id: 'test-medium', label: 'L_MODEL' }, { id: 'test-high', label: 'Test High' }]);
    if (health.authenticated) assert.equal(health.defaultModel, 'test-medium');
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});
test('Antigravity health distinguishes an explicit login failure from network or indeterminate model status', async t => {
  for (const [variant, expected] of [['logged-out', /登录不可用/], ['auth-health-network', /网络/],
    ['auth-health-unknown', /无法确认/], ['auth-health-bad-json', /无法确认/]] as const) {
    const f = await fixture(t, variant); const health = await createAntigravityAdapter(f.binary).health();
    assert.equal(health.ready, false, variant); assert.equal(health.authenticated, false, variant);
    assert.match(health.message, expected, variant);
    if (variant !== 'logged-out') assert.doesNotMatch(health.message, /登录不可用|认证凭证失效/, variant);
    assert.equal(JSON.stringify(health).includes('private@example.invalid'), false);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});
test('Antigravity parses tab catalog, retains labels and rejects invented fallback', () => {
  assert.deepEqual(antigravityModels('Fetching available models...\na\tL12\na\tDuplicate\nbad text\n'), [{ id: 'a', label: 'L12' }]);
  assert.throws(() => antigravityModels(''), /模型/);
});
test('Antigravity per-run permissions isolate workspace commands and preserve readonly/full access', () => {
  for (const mode of ['ask', 'plan'] as const) {
    const settings = antigravitySettings({ mode, accessMode: 'workspace' });
    for (const permission of ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)']) assert.ok(settings.permissions.deny.includes(permission));
    assert.equal(settings.allowNonWorkspaceAccess, false); assert.equal(settings.useG1Credits, false);
    assert.equal(settings.toolPermission, 'request-review'); assert.equal(settings.enableTerminalSandbox, false);
  }
  const workspace = antigravitySettings({ mode: 'agent', accessMode: 'workspace' }, ['/private/attachments']);
  assert.equal(workspace.permissions.deny.includes('write_file(*)'), false); assert.equal(workspace.permissions.deny.includes('command(*)'), false);
  assert.equal(workspace.toolPermission, 'proceed-in-sandbox'); assert.equal(workspace.enableTerminalSandbox, true);
  assert.equal(workspace.allowNonWorkspaceAccess, false);
  assert.ok(workspace.permissions.deny.includes('mcp(*)')); assert.ok(workspace.permissions.deny.includes('execute_url(*)'));
  assert.deepEqual(workspace.permissions.allow, ['read_file(/private/attachments)'], 'No command allow rule may grant execution outside the sandbox');
  assert.deepEqual(workspace.permissions.ask, []);
  assert.ok(workspace.permissions.deny.includes('write_file(/private/attachments)'));
  const full = antigravitySettings({ mode: 'agent', accessMode: 'full' });
  assert.equal(full.toolPermission, 'always-proceed'); assert.equal(full.allowNonWorkspaceAccess, true); assert.equal(full.useG1Credits, false);
  assert.equal(full.enableTerminalSandbox, false); assert.deepEqual(full.permissions.deny, []);
  assert.equal(full.disableSlashCommands, false);
  assert.equal(antigravityRunArguments({ ...sample, mode: 'agent', accessMode: 'full' }).includes('--disable-slash-commands'), false);
  const args = antigravityRunArguments(sample, 'original-session'); assert.equal(args.at(-1), 'original-session');
  assert.equal(args.includes('--continue'), false); assert.equal(args.includes('--effort'), false);
});
test('Antigravity workspace execution accepts sandbox initialization and retains native command tools', async t => {
  const f = await fixture(t);
  assert.equal(await createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, mode: 'agent', accessMode: 'workspace' },
  }), '你好 Antigravity');
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.equal(invocation.settings.toolPermission, 'proceed-in-sandbox');
  assert.equal(invocation.settings.enableTerminalSandbox, true);
  assert.equal(invocation.settings.allowNonWorkspaceAccess, false);
  assert.match(invocation.profile, /^  - run_command$/m);
  assert.match(invocation.profile, /^commandExecutionPolicy: sandbox$/m);
  assert.match(invocation.content, /在终端沙箱内运行检查、测试和构建命令/);
  assert.match(invocation.content, /必须显式 cd 到上述工作台执行目录；附件目录不是主工作区/);
  assert.doesNotMatch(invocation.content, /终端命令不可用/);
  assert.ok(invocation.settings.permissions.deny.includes(`write_file(${invocation.directory})`));
});
test('Antigravity workspace rejects a permission mode mismatch or denied command without retrying', async t => {
  for (const [objective, expected] of [['wrong-permission', /权限模式/], ['tool-command-permission', /权限被拒绝/]] as const) {
    const f = await fixture(t);
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, objective, mode: 'agent', accessMode: 'workspace' },
    }), expected);
    assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1);
    assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 0);
  }
});
test('Antigravity grants only verified linked-worktree Git metadata read access', async t => {
  const f = await fixture(t), git = promisify(execFile);
  const source = path.join(f.directory, 'source repo'), workspace = path.join(f.directory, 'linked worktree');
  await git('git', ['init', '--initial-branch=feature/fixture', source]);
  await git('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', '测试工作树']);
  await git('git', ['-C', source, 'worktree', 'add', '--detach', workspace]);
  const common = await fs.realpath(path.join(source, '.git'));
  assert.deepEqual(await antigravityWorktreeReadDirectories(source), []);
  assert.deepEqual(await antigravityWorktreeReadDirectories(f.directory), []);
  assert.deepEqual(await antigravityWorktreeReadDirectories(workspace), [common]);
  assert.equal(await createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, workspacePath: workspace, mode: 'agent', accessMode: 'workspace' },
  }), '你好 Antigravity');
  const invocation = JSON.parse(await fs.readFile(path.join(workspace, 'antigravity-fixture-started.json'), 'utf8'));
  assert.ok(invocation.settings.permissions.allow.includes(`read_file(${common})`));
  assert.ok(invocation.settings.permissions.deny.includes(`write_file(${common})`));
  assert.equal(invocation.settings.permissions.allow.includes(`read_file(${source})`), false);
  assert.equal(invocation.args.includes(source), false);
  assert.equal(invocation.args.includes(common), false, 'Git metadata must not become an added workspace or command cwd');
  const marker = path.join(workspace, '.git'), original = await fs.readFile(marker, 'utf8');
  const gitDirectory = original.trim().slice('gitdir: '.length);
  const backlink = path.join(gitDirectory, 'gitdir'), originalBacklink = await fs.readFile(backlink, 'utf8');
  await fs.writeFile(backlink, path.join(source, '.git'));
  await assert.rejects(antigravityWorktreeReadDirectories(workspace), /Git 元数据校验失败/);
  await fs.writeFile(backlink, originalBacklink);
  await fs.writeFile(marker, `gitdir: ${path.relative(workspace, gitDirectory)}\n`);
  assert.deepEqual(await antigravityWorktreeReadDirectories(workspace), [common], 'Relative Git pointers remain supported');
  await fs.writeFile(path.join(gitDirectory, 'commondir'), '../../..\n');
  await assert.rejects(antigravityWorktreeReadDirectories(workspace), /Git 元数据校验失败/);
});
test('Antigravity refuses symlinked or malformed Git markers before launching', async t => {
  for (const variant of ['symlink', 'malformed', 'oversized'] as const) {
    const f = await fixture(t), marker = path.join(f.directory, '.git');
    if (variant === 'symlink') {
      const target = path.join(f.directory, 'pointer'); await fs.writeFile(target, 'gitdir: /outside\n'); await fs.symlink(target, marker);
    } else await fs.writeFile(marker, variant === 'oversized' ? 'gitdir: ' + 'x'.repeat(5000) : 'gitdir: /outside\nextra target\n');
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, mode: 'agent', accessMode: 'workspace' },
    }), /Git 元数据校验失败/);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});
test('Antigravity supports a linked worktree whose common metadata is a bare repository', async t => {
  const f = await fixture(t), git = promisify(execFile);
  const source = path.join(f.directory, 'source'), bare = path.join(f.directory, 'repository.git');
  const workspace = path.join(f.directory, 'bare worktree');
  await git('git', ['init', '--initial-branch=feature/fixture', source]);
  await git('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', '测试工作树']);
  await git('git', ['clone', '--bare', source, bare]);
  await git('git', ['-C', bare, 'worktree', 'add', '--detach', workspace]);
  const common = await fs.realpath(bare);
  assert.deepEqual(await antigravityWorktreeReadDirectories(workspace), [common]);
  assert.equal(await createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, workspacePath: workspace, mode: 'agent', accessMode: 'workspace' },
  }), '你好 Antigravity');
  const invocation = JSON.parse(await fs.readFile(path.join(workspace, 'antigravity-fixture-started.json'), 'utf8'));
  assert.ok(invocation.settings.permissions.allow.includes(`read_file(${common})`));
  assert.ok(invocation.settings.permissions.deny.includes(`write_file(${common})`));
  assert.equal(invocation.args.includes(common), false);
});
test('Antigravity read-only group role is launched without command or file editing tools', async t => {
  const f = await fixture(t);
  const team: NonNullable<AgentRun['team']> = { taskId: 'group', nodeId: 'analyst', stageKey: 'group:analyst',
    profileId: 'analyst', profileRevision: 1, interactionMode: 'group' };
  await createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, team } });
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.match(invocation.profile, /^  - (?:view_file|grep_search)$/m);
  assert.doesNotMatch(invocation.profile, /^  - (?:run_command|command_status|write_to_file)$/m);
  assert.ok(invocation.settings.permissions.deny.includes('command(*)'));
  assert.ok(invocation.settings.permissions.deny.includes('write_file(*)'));
  assert.match(invocation.content, /隔离 Agent 配置目录由 CLI 使用，请勿浏览或读取/);
  assert.match(invocation.content, /本轮为只读模式，请使用原生文件读取、目录浏览和搜索工具/);
});
test('Antigravity gates PID, confirms one native session, streams deltas, accepts final line and ignores cumulative usage', async t => {
  const f = await fixture(t); const sessions: string[] = [], output: string[] = [], events: string[] = [], usage: unknown[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const running = createAntigravityAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'original-session', onPid: () => gate,
    onSession: id => { sessions.push(id); }, onOutput: text => { output.push(text); }, onUsage: event => { usage.push(event); },
    onEvent: (_type, message) => { events.push(message); } });
  await delay(100); await assert.rejects(fs.access(f.marker), { code: 'ENOENT' }); release();
  assert.equal(await running, '你好 Antigravity'); assert.deepEqual(sessions, ['original-session']);
  assert.deepEqual(output, ['你好', '你好 Antigravity']); assert.deepEqual(events, ['你好 Antigravity']); assert.deepEqual(usage, []);
});
test('Antigravity rejects missing/duplicate completion, session mismatch, errors and permission soft-denials despite exit zero', async t => {
  for (const [objective, expected] of [['missing-finish', /成功结束/], ['duplicate-final', /事件顺序/], ['mismatch', /会话 ID/],
    ['tool-permission', /权限被拒绝/], ['stderr-permission', /权限被拒绝/], ['non-success', /未成功/], ['empty-final', /最终回复/],
    ['wrong-permission', /权限模式/], ['wrong-agent', /隔离 Agent/], ['error-before-init', /认证凭证失效/]] as const) {
    const f = await fixture(t); await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective } }), expected);
  }
});
test('Antigravity permission denials identify only the observed tool target, preserve boundaries and never retry', async t => {
  for (const [objective, target] of [
    ['tool-read-permission', '/outside/repository/.git/worktrees/workspace4/HEAD'],
    ['tool-history-skill-permission', '/outside/old-verification/.agents/skills/vue-best-practices/SKILL.md'],
    ['tool-command-permission', 'curl [参数已隐藏]'],
    ['tool-long-read-permission', '…'],
  ] as const) await t.test(objective, async child => {
    const f = await fixture(child), events: string[] = [], output: string[] = [];
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, objective }, onEvent: (_type, message) => { events.push(message); }, onOutput: text => { output.push(text); },
    }), (error: Error) => {
      assert.match(error.message, /工具权限被拒绝/);
      assert.ok(error.message.includes(target), error.message);
      assert.match(error.message, objective === 'tool-command-permission' ? /执行命令/ : /读取文件/);
      assert.ok(error.message.length < 450, '目标保持有界，不把原始诊断附加到错误');
      assert.doesNotMatch(JSON.stringify({ error: error.message, events, output }), /PRIVATE_|Authorization|Bearer/);
      return true;
    });
    assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1);
    assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 0);
    assert.deepEqual(output, [], '同一批输出中的成功终态不能覆盖权限拒绝');
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.equal(invocation.settings.allowNonWorkspaceAccess, false);
    assert.equal(invocation.settings.toolPermission, 'request-review');
    for (const permission of ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)'])
      assert.ok(invocation.settings.permissions.deny.includes(permission));
  });
});
test('Antigravity permission diagnostics without tool context do not invent a path or operation', async t => {
  const f = await fixture(t);
  await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, objective: 'stderr-permission' },
  }), (error: Error) => {
    assert.match(error.message, /工具权限被拒绝/);
    assert.doesNotMatch(error.message, /读取文件|执行命令|\.git|headless/);
    return true;
  });
});
test('Antigravity cancellation kills recorded process and PID-save failure never releases execution', async t => {
  const f = await fixture(t); const controller = new AbortController(); let pid = 0;
  const running = createAntigravityAdapter(f.binary).execute({ ...f.context, signal: controller.signal,
    run: { ...f.context.run, objective: 'hang' }, onPid: value => { pid = value; } });
  const settled = running.catch(() => {}); t.after(async () => { controller.abort(); await settled; });
  for (let attempt = 0; attempt < 100; attempt++) { try { await fs.access(f.marker); break; } catch { await delay(20); } }
  controller.abort(); await assert.rejects(running, /运行已停止/); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const f2 = await fixture(t); await assert.rejects(createAntigravityAdapter(f2.binary).execute({ ...f2.context, onPid: () => { throw new Error('save failed'); } }), /记录保存失败/);
  await assert.rejects(fs.access(f2.marker), { code: 'ENOENT' });
});
test('Antigravity stages multiple native images and files privately, preserves sources, and grants readonly historical directories', async t => {
  const f = await fixture(t); const images = [path.join(f.directory, 'first.png'), path.join(f.directory, 'second.png')];
  await Promise.all(images.map(file => fs.writeFile(file, 'image fixture')));
  const file = path.join(f.directory, 'spec.md'); await fs.writeFile(file, 'spec');
  const adapter = createAntigravityAdapter(f.binary);
  await adapter.execute({ ...f.context, imagePaths: images, fileAttachments: [{ path: file, name: 'quoted "spec"' }] });
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.match(invocation.content, /view_file.*逐张读取实际图片/); assert.match(invocation.content, /quoted \\"spec\\"/);
  const entries = await fs.readdir(f.context.attachmentDirectory); assert.equal(entries.length, 1);
  const attempt = path.join(f.context.attachmentDirectory, entries[0]!);
  assert.equal((await fs.stat(attempt)).mode & 0o777, 0o700);
  const names = await fs.readdir(attempt); assert.equal(names.length, 3);
  for (const name of names) assert.equal((await fs.stat(path.join(attempt, name))).mode & 0o777, 0o600);
  assert.ok(invocation.settings.permissions.deny.includes(`write_file(${attempt})`)); assert.ok(invocation.args.includes(attempt));
  assert.equal(await fs.readFile(file, 'utf8'), 'spec');
  await adapter.execute({ ...f.context, attachmentReadDirectories: [attempt], resumeSessionId: 'original-session' });
  const resumed = JSON.parse(await fs.readFile(f.marker, 'utf8')); assert.ok(resumed.args.includes(attempt));
  await adapter.execute({ ...f.context, imagePaths: [images[0]!] });
  assert.equal((await fs.readdir(f.context.attachmentDirectory)).length, 2);
});
test('Antigravity isolates restricted invocations and keeps native capabilities for persistent full access', async t => {
  const f = await fixture(t); const adapter = createAntigravityAdapter(f.binary);
  const names: string[] = [];
  for (const accessMode of ['workspace', 'workspace'] as const) {
    assert.equal(await adapter.execute({ ...f.context, run: { ...f.context.run, mode: 'agent', accessMode } }), '你好 Antigravity');
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.match(invocation.profile, /inheritMcp: false/); assert.match(invocation.profile, /inheritCustomizations: false/);
    const name = invocation.args[invocation.args.indexOf('--agent') + 1]; assert.ok(!names.includes(name)); names.push(name);
    assert.ok(invocation.settings.permissions.deny.includes(`write_file(${invocation.directory})`));
    await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await adapter.execute({ ...f.context, resumeSessionId: 'native-full-session', run: { ...f.context.run, mode: 'agent', accessMode: 'full' } }), '你好 Antigravity');
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.equal(invocation.args.includes('--agent'), false);
    assert.equal(invocation.args.includes('--disable-slash-commands'), false);
    assert.equal(invocation.profile, null); assert.equal(invocation.directory, null);
  }
});
test('Antigravity allows large image tool events without exposing binary output but bounds event and response size', async t => {
  const f = await fixture(t); const events: string[] = [];
  assert.equal(await createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective: 'large-image-event' },
    onEvent: (_type, message) => { events.push(message); } }), '你好 Antigravity');
  assert.deepEqual(events, ['读取文件', '你好 Antigravity']);
  for (const objective of ['oversized-event', 'oversized-text', 'oversized-final']) {
    const next = await fixture(t); await assert.rejects(createAntigravityAdapter(next.binary).execute({ ...next.context, run: { ...next.context.run, objective } }), /大小限制/);
  }
});

test('Antigravity rejects symlinked attachment ancestors without creating files in the target', async t => {
  const f = await fixture(t); const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  const link = path.join(f.directory, 'link'); await fs.symlink(outside, link);
  const source = path.join(f.directory, 'picture.png'); await fs.writeFile(source, 'image');
  await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, imagePaths: [source], attachmentDirectory: path.join(link, 'run') }), /父目录/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('Antigravity concurrent runs safely create their shared attachment parent', async t => {
  const f = await fixture(t); const source = path.join(f.directory, 'picture.png'); await fs.writeFile(source, 'image');
  const adapter = createAntigravityAdapter(f.binary);
  const results = await Promise.all(['first', 'second'].map(name => adapter.execute({ ...f.context, imagePaths: [source],
    attachmentDirectory: path.join(f.directory, 'new-shared-parent', name) })));
  assert.deepEqual(results, ['你好 Antigravity', '你好 Antigravity']);
  for (const name of ['first', 'second']) assert.equal((await fs.readdir(path.join(f.directory, 'new-shared-parent', name))).length, 1);
});

test('Antigravity identifies the primary workspace separately from an external readonly attachment directory', async t => {
  const f = await fixture(t); const external = await fixture(t);
  const source = path.join(f.directory, 'image.png'); await fs.writeFile(source, 'image');
  await createAntigravityAdapter(f.binary).execute({ ...f.context, imagePaths: [source],
    attachmentDirectory: path.join(external.directory, 'private'), run: { ...f.context.run, mode: 'agent', objective: '在当前工作区新建 result.txt' } });
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.ok(invocation.content.includes(`工作台执行目录：${JSON.stringify(await fs.realpath(f.directory))}`));
  assert.match(invocation.content, /“当前工作区”和相对文件路径均以此目录为基准/);
  assert.match(invocation.content, /用户明确指定其他绝对路径时，仍按本轮访问权限处理/);
  assert.match(invocation.content, /附件目录仅供读取。隔离 Agent 配置目录由 CLI 使用，请勿浏览或读取/);
  const staged = invocation.args.filter((_: string, index: number) => invocation.args[index - 1] === '--add-dir')
    .find((directory: string) => directory.startsWith(external.directory));
  assert.ok(staged); assert.ok(invocation.settings.permissions.deny.includes(`write_file(${staged})`));
});

test('Antigravity gives team writers a workspace output directory while shared artifacts remain read-only', async t => {
  const f = await fixture(t), material = await fixture(t);
  const team: NonNullable<AgentRun['team']> = { taskId: 'task', nodeId: 'engineer', stageKey: 'task:engineer:2',
    profileId: 'engineer', profileRevision: 1, interactionMode: 'chat', artifactDirectories: [material.directory] };
  await createAntigravityAdapter(f.binary).execute({ ...f.context, attachmentReadDirectories: [material.directory],
    run: { ...f.context.run, team, mode: 'agent', accessMode: 'full' } });
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.ok(invocation.content.includes(JSON.stringify(path.join(await fs.realpath(f.directory), '.delivery-artifacts'))));
  assert.match(invocation.content, /复用历史脚本时，先读取后在此目录创建工作副本/);
  assert.ok(invocation.settings.permissions.deny.includes(`write_file(${await fs.realpath(material.directory)})`));
  assert.equal(invocation.settings.toolPermission, 'always-proceed');
});

test('Antigravity publishes public responses promptly and once, preserves live text, and shows actual tool transitions', async t => {
  const f = await fixture(t); const events: { type: string; message: string }[] = [], output: string[] = [];
  let visibleResult = '';
  const result = await createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective: 'rich-progress' },
    onEvent: (type, message) => { events.push({ type, message }); if (type === 'message') visibleResult = message; },
    onOutput: text => { output.push(text); visibleResult = text; } });
  assert.equal(result, '准备检查\n检查完成\n');
  assert.deepEqual(events, [
    { type: 'message', message: '准备检查\n' },
    { type: 'tool', message: '开始：执行命令：npm test -- --runInBand' },
    { type: 'tool', message: '调用完成：执行命令：npm test -- --runInBand' },
    { type: 'message', message: '检查完成\n' },
  ]);
  assert.equal(output.at(-1), result);
  assert.equal(visibleResult, result);
  assert.ok(!JSON.stringify({ events, output, result }).includes('PRIVATE_'));
});

test('Antigravity tool errors show failure without publishing raw diagnostics', async t => {
  const f = await fixture(t); const events: string[] = [];
  await createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective: 'tool-error' }, onEvent: (_type, message) => { events.push(message); } });
  assert.ok(events.includes('开始：读取文件：/work/missing.ts'));
  assert.ok(events.includes('执行失败：读取文件：/work/missing.ts'));
  assert.ok(!events.join().includes('PRIVATE_DIAGNOSTIC'));
});


test('Antigravity only classifies explicit authentication failures; paths and startup logs cannot relabel process exits', async t => {
  for (const objective of ['author-file-failure', 'authorization-file-failure', 'credential-path-failure', 'exit-auth-noise', 'success-exit-auth-noise']) {
    const f = await fixture(t); const output: string[] = [];
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective },
      onOutput: text => { output.push(text); } }), (error: Error) => {
      assert.doesNotMatch(error.message, /登录不可用/);
      if (objective.includes('exit-auth-noise')) assert.match(error.message, /退出码 2/);
      if (objective === 'success-exit-auth-noise') assert.match(error.message, /已返回最终回复/);
      return true;
    });
    if (objective === 'success-exit-auth-noise') assert.equal(output.at(-1), '已完成回复');
  }
  for (const [objective, expected] of [['auth-failure-code', /认证凭证失效/], ['network-failure', /网络连接异常/]] as const) {
    const f = await fixture(t);
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective } }), expected);
  }
});

test('Antigravity distinguishes rate limits, uncertain resource limits and unrelated credit/quota words from exhausted quota', async t => {
  for (const [objective, expected] of [
    ['quota-rate-limit', /请求被限流/], ['quota-resource-exhausted', /未确认额度耗尽/],
    ['quota-number-only', /请求被限流/], ['quota-rate-with-quota-code', /请求被限流/],
    ['quota-exceeded-code-only', /未确认额度耗尽/],
    ['quota-unknown', /未确认额度耗尽/], ['quota-credit-file', /未成功/],
    ['quota-network', /网络连接异常/], ['quota-permission', /权限被拒绝/],
  ] as const) {
    const f = await fixture(t);
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, objective } }), (error: Error) => {
      assert.match(error.message, expected, objective);
      assert.doesNotMatch(error.message, /额度已用尽/, objective);
      return true;
    });
  }
});

test('Antigravity reports explicit allowance exhaustion and AI credit balance separately for the selected model', async t => {
  for (const objective of ['quota-exhausted', 'quota-credit-balance']) {
    const f = await fixture(t);
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context, run: { ...f.context.run, model: 'gemini-fixture', objective } }), (error: Error) => {
      assert.match(error.message, /CLI.*gemini-fixture.*报告/);
      if (objective === 'quota-credit-balance') {
        assert.match(error.message, /AI credits 余额不足/);
        assert.doesNotMatch(error.message, /额度已用尽/);
      } else assert.match(error.message, /额度已用尽/);
      return true;
    });
  }
});

const fixtureRecords = async (directory: string, name: string): Promise<{ args: string[]; content: string; settings: ReturnType<typeof antigravitySettings> }[]> => fs.readFile(path.join(directory, name), 'utf8')
  .then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []);

test('Antigravity renews an expired invocation once and resumes its native session without replaying the objective', async t => {
  for (const objective of ['auth-recovery-once', 'auth-recovery-code401', 'auth-recovery-stderr', 'auth-recovery-empty-id', 'auth-recovery-missing-id']) {
    const f = await fixture(t); const sessions: string[] = [], pids: number[] = [], events: { type: string; message: string }[] = [];
    const file = path.join(f.directory, 'existing-result.md'); await fs.writeFile(file, 'existing work');
    const result = await createAntigravityAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'original-session',
      run: { ...f.context.run, objective, model: 'test-high', mode: 'agent', accessMode: 'full' },
      fileAttachments: [{ path: file, name: 'existing-result.md' }],
      onPid: pid => { pids.push(pid); }, onSession: id => { sessions.push(id); }, onEvent: (type, message) => { events.push({ type, message }); } });
    assert.equal(result, '你好 Antigravity'); assert.deepEqual(sessions, ['original-session', 'original-session']);
    assert.equal(pids.length, 2); assert.notEqual(pids[0], pids[1]);
    const invocations = await fixtureRecords(f.directory, 'auth-invocations.jsonl'); assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[0]!.args, invocations[1]!.args); assert.deepEqual(invocations[0]!.settings, invocations[1]!.settings);
    assert.match(invocations[0]!.content, new RegExp(objective)); assert.ok(!invocations[1]!.content.includes(objective));
    assert.match(invocations[1]!.content, /继续/); assert.match(invocations[1]!.content, /不要重复/);
    assert.equal(await fs.readFile(file, 'utf8'), 'existing work');
    const probes = await fixtureRecords(f.directory, 'auth-probes.jsonl'); assert.equal(probes.length, 1);
    assert.equal(probes[0]!.args[probes[0]!.args.indexOf('-p') + 1], '/model');
    assert.equal(JSON.parse(probes[0]!.args[probes[0]!.args.indexOf('--settings') + 1]).useG1Credits, false);
    assert.ok(events.some(event => event.type === 'diagnostic' && /认证凭证失效/.test(event.message)));
    assert.ok(events.some(event => event.type === 'lifecycle' && /续接/.test(event.message)));
  }
});

test('Antigravity holds the recovery process until its replacement PID is durably recorded', async t => {
  const f = await fixture(t); let pidCount = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, objective: 'auth-recovery-once' },
    onPid: () => { pidCount++; return pidCount === 2 ? gate : undefined; } });
  const settled = running.catch(() => {}); t.after(async () => { release(); await settled; });
  for (let attempt = 0; attempt < 100 && pidCount < 2; attempt++) await delay(20);
  assert.equal(pidCount, 2);
  assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1);
  release(); assert.equal(await running, '你好 Antigravity');
  const failed = await fixture(t); let recorded = 0;
  await assert.rejects(createAntigravityAdapter(failed.binary).execute({ ...failed.context,
    run: { ...failed.context.run, objective: 'auth-recovery-once' },
    onPid: () => { if (++recorded === 2) throw new Error('replacement PID persistence failed'); } }), /记录保存失败/);
  assert.equal(recorded, 2);
  assert.equal((await fixtureRecords(failed.directory, 'auth-invocations.jsonl')).length, 1);
});

test('Antigravity stops after the second authentication failure and never starts a third model invocation', async t => {
  const f = await fixture(t);
  await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
    run: { ...f.context.run, objective: 'auth-recovery-repeat' } }), /认证凭证失效/);
  assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 2);
  assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 1);
});

test('Antigravity does not resume when a fresh authentication probe fails or does not prove a zero-turn model command', async t => {
  for (const variant of ['auth-probe-failed', 'auth-probe-missing-turns', 'auth-probe-used-turns', 'auth-probe-wrong-command', 'auth-probe-error-status']) {
    const f = await fixture(t, variant);
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, objective: 'auth-recovery-once' } }), /认证凭证失效/);
    assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1, variant);
    assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 1, variant);
  }
});

test('Antigravity cancellation during credential probing aborts recovery without starting another invocation', async t => {
  const f = await fixture(t, 'auth-probe-hang'); const controller = new AbortController();
  const running = createAntigravityAdapter(f.binary).execute({ ...f.context, signal: controller.signal,
    run: { ...f.context.run, objective: 'auth-recovery-once' } });
  const settled = running.catch(() => {}); t.after(async () => { controller.abort(); await settled; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length) break;
    await delay(20);
  }
  assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 1);
  controller.abort(); await assert.rejects(running, /运行已停止/);
  assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1);
});

test('Antigravity preserves final responses and does not replay errors without a confirmed session or with a response', async t => {
  for (const [objective, expected] of [['error-before-init', /认证凭证失效/], ['auth-recovery-response', /认证凭证失效/],
    ['success-exit-auth-noise', /已返回最终回复.*退出码 2/], ['auth-recovery-different-id', /会话 ID/],
    ['success-then-empty-auth', /会话 ID|事件顺序/], ['success-then-missing-auth', /会话 ID|事件顺序/]] as const) {
    const f = await fixture(t); const output: string[] = [];
    await assert.rejects(createAntigravityAdapter(f.binary).execute({ ...f.context,
      run: { ...f.context.run, objective }, onOutput: text => { output.push(text); },
      onEvent: (type, message) => { if (type === 'message') output.push(message); } }), expected);
    assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1);
    assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 0);
    if (objective.startsWith('success-')) assert.equal(output.at(-1), '已完成回复');
  }
});

function protobufField(field: number, content: Buffer) {
  const varint = (value: number) => {
    const bytes: number[] = [];
    do { bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
  };
  return Buffer.concat([varint(field * 8 + 2), varint(content.length), content]);
}
async function historyFixture(t: TestContext, options: { missing?: boolean; invalidIndices?: boolean; noError?: boolean; twoErrors?: boolean;
  session?: string; historyGap?: boolean; sqlite?: 'quota' | 'auth' | 'raw' | 'wrong-session' } = {}) {
  const f = await fixture(t);
  const session = options.session || 'history-native-session';
  const nativeRoot = path.join(f.directory, 'native');
  const transcript = path.join(nativeRoot, session, '.system_generated', 'logs', 'transcript_full.jsonl');
  const rows: Record<string, unknown>[] = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'earlier request' },
    { step_index: 1, type: options.noError ? 'SYSTEM_MESSAGE' : 'ERROR_MESSAGE', status: 'DONE', error: 'historical transport error' },
    ...(options.twoErrors ? [{ step_index: 2, type: 'ERROR_MESSAGE', status: 'DONE', error: 'the last historical error' }] : []),
    { step_index: options.twoErrors ? 3 : 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'earlier response' },
  ];
  if (options.historyGap) rows.at(-1)!.step_index = 3;
  if (options.sqlite) rows.splice(1, 1);
  if (options.invalidIndices) rows[1]!.step_index = 99;
  const database = path.join(f.directory, 'conversations', `${session}.db`);
  if (options.sqlite) {
    await fs.mkdir(path.dirname(database), { recursive: true });
    const oldError = options.sqlite === 'auth' ? 'UNAUTHENTICATED: historical authentication failed'
      : 'Individual quota reached. Try again in 149h6m8s.';
    const rawError = options.sqlite === 'raw' ? 'UNAUTHENTICATED (code 401): historical credential error' : oldError;
    const payload = protobufField(24, protobufField(3, Buffer.concat([
      protobufField(1, Buffer.from(oldError)), protobufField(2, Buffer.from(rawError)),
      protobufField(3, Buffer.from('PRIVATE_HEADERS_MUST_NOT_BE_PUBLISHED')),
    ])));
    const db = new DatabaseSync(database);
    try {
      db.exec('CREATE TABLE trajectory_meta(trajectory_id TEXT, cascade_id TEXT); CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);');
      db.prepare('INSERT INTO trajectory_meta VALUES(?, ?)').run('11111111-1111-4111-8111-111111111111', options.sqlite === 'wrong-session' ? 'different-native-session' : session);
      const insert = db.prepare('INSERT INTO steps VALUES(?, ?, ?, ?, ?)');
      insert.run(0, 14, 3, null, Buffer.from('earlier request'));
      insert.run(1, 17, 3, null, payload);
      insert.run(2, 15, 3, null, Buffer.from('earlier response'));
    } finally { db.close(); }
    await fs.chmod(database, 0o600);
    await fs.writeFile(path.join(f.directory, 'history-fixture.json'), JSON.stringify({ error: options.sqlite === 'raw' ? rawError : oldError }));
  }
  const baseline = rows.map(row => JSON.stringify(row) + '\n').join('');
  if (!options.missing) {
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, baseline);
  }
  const adapter = createAntigravityAdapter(f.binary, undefined, nativeRoot);
  return { ...f, session, transcript, baseline, database, adapter,
    execute: (objective: string) => adapter.execute({ ...f.context, resumeSessionId: session, run: { ...f.context.run, objective } }),
  };
}

test('Antigravity recovers only a completed resumed turn whose ERROR repeats the exact last historical native error', async t => {
  for (const twoErrors of [false, true]) {
    const f = await historyFixture(t, { twoErrors }); const messages: string[] = [], output: string[] = [], sessions: string[] = [];
    const result = await f.adapter.execute({ ...f.context, resumeSessionId: f.session, run: { ...f.context.run, objective: 'history-recover' },
      onSession: id => { sessions.push(id); }, onOutput: text => { output.push(text); },
      onEvent: (type, message) => { if (type === 'message') messages.push(message); } });
    assert.equal(result, '恢复后本轮完成。');
    assert.deepEqual(sessions, [f.session]);
    assert.equal(output.at(-1), result);
    assert.deepEqual(messages, [result], '恢复终态不重复发布已完成的公开回复');
    assert.ok((await fs.readFile(f.transcript, 'utf8')).startsWith(f.baseline), '旧轨迹前缀保持不变');
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    const rows = (await fs.readFile(f.transcript, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const currentUser = rows[rows.length - 4];
    assert.ok(currentUser.content.startsWith(`<USER_REQUEST>\n${invocation.content}\n</USER_REQUEST>`));
  }
});

test('Antigravity historical-error compatibility rejects new errors, incomplete stream evidence and invalid process completion', async t => {
  for (const objective of [
    'history-current-error', 'history-current-error-state', 'history-tool-error', 'history-permission-error', 'history-different-error',
    'history-no-user-input', 'history-user-active', 'history-only-active', 'history-index-gap', 'history-second-user',
    'history-final-mismatch', 'history-unfinished-tool', 'history-exit2', 'history-step-after-result', 'history-duplicate-result',
    'history-session-mismatch',
  ]) await t.test(objective, async child => {
    const f = await historyFixture(child);
    await assert.rejects(f.execute(objective), /Antigravity/);
  });
});

test('Antigravity historical-error compatibility requires unchanged native history and exact evidence for this submitted turn', async t => {
  for (const objective of [
    'history-transcript-missing', 'history-transcript-truncated', 'history-transcript-prefix-replaced', 'history-transcript-partial-line',
    'history-input-mismatch', 'history-transcript-final-mismatch', 'history-transcript-second-user',
    'history-transcript-error', 'history-transcript-tool-error', 'history-transcript-active', 'history-transcript-index-gap',
  ]) await t.test(objective, async child => {
    const f = await historyFixture(child);
    await assert.rejects(f.execute(objective), /Antigravity/);
  });
  for (const [name, options] of [
    ['missing-before-execution', { missing: true }], ['non-monotonic-baseline', { invalidIndices: true }], ['no-old-error', { noError: true }],
  ] as const) await t.test(name, async child => {
    const f = await historyFixture(child, options);
    await assert.rejects(f.execute('history-recover'), /Antigravity/);
  });
  await t.test('new-session-is-not-a-resume', async child => {
    const f = await historyFixture(child, { session: 'antigravity-test-session' });
    await assert.rejects(f.adapter.execute({ ...f.context, run: { ...f.context.run, objective: 'history-recover' } }), /Antigravity/);
  });
});

test('Antigravity waits for normal CLI cleanup before confirming a historical-error result', { timeout: 12_000 }, async t => {
  const f = await historyFixture(t); const events: string[] = [];
  const result = await f.adapter.execute({ ...f.context, resumeSessionId: f.session,
    run: { ...f.context.run, objective: 'history-cleanup-delay' }, onEvent: (_type, message) => { events.push(message); } });
  assert.equal(result, '恢复后本轮完成。');
  assert.ok(events.some(message => /此前轮次/.test(message)));
});

test('Antigravity historical-error candidate must exit promptly and its process is terminated on timeout', { timeout: 25_000 }, async t => {
  const f = await historyFixture(t); const controller = new AbortController(); let pid = 0;
  const started = Date.now();
  const running = f.adapter.execute({ ...f.context, signal: controller.signal, resumeSessionId: f.session,
    run: { ...f.context.run, objective: 'history-hang' }, onPid: value => { pid = value; } });
  const settled = running.catch(() => {});
  t.after(async () => { controller.abort(); await settled; });
  await assert.rejects(running, /Antigravity/);
  assert.ok(Date.now() - started < 22_000, '候选终态不应无限等待进程退出');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Antigravity genuine SUCCESS remains successful when native history contains an old error', async t => {
  const f = await historyFixture(t);
  assert.equal(await f.execute('history-success'), '恢复后本轮完成。');
});

test('Antigravity historical-error recovery accepts aggregate public replies only when both native and streamed sequences agree', async t => {
  const f = await historyFixture(t); const messages: string[] = [], output: string[] = [];
  const result = await f.adapter.execute({ ...f.context, resumeSessionId: f.session, run: { ...f.context.run, objective: 'history-aggregate' },
    onOutput: text => { output.push(text); }, onEvent: (type, message) => { if (type === 'message') messages.push(message); } });
  assert.equal(result, '已检查。\n恢复后本轮完成。\n');
  assert.equal(output.at(-1), result);
  assert.deepEqual(messages, ['已检查。\n', '恢复后本轮完成。\n']);
  for (const objective of ['history-aggregate-native-mismatch', 'history-aggregate-empty-last', 'history-aggregate-current-error']) {
    const rejected = await historyFixture(t);
    await assert.rejects(rejected.execute(objective), /Antigravity/);
  }
});

test('Antigravity cancellation remains authoritative while an old-error candidate waits for native exit', { timeout: 10_000 }, async t => {
  const f = await historyFixture(t); const controller = new AbortController(); let pid = 0;
  const running = f.adapter.execute({ ...f.context, signal: controller.signal, resumeSessionId: f.session,
    run: { ...f.context.run, objective: 'history-wait-for-abort' }, onPid: value => { pid = value; } });
  const settled = running.catch(() => {});
  t.after(async () => { controller.abort(); await settled; });
  const marker = path.join(f.directory, 'antigravity-fixture-result-emitted');
  for (let attempt = 0; attempt < 100; attempt++) { try { await fs.access(marker); break; } catch { await delay(20); } }
  await fs.access(marker); await delay(100);
  controller.abort();
  await assert.rejects(running, /运行已停止/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Antigravity rejects callback persistence failures after native historical-error evidence is verified', { timeout: 10_000 }, async t => {
  const lifecycle = await historyFixture(t);
  await assert.rejects(lifecycle.adapter.execute({ ...lifecycle.context, resumeSessionId: lifecycle.session,
    run: { ...lifecycle.context.run, objective: 'history-recover' },
    onEvent: type => { if (type === 'lifecycle') throw new Error('lifecycle storage failed'); } }), /记录保存失败/);
  const output = await historyFixture(t); let verified = false;
  await assert.rejects(output.adapter.execute({ ...output.context, resumeSessionId: output.session,
    run: { ...output.context.run, objective: 'history-output-final-whitespace' },
    onEvent: type => { if (type === 'lifecycle') verified = true; },
    onOutput: () => { if (verified) throw new Error('output storage failed'); } }), /记录保存失败/);
  assert.equal(verified, true, '输出回调故障发生在兼容证据核验完成后');
});


test('Antigravity accepts a strictly increasing historical transcript gap and completed system postamble', async t => {
  for (const objective of ['history-recover', 'history-trailing-system']) {
    const f = await historyFixture(t, { historyGap: true });
    assert.equal(await f.execute(objective), '恢复后本轮完成。');
    assert.ok((await fs.readFile(f.transcript, 'utf8')).startsWith(f.baseline));
  }
});

test('Antigravity verifies old quota and authentication errors omitted from JSON against the native SQLite trajectory', async t => {
  for (const sqlite of ['quota', 'auth', 'raw'] as const) {
    const f = await historyFixture(t, { sqlite }); const events: string[] = [];
    const result = await f.adapter.execute({ ...f.context, resumeSessionId: f.session,
      run: { ...f.context.run, objective: `history-sqlite-old-${sqlite}` }, onEvent: (_type, message) => { events.push(message); } });
    assert.equal(result, '恢复后本轮完成。');
    assert.ok(events.some(message => /此前轮次/.test(message)));
    assert.doesNotMatch(events.join('\n'), /PRIVATE_HEADERS/);
    assert.equal((await fixtureRecords(f.directory, 'auth-invocations.jsonl')).length, 1, '旧认证错误不应触发重放或登录恢复');
    assert.equal((await fixtureRecords(f.directory, 'auth-probes.jsonl')).length, 0);
    assert.ok((await fs.readFile(f.transcript, 'utf8')).startsWith(f.baseline));
  }
});

test('Antigravity rejects mismatched or changed native SQLite history and incomplete or failed current database steps', async t => {
  for (const objective of ['history-sqlite-current-error', 'history-sqlite-missing-current-row', 'history-sqlite-history-changed']) {
    const f = await historyFixture(t, { sqlite: 'quota' });
    await assert.rejects(f.execute(objective), /Antigravity/);
  }
  const mismatched = await historyFixture(t, { sqlite: 'wrong-session' });
  await assert.rejects(mismatched.execute('history-sqlite-wrong-session'), /Antigravity/);
});

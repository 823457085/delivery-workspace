/** Local subprocess contracts; account smoke checks are performed separately. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createKiroAdapter, kiroAgentConfig, kiroModels, kiroRunArguments } from '../server/kiro-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const sample: AgentRun = { id: 'kiro-test', provider: 'kiro', mode: 'ask', accessMode: 'workspace', model: 'auto', reasoningEffort: '',
  objective: 'success', workspacePath: '', branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

async function fixture(t: TestContext, variant = 'kiro-peer') {
  const directory = await fs.mkdtemp(path.resolve('.kiro-runtime-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, `${variant}.mjs`);
  await fs.copyFile(path.resolve('test/fixtures/kiro-runtime.mjs'), binary);
  await fs.chmod(binary, 0o700);
  const marker = path.join(directory, 'kiro-fixture-started.json');
  return { directory, binary, marker, context: { run: { ...sample, workspacePath: directory }, fileAttachments: [], imagePaths: [],
    signal: new AbortController().signal, onPid(_pid: number) {}, onSession(_sessionId: string) {}, onEvent(_type: string, _message: string) {} } };
}

test('Kiro health requires login and the verified headless flags; never exposes account details', async t => {
  for (const variant of ['kiro-peer', 'logged-out', 'old-cli']) {
    const f = await fixture(t, variant);
    const health = await createKiroAdapter(f.binary).health();
    assert.equal(health.ready, variant === 'kiro-peer');
    assert.equal(health.authenticated, variant !== 'logged-out');
    assert.equal(JSON.stringify(health).includes('private@example.invalid'), false);
    if (variant === 'kiro-peer') assert.deepEqual(health.models.map(model => model.id), ['auto', 'test-model']);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  }
});

test('Kiro models preserve CLI labels and avoid duplicate or malformed IDs', () => {
  assert.deepEqual(kiroModels(JSON.stringify({ models: [{ model_id: 'test', model_name: 'L123' }, { model_id: 'test' }, {}], default_model: 'missing' })),
    { models: [{ id: 'test', label: 'L123' }], defaultModel: 'test' });
  assert.throws(() => kiroModels('{"models":[]}'), /模型/);
});

test('Kiro profiles isolate tools, MCP and hooks, and only full Agent trusts all tools', () => {
  for (const mode of ['ask', 'plan'] as const) {
    const config = kiroAgentConfig({ mode, accessMode: 'workspace' }, '/work');
    assert.deepEqual(config.tools, ['read', 'glob', 'grep']);
    assert.deepEqual(config.mcpServers, {}); assert.equal(config.includeMcpJson, false);
    assert.deepEqual(config.hooks, {}); assert.deepEqual(config.resources, []);
  }
  const workspace = kiroAgentConfig({ mode: 'agent', accessMode: 'workspace' }, '/work');
  assert.deepEqual(workspace.tools, ['read', 'glob', 'grep', 'write']);
  assert.deepEqual(workspace.allowedTools, ['read', 'glob', 'grep']);
  assert.deepEqual(workspace.toolsSettings?.write.allowedPaths, ['/work/**']);
  const args = kiroRunArguments({ mode: 'agent', accessMode: 'workspace', model: 'auto' }, 'kiro-original-session');
  assert.ok(args.includes('--v2')); assert.ok(args.includes('--trust-tools=read,glob,grep'));
  assert.ok(!args.includes('--trust-all-tools')); assert.equal(args.at(-1), 'kiro-original-session');
  assert.ok(kiroAgentConfig({ mode: 'agent', accessMode: 'full' }, '/work').tools.includes('shell'));
  assert.ok(kiroRunArguments({ mode: 'agent', accessMode: 'full', model: 'auto' }).includes('--trust-all-tools'));
  assert.equal(kiroRunArguments({ mode: 'agent', accessMode: 'full', model: 'auto' }).includes('--agent'), false,
    'full access must not replace the native tool, MCP and customization configuration');
});

test('Kiro full Agent uses native configuration on every resumed invocation', async t => {
  const f = await fixture(t);
  const adapter = createKiroAdapter(f.binary);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await adapter.execute({ ...f.context, run: { ...f.context.run, mode: 'agent', accessMode: 'full' },
      resumeSessionId: 'kiro-original-session' }), '你好 Kiro');
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    assert.equal(invocation.args.includes('--agent'), false);
    assert.ok(invocation.args.includes('--trust-all-tools'));
    assert.equal(invocation.directory, null); assert.equal(invocation.profile, null);
  }
});

test('Kiro records PID before launching, parses chunks and final line, persists one matching session and removes profile', async t => {
  const f = await fixture(t);
  const sessions: string[] = [], output: string[] = [], events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = createKiroAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'kiro-original-session',
    onPid: () => gate, onSession: id => { sessions.push(id); }, onOutput: text => { output.push(text); }, onEvent: (_type, message) => { events.push(message); } });
  await delay(100);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  release();
  assert.equal(await run, '你好 Kiro');
  assert.deepEqual(sessions, ['kiro-original-session']);
  assert.deepEqual(output, ['你好', '你好 Kiro']);
  assert.deepEqual(events, ['你好 Kiro']);
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.deepEqual(invocation.profile.tools, ['read', 'glob', 'grep']);
  await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
});

test('Kiro rejects incomplete, failed, mismatched and permission-denied runs even after exit zero', async t => {
  for (const [objective, expected] of [['missing-finish', /成功结束/], ['mismatch', /会话 ID/], ['error', /额度已用尽/],
    ['permission', /权限被拒绝/], ['non-success', /成功结束/], ['non-end-turn', /成功结束/]] as const) {
    const f = await fixture(t);
    await assert.rejects(createKiroAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'kiro-original-session',
      run: { ...f.context.run, objective } }), expected);
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
  }
});

test('Kiro cancellation stops the recorded process and cleans the temporary profile', async t => {
  const f = await fixture(t); const controller = new AbortController(); let pid = 0;
  const running = createKiroAdapter(f.binary).execute({ ...f.context, signal: controller.signal,
    run: { ...f.context.run, objective: 'hang' }, onPid: value => { pid = value; } });
  const settled = running.catch(() => {});
  const cleanup = async () => { controller.abort(); await settled; };
  t.after(cleanup);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.access(f.marker); break; } catch { await delay(20); }
    }
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    controller.abort(); await assert.rejects(running, /运行已停止/);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
  } finally {
    await cleanup();
  }
});

test('Kiro PID persistence failure does not release the CLI', async t => {
  const f = await fixture(t);
  await assert.rejects(createKiroAdapter(f.binary).execute({ ...f.context, onPid: () => { throw new Error('storage failed'); } }), /记录保存失败/);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('Kiro passes multiple image paths and ordinary attachments to the native read Image prompt', async t => {
  const f = await fixture(t);
  const paths = [path.join(f.directory, 'first picture.png'), path.join(f.directory, '第二张.png')];
  await Promise.all(paths.map(file => fs.writeFile(file, 'image-fixture')));
  const attachment = { name: 'spec "quoted".md', path: path.join(f.directory, 'spec file.md') };
  await fs.writeFile(attachment.path, 'specification');
  const result = await createKiroAdapter(f.binary).execute({ ...f.context, imagePaths: paths, fileAttachments: [attachment] });
  assert.equal(result, '你好 Kiro');
  const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
  assert.ok(invocation.prompt.startsWith(f.context.run.objective));
  for (const imagePath of paths) assert.ok(invocation.prompt.includes(JSON.stringify(imagePath)));
  assert.ok(invocation.prompt.indexOf(JSON.stringify(paths[0])) < invocation.prompt.indexOf(JSON.stringify(paths[1])));
  assert.match(invocation.prompt, /read.*Image.*image_paths/);
  assert.match(invocation.prompt, /逐张读取实际图片/);
  assert.ok(invocation.prompt.includes(JSON.stringify(attachment.name)));
  assert.ok(invocation.prompt.includes(JSON.stringify(attachment.path)));
  assert.deepEqual(invocation.profile.tools, ['read', 'glob', 'grep']);
  await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
});

test('Kiro accepts native image byte events above 2MB without exposing payloads in output or events', async t => {
  const f = await fixture(t); const image = path.join(f.directory, 'large.png');
  await fs.writeFile(image, Buffer.alloc(600_000, 255));
  const output: string[] = [], events: string[] = [];
  const result = await createKiroAdapter(f.binary).execute({ ...f.context, imagePaths: [image],
    run: { ...f.context.run, objective: 'large-image-event' },
    onOutput: text => { output.push(text); }, onEvent: (_type, message) => { events.push(message); } });
  assert.equal(result, '你好 Kiro');
  assert.deepEqual(output, ['你好', '你好 Kiro']);
  assert.deepEqual(events, ['读取图片', '你好 Kiro']);
  assert.ok(!JSON.stringify({ result, output, events }).includes('255,255'));
});

test('Kiro can reread historical images above 2MB when no new images are attached', async t => {
  const f = await fixture(t); const output: string[] = [], events: string[] = [];
  const result = await createKiroAdapter(f.binary).execute({ ...f.context, resumeSessionId: 'kiro-history-session',
    run: { ...f.context.run, objective: 'large-image-event' },
    onOutput: text => { output.push(text); }, onEvent: (_type, message) => { events.push(message); } });
  assert.equal(result, '你好 Kiro');
  assert.deepEqual(output, ['你好', '你好 Kiro']);
  assert.deepEqual(events, ['读取图片', '你好 Kiro']);
});

test('Kiro still rejects image events above 32MiB and text replies above 2MB', async t => {
  for (const objective of ['oversized-image-event', 'oversized-text', 'oversized-final-text']) {
    const f = await fixture(t); const image = path.join(f.directory, 'bounded.png');
    await fs.writeFile(image, Buffer.alloc(600_000));
    await assert.rejects(createKiroAdapter(f.binary).execute({ ...f.context, imagePaths: [image],
      run: { ...f.context.run, objective } }), /大小限制/);
    const invocation = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    await assert.rejects(fs.access(invocation.directory), { code: 'ENOENT' });
  }
});

test('Kiro rejects missing image files, fork and read-only full access before spawning', async t => {
  const f = await fixture(t); const adapter = createKiroAdapter(f.binary);
  await assert.rejects(adapter.execute({ ...f.context, imagePaths: [path.join(f.directory, 'missing.png')] }), { code: 'ENOENT' });
  await assert.rejects(adapter.execute({ ...f.context, forkSessionId: 'original-session' }), /派生/);
  await assert.rejects(adapter.execute({ ...f.context, run: { ...f.context.run, accessMode: 'full' } }), /只有 Agent/);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('Kiro repeated execution of one run preserves earlier image copies and creates a separate attempt directory',
  { skip: process.platform !== 'darwin' }, async t => {
    const f = await fixture(t);
    const image = path.join(f.directory, 'large-original.png');
    const original = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64'),
      Buffer.alloc(1024 * 1024)]);
    await fs.writeFile(image, original);
    const attachmentDirectory = path.join(await fs.realpath(f.directory), 'persistent-images');
    const context = { ...f.context, imagePaths: [image], attachmentDirectory };
    const adapter = createKiroAdapter(f.binary);
    assert.equal(await adapter.execute(context), '你好 Kiro');
    const [firstAttempt] = await fs.readdir(attachmentDirectory);
    assert.match(firstAttempt, /^attempt-[0-9a-f-]+$/);
    const firstDirectory = path.join(attachmentDirectory, firstAttempt);
    const [firstImage] = await fs.readdir(firstDirectory);
    const previousCopy = await fs.readFile(path.join(firstDirectory, firstImage));
    assert.equal(await adapter.execute({ ...context, resumeSessionId: 'kiro-session-1234' }), '你好 Kiro');
    const attempts = await fs.readdir(attachmentDirectory);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.includes(firstAttempt));
    assert.deepEqual(await fs.readFile(path.join(firstDirectory, firstImage)), previousCopy, '旧原生上下文引用的兼容副本不能被重启覆盖或删除');
    assert.deepEqual(await fs.readFile(image), original, '原图始终不变');
  });

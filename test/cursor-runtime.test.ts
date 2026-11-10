/** 验证真实子进程边界：不调用远端模型，检查附件传参、长运行和手动停止。 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createCursorAdapter } from '../server/agent-runtime.js';
import { readDeliveryReport } from '../shared/delivery-report.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const fixture = path.resolve('test/fixtures/cursor-runtime.mjs');
const sample: AgentRun = { id: 'test', provider: 'cursor', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
  objective: '读取附件', workspacePath: os.tmpdir(), branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

async function healthFixture(t: TestContext, output: string, code = 0, waitMs = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-health-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'cursor-health.mjs');
  const calls = path.join(directory, 'calls.jsonl');
  await fs.writeFile(binary, [
    '#!/usr/bin/env node',
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'if (process.argv.includes("--version")) { console.log("cursor-test"); process.exit(0); }',
    'if (process.argv.includes("--list-models")) { console.log("auto"); process.exit(0); }',
    `setTimeout(() => { process.stdout.write(${JSON.stringify(output)}); process.exit(${code}); }, ${waitMs});`,
  ].join('\n'), { mode: 0o700 });
  return { binary, calls };
}

test('Cursor 登录检查使用结构化状态，明确区分未登录和检测失败', async t => {
  for (const [output, code, expected] of [
    ['{"isAuthenticated":true,"userInfo":{"email":"test@example.com"}}', 0, 'ready'],
    ['{"isAuthenticated":false}', 0, 'logged-out'],
    ['{"isAuthenticated":false}', 1, 'logged-out'],
    ['{"isAuthenticated":true}', 1, 'unknown'],
    ['network unavailable', 1, 'unknown'],
    ['temporarily unavailable', 0, 'unknown'],
    ['', 0, 'unknown'],
    ['{}', 0, 'unknown'],
    ['{"isAuthenticated":"false"}', 0, 'unknown'],
  ] as const) {
    const f = await healthFixture(t, output, code);
    const health = await createCursorAdapter(f.binary).health();
    assert.equal(health.ready, expected === 'ready', output);
    if (expected === 'ready') assert.equal(health.authenticated, true);
    if (expected === 'logged-out') assert.match(health.message, /尚未登录/);
    if (expected === 'unknown') {
      assert.match(health.message, /暂时无法确认登录状态/);
      assert.doesNotMatch(health.message, /尚未登录/);
    }
    const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(['status', '--format', 'json'])));
    assert.equal(calls.some(args => args.includes('--list-models')), expected === 'ready');
  }
});

test('Cursor 登录检测超过旧的 10 秒窗口仍能确认有效登录', { timeout: 20_000 }, async t => {
  const f = await healthFixture(t, '{"isAuthenticated":true,"userInfo":{"email":"test@example.com"}}', 0, 10_300);
  const health = await createCursorAdapter(f.binary).health();
  assert.equal(health.ready, true);
  assert.equal(health.authenticated, true);
});

test('Cursor 登录检测超时保留检测失败原因，不误报未登录', { timeout: 40_000 }, async t => {
  const f = await healthFixture(t, '{"isAuthenticated":true}', 0, 36_000);
  const health = await createCursorAdapter(f.binary).health();
  assert.equal(health.ready, false);
  assert.match(health.message, /暂时无法确认登录状态.*超时/);
  assert.doesNotMatch(health.message, /尚未登录/);
});

test('Cursor 只展示完整回复，思考片段、用户回显和工具文本不生成进度或覆盖正文', async () => {
  for (const hasResult of [true, false]) {
    const messages: string[] = [];
    const result = await createCursorAdapter(fixture).execute({
      run: { ...sample, objective: hasResult ? 'progress-events' : 'progress-events-no-result' },
      fileAttachments: [], imagePaths: [], signal: new AbortController().signal,
      onPid() {}, onSession() {}, onEvent(type, message) { if (type === 'message') messages.push(message); },
    });
    assert.deepEqual(messages, ['正在核对旧版本，确认变更范围。', '核对完成，已确认变更范围。', ...(hasResult ? ['已完成本轮核对。'] : [])]);
    assert.equal(result, hasResult ? '已完成本轮核对。' : '核对完成，已确认变更范围。');
  }
});

test('Cursor 聚合结果只在精确拼接已观察连续消息且末条为严格报告时保留末条原文', async t => {
  const progress = [
    '我先独立核对候选版本、三处改动和验证证据，再按审查标准给出结论。',
    '候选差异已对上，我接着核对类型契约、验证日志和当前文件哈希，确认审查对象没有在验证后被改过。',
    '还差一步：用当前工作区文件重算候选哈希，确认验证之后源码没有再变。',
  ];
  assert.deepEqual(progress.map(text => text.length), [32, 46, 33]);
  const report = `\`\`\`delivery-report\n${JSON.stringify({ version: 1, taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved',
    acceptance: [{ id: 'AC-4', status: 'passed', evidence: 'L001 原始审查证据；'.repeat(160) }] } })}\n\`\`\``;
  const quoted = report.split('\n').map(line => `> ${line}`).join('\n');
  const example = `以下仅为格式示例：\n\`\`\`\`markdown\n${report}\n\`\`\`\``;
  const multiple = `${report}\n${report}`;
  const failedReport = `\`\`\`delivery-report\n${JSON.stringify({ version: 1, taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested' } })}\n\`\`\``;
  const structuredProgress = JSON.stringify({ version: 1, taskResult: { role: 'reviewer', status: 'failed' } });
  const cases = [
    { name: '真实连续后缀拼接', messages: [...progress, report], final: progress[2] + report, expected: report, valid: true },
    { name: '全部消息拼接', messages: [...progress, report], final: progress.join('') + report, expected: report, valid: true },
    { name: '独立最终结果', messages: [...progress, report], final: '独立最终说明', expected: '独立最终说明', valid: false },
    { name: '未观察前缀不能切分', messages: [...progress, report], final: `未知前缀${report}`, expected: `未知前缀${report}`, valid: false },
    { name: '非连续消息不能切分', messages: [...progress, report], final: progress[0] + report, expected: progress[0] + report, valid: false },
    { name: '普通文本片段不截短', messages: ['普通', '流式', '正文'], final: '普通流式正文', expected: '普通流式正文', valid: false },
    { name: '引用报告不转正', messages: [progress[2], quoted], final: progress[2] + quoted, expected: progress[2] + quoted, valid: false },
    { name: '外层示例不转正', messages: [progress[2], example], final: progress[2] + example, expected: progress[2] + example, valid: false },
    { name: '多报告仍拒绝', messages: [progress[2], multiple], final: progress[2] + multiple, expected: progress[2] + multiple, valid: false },
    { name: '跨消息失败报告不能被后续通过覆盖', messages: [failedReport, report], final: failedReport + report, expected: failedReport + report, valid: false },
    { name: '跨消息重复报告不能选其中一份', messages: [report, report], final: report + report, expected: report + report, valid: false },
    { name: '结构化前缀不能按普通进度丢弃', messages: [structuredProgress, report], final: structuredProgress + report, expected: structuredProgress + report, valid: false },
    { name: '较早报告不能代替最后回复', messages: [report, '尚未确认候选'], final: report + '尚未确认候选', expected: report + '尚未确认候选', valid: false },
    { name: '无assistant时保留result', messages: [], final: report, expected: report, valid: true },
  ];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-report-boundary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [index, value] of cases.entries()) {
    const binary = path.join(directory, `cursor-${index}.mjs`);
    const events: object[] = value.messages.flatMap(text => [
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      { type: 'tool_call', text: '工具输出不能参与正文聚合' },
    ]);
    events.push({ type: 'result', result: value.final });
    await fs.writeFile(binary, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')});\n`, { mode: 0o700 });
    const messages: string[] = [];
    const result = await createCursorAdapter(binary).execute({ run: sample, fileAttachments: [], imagePaths: [], signal: new AbortController().signal,
      onPid() {}, onSession() {}, onEvent(type, text) { if (type === 'message') messages.push(text); },
    });
    assert.equal(result, value.expected, value.name);
    assert.deepEqual(messages.slice(0, value.messages.length), value.messages, `${value.name}保留原进度及完整assistant`);
    if (value.valid) assert.doesNotThrow(() => readDeliveryReport(result), value.name);
    else assert.throws(() => readDeliveryReport(result), undefined, value.name);
  }
});

async function markerFixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-start-gate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'cursor-peer.mjs');
  await fs.writeFile(binary, [
    '#!/usr/bin/env node',
    'import fs from "node:fs";',
    'fs.writeFileSync("executed", "yes");',
    'const prompt = process.argv.at(-1);',
    'process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: prompt }] } }) + "\\n");',
    'if (prompt.includes("exit-seven")) process.exit(7);',
    'if (prompt.includes("hold-open")) setInterval(() => {}, 1000);',
  ].join('\n'), { mode: 0o700 });
  return { directory, binary, marker: path.join(directory, 'executed') };
}

test('Cursor PID 保存前没有执行命令；拒绝保存不会产生执行标记，保存后透传结果', { timeout: 5000 }, async t => {
  for (const failPersistence of [true, false]) {
    const f = await markerFixture(t);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    let gatePid = 0;
    const settled = createCursorAdapter(f.binary).execute({ run: { ...sample, workspacePath: f.directory },
      fileAttachments: [], imagePaths: [], signal: controller.signal,
      async onPid(pid) { gatePid = pid; entered(); await held; if (failPersistence) throw new Error('fixture save failed'); },
      onSession() {}, onEvent() {},
    }).catch(error => error as Error);
    try {
      await saving;
      assert.ok(gatePid > 0);
      await delay(100);
      await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
      release();
      const result = await settled;
      if (failPersistence) {
        assert.match(String(result), /进程记录保存失败/);
        await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
      } else {
        assert.equal(typeof result, 'string');
        assert.match(String(result), /读取附件/);
        assert.equal(await fs.readFile(f.marker, 'utf8'), 'yes');
      }
      assert.throws(() => process.kill(gatePid, 0), { code: 'ESRCH' });
    } finally { release(); controller.abort(); await settled; }
  }
});

test('Cursor 启动门保留真实 CLI 的非零退出码', async t => {
  const f = await markerFixture(t);
  await assert.rejects(createCursorAdapter(f.binary).execute({ run: { ...sample, workspacePath: f.directory, objective: 'exit-seven' },
    fileAttachments: [], imagePaths: [], signal: new AbortController().signal, onPid() {}, onSession() {}, onEvent() {},
  }), /7/);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'yes');
});

test('Cursor 会话记录异步保存失败时拒绝本轮并收回进程，不产生未处理拒绝', { timeout: 5000 }, async t => {
  let pid = 0;
  const controller = new AbortController();
  t.after(() => controller.abort());
  await assert.rejects(createCursorAdapter(fixture).execute({ run: { ...sample, objective: 'hold-open' },
    fileAttachments: [], imagePaths: [], signal: controller.signal,
    onPid(value) { pid = value; },
    async onSession() { throw new Error('fixture session persistence failed'); }, onEvent() {},
  }), /会话记录保存失败/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('启动门提前断开不执行；放行后断开保留 PID；IPC 停止会终止真实 CLI', { timeout: 5000 }, async t => {
  const f = await markerFixture(t);
  for (const mode of ['unreleased', 'disconnected', 'stop']) {
    const released = mode !== 'unreleased';
    await fs.rm(f.marker, { force: true });
    const gate = spawn(process.execPath, [fileURLToPath(new URL('../server/cli-start-gate.mjs', import.meta.url))], {
      cwd: f.directory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32',
    });
    const closed = new Promise<number | null>((resolve, reject) => { gate.once('exit', resolve); gate.once('error', reject); });
    try {
      if (released) {
        gate.send({ type: 'start', command: f.binary, args: ['hold-open'], stdin: '' });
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await fs.access(f.marker).then(() => true, () => false)) break;
          await delay(5);
        }
        await fs.access(f.marker);
      }
      if (mode === 'stop') gate.send({ type: 'stop', signal: 'SIGTERM' });
      else gate.disconnect();
      if (mode === 'disconnected') {
        await delay(50);
        assert.equal(process.kill(gate.pid!, 0), true);
        gate.kill('SIGTERM');
      }
      assert.equal(await closed, 1);
      if (!released) await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
    } finally { gate.kill('SIGKILL'); await closed; }
  }
});

test('未信任时显示准确错误，仅确认的当前目录收到 --trust，沙箱权限保持不变', async () => {
  await fs.chmod(fixture, 0o755);
  const adapter = createCursorAdapter(fixture);
  const run = { ...sample, objective: 'require-workspace-trust' };
  const context = { run, fileAttachments: [], imagePaths: [], signal: new AbortController().signal,
    onPid() {}, onSession() {}, onEvent() {} };
  await assert.rejects(adapter.execute(context), /当前工作区尚未信任/);
  await assert.rejects(adapter.execute({ ...context, run: { ...run, cursorTrustPath: '/other-workspace' } }), /当前工作区尚未信任/);
  const result = await adapter.execute({ ...context, run: { ...run, cursorTrustPath: run.workspacePath } });
  assert.match(result, /require-workspace-trust/);
});

test('Cursor CLI 收到已校验的图片及文件路径，路径不会变成额外 CLI 参数', async () => {
  await fs.chmod(fixture, 0o755);
  const files = [{ name: '截图.png', path: '/private/含 空格/截图.png' }, { name: '报表.txt', path: '/private/--force;$(echo).txt' }];
  const result = await createCursorAdapter(fixture).execute({ run: sample, fileAttachments: files, imagePaths: [],
    signal: new AbortController().signal, onPid() {}, onSession() {}, onEvent() {} });
  for (const file of files) { assert.ok(result.includes(JSON.stringify(file.name))); assert.ok(result.includes(JSON.stringify(file.path))); }
  assert.ok(result.includes('读取附件'));
});

test('Cursor 超过 30 分钟及数小时不被杀死，手动中断仍释放进程', { timeout: 5000 }, async t => {
  await fs.chmod(fixture, 0o755);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kill = t.mock.method(process, 'kill');
  const controller = new AbortController();
  let ready!: () => void;
  const available = new Promise<void>(resolve => { ready = resolve; });
  const running = createCursorAdapter(fixture).execute({ run: { ...sample, objective: 'hold-open' },
    imagePaths: [], fileAttachments: [], signal: controller.signal, onPid() {}, onSession() { ready(); }, onEvent() {} });
  const settled = running.catch(error => error as Error);
  try {
    await available;
    t.mock.timers.tick(31 * 60_000);
    t.mock.timers.tick(3 * 60 * 60_000);
    assert.equal(kill.mock.callCount(), 0);
    controller.abort();
    assert.match(String(await settled), /停止/);
    assert.ok(kill.mock.callCount() > 0);
  } finally { controller.abort(); await settled; }
});

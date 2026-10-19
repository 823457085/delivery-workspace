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
import type { AgentRun } from '../shared/agent-runtime.js';

const fixture = path.resolve('test/fixtures/cursor-runtime.mjs');
const sample: AgentRun = { id: 'test', provider: 'cursor', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
  objective: '读取附件', workspacePath: os.tmpdir(), branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

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

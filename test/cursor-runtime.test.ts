/** 验证真实子进程边界：不调用远端模型，检查附件传参、长运行和手动停止。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCursorAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const fixture = path.resolve('test/fixtures/cursor-runtime.mjs');
const sample: AgentRun = { id: 'test', provider: 'cursor', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
  objective: '读取附件', workspacePath: os.tmpdir(), branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

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

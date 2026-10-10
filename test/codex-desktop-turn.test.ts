import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { desktopTurnFromSnapshot, runCodexDesktopTurn } from '../server/codex-desktop-turn.js';
import type { DesktopObject } from '../server/codex-desktop-ipc.js';
import type { LiveContext } from '../server/codex-live-turn.js';

const threadId = '33333333-3333-3333-3333-333333333333';
const turnId = 'owned-turn';
const idle = () => ({ id: threadId, hostId: 'local', cwd: os.tmpdir(), resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' }, requests: [] });
function snapshot(turns: DesktopObject[]) {
  return { ...idle(), turns: [], turnHistory: { kind: 'canonical', history: {
    entitiesByKey: Object.fromEntries(turns.map(turn => [`turn:${turn.id}`, { ...turn, turnId: turn.id, id: undefined }])),
  } } };
}
function fixture() {
  const controller = new AbortController();
  const calls: { method: string; params: DesktopObject; version: number }[] = [];
  const sessions: string[] = [];
  const outputs: string[] = [];
  const events: string[] = [];
  let closed = false;
  const context: LiveContext = { resumeSessionId: threadId, imagePaths: ['/tmp/task-image.png'], signal: controller.signal,
    run: { id: 'run', provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'selected-model', reasoningEffort: 'high', serviceTier: 'default',
      objective: 'test', workspacePath: os.tmpdir(), branch: '', headSha: '', status: 'running', sessionId: threadId, pid: null,
      result: '', error: '', events: [], createdAt: '', updatedAt: '' },
    onPid() {}, onSession(id) { sessions.push(id); }, onOutput(text) { outputs.push(text); }, onEvent(_type, text) { events.push(text); },
    onSteer() { assert.fail('不得把无 expectedTurnId 保护的桌面插入通道暴露为实时补充'); },
  };
  const monitor = { snapshot: async (): Promise<DesktopObject> => snapshot([{ id: turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'done' }] }]) };
  const desktop = {
    snapshot: async (): Promise<DesktopObject> => calls.length ? monitor.snapshot() : idle(),
    request: async (method: string, params: DesktopObject, version: number): Promise<DesktopObject> => {
      calls.push({ method, params, version });
      return method === 'thread-follower-start-turn' ? { result: { turn: { id: turnId, status: 'inProgress' } } } : { ok: true, interruptedTurnId: turnId };
    },
    assertConnected() {}, close() { closed = true; },
  };
  const options = { connect: async () => desktop, pollMs: 0 };
  return { context, controller, desktop, options, calls, sessions, outputs, events, monitor, get closed() { return closed; } };
}

test('空闲 desktop owner 续接原会话，按精确轮次读取增量和最终结果', async () => {
  const f = fixture();
  const pages = [
    { data: [{ id: 'foreign-turn', status: 'completed', items: [{ type: 'agentMessage', text: '不得采用' }] }] },
    { data: [{ id: turnId, status: 'inProgress', items: [{ id: 'comment', type: 'agentMessage', text: '正在检查' },
      { id: 'tool', type: 'commandExecution', command: 'check', status: 'inProgress' }] }] },
    { data: [{ id: turnId, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'done' }] }] },
  ];
  f.monitor.snapshot = async () => snapshot(pages.shift()!.data);
  const result = await runCodexDesktopTurn(f.context, 'original prompt', f.options);
  assert.equal(result, 'done');
  assert.deepEqual(f.sessions, [threadId]);
  assert.deepEqual(f.outputs, ['正在检查', 'done']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'thread-follower-start-turn');
  assert.equal(f.calls[0].version, 2);
  assert.match(f.events.join('\n'), /通过原会话继续执行/);
  assert.equal(f.closed, true);
});

test('desktop 续接显式保留权限、工作区、模型、速度和图片，不继承窗口设置', async () => {
  for (const [mode, accessMode, type] of [
    ['agent', 'workspace', 'workspaceWrite'], ['agent', 'full', 'dangerFullAccess'],
    ['ask', 'full', 'readOnly'], ['plan', 'workspace', 'readOnly'],
  ] as const) {
    const f = fixture(); Object.assign(f.context.run, { mode, accessMode });
    await runCodexDesktopTurn(f.context, '原始内容', f.options);
    const start = f.calls[0].params.turnStart as { request: DesktopObject; context: DesktopObject };
    assert.equal(start.request.threadId, threadId);
    assert.equal(start.request.cwd, os.tmpdir());
    assert.equal(start.request.approvalPolicy, 'never');
    assert.equal((start.request.sandboxPolicy as DesktopObject).type, type);
    assert.equal(start.request.model, 'selected-model');
    assert.equal(start.request.effort, 'high');
    assert.equal(start.request.serviceTier, 'default');
    assert.deepEqual(start.request.input, [{ type: 'text', text: '原始内容', text_elements: [] }, { type: 'localImage', path: '/tmp/task-image.png' }]);
    assert.deepEqual(start.context, { inheritThreadSettings: false, useAppServerPermissionDefault: false });
    assert.ok(start.request.clientUserMessageId);
    if (type === 'workspaceWrite') assert.deepEqual((start.request.sandboxPolicy as DesktopObject).writableRoots, [os.tmpdir().replace(/\/$/, '')]);
  }
});

test('真实运行、待处理授权、未确认提交均不得启动或中断原会话', async () => {
  for (const patch of [{ threadRuntimeStatus: { type: 'active' } }, { requests: [{ id: 'approval' }] },
    { unconfirmedTurnSubmissions: [{ requestId: 'pending' }] }]) {
    const f = fixture(); f.desktop.snapshot = async () => ({ ...idle(), ...patch });
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /确有任务正在执行/);
    assert.deepEqual(f.calls, []); assert.equal(f.closed, true);
  }
});

test('发送前重新确认状态，期间变忙或目录改变时不发送', async () => {
  for (const patch of [{ threadRuntimeStatus: { type: 'active' } }, { cwd: '/' }]) {
    const f = fixture(); let count = 0;
    f.desktop.snapshot = async () => ++count === 1 ? idle() : { ...idle(), ...patch };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /本次未启动/);
    assert.equal(f.calls.length, 0);
  }
});

test('未知状态、不同会话、不同主机或不同工作区均保守失败，不谎报运行中', async () => {
  for (const patch of [{ threadRuntimeStatus: {} }, { id: 'another-thread' }, { hostId: 'remote' }, { cwd: '/' }]) {
    const f = fixture(); f.desktop.snapshot = async () => ({ ...idle(), ...patch });
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), error => {
      assert.doesNotMatch(String(error), /确有任务正在执行/); return true;
    });
    assert.equal(f.calls.length, 0);
  }
});

test('发出前取消不发送；发送后取消只中断本轮的 expectedTurnId', async () => {
  const before = fixture(); before.controller.abort();
  await assert.rejects(runCodexDesktopTurn(before.context, 'prompt', before.options), /中断/);
  assert.deepEqual(before.calls, []);
  const after = fixture();
  after.monitor.snapshot = async () => {
    after.controller.abort(); return snapshot([{ id: turnId, status: 'inProgress', items: [] }]);
  };
  await assert.rejects(runCodexDesktopTurn(after.context, 'prompt', after.options), /中断/);
  assert.equal(after.calls.length, 2);
  assert.deepEqual(after.calls[1], { method: 'thread-follower-interrupt-turn', version: 4,
    params: { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId } });
});

test('中断回执失败必须报告未确认，不泛化中断其他轮次', async () => {
  const f = fixture(); const request = f.desktop.request;
  f.desktop.request = async (...args) => {
    if (args[0] === 'thread-follower-interrupt-turn') throw new Error('timeout');
    return request(...args);
  };
  f.monitor.snapshot = async () => {
    f.controller.abort(); return snapshot([{ id: turnId, status: 'inProgress', items: [] }]);
  };
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /中断未获桌面端确认/);
  assert.equal(f.closed, true);
});

test('启动回执超时或缺失轮次 ID 时不重发、不复制会话、不声明完成', async () => {
  for (const outcome of ['timeout', 'missing-id']) {
    const f = fixture(); let starts = 0;
    f.desktop.request = async () => { starts++; if (outcome === 'timeout') throw new Error('timeout'); return {}; };
    f.monitor.snapshot = async () => { assert.fail('不得读取未知轮次'); };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /未自动重复发送/);
    assert.equal(starts, 1); assert.deepEqual(f.sessions, []); assert.equal(f.closed, true);
  }
});

test('桌面无法连接时准确提示写入权占用，不把空闲占用称为正在执行', async () => {
  const f = fixture(); f.options.connect = async () => { throw new Error('ENOENT'); };
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /写入权.*未必有任务运行/);
});

test('已知轮次失败、被中断及桌面断连均不声明成功', async () => {
  for (const status of ['failed', 'interrupted']) {
    const f = fixture();
    f.monitor.snapshot = async () => snapshot([{ id: turnId, status, error: { message: 'failure' } }]);
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /failure/);
  }
  const f = fixture(); let checks = 0;
  f.desktop.assertConnected = () => { if (++checks > 1) throw new Error('desktop disconnected'); };
  f.monitor.snapshot = async () => snapshot([{ id: turnId, status: 'inProgress', items: [] }]);
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /desktop disconnected/);
  assert.equal(f.calls.length, 1);
});

test('canonical 实时轮次仍在运行时不采用历史重建的 interrupted，持续到真实完成', async () => {
  const f = fixture(); let polls = 0;
  f.monitor.snapshot = async () => ({
    ...snapshot([{ id: turnId, status: ++polls === 1 ? 'inProgress' : 'completed',
      items: [{ type: 'agentMessage', text: polls === 1 ? '任务正在执行' : '真实完成' }] }]),
    turns: [{ id: turnId, status: 'interrupted', items: [] }],
    threadRuntimeStatus: { type: polls === 1 ? 'active' : 'idle' },
  });
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), '真实完成');
  assert.equal(polls, 2);
  assert.deepEqual(f.outputs, ['任务正在执行', '真实完成']);
  assert.equal(f.calls.length, 1);
});

test('只读取确切轮次且监测时仍核对会话身份，未知形态不套用其他轮次', () => {
  assert.equal(desktopTurnFromSnapshot(snapshot([{ id: 'other', status: 'completed' }]), threadId, turnId), undefined);
  assert.equal(desktopTurnFromSnapshot({ ...idle(), turnHistory: { kind: 'canonical', history: {} },
    turns: [{ id: turnId, status: 'interrupted' }] }, threadId, turnId), undefined);
  assert.throws(() => desktopTurnFromSnapshot({ ...idle(), id: 'other' }, threadId, turnId), /状态无法确认/);
  assert.equal(desktopTurnFromSnapshot({ ...idle(), turns: [{ turnId, status: 'inProgress' }] }, threadId, turnId)?.status, 'inProgress');
});

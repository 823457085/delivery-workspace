import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { CodexDesktopTurnUnconfirmedError, desktopTurnFromSnapshot, runCodexDesktopTurn } from '../server/codex-desktop-turn.js';
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

test('轮次已启动后状态超时会重连原轮次，提示词只发送一次', async () => {
  const f = fixture(); let reads = 0, connections = 0;
  const result = f.monitor.snapshot;
  f.monitor.snapshot = async () => { if (++reads === 1) throw new Error('Codex 桌面会话状态读取超时'); return result(); };
  f.options.connect = async () => { connections++; return f.desktop; };
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), 'done');
  assert.equal(connections, 2);
  assert.equal(f.calls.filter(call => call.method === 'thread-follower-start-turn').length, 1);
});

test('持续观察超时返回可恢复的未知状态，不重复启动或中断业务轮次', async () => {
  const f = fixture(); let connections = 0;
  f.monitor.snapshot = async () => { throw new Error('Codex 桌面会话状态读取超时'); };
  f.options.connect = async () => { connections++; if (connections === 2) throw new Error('ECONNRESET'); return f.desktop; };
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), CodexDesktopTurnUnconfirmedError);
  assert.equal(connections, 3);
  assert.deepEqual(f.calls.map(call => call.method), ['thread-follower-start-turn']);
});

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

test('等待真实运行、待处理授权、未确认提交时取消，不启动或中断原会话', async () => {
  for (const patch of [{ threadRuntimeStatus: { type: 'active' } }, { requests: [{ id: 'approval' }] },
    { unconfirmedTurnSubmissions: [{ requestId: 'pending' }] }]) {
    const f = fixture(); f.desktop.snapshot = async () => { f.controller.abort(); return { ...idle(), ...patch }; };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /中断/);
    assert.deepEqual(f.calls, []); assert.equal(f.closed, true);
  }
});

test('原会话忙时自动等待，空闲后只启动一次，不采纳前一轮输出', async () => {
  const f = fixture(); let reads = 0, baselineAt = 0;
  f.desktop.snapshot = async () => {
    reads++;
    if (f.calls.length) return f.monitor.snapshot();
    return reads <= 3 ? { ...snapshot([{ id: 'previous-turn', status: 'completed', items: [{ type: 'agentMessage', text: '旧轮结果' }] }]),
      threadRuntimeStatus: { type: 'active' } } : idle();
  };
  f.context.onBeforeTurn = () => { baselineAt = reads; };
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), 'done');
  assert.equal(baselineAt, 4);
  assert.deepEqual(f.outputs, ['done']);
  assert.deepEqual(f.calls.map(call => call.method), ['thread-follower-start-turn']);
  assert.equal(f.events.filter(event => event.includes('等待空闲后自动开始')).length, 1);
});

test('模型容量失败留下 systemError，原轮次均已结束时可以续接且只发送一次', async () => {
  for (const canonical of [true, false]) {
    const f = fixture();
    const turns = [{ id: 'previous-turn', status: 'failed', error: { message: 'Selected model is at capacity.' },
      items: [{ type: 'agentMessage', text: '旧轮结果' }] }];
    const state = { ...(canonical ? snapshot(turns) : { ...idle(), turns }), threadRuntimeStatus: { type: 'systemError' } };
    f.desktop.snapshot = async () => f.calls.length ? f.monitor.snapshot() : state;
    assert.equal(await runCodexDesktopTurn(f.context, 'retry prompt', f.options), 'done');
    assert.deepEqual(f.outputs, ['done']);
    assert.deepEqual(f.calls.map(call => call.method), ['thread-follower-start-turn']);
  }
});

test('systemError 缺少终态证据或包含未知轮次状态时不启动', async () => {
  for (const state of [idle(), snapshot([]), snapshot([{ id: 'previous-turn' }]),
    snapshot([{ id: 'previous-turn', status: 'unknown' }]), snapshot([{ status: 'failed' }]),
    snapshot([{ id: '', status: 'failed' }])]) {
    const f = fixture();
    f.desktop.snapshot = async () => ({ ...state, threadRuntimeStatus: { type: 'systemError' } });
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /未能确认.*空闲/);
    assert.deepEqual(f.calls, []);
  }
});

test('systemError 仍有活动轮次、请求或未确认提交时仅等待，不启动或中断', async () => {
  for (const patch of [
    { ...snapshot([{ id: 'previous-turn', status: 'inProgress' }]) },
    { requests: [{ id: 'approval' }] },
    { unconfirmedTurnSubmissions: [{ requestId: 'pending' }] },
  ]) {
    const f = fixture();
    f.desktop.snapshot = async () => ({ ...snapshot([{ id: 'previous-turn', status: 'failed' }]),
      ...patch, threadRuntimeStatus: { type: 'systemError' } });
    f.context.onEvent = (_type, text) => { if (text.includes('等待空闲')) f.controller.abort(); };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /中断/);
    assert.deepEqual(f.calls, []);
  }
});

test('idle 与原会话活动轮次证据矛盾时仅等待，不发送或中断', async () => {
  const f = fixture();
  f.desktop.snapshot = async () => snapshot([{ id: 'previous-turn', status: 'inProgress' }]);
  f.context.onEvent = (_type, text) => { if (text.includes('等待空闲')) f.controller.abort(); };
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /中断/);
  assert.deepEqual(f.calls, []);
});

test('发送前 systemError 出现活动轮次会重新等待，结束后刷新基线且只续接一次', async () => {
  const f = fixture(); let reads = 0; const baselines: number[] = [];
  f.desktop.snapshot = async () => {
    reads++;
    if (f.calls.length) return f.monitor.snapshot();
    return { ...snapshot([{ id: 'previous-turn', status: reads === 2 ? 'inProgress' : 'failed' }]),
      threadRuntimeStatus: { type: 'systemError' } };
  };
  f.context.onBeforeTurn = () => { baselines.push(reads); };
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), 'done');
  assert.deepEqual(baselines, [1, 3]);
  assert.deepEqual(f.calls.map(call => call.method), ['thread-follower-start-turn']);
});

test('自动等待可以取消，只取消待发步骤，不中断桌面正在执行的另一轮', async () => {
  const f = fixture();
  f.desktop.snapshot = async () => ({ ...idle(), threadRuntimeStatus: { type: 'active' } });
  f.context.onEvent = (_type, text) => { if (text.includes('等待空闲')) f.controller.abort(); };
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), /中断/);
  assert.equal(f.calls.length, 0);
});

test('发送前变忙重新等待并刷新差异基线；目录改变则停止', async () => {
  const f = fixture(); let reads = 0; const baselines: number[] = [];
  f.desktop.snapshot = async () => {
    reads++; if (f.calls.length) return f.monitor.snapshot();
    return reads === 2 ? { ...idle(), threadRuntimeStatus: { type: 'active' } } : idle();
  };
  f.context.onBeforeTurn = () => { baselines.push(reads); };
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), 'done');
  assert.deepEqual(baselines, [1, 3]); assert.equal(f.calls.length, 1);
  const changed = fixture(); let checks = 0;
  changed.desktop.snapshot = async () => ++checks === 1 ? idle() : { ...idle(), cwd: '/' };
  await assert.rejects(runCodexDesktopTurn(changed.context, 'prompt', changed.options), /本次未启动/);
  assert.equal(changed.calls.length, 0);
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
    after.controller.abort(); return snapshot([{ id: turnId,
      status: after.calls.some(call => call.method === 'thread-follower-interrupt-turn') ? 'interrupted' : 'inProgress', items: [] }]);
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
  await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), error => {
    assert.ok(error instanceof CodexDesktopTurnUnconfirmedError);
    assert.match(error.message, /中断未获桌面端确认/); return true;
  });
  assert.equal(f.closed, true);
});

test('中断请求已回执但确切轮次未结束时仍保留未知状态，其他轮次结束也不能释放', async () => {
  for (const status of ['inProgress', 'missing']) {
    const f = fixture();
    f.monitor.snapshot = async () => {
      f.controller.abort();
      return snapshot([{ id: 'other-turn', status: 'interrupted', items: [] },
        ...(status === 'inProgress' ? [{ id: turnId, status, items: [] }] : [])]);
    };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), CodexDesktopTurnUnconfirmedError);
    assert.deepEqual(f.calls.map(call => call.method), ['thread-follower-start-turn', 'thread-follower-interrupt-turn']);
  }
});

test('停止请求与原轮次完成同时发生时采信确切最终结果，不将已完成成果误标取消', async () => {
  const f = fixture();
  f.monitor.snapshot = async () => {
    f.controller.abort();
    const stopped = f.calls.some(call => call.method === 'thread-follower-interrupt-turn');
    return snapshot([{ id: turnId, status: stopped ? 'completed' : 'inProgress',
      items: [{ type: 'agentMessage', text: stopped ? '真实最终结果' : '过程片段' }] }]);
  };
  assert.equal(await runCodexDesktopTurn(f.context, 'prompt', f.options), '真实最终结果');
  assert.equal(f.outputs.at(-1), '真实最终结果');
  assert.equal(f.calls.filter(call => call.method === 'thread-follower-start-turn').length, 1);
});

test('启动回执超时或缺失轮次 ID 时不重发、不复制会话、不声明完成', async () => {
  for (const outcome of ['timeout', 'missing-id']) {
    const f = fixture(); let starts = 0;
    f.desktop.request = async () => { starts++; if (outcome === 'timeout') throw new Error('timeout'); return {}; };
    f.monitor.snapshot = async () => { assert.fail('不得读取未知轮次'); };
    await assert.rejects(runCodexDesktopTurn(f.context, 'prompt', f.options), error => {
      assert.ok(error instanceof CodexDesktopTurnUnconfirmedError);
      assert.match(error.message, /未自动重复发送/); return true;
    });
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
  const f = fixture();
  f.desktop.assertConnected = () => { if (f.calls.length) throw new Error('desktop disconnected'); };
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

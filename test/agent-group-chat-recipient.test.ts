/** 执行真实群聊 SFC 的选择和发送逻辑，不启动 CLI 或派发真实任务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowRef, watch, type ShallowRef } from 'vue';
import type { GroupMember, GroupSendInput } from '../shared/agent-group-chat.js';
import { steerGroupMessage } from '../src/features/agent-workbench/group-chat-api.js';

type FixtureRoom = { id: string; source?: unknown; cursorTrustPaths: string[]; rounds: { id?: string; requestId: string; state?: string; automatic?: { taskId?: string; inputs: { requestId: string; processed: boolean }[] } }[] };
type FixtureTask = { id: string; state: string; chat?: { pendingInputs: { id: string; requestId?: string; attachmentIds?: string[] }[];
  steering?: { inputId: string; requestId?: string; phase: 'stopping' | 'processing' } } };
type FixtureCollaboration = { task: FixtureTask; runs: { id: string }[] };
type RetryReceipt = { roomId: string; state: 'sending' | 'accepted'; createdAt: string };
type FixtureOptions = {
  rerunResponse?: (roomId: string, action: string, input: unknown) => Promise<unknown>;
  scrollTick?: () => Promise<void>;
  operationResponse?: (kind: string, roomId: string, input: unknown) => Promise<unknown>;
};

function fixture(confirm: () => Promise<unknown> = async () => {}, sendResponse?: (input: GroupSendInput) => Promise<unknown>,
  retryResponse?: (taskId: string) => Promise<unknown>, options: FixtureOptions = {}) {
  const source = readFileSync(process.env.AGENT_GROUP_CHAT_TEST_SOURCE || new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentGroupChat.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['active', 'globalChanging', 'roomActions', 'changing', 'recipients', 'accessMode', 'newWorkspace', 'targetMembers', 'canSend',
    'pendingSends', 'visiblePendingSends', 'retryReceipts', 'retryReceipt', 'taskPromptDetail', 'editingMessage', 'editObjective'];
  const functions = ['send', 'switchRoom', 'updateRecipients', 'trustTurn', 'retryTurn', 'pendingSendSaved', 'retryCollaboration',
    'rerunCollaboration', 'action', 'resumeLogin', 'fallbackTurn', 'editMessage', 'saveEditedMessage', 'roomBusy', 'beginRoomAction', 'setRetryReceipt', 'setDetail', 'scrollPinnedResult', 'steerTask', 'steeringMessage', 'canSteerPendingSend', 'canSteerMessage', 'steerMessage'];
  const pieces = tree.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
      .filter(declaration => names.includes(declaration.name.getText(tree)))
      .map(declaration => `const ${declaration.getText(tree)};`);
    if (ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text || '')) return [statement.getText(tree)];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(tree) === 'watch'
      && ['selectedId', '() => props.initialRoomId', '[room, collaborationMessages]'].includes(statement.expression.arguments[0]?.getText(tree) || '')) return [statement.getText(tree)];
    return [];
  });
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const selectedId = shallowRef('current-room'), draft = shallowRef('处理选中成员的任务'), attachments = shallowRef([{ id: 'attachment' }]);
  const props = reactive({ initialRoomId: 'current-room' });
  const operationCalls: unknown[][] = [];
  const captured: GroupSendInput[] = [], emitted: unknown[][] = [], restored: unknown[] = [], trustCalls: unknown[][] = [], errors: string[] = [];
  let clears = 0, confirmations = 0, requestCount = 0;
  const room = shallowRef<FixtureRoom>({ id: 'current-room', cursorTrustPaths: [], rounds: [] });
  const collaborationMessages = shallowRef<{ role: string; text: string; createdAt: string }[]>([]);
  const collaboration = shallowRef<FixtureCollaboration>({ task: { id: 'team-task', state: 'blocked' }, runs: [] });
  const collaborationTask = computed(() => collaboration.value.task);
  const retryCalls: unknown[][] = [], rerunCalls: unknown[][] = [], updates: { key: unknown[]; value: unknown; updater: boolean }[] = [], successes: string[] = [];
  const scrollWrites: { roomId: string; top: number }[] = [];
  function makeViewport(roomId: string) {
    let top = 0;
    return { scrollHeight: 1000, get scrollTop() { return top; }, set scrollTop(value: number) { top = value; scrollWrites.push({ roomId, top }); } };
  }
  const viewport = shallowRef(makeViewport(selectedId.value));
  const cache = new Map<string, unknown>();
  const key = (kind: string, id: string) => JSON.stringify(['agent-group-chat', kind, id]);
  function seedRoom(id: string) {
    const taskId = id === 'current-room' ? 'team-task' : `team-${id}`;
    if (!cache.has(key('room', id))) cache.set(key('room', id), { room: { id, cursorTrustPaths: [], rounds: [{ id: `round-${id}`, requestId: `initial-${id}` }] } });
    if (!cache.has(key('collaboration', taskId))) cache.set(key('collaboration', taskId), { task: { id: taskId, state: 'blocked' }, runs: [] });
    return taskId;
  }
  cache.set(key('room', selectedId.value), { room: room.value });
  cache.set(key('collaboration', collaborationTask.value.id), collaboration.value);
  const client = {
    setQueryData: (queryKey: unknown[], value: unknown) => {
      const serialized = JSON.stringify(queryKey), updater = typeof value === 'function';
      const next = updater ? (value as (cached: unknown) => unknown)(cache.get(serialized)) : value;
      updates.push({ key: queryKey, value: next, updater });
      if (next === undefined) return;
      cache.set(serialized, next);
      if (queryKey[1] === 'room' && queryKey[2] === selectedId.value) room.value = (next as { room: FixtureRoom }).room;
      if (queryKey[1] === 'collaboration' && queryKey[2] === collaborationTask.value.id) collaboration.value = next as FixtureCollaboration;
    },
  };
  const member = (id: string, provider: 'codex' | 'cursor' = 'codex', enabled = true): GroupMember => ({ id, name: id, enabled, capability: 'read', instructions: id,
    binding: { provider, model: 'fixture', reasoningEffort: '' } });
  const members = shallowRef([member('lead'), member('dev'), member('review', 'cursor'), member('disabled', 'cursor', false)]);
  const operation = async (kind: string, roomId: string, input: unknown) => {
    operationCalls.push([kind, roomId, input]);
    return options.operationResponse ? options.operationResponse(kind, roomId, input) : cache.get(key('room', roomId));
  };
  const dependencies = { computed, shallowRef, watch, nextTick: options.scrollTick || nextTick, selectedId, draft, attachments, members, props,
    collaborationTask, collaboration, collaborationTasks: computed(() => [collaboration.value.task]), scope: ['agent-group-chat'], refresh: () => {}, client, viewport,
    rerunnableRound: computed(() => room.value.rounds.at(-1)),
    actOnGroup: async (roomId: string, action: string, input: unknown) => {
      rerunCalls.push([roomId, action, input]);
      return options.rerunResponse ? options.rerunResponse(roomId, action, input) : cache.get(key('room', roomId));
    },
    decideTeamTask: async (taskId: string, ...args: unknown[]) => { retryCalls.push([taskId, ...args]); return retryResponse ? retryResponse(taskId) : { id: taskId, state: 'running' }; },
    window: { matchMedia: () => ({ matches: false }) }, detailsCollapsed: shallowRef(false), workspaceExpanded: shallowRef(false), narrowSidebarOpen: shallowRef(false),
    questionTarget: shallowRef(), sendQuestionReply: async () => { throw new Error("普通发送不应回复问题"); },
    creating: shallowRef(false), draftKey: computed(() => selectedId.value || 'group:new'), config: shallowRef({ revision: 3 }),
    workspacePath: shallowRef('/project'), room, collaborationMessages, files: { pending: shallowRef(false) },
    drafts: { clear: () => { clears++; return { text: draft.value, attachments: attachments.value }; }, restore: (...args: unknown[]) => restored.push(args), move: () => {} },
    ElMessageBox: { confirm: async () => { confirmations++; return confirm(); } }, ElMessage: { error: (error: string) => errors.push(error), success: (message: string) => successes.push(message) },
    sendGroupMessage: async (input: GroupSendInput) => {
      captured.push(input);
      return sendResponse ? sendResponse(input) : { room: { ...room.value, id: selectedId.value || 'new-room', rounds: [...room.value.rounds, { requestId: input.requestId }] } };
    },
    pendingLogin: computed(() => ({ id: `login-${selectedId.value}`, loginHandoff: { runId: `login-run-${selectedId.value}` } })),
    resumeGroupLogin: (roomId: string, input: unknown) => operation('resume-login', roomId, input),
    fallbackGroupTurn: (roomId: string, input: unknown) => operation('fallback', roomId, input),
    retryGroupTurn: (roomId: string, input: unknown) => operation('retry-member', roomId, input), canRetry: () => true,
    pauseGroupMessage: (roomId: string, id: string) => operation('pause-edit', roomId, id),
    reviseGroupMessage: (roomId: string, id: string, input: unknown) => operation('revise', roomId, { id, input }),
    steerGroupMessage: (roomId: string, input: unknown) => operation('steer', roomId, input),
    teamChatActiveStates: new Set(['planning', 'running', 'waiting_input', 'awaiting_plan', 'blocked', 'needs_decision', 'needs_reconciliation']),
    runFor: () => ({ id: 'cursor-run', workspacePath: '/project/verification-copy' }),
    trustGroupTurn: async (roomId: string, input: unknown) => { trustCalls.push([roomId, input]); return options.operationResponse ? operation('trust', roomId, input) : { room: room.value }; },
    requestIds: new Map(), createRequestId: () => `fixture-request-${++requestCount}`, emit: (...args: unknown[]) => emitted.push(args),
  };
  const scope = effectScope();
  const state = scope.run(() => {
    watch(selectedId, (id, previous) => {
      if (room.value.id === previous) cache.set(key('room', previous), { room: room.value });
      cache.set(key('collaboration', collaborationTask.value.id), collaboration.value);
      const taskId = seedRoom(id);
      room.value = (cache.get(key('room', id)) as { room: FixtureRoom }).room;
      collaboration.value = cache.get(key('collaboration', taskId)) as FixtureCollaboration;
      viewport.value = makeViewport(id);
    }, { flush: 'sync' });
    // 兼容修前快照以执行同一行为回归，旧状态仅作观察别名，不替换任何业务函数。
    return new Function(...Object.keys(dependencies), `let pinnedToBottom = true;\n${code}\nreturn {
      recipients, accessMode, updateRecipients, send, switchRoom, trustTurn, retryTurn, pendingSends, visiblePendingSends,
      rerunCollaboration, retryCollaboration, action, resumeLogin, fallbackTurn, editMessage, saveEditedMessage, editingMessage, editObjective, retryReceipt, changing, scrollPinnedResult,
      active: typeof active === 'undefined' ? shallowRef(true) : active,
      globalChanging: typeof globalChanging === 'undefined' ? changing : globalChanging,
      roomBusy: typeof roomBusy === 'undefined' ? () => !!changing.value : roomBusy,
      canSteerMessage: typeof canSteerMessage === 'undefined' ? () => false : canSteerMessage,
      canSteerPendingSend: typeof canSteerPendingSend === 'undefined' ? () => false : canSteerPendingSend,
      steerMessage: typeof steerMessage === 'undefined' ? async () => {} : steerMessage,
    };`)(...Object.values(dependencies));
  }) as {
    recipients: ShallowRef<string[]>; accessMode: ShallowRef<'workspace' | 'full'>; updateRecipients: (value: string[]) => void; send: () => Promise<void>; switchRoom: (id: string) => void; trustTurn: (turn: { id: string }) => Promise<void>;
    pendingSends: ShallowRef<{ roomId: string; requestId: string; text: string; attachments: { id: string }[]; createdAt: string; accepted: boolean }[]>;
    visiblePendingSends: Readonly<ShallowRef<{ roomId: string; requestId: string; text: string; attachments: { id: string }[]; createdAt: string; accepted: boolean }[]>>;
    retryCollaboration(): Promise<void>; rerunCollaboration(): Promise<void>; action(value: 'pause' | 'continue' | 'cancel'): Promise<void>; scrollPinnedResult(): Promise<void>;
    active: ShallowRef<boolean>; resumeLogin(): Promise<void>; fallbackTurn(turn: { id: string; runId: string }): Promise<void>; retryTurn(turn: { id: string }): Promise<void>;
    editMessage(id: string, text: string, attachmentIds: string[]): Promise<void>; saveEditedMessage(): Promise<void>;
    editingMessage: ShallowRef<{ roomId: string; id: string; attachmentIds: string[]; accessMode?: 'workspace' | 'full' } | undefined>; editObjective: ShallowRef<string>;
    retryReceipt: Readonly<ShallowRef<RetryReceipt | undefined>>; changing: Readonly<ShallowRef<string>>; globalChanging: ShallowRef<string>; roomBusy(id: string): boolean;
    canSteerMessage(messageId: string): boolean; steerMessage(input: { messageId: string } | { requestId: string }): Promise<void>;
    canSteerPendingSend(message: { roomId: string; requestId: string; accepted: boolean }): boolean;
  };
  return { ...state, selectedId, draft, room, collaboration, collaborationTask, collaborationMessages, captured, emitted, restored, trustCalls, errors,
    operationCalls, retryCalls, rerunCalls, updates, successes, props, scrollWrites, viewport, makeViewport,
    readRetryReceipt: () => state.retryReceipt.value,
    getRoomCache: (id: string) => cache.get(key('room', id)) as { room: FixtureRoom },
    getTaskCache: (id: string) => cache.get(key('collaboration', id)) as FixtureCollaboration,
    setTaskCache: (id: string, value: FixtureCollaboration) => cache.set(key('collaboration', id), value),
    clears: () => clears, scrolls: () => scrollWrites.length, confirmations: () => confirmations, close: () => scope.stop() };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const accessMode of ['workspace', 'full'] as const) for (const kind of ['retry-member', 'trust', 'fallback', 'resume-login', 'team-retry', 'continue', 'rerun', 'steer', 'revise'] as const) {
  test(`群聊 ${kind} 新派发沿用当前显式选择 ${accessMode}，不清理草稿或附件`, async () => {
    const f = fixture();
    try {
      f.accessMode.value = accessMode;
      f.room.value = { ...f.room.value, rounds: [{ id: 'round-current', requestId: 'original-request' }] };
      if (kind === 'retry-member') await f.retryTurn({ id: 'turn' });
      else if (kind === 'trust') await f.trustTurn({ id: 'turn' });
      else if (kind === 'fallback') await f.fallbackTurn({ id: 'turn', runId: 'run' });
      else if (kind === 'resume-login') await f.resumeLogin();
      else if (kind === 'team-retry') await f.retryCollaboration();
      else if (kind === 'continue') await f.action('continue');
      else if (kind === 'rerun') await f.rerunCollaboration();
      else if (kind === 'steer') {
        f.room.value.rounds[0].automatic = { taskId: 'team-task', inputs: [] };
        f.collaboration.value.task.chat = { pendingInputs: [{ id: 'pending-user' }] };
        await f.steerMessage({ messageId: 'pending-user' });
      } else {
        f.editingMessage.value = { roomId: 'current-room', id: 'saved-user', attachmentIds: [], accessMode };
        f.editObjective.value = '修改后的指令'; await f.saveEditedMessage();
      }
      const input = kind === 'team-retry' ? f.retryCalls.at(-1)?.[1]
        : kind === 'continue' || kind === 'rerun' ? f.rerunCalls.at(-1)?.[2]
          : kind === 'trust' ? f.trustCalls.at(-1)?.[1] : f.operationCalls.at(-1)?.[2];
      const sent = kind === 'revise' ? (input as { input: unknown }).input : input;
      assert.equal((sent as { accessMode?: string } | undefined)?.accessMode, accessMode);
      assert.equal(f.clears(), 0); assert.equal(f.draft.value, '处理选中成员的任务');
    } finally { f.close(); }
  });
}

test('重跑改变访问选择后使用新的请求身份，不复用旧权限下的失败请求', async () => {
  const f = fixture(undefined, undefined, undefined, { rerunResponse: async () => { throw new Error('模拟响应失败'); } });
  try {
    f.room.value = { ...f.room.value, rounds: [{ id: 'round-current', requestId: 'original-request' }] };
    f.accessMode.value = 'workspace'; await f.rerunCollaboration();
    f.accessMode.value = 'full'; await f.rerunCollaboration();
    assert.notEqual((f.rerunCalls[0][2] as { requestId: string }).requestId, (f.rerunCalls[1][2] as { requestId: string }).requestId);
  } finally { f.close(); }
});

test('已接收群聊气泡可插队，精确引用请求并防止重复提交，不改草稿或附件', async () => {
  const gate = deferred<unknown>();
  const f = fixture(undefined, undefined, undefined, { operationResponse: () => gate.promise });
  const sent = { roomId: 'current-room', requestId: 'accepted-request', text: '根据接口返回处理', attachments: [{ id: 'attachment' }], createdAt: new Date().toISOString(), accepted: true };
  try {
    f.pendingSends.value = [sent];
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'round', automatic: { taskId: 'team-task', inputs: [{ requestId: sent.requestId, processed: false }] } }] };
    const pending = f.steerMessage({ requestId: sent.requestId });
    assert.equal(f.changing.value, 'steer:accepted-request');
    await f.steerMessage({ requestId: sent.requestId });
    assert.deepEqual(f.operationCalls, [['steer', 'current-room', { requestId: 'accepted-request', accessMode: 'full' }]]);
    gate.resolve({ room: f.room.value }); await pending;
    assert.deepEqual(f.pendingSends.value, [sent]);
    assert.equal(f.draft.value, '处理选中成员的任务');
    assert.equal(f.clears(), 0); assert.equal(f.changing.value, '');
  } finally { gate.resolve({ room: f.room.value }); f.close(); }
});

test('发送中和已消费群聊消息不能插队；持久待处理消息按消息 ID 操作', async () => {
  const f = fixture();
  try {
    f.pendingSends.value = [{ roomId: 'current-room', requestId: 'sending', text: '消息', attachments: [], createdAt: new Date().toISOString(), accepted: false }];
    await f.steerMessage({ requestId: 'sending' });
    await f.steerMessage({ requestId: 'missing' });
    await f.steerMessage({ messageId: 'consumed' });
    assert.deepEqual(f.operationCalls, []);
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'round', automatic: { taskId: 'team-task', inputs: [] } }] };
    f.collaboration.value = { task: { id: 'team-task', state: 'running', chat: { pendingInputs: [{ id: 'saved-user', attachmentIds: ['attachment'] }] } }, runs: [] };
    assert.equal(f.canSteerMessage('saved-user'), true);
    assert.equal(f.canSteerMessage('consumed'), false);
    await f.steerMessage({ messageId: 'saved-user' });
    assert.deepEqual(f.operationCalls, [['steer', 'current-room', { messageId: 'saved-user', accessMode: 'full' }]]);
    assert.deepEqual(f.collaboration.value.task.chat?.pendingInputs, [{ id: 'saved-user', attachmentIds: ['attachment'] }]);
    f.collaboration.value = { task: { ...f.collaboration.value.task, state: 'cancelled' }, runs: [] };
    assert.equal(f.canSteerMessage('saved-user'), false);
  } finally { f.close(); }
});

test('待处理身份来自当前自动轮；已交接输入精确匹配请求，不猜消息文本', async () => {
  const f = fixture();
  const sent = { roomId: 'current-room', requestId: 'accepted-request', text: '同文消息', attachments: [], createdAt: new Date().toISOString(), accepted: true };
  try {
    f.pendingSends.value = [sent];
    assert.equal(f.canSteerPendingSend(sent), false);
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'round', automatic: { taskId: 'team-task', inputs: [{ requestId: sent.requestId, processed: true }] } }] };
    f.collaboration.value = { task: { id: 'team-task', state: 'running', chat: { pendingInputs: [{ id: 'other-user', requestId: 'group:current-room:other-request' }] } }, runs: [] };
    assert.equal(f.canSteerPendingSend(sent), false);
    f.collaboration.value.task.chat!.pendingInputs[0].requestId = 'group:current-room:accepted-request';
    assert.equal(f.canSteerPendingSend(sent), true);
    assert.equal(f.canSteerPendingSend({ ...sent, roomId: 'other-room' }), false);
    f.room.value.source = { workflow: 'jira' };
    assert.equal(f.canSteerPendingSend(sent), false); assert.equal(f.canSteerMessage('other-user'), false);
    delete f.room.value.source;
    f.room.value.rounds[0].automatic!.taskId = 'another-task';
    assert.equal(f.canSteerPendingSend(sent), false); assert.equal(f.canSteerMessage('other-user'), false);
    f.room.value.rounds[0].automatic!.taskId = 'team-task';
    f.room.value.rounds[0].state = 'cancelled';
    assert.equal(f.canSteerPendingSend(sent), false); assert.equal(f.canSteerMessage('other-user'), false);
  } finally { f.close(); }
});

test('服务端插队回执阻止同一消息按持久 ID 或原请求再次插队', async () => {
  const f = fixture();
  const sent = { roomId: 'current-room', requestId: 'accepted-request', text: '优先问题', attachments: [{ id: 'attachment' }], createdAt: new Date().toISOString(), accepted: true };
  try {
    f.pendingSends.value = [sent];
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'round', automatic: { taskId: 'team-task', inputs: [{ requestId: sent.requestId, processed: true }] } }] };
    for (const phase of ['stopping', 'processing'] as const) {
      f.collaboration.value = { task: { id: 'team-task', state: 'running', chat: { pendingInputs: [{ id: 'saved-user', requestId: 'group:current-room:accepted-request' }],
        steering: { inputId: 'saved-user', requestId: 'group:current-room:accepted-request', phase } } }, runs: [] };
      await f.steerMessage({ messageId: 'saved-user' });
      await f.steerMessage({ requestId: 'accepted-request' });
    }
    assert.deepEqual(f.operationCalls, []); assert.deepEqual(f.pendingSends.value, [sent]);
    assert.equal(f.clears(), 0); assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

test('群聊插队 API 仅提交房间和所选身份，并保留后端错误', async t => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(status === 200 ? { room: { id: 'room/one' } } : { message: '原始拒绝原因 L409' }), { status });
  });
  assert.deepEqual(await steerGroupMessage('room/one', { messageId: 'saved-user' }), { room: { id: 'room/one' } });
  await steerGroupMessage('room/one', { requestId: 'accepted-request' });
  assert.deepEqual(calls.map(call => [call.url, call.init?.method, JSON.parse(String(call.init?.body))]), [
    ['/api/agent-runtimes/group-chat/rooms/room%2Fone/messages/steer', 'POST', { messageId: 'saved-user' }],
    ['/api/agent-runtimes/group-chat/rooms/room%2Fone/messages/steer', 'POST', { requestId: 'accepted-request' }],
  ]);
  assert.equal((calls[0].init?.headers as Record<string, string>)['X-Delivery-Confirmed'], 'yes');
  status = 409;
  await assert.rejects(steerGroupMessage('room/one', { requestId: 'accepted-request' }), /原始拒绝原因 L409/);
});

for (const success of [true, false]) test(`插队${success ? '成功' : '失败'}晚回包只更新来源群聊，不抢当前房间或释放另一房间的锁`, async () => {
  const gates = new Map([['current-room', deferred<unknown>()], ['other-room', deferred<unknown>()]]);
  const f = fixture(undefined, undefined, undefined, { operationResponse: (_kind, roomId) => gates.get(roomId)!.promise });
  try {
    const sent = (roomId: string) => ({ roomId, requestId: `input-${roomId}`, text: '同文消息', attachments: [{ id: roomId }], createdAt: new Date().toISOString(), accepted: true });
    const originalMessages = [sent('current-room'), sent('other-room')];
    f.pendingSends.value = originalMessages;
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'round', automatic: { taskId: 'team-task', inputs: [{ requestId: 'input-current-room', processed: false }] } }] };
    const firstRoom = f.room.value, first = f.steerMessage({ requestId: 'input-current-room' });
    f.switchRoom('other-room'); await nextTick();
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'other-round', automatic: { taskId: 'team-other-room', inputs: [{ requestId: 'input-other-room', processed: false }] } }] };
    const secondRoom = f.room.value, second = f.steerMessage({ requestId: 'input-other-room' });
    assert.equal(f.changing.value, 'steer:input-other-room');
    if (success) gates.get('current-room')!.resolve({ room: { ...firstRoom, cursorTrustPaths: ['source-result'] } });
    else gates.get('current-room')!.reject(new Error('该消息已被处理'));
    await first;
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.room.value.id, 'other-room');
    assert.equal(f.changing.value, 'steer:input-other-room');
    assert.equal(f.roomBusy('current-room'), false); assert.equal(f.roomBusy('other-room'), true);
    assert.equal(f.draft.value, '处理选中成员的任务'); assert.equal(f.clears(), 0);
    assert.deepEqual(f.pendingSends.value, originalMessages);
    if (success) assert.deepEqual(f.getRoomCache('current-room').room.cursorTrustPaths, ['source-result']);
    else assert.deepEqual(f.errors, ['该消息已被处理']);
    gates.get('other-room')!.resolve({ room: secondRoom }); await second;
    assert.equal(f.changing.value, '');
  } finally { for (const [roomId, gate] of gates) gate.resolve({ room: { id: roomId, rounds: [], cursorTrustPaths: [] } }); f.close(); }
});

test('重试提交期间立即显示回执并阻止重复点击，响应后保存任务真实状态', async () => {
  const gate = deferred<unknown>();
  const f = fixture(undefined, undefined, () => gate.promise);
  try {
    const pending = f.retryCollaboration();
    assert.equal(f.readRetryReceipt()?.state, 'sending'); assert.equal(f.changing.value, 'retry');
    await nextTick(); assert.equal(f.scrolls(), 1);
    await f.retryCollaboration(); assert.equal(f.retryCalls.length, 1);
    gate.resolve({ id: 'team-task', state: 'running' }); await pending;
    assert.equal(f.readRetryReceipt()?.state, 'accepted'); assert.equal(f.changing.value, '');
    assert.equal((f.updates[0] as { value: { task: { state: string } } }).value.task.state, 'running');
    assert.equal(f.successes.length, 1);
  } finally { f.close(); }
});

test('重试失败撤下等待回执并显示真实错误，不保留虚假的执行中状态', async () => {
  const f = fixture(undefined, undefined, async () => { throw new Error('原始重试错误 L999'); });
  try {
    await f.retryCollaboration();
    assert.deepEqual(f.retryReceipt.value, undefined); assert.equal(f.changing.value, '');
    assert.deepEqual(f.errors, ['原始重试错误 L999']); assert.equal(f.updates.length, 0);
  } finally { f.close(); }
});

test('群聊多选、取消成员和切回全体使用真实选择逻辑', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.recipients.value, ['all']);
    f.updateRecipients(['all', 'lead']); assert.deepEqual(f.recipients.value, ['lead']);
    f.updateRecipients(['lead', 'dev']); assert.deepEqual(f.recipients.value, ['lead', 'dev']);
    f.updateRecipients(['dev']); assert.deepEqual(f.recipients.value, ['dev']);
    f.updateRecipients(['dev', 'all']); assert.deepEqual(f.recipients.value, ['all']);
    f.updateRecipients([]); assert.deepEqual(f.recipients.value, []);
  } finally { f.close(); }
});

test('群聊单选和多选发送精确成员列表，未选 Cursor 不询问信任', async () => {
  const f = fixture();
  try {
    f.updateRecipients(['lead']); await f.send();
    f.updateRecipients(['lead', 'dev']); await f.send();
    assert.deepEqual(f.captured.map(input => input.memberIds), [['lead'], ['lead', 'dev']]);
    assert.deepEqual(f.captured.map(input => input.attachmentIds), [['attachment'], ['attachment']]);
    assert.equal(f.captured[1].expectedConfigRevision, 3);
    assert.equal(f.confirmations(), 0);
    f.selectedId.value = ''; await nextTick();
    f.updateRecipients(['lead', 'dev']); await f.send(); await nextTick();
    assert.equal(f.selectedId.value, 'new-room');
    assert.deepEqual(f.recipients.value, ['lead', 'dev'], '新群聊发送成功后仍保留定向选择，后续消息不意外广播');
  } finally { f.close(); }
});

test('群聊全体发送保留广播协议，空选择不清草稿也不发送', async () => {
  const f = fixture();
  try {
    await f.send(); assert.equal(f.captured[0].memberIds, undefined); assert.equal(f.confirmations(), 0);
    assert.equal(f.captured[0].cursorTrustPath, undefined);
    f.updateRecipients([]); await f.send();
    assert.equal(f.captured.length, 1); assert.equal(f.clears(), 1);
  } finally { f.close(); }
});

test('切换房间和外部房间切换均重置接收成员，全局配置操作也不禁止浏览会话', async () => {
  const f = fixture();
  try {
    f.updateRecipients(['lead', 'dev']); f.switchRoom('other-room'); await nextTick();
    assert.equal(f.selectedId.value, 'other-room'); assert.deepEqual(f.recipients.value, ['all']);
    f.updateRecipients(['dev']); f.props.initialRoomId = 'externally-selected-room'; await nextTick();
    assert.equal(f.selectedId.value, 'externally-selected-room');
    assert.deepEqual(f.recipients.value, ['all']);
    f.globalChanging.value = 'config'; f.switchRoom('viewable-room');
    assert.equal(f.selectedId.value, 'viewable-room');
  } finally { f.close(); }
});

test('包含 Cursor 的定向消息直接发送，发送后选择变化不改写本次接收成员', async () => {
  const f = fixture(async () => assert.fail('不应弹出 Cursor 信任确认'));
  try {
    f.updateRecipients(['dev', 'review']); const pending = f.send();
    f.updateRecipients(['all']); await pending;
    assert.equal(f.confirmations(), 0);
    assert.deepEqual(f.captured[0].memberIds, ['dev', 'review']);
    assert.equal(f.captured[0].cursorTrustPath, undefined, '实际执行目录由后端确定');
    assert.equal(f.captured[0].accessMode, 'full');
    assert.equal(f.captured[0].expectedConfigRevision, 3);
  } finally { f.close(); }
});

test('旧 Cursor 信任失败成员可直接重试，不再次弹信任确认', async () => {
  const f = fixture(async () => assert.fail('重试此成员不应弹信任确认'));
  try {
    await f.trustTurn({ id: 'review-turn' });
    assert.deepEqual(f.trustCalls, [['current-room', { turnId: 'review-turn', runId: 'cursor-run', workspacePath: '/project/verification-copy', accessMode: 'full' }]]);
    assert.equal(f.confirmations(), 0);
    f.globalChanging.value = 'config'; await f.trustTurn({ id: 'review-turn' });
    assert.equal(f.trustCalls.length, 1, '操作中不得重复重试');
  } finally { f.close(); }
});

test('发送请求仍在等待时已显示原文和附件，轮询先取得记录也只显示一次', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    f.draft.value = 'pc 项目 L001\n接口字段保持原文';
    const sending = f.send();
    assert.equal(f.changing.value, 'send');
    assert.equal(f.visiblePendingSends.value.length, 1);
    assert.equal(f.visiblePendingSends.value[0].text, f.draft.value);
    assert.deepEqual(f.visiblePendingSends.value[0].attachments, [{ id: 'attachment' }]);
    assert.equal(f.visiblePendingSends.value[0].accepted, false);
    await nextTick(); assert.equal(f.scrolls(), 1);
    f.room.value = { ...f.room.value, rounds: [{ requestId: f.captured[0].requestId }] };
    await nextTick();
    assert.equal(f.visiblePendingSends.value.length, 0);
    response.resolve({ room: f.room.value }); await sending;
    assert.equal(f.pendingSends.value.length, 0);
    assert.equal(f.changing.value, '');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('新群聊等待回执时显示待发气泡，成功后移入真实会话', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    f.selectedId.value = ''; await nextTick();
    const sending = f.send();
    assert.equal(f.visiblePendingSends.value.length, 1);
    assert.equal(f.visiblePendingSends.value[0].roomId, '');
    response.resolve({ room: { id: 'new-room', rounds: [{ requestId: f.captured[0].requestId }] } });
    await sending;
    assert.equal(f.selectedId.value, 'new-room');
    assert.equal(f.pendingSends.value.length, 0);
    assert.equal(f.visiblePendingSends.value.length, 0);
  } finally { f.close(); }
});

test('发送失败撤下待发气泡并按原文和附件恢复草稿', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    const sending = f.send();
    assert.equal(f.visiblePendingSends.value.length, 1);
    response.reject(new Error('连接暂不可用')); await sending;
    assert.equal(f.pendingSends.value.length, 0);
    assert.equal(f.visiblePendingSends.value.length, 0);
    assert.deepEqual(f.restored, [['current-room', { text: '处理选中成员的任务', attachments: [{ id: 'attachment' }] }]]);
    assert.deepEqual(f.errors, ['连接暂不可用']);
    assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

test('群聊发送回执迟到时不抢回外部切换后的房间和收件人', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    const sending = f.send();
    f.props.initialRoomId = 'other-room'; await nextTick();
    f.updateRecipients(['dev']);
    response.resolve({ room: { id: 'current-room', rounds: [{ requestId: f.captured[0].requestId }] } });
    await sending;
    assert.equal(f.selectedId.value, 'other-room');
    assert.deepEqual(f.recipients.value, ['dev']);
    assert.deepEqual(f.emitted, []);
    assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

for (const firstSuccess of [true, false]) test(`两房间可并发发送，A迟到${firstSuccess ? '成功' : '失败'}只处理A的缓存与草稿`, async () => {
  const responses = { 'current-room': deferred<unknown>(), 'other-room': deferred<unknown>() };
  const f = fixture(undefined, input => responses[input.roomId as keyof typeof responses].promise);
  try {
    f.draft.value = 'A 原文'; const a = f.send();
    assert.equal(f.changing.value, 'send'); await f.send(); assert.equal(f.captured.length, 1);
    f.switchRoom('other-room'); await nextTick();
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.changing.value, '');
    f.draft.value = 'B 原文'; f.updateRecipients(['dev']); const b = f.send();
    assert.equal(f.captured.length, 2); assert.equal(f.changing.value, 'send');
    assert.deepEqual(f.captured.map(input => [input.roomId, input.text]), [['current-room', 'A 原文'], ['other-room', 'B 原文']]);
    const selections = [...f.emitted];
    if (firstSuccess) responses['current-room'].resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ requestId: f.captured[0].requestId }] } });
    else responses['current-room'].reject(new Error('A 原始发送失败 L123'));
    await a;
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.changing.value, 'send'); assert.equal(f.roomBusy('current-room'), false);
    assert.equal(f.roomBusy('other-room'), true); assert.equal(f.draft.value, 'B 原文'); assert.deepEqual(f.recipients.value, ['dev']);
    assert.deepEqual(f.emitted, selections); assert.equal(f.getRoomCache('other-room').room.rounds[0].id, 'round-other-room');
    assert.deepEqual(f.restored, firstSuccess ? [] : [['current-room', { text: 'A 原文', attachments: [{ id: 'attachment' }] }]]);
    if (firstSuccess) assert.equal(f.getRoomCache('current-room').room.rounds[0].requestId, f.captured[0].requestId);
    await f.send(); assert.equal(f.captured.length, 2);
    f.switchRoom('current-room'); await nextTick(); assert.equal(f.changing.value, '');
    responses['other-room'].resolve({ room: { id: 'other-room', cursorTrustPaths: [], rounds: [{ requestId: f.captured[1].requestId }] } }); await b;
    assert.equal(f.selectedId.value, 'current-room'); assert.equal(f.roomBusy('other-room'), false);
    assert.equal(f.getRoomCache('other-room').room.rounds[0].requestId, f.captured[1].requestId);
  } finally { f.close(); }
});

for (const success of [true, false]) test(`新建会话等待${success ? '成功' : '失败'}时空room锁一致，晚回包不抢已选会话`, async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    f.switchRoom(''); await nextTick(); f.draft.value = '新会话原文';
    const sending = f.send(); assert.equal(f.changing.value, 'send'); assert.equal(f.roomBusy(''), true); assert.equal(f.roomBusy('group:new'), true);
    f.switchRoom('other-room'); await nextTick(); assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.changing.value, '');
    f.switchRoom(''); await nextTick(); assert.equal(f.changing.value, 'send'); await f.send(); assert.equal(f.captured.length, 1);
    f.switchRoom('other-room'); await nextTick(); f.draft.value = '其他会话草稿'; f.updateRecipients(['dev']); const selections = [...f.emitted];
    if (success) response.resolve({ room: { id: 'created-room', cursorTrustPaths: [], rounds: [{ requestId: f.captured[0].requestId }] } });
    else response.reject(new Error('新会话发送失败 L123'));
    await sending;
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.draft.value, '其他会话草稿'); assert.deepEqual(f.recipients.value, ['dev']);
    assert.equal(f.roomBusy(''), false); assert.equal(f.roomBusy('group:new'), false); assert.deepEqual(f.emitted, selections);
    assert.deepEqual(f.restored, success ? [] : [['group:new', { text: '新会话原文', attachments: [{ id: 'attachment' }] }]]);
    if (success) assert.equal(f.getRoomCache('created-room').room.id, 'created-room');
  } finally { f.close(); }
});

test('自动续聊已接收但未消费时保留气泡，连续消息分别等候真实记录', async () => {
  const inputs: { requestId: string; processed: boolean }[] = [];
  const f = fixture(undefined, async input => {
    inputs.push({ requestId: input.requestId, processed: false });
    return { room: { id: 'current-room', rounds: [{ requestId: 'previous-round', automatic: { inputs: inputs.map(item => ({ ...item })) } }] } };
  });
  try {
    await f.send(); await f.send();
    assert.equal(f.visiblePendingSends.value.length, 2);
    assert.ok(f.visiblePendingSends.value.every(message => message.accepted));
    f.collaborationMessages.value = [{ role: 'user', text: f.draft.value, createdAt: new Date(Date.now() + 1).toISOString() }];
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'previous-round', automatic: { inputs: inputs.map((item, index) => ({ ...item, processed: index === 0 })) } }] };
    await nextTick();
    assert.deepEqual(f.visiblePendingSends.value.map(message => message.requestId), [inputs[1].requestId]);
    f.collaborationMessages.value = [...f.collaborationMessages.value, { role: 'user', text: f.draft.value, createdAt: new Date(Date.now() + 1).toISOString() }];
    f.room.value = { ...f.room.value, rounds: [{ requestId: 'previous-round', automatic: { inputs: inputs.map(item => ({ ...item, processed: true })) } }] };
    await nextTick();
    assert.equal(f.pendingSends.value.length, 0);
  } finally { f.close(); }
});

test('重新执行等待期间可切房，返回来源房间仍在等待且不会重复派发，迟到结果只写来源缓存', async () => {
  const response = deferred<unknown>();
  const f = fixture(undefined, undefined, undefined, { rerunResponse: () => response.promise });
  try {
    f.room.value = { ...f.room.value, rounds: [{ id: 'round-a', requestId: 'initial-a' }] };
    const pending = f.rerunCollaboration();
    assert.equal(f.changing.value, 'rerun'); assert.equal(f.roomBusy('current-room'), true);
    f.switchRoom('other-room'); await nextTick();
    assert.equal(f.selectedId.value, 'other-room', '重新执行请求不应阻止查看其他群聊');
    assert.equal(f.changing.value, ''); assert.equal(f.roomBusy('other-room'), false);
    f.switchRoom('current-room'); await nextTick();
    assert.equal(f.changing.value, 'rerun'); await f.rerunCollaboration();
    assert.equal(f.rerunCalls.length, 1, '切回来不能重复发起同房间的请求');
    f.switchRoom('other-room'); await nextTick(); f.updateRecipients(['dev']);
    const scrolls = f.scrolls(), selections = [...f.emitted];
    response.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ id: 'rerun-result', requestId: 'result-a' }] } });
    await pending;
    assert.equal(f.selectedId.value, 'other-room'); assert.deepEqual(f.recipients.value, ['dev']);
    assert.equal(f.getRoomCache('current-room').room.rounds[0].id, 'rerun-result');
    assert.equal(f.room.value.id, 'other-room'); assert.equal(f.room.value.rounds[0].id, 'round-other-room');
    assert.deepEqual(f.emitted, selections); assert.equal(f.scrolls(), scrolls); assert.deepEqual(f.successes, []);
    assert.equal(f.roomBusy('current-room'), false); assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

for (const kind of ['pause', 'continue', 'cancel'] as const) {
  test(`${kind} 等待期间可切房，返回原房间仍锁定，迟到回包只更新原房间`, async () => {
    const response = deferred<unknown>();
    const f = fixture(undefined, undefined, undefined, { rerunResponse: () => response.promise });
    try {
      const pending = f.action(kind);
      assert.equal(f.changing.value, kind); assert.equal(f.roomBusy('current-room'), true);
      f.switchRoom('other-room'); await nextTick();
      assert.equal(f.selectedId.value, 'other-room', `${kind} 请求不应阻止查看其他群聊`);
      assert.equal(f.changing.value, ''); assert.equal(f.roomBusy('other-room'), false);
      f.switchRoom('current-room'); await nextTick();
      assert.equal(f.changing.value, kind);
      for (const duplicate of ['pause', 'continue', 'cancel'] as const) await f.action(duplicate);
      assert.deepEqual(f.rerunCalls, [['current-room', kind, kind === 'continue' ? { accessMode: 'full' } : undefined]], '原房间等待期间不重复发送任何团队动作');
      f.switchRoom('other-room'); await nextTick(); f.updateRecipients(['dev']);
      const scrolls = f.scrolls(), selections = [...f.emitted];
      response.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ id: `${kind}-result`, requestId: 'action-result' }] } });
      await pending;
      assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.room.value.id, 'other-room');
      assert.equal(f.room.value.rounds[0].id, 'round-other-room'); assert.deepEqual(f.recipients.value, ['dev']);
      assert.equal(f.getRoomCache('current-room').room.rounds[0].id, `${kind}-result`);
      assert.deepEqual(f.emitted, selections); assert.equal(f.scrolls(), scrolls);
      assert.equal(f.roomBusy('current-room'), false); assert.equal(f.changing.value, ''); assert.deepEqual(f.errors, []);
      f.switchRoom('current-room'); await nextTick();
      assert.equal(f.room.value.rounds[0].id, `${kind}-result`); assert.equal(f.changing.value, '');
    } finally { f.close(); }
  });
}

for (const firstRoom of ['current-room', 'other-room'] as const) for (const firstSuccess of [true, false]) {
  test(`暂停和继续分属两个房间，${firstRoom}先${firstSuccess ? '成功' : '失败'}只释放自己的等待状态`, async () => {
    const responses = { 'current-room': deferred<unknown>(), 'other-room': deferred<unknown>() };
    const f = fixture(undefined, undefined, undefined, { rerunResponse: roomId => responses[roomId as keyof typeof responses].promise });
    try {
      const a = f.action('pause');
      f.switchRoom('other-room'); await nextTick();
      assert.equal(f.selectedId.value, 'other-room');
      const b = f.action('continue');
      assert.deepEqual(f.rerunCalls, [['current-room', 'pause', undefined], ['other-room', 'continue', { accessMode: 'full' }]]);
      assert.equal(f.roomBusy('current-room'), true); assert.equal(f.roomBusy('other-room'), true);
      if (firstSuccess) responses[firstRoom].resolve(f.getRoomCache(firstRoom));
      else responses[firstRoom].reject(new Error(`${firstRoom} 操作失败 L999`));
      await (firstRoom === 'current-room' ? a : b);
      const remainingRoom = firstRoom === 'current-room' ? 'other-room' : 'current-room';
      assert.equal(f.roomBusy(firstRoom), false); assert.equal(f.roomBusy(remainingRoom), true);
      f.switchRoom(remainingRoom); await nextTick();
      assert.equal(f.changing.value, remainingRoom === 'current-room' ? 'pause' : 'continue');
      await f.action('cancel'); assert.equal(f.rerunCalls.length, 2, '另一个房间的等待保护仍然有效');
      responses[remainingRoom].resolve(f.getRoomCache(remainingRoom));
      await (remainingRoom === 'current-room' ? a : b);
      assert.equal(f.roomBusy('current-room'), false); assert.equal(f.roomBusy('other-room'), false); assert.equal(f.changing.value, '');
      assert.deepEqual(f.errors, firstSuccess ? [] : [`${firstRoom} 操作失败 L999`]);
    } finally { f.close(); }
  });
}

test('重试等待期间可切房并找回等待回执，迟到响应保留来源缓存里的最新执行记录', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, undefined, () => response.promise);
  try {
    const pending = f.retryCollaboration();
    f.switchRoom('other-room'); await nextTick();
    assert.equal(f.selectedId.value, 'other-room', '重试请求不应阻止查看其他群聊');
    assert.deepEqual(f.retryReceipt.value, undefined); assert.equal(f.changing.value, '');
    f.switchRoom('current-room'); await nextTick();
    assert.equal(f.readRetryReceipt()?.state, 'sending'); assert.equal(f.changing.value, 'retry');
    await f.retryCollaboration(); assert.equal(f.retryCalls.length, 1);
    f.switchRoom('other-room'); await nextTick();
    f.setTaskCache('team-task', { task: { id: 'team-task', state: 'blocked' }, runs: [{ id: 'polled-after-request' }] });
    const scrolls = f.scrolls(), selections = [...f.emitted];
    response.resolve({ id: 'team-task', state: 'running' }); await pending;
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.collaborationTask.value.id, 'team-other-room');
    assert.equal(f.collaborationTask.value.state, 'blocked'); assert.deepEqual(f.retryReceipt.value, undefined);
    assert.equal(f.getTaskCache('team-task').task.state, 'running');
    assert.deepEqual(f.getTaskCache('team-task').runs, [{ id: 'polled-after-request' }]);
    assert.equal(f.updates[0].updater, true); assert.deepEqual(f.updates[0].key, ['agent-group-chat', 'collaboration', 'team-task']);
    assert.deepEqual(f.emitted, selections); assert.equal(f.scrolls(), scrolls); assert.deepEqual(f.successes, []);
    f.switchRoom('current-room'); await nextTick();
    assert.equal(f.readRetryReceipt()?.state, 'accepted'); assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

for (const first of [
  { roomId: 'other-room', success: true },
  { roomId: 'current-room', success: false },
  { roomId: 'current-room', success: true },
]) {
  test(`两房间并发重试，${first.roomId}先${first.success ? '成功' : '失败'}不清除另一房间的锁或等待回执`, async () => {
    const responses = { 'team-task': deferred<unknown>(), 'team-other-room': deferred<unknown>() };
    const f = fixture(undefined, undefined, taskId => responses[taskId as keyof typeof responses].promise);
    try {
      const a = f.retryCollaboration();
      f.switchRoom('other-room'); await nextTick();
      assert.equal(f.selectedId.value, 'other-room');
      const b = f.retryCollaboration();
      assert.equal(f.retryCalls.length, 2); assert.equal(f.roomBusy('current-room'), true); assert.equal(f.roomBusy('other-room'), true);
      const firstTaskId = first.roomId === 'current-room' ? 'team-task' : 'team-other-room';
      const remainingRoom = first.roomId === 'current-room' ? 'other-room' : 'current-room';
      const remainingTaskId = remainingRoom === 'current-room' ? 'team-task' : 'team-other-room';
      if (first.success) responses[firstTaskId].resolve({ id: firstTaskId, state: 'running' });
      else responses[firstTaskId].reject(new Error(`原文 ${first.roomId} L999`));
      await (first.roomId === 'current-room' ? a : b);
      assert.equal(f.roomBusy(first.roomId), false); assert.equal(f.roomBusy(remainingRoom), true);
      f.switchRoom(remainingRoom); await nextTick();
      assert.equal(f.changing.value, 'retry'); assert.equal(f.retryReceipt.value?.roomId, remainingRoom);
      assert.equal(f.readRetryReceipt()?.state, 'sending');
      await f.retryCollaboration(); assert.equal(f.retryCalls.length, 2);
      if (first.success) responses[remainingTaskId].reject(new Error(`原文 ${remainingRoom} L999`));
      else responses[remainingTaskId].resolve({ id: remainingTaskId, state: 'running' });
      await (remainingRoom === 'current-room' ? a : b);
      assert.equal(f.roomBusy('current-room'), false); assert.equal(f.roomBusy('other-room'), false);
      assert.equal(f.readRetryReceipt()?.state, first.success ? undefined : 'accepted');
      f.switchRoom(first.roomId); await nextTick();
      assert.equal(f.readRetryReceipt()?.state, first.success ? 'accepted' : undefined);
      assert.deepEqual(f.errors, [`原文 ${first.success ? remainingRoom : first.roomId} L999`]);
    } finally { f.close(); }
  });
}

for (const firstSuccess of [true, false]) {
  test(`两房间并发重新执行，后发的房间先${firstSuccess ? '成功' : '失败'}不释放先发房间的锁`, async () => {
    const responses = { 'current-room': deferred<unknown>(), 'other-room': deferred<unknown>() };
    const f = fixture(undefined, undefined, undefined, { rerunResponse: id => responses[id as keyof typeof responses].promise });
    try {
      f.room.value = { ...f.room.value, rounds: [{ id: 'round-a', requestId: 'initial-a' }] };
      const a = f.rerunCollaboration();
      f.switchRoom('other-room'); await nextTick();
      assert.equal(f.selectedId.value, 'other-room');
      const b = f.rerunCollaboration();
      assert.equal(f.rerunCalls.length, 2);
      if (firstSuccess) responses['other-room'].resolve(f.getRoomCache('other-room'));
      else responses['other-room'].reject(new Error('B 重新执行失败 L999'));
      await b;
      assert.equal(f.roomBusy('other-room'), false); assert.equal(f.roomBusy('current-room'), true);
      f.switchRoom('current-room'); await nextTick();
      assert.equal(f.changing.value, 'rerun'); await f.rerunCollaboration(); assert.equal(f.rerunCalls.length, 2);
      if (firstSuccess) responses['current-room'].reject(new Error('A 重新执行失败 L999'));
      else responses['current-room'].resolve(f.getRoomCache('current-room'));
      await a;
      assert.equal(f.changing.value, ''); assert.equal(f.roomBusy('current-room'), false);
      assert.deepEqual(f.errors, [`${firstSuccess ? 'A' : 'B'} 重新执行失败 L999`]);
    } finally { f.close(); }
  });
}

for (const kind of ['rerun', 'retry', 'pause', 'continue', 'cancel'] as const) {
  test(`A 房间 ${kind} 结束时不释放 B 正在发送的锁，也不抢选择和滚动`, async () => {
    const operation = deferred<unknown>(), sending = deferred<unknown>();
    const f = fixture(undefined, () => sending.promise, () => operation.promise, { rerunResponse: () => operation.promise });
    try {
      f.room.value = { ...f.room.value, rounds: [{ id: 'round-a', requestId: 'initial-a' }] };
      const a = kind === 'rerun' ? f.rerunCollaboration() : kind === 'retry' ? f.retryCollaboration() : f.action(kind);
      f.switchRoom('other-room'); await nextTick();
      assert.equal(f.selectedId.value, 'other-room');
      const b = f.send(); await nextTick();
      assert.equal(f.globalChanging.value, ''); assert.equal(f.roomBusy('other-room'), true); const scrolls = f.scrolls(), selections = [...f.emitted];
      operation.resolve(kind === 'retry' ? { id: 'team-task', state: 'running' } : f.getRoomCache('current-room'));
      await a;
      assert.equal(f.globalChanging.value, ''); assert.equal(f.changing.value, 'send'); assert.equal(f.roomBusy('other-room'), true);
      assert.equal(f.selectedId.value, 'other-room'); assert.deepEqual(f.emitted, selections); assert.equal(f.scrolls(), scrolls);
      f.switchRoom('third-room'); assert.equal(f.selectedId.value, 'third-room', 'B 的发送等待不阻止浏览 C');
      assert.equal(f.roomBusy('other-room'), true);
      sending.resolve({ room: { ...f.getRoomCache('other-room').room, rounds: [{ requestId: f.captured[0].requestId }] } }); await b;
      assert.equal(f.selectedId.value, 'third-room'); assert.equal(f.roomBusy('other-room'), false);
      assert.equal(f.globalChanging.value, ''); assert.equal(f.changing.value, '');
    } finally { f.close(); }
  });
}

test('等待 nextTick 的旧房间滚动不会操作新房间或替换后的 DOM', async () => {
  const tick = deferred<void>(), f = fixture(undefined, undefined, undefined, { scrollTick: () => tick.promise });
  try {
    const oldRoomScroll = f.scrollPinnedResult();
    f.switchRoom('other-room');
    const replacedDomScroll = f.scrollPinnedResult();
    f.viewport.value = f.makeViewport('replacement');
    tick.resolve(); await Promise.all([oldRoomScroll, replacedDomScroll]);
    assert.deepEqual(f.scrollWrites, [], '房间切换和 DOM 替换都应使已排队的滚动失效');
    await f.scrollPinnedResult(); assert.deepEqual(f.scrollWrites, [{ roomId: 'replacement', top: 1000 }]);
  } finally { f.close(); }
});


for (const kind of ['resume-login', 'fallback', 'trust', 'retry-member'] as const) test(`${kind} 等待可切房，晚回包仅更新来源房间且不解除另一房间操作`, async () => {
  const aResponse = deferred<unknown>(), bResponse = deferred<unknown>();
  const f = fixture(undefined, undefined, undefined, { operationResponse: () => aResponse.promise, rerunResponse: () => bResponse.promise });
  const invoke = () => kind === 'resume-login' ? f.resumeLogin() : kind === 'fallback' ? f.fallbackTurn({ id: 'turn-A', runId: 'run-A' }) : kind === 'retry-member' ? f.retryTurn({ id: 'turn-A' }) : f.trustTurn({ id: 'turn-A' });
  try {
    const a = invoke(); assert.equal(f.roomBusy('current-room'), true);
    await invoke(); assert.equal(f.operationCalls.length, 1);
    f.switchRoom('other-room'); await nextTick(); assert.equal(f.selectedId.value, 'other-room');
    const b = f.action('pause'); assert.equal(f.changing.value, 'pause');
    aResponse.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ id: `${kind}-completed`, requestId: 'done' }] } }); await a;
    assert.equal(f.room.value.id, 'other-room'); assert.equal(f.changing.value, 'pause'); assert.equal(f.roomBusy('other-room'), true);
    assert.equal(f.roomBusy('current-room'), false); assert.equal(f.getRoomCache('current-room').room.rounds[0].id, `${kind}-completed`);
    assert.equal(f.operationCalls[0][1], 'current-room');
    if (kind === 'retry-member') assert.deepEqual(f.operationCalls[0], ['retry-member', 'current-room', { turnId: 'turn-A', runId: 'cursor-run', accessMode: 'full' }]);
    bResponse.resolve(f.getRoomCache('other-room')); await b; assert.equal(f.changing.value, '');
  } finally { f.close(); }
});

test('成员重试失败保留原执行记录、原样提示错误并释放按钮等待状态', async () => {
  const f = fixture(undefined, undefined, undefined, { operationResponse: async () => { throw new Error('重试仍受阻 L001'); } });
  try {
    const before = f.getRoomCache('current-room');
    await f.retryTurn({ id: 'turn-A' });
    assert.deepEqual(f.errors, ['重试仍受阻 L001']); assert.equal(f.changing.value, '');
    assert.equal(f.getRoomCache('current-room'), before); assert.equal(f.updates.length, 0);
  } finally { f.close(); }
});

for (const leave of ['another-room', 'inactive'] as const) test(`编辑前暂停消息回包晚到，${leave}时不弹出原消息编辑框`, async () => {
  const response = deferred<unknown>(), f = fixture(undefined, undefined, undefined, { operationResponse: () => response.promise });
  try {
    const editing = f.editMessage('message-A', 'A 原消息', ['file-A']);
    if (leave === 'another-room') { f.switchRoom('other-room'); await nextTick(); assert.equal(f.selectedId.value, 'other-room'); }
    else f.active.value = false;
    response.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ id: 'paused-for-edit', requestId: 'done' }] } }); await editing;
    assert.equal(f.editingMessage.value, undefined); assert.equal(f.getRoomCache('current-room').room.rounds[0].id, 'paused-for-edit');
    assert.equal(f.roomBusy('current-room'), false);
  } finally { f.close(); }
});

test('旧消息修订保存晚回包不关闭新编辑框、不滚动新房间', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, undefined, undefined, { operationResponse: () => response.promise });
  try {
    f.editingMessage.value = { roomId: 'current-room', id: 'message-A', attachmentIds: [] }; f.editObjective.value = 'A 修改';
    const saving = f.saveEditedMessage(); await f.saveEditedMessage(); assert.equal(f.operationCalls.length, 1);
    f.switchRoom('other-room'); await nextTick(); assert.equal(f.selectedId.value, 'other-room');
    const next = { roomId: 'other-room', id: 'message-B', attachmentIds: ['file-B'] }; f.editingMessage.value = next; f.editObjective.value = 'B 草稿';
    const scrolls = f.scrolls();
    response.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ id: 'revised-A', requestId: 'done' }] } }); await saving;
    assert.equal(f.editingMessage.value, next); assert.equal(f.editObjective.value, 'B 草稿'); assert.equal(f.scrolls(), scrolls);
    assert.equal(f.getRoomCache('current-room').room.rounds[0].id, 'revised-A'); assert.equal(f.roomBusy('current-room'), false);
  } finally { f.close(); }
});

test('团队组件隐藏期间保留请求状态且不滚动已隐藏的DOM', async () => {
  const response = deferred<unknown>(), f = fixture(undefined, () => response.promise);
  try {
    const sending = f.send(); await nextTick(); f.active.value = false; const scrolls = f.scrolls();
    await f.scrollPinnedResult(); assert.equal(f.scrolls(), scrolls);
    response.resolve({ room: { id: 'current-room', cursorTrustPaths: [], rounds: [{ requestId: f.captured[0].requestId }] } }); await sending;
    assert.equal(f.roomBusy('current-room'), false); assert.equal(f.scrolls(), scrolls);
    f.active.value = true; await f.scrollPinnedResult(); assert.equal(f.scrolls(), scrolls + 1);
  } finally { f.close(); }
});

test('父级记录隐藏团队会话的晚回包但不切走普通会话或工作台', () => {
  const source = readFileSync(process.env.AGENT_RUNTIME_PANEL_TEST_SOURCE || new URL('../src/features/agent-workbench/AgentRuntimePanel.vue', import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('panel.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'selectGroup')!;
  const code = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const groupRoomId = shallowRef('before'), groupMode = shallowRef(false), props = { workbenchOpen: false }, emitted: unknown[][] = [];
  const select = new Function('groupRoomId', 'groupMode', 'props', 'emit', `${code}; return selectGroup;`)(groupRoomId, groupMode, props, (...args: unknown[]) => emitted.push(args));
  select('created-while-hidden'); assert.equal(groupRoomId.value, 'created-while-hidden'); assert.deepEqual(emitted, []);
  groupMode.value = true; props.workbenchOpen = true;
  select('updated-in-workbench'); assert.equal(groupRoomId.value, 'updated-in-workbench'); assert.deepEqual(emitted, []);
  props.workbenchOpen = false; select('visible-room'); assert.deepEqual(emitted, [['group', 'visible-room']]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowRef, watch, type ShallowRef } from 'vue';

type Target = { taskId: string; questionId: string };
type Draft = { text: string; attachments: { id: string }[] };
function fixture(response?: (taskId: string) => Promise<unknown>) {
  const source = readFileSync(process.env.AGENT_GROUP_CHAT_TEST_SOURCE || new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('group.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['active', 'globalChanging', 'roomActions', 'changing', 'draftKey', 'canSend'];
  const functions = ['send', 'sendQuestionReply', 'switchRoom', 'roomBusy', 'beginRoomAction'];
  const pieces = tree.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
      .filter(declaration => names.includes(declaration.name.getText(tree))).map(declaration => `const ${declaration.getText(tree)};`);
    if (ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text || '')) return [statement.getText(tree)];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(tree) === 'watch'
      && statement.expression.arguments[0]?.getText(tree) === 'selectedId' && statement.getText(tree).includes('questionTarget')) return [statement.getText(tree)];
    return [];
  });
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const selectedId = shallowRef('original-room'), questionTarget = shallowRef<Target | undefined>({ taskId: 'original-task', questionId: 'original-question' });
  const questionReply = shallowRef({ state: 'pending' }), draft = shallowRef('问题的精确答复'), attachments = shallowRef([{ id: 'file-1' }]);
  const accessMode = shallowRef<'workspace' | 'full'>('full');
  const calls: unknown[][] = [], errors: string[] = [], restored: unknown[] = [], emitted: unknown[][] = [], updates: unknown[][] = [], requestIds = new Map<string, string>();
  const savedDrafts = new Map<string, Draft>(), cache = new Map<string, unknown>();
  let clears = 0, fail = false, requests = 0;
  const dependencies = { computed, shallowRef, watch, selectedId, questionTarget, questionReply, draft, attachments, accessMode, files: { pending: shallowRef(false) }, requestIds,
    targetMembers: shallowRef([]),
    drafts: {
      clear: (key: string) => { clears++; const sent = { text: draft.value, attachments: [...attachments.value] }; savedDrafts.set(key, { text: '', attachments: [] }); draft.value = ''; attachments.value = []; return sent; },
      restore: (key: string, sent: Draft) => { restored.push([key, sent]); savedDrafts.set(key, sent); if ((selectedId.value || 'group:new') === key) { draft.value = sent.text; attachments.value = sent.attachments; } },
    },
    createRequestId: () => ++requests === 1 ? 'stable-request' : `stable-request-${requests}`,
    answerTeamMessage: async (taskId: string, ...args: unknown[]) => { calls.push([taskId, ...args]); if (fail) throw new Error('原始失败 L123'); return response ? response(taskId) : { task: { id: taskId, state: 'running' } }; },
    client: { setQueryData: (key: unknown[], value: unknown) => { updates.push([key, value]); cache.set(JSON.stringify(key), value); } },
    scope: ['test-group'], refresh: () => {}, ElMessage: { error: (text: string) => errors.push(text) },
    narrowSidebarOpen: shallowRef(false), detailsCollapsed: shallowRef(false), workspaceExpanded: shallowRef(false), creating: shallowRef(false), recipients: shallowRef(['all']),
    window: { matchMedia: () => ({ matches: false }) }, emit: (...args: unknown[]) => emitted.push(args),
  };
  const effect = effectScope();
  const state = effect.run(() => {
    watch(selectedId, (id, previous) => {
      savedDrafts.set(previous || 'group:new', { text: draft.value, attachments: [...attachments.value] });
      const saved = savedDrafts.get(id || 'group:new') || { text: '', attachments: [] };
      draft.value = saved.text; attachments.value = saved.attachments;
    }, { flush: 'sync' });
    return new Function(...Object.keys(dependencies), `${code}; return { send, canSend, switchRoom, changing, globalChanging, roomBusy };`)(...Object.values(dependencies));
  }) as { send(): Promise<void>; canSend: Readonly<ShallowRef<boolean>>; switchRoom(id: string): void; changing: Readonly<ShallowRef<string>>; globalChanging: ShallowRef<string>; roomBusy(id: string): boolean };
  return { ...state, calls, errors, restored, questionTarget, questionReply, requestIds, selectedId, draft, attachments, accessMode, emitted, updates,
    getTaskCache: (taskId: string) => cache.get(JSON.stringify(['test-group', 'collaboration', taskId])),
    getDraft: (roomId: string) => savedDrafts.get(roomId), clears: () => clears, fail: (value: boolean) => { fail = value; }, close: () => effect.stop() };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const accessMode of ['workspace', 'full'] as const) test(`群聊收件人为空时仍可回复原任务的问题并沿用 ${accessMode} 权限`, async () => {
  const f = fixture();
  try {
    f.accessMode.value = accessMode;
    assert.equal(f.canSend.value, true);
    await f.send();
    assert.deepEqual(f.calls, [['original-task', { correlationId: 'original-question', text: '问题的精确答复', attachmentIds: ['file-1'], requestId: 'stable-request', accessMode }]]);
    assert.equal(f.questionTarget.value, undefined); assert.equal(f.requestIds.size, 0); assert.equal(f.changing.value, '');
  } finally { f.close(); }
});
test('问题答复迟到时不清除用户新选中的另一个问题', async () => {
  const response = deferred<unknown>(), f = fixture(() => response.promise);
  try {
    const sending = f.send();
    const nextTarget = { taskId: 'other-task', questionId: 'other-question' };
    f.questionTarget.value = nextTarget;
    response.resolve({ task: { id: 'original-task' } }); await sending;
    assert.equal(f.questionTarget.value, nextTarget); assert.equal(f.calls[0][0], 'original-task');
  } finally { f.close(); }
});
test('过期问题不发送、不清除草稿；失败保留内容和原请求标识供重试', async () => {
  const f = fixture();
  try {
    f.questionReply.value = { state: 'expired' }; await f.send();
    assert.equal(f.calls.length, 0); assert.equal(f.clears(), 0);
    f.questionReply.value = { state: 'pending' }; f.fail(true); await f.send();
    assert.equal(f.restored.length, 1); assert.equal(f.requestIds.size, 1); assert.equal(f.questionTarget.value?.questionId, 'original-question');
    assert.equal(f.errors.at(-1), '原始失败 L123');
    f.fail(false); await f.send(); assert.deepEqual(f.calls[0], f.calls[1]);
  } finally { f.close(); }
});

for (const firstSuccess of [true, false]) test(`问题答复等待可切房并发回复，原房间${firstSuccess ? '成功' : '失败'}不影响当前房间`, async () => {
  const responses = { 'original-task': deferred<unknown>(), 'other-task': deferred<unknown>() };
  const f = fixture(taskId => responses[taskId as keyof typeof responses].promise);
  try {
    const a = f.send(); assert.equal(f.changing.value, 'send'); assert.equal(f.roomBusy('original-room'), true);
    f.draft.value = '不能重复发送'; await f.send(); assert.equal(f.calls.length, 1);
    f.switchRoom('other-room'); await nextTick(); assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.changing.value, '');
    f.questionTarget.value = { taskId: 'other-task', questionId: 'other-question' }; f.draft.value = 'B 精确答复'; f.attachments.value = [{ id: 'file-B' }];
    const b = f.send(); assert.equal(f.calls.length, 2); assert.equal(f.changing.value, 'send');
    const nextTarget = { taskId: 'other-task', questionId: 'new-question' }; f.questionTarget.value = nextTarget; f.draft.value = 'B 新草稿';
    const selections = [...f.emitted], originalResult = { task: { id: 'original-task', state: 'running' } };
    if (firstSuccess) responses['original-task'].resolve(originalResult); else responses['original-task'].reject(new Error('A 答复失败 L999'));
    await a;
    assert.equal(f.selectedId.value, 'other-room'); assert.equal(f.questionTarget.value, nextTarget); assert.equal(f.draft.value, 'B 新草稿');
    assert.equal(f.changing.value, 'send'); assert.equal(f.roomBusy('original-room'), false); assert.equal(f.roomBusy('other-room'), true);
    assert.deepEqual(f.emitted, selections); assert.equal(f.getTaskCache('other-task'), undefined);
    assert.deepEqual(f.getTaskCache('original-task'), firstSuccess ? originalResult : undefined);
    assert.deepEqual(f.restored, firstSuccess ? [] : [['original-room', { text: '问题的精确答复', attachments: [{ id: 'file-1' }] }]]);
    if (!firstSuccess) assert.equal(f.getDraft('original-room')?.text, '问题的精确答复');
    await f.send(); assert.equal(f.calls.length, 2);
    f.switchRoom('original-room'); await nextTick(); assert.equal(f.changing.value, '');
    const otherResult = { task: { id: 'other-task', state: 'running' } }; responses['other-task'].resolve(otherResult); await b;
    assert.equal(f.selectedId.value, 'original-room'); assert.equal(f.roomBusy('other-room'), false); assert.deepEqual(f.getTaskCache('other-task'), otherResult);
    assert.deepEqual(f.calls[1], ['other-task', { correlationId: 'other-question', text: 'B 精确答复', attachmentIds: ['file-B'], requestId: 'stable-request-2', accessMode: 'full' }]);
  } finally { f.close(); }
});

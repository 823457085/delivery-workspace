import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceActionExecutor } from '../src/shared/source-action.js';

function setup(options: { confirm?: () => Promise<boolean>; send?: (key: string, body: string) => Promise<Response>; refresh?: () => Promise<unknown> } = {}) {
  const sends: string[] = [], events: string[] = [];
  const execute = createSourceActionExecutor({
    confirm: options.confirm ?? (async () => true),
    send: async (key, body) => { sends.push(body); return options.send ? options.send(key, body) : Response.json({ message: '已接受' }); },
    refresh: async () => { events.push('refresh'); return options.refresh?.(); },
    success: (message) => events.push(`success:${message}`), error: (message) => events.push(`error:${message}`),
    pending: (value) => events.push(`pending:${value}`),
  });
  const run = (data: unknown = {}) => execute('merge-action', data, '确认审核', '真实影响');
  return { run, sends, events };
}

test('cancel produces no write or refresh and releases the confirmation lock', async () => {
  const { run, sends, events } = setup({ confirm: async () => false });
  assert.equal(await run(), false); assert.equal(await run(), false);
  assert.deepEqual(sends, []); assert.deepEqual(events, ['pending:true', 'pending:false', 'pending:true', 'pending:false']);
});
test('double-click is ignored during confirmation and request; payload is the pre-confirmation snapshot', async () => {
  let confirm!: (value: boolean) => void, respond!: (value: Response) => void;
  const confirmation = new Promise<boolean>((resolve) => { confirm = resolve; });
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const { run, sends, events } = setup({ confirm: () => confirmation, send: () => response });
  const data = { expectedRevision: 1, requirementId: 'REQ-027' };
  const first = run(data); data.expectedRevision = 2;
  assert.equal(await run(data), false);
  confirm(true); await Promise.resolve();
  assert.equal(await run(data), false);
  respond(Response.json({ message: '已接受' }));
  assert.equal(await first, true);
  assert.deepEqual(sends, ['{"expectedRevision":1,"requirementId":"REQ-027"}']);
  assert.deepEqual(events, ['pending:true', 'success:已接受', 'refresh', 'pending:false']);
});
test('409 refreshes revisions but never retries the rejected approval automatically', async () => {
  const { run, sends, events } = setup({ send: async () => Response.json({ error: 'Catchup state changed, refresh and retry' }, { status: 409 }) });
  assert.equal(await run({ expectedRevision: 1 }), false);
  assert.equal(sends.length, 1); assert.equal(events.filter((event) => event === 'refresh').length, 1);
  assert.match(events[1], /Catchup state changed/); assert.equal(events.at(-1), 'pending:false');
});
test('business errors stay failures, release the lock and preserve server details', async () => {
  const { run, sends, events } = setup({ send: async () => Response.json({ error: 'rejected', details: '证据不完整' }, { status: 400 }) });
  assert.equal(await run(), false); assert.equal(await run(), false);
  assert.equal(sends.length, 2); assert.ok(events.includes('error:证据不完整')); assert.ok(!events.includes('refresh'));
});
test('network failure is ambiguous, not falsely reported as a safe failed write', async () => {
  const { run, sends, events } = setup({ send: async () => { throw new Error('连接断开'); } });
  assert.equal(await run(), false); assert.equal(sends.length, 1);
  assert.ok(events.some((event) => event.includes('执行结果未确认'))); assert.ok(!events.some((event) => event.startsWith('success:')));
});
test('successful write followed by failed refresh remains successful and warns against duplicate submission', async () => {
  const { run, sends, events } = setup({ refresh: async () => { throw new Error('offline'); } });
  assert.equal(await run(), true); assert.equal(sends.length, 1);
  assert.ok(events.includes('success:已接受')); assert.ok(events.some((event) => event.includes('不要重复提交')));
});

test('snapshot responses keep feedback in the current panel without claiming merge completion', async () => {
  const { run, sends, events } = setup({ send: async () => Response.json({ revision: 1397, items: [{ requirementId: 'REQ-008', status: 'QUEUED' }] }) });
  assert.equal(await run({ requirementId: 'REQ-008', action: 'direct-merge' }), true);
  assert.deepEqual(events, ['pending:true', 'success:操作已受理，请在当前面板查看最新状态', 'refresh', 'pending:false']);
  assert.equal(sends.length, 1);
  assert.ok(!events.some((event) => /原系统|已经合入|已合入/.test(event)));
});

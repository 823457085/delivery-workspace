#!/usr/bin/env node
// A protocol peer: one turn only, responds to steering without finishing/restarting it.
import { createInterface } from 'node:readline';
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = 'thread-live-test';
let started = false;
let unarchived = false;
const requests = [];
const recoverableId = '11111111-1111-1111-1111-111111111111';
const rejectedId = '22222222-2222-2222-2222-222222222222';
const busyId = '33333333-3333-3333-3333-333333333333';
const wrongId = '44444444-4444-4444-4444-444444444444';
const wrongRestoreId = '55555555-5555-5555-5555-555555555555';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return output({ id, result: {} });
  if (method?.startsWith('thread/') || method === 'turn/start') requests.push(method);
  if (method === 'thread/unarchive') {
    if (params.threadId === rejectedId) return output({ id, error: { message: 'restore denied' } });
    if (params.threadId === wrongRestoreId) return output({ id, result: { thread: { id: recoverableId } } });
    if (params.threadId !== recoverableId) return output({ id, error: { message: 'unexpected unarchive' } });
    unarchived = true;
    return output({ id, result: { thread: { id: recoverableId } } });
  }
  if (method === 'thread/resume') {
    if ([recoverableId, rejectedId, wrongRestoreId].includes(params.threadId) && !unarchived) {
      return output({ id, error: { message: `session ${params.threadId} is archived. Run codex unarchive first` } });
    }
    if (params.threadId === busyId) return output({ id, error: { message: `thread ${busyId} already has an active writer` } });
    if (params.threadId === wrongId) return output({ id, error: { message: `session ${recoverableId} is archived` } });
  }
  if (method === 'thread/fork' && params.lastTurnId === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') {
    return output({ id, result: { cwd: params.cwd, thread: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      turns: [{ id: params.lastTurnId }] } } });
  }
  if (method === 'thread/fork' && params.lastTurnId === 'cccccccc-cccc-cccc-cccc-cccccccccccc') {
    return output({ id, result: { cwd: params.cwd, thread: { id: params.threadId, turns: [{ id: params.lastTurnId }] } } });
  }
  if (method === 'thread/fork' && params.lastTurnId === 'dddddddd-dddd-dddd-dddd-dddddddddddd') {
    return output({ id, result: { cwd: params.cwd, thread: { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', turns: [] } } });
  }
  if (method?.startsWith('thread/')) {
    threadId = method === 'thread/resume' ? params.threadId : 'thread-live-test';
    return output({ id, result: { thread: { id: threadId } } });
  }
  if (method === 'turn/start') {
    if (threadId === recoverableId) {
      output({ id, result: { turn: { id: 'turn-live-test' } } });
      output({ method: 'turn/started', params: { threadId, turn: { id: 'turn-live-test' } } });
      output({ method: 'item/completed', params: { threadId, turnId: 'turn-live-test', item: { type: 'agentMessage', text: JSON.stringify({ threadId, requests }) } } });
      output({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-live-test', status: 'completed' } } });
      return;
    }
    if (params.input[0].text === 'writer-busy') {
      return output({ id, error: { message: 'thread 12345678-1234-1234-1234-123456789abc already has an active writer' } });
    }
    if (started) throw new Error('Unexpected second turn');
    started = true;
    output({ id, result: { turn: { id: 'turn-live-test' } } });
    output({ method: 'turn/started', params: { threadId, turn: { id: 'turn-live-test' } } });
    if (params.input[0].text === 'speed-tier-test') {
      output({ method: 'item/completed', params: { threadId, turnId: 'turn-live-test', item: {
        type: 'agentMessage', text: JSON.stringify({ args: process.argv.slice(2) }),
      } } });
      output({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-live-test', status: 'completed' } } });
      return;
    }
    if (params.input[0].text === 'stream-test') {
      output({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', turnId: 'turn-live-test', itemId: 'a', delta: '不要显示' } });
      output({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'old-turn', itemId: 'a', delta: '不要显示' } });
      for (const delta of ['第一段 ', '\n继续']) output({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-live-test', itemId: 'a', delta } });
      output({ method: 'item/completed', params: { threadId, turnId: 'turn-live-test', item: { id: 'a', type: 'agentMessage', text: '第一段 \n继续' } } });
      output({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-live-test', itemId: 'b', delta: '最终' } });
    }
    return;
  }
  if (method === 'turn/steer') {
    if (!started || params.expectedTurnId !== 'turn-live-test') throw new Error('Wrong turn');
    if (params.input[0].text === 'reject') return output({ id, error: { message: 'turn already completed' } });
    if (params.input[0].text !== 'completion-before-ack') output({ id, result: { turnId: 'turn-live-test' } });
    output({ method: 'item/completed', params: { threadId, turnId: 'turn-live-test', item: { type: 'agentMessage', text: JSON.stringify(params) } } });
    setTimeout(() => output({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-live-test', status: 'completed' } } }), 20);
    if (params.input[0].text === 'completion-before-ack') setTimeout(() => output({ id, result: { turnId: 'turn-live-test' } }), 40);
  }
});

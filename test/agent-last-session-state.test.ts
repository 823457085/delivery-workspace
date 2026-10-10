import assert from 'node:assert/strict';
import test from 'node:test';
import { LAST_AGENT_SESSION_STORAGE_KEY, parseLastAgentSessionId, readLastAgentSessionId,
  saveLastAgentSessionId } from '../src/features/agent-workbench/last-session-state.js';

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('last opened Agent conversation can be restored after refresh', () => {
  const storage = createStorage();
  assert.equal(saveLastAgentSessionId(storage, 'conversation-a'), true);
  assert.equal(readLastAgentSessionId(storage), 'conversation-a');
  assert.equal(storage.values.get(LAST_AGENT_SESSION_STORAGE_KEY), 'conversation-a');
});

test('opening a new conversation clears the remembered conversation', () => {
  const storage = createStorage();
  saveLastAgentSessionId(storage, 'conversation-a');
  assert.equal(saveLastAgentSessionId(storage, ''), true);
  assert.equal(readLastAgentSessionId(storage), '');
  assert.equal(storage.values.has(LAST_AGENT_SESSION_STORAGE_KEY), false);
});

test('invalid or unavailable browser storage does not block the workbench', () => {
  assert.equal(parseLastAgentSessionId('  conversation-a  '), 'conversation-a');
  assert.equal(parseLastAgentSessionId(null), '');
  assert.equal(readLastAgentSessionId({ getItem: () => { throw new Error('denied'); } }), '');
  assert.equal(saveLastAgentSessionId({ setItem: () => { throw new Error('denied'); }, removeItem: () => {} }, 'conversation-a'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createRequestId } from '../src/features/requirement-development/request-id.js';

test('HTTP clients without randomUUID still generate valid, distinct request IDs for the server contract', () => {
  const insecureContext = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const ids = Array.from({ length: 100 }, () => createRequestId(insecureContext));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(z.uuidv4().safeParse(id).success, true);
  }
});

test('secure clients retain the native UUID implementation', () => {
  const native = 'f591acdb-4d0a-40db-ae58-4249a11bb8ce';
  assert.equal(createRequestId({ randomUUID: () => native, getRandomValues: () => { throw new Error('fallback not needed'); } }), native);
});

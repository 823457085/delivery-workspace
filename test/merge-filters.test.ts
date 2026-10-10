import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeItemGroup } from '../src/features/catchup/domain.js';

test('pending excludes normal completion, exception completion and requirements outside Admin scope', () => {
  for (const status of ['APPROVED', 'EXCEPTION_MERGED']) {
    assert.equal(mergeItemGroup({ status, gitStatus: 'MERGED' }), 'completed');
    assert.equal(mergeItemGroup({ status, gitStatus: 'READY' }), 'completed');
  }
  assert.equal(mergeItemGroup({ status: 'HOLD', gitStatus: 'HOLD' }), 'excluded');
  assert.equal(mergeItemGroup({ status: 'APPROVED', gitStatus: 'HOLD' }), 'excluded');
});

test('pending retains unmerged work but excludes code already in target without changing review status', () => {
  for (const status of ['BLOCKED', 'AWAITING_REVIEW', 'PENDING', 'QUEUED', 'DISPATCHING', 'RUNNING', 'UNRECOGNIZED']) {
    assert.equal(mergeItemGroup({ status, gitStatus: 'READY' }), 'pending');
    assert.equal(mergeItemGroup({ status, gitStatus: 'MERGED' }), 'completed');
  }
});

test('quick views partition all records without mutating their original state', () => {
  const items = Object.freeze([
    Object.freeze({ status: 'BLOCKED', gitStatus: 'READY' }),
    Object.freeze({ status: 'BLOCKED', gitStatus: 'MERGED' }),
    Object.freeze({ status: 'APPROVED', gitStatus: 'MERGED' }),
    Object.freeze({ status: 'EXCEPTION_MERGED', gitStatus: 'READY' }),
    Object.freeze({ status: 'HOLD', gitStatus: 'HOLD' }),
  ]);
  const before = JSON.stringify(items);
  const groups = ['pending', 'completed', 'excluded'].map((group) => items.filter((item) => mergeItemGroup(item) === group));
  assert.deepEqual(groups.map((group) => group.length), [1, 3, 1]);
  assert.equal(groups.flat().length, items.length);
  assert.equal(JSON.stringify(items), before);
});

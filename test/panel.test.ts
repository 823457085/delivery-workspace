import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceRoute, READ_ROUTES, WRITE_ROUTES } from '../server/source-proxy.js';
import { catchupQueue, screenshotGroups } from '../src/features/catchup/domain.js';
import { statusTone, safeUrl } from '../src/shared/format.js';
import type { CatchupData, MergeData, MergeItem } from '../shared/hub.js';

test('all read mappings are fixed local paths; arbitrary/prototype/method routes fail closed', () => {
  for (const [key, path] of Object.entries(READ_ROUTES)) { assert.equal(resolveSourceRoute(key, 'GET'), path); assert.match(path, /^\/(api\/|meeting-snapshot\.json)/); }
  for (const key of ['https://evil.test/', '../settings', '__proto__', 'constructor', 'toString']) assert.throws(() => resolveSourceRoute(key, 'GET'));
  assert.throws(() => resolveSourceRoute('issues', 'DELETE', true));
  assert.throws(() => resolveSourceRoute('issues', 'POST', true));
});

test('every original-system write requires explicit confirmation without making network requests', () => {
  for (const [key, path] of Object.entries(WRITE_ROUTES)) {
    assert.throws(() => resolveSourceRoute(key, 'POST'), /必须先确认/);
    assert.equal(resolveSourceRoute(key, 'POST', true), path);
  }
});

test('catchup stage aggregation retains two entries per requirement and excludes review/history/scope exclusions', () => {
  const board = { requirements: [
    { id: 'REQ-001', title: '测试需求', execution: { exclusionReason: '' }, session: { status: 'running', workspacePath: '/demo/source', branch: 'feature/demo', threadId: 'execution-id' } },
    { id: 'REQ-002', execution: { exclusionReason: '' }, session: { status: 'completed' } },
    { id: 'REQ-003', execution: { exclusionReason: '不属于 Admin' }, session: { status: 'queued' } },
  ] } as CatchupData;
  const merge = { target: { branch: 'feature/target' }, items: [
    { requirementId: 'REQ-001', title: '测试需求', status: 'PENDING', order: 1, pipeline: { phase: 'delivery', threadId: 'merge-id' } },
    { requirementId: 'REQ-004', status: 'AWAITING_REVIEW', pipeline: {} },
    { requirementId: 'REQ-005', status: 'BLOCKED', pipeline: {} },
  ] } as MergeData;
  const queue = catchupQueue(board, merge);
  assert.deepEqual(queue.map((item) => item.key), ['execution:REQ-001', 'merge:REQ-001']);
  assert.equal(queue[1].stage, 'Git 交付');
  assert.equal(queue[1].status, 'queued');
  assert.equal(queue[1].workspace, '统一目标 worktree');
  assert.equal(queue[1].branch, 'feature/target');
  assert.equal(catchupQueue().length, 0);
});

test('authentication images are excluded and supplementary screenshots never become submitted review evidence', () => {
  const item = { pipeline: { evidence: { screenshots: [ { filename: 'valid.png' }, { filename: 'invalid.png' } ] } },
    executionScreenshots: [ { filename: 'valid.png' }, { filename: 'login.png', isAuthentication: true }, { filename: 'extra.png' } ],
    reviewGate: { invalidScreenshotNames: ['invalid.png'] } } as MergeItem;
  const groups = screenshotGroups(item);
  assert.deepEqual(groups.submitted.map((shot) => shot.filename), ['valid.png']);
  assert.deepEqual(groups.supplementary.map((shot) => shot.filename), ['extra.png']);
  assert.deepEqual(groups.excluded.map((shot) => shot.filename), ['invalid.png', 'login.png']);
});

test('status presentation does not color NOT_MERGED as success and rejects script links', () => {
  assert.equal(statusTone('NOT_MERGED'), 'info');
  assert.equal(statusTone('MERGED'), 'success');
  assert.equal(statusTone('AWAITING_REVIEW'), 'warning');
  assert.equal(statusTone('N/A'), 'warning');
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('https://example.com/test'), 'https://example.com/test');
});

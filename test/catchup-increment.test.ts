import test from 'node:test';
import assert from 'node:assert/strict';
import type { CatchupData, CatchupRequirement } from '../shared/hub';
import { displayCatchupBoard, readCatchupIncrement, type CatchupIncrement } from '../src/features/catchup/increment';
import { catchupQueue } from '../src/features/catchup/domain';

const increment: CatchupIncrement = {
  groupCount: 2,
  baseline: { sourceBase: 'source-fixture', target: 'target-fixture', generatedAt: '2026-10-01T00:00:00.000Z' },
  requirements: [
    { id: 'REQ-930-001', title: '示例查询条件', domain: '示例业务', category: '查询', description: '接口文案 L1001 原样展示',
      demoState: '待核验', acceptance: ['查询参数保持一致', '保留空态'], issues: ['DEMO-101'], evidence: [], commits: [] },
    { id: 'REQ-930-002', title: '示例详情字段', domain: '示例业务', category: '详情', description: '显示已确认字段',
      demoState: '待核验', acceptance: ['详情字段原样展示'], issues: ['DEMO-102'], evidence: [], commits: [] },
  ],
  sourceConflicts: [
    { issue: 'DEMO-101', title: '字段口径', requirement: '使用确认后的字段', source: 'L1001  原始文本', decision: '待确认' },
    { issue: 'DEMO-102', title: '展示范围', requirement: '详情内展示', source: '示例来源说明', decision: '待确认' },
  ],
};
function frozenBoard(): CatchupData {
  const requirement: CatchupRequirement = {
    id: 'REQ-001', title: '历史需求', slug: 'history', goal: '保留历史状态', businessDomain: '支付、订单与财务', wave: '第 1 波',
    deliveryStatus: 'READY', pageStatus: 'READY', demoApiStatus: 'READY', gap: '', nextAction: '已有下一步',
    acceptanceCriteria: [{ id: 'AC-1', text: '历史标准' }], acceptanceCriteriaCount: 1, workPackageCount: 1,
    readinessGaps: [], deliveryFollowups: [], execution: { status: 'IN_PROGRESS', exclusionReason: '', allowedActions: ['pause'], updatedAt: '', startedAt: '' },
    session: { status: 'running', jiraKey: 'DEMO-001', jiraUrl: '', threadId: 'existing-thread', branch: 'existing-branch', workspacePath: '/existing', result: '历史结果', error: '', updatedAt: '' },
  };
  return { source: { integrity: 'VERIFIED', updatedAt: '' }, counts: { requirements: 1, acceptanceCriteria: 1, workPackages: 1, landings: 1 },
    requirements: [requirement], domains: [requirement.businessDomain], waves: [requirement.wave], executionRevision: 111,
    executionStatuses: { IN_PROGRESS: 1 }, dispatcher: { status: 'active', displayStatus: 'stale', lastHeartbeatAt: '' },
    executionSemantics: { pause: '历史暂停语义', finish: '历史结束语义' } };
}

test('9.30 增量不改历史记录、执行计数与原队列，不伪造工作包或执行会话', () => {
  const board = frozenBoard(), before = structuredClone(board), display = displayCatchupBoard(board, increment);
  assert.deepEqual(board, before);
  assert.equal(display.requirements.length, 3);
  assert.equal(display.counts.incrementalRequirements, 2);
  assert.equal(display.counts.sourceCheckpoints, 3);
  assert.equal(display.counts.frozenRequirements, 1);
  assert.equal(display.counts.acceptanceCriteria, 1);
  assert.equal(display.counts.workPackages, 1);
  assert.deepEqual(display.executionStatuses, board.executionStatuses);
  assert.equal(display.executionRevision, 111);
  assert.deepEqual(catchupQueue(display), catchupQueue(board));
  const { sourceBatch, ...old } = display.requirements.at(-1)!;
  assert.equal(sourceBatch, '8.26 冻结');
  assert.deepEqual(old, board.requirements[0]);
  for (const item of display.requirements.slice(0, 2)) {
    assert.equal(item.execution.status, '待核验');
    assert.deepEqual(item.execution.allowedActions, []);
    assert.equal(item.session.jiraKey, '');
    assert.equal(item.session.threadId, '');
    assert.equal(item.workPackageCount, 0);
    assert.equal(item.pageStatus, '待核验');
    assert.equal(item.demoApiStatus, '待核验');
  }
});

test('源码文案和 PRD 冲突原样保留，重复编号拒绝覆盖历史', () => {
  const board = frozenBoard(), display = displayCatchupBoard(board, increment);
  assert.equal(display.requirements[0].goal, increment.requirements[0].description);
  assert.deepEqual(display.requirements[0].acceptanceCriteria.map(ac => ac.text), increment.requirements[0].acceptance);
  assert.equal(display.requirements.find(item => item.id === 'REQ-930-001')?.sourceIncrement?.conflicts[0].source, increment.sourceConflicts[0].source);
  assert.equal(display.requirements.find(item => item.id === 'REQ-930-002')?.sourceIncrement?.conflicts[0].source, increment.sourceConflicts[1].source);
  assert.throws(() => displayCatchupBoard(board, { ...increment, requirements: [{ ...increment.requirements[0], id: 'REQ-001' }] }), /重复/);
});

test('读取增量只发 GET，禁用静态缓存，拒绝缺失或不完整清单', async () => {
  const original = globalThis.fetch;
  const requests: { input: unknown; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = async (input, init) => { requests.push({ input, init }); return new Response(JSON.stringify(increment)); };
    const signal = new AbortController().signal;
    assert.equal((await readCatchupIncrement(signal)).requirements.length, 2);
    assert.equal(requests[0].input, '/catchup/apex-930.json');
    assert.equal(requests[0].init?.signal, signal);
    assert.equal(requests[0].init?.cache, 'no-store');
    assert.equal(requests[0].init?.method, undefined);
    assert.equal(requests[0].init?.body, undefined);
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(readCatchupIncrement(), /读取.*失败/);
    globalThis.fetch = async () => new Response(JSON.stringify({ ...increment, groupCount: 1 }));
    await assert.rejects(readCatchupIncrement(), /结构校验/);
  } finally { globalThis.fetch = original; }
});

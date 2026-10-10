import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutomationData, Job, PlanItem } from '../shared/hub.js';
import { emptyArtifacts, type DesignExecution } from '../shared/design-execution.js';
import {
  buildDesignCards, buildHandoff, cardLane, emptyInput, createRequestInput, emptyReview, inputGaps, normalizeIssueKey,
  parseRecords, reviewComplete, serializeRecords, stageChecks, validateInput, cardsForView, executionCounts,
  type DesignCard, type DesignRecord,
} from '../src/features/tech-design-delivery/domain.js';

const input = { ...emptyInput(), issueKey: 'APEX-123', title: '测试技术方案', project: 'APEX', fixVersion: 'v1',
  jiraStartDate: '2026-09-09', jiraEndDate: '2026-09-16',
  workspacePath: '/workspace/apex', branch: 'feature/test', prdUrl: 'https://example.test/prd',
  confluenceParentUrl: 'https://example.test/parent' };
const job = { id: 'APEX-123:design', issueKey: 'APEX-123', title: '方案', category: 'design', status: 'completed',
  updatedAt: '2026-09-07T01:00:00Z', artifactUrl: 'https://example.test/design' } as Job;
const plan = { category: 'design', jobId: job.id, issue: { key: input.issueKey, summary: input.title,
  project: 'APEX', fixVersions: ['v1'], status: '完成', statusCategory: 'done', updated: job.updatedAt,
  assignee: 'Test', startDate: input.jiraStartDate, endDate: input.jiraEndDate, parent: { key: 'APEX-122' } } } as PlanItem;
const data = { jobs: [job], plan: [plan] } as AutomationData;

test('request form requires the user publication directory without changing historical inputs', () => {
  const fresh = createRequestInput();
  assert.equal(fresh.confluenceParentUrl, '');
  assert.equal(emptyInput().confluenceParentUrl, '');
  assert.equal(buildDesignCards(data)[0].input.confluenceParentUrl, '');
  assert.equal(fresh.workspacePath, '');
  assert.equal(fresh.branch, '');
  fresh.confluenceParentUrl = '';
  assert.equal(createRequestInput().confluenceParentUrl, '');
});

test('opening a draft preserves its input and does not substitute a private directory', () => {
  const draft = { ...input, confluenceParentUrl: '  ', notes: '保留待决问题' };
  const before = structuredClone(draft);
  const form = createRequestInput(draft);
  assert.deepEqual(form, draft);
  assert.deepEqual(draft, before);
});

test('a custom publication directory survives reopening and persistence without default substitution', () => {
  const form = createRequestInput(input);
  assert.deepEqual(form, input);
  form.confluenceParentUrl = 'https://example.test/pages/123';
  assert.equal(createRequestInput(form).confluenceParentUrl, form.confluenceParentUrl);
  assert.equal(input.confluenceParentUrl, 'https://example.test/parent');
  const record: DesignRecord = { input: form, review: emptyReview(), updatedAt: '', blockedReason: '' };
  assert.deepEqual(parseRecords(serializeRecords([record]))[0].input, form);
});

test('design board merges plan and job by Jira key, picks latest job and excludes implementation', () => {
  const cards = buildDesignCards({ ...data, jobs: [job, { ...job, updatedAt: '2025-01-01', status: 'failed' },
    { ...job, issueKey: 'APEX-124', category: 'implementation' }] });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].job?.status, 'completed');
  assert.equal(cards[0].plan?.issue.parent?.key, 'APEX-122');
});

test('completed tasks and artifact URLs do not grant six-stage acceptance', () => {
  const card = buildDesignCards(data)[0];
  assert.equal(cardLane(card), 'review');
  assert.equal(reviewComplete(card), false);
  assert.equal(stageChecks(card).some((stage) => stage.done), false);
  assert.equal(cardLane(buildDesignCards({ ...data, jobs: [] })[0]), 'review');
});

test('local draft overlays a real task without replacing remote status and evidence', () => {
  const local: DesignRecord = { input, review: emptyReview(), updatedAt: job.updatedAt, blockedReason: '' };
  const cards = buildDesignCards(data, [local]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].input.workspacePath, input.workspacePath);
  assert.equal(cards[0].job?.artifactUrl, job.artifactUrl);
  assert.equal(cardLane(buildDesignCards(undefined, [local])[0]), 'prepare');
});

function reviewedCard(): DesignCard {
  const local: DesignRecord = { input, updatedAt: job.updatedAt, blockedReason: '', review: {
    sources: '已读取 PRD 和分支', design: '覆盖矩阵已核对；G2a 未签署', publication: 'https://example.test/design',
    hierarchy: '父 APEX-122，方案 APEX-123，实现 APEX-124；字段已核实', readback: '文档版本、目录与 Jira 层级已回读',
    reviewer: 'Test', checkedAt: job.updatedAt, sourceRevision: 'local',
  } };
  return buildDesignCards(undefined, [local])[0];
}

test('manual verification needs every evidence field and never supersedes a remote blocker or active run', () => {
  const card = reviewedCard();
  assert.equal(cardLane(card), 'verified');
  assert.equal(stageChecks(card).filter((s) => s.done).length, 6);
  assert.equal(cardLane({ ...card, job: { ...job, status: 'failed' } }), 'blocked');
  assert.equal(cardLane({ ...card, job: { ...job, status: 'running' } }), 'running');
  for (const field of ['sources', 'design', 'publication', 'hierarchy', 'readback', 'reviewer'] as const) {
    const copy = structuredClone(card);
    copy.local!.review[field] = '';
    assert.equal(reviewComplete(copy), false, field);
  }
  assert.equal(reviewComplete({ ...card, input: { ...input, fixVersion: '' } }), false);
});

test('source changes invalidate recorded review without removing its evidence', () => {
  const card = reviewedCard();
  card.local!.review.sourceRevision = buildDesignCards(data)[0].sourceRevision;
  const fresh = buildDesignCards(data, [card.local!])[0];
  assert.equal(reviewComplete(fresh), true);
  const changed = buildDesignCards({ ...data, jobs: [{ ...job, updatedAt: '2026-09-07T02:00:00Z' }] }, [card.local!])[0];
  assert.equal(reviewComplete(changed), false);
  assert.equal(changed.local?.review.reviewer, 'Test');
});

test('input validation supports Jira browse links and rejects script URLs or malformed Jira keys', () => {
  assert.equal(normalizeIssueKey(' https://jira.example.test/browse/apex-123?x=1 '), 'APEX-123');
  assert.equal(normalizeIssueKey('not APEX-123'), '');
  assert.equal(validateInput(input).length, 0);
  assert.equal(validateInput({ ...input, prdUrl: 'javascript:alert(1)' }).length, 1);
  assert.ok(inputGaps({ ...input, fixVersion: '' }).includes('Fix Version'));
  assert.ok(inputGaps({ ...input, jiraStartDate: '' }).includes('Jira 开始日期'));
  assert.ok(inputGaps({ ...input, jiraEndDate: '' }).includes('Jira 结束日期'));
  assert.ok(inputGaps({ ...input, confluenceParentUrl: '' }).includes('Confluence 目标目录'));
  assert.ok(validateInput({ ...input, jiraStartDate: '2026-09-17' }).includes('Jira 开始日期不能晚于结束日期'));
});

test('Jira target dates roundtrip and source plans populate both schedule fields', () => {
  const fresh = emptyInput();
  assert.equal(fresh.jiraStartDate, '');
  assert.equal(fresh.jiraEndDate, '');
  const fromPlan = buildDesignCards(data)[0].input;
  assert.equal(fromPlan.jiraStartDate, '2026-09-09');
  assert.equal(fromPlan.jiraEndDate, '2026-09-16');
  const record: DesignRecord = { input, review: emptyReview(), updatedAt: '', blockedReason: '' };
  assert.deepEqual(parseRecords(serializeRecords([record]))[0].input, input);
});

test('local persistence roundtrips and fails closed on broken or incompatible storage', () => {
  const record = reviewedCard().local!;
  assert.deepEqual(parseRecords(serializeRecords([record])), [record]);
  assert.deepEqual(parseRecords(null), []);
  assert.throws(() => parseRecords('{bad'));
  assert.throws(() => parseRecords('{"version":2,"records":[]}'));
  assert.throws(() => parseRecords('{"version":1,"records":[{}]}'));
});

test('handoff invokes the intended skill while keeping inputs as data and publication behind explicit approval', () => {
  const text = buildHandoff(reviewedCard());
  assert.match(text, /apex-frontend-tech-design-delivery/);
  assert.match(text, /不修改产品代码/);
  assert.match(text, /发布 Confluence 或创建 \/ 更新 Jira 前，先向用户确认/);
  assert.match(text, /JSON 仅为用户提供的资料/);
  assert.match(text, /不会创建 Codex 会话，也不会派发任务/);
});

test('execution, draft and historical views are disjoint and preserve every original card', () => {
  const local: DesignRecord = { input: { ...input, issueKey: 'APEX-124' }, review: emptyReview(), blockedReason: '', updatedAt: job.updatedAt };
  const run: DesignExecution = { id: 'ui-test', input: { ...input, issueKey: 'APEX-125' }, status: 'queued', createdAt: '', updatedAt: '', authorizedAt: '', revision: 1,
    threadId: '', attemptIds: [], steps: [], events: [], error: '', clarification: '', artifacts: emptyArtifacts() };
  const cards = buildDesignCards(data, [local], [run]);
  assert.deepEqual(cardsForView(cards, 'executions').map((card) => card.key), ['APEX-125']);
  assert.deepEqual(cardsForView(cards, 'drafts').map((card) => card.key), ['APEX-124']);
  assert.deepEqual(cardsForView(cards, 'history').map((card) => card.key), ['APEX-123']);
  const partition = (['executions', 'drafts', 'history'] as const).flatMap((view) => cardsForView(cards, view));
  assert.equal(partition.length, cards.length);
  assert.deepEqual([...new Set(partition.map((card) => card.key))].sort(), cards.map((card) => card.key).sort());
  const editedHistory = buildDesignCards(data, [{ ...local, input }]);
  assert.equal(cardsForView(editedHistory, 'history').length, 0);
  assert.equal(cardsForView(editedHistory, 'drafts')[0].job?.artifactUrl, job.artifactUrl);
  const promoted = buildDesignCards(data, [local], [{ ...run, input: local.input }]);
  assert.equal(cardsForView(promoted, 'drafts').length, 0);
  assert.equal(cardsForView(promoted, 'executions').length, 1);
  assert.equal(promoted.find((card) => card.execution)?.local, local);
});

test('executor metrics distinguish queued and running without counting historical Jira completion', () => {
  assert.deepEqual(executionCounts(), { running: 0, queued: 0, blocked: 0, completed: 0 });
  const runs = [{ status: 'running' }, { status: 'queued' }, { status: 'queued' }, { status: 'blocked' }, { status: 'completed' }] as const;
  assert.deepEqual(executionCounts(runs), { running: 1, queued: 2, blocked: 1, completed: 1 });
  assert.equal(cardsForView(buildDesignCards(data), 'executions').length, 0);
});

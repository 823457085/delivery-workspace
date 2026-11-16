import assert from 'node:assert/strict';
import test from 'node:test';
import type { JiraIssue } from '../shared/hub.js';
import {
  buildGanttRows,
  buildGanttWindowDays,
  formatLocalDayKey,
  summarizeTaskHealth,
} from '../src/features/task-calendar/calendar-timeline-studio.js';
import {
  appendContextMention,
  estimatePromptTokens,
  pickLaunchpadWorkspaces,
} from '../src/features/agent-workbench/prompt-studio-metrics.js';
import {
  classifyDeliveryRecordState,
  computeSpecStageProgress,
  summarizeDeliveryRecords,
} from '../src/features/requirement-development/spec-delivery-studio.js';
import {
  filterIntegrationPlugins,
  isPluginActiveReady,
  isPluginNeedsSetup,
  summarizePluginRegistry,
  type RegistryPluginLike,
} from '../src/features/delivery-settings/plugin-registry-studio.js';

function makeIssue(overrides: Partial<JiraIssue> & { key: string }): JiraIssue {
  return {
    summary: overrides.summary ?? 'Sample task',
    status: overrides.status ?? '进行中',
    statusCategory: overrides.statusCategory ?? 'indeterminate',
    priority: overrides.priority ?? 'Medium',
    assignee: overrides.assignee ?? 'Alice',
    updated: overrides.updated ?? '2026-11-12T10:00:00.000Z',
    url: overrides.url ?? `https://jira.example.com/browse/${overrides.key}`,
    ...overrides,
  };
}

test('Pass-11 Gantt & Health Studio: Monday-aligned 14-day window, range clamping, overdue detection, and health metrics', () => {
  // 2026-11-18 is a Wednesday -> Monday should be 2026-11-16
  const anchor = new Date(2026, 10, 18);
  const today = new Date(2026, 10, 18);
  const days = buildGanttWindowDays(anchor, 14, today);

  assert.equal(days.length, 14);
  assert.equal(days[0]?.day, '2026-11-16');
  assert.equal(days[0]?.weekdayShort, '一');
  assert.equal(days[2]?.day, '2026-11-18');
  assert.equal(days[2]?.isToday, true);
  assert.equal(days[5]?.isRestDay, true); // Saturday
  assert.equal(days[13]?.day, '2026-11-29');

  const issues: JiraIssue[] = [
    makeIssue({
      key: 'PROJ-101',
      startDate: '2026-11-14',
      endDate: '2026-11-17',
      status: '进行中',
      assignee: 'Alice',
    }),
    makeIssue({
      key: 'PROJ-102',
      startDate: '2026-11-20',
      endDate: '2026-12-02',
      status: '待办',
      statusCategory: 'new',
      assignee: 'Bob',
    }),
    makeIssue({
      key: 'PROJ-103',
      startDate: '2026-11-16',
      endDate: '2026-11-16',
      status: '已完成',
      statusCategory: 'done',
      assignee: 'Alice',
    }),
    makeIssue({
      key: 'PROJ-104',
      // Unscheduled open issue
      status: '待办',
      statusCategory: 'new',
      assignee: '',
    }),
  ];

  const rows = buildGanttRows(issues, days, 'planned', formatLocalDayKey(today));
  assert.equal(rows.length, 3);

  const clampedBefore = rows.find(r => r.issue.key === 'PROJ-101')!;
  assert.equal(clampedBefore.startCol, 0);
  assert.equal(clampedBefore.endCol, 1);
  assert.equal(clampedBefore.continuesBefore, true);
  assert.equal(clampedBefore.continuesAfter, false);
  assert.equal(clampedBefore.isOverdue, true);

  const clampedAfter = rows.find(r => r.issue.key === 'PROJ-102')!;
  assert.equal(clampedAfter.startCol, 4);
  assert.equal(clampedAfter.endCol, 13);
  assert.equal(clampedAfter.continuesBefore, false);
  assert.equal(clampedAfter.continuesAfter, true);
  assert.equal(clampedAfter.isOverdue, false);

  const health = summarizeTaskHealth(issues, '2026-11-18');
  assert.deepEqual(health, {
    total: 4,
    doneCount: 1,
    completionRate: 25,
    overdueCount: 1,
    unscheduledCount: 1,
    assigneeCount: 2,
  });
});

test('Pass-11 Prompt Studio Metrics: CJK + code token estimation, launchpad workspace pinning, and @mention append', () => {
  assert.deepEqual(estimatePromptTokens(''), {
    chars: 0,
    lines: 0,
    estimatedTokens: 0,
    codeBlocks: 0,
  });

  const mixed = '请帮我修复登录鉴权问题\n```ts\nconst ok = verifyToken(req);\n```';
  const metrics = estimatePromptTokens(mixed);
  assert.equal(metrics.lines, 4);
  assert.equal(metrics.codeBlocks, 1);
  assert.ok(metrics.estimatedTokens >= 15 && metrics.estimatedTokens <= 30);

  const workspaces = [
    { path: '/repo/a', label: 'a' },
    { path: '/repo/b', label: 'b' },
    { path: '/repo/c', label: 'c' },
    { path: '/repo/d', label: 'd' },
  ];
  const picked = pickLaunchpadWorkspaces(workspaces, '/repo/d', 2);
  assert.deepEqual(picked.map(item => item.path), ['/repo/d', '/repo/a']);

  let draft = '';
  draft = appendContextMention(draft, '@PROJ-101');
  assert.equal(draft, '@PROJ-101 ');
  draft = appendContextMention(draft, '@PROJ-101');
  assert.equal(draft, '@PROJ-101 '); // deduplicated
  draft = appendContextMention('请排查缺陷', '@PROJ-102');
  assert.equal(draft, '请排查缺陷 @PROJ-102 ');
});

test('Pass-11 Spec-Driven Delivery Ledger: operational state bucketing and stage checkpoint progress', () => {
  const records = [
    { status: 'started', runStatus: 'running' },
    { status: 'started', runStatus: 'completed' },
    { status: 'failed', error: 'Git worktree conflict' },
    { status: 'started', runStatus: undefined },
  ];

  assert.equal(classifyDeliveryRecordState(records[0]!), 'running');
  assert.equal(classifyDeliveryRecordState(records[1]!), 'completed');
  assert.equal(classifyDeliveryRecordState(records[2]!), 'failed');
  assert.equal(classifyDeliveryRecordState(records[3]!), 'ready');

  assert.deepEqual(summarizeDeliveryRecords(records), {
    total: 4,
    running: 1,
    completed: 1,
    failed: 1,
  });

  const stageProgress = computeSpecStageProgress({
    schedule: { status: 'completed' },
    design: { status: 'completed' },
    implementation: { status: 'in_progress' },
    verification: { status: 'pending' },
  });
  assert.deepEqual(stageProgress, {
    completedCount: 2,
    activeCount: 1,
    totalCount: 4,
    percent: 50,
  });
});

test('Pass-11 Plugin Ecosystem Registry: category tab filtering, capability/port search, and summary counts', () => {
  const samplePlugins: RegistryPluginLike[] = [
    {
      id: 'jira',
      name: 'Jira 任务同步',
      description: '同步研发任务与缺陷',
      installed: true,
      runningEnabled: true,
      runningConfigured: true,
      views: [{ id: 'jira', label: 'Jira 面板' }],
    },
    {
      id: 'wecom',
      name: '企业微信机器人',
      description: '推送巡检与构建通知',
      installed: true,
      runningEnabled: true,
      runningConfigured: false,
      views: [],
    },
    {
      id: 'port-monitor',
      name: '本机端口监控',
      description: '扫描开发端口与进程',
      local: true,
      localPort: 5288,
      installed: true,
      runningEnabled: true,
      runningConfigured: true,
      views: [{ id: 'ports', label: '端口监控' }],
    },
  ];

  assert.equal(isPluginActiveReady(samplePlugins[0]!), true);
  assert.equal(isPluginNeedsSetup(samplePlugins[1]!), true);

  const counts = summarizePluginRegistry(samplePlugins);
  assert.deepEqual(counts, {
    all: 3,
    active: 2,
    service: 2,
    local: 1,
    setup: 1,
  });

  const caps = {
    jira: ['issues.read', 'issues.write'],
    'port-monitor': ['ports.inspect'],
  };

  assert.deepEqual(
    filterIntegrationPlugins(samplePlugins, 'issues.write', 'all', caps).map(p => p.id),
    ['jira'],
  );
  assert.deepEqual(
    filterIntegrationPlugins(samplePlugins, '5288', 'local', caps).map(p => p.id),
    ['port-monitor'],
  );
  assert.deepEqual(
    filterIntegrationPlugins(samplePlugins, '', 'setup', caps).map(p => p.id),
    ['wecom'],
  );
});

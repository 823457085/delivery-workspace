import test from 'node:test';
import assert from 'node:assert/strict';
import type { JiraIssue } from '../shared/hub';
import {
  buildIssueKanbanColumns,
  classifyIssueStage,
  formatIssueMarkdownLink,
  stepIssueSelection,
  suggestIssueBranchName,
} from '../src/features/task-calendar/task-triage-studio';
import {
  classifyEnvironmentTier,
  countTopEnvironments,
  environmentTierLabel,
  extractUrlHost,
  sortSystemsWithPins,
} from '../src/features/system-catalog/catalog-studio';
import {
  detectDeployLogLevel,
  parseStructuredLogLines,
  stripAnsiCodes,
} from '../src/features/deployments/deployment-studio';

const makeIssue = (partial: Partial<JiraIssue>): JiraIssue => ({
  key: 'VMS-802',
  url: 'https://jira.hahabianli.com/browse/VMS-802',
  summary: '完成 Adyen商家账户拆分联调自测',
  status: '待开始',
  statusCategory: 'new',
  issueType: '任务',
  priority: 'P1',
  project: 'VMS',
  projectName: '商户平台',
  assignee: '李子锐',
  fixVersions: [],
  created: '2026-11-10T00:00:00Z',
  updated: '2026-11-15T00:00:00Z',
  dueDate: null,
  startDate: null,
  endDate: null,
  resolutionDate: null,
  parent: null,
  subtasks: [],
  ...partial,
});

test('task-triage-studio: classifies Jira statuses into 4 Plane/Linear Kanban lanes', () => {
  const issues = [
    makeIssue({ key: 'A-1', status: '待开始', statusCategory: 'new' }),
    makeIssue({ key: 'A-2', status: '开发中', statusCategory: 'indeterminate' }),
    makeIssue({ key: 'A-3', status: '测试中', statusCategory: 'indeterminate' }),
    makeIssue({ key: 'A-4', status: '已完成', statusCategory: 'done' }),
  ];
  assert.equal(classifyIssueStage(issues[0]!), 'todo');
  assert.equal(classifyIssueStage(issues[1]!), 'active');
  assert.equal(classifyIssueStage(issues[2]!), 'verify');
  assert.equal(classifyIssueStage(issues[3]!), 'done');

  const cols = buildIssueKanbanColumns(issues);
  assert.deepEqual(
    cols.map(c => [c.id, c.issues.map(i => i.key)]),
    [
      ['todo', ['A-1']],
      ['active', ['A-2']],
      ['verify', ['A-3']],
      ['done', ['A-4']],
    ],
  );
});

test('task-triage-studio: suggests branch names, formats safe Markdown links, and steps j/k selection', () => {
  assert.equal(suggestIssueBranchName('VMS-802', '任务'), 'feat/VMS-802');
  assert.equal(suggestIssueBranchName('OPAY-536', '线上缺陷'), 'fix/OPAY-536');
  assert.equal(suggestIssueBranchName('APEX-10', 'Bug'), 'fix/APEX-10');
  assert.equal(suggestIssueBranchName(''), '');

  assert.equal(
    formatIssueMarkdownLink({ key: 'VMS-802', summary: '自测任务', url: 'https://jira.example.com/browse/VMS-802' }),
    '[VMS-802](https://jira.example.com/browse/VMS-802) 自测任务',
  );
  assert.equal(
    formatIssueMarkdownLink({ key: 'VMS-802', summary: '拦截脚本链接', url: 'javascript:alert(1)' }),
    'VMS-802 拦截脚本链接',
  );

  const keys = ['K-1', 'K-2', 'K-3'];
  assert.equal(stepIssueSelection(keys, '', 1), 'K-1');
  assert.equal(stepIssueSelection(keys, '', -1), 'K-3');
  assert.equal(stepIssueSelection(keys, 'K-1', 1), 'K-2');
  assert.equal(stepIssueSelection(keys, 'K-3', 1), 'K-3');
  assert.equal(stepIssueSelection(keys, 'K-2', -1), 'K-1');
});

test('catalog-studio: classifies environment tiers, extracts hosts safely, pins systems, and counts top environments', () => {
  assert.equal(classifyEnvironmentTier('生产环境'), 'prod');
  assert.equal(environmentTierLabel(classifyEnvironmentTier('prod')), 'PROD');
  assert.equal(classifyEnvironmentTier('预发布 pre'), 'stage');
  assert.equal(classifyEnvironmentTier('多语言测试'), 'test');
  assert.equal(classifyEnvironmentTier('本地开发'), 'dev');

  assert.equal(extractUrlHost('https://admin-pre.example.com:8443/login?x=1'), 'admin-pre.example.com:8443');
  assert.equal(extractUrlHost('javascript:alert(1)'), '');
  assert.equal(extractUrlHost('not a url'), '');

  const ordered = sortSystemsWithPins([{ id: 's1' }, { id: 's2' }, { id: 's3' }], ['s3']);
  assert.deepEqual(ordered.map(s => s.id), ['s3', 's1', 's2']);

  const top = countTopEnvironments(
    [{ name: '测试' }, { name: '生产' }, { name: '测试' }, { name: '预发' }, { name: '测试' }, { name: '预发' }],
    2,
  );
  assert.deepEqual(top, [
    { name: '测试', count: 3 },
    { name: '预发', count: 2 },
  ]);
});

test('deployment-studio: strips ANSI escapes, detects log levels, and filters structured lines while preserving line numbers', () => {
  const raw = [
    '\u001b[36m[INFO] Installing dependencies...\u001b[0m',
    '\u001b[33mWARN deprecated inflight@1.0.6\u001b[0m',
    '\u001b[31mERROR: Build failed with exit code 1\u001b[0m',
    'Finished: SUCCESS',
  ].join('\n');

  assert.equal(stripAnsiCodes('\u001b[32mOK\u001b[0m'), 'OK');
  assert.equal(detectDeployLogLevel('ERROR: Build failed'), 'error');
  assert.equal(detectDeployLogLevel('WARN deprecated'), 'warn');
  assert.equal(detectDeployLogLevel('Finished: SUCCESS'), 'success');

  const all = parseStructuredLogLines(raw);
  assert.equal(all.totalLines, 4);
  assert.equal(all.errorCount, 1);
  assert.equal(all.warnCount, 1);
  assert.equal(all.lines[0]?.text, '[INFO] Installing dependencies...');
  assert.equal(all.lines[2]?.level, 'error');

  const issuesOnly = parseStructuredLogLines(raw, { levelFilter: 'issues' });
  assert.deepEqual(issuesOnly.lines.map(l => [l.lineNumber, l.level]), [
    [2, 'warn'],
    [3, 'error'],
  ]);

  const keywordFiltered = parseStructuredLogLines(raw, { keyword: 'success' });
  assert.deepEqual(keywordFiltered.lines.map(l => [l.lineNumber, l.level]), [
    [4, 'success'],
  ]);
});

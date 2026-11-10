import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { chinaWorkingDates, splitWorkingDates } from '../shared/china-work-calendar.mjs';
import { jiraDevNeedsApply, jiraDevStartBlocker } from '../shared/jira-dev.js';
import { createRequirementStore } from '../server/jira-dev/index.mjs';

function fixture(saved?: unknown) {
  const source = readFileSync(new URL('../src/features/jira-dev/useJiraDevTask.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('useJiraDevTask.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n').replace(/^export /gm, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const storage = new Map<string, string>();
  if (saved) storage.set('qiyuan:jira-dev:requirement:v1', JSON.stringify(saved));
  const requests: string[] = [];
  const dependencies = { computed, reactive, ref, shallowRef, watch, chinaWorkingDates, splitWorkingDates, jiraDevNeedsApply, jiraDevStartBlocker,
    ElMessage: { error() {}, warning() {} }, localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: async (url: string) => { requests.push(url); throw new Error('This scheduling preview must not send requests'); } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn useJiraDevTask('requirement', () => {});`)(...Object.values(dependencies)));
  return { state, storage, requests, close: () => scope.stop() };
}
const ranges = (rows: any[]) => rows.map(row => [row.role, row.startDate, row.endDate, row.workdays]);

async function backendRanges(startDate: string, endDate: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inline-jira-plan-'));
  const issue = { key: 'TEST-123', url: 'https://jira.example.test/browse/TEST-123', summary: '【商家账户】拆分任务', project: { id: '1', key: 'TEST' }, startDate, endDate, fixVersions: [], links: [] };
  const fields = Object.fromEntries(['project', 'issuetype', 'summary', 'description', 'parent', 'labels', 'assignee', 'start', 'end'].map(key => [key, { required: false, operations: ['set'], ...(key === 'start' || key === 'end' ? { schema: { type: 'date' } } : {}) }]));
  const jira = { readRequirementContext: async () => ({ issue, assignee: { name: 'tester' }, startField: 'start', endField: 'end', issueTypes: [{ id: '10', name: '任务', subtask: false, fields }, { id: '11', name: '子任务', subtask: true, fields }], linkTypes: [{ id: '20', name: 'relates to' }] }),
    findRequirementIssues: async () => ({ sourceIssue: issue, issues: [], truncated: false }), createRequirementIssue: async () => { throw new Error('Preview cannot write Jira'); } };
  try {
    const store = createRequirementStore({ jira, dataDirectory: directory });
    const plan = await store.prepare({ taskId: 'inline', sourceKind: 'product', sourceIssue: issue, repositoryId: 'fixture', designDestination: null, schedules: { parent: { startDate, endDate } } });
    assert.equal(plan.status, 'ready', plan.warning || '');
    return plan.items.filter(item => item.role !== 'parent').map(item => [item.role, item.schedule!.startDate, item.schedule!.endDate, item.workdays]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('选择截图主任务日期即展示三个子任务，和后台建单预览一致；不等待生成、不写 Jira', async () => {
  const f = fixture();
  try {
    f.state.editSchedule('parent', 'startDate', '2026-11-03'); f.state.editSchedule('parent', 'endDate', '2026-11-11');
    const expected = [['design', '2026-11-03', '2026-11-03', 1], ['implementation', '2026-11-04', '2026-11-06', 3], ['implementation', '2026-11-09', '2026-11-11', 3]];
    assert.deepEqual(ranges(f.state.childSchedules.value), expected); assert.deepEqual(await backendRanges('2026-11-03', '2026-11-11'), expected);
    assert.deepEqual(f.requests, []);
  } finally { f.close(); }
});

test('展示与后台同时跳过法定休假和休息日，官方周六补班计入三天子任务', async () => {
  const f = fixture();
  try {
    f.state.editSchedule('parent', 'startDate', '2026-05-01'); f.state.editSchedule('parent', 'endDate', '2026-05-11');
    const expected = [['design', '2026-05-06', '2026-05-06', 1], ['implementation', '2026-05-07', '2026-05-09', 3], ['implementation', '2026-05-11', '2026-05-11', 1]];
    assert.deepEqual(ranges(f.state.childSchedules.value), expected); assert.deepEqual(await backendRanges('2026-05-01', '2026-05-11'), expected);
  } finally { f.close(); }
});

test('修改日期或恢复草稿时重算；保留手工范围，复用前端事项及锁定任务不伪造待创建子任务', async () => {
  const f = fixture({ form: { schedules: { parent: { startDate: '2026-11-03', endDate: '2026-11-11' } } } });
  try {
    await nextTick(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.state.childSchedules.value.length, 3);
    f.state.editSchedule('design', 'endDate', '2026-11-04'); f.state.editSchedule('parent', 'endDate', '2026-11-12');
    assert.equal(f.state.childSchedules.value[0].endDate, '2026-11-04');
    assert.ok(f.state.childSchedules.value.every((row: any) => row.workdays <= 3));
    f.state.edit('sourceKind', 'frontend'); assert.deepEqual(f.state.childSchedules.value, []);
    f.state.edit('sourceKind', 'product'); f.state.task.value = { launch: { status: 'started' } }; assert.deepEqual(f.state.childSchedules.value, []);
  } finally { f.close(); }
});

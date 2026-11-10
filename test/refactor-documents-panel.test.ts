import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowRef, watch } from 'vue';
import { refactorDocumentStateLabels, type RefactorDocumentRow, type RefactorWorkspaceDashboard } from '../shared/refactor-workspace.js';

const source = await fs.readFile(new URL('../src/features/refactor-control/RefactorDocumentsPanel.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .+;$/gm, '');
const code = ts.transpileModule(`${script}\n;({ documentId, bindProjectId, current, selectedRows, testRows, retestRows, disabledReason, launch, toggleAll, stateLabel, resultLabel, counts, visibleRows, stateFilter, search, sourceStatusFilter, reporterFilter, sourceStatusOptions, reporterOptions, selectedIds });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function row(id: string, state: RefactorDocumentRow['state'], method = 'GET', path = '/admin/v1/fixture'): RefactorDocumentRow {
  return { id, state, method, path, sheet: 1, sheetName: '问题清单', row: 2, issueId: id, title: '原文 L1001',
    sourceStatus: '原始状态 L1002', request: `${method} ${path}`, parameters: '', expected: '', actual: '', notes: '' };
}
function fixture(bound = true) {
  const passed = { ...row('verified', 'passed'), latest: { status: 'passed' as const, actual: '真实返回 L1003', evidence: ['request.json'],
    environment: 'DEV', version: 'fixture-sha', checkedAt: '2026-11-04T00:00:00Z', jobId: 'fixture-job' } };
  const rows = [row('first', 'pending_test'), row('retry', 'pending_retest'), row('history', 'passed'), passed,
    row('deferred', 'blocked'), row('write', 'pending_test', 'POST'), row('missing', 'pending_test', 'GET', '')];
  const data = shallowRef<RefactorWorkspaceDashboard>({ revision: 'fixture', projects: [{ id: 'project-a', name: 'APEX', role: 'micro-app',
    workspacePath: '/fixture/apex', baseUrl: 'http://localhost:7331', packageManager: 'pnpm', startScript: 'dev', dependencies: [],
    state: 'running', branch: 'feature/fixture', head: 'fixture-sha', dirty: false, message: '', ports: [7331], scripts: ['dev'], pids: [321] }],
    documents: [{ id: 'doc-a', moduleId: bound ? 'document:doc-a' : '', projectId: bound ? 'project-a' : '', projectName: bound ? 'APEX' : '',
      name: '问题清单.xlsx', importedAt: '2026-11-04T00:00:00Z', sha256: 'fixture', imageCount: 2, warnings: [], rows }] });
  const events: { event: string; selection: { action: string; moduleIds: string[]; interfaceIds: string[]; issueIds: string[] } }[] = [];
  const scope = effectScope();
  const component = scope.run(() => runInNewContext(code, {
    computed, shallowRef, watch, useTemplateRef: () => shallowRef(),
    useQuery: () => ({ data, error: shallowRef(), isPending: shallowRef(false) }), useQueryClient: () => ({}),
    defineEmits: () => (event: string, selection: typeof events[number]['selection']) => events.push({ event, selection }),
    stateLabels: refactorDocumentStateLabels, ElMessage: { error() {} },
    refactorWorkspaceQueryKey: ['refactor-workspace'], refactorWorkspaceBase: '/fixture',
  }));
  return { data, rows, events, component, cleanup: () => scope.stop() };
}

test('文档缓存立即显示；首次测试和复测保持所选行ID，不扩大到整份文档或写接口', () => {
  const f = fixture();
  try {
    assert.equal(f.component.documentId.value, 'doc-a');
    assert.equal(f.component.bindProjectId.value, 'project-a');
    f.component.toggleAll(true);
    assert.equal(f.component.selectedRows.value.length, 4);
    assert.equal(f.component.testRows.value.length, 1);
    f.component.launch('integrate', f.component.testRows.value);
    assert.equal(f.events[0].selection.moduleIds.join(','), 'document:doc-a');
    assert.equal(f.events[0].selection.interfaceIds.join(','), 'first');
    assert.equal(f.events[0].selection.issueIds.length, 0);
    f.component.launch('retest', f.component.retestRows.value);
    assert.equal(f.events[1].selection.issueIds.join(','), 'retry,history,verified');
    assert.equal(f.events[1].selection.interfaceIds.length, 0);
    for (const row of f.rows.slice(4)) f.component.launch('integrate', [row]);
    assert.equal(f.events.length, 2);
  } finally { f.cleanup(); }
});

test('未绑定或项目被移除时不能派发，原文暂缓、写接口和缺路径均保留禁用原因', async () => {
  const unbound = fixture(false), bound = fixture();
  try {
    assert.match(unbound.component.disabledReason(unbound.rows[0]), /关联重构项目/);
    unbound.component.launch('integrate', [unbound.rows[0]]);
    assert.equal(unbound.events.length, 0);
    assert.match(bound.component.disabledReason(bound.rows[4]), /暂不联调/);
    assert.match(bound.component.disabledReason(bound.rows[5]), /写接口/);
    assert.match(bound.component.disabledReason(bound.rows[6]), /接口路径/);
    bound.component.toggleAll(true);
    bound.data.value = { ...bound.data.value, projects: [] };
    await nextTick();
    assert.equal(bound.component.selectedRows.value.length, 0);
    bound.component.launch('integrate', [bound.rows[0]]);
    assert.equal(bound.events.length, 0);
  } finally { unbound.cleanup(); bound.cleanup(); }
});

test('历史通过不冒充本轮结果，真实报告原文保留并使用独立的本轮通过标签', () => {
  const f = fixture();
  try {
    assert.equal(f.component.stateLabel(f.rows[2]), '历史通过');
    assert.equal(f.component.resultLabel(f.rows[2]), '');
    assert.equal(f.component.stateLabel(f.rows[3]), '本轮通过');
    assert.equal(f.component.resultLabel(f.rows[3]), '本轮通过');
    assert.equal(f.rows[3].latest?.actual, '真实返回 L1003');
    assert.equal(f.rows[3].sourceStatus, '原始状态 L1002');
    assert.equal(f.component.counts.value.find((item: { state: string }) => item.state === 'passed').label, '通过记录');
    const retryAfterBlock = { ...f.rows[1], latest: { ...f.rows[3].latest!, status: 'blocked' as const } };
    assert.equal(f.component.disabledReason(retryAfterBlock), '');
    assert.equal(f.component.stateLabel(retryAfterBlock), '待复测');
    assert.equal(f.component.resultLabel(retryAfterBlock), '本轮阻塞');
  } finally { f.cleanup(); }
});

test('原文状态、提出人员、处理分类与搜索取交集，空字段和L码原文可以精确筛选', () => {
  const f = fixture();
  try {
    const statuses = ['复测不通过', '复测不通过', '复测通过', 'L1002', '', '复测不通过', '已修复待复测'];
    const reporters = ['示例用户', '示例成员', '示例用户', '示例用户', '', '示例用户', '示例成员'];
    const rows = f.rows.map((row, index) => ({ ...row, sourceStatus: statuses[index], reporter: reporters[index] }));
    f.data.value = { ...f.data.value, documents: [{ ...f.data.value.documents[0], rows }] };
    assert.equal(f.component.sourceStatusOptions.value.length, 5);
    assert.ok(f.component.sourceStatusOptions.value.includes('L1002'));
    assert.equal(f.component.reporterOptions.value.length, 3);
    f.component.sourceStatusFilter.value = '复测不通过';
    assert.equal(f.component.visibleRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first,retry,write');
    f.component.reporterFilter.value = '示例用户';
    assert.equal(f.component.visibleRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first,write');
    f.component.toggleAll(true);
    assert.equal(f.component.selectedRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first');
    f.component.stateFilter.value = 'pending_test';
    f.component.search.value = 'first';
    assert.equal(f.component.visibleRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first');
    f.component.search.value = ''; f.component.stateFilter.value = '';
    f.component.sourceStatusFilter.value = 'L1002';
    assert.equal(f.component.visibleRows.value[0].id, 'verified');
    assert.equal(f.component.visibleRows.value[0].sourceStatus, 'L1002');
    f.component.sourceStatusFilter.value = ''; f.component.reporterFilter.value = '';
    assert.equal(f.component.visibleRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'deferred');
    f.component.sourceStatusFilter.value = undefined; f.component.reporterFilter.value = undefined;
    assert.equal(f.component.visibleRows.value.length, 7);
    assert.equal(f.component.sourceStatusOptions.value.length, 5, '筛选选项始终来自整份当前文档');
  } finally { f.cleanup(); }
});

test('切换筛选后清除不可见选中项，已选数量与执行范围只对应当前筛选结果', async () => {
  const f = fixture();
  try {
    f.component.toggleAll(true);
    assert.equal(f.component.selectedRows.value.length, 4);
    f.component.stateFilter.value = 'pending_test';
    await nextTick();
    assert.equal(f.component.visibleRows.value.length, 3);
    assert.equal(f.component.selectedRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first');
    assert.equal(f.component.retestRows.value.length, 0);
    f.component.toggleAll(true);
    assert.equal(f.component.selectedRows.value.map((row: RefactorDocumentRow) => row.id).join(','), 'first');
    f.component.stateFilter.value = 'pending_retest';
    await nextTick();
    assert.equal(f.component.visibleRows.value.length, 1);
    assert.equal(f.component.selectedRows.value.length, 0);
  } finally { f.cleanup(); }
});

test('切换文档清除原文状态和人员筛选，并从新文档生成选项', async () => {
  const f = fixture();
  try {
    const second = { ...f.data.value.documents[0], id: 'doc-b', rows: [{ ...f.rows[0], id: 'second', sourceStatus: '新原文状态', reporter: '新提出人' }] };
    f.data.value = { ...f.data.value, documents: [...f.data.value.documents, second] };
    f.component.sourceStatusFilter.value = '复测不通过'; f.component.reporterFilter.value = '示例用户';
    f.component.stateFilter.value = 'pending_retest'; f.component.search.value = '旧查询'; f.component.selectedIds.value = ['first'];
    f.component.documentId.value = 'doc-b';
    await nextTick();
    assert.equal(f.component.sourceStatusFilter.value, undefined);
    assert.equal(f.component.reporterFilter.value, undefined);
    assert.equal(f.component.stateFilter.value, ''); assert.equal(f.component.search.value, '');
    assert.equal(f.component.selectedIds.value.length, 0);
    assert.equal(f.component.visibleRows.value[0].id, 'second');
    assert.equal(f.component.sourceStatusOptions.value.join(','), '新原文状态');
    assert.equal(f.component.reporterOptions.value.join(','), '新提出人');
  } finally { f.cleanup(); }
});

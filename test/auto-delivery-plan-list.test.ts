import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanItem } from '../shared/hub';
import { planItems, projectRoutingLabel, type PlanFilter } from '../src/features/auto-delivery/plan-list';
import { emptyProjectProfile } from '../src/features/delivery-settings/domain';

function plan(key: string, overrides: Partial<PlanItem> = {}, issue: Partial<PlanItem['issue']> = {}): PlanItem {
  return {
    jobId: key, category: 'implementation', categoryLabel: '代码实现', model: 'recorded-model',
    action: '来源原文 L_1001', dispatchable: false, dependencyKeys: [], childKeys: [], jobStatus: '',
    localAlreadyDone: false, targetBranch: 'main', workspace: null, ...overrides,
    issue: { key, url: '', summary: key, status: '开发中', statusCategory: '处理中', issueType: '任务',
      priority: '', project: 'APEX', projectName: '商家项目', assignee: '', fixVersions: [], created: '', updated: '',
      dueDate: null, startDate: null, endDate: null, resolutionDate: null, parent: null, subtasks: [], ...issue },
  };
}
const keys = (items: PlanItem[], filter: PlanFilter = 'all', search = '') => planItems(items, search, filter).map(item => item.issue.key);

test('未完成优先，目标日期从近到远，缺日期最后，同日按任务编号稳定排序且不改输入', () => {
  const items = [plan('FAR', {}, { endDate: '2026-12-31' }), plan('MISSING'),
    plan('DONE', {}, { status: '已完成', statusCategory: '完成', endDate: '2026-10-01' }),
    plan('NEAR-B', {}, { endDate: '2026-11-04' }), plan('NEAR-A', {}, { dueDate: '2026-11-04' }),
    plan('START', {}, { startDate: '2026-11-05' })];
  const before = structuredClone(items);
  assert.deepEqual(keys(items), ['NEAR-A', 'NEAR-B', 'START', 'FAR', 'MISSING', 'DONE']);
  assert.deepEqual(items, before);
});

test('除了全部，每个筛选都排除已完成任务，符合派发规则不等于所有未派发任务', () => {
  const done = plan('DONE', { dispatchable: true, dependencyKeys: ['PRE'], jobStatus: 'blocked' },
    { status: 'Closed', statusCategory: 'done' });
  const eligible = plan('ELIGIBLE', { dispatchable: true });
  const blocked = plan('BLOCKED', { jobStatus: 'blocked' });
  const ineligible = plan('INELIGIBLE');
  const items = [done, eligible, blocked, ineligible];
  for (const filter of ['open', 'eligible', 'dependencies', 'blocked', 'unmatched'] as const) {
    assert.equal(keys(items, filter).includes('DONE'), false);
  }
  assert.deepEqual(keys(items, 'eligible'), ['ELIGIBLE']);
  assert.deepEqual(keys(items, 'blocked'), ['BLOCKED']);
  assert.equal(keys(items, 'blocked').includes('INELIGIBLE'), false);
});

test('等待前置来自真实依赖和未完成子任务，不根据下一步文案推测', () => {
  const items = [plan('DEPENDENCY', { dependencyKeys: ['PRE'] }),
    plan('PARENT', { childKeys: ['CHILD'] }, { subtasks: [{ key: 'CHILD', status: '待开始', statusCategory: '待办' }] }),
    plan('FINISHED-PARENT', { childKeys: ['DONE-CHILD'] }, { subtasks: [{ key: 'DONE-CHILD', status: '已完成', statusCategory: '完成' }] }),
    plan('UNKNOWN-PARENT', { childKeys: ['UNKNOWN'] }),
    plan('TEXT-ONLY', { action: '等待子任务汇总完成' })];
  assert.deepEqual(keys(items, 'dependencies'), ['DEPENDENCY', 'PARENT']);
});

test('计划中子任务完整状态优先于父项概要，缺少概要时仍识别已记录的未完成子项', () => {
  const items = [plan('PARENT', { childKeys: ['CHILD'] }, { subtasks: [{ key: 'CHILD', status: '待开始', statusCategory: '待办' }] }),
    plan('CHILD', {}, { status: '已完成', statusCategory: '完成' }),
    plan('OTHER-PARENT', { childKeys: ['OTHER-CHILD'] }), plan('OTHER-CHILD')];
  assert.deepEqual(keys(items, 'dependencies'), ['OTHER-PARENT']);
});

test('搜索包含项目、工作区、分支、父项和依赖，来源文案和对象保持原样', () => {
  const item = plan('APEX-123', { dependencyKeys: ['DEPEND-9'],
    workspace: { path: '/Users/test/repo', displayPath: '~/repo', branch: 'feature/recorded' } },
    { parent: { key: 'PARENT-1' }, summary: '服务返回 L_4321' });
  for (const term of ['商家项目', 'apex', '/Users/test/repo', 'feature/recorded', 'PARENT-1', 'DEPEND-9', 'L_1001', 'L_4321']) {
    assert.deepEqual(planItems([item], term, 'open'), [item]);
    assert.equal(planItems([item], term, 'open')[0], item);
  }
  assert.deepEqual(keys([item], 'all', 'missing'), []);
  assert.equal(item.action, '来源原文 L_1001');
  assert.equal(item.issue.summary, '服务返回 L_4321');
});

test('未匹配工作区只依据实际路径，不把已匹配计划误算在内', () => {
  const matched = plan('MATCHED', { workspace: { path: '/repo', displayPath: '/repo', branch: 'main' } });
  assert.deepEqual(keys([matched, plan('UNMATCHED')], 'unmatched'), ['UNMATCHED']);
});

test('项目未匹配或歧义即使已有工作区也保留待核对，原因原样显示并可搜索', () => {
  const profile = { ...emptyProjectProfile('app'), name: 'APP内嵌H5', repositoryUrl: 'git@example.test:app.git' };
  const base = { workspace: { path: '/work/app', displayPath: '/work/app', branch: 'test' } };
  const matched = plan('MATCHED', { ...base, projectRouting: { status: 'matched', reason: '组件 L_APP', profile, candidates: [profile] } });
  const ambiguous = plan('AMBIGUOUS', { ...base, projectRouting: { status: 'ambiguous', reason: ' L_ROUTING_002 ', profile: null, candidates: [profile] } });
  const incomplete = plan('INCOMPLETE', { ...base, projectRouting: { status: 'incomplete', reason: '启动命令待填写', profile, candidates: [profile] } });
  assert.deepEqual(keys([matched, ambiguous, incomplete], 'unmatched'), ['AMBIGUOUS', 'INCOMPLETE']);
  assert.deepEqual(planItems([matched], 'APP内嵌H5', 'open'), [matched]);
  assert.deepEqual(planItems([ambiguous], 'L_ROUTING_002', 'open'), [ambiguous]);
  assert.equal(ambiguous.projectRouting!.reason, ' L_ROUTING_002 ');
  assert.equal(projectRoutingLabel(matched.projectRouting), profile.name);
  assert.equal(projectRoutingLabel(ambiguous.projectRouting), '待选择项目');
  assert.equal(projectRoutingLabel(incomplete.projectRouting), 'APP内嵌H5 · 配置待完善');
  assert.equal(projectRoutingLabel(), '未记录项目匹配');
});

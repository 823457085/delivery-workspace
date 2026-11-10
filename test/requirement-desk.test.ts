import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyOverseasRequirement, mergeOverseasRequirements, type OverseasRequirement } from '../shared/overseas-requirements';
import { emptyRequirementProgress, type RequirementDevelopmentRecord } from '../shared/requirement-development';
import type { CatalogSystem } from '../shared/system-catalog';
import type { GroupRoomSummary } from '../shared/agent-group-chat';
import { deskRows, deskToday, matchesDeskFocus, requirementDeskRow } from '../src/features/requirement-development/requirement-desk';

const today = '2026-11-05';
test('外部接续需求跟随已关联群聊的实时状态；群聊完成不等于需求验收', () => {
  const group: GroupRoomSummary = { id: 'external-room', title: '需求接续 · OPAY-700', workspacePath: '/app', paused: false,
    state: 'completed', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' };
  const demand = item({ executionIds: [], groupRoomIds: [group.id], stage: 'verification', blocker: ' L_DEVICE_TEST_PENDING ', systems: [
    { name: 'APEX', status: 'verification', evidence: '', previewUrl: '' }, { name: 'App', status: 'verification', evidence: '', previewUrl: '' },
  ] });
  const derive = () => requirementDeskRow(demand, [], [], today, [group]);
  assert.equal(derive().targetGroupId, group.id); assert.equal(derive().action, 'team'); assert.equal(derive().accepted, false);
  assert.equal(derive().attention, true); assert.equal(derive().blocker, demand.blocker); assert.equal(derive().executionLabel, '本轮执行已结束');
  assert.deepEqual(derive().systems, ['APEX', 'App']);
  demand.blocker = ''; group.state = 'running'; group.activeMember = '前端开发';
  assert.equal(derive().running, true); assert.equal(derive().label, '前端开发正在处理');
  group.paused = true; group.waitingForLogin = true;
  assert.equal(derive().running, false); assert.equal(derive().label, '等待登录测试环境');
  demand.stage = 'development';
  const unreadable = requirementDeskRow(demand, [], [], today);
  assert.equal(unreadable.executionLabel, '群聊状态待核对'); assert.equal(unreadable.targetGroupId, group.id); assert.equal(unreadable.action, 'team');
  demand.groupRoomIds = [];
  assert.equal(derive().targetGroupId, undefined); assert.equal(derive().running, false);
});

test('人工验收之后的群聊失败或新结果重新进入待办，验收之前的历史失败不复活', () => {
  const group: GroupRoomSummary = { id: 'external-room', title: '已关联群聊', workspacePath: '/app', paused: false,
    state: 'failed', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' };
  const demand = item({ executionIds: [], groupRoomIds: [group.id], stage: 'accepted', updatedAt: '2026-11-05T01:00:00.000Z', acceptanceEvidence: '人工验收记录' });
  const derive = () => requirementDeskRow(demand, [], [], today, [group]);
  assert.equal(derive().accepted, true); assert.equal(derive().attention, false);
  group.updatedAt = '2026-11-05T02:00:00.000Z';
  assert.equal(derive().accepted, false); assert.equal(derive().attention, true); assert.equal(derive().tone, 'blocked');
  assert.equal(derive().targetGroupId, group.id);
  group.state = 'completed';
  assert.equal(derive().label, '新执行结果待复核'); assert.equal(derive().attention, true); assert.equal(derive().accepted, false);
});

test('混合开发记录和接续群聊按阻塞来源跳转，群聊暂不可读取仍保留原入口', () => {
  const group: GroupRoomSummary = { id: 'external-room', title: '接续群聊', workspacePath: '/app', paused: false,
    state: 'failed', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-05T02:00:00.000Z' };
  const legacy = record();
  const demand = item({ groupRoomIds: [group.id], stage: 'development' });
  const fromGroup = requirementDeskRow(demand, [legacy], [], today, [group]);
  assert.equal(fromGroup.tone, 'blocked'); assert.equal(fromGroup.target, undefined); assert.equal(fromGroup.targetGroupId, group.id);
  const unreadable = requirementDeskRow(demand, [legacy], [], today, []);
  assert.equal(unreadable.action, 'team'); assert.equal(unreadable.targetGroupId, group.id);
  assert.equal(requirementDeskRow({ ...demand, groupRoomIds: [] }, [legacy], [], today).action, 'develop');
  group.state = 'completed';
  legacy.runStatus = 'failed'; legacy.runError = ' L_RECORD_FAILURE '; delete legacy.groupRoomId;
  const fromRecord = requirementDeskRow(demand, [legacy], [], today, [group]);
  assert.equal(fromRecord.blocker, legacy.runError); assert.equal(fromRecord.target?.runId, legacy.runId);
  assert.equal(fromRecord.targetGroupId, undefined); assert.equal(fromRecord.action, 'team');
});
function record(id = 'task-1'): RequirementDevelopmentRecord {
  return { id, status: 'started', runStatus: 'completed', runId: `run-${id}`, workspacePath: '/isolated/repo', headSha: 'abc', error: '',
    createdAt: '2026-11-04T00:00:00.000Z', groupRoomId: `group-${id}`,
    input: { title: ' L_SOURCE_TITLE ', issueKey: 'APEX-123', prdUrl: '', requirement: ' L_BODY ', project: 'APEX', fixVersion: '', assignee: '',
      startDate: '2026-11-04', endDate: '2026-11-06', repository: 'git@example.test:org/repo.git', parentDirectory: '/isolated', branch: 'feature/APEX-123', confluenceParentUrl: '' },
    progress: { ...emptyRequirementProgress(), source: 'agent-result', sourceRunId: `run-${id}`, revision: 1, updatedAt: '2026-11-05T00:00:00.000Z' } };
}
function item(overrides: Partial<OverseasRequirement> = {}): OverseasRequirement {
  return { ...emptyOverseasRequirement('demand-1'), title: ' L_SOURCE_TITLE ', stage: 'unconfirmed',
    executionIds: ['task-1'], createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', ...overrides };
}
const row = (value: OverseasRequirement, records: RequirementDevelopmentRecord[] = [], catalog: CatalogSystem[] = []) => requirementDeskRow(value, records, catalog, today);
function system(name: string, repository: string): CatalogSystem {
  return { id: name, name, repository, region: '海外', environments: [], source: { id: 'doc', title: '目录', url: 'https://example.test/doc', version: 1 } };
}

test('执行完成与业务完成分开：两个验证阻塞和一个未完成验证均进入今日待办', () => {
  const records = [record('task-1'), record('task-2'), record('task-3')];
  records.forEach(value => { value.progress!.stages.development = { status: 'completed', evidence: '构建通过' }; });
  records[0].progress!.stages.verification = { status: 'blocked', evidence: ' L_AUTH_902：登录失败\n真实流程未验证 ' };
  records[1].progress!.stages.verification = { status: 'blocked', evidence: '需要完整接口契约' };
  records[2].progress!.stages.verification = { status: 'in_progress', evidence: '仍有失败场景' };
  const rows = deskRows(mergeOverseasRequirements([], records), records, [], today);
  assert.equal(rows.filter(value => value.tone === 'blocked').length, 2);
  assert.equal(rows.filter(value => value.attention).length, 3);
  assert.equal(rows.filter(value => value.accepted || value.awaitingAcceptance || value.running).length, 0);
  assert.equal(rows.find(value => value.item.id === 'task-3')!.label, '验证尚未完成');
  const blocked = rows.find(value => value.item.id === 'task-1')!;
  assert.equal(blocked.blocker, records[0].progress!.stages.verification.evidence);
  assert.equal(blocked.item.title, ' L_SOURCE_TITLE ');
  assert.equal(blocked.action, 'team'); assert.equal(blocked.target?.groupRoomId, 'group-task-1');
});

test('旧运行的报告不污染本轮阻塞、阶段或更新时间', () => {
  const value = record();
  value.progress!.sourceRunId = 'old-run'; value.progress!.updatedAt = '2026-11-05T12:00:00.000Z';
  value.progress!.stages.verification = { status: 'blocked', evidence: '旧登录阻塞' };
  const result = row(item(), [value]);
  assert.equal(result.tone, 'review'); assert.equal(result.label, '执行结果待核对');
  assert.equal(result.blocker, ''); assert.deepEqual(result.blockers, []); assert.deepEqual(result.stages, []);
  assert.equal(result.evidenceAt, value.createdAt); assert.equal(result.staleReport, true);
});

test('人工验收保留；验收后新阶段结果或活动执行仍需复核', () => {
  const value = record(); value.progress!.stages.verification = { status: 'blocked', evidence: '验收前的旧记录' };
  const accepted = item({ stage: 'accepted', acceptanceEvidence: '人工实测通过', updatedAt: '2026-11-05T01:00:00.000Z', endDate: '2026-11-01' });
  const old = row(accepted, [value]);
  assert.equal(old.accepted, true); assert.equal(old.attention, false); assert.equal(old.overdue, false); assert.equal(old.blocker, '');
  value.progress!.updatedAt = '2026-11-05T02:00:00.000Z';
  assert.equal(row(accepted, [value]).accepted, false); assert.equal(row(accepted, [value]).tone, 'blocked');
  value.progress!.stages.verification = { status: 'completed', evidence: '新验证记录' };
  assert.equal(row(accepted, [value]).label, '新执行结果待复核');
  value.progress!.updatedAt = '2026-11-05T00:00:00.000Z'; value.runStatus = 'running';
  const active = row(accepted, [value]);
  assert.equal(active.running, true); assert.equal(active.accepted, false); assert.equal(active.label, '团队正在执行');
});

test('活动执行按实际运行显示；暂停、登录等待和失败均能找到对应记录', () => {
  const value = record(); value.progress = undefined;
  for (const state of ['queued', 'running'] as const) {
    value.groupProgress = { roomId: 'group-task-1', state, activeMember: '前端开发', completed: 1, total: 5, error: '' };
    const active = row(item(), [value]);
    assert.equal(active.running, true); assert.equal(active.attention, false); assert.equal(active.action, 'team');
  }
  value.groupProgress!.state = 'paused'; value.groupProgress!.waitingForLogin = true;
  const login = row(item(), [value]);
  assert.equal(login.label, '等待登录测试环境'); assert.equal(login.attention, true); assert.equal(login.running, false);
  value.groupProgress = undefined; value.runStatus = 'failed'; value.runError = ' L_PERMISSION_DENIED ';
  const failed = row(item(), [value]);
  assert.equal(failed.blocker, value.runError); assert.equal(failed.target?.id, value.id); assert.equal(failed.tone, 'blocked');
  value.runStatus = 'completed'; value.status = 'preparing';
  assert.equal(row(item(), [value]).running, true);
});

test('系统只按完整仓库关联并保留自定义系统，不按 Jira 前缀或标题猜测', () => {
  const value = record();
  const registered = item({ systems: [{ name: '自定义业务', status: 'verification', evidence: '待验证', previewUrl: '' }] });
  const result = row(registered, [value], [system('真实管理后台', 'https://example.test/org/repo'),
    system('同名不同组织', 'https://example.test/other/repo.git'), system('APEX', ''), system('其他主机', 'https://other.test/org/repo.git')]);
  assert.deepEqual(result.systems, ['自定义业务', '真实管理后台']);
  assert.equal(registered.systems.length, 1); assert.equal(registered.systems[0].status, 'verification');
});

test('交付日期使用新加坡日历，今日与七天边界一致，未来排期保留在台账', () => {
  assert.equal(deskToday(new Date('2026-11-04T15:59:59.000Z')), '2026-11-04');
  assert.equal(deskToday(new Date('2026-11-04T16:00:00.000Z')), '2026-11-05');
  for (const [endDate, overdue, dueSoon] of [['2026-11-04', true, false], ['2026-11-05', false, true], ['2026-11-12', false, true], ['2026-11-13', false, false]] as const) {
    const result = row(item({ endDate, executionIds: [] }));
    assert.equal(result.overdue, overdue); assert.equal(result.dueSoon, dueSoon);
  }
  const future = row(item({ stage: 'planned', startDate: '2026-11-10', executionIds: [] }));
  assert.equal(matchesDeskFocus(future, 'attention'), false); assert.equal(matchesDeskFocus(future, 'all'), true);
  assert.equal(row(item({ stage: 'acceptance', executionIds: [] })).awaitingAcceptance, true);
});

test('多个关联执行定位到真正阻塞的任务，待办排序与筛选不靠会话完成比例', () => {
  const old = record('task-1'), affected = record('task-2');
  old.progress!.updatedAt = '2026-11-05T02:00:00.000Z';
  affected.progress!.stages.verification = { status: 'blocked', evidence: '接口未打通' };
  const blocked = row(item({ executionIds: [old.id, affected.id] }), [old, affected]);
  assert.equal(blocked.target?.id, affected.id);
  const values = deskRows([item({ id: 'planning', stage: 'planned', executionIds: [] }), item({ id: 'acceptance', stage: 'acceptance', executionIds: [] }),
    item({ id: 'blocked', executionIds: [affected.id] })], [affected], [], today);
  assert.deepEqual(values.map(value => value.item.id), ['blocked', 'acceptance', 'planning']);
  assert.equal(values.filter(value => matchesDeskFocus(value, 'acceptance')).length, 1);
  assert.equal(values.filter(value => matchesDeskFocus(value, 'running')).length, 0);
});

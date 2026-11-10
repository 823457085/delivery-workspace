import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProjectProfile, projectProfileError, selectProfileProject, validDeliverySettings } from '../src/features/delivery-settings/domain.js';
import type { AutomationSettings, LocalProject } from '../shared/hub.js';
import { requestProjectPreview } from '../src/features/delivery-settings/project-preview.js';

const settings: AutomationSettings = { enabled: false, dailyTime: '09:00', dailyTimes: ['09:00', '19:00'], maxDispatchPerRun: 8, autoCreateCodex: false, autoCreateMergeRequest: false, autoTransitionJira: false, startStatus: '开始', completedStatus: '完成', targetBranch: 'feature/test', reviewer: '' };
test('dispatch quantity preserves original zero-unlimited semantics and no invented cap of 100', () => {
  for (const maxDispatchPerRun of [0, 1, 8, 101]) assert.equal(validDeliverySettings({ ...settings, maxDispatchPerRun }), true);
  for (const maxDispatchPerRun of [-1, 1.2, NaN, Infinity]) assert.equal(validDeliverySettings({ ...settings, maxDispatchPerRun }), false);
});
test('invalid schedule and required status or branch remain blocked', () => {
  assert.equal(validDeliverySettings(), false);
  for (const dailyTimes of [[], ['24:00'], ['09:60'], ['']]) assert.equal(validDeliverySettings({ ...settings, dailyTimes }), false);
  for (const field of ['startStatus', 'completedStatus', 'targetBranch']) assert.equal(validDeliverySettings({ ...settings, [field]: ' ' }), false);
});

test('每个项目独立校验运行配置，不要求废弃的全局目标分支', () => {
  const profile = { ...emptyProjectProfile('app'), name: 'APP内嵌H5', repositoryUrl: 'git@example.test:merchant-front.git',
    runtimeCommand: 'npm run serve', runtimeEnvironment: 'i18n-test', targetBranch: 'feature/app' };
  assert.equal(validDeliverySettings({ ...settings, targetBranch: '', projectProfiles: [profile] }), true);
  for (const field of ['name', 'repositoryUrl', 'runtimeCommand', 'runtimeEnvironment', 'targetBranch'] as const) {
    const incomplete = { ...profile, [field]: ' ' };
    assert.equal(validDeliverySettings({ ...settings, projectProfiles: [profile, incomplete] }), false, field);
    assert.ok(projectProfileError(incomplete));
  }
  assert.equal(validDeliverySettings({ ...settings, projectProfiles: [] }), true, '没有项目配置时仍可保存暂停等策略');
  assert.deepEqual(profile.jiraProjects, [], '空规则留给后端仓库或工作区匹配，不伪造默认Key');
});

test('切换本机项目只填真实项目身份，不继承旧项目的启动命令环境或分支', () => {
  const previous = { ...emptyProjectProfile('route'), name: 'APEX', localPath: '/work/apex', repositoryUrl: 'git@example.test:apex.git',
    runtimeCommand: 'pnpm dev:apex', runtimeEnvironment: 'dev-apex', targetBranch: 'develop' };
  const local = { displayName: 'APP', projectName: 'merchant-front', folderName: 'merchant-front', path: '/work/app',
    remoteUrl: 'git@example.test:merchant-front.git' } as LocalProject;
  const next = selectProfileProject(previous, local);
  assert.equal(next.id, previous.id); assert.equal(next.name, 'APP'); assert.equal(next.localPath, local.path);
  assert.equal(next.repositoryUrl, local.remoteUrl);
  assert.deepEqual([next.runtimeCommand, next.runtimeEnvironment, next.targetBranch], ['', '', '']);
  assert.equal(previous.runtimeCommand, 'pnpm dev:apex');
  const configured = { ...next, runtimeCommand: 'npm run serve', runtimeEnvironment: 'test', targetBranch: 'test' };
  assert.deepEqual(selectProfileProject(configured, local), configured, '重选同一项目保留人工配置');
  assert.equal(emptyProjectProfile('new').runtimeCommand, '');
});

test('项目匹配预览发送未保存表单到只读接口，不调用保存或巡检', async () => {
  const draft = { ...settings, projectProfiles: [{ ...emptyProjectProfile('draft'), name: '尚未保存的项目' }] };
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const preview = { plan: [], source: 'snapshot', checkedAt: '2026-11-05T12:00:00Z', issueCount: 0 };
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(preview), { status: 200 });
  };
  assert.deepEqual(await requestProjectPreview(draft, request), preview);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/automation/project-preview');
  assert.equal(calls[0].options?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { settings: draft });
  assert.equal(draft.projectProfiles[0].runtimeCommand, '', '不为不完整草稿填入其他项目命令');
});

test('项目匹配预览失败保留接口原始文案', async () => {
  const request: typeof fetch = async () => new Response(JSON.stringify({ message: 'L_001：快照不可用' }), { status: 503 });
  await assert.rejects(requestProjectPreview(settings, request), { message: 'L_001：快照不可用' });
});

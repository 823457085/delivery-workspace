import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, ref, shallowRef, watch, type Ref } from 'vue';
import { emptyProjectProfile, projectProfileError, selectProfileProject, validDeliverySettings } from '../src/features/delivery-settings/domain.js';
import type { AutomationProjectProfile, AutomationSettings, LocalProject } from '../shared/hub.js';

const source = readFileSync(new URL('../src/features/delivery-settings/DeliverySettings.vue', import.meta.url), 'utf8');
const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
const tree = ts.createSourceFile('DeliverySettings.ts', script, ts.ScriptTarget.Latest, true);
// 执行真实 SFC 状态、watch 和编辑/保存函数，只替换查询及写入请求边界。
const code = ts.transpileModule(tree.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const profile = (id: string): AutomationProjectProfile => ({ ...emptyProjectProfile(id), name: `项目 ${id}`,
  localPath: `/fixture/${id}`, repositoryUrl: `git@example.test:${id}.git`, runtimeCommand: `pnpm dev:${id}`,
  runtimeEnvironment: `test-${id}`, targetBranch: `feature/${id}`, jiraProjects: [`KEY-${id}`], components: ['原组件'], labels: ['原标签'] });
const settings = (): AutomationSettings => ({ enabled: false, dailyTime: '09:00', dailyTimes: ['09:00', '19:00'], maxDispatchPerRun: 0,
  autoCreateCodex: false, autoTransitionJira: false, autoCreateMergeRequest: false, startStatus: '开始', completedStatus: '完成',
  targetBranch: 'feature/original', reviewer: 'reviewer', runtimeEnvironment: 'test', runtimeCommand: 'pnpm dev', browser: 'Chrome',
  repositoryUrl: 'git@example.test:original.git', projectProfiles: ['a', 'b', 'c'].map(profile) });

interface EditorState {
  form: Ref<AutomationSettings>; dirty: Ref<boolean>; saving: Ref<boolean>; valid: Ref<boolean>;
  projectDraft: Ref<AutomationProjectProfile | undefined>; projectEditorOpen: Ref<boolean>;
  editProject(profile: AutomationProjectProfile): void; addProject(): void; applyProject(): void;
  chooseProject(profile: AutomationProjectProfile, path: string): void; reset(): void; save(): Promise<void>;
}

function fixture() {
  const data = ref({ settings: settings() });
  const local = { displayName: '新本机项目', projectName: 'next', folderName: 'next', path: '/fixture/next', remoteUrl: 'git@example.test:next.git' } as LocalProject;
  const writes: { key: string; payload: Record<string, unknown>; confirmation: string[] }[] = [];
  const bindings = { computed, ref, shallowRef, watch, crypto: { randomUUID },
    onMounted() {}, onBeforeUnmount() {}, useRoute: () => ({ query: {} }), useRouter: () => ({ replace() {} }),
    useSource: (key: string) => ({ data: key === 'automation' ? data : ref(key === 'projects' ? { projects: [local] } : {}),
      error: ref(null), isPending: ref(false), isFetching: ref(false) }),
    useSourceActions: () => ({ execute: async (key: string, payload: Record<string, unknown>, ...confirmation: string[]) => {
      writes.push({ key, payload: copy(payload), confirmation }); return false;
    } }), emptyProjectProfile, projectProfileError, selectProfileProject, validDeliverySettings,
  };
  const lifetime = effectScope();
  const state = lifetime.run(() => new Function(...Object.keys(bindings), `${code}\nreturn {
    form, dirty, saving, valid, projectDraft, projectEditorOpen, editProject, addProject, applyProject, chooseProject, reset, save };
  `)(...Object.values(bindings))) as EditorState;
  return { state, data, writes, local, close: () => lifetime.stop() };
}

test('编辑草稿深拷贝规则数组，取消/关闭不污染表单和已保存查询', async () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value), saved = copy(f.data.value);
    f.state.editProject(f.state.form.value.projectProfiles![1]);
    assert.equal(f.state.projectEditorOpen.value, true);
    const draft = f.state.projectDraft.value!;
    draft.name = '未应用修改'; draft.jiraProjects.push('NEW'); draft.components.splice(0, 1, '草稿组件'); draft.labels.push('草稿标签');
    f.state.projectEditorOpen.value = false;
    await nextTick();
    assert.deepEqual(f.state.form.value, before); assert.deepEqual(f.data.value, saved);
    assert.equal(f.state.dirty.value, false); assert.equal(f.writes.length, 0);
    f.state.editProject(f.state.form.value.projectProfiles![1]);
    assert.deepEqual(f.state.projectDraft.value, before.projectProfiles![1], '重新编辑丢弃上次未应用的草稿');
    f.state.form.value.reviewer = '已有未保存修改';
    f.state.projectDraft.value!.labels.push('另一草稿'); f.state.projectEditorOpen.value = false;
    assert.equal(f.state.form.value.reviewer, '已有未保存修改'); assert.equal(f.state.dirty.value, true);
    assert.deepEqual(f.state.form.value.projectProfiles, before.projectProfiles);
  } finally { f.close(); }
});

test('新增取消不留下无效项目，填写完整后应用只追加到本地表单', () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value.projectProfiles);
    f.state.addProject();
    const cancelledId = f.state.projectDraft.value!.id;
    assert.ok(cancelledId); assert.ok(projectProfileError(f.state.projectDraft.value!));
    f.state.projectEditorOpen.value = false;
    assert.deepEqual(f.state.form.value.projectProfiles, before); assert.equal(f.state.valid.value, true);
    assert.equal(f.state.dirty.value, false);
    f.state.addProject();
    const id = f.state.projectDraft.value!.id;
    assert.notEqual(id, cancelledId);
    Object.assign(f.state.projectDraft.value!, profile(id)); f.state.applyProject();
    assert.deepEqual(f.state.form.value.projectProfiles, [...before!, profile(id)]);
    assert.equal(f.state.projectEditorOpen.value, false); assert.equal(f.state.dirty.value, true);
    assert.equal(f.writes.length, 0); assert.equal(f.data.value.settings.projectProfiles!.length, 3);
  } finally { f.close(); }
});

test('应用按 id 原位替换并保留未编辑字段，应用后仍与草稿数组隔离', () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value.projectProfiles!);
    f.state.editProject(f.state.form.value.projectProfiles![1]);
    f.state.projectDraft.value!.name = '修改项目名'; f.state.projectDraft.value!.labels.push('新增标签');
    f.state.applyProject();
    assert.deepEqual(f.state.form.value.projectProfiles, [before[0], { ...before[1], name: '修改项目名', labels: ['原标签', '新增标签'] }, before[2]]);
    assert.deepEqual(f.state.form.value.projectProfiles!.map(item => item.id), ['a', 'b', 'c']);
    f.state.projectDraft.value!.jiraProjects.push('未应用规则');
    assert.deepEqual(f.state.form.value.projectProfiles![1].jiraProjects, before[1].jiraProjects);
    assert.deepEqual(f.data.value.settings.projectProfiles, before); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('必填无效或正在保存时不应用草稿，仍可修正后应用', () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value);
    for (const field of ['name', 'repositoryUrl', 'runtimeCommand', 'runtimeEnvironment', 'targetBranch'] as const) {
      f.state.editProject(f.state.form.value.projectProfiles![0]); f.state.projectDraft.value![field] = ' ';
      f.state.applyProject();
      assert.deepEqual(f.state.form.value, before, field); assert.equal(f.state.projectEditorOpen.value, true);
    }
    f.state.editProject(f.state.form.value.projectProfiles![0]); f.state.projectDraft.value!.name = '有效草稿';
    f.state.saving.value = true; f.state.applyProject();
    assert.deepEqual(f.state.form.value, before); assert.equal(f.state.dirty.value, false);
    f.state.saving.value = false; f.state.applyProject();
    assert.equal(f.state.form.value.projectProfiles![0].name, '有效草稿'); assert.equal(f.state.dirty.value, true);
  } finally { f.close(); }
});

test('草稿选择新本机项目清空旧运行配置，未应用时不污染表单或 dirty', () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value);
    f.state.editProject(f.state.form.value.projectProfiles![0]);
    const draft = f.state.projectDraft.value!;
    f.state.chooseProject(draft, f.local.path);
    assert.equal(draft.localPath, f.local.path); assert.equal(draft.name, f.local.displayName);
    assert.equal(draft.repositoryUrl, f.local.remoteUrl);
    assert.deepEqual([draft.runtimeCommand, draft.runtimeEnvironment, draft.targetBranch], ['', '', '']);
    assert.deepEqual(draft.jiraProjects, before.projectProfiles![0].jiraProjects);
    assert.deepEqual(f.state.form.value, before); assert.equal(f.state.dirty.value, false);
    f.state.applyProject();
    assert.deepEqual(f.state.form.value, before, '新项目缺少运行必填字段时不可应用');
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('抽屉打开时后台 refetch 不 reset，关闭后的新回读仍可刷新干净表单', async () => {
  const f = fixture();
  try {
    const before = copy(f.state.form.value);
    f.state.editProject(f.state.form.value.projectProfiles![0]); f.state.projectDraft.value!.name = '正在输入';
    const refreshed = settings(); refreshed.reviewer = '远端新审核人'; refreshed.projectProfiles![0].name = '远端新项目名';
    f.data.value = { settings: refreshed }; await nextTick();
    assert.equal(f.state.projectEditorOpen.value, true); assert.equal(f.state.projectDraft.value!.name, '正在输入');
    assert.deepEqual(f.state.form.value, before); assert.equal(f.state.dirty.value, false);
    f.state.projectEditorOpen.value = false;
    f.data.value = { settings: copy(refreshed) }; await nextTick();
    assert.equal(f.state.form.value.reviewer, '远端新审核人'); assert.equal(f.state.projectDraft.value, undefined);
    assert.equal(f.state.dirty.value, false); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('草稿编辑和应用不远端写入，最终保存仅发送原设置 payload 的已应用配置', async () => {
  const f = fixture();
  try {
    f.state.editProject(f.state.form.value.projectProfiles![0]); f.state.projectDraft.value!.name = '已应用名字';
    f.state.applyProject();
    f.state.editProject(f.state.form.value.projectProfiles![1]); f.state.projectDraft.value!.name = '未应用名字';
    assert.equal(f.writes.length, 0);
    const value = copy(f.state.form.value);
    await f.state.save();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].key, 'settings');
    assert.deepEqual(f.writes[0].payload, {
      dailyTime: value.dailyTimes[0], dailyTimes: value.dailyTimes, maxDispatchPerRun: value.maxDispatchPerRun,
      startStatus: value.startStatus, completedStatus: value.completedStatus, targetBranch: value.targetBranch, reviewer: value.reviewer,
      runtimeEnvironment: value.runtimeEnvironment, runtimeCommand: value.runtimeCommand, browser: value.browser, repositoryUrl: value.repositoryUrl,
      projectProfiles: value.projectProfiles, enabled: value.enabled, autoCreateCodex: value.autoCreateCodex,
      autoPrepareJiraDev: false, autoTransitionJira: value.autoTransitionJira, autoCreateMergeRequest: value.autoCreateMergeRequest,
      jiraDevAutomationApproved: false,
    });
    assert.equal(f.writes[0].confirmation[0], '确认保存自动交付设置');
    assert.equal((f.writes[0].payload.projectProfiles as AutomationProjectProfile[])[1].name, '项目 b');
    assert.equal(f.state.saving.value, false); assert.equal(f.state.dirty.value, true, '确认取消后保留未保存表单');
    f.state.form.value.dailyTimes.push('09:00'); await f.state.save();
    assert.equal(f.writes.length, 1, '无效总表单仍由原保存校验阻止写入');
  } finally { f.close(); }
});

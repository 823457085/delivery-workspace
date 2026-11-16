<script setup lang="ts">
/** 交付与连接设置：集中管理 Jira 连接、本地项目扫描目录、多平台 Agent 模型默认值、CLI 队列与自动交付策略。 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { AutomationData, AutomationProjectPreview, AutomationProjectProfile, AutomationSettings, ProjectsData } from '../../../shared/hub';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { useSource, useSourceActions } from '../../shared/api';
import { safeUrl, dateTime, isDone } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { emptyProjectProfile, projectProfileError, selectProfileProject, validDeliverySettings } from './domain';
import { requestProjectPreview } from './project-preview';
import { projectRoutingLabel } from '../auto-delivery/plan-list';
import ShareConnectionCard from './ShareConnectionCard.vue';
import ChromeConnectionCard from '../browser-connection/ChromeConnectionCard.vue';

const CliExecutorCard = defineAsyncComponent(() => import('./CliExecutorCard.vue'));
const AgentModelDefaultsCard = defineAsyncComponent(() => import('./AgentModelDefaultsCard.vue'));
const IntegrationPluginsCard = defineAsyncComponent(() => import('./IntegrationPluginsCard.vue'));
const CustomPluginManager = defineAsyncComponent(() => import('../custom-plugins/CustomPluginManager.vue'));
const WorkspaceReportsCard = defineAsyncComponent(() => import('./WorkspaceReportsCard.vue'));
const WorkspaceStorageCard = defineAsyncComponent(() => import('./WorkspaceStorageCard.vue'));

const integrations = useIntegrationPlugins();
const route = useRoute(), router = useRouter();
const settingsRoot = ref<HTMLElement>();
const settingsTabPosition = shallowRef<'top' | 'left'>('top');
let settingsResize: ResizeObserver | undefined;
function onSettingsKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    if (dirty.value) {
      event.preventDefault();
      if (valid.value && !saving.value) void save();
    }
  }
}
onMounted(() => {
  window.addEventListener('keydown', onSettingsKeydown);
  if (!settingsRoot.value) return;
  settingsResize = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    settingsTabPosition.value = width >= 920 && height >= 220 ? 'left' : 'top';
  });
  settingsResize.observe(settingsRoot.value);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onSettingsKeydown);
  settingsResize?.disconnect();
});
const settingsTabs = ['connections', 'plugins', 'models', 'automation', 'reports', 'runtime'];
const activeTab = computed({
  get: () => typeof route.query.settingsTab === 'string' && settingsTabs.includes(route.query.settingsTab) ? route.query.settingsTab : 'connections',
  set: value => { void router.replace({ query: { ...route.query, settingsTab: value } }); },
});

const projectEditorOpen = shallowRef(false);
const query = useSource<AutomationData>('automation');
const projects = useSource<ProjectsData>('projects', {}, false, { active: projectEditorOpen });
const { data, error, isPending, isFetching } = query;
const form = ref<AutomationSettings>();
const dirty = shallowRef(false);
const saving = shallowRef(false);
const projectDraft = ref<AutomationProjectProfile>();
const actions = useSourceActions();
const projectPreview = shallowRef<AutomationProjectPreview>();
const previewing = shallowRef(false);
const previewOnlyOpen = shallowRef(true);
const previewRows = computed(() => (projectPreview.value?.plan || []).filter(item => !previewOnlyOpen.value || !isDone(item.issue)));
const settingsFingerprint = computed(() => JSON.stringify(form.value));
let savedSettingsFingerprint = '';
watch(settingsFingerprint, fingerprint => {
  projectPreview.value = undefined;
  if (form.value) dirty.value = fingerprint !== savedSettingsFingerprint;
}, { flush: 'sync' });

async function previewProjects() {
  if (!form.value || previewing.value) return;
  const fingerprint = settingsFingerprint.value;
  projectPreview.value = undefined;
  previewing.value = true;
  try {
    const preview = await requestProjectPreview(form.value);
    if (settingsFingerprint.value === fingerprint) projectPreview.value = preview;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '项目匹配预览失败');
  } finally { previewing.value = false; }
}

function reset() {
  if (data.value) {
    projectEditorOpen.value = false;
    projectDraft.value = undefined;
    const settings: AutomationSettings = JSON.parse(JSON.stringify(data.value.settings));
    settings.projectProfiles ||= [];
    settings.autoPrepareJiraDev ??= false;
    settings.jiraDevAutomationApproved ??= false;
    savedSettingsFingerprint = JSON.stringify(settings);
    form.value = settings;
    dirty.value = false;
  }
}
watch(
  data,
  () => {
    if (!dirty.value && !projectEditorOpen.value) reset();
  },
  { immediate: true },
);
const valid = computed(() => validDeliverySettings(form.value) && new Set(form.value?.dailyTimes).size === form.value?.dailyTimes.length);
const approvalPending = computed(() => !!form.value && form.value.enabled && !form.value.jiraDevAutomationApproved
  && (form.value.autoCreateCodex || form.value.autoTransitionJira || form.value.autoCreateMergeRequest));
function addTime() {
  if (!form.value) return;
  const next = ['09:00', '12:00', '18:00', '21:00'].find(time => !form.value!.dailyTimes.includes(time)) || '00:00';
  form.value.dailyTimes.push(next); dirty.value = true;
}
function removeTime(index: number) { if (form.value && form.value.dailyTimes.length > 1) { form.value.dailyTimes.splice(index, 1); dirty.value = true; } }
function addProject() {
  if (!form.value) return;
  projectDraft.value = emptyProjectProfile(crypto.randomUUID());
  projectEditorOpen.value = true;
}
function editProject(profile: AutomationProjectProfile) {
  projectDraft.value = JSON.parse(JSON.stringify(profile));
  projectEditorOpen.value = true;
}
function applyProject() {
  if (!form.value || !projectDraft.value || projectProfileError(projectDraft.value) || saving.value) return;
  const profiles = form.value.projectProfiles ||= [];
  const profile: AutomationProjectProfile = JSON.parse(JSON.stringify(projectDraft.value));
  const index = profiles.findIndex(item => item.id === profile.id);
  if (index < 0) profiles.push(profile);
  else profiles.splice(index, 1, profile);
  projectEditorOpen.value = false;
}
function removeProject(id: string) {
  if (!form.value) return;
  form.value.projectProfiles = form.value.projectProfiles?.filter(profile => profile.id !== id); dirty.value = true;
}
function chooseProject(profile: AutomationProjectProfile, path: string) {
  if (!path) { profile.localPath = ''; return; }
  const project = projects.data.value?.projects.find(project => project.path === path);
  if (!project) return;
  Object.assign(profile, selectProfileProject(profile, project));
}

async function save() {
  if (!form.value || !valid.value || saving.value) return;
  const value = form.value;
  const payload = {
    dailyTime: value.dailyTimes[0],
    dailyTimes: [...value.dailyTimes],
    maxDispatchPerRun: value.maxDispatchPerRun,
    startStatus: value.startStatus,
    completedStatus: value.completedStatus,
    targetBranch: value.targetBranch,
    reviewer: value.reviewer,
    runtimeEnvironment: value.runtimeEnvironment,
    runtimeCommand: value.runtimeCommand,
    browser: value.browser,
    repositoryUrl: value.repositoryUrl,
    projectProfiles: JSON.parse(JSON.stringify(value.projectProfiles || [])),
    enabled: value.enabled,
    autoCreateCodex: value.autoCreateCodex,
    autoPrepareJiraDev: value.autoPrepareJiraDev,
    autoTransitionJira: value.autoTransitionJira,
    autoCreateMergeRequest: value.autoCreateMergeRequest,
    jiraDevAutomationApproved: value.enabled && (value.autoCreateCodex || value.autoTransitionJira || value.autoCreateMergeRequest),
  };
  const effects = [
    `自动巡检${value.enabled ? '启用' : '暂停'}。研发预览${value.autoPrepareJiraDev ? '开启' : '关闭'}。`,
    value.enabled && value.autoCreateCodex ? (value.autoPrepareJiraDev
      ? '符合条件的实现事项生成预览，确认后开始。其他自动派发按已有规则执行。'
      : '符合条件且无需 Jira 写入确认的实现事项，可由本机 Codex 通过需求开发或 Jira 修复自动启动。') : '自动创建 Codex 任务关闭或暂停。',
    value.enabled && value.autoTransitionJira ? `两条流程启动后可将绑定事项推进至「${value.startStatus}」，验证及所选交付步骤通过后可推进至「${value.completedStatus}」。` : '自动推进 Jira 状态关闭或暂停。',
    value.enabled && value.autoCreateMergeRequest ? `授权符合项目匹配的研发任务在验证通过后提交、推送本次任务分支，并按项目目标分支和审核人「${value.reviewer || '尚未配置'}」创建 MR。` : '自动创建合并请求关闭或暂停。',
  ].join(' ');
  saving.value = true;
  try {
    const ok = await actions.execute(
      'settings',
      payload,
      '确认保存自动交付设置',
      effects,
      { skipConfirm: !approvalPending.value },
    );
    if (ok) {
      dirty.value = false;
      reset();
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div ref="settingsRoot" class="delivery-settings">
    <PageHeading title="连接与策略设置" description="按连接、执行、自动交付与汇报分别管理；切换分栏会保留未保存的内容。" :loading="isFetching" @refresh="query.refetch()" />
    <section v-if="data" class="settings-readiness-strip" aria-label="交付策略态势摘要">
      <button type="button" class="settings-readiness-card" :class="{ 'is-active': (form?.enabled ?? data.settings.enabled) }" @click="activeTab = 'automation'">
        <span>自动巡检引擎</span>
        <strong>{{ (form?.enabled ?? data.settings.enabled) ? '已启用' : '已暂停' }}</strong>
        <small>下次巡检 {{ dateTime(data.nextRun) }}</small>
      </button>
      <button type="button" class="settings-readiness-card" @click="activeTab = 'automation'">
        <span>路由绑定项目</span>
        <strong>{{ form?.projectProfiles?.length ?? data.settings.projectProfiles?.length ?? 0 }} 个仓库</strong>
        <small>单轮上限 {{ (form?.maxDispatchPerRun ?? data.settings.maxDispatchPerRun) || '不限制' }}</small>
      </button>
      <button type="button" class="settings-readiness-card" @click="activeTab = 'runtime'">
        <span>每日巡检窗口</span>
        <strong>{{ ((form?.dailyTimes?.length ? form.dailyTimes : data.settings.dailyTimes) || []).join(' · ') || '—' }}</strong>
        <small>{{ (form?.startStatus ?? data.settings.startStatus) || '开始' }} → {{ (form?.completedStatus ?? data.settings.completedStatus) || '完成' }}</small>
      </button>
      <button type="button" class="settings-readiness-card" :class="{ 'is-dirty': dirty }" @click="activeTab = 'automation'">
        <span>策略同步状态</span>
        <strong>{{ dirty ? '有未保存更改' : '已同步本机' }}</strong>
        <small>{{ dirty ? '支持 ⌘S 快速保存自动交付策略' : `浏览器 ${data.settings.browser || '默认'}` }}</small>
      </button>
    </section>
    <el-tabs v-model="activeTab" :tab-position="settingsTabPosition" class="settings-tabs" aria-label="设置分类">
      <el-tab-pane label="连接与项目" name="connections" tabindex="0"><ChromeConnectionCard :active="activeTab === 'connections'" /><ShareConnectionCard /></el-tab-pane>
      <el-tab-pane label="接入插件" name="plugins" lazy tabindex="0"><IntegrationPluginsCard /><CustomPluginManager /></el-tab-pane>
      <el-tab-pane label="模型与执行" name="models" lazy tabindex="0"><AgentModelDefaultsCard /><CliExecutorCard /></el-tab-pane>
      <el-tab-pane label="自动交付" name="automation" lazy tabindex="0"><p v-if="!integrations.capability('issues.read')" role="status">任务提供者未接入或不可用。原策略保留，相关巡检与派发已暂停，请先在插件管理中恢复连接。</p>
        <QueryState :loading="isPending" :error="error" :has-data="!!data && !!form" @retry="query.refetch()">
          <div v-if="form && data" class="automation-settings">
            <div class="surface">
              <div class="surface-header">
                <div>
                  <h2>自动交付策略</h2>
                  <p>配置定时巡检、自动派发 Codex、Jira 状态自动流转及合并请求参数</p>
                </div>
                <StatusPill :value="data.settings.enabled ? 'active' : 'paused'" :label="data.settings.enabled ? '策略已启用' : '策略已暂停'" />
              </div>
              <el-form class="surface-body settings-form" :disabled="saving || !integrations.capability('issues.read')" label-position="top" @change="dirty = true">
                <div class="settings-switch">
                  <div>
                    <strong>启用自动巡检</strong>
                    <p>后端按每天指定时间自动巡检待办任务</p>
                  </div>
                  <el-switch v-model="form.enabled" aria-label="启用自动巡检" @change="dirty = true" />
                </div>
                <el-form-item label="每日巡检时间">
                  <div class="schedule-times">
                    <div v-for="(_, index) in form.dailyTimes" :key="index" class="schedule-time">
                      <el-time-picker v-model="form.dailyTimes[index]" format="HH:mm" value-format="HH:mm" :clearable="false" :aria-label="`巡检时间 ${index + 1}`" @change="dirty = true" />
                      <el-button :disabled="form.dailyTimes.length === 1" :aria-label="`移除巡检时间 ${index + 1}`" @click="removeTime(index)">移除</el-button>
                    </div>
                    <el-button class="add-time" @click="addTime">添加巡检时间</el-button>
                  </div>
                </el-form-item>
                <el-form-item label="每轮最大派发数量">
                  <el-input-number v-model="form.maxDispatchPerRun" :min="0" :precision="0" aria-label="每轮最大派发数量" @change="dirty = true" />
                  <span class="row-secondary">0 表示不限制</span>
                </el-form-item>
                <div class="settings-switch">
                  <div>
                    <strong>自动创建 Codex 任务</strong>
                    <p>符合条件的代码任务由本机 Codex 通过需求开发或 Jira 修复启动。开启研发预览时先生成预览，等你确认。</p>
                  </div>
                  <el-switch v-model="form.autoCreateCodex" aria-label="自动创建 Codex 任务" @change="dirty = true" />
                </div>
                <div class="settings-switch">
                  <div>
                    <strong>自动生成研发任务预览</strong>
                    <p>巡检后将缺陷和开发事项送到 Jira 修复或需求开发。请在项目匹配里填写本地目录。</p>
                  </div>
                  <el-switch v-model="form.autoPrepareJiraDev" aria-label="自动生成研发任务预览" @change="dirty = true" />
                </div>
                <div class="settings-switch">
                  <div>
                    <strong>自动推进 Jira 状态</strong>
                    <p>巡检按排期推进。需求开发和 Jira 修复按启动和验证结果推进已绑定的 Jira 事项。</p>
                  </div>
                  <el-switch v-model="form.autoTransitionJira" aria-label="自动推进 Jira 状态" @change="dirty = true" />
                </div>
                <div class="settings-switch">
                  <div>
                    <strong>自动创建合并请求</strong>
                    <p>核对已验证的远端任务分支后，按匹配项目的目标分支与审核人创建 MR。</p>
                  </div>
                  <el-switch v-model="form.autoCreateMergeRequest" aria-label="自动创建合并请求" @change="dirty = true" />
                </div>
                <div class="settings-fields">
                  <el-form-item label="开始状态">
                    <el-input v-model="form.startStatus" aria-label="开始状态" />
                  </el-form-item>
                  <el-form-item label="完成状态">
                    <el-input v-model="form.completedStatus" aria-label="完成状态" />
                  </el-form-item>
                  <el-form-item label="审核人">
                    <el-input v-model="form.reviewer" aria-label="审核人" />
                  </el-form-item>
                  <el-form-item label="验证浏览器">
                    <el-input v-model="form.browser" aria-label="验证浏览器" />
                  </el-form-item>
                </div>
                <section class="project-routing-settings" aria-label="按 Jira 匹配项目">
                  <header class="project-routing-heading"><div><h3>按 Jira 匹配项目</h3><p>为每个项目设置仓库、运行方式和 Jira 匹配规则；未匹配或命中多个项目时先核对，不自动猜选。</p></div><el-button @click="addProject">添加项目配置</el-button></header>
                  <el-empty v-if="!form.projectProfiles?.length" description="尚无项目配置，请添加需要自动交付的项目" :image-size="44" />
                  <el-table v-else :data="form.projectProfiles" row-key="id" size="small" max-height="320" class="project-routing-list" aria-label="项目配置列表">
                    <el-table-column label="项目" min-width="220"><template #default="{ row, $index }">
                      <strong class="project-summary-name">{{ row.name || `项目 ${$index + 1}` }}</strong>
                      <div class="project-summary-path" :title="row.localPath || row.repositoryUrl">{{ row.localPath || row.repositoryUrl }}</div>
                      <span v-if="projectProfileError(row)" class="project-rule-note">{{ projectProfileError(row) }}</span>
                    </template></el-table-column>
                    <el-table-column label="运行环境 / 分支" min-width="150"><template #default="{ row }">{{ row.runtimeEnvironment || '—' }} / {{ row.targetBranch || '—' }}</template></el-table-column>
                    <el-table-column label="Jira 匹配规则" min-width="200"><template #default="{ row }"><span class="project-summary-rules">{{ [...row.jiraProjects, ...row.components, ...row.labels].join(' · ') || '按仓库或关联工作区核对' }}</span></template></el-table-column>
                    <el-table-column label="操作" width="116" fixed="right"><template #default="{ row }">
                      <div class="project-row-actions">
                      <el-button link type="primary" :aria-label="`编辑项目配置 ${row.name}`" @click="editProject(row)">编辑</el-button>
                      <el-button link type="danger" :aria-label="`移除项目配置 ${row.name}`" @click="removeProject(row.id)">移除</el-button>
                      </div>
                    </template></el-table-column>
                  </el-table>
                  <div class="project-preview-actions"><el-button :loading="previewing" @click="previewProjects">预览项目匹配</el-button><span class="row-secondary">使用当前表单核对已保存的 Jira 快照，不保存配置或派发任务。</span></div>
                  <section v-if="projectPreview" class="project-preview" aria-label="项目匹配预览">
                    <header class="project-routing-heading"><div><h4>项目匹配预览</h4><p>{{ dateTime(projectPreview.checkedAt) }} · {{ previewRows.length }} / {{ projectPreview.issueCount }} 项</p></div><div class="project-preview-controls" @change.stop><el-checkbox v-model="previewOnlyOpen">仅未完成</el-checkbox><el-button link @click="projectPreview = undefined">清除预览</el-button></div></header>
                    <el-table :data="previewRows" row-key="issue.key" size="small" max-height="360" empty-text="当前范围没有事项">
                      <el-table-column label="Jira 事项" min-width="220"><template #default="{ row }"><a :href="safeUrl(row.issue.url)" target="_blank">{{ row.issue.key }}</a><div class="row-secondary">{{ row.issue.summary }}</div></template></el-table-column>
                      <el-table-column label="匹配项目" min-width="150"><template #default="{ row }">{{ projectRoutingLabel(row.projectRouting) }}</template></el-table-column>
                      <el-table-column label="匹配依据" min-width="240"><template #default="{ row }">{{ row.projectRouting?.reason || '未记录匹配依据' }}</template></el-table-column>
                    </el-table>
                  </section>
                </section>
                <el-alert v-if="!valid" title="请填写不重复的有效时间、派发数量、状态，以及每个项目的必填配置。" type="error" :closable="false" />
                <div class="settings-actions">
                  <span v-if="approvalPending" class="row-secondary">保存并确认后，所选自动动作才会应用到需求开发和 Jira 修复。</span>
                  <el-button @click="reset">恢复已保存配置</el-button>
                  <el-button type="primary" :disabled="!valid" :loading="saving" @click="save">保存交付设置</el-button>
                </div>
              </el-form>
            </div>
          </div>
        </QueryState>
      </el-tab-pane>
      <el-tab-pane label="自动汇报" name="reports" lazy tabindex="0"><WorkspaceReportsCard /></el-tab-pane>
      <el-tab-pane label="状态与存储" name="runtime" lazy tabindex="0">
        <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()">
          <div v-if="data">
            <section class="surface">
              <div class="surface-header"><h2>当前运行环境状态</h2></div>
              <div class="surface-body runtime-status-body">
                <div class="runtime-summary-strip">
                  <div class="runtime-summary-tile">
                    <span>下次自动巡检</span>
                    <strong>{{ dateTime(data.nextRun) }}</strong>
                  </div>
                  <div class="runtime-summary-tile">
                    <span>验证浏览器</span>
                    <strong>{{ data.settings.browser || '未配置' }}</strong>
                  </div>
                  <div class="runtime-summary-tile">
                    <span>已配置交付项目</span>
                    <strong>{{ data.settings.projectProfiles?.length || 0 }} 个项目</strong>
                  </div>
                </div>
                <div v-if="data.settings.projectProfiles?.length" class="runtime-profiles-section">
                  <div class="runtime-profiles-label">已配置交付项目明细</div>
                  <div class="runtime-profiles-grid">
                    <article v-for="profile in data.settings.projectProfiles" :key="profile.id" class="runtime-profile-card">
                      <div class="runtime-profile-head">
                        <strong>{{ profile.name }}</strong>
                        <span class="runtime-profile-branch">{{ profile.targetBranch }}</span>
                      </div>
                      <p class="runtime-profile-repo" :title="profile.repositoryUrl">{{ profile.repositoryUrl }}</p>
                      <p class="runtime-profile-meta">{{ profile.runtimeEnvironment }} · <code>{{ profile.runtimeCommand }}</code></p>
                    </article>
                  </div>
                </div>
                <p v-else class="row-secondary">尚未配置交付项目路由规则。</p>
              </div>
            </section>
            <WorkspaceStorageCard v-if="activeTab === 'runtime'" />
            <p class="settings-boundary">凭据和自动交付开关保存在当前工作台本机目录；此处显示已保存的运行配置。</p>
          </div>
        </QueryState>
      </el-tab-pane>
    </el-tabs>
    <div v-if="dirty" class="settings-unsaved-bar" role="status" aria-live="polite">
      <div class="settings-unsaved-info">
        <span class="settings-unsaved-dot" />
        <div>
          <strong>检测到未保存的自动交付策略更改</strong>
          <span class="settings-unsaved-sub">{{ !valid ? '请先修正表单中的校验项后再保存' : '切换分栏不会丢失草稿 · 支持 ⌘S 快速保存' }}</span>
        </div>
      </div>
      <div class="settings-unsaved-actions">
        <el-button v-if="activeTab !== 'automation'" size="small" @click="activeTab = 'automation'">查看修改项</el-button>
        <el-button size="small" :disabled="saving" @click="reset">放弃修改</el-button>
        <el-button size="small" type="primary" :disabled="!valid" :loading="saving" @click="save">保存交付设置 (⌘S)</el-button>
      </div>
    </div>
    <el-drawer v-model="projectEditorOpen" title="项目配置" size="min(760px, 100vw)" class="hub-drawer project-profile-drawer" append-to-body destroy-on-close>
      <el-form v-if="projectDraft" class="settings-form project-editor-form" label-position="top" :disabled="saving" @submit.prevent="applyProject">
        <el-form-item label="选择已有本机项目"><el-select :model-value="projectDraft.localPath" filterable clearable :loading="projects.isFetching.value" aria-label="项目配置 选择已有本机项目" placeholder="选择项目，填入名称、仓库和路径" @change="chooseProject(projectDraft, $event)"><el-option v-for="project in projects.data.value?.projects || []" :key="project.path" :value="project.path" :label="`${project.displayName || project.projectName || project.folderName} · ${project.displayPath || project.path}`" /></el-select></el-form-item>
        <div class="settings-fields project-editor-fields">
          <el-form-item label="项目名称" required><el-input v-model="projectDraft.name" aria-label="项目配置 名称" /></el-form-item>
          <el-form-item label="本机项目路径（可选）"><el-input v-model="projectDraft.localPath" aria-label="项目配置 本机路径" placeholder="已有项目的绝对路径" /></el-form-item>
        </div>
        <el-form-item label="仓库地址" required><el-input v-model="projectDraft.repositoryUrl" aria-label="项目配置 仓库地址" placeholder="Git 仓库地址" /></el-form-item>
        <el-form-item label="项目启动命令" required><el-input v-model="projectDraft.runtimeCommand" aria-label="项目配置 启动命令" placeholder="填写该项目实际使用的启动命令" /></el-form-item>
        <div class="settings-fields project-editor-fields">
          <el-form-item label="运行环境标识" required><el-input v-model="projectDraft.runtimeEnvironment" aria-label="项目配置 运行环境" placeholder="该项目实际验证环境" /></el-form-item>
          <el-form-item label="目标分支" required><el-input v-model="projectDraft.targetBranch" aria-label="项目配置 目标分支" /></el-form-item>
        </div>
        <div class="project-rule-fields">
          <el-form-item label="Jira 项目 Key"><el-select v-model="projectDraft.jiraProjects" multiple filterable allow-create default-first-option aria-label="项目配置 Jira项目Key" placeholder="输入 Key 后按回车添加"><el-option v-for="value in projectDraft.jiraProjects" :key="value" :value="value" :label="value" /></el-select></el-form-item>
          <el-form-item label="Jira 组件"><el-select v-model="projectDraft.components" multiple filterable allow-create default-first-option aria-label="项目配置 Jira组件" placeholder="输入组件原名后按回车添加"><el-option v-for="value in projectDraft.components" :key="value" :value="value" :label="value" /></el-select></el-form-item>
          <el-form-item label="Jira 标签"><el-select v-model="projectDraft.labels" multiple filterable allow-create default-first-option aria-label="项目配置 Jira标签" placeholder="输入标签后按回车添加"><el-option v-for="value in projectDraft.labels" :key="value" :value="value" :label="value" /></el-select></el-form-item>
        </div>
        <p class="project-rule-note">规则可留空，届时根据事项中明确的仓库或已关联工作区核对项目。</p>
        <p v-if="projectProfileError(projectDraft)" class="project-rule-note">{{ projectProfileError(projectDraft) }}</p>
      </el-form>
      <template #footer>
        <div class="project-editor-footer">
          <span class="row-secondary">应用后，点击页面“保存交付设置”生效。</span>
          <div><el-button @click="projectEditorOpen = false">取消</el-button><el-button type="primary" :disabled="saving || !projectDraft || !!projectProfileError(projectDraft)" @click="applyProject">应用到表单</el-button></div>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.delivery-settings { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.settings-tabs { flex: 1; min-height: 0; min-width: 0; }
.settings-tabs :deep(.el-tabs__header) { margin-bottom: 22px; }
.settings-tabs :deep(.el-tabs__item) { font-size: 13px; }
.settings-tabs > :deep(.el-tabs__content) { flex: 1; min-height: 0; min-width: 0; }
.settings-tabs :deep(.el-tab-pane) {
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.settings-tabs :deep(.el-tab-pane:focus-visible) { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.project-routing-settings { margin: 10px 0 24px; }
.project-routing-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.project-routing-heading h3 { margin: 0; font-size: 13px; font-weight: 600; }
.project-routing-heading p,.project-rule-note { margin: 7px 0 12px; color: var(--ui-muted); font-size: 12px; line-height: 1.7; }
.project-summary-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.project-summary-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); font-size: 11px; }
.project-summary-rules { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.project-row-actions { display: flex; align-items: center; gap: 12px; }
.project-editor-form :deep(.el-select) { width: 100%; }
.project-editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.project-editor-footer>div { display: flex; gap: 10px; flex-shrink: 0; }
.project-editor-footer .row-secondary { margin: 0; text-align: left; }
.project-rule-fields { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 15px; }
.project-rule-fields :deep(.el-form-item) { min-width: 0; }
.project-preview-actions,.project-preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.project-preview-actions { margin-top: 20px; }
.project-preview { margin-top: 20px; }
.project-preview h4 { margin: 0; font-size: 13px; }
.settings-boundary { font-size: 12px; line-height: 1.8; color: var(--ui-muted); margin: 14px 0 0; }
.schedule-time { display: flex; align-items: center; gap: 8px; min-width: 0; }
.schedule-time :deep(.el-date-editor) { width: 100%; min-width: 0; }
.add-time { width: fit-content; }
.settings-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ui-divider);
}
.settings-switch > div {
  min-width: 0;
}
.settings-switch :deep(.el-switch) {
  flex-shrink: 0;
}
.settings-switch strong {
  font-size: 13px;
  font-weight: 550;
}
.settings-switch p {
  font-size: 12px;
  color: var(--ui-muted);
  line-height: 1.55;
  margin: 3px 0 0;
}
:deep(.settings-form .el-form-item__label) {
  font-size: 12px;
  color: var(--ui-muted);
}
.schedule-times,
:deep(.settings-fields) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
  width: 100%;
}
:deep(.settings-fields .el-form-item) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
:deep(.settings-fields .el-form-item__content) {
  flex: 0 0 auto;
  margin-top: auto;
}
.settings-actions {
  display: flex;
  gap: 10px;
  border-top: 1px solid var(--ui-border);
  padding-top: 22px;
  margin-top: 10px;
}
.runtime-status-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.runtime-summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.runtime-summary-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm, 6px);
  background: var(--ui-surface);
}
.runtime-summary-tile span {
  font-size: 11.5px;
  color: var(--ui-muted);
}
.runtime-summary-tile strong {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}
.runtime-profiles-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.runtime-profiles-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ui-muted);
}
.runtime-profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.runtime-profile-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm, 6px);
  background: var(--ui-surface);
}
.runtime-profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.runtime-profile-head strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-profile-branch {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--ui-border);
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-family: var(--ui-font-mono);
  font-size: 11px;
  line-height: 1.4;
}
.runtime-profile-repo {
  margin: 0;
  font-family: var(--ui-font-mono);
  font-size: 11.5px;
  color: var(--ui-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-profile-meta {
  margin: 0;
  font-size: 11.5px;
  color: var(--ui-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-profile-meta code {
  font-family: var(--ui-font-mono);
  font-size: 11px;
  color: var(--ui-ink);
}
@media (max-width: 720px) {
  .runtime-summary-strip {
    grid-template-columns: 1fr;
  }
}
@container workspace-page (max-width: 1000px) {
}
@container workspace-page (max-width: 600px) {
  :deep(.settings-fields),
  .schedule-times,.project-rule-fields {
    grid-template-columns: 1fr;
  }
  .settings-actions {
    flex-wrap: wrap;
  }
}
@media (max-width: 1000px) {
}
@media (max-width: 600px) {
  .project-editor-fields,.project-editor-form .project-rule-fields { grid-template-columns: 1fr; }
  .project-editor-footer { align-items: flex-end; flex-direction: column; }
}
@media (max-width: 500px) {
  :deep(.settings-fields),
  .schedule-times,.project-rule-fields {
    grid-template-columns: 1fr;
  }
  .settings-actions {
    flex-wrap: wrap;
  }
}
.settings-readiness-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.settings-readiness-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm, 6px);
  background: var(--ui-surface);
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}
.settings-readiness-card:hover {
  border-color: color-mix(in srgb, var(--ui-text) 20%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-raised) 50%, var(--ui-surface));
}
.settings-readiness-card span {
  font-size: 11px;
  color: var(--ui-muted);
}
.settings-readiness-card strong {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-readiness-card.is-active strong {
  color: var(--ui-success, #16a34a);
}
.settings-readiness-card.is-dirty {
  border-color: color-mix(in srgb, var(--ui-warning, #d97706) 45%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning, #d97706) 7%, var(--ui-surface));
}
.settings-readiness-card.is-dirty strong {
  color: var(--ui-warning, #d97706);
}
.settings-readiness-card small {
  font-size: 11px;
  color: var(--ui-muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-unsaved-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 10px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  border-radius: var(--ui-radius-sm, 8px);
  background: color-mix(in srgb, var(--ui-accent) 8%, var(--ui-surface));
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.08);
}
.settings-unsaved-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.settings-unsaved-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  background: var(--ui-warning, #d97706);
}
.settings-unsaved-info strong {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ui-text);
}
.settings-unsaved-sub {
  display: block;
  font-size: 11.5px;
  color: var(--ui-muted);
}
.settings-unsaved-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.settings-unsaved-actions :deep(.el-button) {
  margin: 0;
}
:global(.project-profile-drawer.el-drawer) {
  color: var(--ui-text);
  background: var(--ui-bg);
}
:global(.project-profile-drawer .el-drawer__header) {
  color: var(--ui-text);
}
:global(html[data-ui-skin="acid"]) .settings-readiness-card,
:global(html[data-ui-skin="acid"]) .settings-unsaved-bar,
:global(html[data-ui-skin="acid"]) .runtime-summary-tile,
:global(html[data-ui-skin="acid"]) .runtime-profile-card,
:global(html[data-ui-skin="acid"]) .runtime-profile-branch {
  border-radius: 0;
}
@media (max-width: 860px) {
  .settings-readiness-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 520px) {
  .settings-readiness-strip {
    grid-template-columns: 1fr;
  }
}
</style>

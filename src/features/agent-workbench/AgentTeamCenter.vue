<script setup lang="ts">
/** 高级团队独立轮询；编辑中的计划、配置与草稿不被后台快照覆盖，消息列表保持稳定顺序。 */
import { computed, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { AgentProvider, AgentReasoningEffort, AgentRun, AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { defaultTeamProfileConfig, profileConfigSchema, teamModelChoiceSchema, teamProfile,
  type TeamModelChoice, type TeamProfileConfig, type TeamProfileId, type TeamRoleProfile } from '../../../shared/agent-team';
import { taskPlanSchema } from '../../../shared/agent-task-plan';
import { teamRoleLabels } from './team-chat';
import { buildModelChoice, composeMixedTeam, coreTeamProfileIds, extendedTeamProfileIds,
  teamEffortShortLabels, teamModelPresentation, teamProviderLabels, teamProviderStrengths, teamProvidersInUse, teamRoleShortHints, type TeamProvider } from './team-role-settings';
import { modelSelectionChoices, selectModelChoice, selectModelEffort } from './model-selection';
import { createRequestId } from '../requirement-development/request-id';
import { readTeamArtifact, readTeamDraft, readTeamProfiles, readTeamRoom, readTeamTasks,
  saveTeamDraft, saveTeamProfiles, type TeamArtifactContent } from './team-api';

const props = defineProps<{ open: boolean; parentRun?: AgentRun; objective: string; runtimes: AgentRuntimeHealth[]; attachmentIds?: string[]; workspacePath?: string; initialTab?: string }>();
const emit = defineEmits<{ 'update:open': [open: boolean]; select: [runId: string] }>();
const visible = computed({ get: () => props.open, set: value => emit('update:open', value) });
const client = useQueryClient(), scope = ['agent-team', createRequestId()];

const selectedId = shallowRef('');
const changing = shallowRef('');
const planText = shallowRef(''), planRevision = shallowRef(0), planDirty = shallowRef(false);
const planAnswers = ref<Record<string, string>>({}), messageAnswers = ref<Record<string, string>>({});
const profileDraft = ref<TeamProfileConfig>(defaultTeamProfileConfig()), profileDirty = shallowRef(false), routingText = shallowRef('');
const draftText = shallowRef(''), draftRevision = shallowRef(0), draftDirty = shallowRef(false);
const artifactVisible = shallowRef(false), artifactLoading = shallowRef(false), artifactContent = shallowRef<TeamArtifactContent>();
const secondaryExpanded = shallowRef(false);
let artifactRequest: AbortController | undefined;

const ids = new Map<string, string>();
function requestId(key: string) {
  const value = ids.get(key) || createRequestId();
  ids.set(key, value);
  return value;
}
function choiceOf(value: TeamModelChoice): TeamModelChoice {
  return { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort, ...(value.catalogAlias ? { catalogAlias: { ...value.catalogAlias } } : {}) };
}

const tasksQuery = useQuery({ queryKey: [...scope, 'tasks'], queryFn: ({ signal }) => readTeamTasks(signal), enabled: computed(() => false) });
const roomQuery = useQuery({ queryKey: computed(() => [...scope, 'room', selectedId.value]), queryFn: ({ signal }) => readTeamRoom(selectedId.value, signal), enabled: computed(() => false) });
const profilesQuery = useQuery({ queryKey: [...scope, 'profiles'], queryFn: ({ signal }) => readTeamProfiles(signal), refetchInterval: computed(() => props.open ? 5000 : false) });
const draftQuery = useQuery({ queryKey: computed(() => [...scope, 'draft', selectedId.value]), queryFn: ({ signal }) => readTeamDraft(selectedId.value, signal), enabled: computed(() => false) });

const tasks = computed(() => [...(tasksQuery.data.value || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)));
const task = computed(() => roomQuery.data.value?.task || tasks.value.find(item => item.id === selectedId.value));
const currentPlan = computed(() => { try { return taskPlanSchema.safeParse(JSON.parse(planText.value)).data; } catch { return undefined; } });
const plannedRoles = computed(() => {
  const current = task.value, plan = currentPlan.value;
  if (!current || current.legacy || !plan) return [];
  const rows: { stage: string; profileId: TeamProfileId; choice: TeamModelChoice }[] = [];
  const push = (stage: string, profileId: TeamProfileId, choice = choiceOf(teamProfile(current.profileConfig, profileId))) => rows.push({ stage, profileId, choice });
  push('计划', 'leader');
  if (plan.needsAnalyst || ['research_design', 'complex_delivery', 'complex_delivery_parallel'].includes(plan.templateId)) push('需求研究', 'analyst');
  if (plan.needsArchitect || ['complex_delivery', 'complex_delivery_parallel'].includes(plan.templateId)) push('架构设计', 'architect');
  if (plan.templateId === 'diagnosis') { push('副本诊断', 'engineer'); return rows; }
  const implementers: TeamProfileId[] = plan.templateId === 'research_design'
    ? [plan.needsArchitect ? 'architect' : 'analyst']
    : ['complex_delivery', 'complex_delivery_parallel'].includes(plan.templateId)
    ? ['engineer', 'frontend']
    : [plan.templateId === 'frontend' ? 'frontend' : plan.templateId === 'batch' ? 'batch' : 'engineer'];
  if (plan.templateId !== 'research_design') for (const id of implementers) push('实现', id);
  if (plan.templateId !== 'research_design') push('独立验证', 'verifier');
  for (const id of implementers) {
    const authorProvider = teamProfile(current.profileConfig, id).provider;
    push(`独立审查（${teamRoleLabels[id]}）`, 'reviewer', choiceOf(current.profileConfig.reviewRouting[authorProvider]));
  }
  return rows;
});

watch(tasks, list => { if (!selectedId.value && list[0]) selectedId.value = list[0].id; }, { immediate: true });
watch(selectedId, () => {
  planDirty.value = false; planText.value = ''; planAnswers.value = {}; messageAnswers.value = {};
  draftDirty.value = false; draftRevision.value = 0; draftText.value = ''; closeArtifact();
}, { flush: 'sync' });
watch(() => [task.value?.id, task.value?.planRevision, task.value?.plan] as const, ([id, revision, plan]) => {
  if (!id || !plan || (planDirty.value && planRevision.value === revision)) return;
  planRevision.value = revision || 0; planText.value = JSON.stringify(plan, null, 2); planDirty.value = false;
}, { immediate: true });
watch(profilesQuery.data, value => {
  if (!value || profileDirty.value) return;
  const raw = toRaw(value.config);
  profileDraft.value = structuredClone( {
    ...raw,
    profiles: raw.profiles.map(item => {
      const entry = toRaw(item);
      return {
        ...entry,
        ...(entry.catalogAlias ? { catalogAlias: { ...toRaw(entry.catalogAlias) } } : {}),
        ...(entry.escalation ? { escalation: { ...toRaw(entry.escalation), ...(entry.escalation.catalogAlias ? { catalogAlias: { ...toRaw(entry.escalation.catalogAlias) } } : {}) } } : {}),
      };
    }),
    reviewRouting: Object.fromEntries(Object.entries(toRaw(raw.reviewRouting)).map(([key, item]) => {
      const choice = toRaw(item);
      return [key, { ...choice, ...(choice.catalogAlias ? { catalogAlias: { ...toRaw(choice.catalogAlias) } } : {}) }];
    })) as TeamProfileConfig['reviewRouting'],
    options: { ...toRaw(raw.options), tokenLimits: { ...toRaw(raw.options.tokenLimits) } },
  });
  routingText.value = JSON.stringify(profileDraft.value.reviewRouting, null, 2);
}, { immediate: true });
watch(draftQuery.data, value => {
  if (!value) {
    if (!draftDirty.value) { draftRevision.value = 0; draftText.value = ''; }
    return;
  }
  if (draftDirty.value && draftRevision.value === value.revision) return;
  draftRevision.value = value.revision; draftText.value = value.text; draftDirty.value = false;
}, { immediate: true });

function closeArtifact() {
  artifactRequest?.abort(); artifactRequest = undefined;
  artifactVisible.value = false; artifactLoading.value = false; artifactContent.value = undefined;
}
async function previewArtifact(artifactId: string) {
  if (!task.value) return;
  artifactRequest?.abort();
  const controller = new AbortController();
  artifactRequest = controller; artifactVisible.value = true; artifactLoading.value = true; artifactContent.value = undefined;
  try {
    const content = await readTeamArtifact(task.value.id, artifactId, controller.signal);
    if (artifactRequest === controller) artifactContent.value = content;
  } catch (error) {
    if (!controller.signal.aborted) { closeArtifact(); ElMessage.error(error instanceof Error ? error.message : '产物读取失败'); }
  } finally { if (artifactRequest === controller) artifactLoading.value = false; }
}

const coreProfiles = computed(() => coreTeamProfileIds.map(id => teamProfile(profileDraft.value, id)));
const extendedProfiles = computed(() => extendedTeamProfileIds.map(id => teamProfile(profileDraft.value, id)));
const activeProviders = computed(() => teamProvidersInUse(profileDraft.value));
const providerRoleCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const profile of profileDraft.value.profiles) {
    counts[profile.provider] = (counts[profile.provider] || 0) + 1;
  }
  return counts;
});
const crossReviewSummary = computed(() => {
  const reviewer = teamProfile(profileDraft.value, 'reviewer');
  const reviewerLabel = teamProviderLabels[reviewer.provider] || reviewer.provider;
  const altRoute = profileDraft.value.reviewRouting[reviewer.provider as keyof TeamProfileConfig['reviewRouting']];
  const altLabel = altRoute ? (teamProviderLabels[altRoute.provider] || altRoute.provider) : 'Codex';
  return `默认由 ${reviewerLabel} 独立复核；${reviewerLabel} 产出的代码按 ${altLabel} 审查路由复核，使用独立会话核验证据。`;
});

function efforts(profile: TeamModelChoice) {
  return teamModelPresentation(props.runtimes, profile).efforts;
}
function runtimeReady(provider: AgentProvider) {
  return !!props.runtimes.find(runtime => runtime.provider === provider)?.ready;
}
function sanitizeEscalations() {
  if (!props.runtimes.length) return;
  for (const profile of profileDraft.value.profiles) {
    if (!profile.escalation) continue;
    const runtime = props.runtimes.find(item => item.provider === profile.escalation!.provider);
    const valid = runtime?.models.some(item => item.id === profile.escalation!.model);
    if (!valid || (profile.escalation.provider === profile.provider && profile.escalation.model === profile.model)) {
      delete profile.escalation;
    }
  }
}
function syncReviewer(profile: TeamRoleProfile) {
  profileDirty.value = true;
  const reviewer = profileDraft.value.profiles.find(item => item.id === 'reviewer') || profile;
  const reviewerChoice = choiceOf(reviewer);
  const fallbackProvider: TeamProvider = (['codex', 'cursor', 'antigravity'] as const).find(p => p !== reviewerChoice.provider && runtimeReady(p))
    || (reviewerChoice.provider === 'codex' ? 'cursor' : 'codex');
  const fallbackModel = fallbackProvider === 'codex' ? 'gpt-6-astra' : fallbackProvider === 'cursor' ? 'claude-opus-5-5-high' : 'gemini-4-argon-high';
  const fallbackChoice = buildModelChoice(props.runtimes, fallbackProvider, fallbackModel, 'high');
  const next: TeamProfileConfig['reviewRouting'] = {
    codex: reviewerChoice,
    cursor: reviewerChoice.provider === 'cursor' ? fallbackChoice : reviewerChoice,
    claude: reviewerChoice.provider === 'claude' ? fallbackChoice : reviewerChoice,
    kiro: reviewerChoice.provider === 'kiro' ? fallbackChoice : reviewerChoice,
    antigravity: reviewerChoice.provider === 'antigravity' ? fallbackChoice : reviewerChoice,
  };
  profileDraft.value.reviewRouting = next;
  routingText.value = JSON.stringify(next, null, 2);
  sanitizeEscalations();
}

let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
function cancelAutoSave() { if (autoSaveTimer) clearTimeout(autoSaveTimer); autoSaveTimer = undefined; }
function scheduleAutoSave() {
  cancelAutoSave();
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = undefined;
    if (!profileDirty.value) return;
    if (changing.value) scheduleAutoSave();
    else void saveProfiles(true);
  }, 350);
}
onBeforeUnmount(() => { if (autoSaveTimer) { cancelAutoSave(); void saveProfiles(true); } });

const roleStatusText = computed(() => {
  if (changing.value === 'profiles' || profileDirty.value) return '保存中…';
  return '已自动保存';
});

function roleModelKey(profile: TeamRoleProfile) {
  return `${profile.provider}:${teamModelPresentation(props.runtimes, profile).id}`;
}
function roleModelGroups(profile: TeamRoleProfile) {
  const groups = [...props.runtimes]
    .filter(runtime => (runtime.provider as string) !== 'api')
    .sort((a, b) => Number(b.ready) - Number(a.ready))
    .map(runtime => ({
      provider: runtime.provider,
      label: `${teamProviderLabels[runtime.provider] || runtime.label}${runtime.ready ? '' : ' · 未就绪'}`,
      options: modelSelectionChoices(runtime).filter(model => model.id).map(model => ({ key: `${runtime.provider}:${model.id}`, label: model.label })),
    }))
    .filter(group => group.options.length > 0);
  const current = roleModelKey(profile);
  if (!groups.some(group => group.options.some(option => option.key === current))) {
    const option = { key: current, label: profile.catalogAlias?.label || profile.model };
    const group = groups.find(item => item.provider === profile.provider);
    if (group) group.options.unshift(option);
    else groups.push({ provider: profile.provider, label: `${teamProviderLabels[profile.provider]} · 未就绪`, options: [option] });
  }
  return groups;
}
function changeRoleModel(profile: TeamRoleProfile, key: string) {
  const index = key.indexOf(':');
  if (index < 1) return;
  const provider = key.slice(0, index) as AgentProvider, model = key.slice(index + 1);
  if (!model) return;
  const previousEffort = teamModelPresentation(props.runtimes, profile).effort;
  const preferredEffort = provider === profile.provider && previousEffort ? previousEffort : 'high';
  const runtime = props.runtimes.find(item => item.provider === provider);
  const selected = selectModelChoice(runtime, model, false);
  const variant = selectModelEffort(runtime, selected.model, preferredEffort);
  const next = buildModelChoice(props.runtimes, provider, variant?.model || selected.model, preferredEffort);
  profile.provider = next.provider; profile.model = next.model; profile.reasoningEffort = next.reasoningEffort;
  if (next.catalogAlias) profile.catalogAlias = { ...next.catalogAlias };
  else delete profile.catalogAlias;
  syncReviewer(profile);
  scheduleAutoSave();
}
function changeRoleEffort(profile: TeamRoleProfile, effort: AgentReasoningEffort | '') {
  const presentation = teamModelPresentation(props.runtimes, profile);
  const next = selectModelEffort(presentation.runtime, presentation.model, effort);
  if (!next) return;
  if (presentation.embedded) {
    profile.model = next.model;
    profile.reasoningEffort = '';
    delete profile.catalogAlias;
  } else {
    if (effort && !efforts(profile).includes(effort)) return;
    profile.reasoningEffort = effort as TeamModelChoice['reasoningEffort'];
  }
  syncReviewer(profile);
  scheduleAutoSave();
}
function changeAutoStart() {
  sanitizeEscalations();
  profileDirty.value = true;
  scheduleAutoSave();
}
function toggleProvider(provider: TeamProvider) {
  if (changing.value === 'profiles') return;
  const current = activeProviders.value;
  const exists = current.includes(provider);
  if (exists && current.length <= 1) {
    ElMessage.warning('至少需要保留一个参与协作的 AI');
    return;
  }
  const nextProviders = exists ? current.filter(item => item !== provider) : [...current, provider];
  const next = composeMixedTeam(profileDraft.value, nextProviders, props.runtimes);
  profileDraft.value = next;
  routingText.value = JSON.stringify(next.reviewRouting, null, 2);
  profileDirty.value = true;
  scheduleAutoSave();
}
async function restoreProfiles(quiet?: unknown) {
  cancelAutoSave();
  const preferred: TeamProvider[] = ['codex', 'cursor', 'antigravity'];
  const readyPreferred = preferred.filter(p => runtimeReady(p));
  const next = composeMixedTeam(profileDraft.value, readyPreferred.length ? readyPreferred : preferred, props.runtimes);
  profileDraft.value = next;
  routingText.value = JSON.stringify(next.reviewRouting, null, 2);
  profileDirty.value = true;
  await saveProfiles(true);
  if (quiet !== true && !profileDirty.value) ElMessage.success('已按推荐组合自动分配角色');
}
async function run(action: string, operation: () => Promise<unknown>, refresh = true) {
  if (changing.value) return;
  changing.value = action;
  try {
    await operation(); ids.delete(action);
    if (refresh) await client.invalidateQueries({ queryKey: scope });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '团队操作失败'); }
  finally { changing.value = ''; }
}
async function saveProfiles(quiet = false) {
  await run('profiles', async () => {
    const routing = JSON.parse(routingText.value), value = JSON.parse(JSON.stringify(toRaw(profileDraft.value))) as TeamProfileConfig;
    value.reviewRouting = routing;
    const reviewer = value.profiles.find(item => item.id === 'reviewer')!;
    const reviewerChoice = teamModelChoiceSchema.parse(routing.codex);
    Object.assign(reviewer, reviewerChoice); if (!reviewerChoice.catalogAlias) delete reviewer.catalogAlias;
    const parsed = profileConfigSchema.parse(value);
    await saveTeamProfiles(parsed); profileDirty.value = false;
    if (!quiet) ElMessage.success('角色配置已保存，之后创建的任务使用新版本');
  });
}
async function saveDraft() {
  if (!task.value) return;
  const id = task.value.id, revision = draftRevision.value, text = draftText.value;
  await run('save-draft', async () => {
    await saveTeamDraft(id, revision, text);
    if (selectedId.value === id && draftRevision.value === revision && draftText.value === text) draftDirty.value = false;
  });
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="团队协作与角色设置"
    width="min(840px, 95vw)"
    append-to-body
    :close-on-click-modal="false"
    :show-close="!changing"
    :close-on-press-escape="!changing"
    class="team-role-dialog"
  >
    <div class="team-settings-shell">
      <!-- 顶部：参与的 AI 一键组合 -->
      <section class="ai-roster-section" aria-label="参与协作的 AI">
        <div class="section-bar">
          <div class="section-bar-title">
            <strong>参与协作的 AI</strong>
            <span>全部岗位使用 Agent 完全访问；点选 AI 自动分配岗位，也可单独指定每个角色的模型</span>
          </div>
          <div class="section-bar-actions">
            <span class="save-badge" :class="{ saving: changing === 'profiles' || profileDirty }">
              <i class="save-dot"></i>
              {{ roleStatusText }}
            </span>
            <el-button size="small" :disabled="!!changing" @click="restoreProfiles">恢复推荐分工</el-button>
          </div>
        </div>

        <div class="ai-chip-grid">
          <button
            v-for="item in teamProviderStrengths"
            :key="item.provider"
            type="button"
            class="ai-chip"
            :class="{ active: activeProviders.includes(item.provider), unready: !runtimeReady(item.provider) }"
            :disabled="changing === 'profiles'"
            @click="toggleProvider(item.provider)"
          >
            <div class="ai-chip-top">
              <span class="ai-chip-check" aria-hidden="true">{{ activeProviders.includes(item.provider) ? '✓' : '' }}</span>
              <strong class="ai-chip-name">{{ teamProviderLabels[item.provider] }}</strong>
              <span v-if="providerRoleCounts[item.provider]" class="ai-chip-count">{{ providerRoleCounts[item.provider] }} 岗</span>
              <span v-else class="ai-chip-count muted">未启用</span>
            </div>
            <div class="ai-chip-hint">{{ item.hint }}</div>
          </button>
        </div>
      </section>

      <!-- 中部：核心研发角色（3x2 对称双列网格） -->
      <section class="role-section" aria-label="核心研发角色">
        <div class="section-subbar">
          <strong>核心研发角色</strong>
          <span>主流程必经岗位（拆解计划 → 编码实现 → 隔离验证 → 独立审查）</span>
        </div>

        <div class="role-grid">
          <div v-for="row in coreProfiles" :key="row.id" class="role-card">
            <div class="role-card-head">
              <div class="role-card-title">
                <strong>{{ row.label }}</strong>
                <el-tag v-if="!runtimeReady(row.provider)" size="small" type="warning" effect="plain">未就绪</el-tag>
              </div>
              <span class="role-card-desc">{{ teamRoleShortHints[row.id as TeamProfileId] }}</span>
            </div>
            <div class="role-card-controls">
              <el-select
                :model-value="roleModelKey(row)"
                filterable
                size="small"
                :disabled="changing === 'profiles'"
                class="role-select-model"
                :aria-label="`${row.label}模型`"
                @update:model-value="(value: string) => changeRoleModel(row, value)"
              >
                <el-option-group v-for="group in roleModelGroups(row)" :key="group.provider" :label="group.label">
                  <el-option
                    v-for="option in group.options"
                    :key="option.key"
                    :value="option.key"
                    :label="`${teamProviderLabels[group.provider]} · ${option.label}`"
                  />
                </el-option-group>
              </el-select>

              <el-select
                v-if="efforts(row).length"
                :model-value="teamModelPresentation(runtimes, row).effort"
                size="small"
                class="role-select-effort"
                :disabled="changing === 'profiles'"
                :aria-label="`${row.label}推理强度`"
                @update:model-value="(value: AgentReasoningEffort | '') => changeRoleEffort(row, value)"
              >
                <el-option v-if="teamModelPresentation(runtimes, row).allowDefaultEffort" value="" label="默认" />
                <el-option
                  v-for="effort in efforts(row)"
                  :key="effort"
                  :value="effort"
                  :label="teamEffortShortLabels[effort] || effort"
                />
              </el-select>
              <span v-else class="role-effort-tag">默认强度</span>
            </div>
          </div>

          <!-- 第 6 格：跨执行器交叉审查说明卡，补齐 3x2 网格 -->
          <div class="role-card review-guard-card">
            <div class="role-card-head">
              <div class="role-card-title">
                <strong>跨执行器交叉审查</strong>
                <span class="guard-pill">自动避嫌</span>
              </div>
              <span class="role-card-desc">独立会话审查代码与验收证据</span>
            </div>
            <p class="guard-card-text">{{ crossReviewSummary }}</p>
          </div>
        </div>
      </section>

      <!-- 按需与辅助角色（折叠，未展开时也直观展示当前分配） -->
      <section class="secondary-section" aria-label="按需与辅助角色">
        <button type="button" class="secondary-bar" :aria-expanded="secondaryExpanded" @click="secondaryExpanded = !secondaryExpanded">
          <div class="secondary-bar-main">
            <strong>按需辅助角色（5 个）</strong>
            <div class="secondary-pills">
              <span v-for="item in extendedProfiles" :key="item.id" class="secondary-pill">
                <em>{{ item.label }}</em>
                <b>{{ teamProviderLabels[item.provider] }}</b>
              </span>
            </div>
          </div>
          <span class="secondary-toggle-btn">{{ secondaryExpanded ? '收起 ▴' : '展开微调 ▾' }}</span>
        </button>

        <div v-if="secondaryExpanded" class="role-grid secondary-grid">
          <div v-for="row in extendedProfiles" :key="row.id" class="role-card">
            <div class="role-card-head">
              <div class="role-card-title">
                <strong>{{ row.label }}</strong>
                <el-tag v-if="!runtimeReady(row.provider)" size="small" type="warning" effect="plain">未就绪</el-tag>
              </div>
              <span class="role-card-desc">{{ teamRoleShortHints[row.id as TeamProfileId] }}</span>
            </div>
            <div class="role-card-controls">
              <el-select
                :model-value="roleModelKey(row)"
                filterable
                size="small"
                :disabled="changing === 'profiles'"
                class="role-select-model"
                :aria-label="`${row.label}模型`"
                @update:model-value="(value: string) => changeRoleModel(row, value)"
              >
                <el-option-group v-for="group in roleModelGroups(row)" :key="group.provider" :label="group.label">
                  <el-option
                    v-for="option in group.options"
                    :key="option.key"
                    :value="option.key"
                    :label="`${teamProviderLabels[group.provider]} · ${option.label}`"
                  />
                </el-option-group>
              </el-select>

              <el-select
                v-if="efforts(row).length"
                :model-value="teamModelPresentation(runtimes, row).effort"
                size="small"
                class="role-select-effort"
                :disabled="changing === 'profiles'"
                :aria-label="`${row.label}推理强度`"
                @update:model-value="(value: AgentReasoningEffort | '') => changeRoleEffort(row, value)"
              >
                <el-option v-if="teamModelPresentation(runtimes, row).allowDefaultEffort" value="" label="默认" />
                <el-option
                  v-for="effort in efforts(row)"
                  :key="effort"
                  :value="effort"
                  :label="teamEffortShortLabels[effort] || effort"
                />
              </el-select>
              <span v-else class="role-effort-tag">默认强度</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 底部：执行选项与关闭按钮合为一行 -->
      <footer class="settings-footer">
        <label class="auto-start-label">
          <el-switch
            v-model="profileDraft.options.autoStartLowRisk"
            size="small"
            :disabled="changing === 'profiles'"
            @change="changeAutoStart"
          />
          <span>低风险任务无需我确认计划，直接开始执行</span>
        </label>
        <el-button @click="visible = false">完成</el-button>
      </footer>
    </div>
  </el-dialog>
</template>

<style scoped>
.team-settings-shell {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: -6px;
}

.section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.section-bar-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.section-bar-title strong {
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.section-bar-title span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.section-bar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.save-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.save-badge.saving {
  color: var(--el-color-warning);
}

.save-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-color-success);
}

.save-badge.saving .save-dot {
  background: var(--el-color-warning);
}

.ai-chip-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.ai-chip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 9px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.ai-chip:hover:not(:disabled) {
  border-color: var(--el-color-primary-light-3);
}

.ai-chip.active {
  border-color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 7%, var(--el-fill-color-blank));
  box-shadow: 0 1px 3px color-mix(in srgb, var(--el-color-primary) 12%, transparent);
}

.ai-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ai-chip-top {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ai-chip-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color-darker);
  font-size: 9px;
  font-weight: 700;
  color: transparent;
  background: var(--el-fill-color-blank);
  flex-shrink: 0;
}

.ai-chip.active .ai-chip-check {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary);
  color: #fff;
}

.ai-chip-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-chip-count {
  margin-left: auto;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  white-space: nowrap;
}

.ai-chip-count.muted {
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}

.ai-chip-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.section-subbar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.section-subbar strong {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.section-subbar span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.role-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 13px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
  transition: border-color 0.15s ease;
}

.role-card:hover {
  border-color: var(--el-border-color);
}

.role-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.role-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.role-card-title strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.role-card-desc {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-card-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.role-select-model {
  flex: 1;
  min-width: 0;
}

.role-select-effort {
  width: 78px;
  flex-shrink: 0;
}

.role-effort-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 78px;
  height: 24px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  flex-shrink: 0;
}

.review-guard-card {
  background: color-mix(in srgb, var(--el-color-primary) 4%, var(--el-fill-color-blank));
  border-style: dashed;
}

.guard-pill {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
}

.guard-card-text {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}

.secondary-section {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  overflow: hidden;
}

.secondary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.secondary-bar-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.secondary-bar-main strong {
  font-size: 12.5px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}

.secondary-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.secondary-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-extra-light);
  font-size: 11px;
}

.secondary-pill em {
  font-style: normal;
  color: var(--el-text-color-secondary);
}

.secondary-pill b {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.secondary-toggle-btn {
  font-size: 12px;
  color: var(--el-color-primary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.secondary-grid {
  padding: 0 12px 12px;
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.auto-start-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}

@media (max-width: 720px) {
  .ai-chip-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .role-grid {
    grid-template-columns: 1fr;
  }
}
</style>

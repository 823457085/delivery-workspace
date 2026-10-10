<script setup lang="ts">
/**
 * 设计说明：这是 AI Agent 会话控制面的容器，只负责编排运行时状态、当前会话、新建会话和后端动作。
 * 会话列表与消息窗口分别作为纯展示/事件组件，避免容器同时承担大段界面；现有抽屉继续承载诊断详情。
 */
import { computed, nextTick, onBeforeUnmount, reactive, shallowRef, useTemplateRef, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentRun, AgentRunMode, AgentServiceTier, SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput } from '../../../shared/agent-runtime';
import { workbenchRuntime } from '../../../shared/agent-runtime';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { dateTime } from '../../shared/format';
import AgentConversation from './AgentConversation.vue';
import AgentForkDialog from './AgentForkDialog.vue';
import AgentEditMessageDialog from './AgentEditMessageDialog.vue';
import AgentInitialLoading from './AgentInitialLoading.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentModelSettings from './AgentModelSettings.vue';
import AgentNewConversation, { type AgentWorkspaceOption } from './AgentNewConversation.vue';
import AgentSessionList from './AgentSessionList.vue';
import AgentSidePanel from './AgentSidePanel.vue';
import AgentPanelResize from './AgentPanelResize.vue';
import AgentResponsivePanel from './AgentResponsivePanel.vue';
import { useAgentViewport } from './useAgentViewport';
import { agentRunProjectPath, buildAgentConversationList, findAgentConversation, reconcileAgentConversation, resumedConversationId,
  type AgentConversation as AgentConversationModel } from './conversation';
import { groupRunExecutionEvents, summarizeRunExecution } from './execution-summary';
import { readLastAgentSessionId, saveLastAgentSessionId } from './last-session-state';
import { isPinnedAgentSession, migratePinnedAgentSessionIds, readPinnedAgentSessionIds, savePinnedAgentSessionIds,
  togglePinnedAgentSession } from './session-pins';
import { useAgentRuntimes } from './useAgentRuntimes';
import { removePendingAgentAttachments } from './useAgentAttachments';
import { useAgentBusinessContext } from './useAgentBusinessContext';
import { useAgentConversationDrafts } from './useAgentConversationDrafts';
import { createDailyReportInput, dailyReportDate } from './daily-report';
import { providerSwitchInput } from './provider-switch';
import { codexServiceTier } from './model-speed';

defineProps<{ workbenchOpen?: boolean }>();
const emit = defineEmits<{ chat: []; ready: [hasSession: boolean] }>();

const { query, changing, streamStatus, codexDetails, start, spawn, orchestrate, stop, pauseForEdit, revise, steer, deleteQueuedRun, retry, resume, resumeCodexSession, fork, syncCodexSessions, loadCodexSession,
  removeConversation, updateConversationTitle, addCustomModel, removeCustomModel } = useAgentRuntimes();
const { data, dataUpdatedAt, error, isPending } = query;
const picker = useWorkspacePicker();
const modelDialog = shallowRef(false);
const forkSource = shallowRef<AgentRun>();
const editSource = shallowRef<AgentRun>();
const editObjective = shallowRef('');
const editDialogOpen = shallowRef(false);
const forkObjective = shallowRef('');
const forkAttachments = shallowRef<AgentAttachment[]>([]);
const detail = shallowRef<AgentRun>();
const selectedConversationId = shallowRef('');
const rememberedConversationId = readLastAgentSessionId(window.localStorage);
const selectionInitialized = shallowRef(false);
const pendingConversationId = shallowRef('');
let selectionRevision = 0;
let pendingSelectionRevision = 0;
const { draft, attachments: draftAttachments, clear: clearConversationDraft, restore: restoreConversationDraft, move: moveConversationDraft,
  pendingAttachments: pendingDraftAttachments } = useAgentConversationDrafts(selectedConversationId);
const newAttachments = shallowRef<AgentAttachment[]>([]);
const leftCollapsed = shallowRef(false);
const rightCollapsed = shallowRef(false);
const { mobile, keyboardOpen, viewportStyle } = useAgentViewport();
const mobilePanel = shallowRef<'sessions' | 'details' | ''>('');
watch(mobile, () => { mobilePanel.value = ''; });
const leftWidth = shallowRef(300);
const rightWidth = shallowRef(336);
const creating = shallowRef(false);
watch([selectedConversationId, creating], () => { mobilePanel.value = ''; });
const conversationPane = useTemplateRef<InstanceType<typeof AgentConversation>>('conversationPane');
const newConversationPane = useTemplateRef<InstanceType<typeof AgentNewConversation>>('newConversationPane');
const pinnedConversationIds = shallowRef(readPinnedAgentSessionIds(window.localStorage));
const detailDrawer = computed({ get: () => !!detail.value, set: (open: boolean) => { if (!open) detail.value = undefined; } });
const detailSummary = computed(() => detail.value ? summarizeRunExecution(detail.value) : []);
const detailEvents = computed(() => groupRunExecutionEvents(detail.value?.events || []));
let savedNewServiceTier: string | null = null;
try { savedNewServiceTier = window.localStorage.getItem('agent-service-tier:new'); }
catch { /* 存储不可用时沿用执行器配置 */ }
const form = reactive<StartAgentRunInput & { accessMode: AgentAccessMode; reasoningEffort: AgentReasoningEffort | ''; branch: string }>({
  provider: 'codex', mode: 'agent', accessMode: 'workspace', model: '', reasoningEffort: '', objective: '', workspacePath: '', branch: '',
  serviceTier: savedNewServiceTier === 'default' || savedNewServiceTier === 'priority' ? savedNewServiceTier : undefined,
});
watch(() => form.serviceTier, (value) => {
  if (value) {
    try { window.localStorage.setItem('agent-service-tier:new', value); }
    catch { /* 当前页面仍使用选中的档位 */ }
  }
});
const runtimes = computed(() => (data.value?.runtimes || []).map(workbenchRuntime));
const dailyReportStarting = shallowRef(false);
const dailyReportRuntime = computed(() => runtimes.value.find((runtime) => runtime.provider === 'codex'));
const dailyReportAvailable = computed(() => !!createDailyReportInput(dailyReportDate(), sideWorkspacePath.value, dailyReportRuntime.value));
const runs = computed(() => data.value?.runs || []);
const conversations = computed(() => buildAgentConversationList(runs.value, data.value?.codexSessions || [], codexDetails.value,
  data.value?.conversationTitles || {}));
const selectedConversation = computed(() => findAgentConversation(conversations.value, selectedConversationId.value));
const detailRoundNumber = computed(() => detail.value
  ? (selectedConversation.value?.runs.findIndex((run) => run.id === detail.value?.id) ?? -1) + 1 : 0);
const sideWorkspacePath = computed(() => creating.value ? form.workspacePath : selectedConversation.value ? agentRunProjectPath(selectedConversation.value.latest) : '');
const sideProvider = computed<AgentProvider>(() => creating.value ? form.provider : selectedConversation.value?.latest.provider || 'codex');
const { context: businessContext, mentions: businessMentions, loading: businessLoading }
  = useAgentBusinessContext(() => creating.value ? undefined : selectedConversation.value);
const conversationChanging = computed(() => changing.value || pendingConversationId.value);
const selectedCodexHistoryId = computed(() => selectedConversation.value?.runs.find((run) => run.originSessionId)?.originSessionId
  || (selectedConversation.value?.source === 'codex' ? selectedConversation.value.id : ''));
const selectedRuntime = computed(() => runtimes.value.find((runtime) => runtime.provider === form.provider));
const modelOptions = computed(() => selectedRuntime.value?.models || []);
const selectedModelOption = computed(() => modelOptions.value.find((model) => model.id === form.model));
const effortOptions = computed(() => selectedModelOption.value?.efforts || []);
const workspaceOptions = computed<AgentWorkspaceOption[]>(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const options = new Map<string, AgentWorkspaceOption>();
  for (const conversation of conversations.value) {
    if (Date.parse(conversation.updatedAt) < cutoff) continue;
    const path = agentRunProjectPath(conversation.latest);
    if (!path || options.has(path)) continue;
    const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
    const executorIndex = parts.findIndex((part, index) => part === '.data' && parts[index + 1] === 'design-executor');
    const leaf = parts.at(-1) || path;
    const label = executorIndex > 0
      ? `${parts[executorIndex - 1]} / design-executor`
      : ['admin', 'delivery-admin'].includes(leaf.toLowerCase()) ? parts.at(-2) || leaf : leaf;
    options.set(path, { path, branch: conversation.latest.baseBranch || conversation.latest.branch, label });
  }
  return [...options.values()];
});
const canStart = computed(() => !!selectedRuntime.value?.ready && selectedRuntime.value.modes.includes(form.mode)
  && !!selectedModelOption.value && (!effortOptions.value.length || effortOptions.value.includes(form.reasoningEffort as AgentReasoningEffort))
  && (!!form.objective.trim() || !!newAttachments.value.length) && (!newAttachments.value.length || form.provider === 'codex')
  && !changing.value);
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };

watch(conversations, (items) => {
  const migratedPins = migratePinnedAgentSessionIds(pinnedConversationIds.value, items);
  if (![...migratedPins].some((id) => !pinnedConversationIds.value.has(id))
    && ![...pinnedConversationIds.value].some((id) => !migratedPins.has(id))) return;
  pinnedConversationIds.value = migratedPins;
  savePinnedAgentSessionIds(window.localStorage, migratedPins);
}, { immediate: true });

watch([conversations, isPending, error, pendingConversationId], ([items, pending, loadError], [previousItems = []]) => {
  if (pending || loadError) return;
  // SSE 可能先于发送响应到达。先迁移同一会话的草稿，再更新选中项，避免窗口截断后丢失输入。
  for (const previous of previousItems) {
    const current = reconcileAgentConversation(items, previous.id, previousItems);
    if (current && current.id !== previous.id) moveConversationDraft(previous.id, current.id);
  }
  if (!selectionInitialized.value) {
    selectionInitialized.value = true;
    const remembered = findAgentConversation(items, rememberedConversationId);
    if (remembered) {
      selectedConversationId.value = remembered.id;
      creating.value = false;
    } else {
      selectedConversationId.value = '';
      creating.value = true;
      if (rememberedConversationId) saveLastAgentSessionId(window.localStorage, '');
    }
    return;
  }
  if (!items.length) { selectedConversationId.value = ''; creating.value = true; }
  else if (creating.value) return;
  else if (pendingConversationId.value && pendingSelectionRevision === selectionRevision) {
    const target = reconcileAgentConversation(items, pendingConversationId.value, previousItems)
      || reconcileAgentConversation(items, selectedConversationId.value, previousItems);
    if (target) selectedConversationId.value = target.id;
  }
  else {
    const selected = reconcileAgentConversation(items, selectedConversationId.value, previousItems);
    selectedConversationId.value = selected?.id || items[0].id;
  }
}, { immediate: true });

watch(selectionInitialized, initialized => { if (initialized) emit('ready', !!selectedConversation.value); }, { immediate: true });
watch([selectedConversation, creating], ([conversation, isCreating]) => {
  saveLastAgentSessionId(window.localStorage, isCreating ? '' : conversation?.id || '');
});

watch(() => [selectedCodexHistoryId.value, dataUpdatedAt.value] as const, async ([id]) => {
  if (!id || codexDetails.value[id]) return;
  try { await loadCodexSession(id); } catch { /* 下次运行时状态刷新后自动重试，摘要内容继续可用 */ }
}, { immediate: true });

watch(selectedRuntime, (runtime) => {
  if (!runtime) return;
  if (!form.model || !runtime.models.some((item) => item.id === form.model)) form.model = runtime.defaultModel;
}, { immediate: true });
watch(selectedModelOption, (option) => {
  const efforts = option?.efforts || [];
  if (!efforts.includes(form.reasoningEffort as AgentReasoningEffort)) {
    form.reasoningEffort = option?.defaultEffort || efforts[0] || '';
  }
}, { immediate: true });

function resetForm() {
  if (newAttachments.value.length) void removePendingAgentAttachments(newAttachments.value);
  newAttachments.value = [];
  form.provider = 'codex'; form.mode = 'agent'; form.accessMode = 'workspace'; form.model = runtimes.value.find((runtime) => runtime.provider === 'codex')?.defaultModel || '';
  form.reasoningEffort = runtimes.value.find((runtime) => runtime.provider === 'codex')?.models.find((model) => model.id === form.model)?.defaultEffort || '';
  form.objective = ''; form.workspacePath = ''; form.branch = '';
}
function openCreate() { selectionRevision++; selectedConversationId.value = ''; creating.value = true; }
function selectConversation(id: string) { selectionRevision++; creating.value = false; selectedConversationId.value = id; }
function openSession(id: string) {
  const direct = findAgentConversation(conversations.value, id);
  const bySession = conversations.value.filter(item => item.runs.some(run => run.sessionId === id));
  const conversation = direct || (bySession.length === 1 ? bySession[0] : undefined);
  if (!conversation) return false;
  selectConversation(conversation.id);
  return true;
}
async function openRun(id: string) {
  const requestSelectionRevision = ++selectionRevision;
  await query.refetch();
  if (selectionRevision !== requestSelectionRevision) return false;
  const conversation = findAgentConversation(conversations.value, id);
  if (!conversation) return false;
  selectConversation(conversation.id);
  return true;
}
defineExpose({ openSession, openRun, compose: composeBusinessPrompt });
async function generateDailyReport(date: string) {
  if (dailyReportStarting.value || changing.value) return;
  const input = createDailyReportInput(date, sideWorkspacePath.value, dailyReportRuntime.value);
  if (!input) return;
  const requestSelectionRevision = selectionRevision;
  dailyReportStarting.value = true;
  try {
    const run = await start(input);
    if (run && selectionRevision === requestSelectionRevision) selectConversation(run.id);
  } finally { dailyReportStarting.value = false; }
}
async function chooseWorkspace() {
  const selection = await picker.choose(form.workspacePath);
  if (!selection) return;
  form.workspacePath = selection.workspacePath;
  form.branch = selection.branch;
}
async function submit() {
  if (!canStart.value) return;
  const requestSelectionRevision = selectionRevision;
  const run = await start({ ...form, serviceTier: form.provider === 'codex' ? codexServiceTier(selectedRuntime.value, form.model, form.serviceTier) : undefined,
  isolateWorkspace: true, attachmentIds: newAttachments.value.map((item) => item.id) });
  if (!run) return;
  newAttachments.value = [];
  resetForm();
  if (selectionRevision === requestSelectionRevision) {
    selectedConversationId.value = run.id;
    creating.value = false;
  }
}
async function openEditMessage(run: AgentRun) {
  const conversationId = selectedConversationId.value;
  const paused = await pauseForEdit(run);
  if (!paused || selectedConversationId.value !== conversationId || creating.value) return;
  if (editSource.value?.id !== paused.id) editObjective.value = paused.objective;
  editSource.value = paused;
  editDialogOpen.value = true;
}

async function saveEditedMessage() {
  const source = editSource.value;
  if (!source || changing.value) return;
  const next = await revise(source, editObjective.value);
  if (!next) return;
  editDialogOpen.value = false;
  editSource.value = undefined;
  editObjective.value = '';
  await query.refetch();
}

async function sendMessage(selection: { provider?: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean }) {
  const conversation = selectedConversation.value;
  const objective = draft.value.trim();
  if (!conversation || changing.value || pendingConversationId.value || (!objective && !draftAttachments.value.length)) return;
  const targetProvider = selection.provider || conversation.latest.provider;
  const switchingProvider = targetProvider !== conversation.latest.provider;
  if (selection.workflow && !switchingProvider) { await startAgentWorkflow({ templateId: 'implement-review', objective,
    model: selection.model, reasoningEffort: selection.reasoningEffort, accessMode: selection.accessMode,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}) }); return; }
  const conversationId = conversation.id;
  const sentDraft = clearConversationDraft(conversationId)!;
  const attachmentIds = sentDraft.attachments.map((item) => item.id);
  const requestSelectionRevision = selectionRevision;
  pendingSelectionRevision = requestSelectionRevision;
  pendingConversationId.value = conversation.id;
  let accepted = false;
  try {
    const source = selection.queuePlacement === 'next'
      ? conversation.runs.find((run) => run.status === 'running') || conversation.latest
      : conversation.latest;
    const run = switchingProvider
      ? await start({ ...providerSwitchInput(conversation, objective, { ...selection, provider: targetProvider }), attachmentIds })
      : conversation.source === 'codex'
      ? await resumeCodexSession(conversation.id, objective, selection.model, selection.reasoningEffort, attachmentIds, selection.accessMode, selection.serviceTier)
      : await resume(source, objective, selection.model, selection.reasoningEffort, attachmentIds, selection.accessMode, selection.queuePlacement,
        selection.queuePlacement === 'next' ? undefined : selection.serviceTier);
    if (!run) return;
    accepted = true;
    const targetId = resumedConversationId(conversation, run);
    pendingConversationId.value = targetId;
    await query.refetch();
    const target = findAgentConversation(conversations.value, targetId);
    if (target && !switchingProvider) moveConversationDraft(conversationId, target.id);
    if (target && selectionRevision === requestSelectionRevision) selectedConversationId.value = target.id;
  } finally {
    if (!accepted) restoreConversationDraft(
      reconcileAgentConversation(conversations.value, conversationId, [conversation])?.id || conversationId, sentDraft);
    pendingConversationId.value = '';
  }
}
async function retryRun(run: AgentRun) {
  const conversation = selectedConversation.value;
  if (!conversation) return;
  const requestSelectionRevision = selectionRevision;
  pendingSelectionRevision = requestSelectionRevision;
  pendingConversationId.value = conversation.id;
  try {
    const next = await retry(run);
    if (!next) return;
    const targetId = resumedConversationId(conversation, next);
    pendingConversationId.value = targetId;
    await query.refetch();
    const target = findAgentConversation(conversations.value, targetId);
    if (target && selectionRevision === requestSelectionRevision) selectedConversationId.value = target.id;
  } finally {
    pendingConversationId.value = '';
  }
}
function openForkConversation(run: AgentRun) {
  if (forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
  forkObjective.value = '';
  forkAttachments.value = [];
  forkSource.value = run;
}
function closeForkDialog() {
  if (forkSource.value && changing.value === `fork:${forkSource.value.id}`) return;
  if (forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
  forkObjective.value = '';
  forkAttachments.value = [];
  forkSource.value = undefined;
}
async function forkConversation() {
  const source = forkSource.value;
  if (!source) return;
  const requestSelectionRevision = selectionRevision;
  const next = await fork(source, forkObjective.value, forkAttachments.value.map((item) => item.id));
  if (!next) return;
  forkAttachments.value = [];
  forkObjective.value = '';
  forkSource.value = undefined;
  pendingSelectionRevision = requestSelectionRevision;
  pendingConversationId.value = next.id;
  try {
    await query.refetch();
    if (selectionRevision === requestSelectionRevision) {
      selectedConversationId.value = findAgentConversation(conversations.value, next.id)?.id || next.id;
      creating.value = false;
    }
  } finally {
    pendingConversationId.value = '';
  }
}
async function removeAgentConversation(conversation: AgentConversationModel) {
  const removed = await removeConversation(conversation.id, conversation.source);
  if (!removed) return;
  const removedDraft = clearConversationDraft(conversation.id);
  if (removedDraft?.attachments.length) void removePendingAgentAttachments(removedDraft.attachments);
}
async function renameAgentConversation(conversation: AgentConversationModel) {
  try {
    const { value } = await ElMessageBox.prompt('请输入新的会话标题', '修改会话标题', {
      inputValue: conversation.title,
      inputValidator: (input) => !input.trim() ? '请输入会话标题' : input.trim().length > 120 ? '会话标题不能超过 120 个字符' : true,
      confirmButtonText: '保存', cancelButtonText: '取消', closeOnClickModal: false,
    });
    await updateConversationTitle(conversation.id, value);
  } catch { /* 取消修改时保留原标题 */ }
}
function togglePinnedConversation(conversation: AgentConversationModel) {
  const next = togglePinnedAgentSession(pinnedConversationIds.value, conversation);
  pinnedConversationIds.value = next;
  savePinnedAgentSessionIds(window.localStorage, next);
}
async function composeBusinessPrompt(prompt: string) {
  if (!selectedConversation.value && !creating.value) openCreate();
  if (creating.value) {
    const current = form.objective.trim();
    form.objective = current ? `${current}\n\n${prompt}` : prompt;
    await nextTick();
    newConversationPane.value?.focusPrompt();
    return;
  }
  const current = draft.value.trim();
  draft.value = current ? `${current}\n\n${prompt}` : prompt;
  await nextTick();
  conversationPane.value?.focusComposer();
}
async function spawnAgentTask(input: SpawnAgentTaskInput) {
  const parent = selectedConversation.value?.latest;
  if (!parent) return;
  await spawn(parent, input);
}
async function startAgentWorkflow(input: StartAgentTaskWorkflowInput) {
  const conversation = selectedConversation.value;
  if (!conversation || conversation.source === 'codex' || !input.objective.trim()) return;
  const revision = selectionRevision;
  const sentDraft = clearConversationDraft(conversation.id)!;
  let accepted = false;
  try {
    const result = await orchestrate(conversation.latest, { ...input, attachmentIds: sentDraft.attachments.map((item) => item.id) });
    if (!result) return;
    accepted = true;
    await query.refetch();
    if (selectionRevision === revision) selectConversation(result.worker.id);
  } finally {
    if (!accepted) restoreConversationDraft(conversation.id, sentDraft);
  }
}
function providerLabel(provider: AgentProvider) { return provider === 'codex' ? '启元' : 'Cursor Agent'; }
function modeLabel(mode: AgentRunMode) { return mode === 'agent' ? 'Agent 执行' : mode === 'plan' ? '方案分析' : '只读问答'; }
function modelLabel(run: AgentRun) {
  return runtimes.value.find((runtime) => runtime.provider === run.provider)?.models.find((model) => model.id === run.model)?.label
    || run.model || 'CLI 默认';
}
onBeforeUnmount(() => {
  if (newAttachments.value.length) void removePendingAgentAttachments(newAttachments.value);
  const pending = pendingDraftAttachments();
  if (pending.length) void removePendingAgentAttachments(pending);
  if (forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
});
</script>

<template>
  <section class="agent-panel" :class="{ 'mobile-layout': mobile, 'keyboard-open': keyboardOpen }" :style="{ '--session-column-width': `min(${leftWidth}px, 28vw)`, '--execution-column-width': `min(${rightWidth}px, 28vw)`, ...viewportStyle }">
    <slot name="navigation" />
    <header v-if="mobile" class="mobile-agent-toolbar">
      <button type="button" :aria-expanded="mobilePanel === 'sessions'" @click="mobilePanel = 'sessions'">会话列表</button>
      <strong>启元</strong>
      <button type="button" @click="openCreate(); emit('chat')">新对话</button>
      <button v-if="!workbenchOpen" type="button" :aria-expanded="mobilePanel === 'details'" @click="mobilePanel = 'details'">详情</button>
    </header>
    <AgentInitialLoading v-if="isPending" />
    <div v-else class="agent-body">
      <el-alert v-if="error" :title="error.message" type="error" :closable="false" />
      <div class="session-shell" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed }">
        <AgentResponsivePanel class="session-column" :mobile="mobile" :open="mobile ? mobilePanel === 'sessions' : !leftCollapsed" side="left" title="会话列表" @close="mobilePanel = ''">
        <AgentSessionList :conversations="conversations" :selected-id="selectedConversationId" :runtimes="runtimes"
          :sync-state="data?.codexSync" :usage="data?.codexUsage" :changing="changing" :pinned-ids="pinnedConversationIds" @select="mobilePanel = ''; selectConversation($event); emit('chat')" @create="mobilePanel = ''; openCreate(); emit('chat')"
          @sync="syncCodexSessions" @refresh="query.refetch()" />
        </AgentResponsivePanel>
        <AgentPanelResize v-show="!mobile && !leftCollapsed" v-model="leftWidth" side="left" />
        <AgentPanelResize v-show="!mobile && !rightCollapsed && !workbenchOpen" v-model="rightWidth" side="right" />
        <AgentNewConversation v-if="creating" v-show="!workbenchOpen" ref="newConversationPane" v-model:provider="form.provider" v-model:mode="form.mode" v-model:access-mode="form.accessMode" v-model:model="form.model" v-model:service-tier="form.serviceTier" v-model:reasoning-effort="form.reasoningEffort"
          v-model:objective="form.objective" v-model:attachments="newAttachments" v-model:workspace-path="form.workspacePath" v-model:branch="form.branch" class="conversation-column"
          :runtimes="runtimes" :workspaces="workspaceOptions" :business-options="businessMentions" :changing="changing" :can-start="canStart"
          @send="submit" @choose-workspace="chooseWorkspace" @configure-models="modelDialog = true" />
        <AgentConversation v-else v-show="!workbenchOpen" ref="conversationPane" v-model="draft" v-model:attachments="draftAttachments" class="conversation-column" :conversation="selectedConversation" :pinned="!!selectedConversation && isPinnedAgentSession(pinnedConversationIds, selectedConversation)" :changing="conversationChanging" :runtimes="runtimes"
          :left-collapsed="leftCollapsed" :right-collapsed="rightCollapsed" :business-options="businessMentions" @send="sendMessage" @stop="stop" @steer="steer" @remove-queued="deleteQueuedRun" @retry="retryRun" @fork="openForkConversation"
          @edit="openEditMessage" @pin="togglePinnedConversation" @rename="renameAgentConversation" @remove="removeAgentConversation" @inspect="detail = $event" @configure-models="modelDialog = true"
          @toggle-left="mobile ? mobilePanel = 'sessions' : leftCollapsed = !leftCollapsed" @toggle-right="mobile ? mobilePanel = 'details' : rightCollapsed = !rightCollapsed" />
        <AgentResponsivePanel v-show="!workbenchOpen" class="execution-column" :mobile="mobile" :open="mobile ? mobilePanel === 'details' && !workbenchOpen : !rightCollapsed" side="right" title="会话详情" @close="mobilePanel = ''">
        <AgentSidePanel :conversation="creating ? undefined : selectedConversation"
          :conversations="conversations"
          :context="businessContext" :loading="businessLoading"
          :workspace-path="sideWorkspacePath" :provider="sideProvider" :stream-status="streamStatus" :spawning="changing.startsWith('spawn:')"
          :changing="!!changing"
          @inspect="detail = $event || selectedConversation?.latest" @compose="mobilePanel = ''; composeBusinessPrompt($event)" @select-conversation="mobilePanel = ''; selectConversation($event)"
          @spawn-agent="spawnAgentTask" @focus="conversationPane?.focusComposer()" @stop="stop" @retry="retryRun" />
        </AgentResponsivePanel>
        <div v-if="workbenchOpen" class="workbench-column"><slot name="workbench" :daily-report-available="dailyReportAvailable" :daily-report-pending="dailyReportStarting || !!changing" :generate-daily-report="async (date: string) => { const before = selectedConversationId; await generateDailyReport(date); if (selectedConversationId !== before) emit('chat'); }" :compose="(prompt: string) => { emit('chat'); composeBusinessPrompt(prompt); }" /></div>
      </div>
    </div>
  </section>

  <el-drawer v-model="detailDrawer" :title="detail ? `${providerLabel(detail.provider)}${detailRoundNumber ? ` · 第 ${detailRoundNumber} 轮` : ''} 会话信息` : 'Agent 会话信息'" size="min(760px, 94vw)" class="hub-drawer" destroy-on-close>
    <template v-if="detail"><dl class="detail-facts"><div><dt>状态</dt><dd><StatusPill :value="detail.status" /></dd></div><div><dt>模式 / 模型</dt><dd>{{ modeLabel(detail.mode) }} · {{ modelLabel(detail) }}{{ detail.reasoningEffort ? ` · Thinking ${effortLabels[detail.reasoningEffort]}` : '' }}</dd></div><div><dt>访问权限</dt><dd>{{ detail.mode !== 'agent' ? '只读访问' : detail.accessMode === 'full' ? '完全访问' : '工作区访问' }}</dd></div><div v-if="detail.isolatedWorkspace"><dt>源项目 / 基线</dt><dd>{{ detail.sourceWorkspacePath }}<br />{{ detail.baseBranch }}</dd></div><div><dt>{{ detail.isolatedWorkspace ? '隔离工作区' : '工作区' }}</dt><dd>{{ detail.workspacePath }}</dd></div><div><dt>{{ detail.branch || detail.headSha ? '分支 / HEAD' : '工作区类型' }}</dt><dd>{{ detail.branch || '普通文件夹' }}<template v-if="detail.headSha"><br />{{ detail.headSha }}</template></dd></div><div><dt>CLI Session ID</dt><dd>{{ detail.sessionId || '尚未取得' }}</dd></div><div><dt>本机 PID</dt><dd>{{ detail.pid || '已结束' }}</dd></div></dl><section class="detail-section"><h3>本轮消息</h3><p>{{ detail.objective }}</p></section><section v-if="detail.result" class="detail-section"><h3>本轮结果</h3><AgentMarkdown :source="detail.result" /></section><el-alert v-if="detail.error" :title="detail.error" type="error" :closable="false" /><section class="detail-section"><h3>执行摘要</h3><div class="drawer-summary"><article v-for="item in detailSummary" :key="item.key" :class="item.tone"><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></article></div><details v-if="detail.events.length" :key="detail.id" class="raw-events" open><summary>查看原始运行记录（{{ detail.events.length }}）</summary><el-timeline v-if="detailEvents.visible.length"><el-timeline-item v-for="event in [...detailEvents.visible].reverse()" :key="event.id" :timestamp="dateTime(event.createdAt)">{{ event.message }}</el-timeline-item></el-timeline><details v-if="detailEvents.routine.length" class="routine-events"><summary>工作区命令：{{ detailEvents.routineSummary }}（{{ detailEvents.routine.length }} 个节点）</summary><el-timeline><el-timeline-item v-for="event in [...detailEvents.routine].reverse()" :key="event.id" :timestamp="dateTime(event.createdAt)">{{ event.message }}</el-timeline-item></el-timeline></details></details></section></template>
    <template #footer><el-button @click="detail = undefined">关闭</el-button></template>
  </el-drawer>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
  <AgentModelSettings v-model="modelDialog" :runtimes="runtimes" :changing="changing" @add="addCustomModel" @remove="removeCustomModel" />
  <AgentForkDialog :open="!!forkSource" v-model:objective="forkObjective" v-model:attachments="forkAttachments" :source="forkSource"
    :submitting="!!forkSource && changing === `fork:${forkSource.id}`" @submit="forkConversation" @cancel="closeForkDialog" />
  <AgentEditMessageDialog v-model="editObjective" :open="editDialogOpen" :source="editSource"
    :submitting="!!changing" @submit="saveEditedMessage" @close="editDialogOpen = false" />
</template>

<style scoped>
.agent-panel{display:flex;flex-direction:column}.agent-body{flex:1;height:auto!important}.workbench-column{grid-column:2 / -1;grid-row:1;min-width:0;min-height:0;overflow:hidden}.session-column,.conversation-column,.execution-column{grid-row:1}
.agent-panel{--agent-bg:color-mix(in srgb,var(--ui-nav) 82%,#05070c);--agent-panel:color-mix(in srgb,var(--ui-nav-raised) 58%,#11151d);--agent-panel-strong:color-mix(in srgb,var(--ui-nav-raised) 72%,#1a202b);--agent-raised:color-mix(in srgb,var(--ui-nav-border) 48%,#222936);--agent-border:color-mix(in srgb,var(--ui-nav-border) 70%,#273041);--agent-text:var(--ui-nav-text);--agent-secondary:color-mix(in srgb,var(--ui-nav-text) 82%,var(--ui-nav-muted));--agent-muted:var(--ui-nav-muted);--agent-accent:var(--ui-accent);--agent-cyan:color-mix(in srgb,var(--ui-accent) 42%,#37c8f6);--session-column-width:360px;--execution-column-width:420px;position:fixed;inset:0;z-index:60;min-width:1080px;overflow:hidden;background:radial-gradient(circle at 48% -18%,color-mix(in srgb,var(--agent-accent) 18%,transparent) 0,transparent 42%),var(--agent-bg);color:var(--agent-text);font-family:var(--sans)}
.agent-body,.session-shell{height:100%;min-width:0;min-height:0;overflow:hidden}.agent-body>.el-alert{position:absolute;z-index:4;left:calc(var(--session-column-width) + 12px);right:calc(var(--execution-column-width) + 6px);top:12px}.session-shell{display:grid;grid-template-columns:var(--session-column-width) minmax(0,1fr) var(--execution-column-width);grid-template-rows:minmax(0,1fr)}.session-column{grid-column:1}.conversation-column{grid-column:2}.execution-column{grid-column:3}.session-shell.left-collapsed{grid-template-columns:0 minmax(0,1fr) var(--execution-column-width)}.session-shell.right-collapsed{grid-template-columns:var(--session-column-width) minmax(0,1fr) 0}.session-shell.left-collapsed.right-collapsed{grid-template-columns:0 minmax(0,1fr) 0}.detail-facts dd{word-break:break-all}.drawer-summary{display:grid;gap:8px}.drawer-summary article{padding:11px 13px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-fill-color-light)}.drawer-summary strong{font-size:13px;color:var(--el-text-color-primary)}.drawer-summary p{margin:4px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.drawer-summary article.warning{border-color:var(--el-color-warning-light-7)}.drawer-summary article.danger{border-color:var(--el-color-danger-light-7)}.raw-events{margin-top:14px}.raw-events summary{padding:8px 0;color:var(--el-text-color-secondary);font-size:12px;cursor:pointer}.raw-events:deep(.el-timeline){margin-top:10px;padding-left:4px}.routine-events{margin:2px 0 12px;padding:0 12px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-fill-color-light)}.routine-events>summary{color:var(--el-text-color-regular)}
:global(.agent-model-popper.el-popper),:global(.agent-workspace-popper.el-popper){--el-bg-color-overlay:#202129;--el-text-color-regular:#c7c7d2;--el-fill-color-light:#302f43;border-color:#414250;background:#202129}:global(.agent-model-popper .el-select-dropdown__item){color:#c7c7d2}:global(.agent-model-popper .el-select-dropdown__item.is-hovering),:global(.agent-model-popper .el-select-dropdown__item:hover){background:#302f43}:global(.agent-model-popper .el-select-dropdown__item.is-selected){color:#aaa3ff}
:global(.agent-panel *::-webkit-scrollbar){width:7px;height:7px}:global(.agent-panel *::-webkit-scrollbar-track){background:transparent}:global(.agent-panel *::-webkit-scrollbar-thumb){border:2px solid transparent;border-radius:8px;background:#4a5366;background-clip:padding-box}:global(.agent-panel *::-webkit-scrollbar-thumb:hover){background:#626d84;background-clip:padding-box}
@media(max-width:1440px){.agent-panel{--session-column-width:320px;--execution-column-width:380px}}
</style>

<style src="./agent-appearance.css"></style>
<style src="./agent-mobile.css"></style>

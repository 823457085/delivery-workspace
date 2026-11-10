<script setup lang="ts">
/**
 * 设计说明：这是 AI Agent 会话控制面的容器，只负责编排运行时状态、当前会话、新建会话和后端动作。
 * 会话列表与消息窗口分别作为纯展示/事件组件，避免容器同时承担大段界面；现有抽屉继续承载诊断详情。
 */
import { computed, nextTick, onBeforeUnmount, reactive, shallowRef, useTemplateRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { GitFork, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, X } from '@lucide/vue';
import type { AgentAccessMode, AgentApiProvider, AgentAttachment, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentRun, AgentRunMode, AgentServiceTier, SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput, AgentWorkflowAction } from '../../../shared/agent-runtime';
import type { AgentTeamRequest } from './AgentTeamDialog.vue';
import { codexWorkbenchDefaults, workbenchRuntime } from '../../../shared/agent-runtime';
import type { DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import { agentModelDefaults } from '../../shared/agent-model-defaults';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import AgentGroupChat from './AgentGroupChat.vue';
import AgentConversation from './AgentConversation.vue';
import AgentForkDialog from './AgentForkDialog.vue';
import AgentEditMessageDialog from './AgentEditMessageDialog.vue';
import AgentInitialLoading from './AgentInitialLoading.vue';
import AgentRunDetails from './AgentRunDetails.vue';
import AgentModelSettings from './AgentModelSettings.vue';
import AgentRecoveryDialog from './AgentRecoveryDialog.vue';
import AgentConnectionStatus from './AgentConnectionStatus.vue';
import AgentNewConversation, { type AgentWorkspaceOption } from './AgentNewConversation.vue';
import { buildWorkspaceCatalog } from './workspace-catalog';
import AgentSessionList from './AgentSessionList.vue';
import AgentSidePanel from './AgentSidePanel.vue';
import AgentProjectLaunch from './AgentProjectLaunch.vue';
import AgentPanelResize from './AgentPanelResize.vue';
import AgentResponsivePanel from './AgentResponsivePanel.vue';
import { useAgentViewport } from './useAgentViewport';
import { agentRunStatus, agentConversationContinuation, agentConversationInsertRun, agentConversationRunRounds, agentRunContextPath, agentRunProjectPath, agentConversationProjectPath, buildAgentConversationList, findAgentConversation, reconcileAgentConversation, resumedConversationId, compareAgentConversations,
  type AgentConversation as AgentConversationModel } from './conversation';
import { readableRunTask } from './execution-summary';
import { readLastAgentSessionId, saveLastAgentSessionId } from './last-session-state';
import { isPinnedAgentSession, migratePinnedAgentSessionIds, readPinnedAgentSessionIds, savePinnedAgentSessionIds,
  togglePinnedAgentSession } from './session-pins';
import { useAgentRuntimes } from './useAgentRuntimes';
import { useAgentTeamChat } from './useAgentTeamChat';
import { withTeamChatConversations, type TeamQuestionTarget } from './team-chat';
import { AgentAttachmentDraft, removePendingAgentAttachments } from './useAgentAttachments';
import { useAgentBusinessContext } from './useAgentBusinessContext';
import { useAgentConversationDrafts } from './useAgentConversationDrafts';
import { createDailyReportInput, dailyReportDate, findDailyReportRun } from './daily-report';
import { providerSwitchInput } from './provider-switch';
import { codexServiceTier } from './model-speed';
import { deliveryAcceptanceQueryKey, readDeliveryAcceptances } from '../workbench/acceptance-api';
import { reconcileDeliveryRecords } from '../workbench/domain';
import { jiraDevTasksQueryKey, jiraDevTaskWorkspacePaths, matchConversationJiraDevTask, readJiraDevTasks } from './jira-dev-context';

const props = defineProps<{ workbenchOpen?: boolean }>();
const emit = defineEmits<{ chat: []; ready: [hasSession: boolean]; group: [id: string] }>();

const { query, refreshStatus, refreshing, changing, streamStatus, codexDetails, start, spawn, orchestrate, decideWorkflow, stop, pauseForEdit, revise, steer, deleteQueuedRun, retry, resume, resumeCodexSession, fork, syncCodexSessions, loadCodexSession,
  removeConversation, removeConversations, updateConversationTitle, addCustomModel, removeCustomModel } = useAgentRuntimes();
const { data, dataUpdatedAt, error, isPending } = query;
const acceptanceQuery = useQuery({ queryKey: deliveryAcceptanceQueryKey, retry: false,
  queryFn: ({ signal }) => readDeliveryAcceptances(signal), refetchInterval: 15_000 });
const jiraTasksQuery = useQuery({ queryKey: jiraDevTasksQueryKey, retry: false,
  queryFn: ({ signal }) => readJiraDevTasks(signal), refetchInterval: 10_000 });
const jiraTasks = computed(() => jiraTasksQuery.data.value || []);
const acceptanceByConversationId = computed<Map<string, DeliveryAcceptanceRecord>>(() => new Map<string, DeliveryAcceptanceRecord>((acceptanceQuery.data.value || [])
  .filter((record: DeliveryAcceptanceRecord) => record.recordId.startsWith('agent:'))
  .map((record: DeliveryAcceptanceRecord) => [record.recordId.slice('agent:'.length), record])));
const acceptanceKnown = computed(() => !!acceptanceQuery.data.value && !acceptanceQuery.error.value);
const picker = useWorkspacePicker();
const modelDialog = shallowRef(false);
const modelDialogProvider = shallowRef<AgentApiProvider>();
function openModelSettings(provider?: AgentApiProvider) {
  modelDialogProvider.value = provider;
  modelDialog.value = true;
}
const forkSource = shallowRef<AgentRun>();
const forkInSide = shallowRef(false);
const editSource = shallowRef<AgentRun>();
const editObjective = shallowRef('');
const editDialogOpen = shallowRef(false);
const forkObjective = shallowRef('');
const forkAttachments = shallowRef<AgentAttachment[]>([]);
const forkAttachmentDraft = shallowRef(new AgentAttachmentDraft(forkAttachments));
const detail = shallowRef<AgentRun>();
const selectedConversationId = shallowRef('');
const rememberedConversationId = readLastAgentSessionId(window.localStorage);
const selectionInitialized = shallowRef(false);
const pendingConversationId = shallowRef('');
let selectionRevision = 0;
let pendingSelectionRevision = 0;
const { draft, attachments: draftAttachments, attachmentDraft: conversationAttachmentDraft, attachmentsPending,
  clear: clearConversationDraft, restore: restoreConversationDraft, move: moveConversationDraft,
  bind: bindConversationDraft, pendingAttachments: pendingDraftAttachments, dispose: disposeConversationDrafts } = useAgentConversationDrafts(selectedConversationId);
const newAttachments = shallowRef<AgentAttachment[]>([]);
const newAttachmentDraft = shallowRef(new AgentAttachmentDraft(newAttachments));
const submittingNew = shallowRef(false);
let panelDisposed = false;
const leftCollapsed = shallowRef(false);
const sessionsCollapsed = computed(() => props.workbenchOpen || leftCollapsed.value);
// 进入 Agent 工作台时默认展示右侧执行过程，便于直接看到进度、任务房间和多 Agent 协作状态。
// 用户仍可通过标题栏按钮手动收起；这里只调整首次进入的默认状态。
const rightCollapsed = shallowRef(false);
const { mobile, keyboardOpen, viewportStyle } = useAgentViewport();
const mobilePanel = shallowRef<'sessions' | 'details' | ''>('');
watch(mobile, () => { mobilePanel.value = ''; });
// 布局和栏宽独立于配色，切换主题时保留用户当前的面板状态。
const leftWidth = shallowRef(232);
const rightWidth = shallowRef(320);
const executionColumnWidth = computed(() => `min(${rightWidth.value}px, 28vw)`);
function toggleSessions() {
  if (mobile.value) mobilePanel.value = mobilePanel.value === 'sessions' ? '' : 'sessions';
  else leftCollapsed.value = !leftCollapsed.value;
}
function toggleDetails() {
  if (mobile.value) mobilePanel.value = mobilePanel.value === 'details' ? '' : 'details';
  else rightCollapsed.value = !rightCollapsed.value;
}
const creating = shallowRef(false);
const groupMode = shallowRef(new URLSearchParams(window.location.search).get('group') === '1');
const groupRoomId = shallowRef<string | undefined>(new URLSearchParams(window.location.search).get('room') || undefined);
function openGroup(id?: string) { groupMode.value = true; groupRoomId.value = id; }
function openGroups() { groupMode.value = true; emit('group', groupRoomId.value || ''); }
function selectGroup(id: string) { groupRoomId.value = id; if (groupMode.value && !props.workbenchOpen) emit('group', id); }
const automaticAccessMode = shallowRef<AgentAccessMode>('full');
const teamChat = useAgentTeamChat(() => creating.value ? '' : selectedConversationId.value);
watch([selectedConversationId, creating], () => { mobilePanel.value = ''; });
const conversationPane = useTemplateRef<InstanceType<typeof AgentConversation>>('conversationPane');
const newConversationPane = useTemplateRef<InstanceType<typeof AgentNewConversation>>('newConversationPane');
const pinnedConversationIds = shallowRef(readPinnedAgentSessionIds(window.localStorage));
const detailDrawer = computed({ get: () => !!detail.value, set: (open: boolean) => { if (!open) detail.value = undefined; } });
const detailTask = computed(() => readableRunTask(detail.value?.objective || ''));
let savedNewServiceTier: string | null = null;
try { savedNewServiceTier = window.localStorage.getItem('agent-service-tier:v2:new'); }
catch { /* 存储不可用时使用工作台普通速度 */ }
const workspacePaths = shallowRef<string[]>([]);
let lastHandoffDraft = '';
const form = reactive<StartAgentRunInput & { accessMode: AgentAccessMode; reasoningEffort: AgentReasoningEffort | ''; branch: string }>({
  provider: agentModelDefaults.value.provider || 'codex', mode: 'agent', accessMode: 'full', model: '', reasoningEffort: '', objective: '', workspacePath: '', branch: '',
  serviceTier: savedNewServiceTier === 'default' || savedNewServiceTier === 'priority' ? savedNewServiceTier : codexWorkbenchDefaults.serviceTier,
});
watch(() => form.serviceTier, (value) => {
  if (value) {
    try { window.localStorage.setItem('agent-service-tier:v2:new', value); }
    catch { /* 当前页面仍使用选中的档位 */ }
  }
});
const runtimes = computed(() => (data.value?.runtimes || []).map(runtime => workbenchRuntime(runtime, agentModelDefaults.value)));
const workflows = computed(() => data.value?.workflows || []);
const dailyReportStarting = shallowRef(false);
const dailyReportRuntime = computed(() => runtimes.value.find((runtime) => runtime.provider === 'codex'));
const dailyReportAvailable = computed(() => !!createDailyReportInput(dailyReportDate(), sideWorkspacePath.value, dailyReportRuntime.value, new Date(), agentModelDefaults.value));
const runs = computed(() => data.value?.runs || []);
const conversations = computed(() => {
  const groupTaskIds = new Set(teamChat.allTasks.value.filter(task => task.groupRoomId).map(task => task.id));
  const groupRuns = runs.value.filter(run => run.team?.interactionMode === 'group' || run.team && groupTaskIds.has(run.team.taskId));
  const groupRunIds = new Set(groupRuns.map(run => run.id));
  const groupSessionIds = new Set(groupRuns.flatMap(run => [run.sessionId, run.originSessionId].filter(Boolean)));
  return withTeamChatConversations(buildAgentConversationList(runs.value.filter(run => !groupRunIds.has(run.id)),
    (data.value?.codexSessions || []).filter(session => !groupSessionIds.has(session.id)), codexDetails.value,
    data.value?.conversationTitles || {}), teamChat.allTasks.value.filter(task => !task.groupRoomId), data.value?.conversationTitles || {}).sort(compareAgentConversations);
});
const selectedConversation = computed(() => findAgentConversation(conversations.value, selectedConversationId.value));
const sideChatOpen = shallowRef(false);
const sideChatVisible = computed(() => sideChatOpen.value && !mobile.value && !props.workbenchOpen);
const sideTabIds = shallowRef<string[]>([]);
const activeSideId = shallowRef('');
const choosingSide = shallowRef(false);
const sideSending = shallowRef(false);
const sideChoices = computed(() => conversations.value.filter(item => !item.teamChat && (creating.value || item.id !== selectedConversation.value?.id)));
const sideTabs = computed(() => sideTabIds.value
  .map(id => findAgentConversation(conversations.value, id))
  .filter((item): item is AgentConversationModel => !!item && !item.teamChat));
const sideConversation = computed(() => {
  const available = sideTabs.value.filter(item => creating.value || item.id !== selectedConversation.value?.id);
  return available.find(item => item.id === activeSideId.value) || available[0];
});
const sideConversationId = computed(() => sideConversation.value?.id || '');
const { draft: sideDraft, attachments: sideAttachments, attachmentDraft: sideAttachmentDraft } = bindConversationDraft(sideConversationId);
const projectlessFork = computed(() => {
  const snapshot = data.value;
  return !!snapshot && 'projectlessFork' in snapshot && snapshot.projectlessFork === true;
});
const sideForkSource = computed(() => {
  const conversation = !creating.value && selectedConversation.value;
  if (!conversation || conversation.source !== 'workspace' || conversation.teamChat
    || conversation.runs.some(run => run.status === 'running' || run.status === 'queued')) return;
  const run = conversation.latest;
  if (run.provider === 'codex' && run.status === 'completed' && run.sessionId && run.codexTurnId
    && (projectlessFork.value || run.sourceWorkspacePath !== '' || run.branch || run.headSha)) return run;
});
function openSideConversation(id: string) {
  if (!sideTabIds.value.includes(id)) sideTabIds.value = [...sideTabIds.value, id];
  activeSideId.value = id;
  choosingSide.value = false;
  sideChatOpen.value = true;
}
function closeSideTab(id: string) {
  sideTabIds.value = sideTabIds.value.filter(item => item !== id);
  if (activeSideId.value === id) activeSideId.value = '';
}
function replaceSideTab(id: string, nextId: string) {
  if (id === nextId || !sideTabIds.value.includes(id)) return;
  sideTabIds.value = [...new Set(sideTabIds.value.map(item => item === id ? nextId : item))];
  if (activeSideId.value === id) activeSideId.value = nextId;
}
watch(conversations, (items, previous) => {
  for (const id of sideTabIds.value) {
    const conversation = reconcileAgentConversation(items, id, previous);
    if (conversation && !conversation.teamChat) replaceSideTab(id, conversation.id);
    else if (findAgentConversation(previous, id)) closeSideTab(id);
  }
});
const matchedJiraTask = computed(() => creating.value ? undefined : matchConversationJiraDevTask(selectedConversation.value, jiraTasks.value));
const automaticTeam = computed(() => !creating.value && !!selectedConversation.value?.teamChat);
const selectedDeliveryRecord = computed(() => selectedConversation.value?.latest.task?.workflow?.stage === 'implement'
  ? reconcileDeliveryRecords([], [], runs.value, { includeStandalone: true, runtimeKnown: !!data.value && !error.value,
    workflows: workflows.value, acceptances: acceptanceQuery.data.value, acceptanceKnown: acceptanceKnown.value })
    .find(record => record.id === `agent:${selectedConversation.value!.id}`) : undefined);
const detailRoundNumber = computed(() => !groupMode.value && detail.value
  ? agentConversationRunRounds(selectedConversation.value).get(detail.value.id) || 0 : 0);
const sideWorkspacePath = computed(() => creating.value ? form.workspacePath : selectedConversation.value ? selectedConversation.value.teamChat ? agentConversationProjectPath(selectedConversation.value) : agentRunContextPath(selectedConversation.value.latest) : '');
const launchWorkspacePaths = computed(() => {
  if (creating.value) return workspacePaths.value.length ? workspacePaths.value : form.workspacePath ? [form.workspacePath] : [];
  const conversation = selectedConversation.value;
  const projectPath = conversation ? agentConversationProjectPath(conversation) : '';
  const path = conversation && projectPath ? (conversation.teamChat ? projectPath : conversation.latest.workspacePath) : '';
  if (matchedJiraTask.value) {
    return [...new Set([...jiraDevTaskWorkspacePaths(matchedJiraTask.value), ...(path ? [path] : [])])];
  }
  return path ? [path] : [];
});
const desktopDetailsAvailable = computed(() => !props.workbenchOpen && !sideChatVisible.value && (!creating.value || launchWorkspacePaths.value.length > 0));
const desktopDetailsOpen = computed(() => desktopDetailsAvailable.value && !rightCollapsed.value);
const desktopSideControls = computed(() => !mobile.value && !props.workbenchOpen);
const detailsPanelOpen = computed(() => mobile.value ? mobilePanel.value === 'details' && !props.workbenchOpen : desktopDetailsOpen.value);
const sideProvider = computed<AgentProvider>(() => creating.value ? form.provider : selectedConversation.value?.latest.provider || 'codex');
const usageCards = computed(() => [
  { key: 'codex-plan', label: 'Codex 套餐', usage: data.value?.codexUsage },
  // API 余额不是 ChatGPT 套餐窗口；没有真实数据源时不生成占位额度卡。
  ...(data.value?.apiUsage?.available ? [{ key: 'api', label: 'API', usage: data.value.apiUsage }] : []),
  { key: 'cursor', label: 'Cursor', usage: data.value?.cursorUsage },
  { key: 'claude', label: 'Claude Code', usage: data.value?.claudeUsage },
]);
const connectionStatusTarget = computed(() => groupMode.value && !props.workbenchOpen ? '#group-connection-status' : mobile.value ? '#mobile-connection-status'
  : props.workbenchOpen ? '#workspace-connection-status' : creating.value ? '#new-connection-status' : '#conversation-connection-status');
const { context: businessContext, mentions: businessMentions, loading: businessLoading, projectsData }
  = useAgentBusinessContext(() => creating.value ? undefined : selectedConversation.value);
const conversationChanging = computed(() => changing.value || teamChat.changing.value || pendingConversationId.value);
const selectedCodexHistoryId = computed(() => selectedConversation.value?.runs.find((run) => run.originSessionId)?.originSessionId
  || (selectedConversation.value?.source === 'codex' ? selectedConversation.value.id : ''));
const sideCodexHistoryId = computed(() => sideChatVisible.value
  ? sideConversation.value?.runs.find(run => run.originSessionId)?.originSessionId
    || (sideConversation.value?.source === 'codex' ? sideConversation.value.id : '') : '');
const selectedRuntime = computed(() => runtimes.value.find((runtime) => runtime.provider === form.provider));
const modelOptions = computed(() => selectedRuntime.value?.models || []);
const selectedModelOption = computed(() => modelOptions.value.find((model) => model.id === form.model));
const effortOptions = computed(() => selectedModelOption.value?.efforts || []);
const workspaceOptions = computed<AgentWorkspaceOption[]>(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent: { path: string; branch?: string }[] = [];
  for (const conversation of conversations.value) {
    if (Date.parse(conversation.updatedAt) < cutoff) continue;
    const path = agentConversationProjectPath(conversation);
    if (!path) continue;
    recent.push({ path, branch: conversation.latest.baseBranch || conversation.latest.branch });
  }
  return buildWorkspaceCatalog({
    projectsData: projectsData.value,
    recent,
    selectedPaths: workspacePaths.value.length ? workspacePaths.value : (form.workspacePath ? [form.workspacePath] : []),
  });
});
const canStart = computed(() => !!selectedRuntime.value?.ready && selectedRuntime.value.modes.includes(form.mode)
  && (!selectedRuntime.value.accessModes || selectedRuntime.value.accessModes.includes(form.accessMode))
  && !!selectedModelOption.value && (!effortOptions.value.length || (form.provider === 'claude' && !form.reasoningEffort)
    || effortOptions.value.includes(form.reasoningEffort as AgentReasoningEffort))
  && (!!form.objective.trim() || !!newAttachments.value.length)
  && !changing.value && !submittingNew.value && !newAttachmentDraft.value.pending);
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
    if (creating.value) return;
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

watch(selectionInitialized, initialized => { if (initialized) emit('ready', !!selectedConversation.value || !!form.objective.trim()); }, { immediate: true });
watch([selectedConversation, creating], ([conversation, isCreating]) => {
  saveLastAgentSessionId(window.localStorage, isCreating ? '' : conversation?.id || '');
});

watch(() => [selectedCodexHistoryId.value, dataUpdatedAt.value] as const, async ([id]) => {
  if (!id || codexDetails.value[id]) return;
  try { await loadCodexSession(id); } catch { /* 下次运行时状态刷新后自动重试，摘要内容继续可用 */ }
}, { immediate: true });
watch([sideCodexHistoryId, dataUpdatedAt], async ([id]) => {
  if (!id || codexDetails.value[id]) return;
  try { await loadCodexSession(id); } catch { /* 快照刷新后重试，期间保留摘要。 */ }
});

watch(selectedRuntime, (runtime, previous) => {
  if (!runtime) return;
  if (runtime.provider !== previous?.provider) {
    form.reasoningEffort = '';
    form.model = runtime.defaultModel;
  }
  if (!runtime.modes.includes(form.mode)) form.mode = runtime.modes.includes('ask') ? 'ask' : runtime.modes[0] || 'ask';
  if (form.mode !== 'agent' || (runtime.accessModes && !runtime.accessModes.includes(form.accessMode))) form.accessMode = 'workspace';
  if (!form.model || !runtime.models.some((item) => item.id === form.model)) form.model = runtime.defaultModel;
}, { immediate: true });
watch(selectedModelOption, (option) => {
  const efforts = option?.efforts || [];
  if (!efforts.includes(form.reasoningEffort as AgentReasoningEffort)) {
    form.reasoningEffort = option?.defaultEffort || (form.provider === 'codex' ? efforts[0] || '' : '');
  }
}, { immediate: true });
watch(() => agentModelDefaults.value.revision, () => {
  if (form.provider !== (agentModelDefaults.value.provider || 'codex')) return;
  form.model = agentModelDefaults.value.model;
  form.reasoningEffort = agentModelDefaults.value.reasoningEffort;
});

function resetForm() {
  newAttachmentDraft.value.discard();
  if (newAttachments.value.length) void removePendingAgentAttachments(newAttachments.value);
  newAttachments.value = [];
  newAttachmentDraft.value = new AgentAttachmentDraft(newAttachments);
  form.provider = agentModelDefaults.value.provider || 'codex';
  const runtime = runtimes.value.find(item => item.provider === form.provider);
  form.mode = runtime?.modes.includes('agent') ? 'agent' : runtime?.modes.includes('ask') ? 'ask' : runtime?.modes[0] || 'ask';
  form.accessMode = form.mode === 'agent' && (!runtime?.accessModes || runtime.accessModes.includes('full')) ? 'full' : 'workspace';
  form.model = runtime?.defaultModel || '';
  form.reasoningEffort = runtime?.models.find(model => model.id === form.model)?.defaultEffort || '';
  lastHandoffDraft = '';
  form.objective = ''; form.workspacePath = ''; workspacePaths.value = []; form.branch = '';
}
function openCreate() { groupMode.value = false; selectionRevision++; selectedConversationId.value = ''; creating.value = true; }
function selectConversation(id: string) { groupMode.value = false; selectionRevision++; creating.value = false; selectedConversationId.value = id; }
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
  await Promise.all([query.refetch(), teamChat.refetch()]);
  if (selectionRevision !== requestSelectionRevision) return false;
  const run = data.value?.runs.find(run => run.id === id);
  const groupRoomId = run?.team?.interactionMode === 'group' ? run.team.taskId
    : teamChat.allTasks.value.find(task => task.groupRoomId && (task.id === run?.team?.taskId
      || task.id === id || task.parentConversationId === id))?.groupRoomId;
  if (groupRoomId) { openGroup(groupRoomId); emit('group', groupRoomId); return true; }
  const conversation = findAgentConversation(conversations.value, id);
  if (!conversation) return false;
  selectConversation(conversation.id);
  return true;
}
defineExpose({ openSession, openRun, openGroup, compose: composeBusinessPrompt });
function dailyReportForDate(date: string) { return findDailyReportRun(runs.value, date); }

async function generateDailyReport(date: string) {
  if (dailyReportStarting.value || changing.value) return;
  const current = dailyReportForDate(date);
  const status = current && agentRunStatus(current).value;
  if (status === 'queued' || status === 'running') return;
  const input = createDailyReportInput(date, sideWorkspacePath.value, dailyReportRuntime.value, new Date(), agentModelDefaults.value);
  if (!input) return;
  dailyReportStarting.value = true;
  try { await start(input); }
  finally { dailyReportStarting.value = false; }
}
async function chooseWorkspace() {
  const selection = await picker.choose(form.workspacePath);
  if (!selection) return;
  const currentPaths = workspacePaths.value.length ? workspacePaths.value : (form.workspacePath ? [form.workspacePath] : []);
  const nextPaths = currentPaths.includes(selection.workspacePath) ? currentPaths : [...currentPaths, selection.workspacePath];
  workspacePaths.value = nextPaths;
  form.workspacePath = nextPaths[0] || selection.workspacePath;
  if (nextPaths.length === 1) form.branch = selection.branch;
}
async function submit() {
  if (!canStart.value || submittingNew.value || newAttachmentDraft.value.pending) return;
  const requestSelectionRevision = selectionRevision;
  submittingNew.value = true;
  try {
    const extraPaths = workspacePaths.value;
    const multiWorkspaceNote = extraPaths.length > 1
      ? `\n\n[关联项目工作区]\n${extraPaths.map((p, i) => `- ${i === 0 ? '主工作区' : '关联工作区'}：${p}`).join('\n')}`
      : '';
    const run = await start({ ...form, ...(multiWorkspaceNote ? { objective: `${form.objective.trim()}${multiWorkspaceNote}`.trim() } : {}), serviceTier: form.provider === 'codex' ? codexServiceTier(selectedRuntime.value, form.model, form.serviceTier) : undefined,
      isolateWorkspace: true, attachmentIds: newAttachments.value.map((item) => item.id) });
    if (!run) return;
    newAttachments.value = [];
    if (panelDisposed) return;
    resetForm();
    if (selectionRevision === requestSelectionRevision) {
      selectedConversationId.value = run.id;
      creating.value = false;
    }
  } finally {
    submittingNew.value = false;
  }
}
async function openEditMessage(run: AgentRun, side = false) {
  const conversationId = side ? sideConversationId.value : selectedConversationId.value;
  const paused = await pauseForEdit(run);
  if (!paused || (side ? !sideChatVisible.value || sideConversationId.value !== conversationId
    : selectedConversationId.value !== conversationId || creating.value)) return;
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

type ConversationSendSelection = { provider?: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean; team?: AgentTeamRequest; question?: TeamQuestionTarget };
async function sendMessage(selection: ConversationSendSelection, side?: {
  conversation: AgentConversationModel; draft: string; attachments: AgentAttachment[]; accepted: (id: string) => void;
}) {
  const conversation = side ? side.conversation : selectedConversation.value;
  const objective = (side ? side.draft : draft.value).trim();
  if (!conversation || changing.value || pendingConversationId.value || attachmentsPending(conversation.id)
    || (!objective && !(side ? side.attachments : draftAttachments.value).length)) return;
  if (selection.question) { await sendQuestionAnswer(conversation, selection.question); return; }
  const continuation = agentConversationContinuation(conversation);
  const nativeBusy = conversation.runs.some(run => ['queued', 'running'].includes(run.status) && !run.team);
  if (conversation.teamChat && conversation.source !== 'codex' && !nativeBusy && !selection.workflow && !selection.team && selection.queuePlacement !== 'next') {
    await sendChatMessage(conversation, objective, undefined, selection.accessMode); return;
  }
  const targetProvider = selection.provider || continuation.provider;
  const switchingProvider = targetProvider !== continuation.provider;
  // 团队流程的模型与权限由岗位配置决定，不传输入框当前的模型、强度和访问模式。
  if (selection.team && !switchingProvider) { await startAgentWorkflow({ templateId: selection.team.templateId, objective,
    acceptanceCriteria: selection.team.acceptanceCriteria, allowedPaths: selection.team.allowedPaths }); return; }
  if (selection.workflow && !switchingProvider) { await startAgentWorkflow({ templateId: 'implement-review', objective,
    model: selection.model, reasoningEffort: selection.reasoningEffort, accessMode: selection.accessMode,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}) }); return; }
  const conversationId = conversation.id;
  const sentDraft = clearConversationDraft(conversationId)!;
  const attachmentIds = sentDraft.attachments.map((item) => item.id);
  const requestSelectionRevision = selectionRevision;
  if (!side) {
    pendingSelectionRevision = requestSelectionRevision;
    pendingConversationId.value = conversation.id;
  }
  let accepted = false;
  try {
    const insertRun = !switchingProvider && selection.queuePlacement === 'next' ? agentConversationInsertRun(conversation) : undefined;
    const queuePlacement = insertRun ? 'next' : 'append';
    const source = insertRun || continuation;
    const run = switchingProvider
      ? await start({ ...providerSwitchInput(conversation, objective, { ...selection, provider: targetProvider }), attachmentIds })
      : conversation.source === 'codex'
      ? await resumeCodexSession(conversation.id, objective, selection.model, selection.reasoningEffort, attachmentIds, selection.accessMode, selection.serviceTier)
      : await resume(source, objective, selection.model, selection.reasoningEffort, attachmentIds, selection.accessMode, queuePlacement,
        queuePlacement === 'next' ? undefined : selection.serviceTier, selection.mode);
    if (!run) return;
    accepted = true;
    const targetId = resumedConversationId(conversation, run);
    if (!side) pendingConversationId.value = targetId;
    await query.refetch();
    const target = findAgentConversation(conversations.value, targetId);
    if (target) moveConversationDraft(conversationId, target.id);
    if (side) side.accepted(target?.id || targetId);
    else if (target && selectionRevision === requestSelectionRevision) selectedConversationId.value = target.id;
  } finally {
    if (!accepted) restoreConversationDraft(
      reconcileAgentConversation(conversations.value, conversationId, [conversation])?.id || conversationId, sentDraft);
    if (!side) pendingConversationId.value = '';
  }
}
async function sendSideMessage(selection: ConversationSendSelection) {
  const conversation = sideConversation.value;
  if (!conversation || sideSending.value) return;
  sideSending.value = true;
  try {
    await sendMessage(selection, { conversation, draft: sideDraft.value, attachments: sideAttachments.value,
      accepted: id => replaceSideTab(conversation.id, id) });
  } finally { sideSending.value = false; }
}
async function sendQuestionAnswer(conversation: AgentConversationModel, question: TeamQuestionTarget) {
  const conversationId = conversation.id;
  if (!teamChat.tasks.value.some(task => task.id === question.taskId && task.parentConversationId === conversationId)) return;
  const sentDraft = clearConversationDraft(conversationId)!;
  pendingSelectionRevision = selectionRevision;
  pendingConversationId.value = conversationId;
  let accepted = false;
  try {
    accepted = await teamChat.answer({ ...question, text: sentDraft.text.trim(), attachmentIds: sentDraft.attachments.map(file => file.id) }, sentDraft.attachments);
  } finally {
    if (!accepted) restoreConversationDraft(conversationId, sentDraft);
    pendingConversationId.value = '';
  }
}
async function sendChatMessage(conversation: AgentConversationModel, objective: string, workspacePath?: string, accessMode: AgentAccessMode = 'full') {
  const conversationId = conversation.id, revision = selectionRevision;
  const sentDraft = clearConversationDraft(conversationId)!;
  pendingSelectionRevision = revision; pendingConversationId.value = conversationId;
  let accepted = false;
  try {
    const task = teamChat.task.value;
    const taskId = task?.id || [...conversation.runs].reverse().find(run => run.team?.interactionMode === 'chat')?.team?.taskId;
    // 执行基线由后端继承父会话当前候选；只有用户明确改选项目才传新目录。
    const projectPath = workspacePath || '';
    const result = await teamChat.send({ objective, attachmentIds: sentDraft.attachments.map(item => item.id),
      accessMode,
      ...(taskId ? { taskId } : !conversation.latest.id.startsWith('team-chat:') ? { parentRunId: conversation.latest.id } : {}),
      ...(projectPath ? { workspacePath: projectPath } : {}) }, sentDraft.attachments, conversationId);
    if (!result) return;
    accepted = true; pendingConversationId.value = result.conversationId;
    await query.refetch();
    if (selectionRevision === revision) selectedConversationId.value = result.conversationId;
  } finally {
    if (!accepted) restoreConversationDraft(conversationId, sentDraft);
    pendingConversationId.value = '';
  }
}
async function chooseChatWorkspace() {
  const conversation = selectedConversation.value;
  if (!conversation || conversationChanging.value) return;
  const selection = await picker.choose(teamChat.task.value?.chat?.workspaceBound ? teamChat.task.value.sourceWorkspacePath : agentConversationProjectPath(conversation));
  if (selection && selectedConversationId.value === conversation.id) {
    const text = draft.value.trim() || `使用这个项目：${selection.workspacePath}`;
    await sendChatMessage(conversation, text, selection.workspacePath, automaticAccessMode.value);
  }
}
async function stopConversation(run: AgentRun) {
  if (automaticTeam.value && teamChat.active.value) await teamChat.decide('cancel');
  else await stop(run);
}
async function retryRun(run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>, side = false) {
  const conversation = side ? sideConversation.value : selectedConversation.value;
  if (!conversation) return;
  const requestSelectionRevision = selectionRevision;
  if (!side) {
    pendingSelectionRevision = requestSelectionRevision;
    pendingConversationId.value = conversation.id;
  }
  try {
    const next = await retry(run, selection);
    if (!next) return;
    const targetId = resumedConversationId(conversation, next);
    if (!side) pendingConversationId.value = targetId;
    await query.refetch();
    const target = findAgentConversation(conversations.value, targetId);
    if (side) replaceSideTab(conversation.id, target?.id || targetId);
    else if (target && selectionRevision === requestSelectionRevision) selectedConversationId.value = target.id;
  } finally {
    if (!side) pendingConversationId.value = '';
  }
}
function openForkConversation(run: AgentRun, inSide = false) {
  forkAttachmentDraft.value.discard();
  if (forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
  forkObjective.value = '';
  forkAttachments.value = [];
  forkAttachmentDraft.value = new AgentAttachmentDraft(forkAttachments);
  forkInSide.value = inSide;
  forkSource.value = run;
}
function closeForkDialog() {
  if (forkSource.value && changing.value === `fork:${forkSource.value.id}`) return;
  forkAttachmentDraft.value.discard();
  if (forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
  forkObjective.value = '';
  forkAttachments.value = [];
  forkSource.value = undefined;
}
async function forkConversation(inSide = false) {
  const source = forkSource.value;
  if (!source || forkAttachmentDraft.value.pending) return;
  const requestSelectionRevision = selectionRevision;
  const next = await fork(source, forkObjective.value, forkAttachments.value.map((item) => item.id));
  if (!next) return;
  forkAttachmentDraft.value.discard();
  forkAttachments.value = [];
  forkObjective.value = '';
  forkSource.value = undefined;
  if (inSide) {
    await query.refetch();
    const id = next.conversationId || next.id;
    openSideConversation(findAgentConversation(conversations.value, id)?.id || id);
    return;
  }
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
async function removeAgentConversations(conversations: AgentConversationModel[]) {
  const removed = await removeConversations(conversations);
  for (const conversation of removed) {
    const removedDraft = clearConversationDraft(conversation.id);
    if (removedDraft?.attachments.length) void removePendingAgentAttachments(removedDraft.attachments);
  }
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
async function composeBusinessPrompt(prompt: string, workspacePath?: string) {
  const handoff = workspacePath !== undefined;
  if (!creating.value && (handoff || !selectedConversation.value)) openCreate();
  if (creating.value) {
    let current = form.objective.trim();
    if (handoff) {
      form.workspacePath = workspacePath;
      workspacePaths.value = workspacePath ? [workspacePath] : [];
      if (lastHandoffDraft && (current === lastHandoffDraft || current.endsWith(`\n\n${lastHandoffDraft}`))) {
        current = current.slice(0, -lastHandoffDraft.length).trimEnd();
      }
      lastHandoffDraft = prompt;
    }
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
async function decideTeamWorkflow(workflowId: string, action: AgentWorkflowAction) {
  await decideWorkflow(workflowId, action);
}
async function spawnAgentTask(input: SpawnAgentTaskInput) {
  const parent = selectedConversation.value?.latest;
  if (!parent) return;
  await spawn(parent, input);
}
async function startAgentWorkflow(input: StartAgentTaskWorkflowInput) {
  const conversation = selectedConversation.value;
  if (!conversation || conversation.source === 'codex' || !input.objective.trim() || attachmentsPending(conversation.id)) return;
  const revision = selectionRevision;
  const sentDraft = clearConversationDraft(conversation.id)!;
  let accepted = false;
  try {
    const result = await orchestrate(conversation.latest, { ...input, attachmentIds: sentDraft.attachments.map((item) => item.id) });
    if (!result) return;
    accepted = true;
    await query.refetch();
    if (selectionRevision === revision) selectConversation(result.firstRun.id);
  } finally {
    if (!accepted) restoreConversationDraft(conversation.id, sentDraft);
  }
}
function providerLabel(provider: AgentProvider) { return provider === 'api' ? '模型 API' : provider === 'codex' ? 'GPT / Codex' : provider === 'claude' ? 'Claude Code' : provider === 'kiro' ? 'Kiro CLI' : provider === 'antigravity' ? 'Antigravity CLI' : 'Cursor Agent'; }
onBeforeUnmount(() => {
  panelDisposed = true;
  newAttachmentDraft.value.discard();
  forkAttachmentDraft.value.discard();
  disposeConversationDrafts();
  // 已提交但尚未返回的附件可能已被运行接收，不能在离开页面时删除。
  if (!submittingNew.value && newAttachments.value.length) void removePendingAgentAttachments(newAttachments.value);
  const pending = pendingDraftAttachments();
  if (pending.length) void removePendingAgentAttachments(pending);
  if ((!forkSource.value || changing.value !== `fork:${forkSource.value.id}`) && forkAttachments.value.length) void removePendingAgentAttachments(forkAttachments.value);
});
</script>

<template>
  <section class="agent-panel studio-layout" :class="{ 'mobile-layout': mobile, 'keyboard-open': keyboardOpen }" :style="{ '--session-column-width': `min(${leftWidth}px, 28vw)`, '--execution-column-width': executionColumnWidth, ...viewportStyle }">
    <header v-if="mobile && (!groupMode || workbenchOpen)" class="mobile-agent-toolbar">
      <button type="button" :aria-expanded="mobilePanel === 'sessions'" @click="mobilePanel = 'sessions'">会话列表</button>
      <strong>Agent Studio</strong>
      <button type="button" @click="openCreate(); emit('chat')">新对话</button>
      <button v-if="!workbenchOpen" type="button" :aria-expanded="mobilePanel === 'details'" @click="mobilePanel = 'details'">详情</button>
      <span id="mobile-connection-status"></span>
    </header>
    <AgentInitialLoading v-if="isPending && (!groupMode || workbenchOpen)" />
    <div v-else class="agent-body">
      <el-alert v-if="error" :title="error.message" type="error" :closable="false" />
      <KeepAlive>
        <AgentGroupChat v-if="groupMode && !workbenchOpen" v-model:sidebar-width="leftWidth" :runtimes="runtimes" :initial-room-id="groupRoomId" :quotas="{ codex: data?.codexUsage, cursor: data?.cursorUsage, claude: data?.claudeUsage }" :antigravity-usage="data?.antigravityUsage" :refreshing="refreshing" :stream-status="streamStatus" @refresh="refreshStatus" @select="selectGroup" @back="groupMode = false; emit('chat')"><template #navigation><slot name="navigation" placement="sidebar" :close-navigation="() => {}" :toggle-sessions="toggleSessions" :sessions-collapsed="false" /></template></AgentGroupChat>
      </KeepAlive>
      <div v-if="!groupMode || workbenchOpen" class="session-shell" :class="{
        'left-collapsed': sessionsCollapsed, 'right-collapsed': !desktopDetailsOpen,
        'has-left-rail': desktopSideControls && leftCollapsed,
        'has-right-rail': desktopSideControls && desktopDetailsAvailable && rightCollapsed,
        'has-side-chat': sideChatVisible,
      }">
        <button v-if="desktopSideControls" type="button" class="studio-side-toggle left"
          aria-controls="studio-session-sidebar" :aria-expanded="!leftCollapsed"
          :aria-label="leftCollapsed ? '展开会话列表' : '收起会话列表'"
          :title="leftCollapsed ? '展开会话列表' : '收起会话列表'" @click="toggleSessions">
          <component :is="leftCollapsed ? PanelLeftOpen : PanelLeftClose" :size="16" />
        </button>
        <AgentResponsivePanel id="studio-session-sidebar" class="session-column" :mobile="mobile" :open="mobile ? mobilePanel === 'sessions' : !sessionsCollapsed" side="left" title="会话列表" @close="mobilePanel = ''">
        <AgentSessionList :conversations="conversations" :selected-id="selectedConversationId"
          :changing="changing" :pinned-ids="pinnedConversationIds" @select="mobilePanel = ''; selectConversation($event); emit('chat')" @create="mobilePanel = ''; openCreate(); emit('chat')"
          @groups="openGroups" @sync="syncCodexSessions" @remove="removeAgentConversations">
          <template #navigation><slot name="navigation" placement="sidebar" :close-navigation="() => { mobilePanel = ''; }" :toggle-sessions="toggleSessions" :sessions-collapsed="false" /></template>
          <template #tools><AgentRecoveryDialog :changing="changing" @retry="retryRun" @inspect="detail = $event" /></template>
          <template #navigation-footer><slot name="navigation" placement="footer" :close-navigation="() => { mobilePanel = ''; }" :toggle-sessions="toggleSessions" :sessions-collapsed="false" /></template>
        </AgentSessionList>
        </AgentResponsivePanel>
        <AgentPanelResize v-show="!mobile && !sessionsCollapsed" v-model="leftWidth" side="left" variant="project-studio" />
        <AgentPanelResize v-show="!mobile && desktopDetailsOpen" v-model="rightWidth" side="right" variant="project-studio" />
        <AgentNewConversation v-if="creating" v-show="!workbenchOpen" ref="newConversationPane" v-model:provider="form.provider" v-model:mode="form.mode" v-model:access-mode="form.accessMode" v-model:model="form.model" v-model:service-tier="form.serviceTier" v-model:reasoning-effort="form.reasoningEffort"
          v-model:objective="form.objective" v-model:attachments="newAttachments" v-model:workspace-path="form.workspacePath" v-model:workspace-paths="workspacePaths" v-model:branch="form.branch" class="conversation-column"
          :runtimes="runtimes" :workspaces="workspaceOptions" :business-options="businessMentions" :changing="submittingNew ? 'start' : changing || teamChat.changing.value" :can-start="canStart" :attachment-draft="newAttachmentDraft"
          @send="submit" @choose-workspace="chooseWorkspace" @configure-models="openModelSettings()">
          <template #header-actions><span id="new-connection-status"></span></template>
        </AgentNewConversation>
        <AgentConversation :automatic="automaticTeam" v-else v-show="!workbenchOpen" :visible="!workbenchOpen" ref="conversationPane" v-model="draft" v-model:attachments="draftAttachments" class="conversation-column" :conversation="selectedConversation" :pinned="!!selectedConversation && isPinnedAgentSession(pinnedConversationIds, selectedConversation)" :changing="conversationChanging" :runtimes="runtimes"
          :attachment-draft="conversationAttachmentDraft" :team-tasks="teamChat.tasks.value" :team-room="teamChat.room.value" :team-attachments="teamChat.attachments.value" :jira-task="matchedJiraTask"
          :side-fork-available="!mobile && !!sideForkSource" :projectless-fork="projectlessFork" @fork-side="openForkConversation($event, true)"
          :business-options="businessMentions" @send="sendMessage" @access-change="automaticAccessMode = $event" @stop="stopConversation" @team-decision="teamChat.decide" @team-command="teamChat.command" @choose-team-workspace="chooseChatWorkspace" @steer="steer" @remove-queued="deleteQueuedRun" @retry="retryRun" @fork="openForkConversation"
          @edit="openEditMessage" @pin="togglePinnedConversation" @rename="renameAgentConversation" @remove="removeAgentConversation" @inspect="detail = $event" @configure-models="openModelSettings()"
          @open-group="openGroup($event); emit('group', $event)">
          <template #header-actions>
            <span id="conversation-connection-status"></span>
            <button v-if="!mobile" type="button" class="side-chat-action" aria-controls="agent-side-chat"
              aria-label="侧边聊天" title="侧边聊天" :aria-expanded="sideChatOpen" @click="sideChatOpen = !sideChatOpen">
              <PanelRightOpen :size="16" />
            </button>
          </template>
        </AgentConversation>
        <section v-if="sideChatVisible" id="agent-side-chat" class="side-chat-column" aria-label="侧边聊天">
          <header class="side-chat-bar">
            <nav class="side-chat-tabs" aria-label="侧边会话标签">
              <strong v-if="!sideTabs.length" class="side-chat-label">侧边聊天</strong>
              <div v-for="tab in sideTabs" :key="tab.id" class="side-chat-tab" :class="{ active: tab.id === sideConversationId }">
                <button type="button" :aria-pressed="tab.id === sideConversationId" :title="tab.title"
                  :disabled="!creating && tab.id === selectedConversation?.id"
                  @click="openSideConversation(tab.id)">{{ tab.title }}</button>
                <button type="button" class="side-chat-action" :aria-label="`关闭侧边标签：${tab.title}`" @click="closeSideTab(tab.id)"><X :size="13" /></button>
              </div>
            </nav>
            <button type="button" class="side-chat-action" aria-label="打开已有会话" title="打开已有会话"
              :aria-expanded="choosingSide || !sideConversation" @click="choosingSide = !choosingSide"><Plus :size="17" /></button>
            <button v-if="sideForkSource" type="button" class="side-chat-action" aria-label="基于主会话新建" title="基于主会话新建"
              :disabled="!!changing" @click="openForkConversation(sideForkSource, true)"><GitFork :size="16" /></button>
            <button type="button" class="side-chat-action" aria-label="关闭侧边聊天" title="关闭侧边聊天"
              @click="sideChatOpen = false"><X :size="17" /></button>
          </header>
          <div v-if="choosingSide || !sideConversation" class="side-chat-picker">
            <el-select :model-value="undefined" filterable placeholder="搜索并打开已有会话" aria-label="搜索并打开已有会话"
              @change="openSideConversation">
              <el-option v-for="item in sideChoices" :key="item.id" :value="item.id" :label="item.title" />
            </el-select>
            <el-button v-if="sideForkSource" :disabled="!!changing" @click="openForkConversation(sideForkSource, true)">
              <GitFork :size="14" /> 基于主会话新建
            </el-button>
          </div>
          <AgentConversation v-if="sideConversation" v-model="sideDraft" v-model:attachments="sideAttachments" :conversation="sideConversation"
            :attachment-draft="sideAttachmentDraft" :business-options="[]" :runtimes="runtimes" :changing="conversationChanging || (sideSending ? 'side:send' : '')"
            :pinned="isPinnedAgentSession(pinnedConversationIds, sideConversation)" :jira-task="matchConversationJiraDevTask(sideConversation, jiraTasks)" :projectless-fork="projectlessFork"
            @send="sendSideMessage" @stop="stop" @steer="steer" @remove-queued="deleteQueuedRun" @retry="(run, selection) => retryRun(run, selection, true)"
            @fork="openForkConversation($event, true)" @edit="openEditMessage($event, true)" @pin="togglePinnedConversation"
            @rename="renameAgentConversation" @remove="removeAgentConversation" @inspect="detail = $event" @configure-models="openModelSettings()"
            @open-group="openGroup($event); emit('group', $event)" />
        </section>
        <button v-if="desktopSideControls && desktopDetailsAvailable" type="button" class="studio-side-toggle right"
          aria-controls="studio-details-sidebar" :aria-expanded="desktopDetailsOpen"
          :aria-label="rightCollapsed ? '展开会话详情' : '收起会话详情'"
          :title="rightCollapsed ? '展开会话详情' : '收起会话详情'" @click="toggleDetails">
          <component :is="rightCollapsed ? PanelRightOpen : PanelRightClose" :size="16" />
        </button>
        <AgentResponsivePanel id="studio-details-sidebar" class="execution-column" :mobile="mobile" :open="detailsPanelOpen" side="right" title="会话详情" @close="mobilePanel = ''">
        <AgentSidePanel :conversation="creating ? undefined : selectedConversation" :team-room="creating ? undefined : teamChat.room.value"
          :conversations="conversations"
          :context="businessContext" :loading="businessLoading"
          :workspace-path="sideWorkspacePath" :provider="sideProvider" :stream-status="streamStatus" :spawning="changing.startsWith('spawn:')"
          :changing="!!changing" :acceptances="acceptanceByConversationId" :acceptance-known="acceptanceKnown" :workflows="workflows" :delivery-record="selectedDeliveryRecord"
          :matched-jira-task="matchedJiraTask" :default-tab="matchedJiraTask ? 'delivery' : 'execution'" :panel-open="detailsPanelOpen" external-collapse
          @inspect="detail = $event || selectedConversation?.latest" @compose="mobilePanel = ''; composeBusinessPrompt($event)" @select-conversation="mobilePanel = ''; selectConversation($event)"
          @spawn-agent="spawnAgentTask" @decide-workflow="decideTeamWorkflow" @focus="conversationPane?.focusComposer()" @stop="stop" @retry="retryRun"
          @open-group="openGroup($event); emit('group', $event)">
          <template v-if="launchWorkspacePaths.length" #project-launch><AgentProjectLaunch class="project-launch-sidebar" :workspace-paths="launchWorkspacePaths" /></template>
        </AgentSidePanel>
        </AgentResponsivePanel>
        <div v-if="workbenchOpen" class="workbench-column"><slot name="workbench" :daily-report-available="dailyReportAvailable" :daily-report-pending="dailyReportStarting || !!changing" :daily-report-for-date="dailyReportForDate" :generate-daily-report="generateDailyReport" /></div>
      </div>
    </div>
  </section>

  <el-drawer v-model="detailDrawer" :title="detail ? `执行记录 · ${detailTask.role || providerLabel(detail.provider)}${detailRoundNumber ? ` · 第 ${detailRoundNumber} 轮` : ''}` : '执行记录'" size="min(760px, 94vw)" class="hub-drawer" destroy-on-close>
    <AgentRunDetails v-if="detail" :run="detail" :runtimes="runtimes" />
    <template #footer><el-button @click="detail = undefined">关闭</el-button></template>
  </el-drawer>
  <Teleport v-if="!isPending" defer :to="connectionStatusTarget">
    <AgentConnectionStatus :runtimes="runtimes" :usage-cards="usageCards" :antigravity-usage="data?.antigravityUsage" :refreshing="refreshing" @refresh="refreshStatus" @configure-models="openModelSettings" />
  </Teleport>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
  <AgentModelSettings v-model="modelDialog" :runtimes="runtimes" :changing="changing" :initial-provider="modelDialogProvider" @add="addCustomModel" @remove="removeCustomModel" />
  <AgentForkDialog :open="!!forkSource" v-model:objective="forkObjective" v-model:attachments="forkAttachments" :source="forkSource" :in-side="forkInSide"
    :attachment-draft="forkAttachmentDraft"
    :submitting="!!forkSource && changing === `fork:${forkSource.id}`" @submit="forkConversation(forkInSide)" @cancel="closeForkDialog" />
  <AgentEditMessageDialog v-model="editObjective" :open="editDialogOpen" :source="editSource"
    :submitting="!!changing" @submit="saveEditedMessage" @close="editDialogOpen = false" />
</template>

<style scoped>
.session-shell.has-side-chat {
  grid-template-columns: var(--visible-session-width, var(--session-column-width)) minmax(0, 1fr) minmax(0, 1fr);
}
.side-chat-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  grid-area: 1 / 3;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.side-chat-column > .conversation-pane { flex: 1; height: auto; }
.side-chat-bar, .side-chat-picker {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface);
}
.side-chat-picker { flex-wrap: wrap; padding: 8px; }
.side-chat-picker > .el-select { flex: 1 1 175px; min-width: 0; }
.side-chat-picker > .el-button { gap: 4px; margin-left: 0; }
.side-chat-tabs {
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
}
.side-chat-label { padding: 4px; font-size: 12px; }
.side-chat-tab {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: min(165px, 85%);
  padding: 1px 2px;
  border-radius: 7px;
}
.side-chat-tab.active { background: var(--ui-accent-soft); color: var(--ui-accent); }
.side-chat-tab > button:first-child {
  min-width: 0;
  padding: 4px 5px;
  overflow: hidden;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.side-chat-action {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary);
  cursor: pointer;
}
.side-chat-tab .side-chat-action { width: 23px; height: 23px; }
.side-chat-action:hover { background: var(--ui-hover); color: var(--ui-accent); }
.side-chat-action:disabled, .side-chat-tab > button:disabled { opacity: .55; cursor: default; }
.side-chat-action:focus-visible, .side-chat-tab > button:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
}
.agent-panel{display:flex;flex-direction:column}.agent-body{flex:1;height:auto!important}.workbench-column{grid-column:2 / -1;grid-row:1;min-width:0;min-height:0;overflow:hidden}.session-column,.conversation-column,.execution-column{grid-row:1}
.agent-panel{--agent-bg:color-mix(in srgb,var(--ui-nav) 82%,#05070c);--agent-panel:color-mix(in srgb,var(--ui-nav-raised) 58%,#11151d);--agent-panel-strong:color-mix(in srgb,var(--ui-nav-raised) 72%,#1a202b);--agent-raised:color-mix(in srgb,var(--ui-nav-border) 48%,#222936);--agent-border:color-mix(in srgb,var(--ui-nav-border) 70%,#273041);--agent-text:var(--ui-nav-text);--agent-secondary:color-mix(in srgb,var(--ui-nav-text) 82%,var(--ui-nav-muted));--agent-muted:var(--ui-nav-muted);--agent-accent:var(--ui-accent);--agent-cyan:color-mix(in srgb,var(--ui-accent) 42%,#37c8f6);--session-column-width:360px;--execution-column-width:420px;position:fixed;inset:0;z-index:60;min-width:1080px;overflow:hidden;background:radial-gradient(circle at 48% -18%,color-mix(in srgb,var(--agent-accent) 18%,transparent) 0,transparent 42%),var(--agent-bg);color:var(--agent-text);font-family:var(--sans)}
.agent-body,.session-shell{height:100%;min-width:0;min-height:0;overflow:hidden}.agent-body>.el-alert{position:absolute;z-index:4;left:calc(var(--session-column-width) + 12px);right:calc(var(--execution-column-width) + 6px);top:12px}.session-shell{display:grid;grid-template-columns:var(--visible-session-width,var(--session-column-width)) minmax(0,1fr) var(--visible-execution-width,var(--execution-column-width));grid-template-rows:minmax(0,1fr)}.session-column{grid-column:1}.conversation-column{grid-column:2}.execution-column{grid-column:3}.session-shell.left-collapsed{--visible-session-width:0px}.session-shell.right-collapsed{--visible-execution-width:0px}.detail-facts dd{word-break:break-all}.drawer-summary{display:grid;gap:8px}.drawer-summary article{padding:11px 13px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-fill-color-light)}.drawer-summary strong{font-size:13px;color:var(--el-text-color-primary)}.drawer-summary p{margin:4px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.drawer-summary article.warning{border-color:var(--el-color-warning-light-7)}.drawer-summary article.danger{border-color:var(--el-color-danger-light-7)}.raw-events{margin-top:14px}.raw-events summary{padding:8px 0;color:var(--el-text-color-secondary);font-size:12px;cursor:pointer}.raw-events:deep(.el-timeline){margin-top:10px;padding-left:4px}.routine-events{margin:2px 0 12px;padding:0 12px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-fill-color-light)}.routine-events>summary{color:var(--el-text-color-regular)}
:global(.agent-model-popper.el-popper),:global(.agent-workspace-popper.el-popper){--el-bg-color-overlay:#202129;--el-text-color-regular:#c7c7d2;--el-fill-color-light:#302f43;border-color:#414250;background:#202129}:global(.agent-model-popper .el-select-dropdown__item){color:#c7c7d2}:global(.agent-model-popper .el-select-dropdown__item.is-hovering),:global(.agent-model-popper .el-select-dropdown__item:hover){background:#302f43}:global(.agent-model-popper .el-select-dropdown__item.is-selected){color:#aaa3ff}
:global(.agent-panel *::-webkit-scrollbar){width:7px;height:7px}:global(.agent-panel *::-webkit-scrollbar-track){background:transparent}:global(.agent-panel *::-webkit-scrollbar-thumb){border:2px solid transparent;border-radius:8px;background:#4a5366;background-clip:padding-box}:global(.agent-panel *::-webkit-scrollbar-thumb:hover){background:#626d84;background-clip:padding-box}
@media(max-width:1440px){.agent-panel{--session-column-width:320px;--execution-column-width:380px}}
</style>

<style src="./agent-appearance.css"></style>
<style src="./agent-mobile.css"></style>
<style src="./agent-studio.css"></style>

<style scoped>
.execution-overview{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--ui-secondary);font-size:12px}.execution-task-title{font-weight:600;font-size:14px}.execution-task p{margin:8px 0;line-height:1.75;overflow-wrap:anywhere}.execution-task-text{white-space:pre-wrap}.execution-original{margin-top:16px;border-top:1px solid var(--ui-divider,var(--ui-border));padding-top:10px}.execution-original>summary{cursor:pointer;color:var(--ui-secondary);font-size:12px}.execution-original>pre,.execution-original :deep(.el-timeline),.readable-events pre{max-height:420px;overflow:auto}.execution-original pre,.readable-events pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono);color:var(--ui-secondary)}.execution-original :deep(.el-timeline){margin:14px 0 0;padding-left:16px}.readable-events{list-style:none;margin:0;padding:0}.readable-events>li{padding:10px 0;border-top:1px solid var(--ui-divider,var(--ui-border))}.readable-events time{color:var(--ui-muted);font-size:11px}.readable-events summary{cursor:pointer;line-height:1.75;overflow-wrap:anywhere}.readable-events summary small{margin-right:8px;color:var(--ui-muted);font-size:11px}.readable-events summary span{font-size:12px}
</style>

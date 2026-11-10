<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, CornerUpLeft, Download, Ellipsis, Folder, FolderOpen, Info, PanelRight, Pencil, Pin, Plus, Send, Settings2, Square, Trash2, Upload, Users } from '@lucide/vue';
import type { AgentAccessMode, AgentAttachment, AgentReasoningEffort, AgentRun, AgentRuntimeHealth, AgentProvider, AgentUsageLimits, AntigravityUsageLimits } from '../../../shared/agent-runtime';
import type { ProjectsData } from '../../../shared/hub';
import { agentProviderLabels, isAgentImageAttachment } from '../../../shared/agent-runtime';
import { groupCapabilityLabels, type GroupChatDashboard, type GroupConfig, type GroupMember, type GroupRoomDetail, type GroupSteerInput, type GroupTurn } from '../../../shared/agent-group-chat';
import { useSource } from '../../shared/api';
import { useWorkspaceRestart } from '../../shared/version/useWorkspaceRestart';
import { dateTime } from '../../shared/format';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import AgentSidebarHeader from './AgentSidebarHeader.vue';
import AgentAvatar from './AgentAvatar.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentPromptEditor from './AgentPromptEditor.vue';
import AgentEditMessageDialog from './AgentEditMessageDialog.vue';
import AgentWorkspaceSelector from './AgentWorkspaceSelector.vue';
import AgentProjectLaunch from './AgentProjectLaunch.vue';
import AgentCursorButton from './AgentCursorButton.vue';
import { buildWorkspaceCatalog, workspacePathLabel } from './workspace-catalog';
import AgentGroupSummary from './AgentGroupSummary.vue';
import AgentElapsedTime from './AgentElapsedTime.vue';
import { groupRoundTiming } from './group-elapsed';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentTeamQuestion from './AgentTeamQuestion.vue';
import AgentGroupDetailsPanel from './AgentGroupDetailsPanel.vue';
import AgentPanelResize from './AgentPanelResize.vue';
import { answerTeamMessage, decideTeamTask, readTeamRoom } from './team-api';
import { teamChatActivity, teamChatActiveStates, teamQuestionReply, teamQuestionState, type TeamQuestionTarget } from './team-chat';
import { agentReplyText, agentRunActivity, agentRunPublicMessages, groupRunExecutionEvents, previewRunExecution } from './execution-summary';
import { readableToolEvents } from './tool-activity';
import { useAgentConversationDrafts } from './useAgentConversationDrafts';
import { useAgentModelSelection } from './model-selection';
import { useAgentAttachments, removePendingAgentAttachments } from './useAgentAttachments';
import { createRequestId } from '../requirement-development/request-id';
import { readGroupDashboard, readGroupRoom, readRemoteDelivery, sendGroupMessage, renameGroupRoom, removeGroupRoom, pauseGroupMessage, steerGroupMessage, reviseGroupMessage, saveGroupConfig, importGroupConfig, readGroupTemplate, actOnGroup, trustGroupTurn, retryGroupTurn, fallbackGroupTurn, resumeGroupLogin } from './group-chat-api';
import { downloadGroupConversation } from './conversation-export';
import { agentQuotaState } from '../../../shared/agent-usage';
import { antigravityMemberQuotaLabel, antigravityModelGroup, antigravityModelQuota, antigravityUnavailableLabel, antigravityUsageNote, antigravityWindowSummary, quotaCreditsLabel, quotaDisplayState, quotaLabel, quotaPercent, quotaUsageNote, quotaWindow, quotaReset } from './usage-quota';
import { groupChatPresentation, recentGroupTurns } from './group-chat-progress';
import { groupChatSummaries } from './group-chat-summary';
import { groupDeliveryOverview } from './group-delivery-presentation';
import { groupChatMessages } from './group-chat-messages';
import { groupChatMessageBlocks, groupMemberReply, groupRoundReply } from './group-chat-replies';
import { groupMemberFeedback } from './group-summary-presentation';
import AgentTaskPromptDrawer from './AgentTaskPromptDrawer.vue';
import { groupTaskMessage } from './message-text';
import { groupRoomSections, readGroupSidebarPreferences, saveGroupSidebarPreferences } from './group-room-sidebar';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const props = defineProps<{ runtimes: AgentRuntimeHealth[]; initialRoomId?: string; quotas?: Partial<Record<AgentProvider, AgentUsageLimits>>; antigravityUsage?: AntigravityUsageLimits; refreshing?: boolean; streamStatus?: 'connecting' | 'connected' | 'reconnecting' }>();
const emit = defineEmits<{ back: []; select: [id: string]; refresh: [] }>();
const client = useQueryClient(), scope = ['agent-group-chat'], selectedId = shallowRef(props.initialRoomId || ''), creating = shallowRef(false), globalChanging = shallowRef('');
const active = shallowRef(true);
// 房间操作只锁定发起它的房间；浏览其他房间不会取消请求或释放来源房间的锁。
const roomActions = shallowRef<Record<string, { kind: string }>>({});
const changing = computed(() => globalChanging.value || roomActions.value[selectedId.value || 'group:new']?.kind || '');
function roomBusy(id: string) { return !!globalChanging.value || !!roomActions.value[id || 'group:new']; }
function beginRoomAction(id: string, kind: string) {
  id ||= 'group:new';
  if (roomBusy(id)) return;
  const operation = { kind };
  roomActions.value = { ...roomActions.value, [id]: operation };
  return () => {
    if (roomActions.value[id] !== operation) return;
    const next = { ...roomActions.value }; delete next[id]; roomActions.value = next;
  };
}
const { busy: restarting } = useWorkspaceRestart();
const dashboard = useQuery({ queryKey: scope, enabled: computed(() => active.value && !restarting.value), queryFn: ({ signal }) => readGroupDashboard(signal), retry: false, refetchInterval: 3000 });
const config = computed(() => dashboard.data.value?.config), rooms = computed(() => dashboard.data.value?.rooms || []);
const batchMode = shallowRef(false), checkedIds = shallowRef(new Set<string>());
const checkedRooms = computed(() => rooms.value.filter(item => checkedIds.value.has(item.id)));
const allChecked = computed(() => !!rooms.value.length && checkedRooms.value.length === rooms.value.length);
watch(rooms, value => { checkedIds.value = new Set([...checkedIds.value].filter(id => value.some(item => item.id === id))); });
function toggleChecked(id: string) {
  const next = new Set(checkedIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  checkedIds.value = next;
}
function cancelBatch() { batchMode.value = false; checkedIds.value = new Set(); }
let initialized = false;
watch(rooms, value => { if (!initialized && dashboard.data.value) { initialized = true; selectedId.value = props.initialRoomId !== undefined ? props.initialRoomId : value[0]?.id || ''; creating.value = !selectedId.value; } }, { immediate: true });
const detail = useQuery({ queryKey: computed(() => [...scope, 'room', selectedId.value]), enabled: computed(() => active.value && !!selectedId.value && !restarting.value),
  queryFn: ({ signal }) => readGroupRoom(selectedId.value, signal), retry: false, refetchInterval: 2000 });
watch(() => props.initialRoomId, id => { if (id !== undefined && id !== selectedId.value) { selectedId.value = id; creating.value = !id; recipients.value = ['all']; } });
const current = computed(() => detail.data.value?.room.id === selectedId.value ? detail.data.value : undefined);
const room = computed(() => current.value?.room), runs = computed(() => current.value?.runs || []);
const roundMessages = computed(() => new Map((room.value?.rounds || []).map(round => [round.id, groupTaskMessage(round)])));
const taskPromptDetail = shallowRef<string>();
const groupInfoOpen = shallowRef(false);
watch(selectedId, () => { taskPromptDetail.value = undefined; });
watch(() => room.value?.id, () => { groupInfoOpen.value = false; });
const localDelivery = useQuery({
  queryKey: computed(() => [...scope, 'local-delivery', selectedId.value]),
  enabled: computed(() => active.value && !restarting.value && room.value?.source?.workflow === 'requirement' && !!room.value.source.issueKey),
  queryFn: ({ queryKey, signal }) => readRemoteDelivery(queryKey[2]!, signal),
  retry: false, staleTime: 10000,
});
const currentLocalDelivery = computed(() => localDelivery.data.value?.roomId === room.value?.id ? localDelivery.data.value : undefined);

type PendingGroupSend = { roomId: string; requestId: string; text: string; attachments: AgentAttachment[]; createdAt: string; accepted: boolean };
const pendingSends = shallowRef<PendingGroupSend[]>([]);
const detailsCollapsed = shallowRef(window.matchMedia('(max-width: 900px)').matches);
const narrowSidebarOpen = shallowRef(false);
const detailsWidth = shallowRef(320);
const sidebarWidth = defineModel<number>('sidebarWidth', { default: 232 });
const detailsOpen = computed(() => !detailsCollapsed.value && (!!room.value || launchWorkspacePaths.value.length > 0));
const detailsPanel = shallowRef<InstanceType<typeof AgentGroupDetailsPanel>>();
const composerInput = shallowRef<InstanceType<typeof AgentPromptEditor>>();
watch(selectedId, () => { narrowSidebarOpen.value = false; if (window.matchMedia('(max-width: 900px)').matches) detailsCollapsed.value = true; });
function returnToChat() { narrowSidebarOpen.value = false; detailsCollapsed.value = true; }
async function inspectRun(run: AgentRun) {
  if (!runs.value.some(item => item.id === run.id)) return;
  detailsCollapsed.value = false;
  await nextTick();
  await detailsPanel.value?.inspect(run);
}
async function composeDetailsPrompt(text: string) {
  draft.value = [draft.value, text].filter(Boolean).join('\n\n');
  if (window.matchMedia('(max-width: 900px)').matches) detailsCollapsed.value = true;
  await nextTick();
  await composerInput.value?.focusInput();
}
const collaborationId = computed(() => current.value?.collaboration?.task.id || '');
const collaborationQuery = useQuery({ queryKey: computed(() => [...scope, 'collaboration', collaborationId.value]),
  enabled: computed(() => active.value && !!collaborationId.value && !restarting.value), queryFn: ({ signal }) => readTeamRoom(collaborationId.value, signal), retry: false, refetchInterval: 2000 });
const collaboration = computed(() => collaborationQuery.data.value?.task.id === collaborationId.value ? collaborationQuery.data.value : undefined);
const collaborationTask = computed(() => collaboration.value?.task);
const collaborationTasks = computed(() => current.value?.collaborations?.map(item => item.task) || (current.value?.collaboration ? [current.value.collaboration.task] : []));
const roundTimings = computed(() => new Map((room.value?.rounds || []).map(round => [round.id,
  groupRoundTiming(round, runs.value, collaborationTasks.value.find(task => task.id === round.automatic?.taskId), room.value?.paused),
])));
const latestTiming = computed(() => roundTimings.value.get(room.value?.rounds.at(-1)?.id || ''));
const collaborationMessages = computed(() => groupChatMessages(collaborationTasks.value, runs.value));
const collaborationBlocks = computed(() => groupChatMessageBlocks(collaborationMessages.value));
function pendingSendSaved(message: PendingGroupSend) {
  if (room.value?.id !== message.roomId) return false;
  if (room.value.rounds.some(round => round.requestId === message.requestId)) return true;
  const processed = room.value.rounds.some(round => round.automatic?.inputs.some(input => input.requestId === message.requestId && input.processed));
  return processed && collaborationMessages.value.some(saved => saved.role === 'user' && saved.text === message.text && saved.createdAt >= message.createdAt);
}
const visiblePendingSends = computed(() => pendingSends.value.filter(message => message.roomId === selectedId.value && !pendingSendSaved(message)));
watch([room, collaborationMessages], () => { pendingSends.value = pendingSends.value.filter(message => !pendingSendSaved(message)); });
// 只操作当前自动轮的准确输入身份；原消息和附件留给后端排队，不重新发送或按内容猜测。
function steerTask() {
  const round = room.value?.rounds.at(-1);
  if (room.value?.source || !round?.automatic || round.state === 'cancelled') return;
  const task = collaborationTasks.value.find(task => task.id === round.automatic?.taskId);
  return task && teamChatActiveStates.has(task.state) ? task : undefined;
}
function steeringMessage(input: GroupSteerInput) {
  const steering = steerTask()?.chat?.steering;
  return steering && (input.messageId ? steering.inputId === input.messageId
    : steering.requestId === `group:${room.value?.id}:${input.requestId}`) ? steering : undefined;
}
function canSteerMessage(messageId: string) {
  return !!steerTask()?.chat?.pendingInputs.some(input => input.id === messageId);
}
function canSteerPendingSend(message: PendingGroupSend) {
  if (!message.accepted || message.roomId !== room.value?.id || message.roomId !== selectedId.value || !steerTask()) return false;
  return !!room.value.rounds.at(-1)?.automatic?.inputs.some(input => input.requestId === message.requestId && !input.processed)
    || !!steerTask()?.chat?.pendingInputs.some(input => input.requestId === `group:${message.roomId}:${message.requestId}`);
}
async function steerMessage(input: GroupSteerInput) {
  const roomId = room.value?.id;
  if (!roomId || roomId !== selectedId.value || steeringMessage(input)) return;
  if (input.messageId ? !canSteerMessage(input.messageId)
    : !pendingSends.value.some(message => message.requestId === input.requestId && canSteerPendingSend(message))) return;
  const finish = beginRoomAction(roomId, `steer:${input.messageId || input.requestId}`);
  if (!finish) return;
  try { setDetail(await steerGroupMessage(roomId, { ...input, accessMode: accessMode.value })); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '消息插队失败'); }
  finally { finish(); }
}
const questionTarget = shallowRef<TeamQuestionTarget>();
const workspaceExpanded = shallowRef(false);
const questionReply = computed(() => questionTarget.value
  ? teamQuestionReply(collaborationTasks.value, questionTarget.value, collaboration.value) : undefined);
function replyToQuestion(taskId: string, questionId: string) {
  questionTarget.value = { taskId, questionId };
}
watch(selectedId, () => { questionTarget.value = undefined; workspaceExpanded.value = false; });
const stepStatusLabels = { running: '已开始', finished: '已结束', failed: '执行失败', recorded: '已记录' };
const executions = computed(() => new Map(runs.value.map(run => {
  const steps = readableToolEvents(groupRunExecutionEvents(run.events).routine);
  const activity = agentRunActivity(run), latest = [...run.events].reverse().find(event => event.type !== 'session');
  const lastStep = steps.at(-1);
  const activityStep = activity && latest && lastStep?.events.some(event => event.id === latest.id) ? lastStep : undefined;
  return [run.id, { ...previewRunExecution(run), steps: steps.slice(-3), activity, activityStep,
    activityAt: latest?.createdAt || run.updatedAt, messages: agentRunPublicMessages(run) }] as const;
})));
function execution(run: AgentRun) { return executions.value.get(run.id)!; }
function activityTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
const draftKey = computed(() => selectedId.value || 'group:new');
const drafts = useAgentConversationDrafts(draftKey);
const { draft, attachments, attachmentDraft } = drafts;
const files = useAgentAttachments(attachments, () => !!changing.value, () => attachmentDraft.value);
const importInput = shallowRef<HTMLInputElement>(), viewport = shallowRef<HTMLElement>();
const recipients = shallowRef<string[]>(['all']), accessMode = shallowRef<AgentAccessMode>('full'), newWorkspace = shallowRef('');
const newWorkspaces = shallowRef<string[]>([]);
const projectsQuery = useSource<ProjectsData>('projects');
const sidebarPreferences = shallowRef(readGroupSidebarPreferences(window.localStorage));
const roomSections = computed(() => groupRoomSections(rooms.value, sidebarPreferences.value.pinnedIds, projectsQuery.data.value));
function saveSidebarPreferences(next: typeof sidebarPreferences.value) {
  sidebarPreferences.value = next;
  if (!saveGroupSidebarPreferences(window.localStorage, next)) ElMessage.warning('群聊列表偏好暂时无法保存，刷新后可能恢复。');
}
function toggleRoomPin() {
  if (!room.value) return;
  const pinnedIds = new Set(sidebarPreferences.value.pinnedIds);
  const unpinning = pinnedIds.delete(room.value.id);
  const collapsedIds = new Set(sidebarPreferences.value.collapsedIds);
  if (!unpinning) pinnedIds.add(room.value.id);
  else {
    const section = groupRoomSections(rooms.value, pinnedIds, projectsQuery.data.value).find(item => item.rooms.some(item => item.id === room.value!.id));
    if (section) collapsedIds.delete(section.id);
  }
  saveSidebarPreferences({ pinnedIds, collapsedIds });
}
function toggleRoomSection(id: string) {
  const collapsedIds = new Set(sidebarPreferences.value.collapsedIds);
  if (collapsedIds.has(id)) collapsedIds.delete(id); else collapsedIds.add(id);
  saveSidebarPreferences({ ...sidebarPreferences.value, collapsedIds });
}
const picker = useWorkspacePicker();
let accessRoom = '';
watch(selectedId, id => { if (!id) { accessRoom = ''; accessMode.value = 'full'; } });
watch(room, value => { if (value && value.id !== accessRoom) { accessRoom = value.id; accessMode.value = value.rounds.at(-1)?.accessMode || 'full'; } }, { immediate: true });
const workspacePath = computed(() => room.value?.workspacePath || (!selectedId.value ? newWorkspace.value : ''));
const workspaceOptions = computed(() => buildWorkspaceCatalog({
  projectsData: projectsQuery.data.value,
  recent: rooms.value.flatMap(item => item.workspacePaths?.length ? item.workspacePaths.map(path => ({ path })) : item.workspacePath ? [{ path: item.workspacePath }] : []),
  selectedPaths: newWorkspaces.value.length ? newWorkspaces.value : (newWorkspace.value ? [newWorkspace.value] : []),
}));
const roomWorkspacePaths = computed(() => room.value?.workspacePaths?.length ? room.value.workspacePaths : (room.value?.workspacePath ? [room.value.workspacePath] : []));
const launchWorkspacePaths = computed(() => selectedId.value ? roomWorkspacePaths.value : (newWorkspaces.value.length ? newWorkspaces.value : newWorkspace.value ? [newWorkspace.value] : []));
function projectDisplayLabel(path: string) {
  return workspaceOptions.value.find(option => option.path === path)?.label || workspacePathLabel(path);
}
const unfinished = computed(() => collaborationTask.value ? teamChatActiveStates.has(collaborationTask.value.state)
  : room.value?.rounds.some(round => !['completed', 'cancelled'].includes(round.state)) || false);
const roundSummaries = computed(() => groupChatSummaries(room.value, runs.value, collaborationTasks.value));
const presentation = computed(() => groupChatPresentation(room.value, runs.value, roundSummaries.value));
const rerunnableRound = computed(() => {
  const latest = room.value?.rounds.at(-1);
  if (!room.value?.workspacePath || room.value.source || !latest?.automatic
    || !['completed', 'failed', 'cancelled'].includes(latest.state)
    || runs.value.some(run => ['queued', 'running'].includes(run.status) || run.status === 'completed' && run.resultReady === false)) return;
  return latest;
});
const rerunHistory = computed(() => new Set(room.value?.rounds.flatMap(round => round.rerunsRoundId ? [round.rerunsRoundId] : []) || []));
const pendingLogin = computed(() => room.value?.rounds.find(round => round.loginHandoff && !round.loginHandoff.answered
  && !['completed', 'cancelled'].includes(round.state)));
const loginUrl = computed(() => pendingLogin.value?.loginHandoff?.url
  || currentLocalDelivery.value?.previewLinks?.find(link => link.mode === 'i18n-test')?.url);
async function resumeLogin() {
  const round = pendingLogin.value, roomId = room.value?.id;
  if (!round?.loginHandoff || !roomId || changing.value) return;
  const finish = beginRoomAction(roomId, 'resume-login');
  if (!finish) return;
  try {
    const updated = await resumeGroupLogin(roomId, { roundId: round.id, runId: round.loginHandoff.runId, accessMode: accessMode.value });
    client.setQueryData([...scope, 'room', roomId], updated);
    refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '无法继续验证');
  } finally { finish(); }
}

const summaryByRound = computed(() => new Map(roundSummaries.value.map(summary => [summary.round.id, summary])));
const summaryByTurn = computed(() => new Map(roundSummaries.value.flatMap(summary => summary.members.map(member => [member.turn.id, member] as const))));
const recentTurns = computed(() => {
  const latestUserAt = [...(room.value?.rounds.map(round => round.createdAt) || []),
    ...collaborationMessages.value.filter(message => message.role === 'user').map(message => message.createdAt)].sort().at(-1) || '';
  const turns = presentation.value.rounds.flatMap(view => view.round.state === 'cancelled' || roundReply(view.round.id) || finalDelivery(view.round.id) ? [] : view.turns)
    .filter(item => summaryByTurn.value.get(item.turn.id)?.current !== false)
    .filter(item => item.state !== 'completed' || !collaborationMessages.value.some(message => message.role === 'assistant'
      && !message.hostGenerated && message.kind !== 'question' && message.nodeId === item.turn.id && message.createdAt >= latestUserAt
      && (!item.run || message.createdAt >= item.run.createdAt)));
  const latest = recentGroupTurns(turns, latestUserAt);
  const latestRound = presentation.value.rounds.at(-1);
  const attention = latestRound?.round.state === 'cancelled' ? [] : (latestRound?.turns || []).filter(item =>
    summaryByTurn.value.get(item.turn.id)?.current !== false && ['failed', 'interrupted'].includes(item.state)
    && !roundReply(latestRound!.round.id));
  return [...new Map([...attention, ...latest].map(item => [item.turn.runId || item.turn.id, item])).values()];
});
type RetryReceipt = { roomId: string; state: 'sending' | 'accepted'; createdAt: string };
const retryReceipts = shallowRef<Record<string, RetryReceipt>>({});
const retryReceipt = computed(() => retryReceipts.value[selectedId.value]);
function setRetryReceipt(roomId: string, value?: RetryReceipt) {
  const next = { ...retryReceipts.value };
  if (value) next[roomId] = value; else delete next[roomId];
  retryReceipts.value = next;
}
watch(recentTurns, value => {
  const receipt = retryReceipt.value;
  if (receipt && value.some(item => item.run && item.run.createdAt >= receipt.createdAt)) setRetryReceipt(receipt.roomId);
});
const feedbackByTurn = computed(() => new Map(roundSummaries.value.flatMap(summary => summary.members.flatMap(member => {
  const feedback = groupMemberFeedback(member);
  return feedback ? [[member.turn.id, feedback] as const] : [];
}))));
function finalDelivery(roundId: string) {
  const taskId = room.value?.rounds.find(round => round.id === roundId)?.automatic?.taskId;
  const task = collaborationTasks.value.find(task => task.id === taskId);
  return task && ['completed', 'awaiting_acceptance', 'accepted'].includes(task.state)
    ? task.chat?.messages.filter(message => message.kind === 'delivery' && message.id.startsWith(`delivery:${task.id}:${task.round}:`)).at(-1) : undefined;
}
function finalDeliveryOverview(roundId: string) {
  const taskId = room.value?.rounds.find(round => round.id === roundId)?.automatic?.taskId;
  return groupDeliveryOverview(collaborationTasks.value.find(task => task.id === taskId));
}
function arrangedTurns(roundId: string) {
  const view = presentation.value.rounds.find(view => view.round.id === roundId);
  if (!view?.round.automatic) return view?.turns || [];
  const task = collaborationTasks.value.find(task => task.id === view.round.automatic?.taskId);
  return view.turns.filter(item => {
    const node = task?.nodes.find(node => node.id === item.turn.id);
    return !!node && node.round === task!.round && node.status !== 'skipped'
      && !['coordinate', 'answer'].includes((node as { purpose?: string }).purpose || '');
  });
}
const status = computed(() => {
  const task = collaborationTask.value;
  if (task?.chat?.paused) return task.chat.coordination?.text || task.reason || '后续执行已暂停';
  if (pendingLogin.value) return '等待你登录测试环境';
  if (presentation.value.active) return presentation.value.status;
  if (task && ['blocked', 'needs_decision', 'needs_reconciliation', 'waiting_input'].includes(task.state)) return task.reason || teamChatActivity(task);
  if (roundSummaries.value.at(-1)?.status === 'blocked') return roundSummaries.value.at(-1)!.headline;
  return presentation.value.awaitingRestart || !task ? presentation.value.status : teamChatActivity(task);
});
const headerProgress = computed(() => {
  const summary = roundSummaries.value.at(-1);
  const progress = summary?.total ? ` · 本轮 ${summary.completed}/${summary.total} 项执行已返回` : '';
  const blocked = presentation.value.active && summary?.status === 'blocked' ? ` · ${summary.headline}` : '';
  return `${status.value}${blocked}${progress}`;
});
const members = computed(() => config.value?.members || []);
function collaborationMemberName(message: ReturnType<typeof groupChatMessages>[number]) {
  const id = message.profileId;
  return id && (message.task.groupMembers?.[id]?.name || members.value.find(member => member.id === id)?.name) || '团队协调';
}
const membersOpen = shallowRef(false);
const targetMembers = computed(() => members.value.filter(member => member.enabled && (recipients.value.includes('all') || recipients.value.includes(member.id))));
const canSend = computed(() => !changing.value && !files.pending.value
  && (questionTarget.value ? !!draft.value.trim() : !!targetMembers.value.length && (!!draft.value.trim() || !!attachments.value.length)));
function updateRecipients(value: string[]) {
  recipients.value = value.includes('all') && !recipients.value.includes('all') ? ['all'] : value.filter(id => id !== 'all');
}
const quotaProviders = computed(() => [...new Set(members.value.filter(member => member.enabled).map(member => memberBinding(member)?.provider).filter((provider): provider is AgentProvider => !!provider))]);
const antigravityGroups = computed(() => [...new Set(members.value.filter(member => member.enabled).map(member => memberBinding(member))
  .filter(binding => binding?.provider === 'antigravity').map(binding => antigravityModelGroup(props.antigravityUsage, binding!.model))
  .filter(group => !!group))]);
function memberUsage(member: GroupMember) {
  const binding = memberBinding(member);
  return binding?.provider === 'antigravity' ? antigravityModelQuota(props.antigravityUsage, binding.model) : binding ? props.quotas?.[binding.provider] : undefined;
}
function memberQuotaLabel(member: GroupMember) {
  const binding = memberBinding(member);
  return binding?.provider === 'antigravity' ? antigravityMemberQuotaLabel(props.antigravityUsage, binding.model) : quotaLabel(memberUsage(member));
}
function quotaWindows(provider: AgentProvider) {
  const usage = props.quotas?.[provider];
  return usage?.available ? [usage.primary, usage.secondary].filter(window => !!window && Number.isFinite(window.remainingPercent)) : [];
}
function quotaTitle(provider: AgentProvider) {
  if (provider === 'antigravity') return [antigravityUsageNote(props.antigravityUsage) || props.antigravityUsage?.message, ...antigravityGroups.value.flatMap(group => [group.name, group.description,
    ...group.buckets.map(bucket => `${bucket.name}：${bucket.disabled ? bucket.description || '停用' : `${props.antigravityUsage?.stale ? '上次剩余' : '剩余'} ${quotaPercent(bucket.remainingPercent)}`}，重置 ${quotaReset(bucket.resetsAt)}`)])].filter(Boolean).join('；') || '服务未提供可读取的额度，未知不代表已用尽';
  const usage = props.quotas?.[provider];
  const credits = quotaCreditsLabel(usage);
  return [usage?.sourceLabel, ...(agentQuotaState(usage).usingCredits ? ['用量来源：额度'] : []), ...(credits ? [credits] : []), ...[usage?.primary, usage?.secondary].filter(Boolean).map(window => `${quotaWindow(window!.windowDurationMins)}，${usage?.stale ? '上次记录的重置时间' : '重置'} ${quotaReset(window!.resetsAt)}`), quotaUsageNote(usage)].filter(Boolean).join('；') || '服务未提供可读取的额度，未知不代表已用尽';
}
// 成员卡片是当前配置入口；历史任务实际使用的模型由各轮执行记录展示。
function memberBinding(member: GroupMember) { return member.binding; }
function backupModel(member: GroupMember) { return member.fallbackBinding?.model; }
function canFallback(turn: GroupTurn) { return !!(room.value?.orchestration === 'automatic' ? turn.member.fallbackBinding : dashboard.data.value?.fallbackChoices?.[turn.member.id]?.length) && ['failed', 'interrupted'].includes(runFor(turn)?.status || turn.status); }
async function fallbackTurn(turn: GroupTurn) {
  const roomId = room.value?.id;
  if (!roomId) return;
  const finish = beginRoomAction(roomId, `fallback:${turn.id}`);
  if (!finish) return;
  try { setDetail(await fallbackGroupTurn(roomId, { turnId: turn.id, runId: turn.runId, accessMode: accessMode.value })); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '备用模型接续失败'); }
  finally { finish(); }
}
const requestIds = new Map<string, string>();
watch(restarting, pending => { if (pending) void client.cancelQueries({ queryKey: scope }); });
// 轮询会为同一次断连生成新的 Error；按文案观察，只在故障发生或变化时提示。
const readError = computed(() => restarting.value ? '' : [dashboard.error.value, detail.error.value, collaborationQuery.error.value].find(Boolean)?.message || '');
const readsRecovered = computed(() => dashboard.isSuccess.value && (!selectedId.value || detail.isSuccess.value)
  && (!collaborationId.value || collaborationQuery.isSuccess.value));
let lastReadError = '';
watch([readError, readsRecovered, restarting], ([message, recovered, pending]) => {
  if (pending) return;
  if (message) {
    if (message !== lastReadError) ElMessage.error(message);
    lastReadError = message;
  } else if (recovered) lastReadError = '';
});
function switchRoom(id: string) {
  narrowSidebarOpen.value = false;
  if (window.matchMedia('(max-width: 900px)').matches) detailsCollapsed.value = true;
  selectedId.value = id; creating.value = !id; recipients.value = ['all']; emit('select', id);
}
function refresh() { void client.invalidateQueries({ queryKey: scope }); }
function setDetail(value: GroupRoomDetail) { client.setQueryData([...scope, 'room', value.room.id], value); refresh(); }
async function editRoomTitle() {
  const target = room.value;
  if (!target || roomBusy(target.id)) return;
  let title: string;
  try {
    const { value } = await ElMessageBox.prompt('请输入新的群聊标题', '修改群聊标题', {
      inputValue: target.title,
      inputValidator: input => !input.trim() ? '请输入群聊标题' : input.trim().length > 300 ? '群聊标题不能超过 300 个字符' : true,
      confirmButtonText: '保存', cancelButtonText: '取消', closeOnClickModal: false,
    });
    title = value.trim();
  } catch { return; }
  if (selectedId.value !== target.id || title === target.title) return;
  const finish = beginRoomAction(target.id, 'rename');
  if (!finish) return;
  try {
    const result = await renameGroupRoom(target.id, title, target.title);
    const roomKey = [...scope, 'room', target.id];
    await Promise.all([client.cancelQueries({ queryKey: roomKey, exact: true }), client.cancelQueries({ queryKey: scope, exact: true })]);
    client.setQueryData<GroupRoomDetail>(roomKey, value => value && ({ ...value, room: { ...value.room, title: result.title } }));
    client.setQueryData<GroupChatDashboard>(scope, value => value && ({ ...value,
      rooms: value.rooms.map(item => item.id === target.id ? { ...item, title: result.title } : item),
    }));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '修改群聊标题失败');
  } finally { finish(); refresh(); }
}
function exportRoom(format: 'markdown' | 'json') {
  if (current.value) downloadGroupConversation(current.value, format);
}
async function removeRooms(targets: { id: string; title: string }[]) {
  if (globalChanging.value || !targets.length || targets.some(target => roomBusy(target.id))) return;
  const selected = [...new Map(targets.map(item => [item.id, item])).values()];
  try {
    await ElMessageBox.confirm(`将停止选中群聊中运行和排队的任务，并删除 ${selected.length} 个群聊的聊天记录。`,
      selected.length === 1 ? '删除群聊' : '批量删除群聊', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false });
  } catch { return; }
  // 确认框等待期间来源房间可能开始了新操作，删除前再检查一次。
  if (globalChanging.value || selected.some(target => roomBusy(target.id))) return;
  globalChanging.value = 'delete';
  const failures: string[] = [];
  let removed = 0;
  try {
    for (const target of selected) {
      try {
        await removeGroupRoom(target.id);
        removed++;
        client.setQueryData<GroupChatDashboard>(scope, value => value && ({ ...value, rooms: value.rooms.filter(item => item.id !== target.id) }));
        if (selectedId.value === target.id) {
          selectedId.value = rooms.value[0]?.id || ''; creating.value = !selectedId.value; emit('select', selectedId.value);
        }
        client.removeQueries({ queryKey: [...scope, 'room', target.id], exact: true });
        const discarded = drafts.clear(target.id);
        if (discarded?.attachments.length) await removePendingAgentAttachments(discarded.attachments);
      } catch (error) { failures.push(`${target.title}：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failures.length) ElMessage.error(`已删除 ${removed} 个群聊，${failures.join('；')}`);
    else { cancelBatch(); ElMessage.success(selected.length === 1 ? '群聊已删除' : `已删除 ${removed} 个群聊`); }
    if (removed) {
      void client.invalidateQueries({ queryKey: ['requirement-development'] });
      void client.invalidateQueries({ queryKey: ['requirement-group-links'] });
    }
    refresh();
  } finally { globalChanging.value = ''; }
}
const editingMessage = shallowRef<{ roomId: string; id: string; attachmentIds: string[]; accessMode?: AgentAccessMode }>();
const editObjective = shallowRef('');
watch(selectedId, () => { editingMessage.value = undefined; });
const editingSource = computed(() => ({ attachments: (editingMessage.value?.attachmentIds || []).map(id => attachmentFor(id)
  || { id, name: '附件', mimeType: 'application/octet-stream', size: 0, url: `/api/agent-runtimes/attachments/${id}` }) }));
async function editMessage(id: string, text: string, attachmentIds: string[]) {
  if (!room.value || changing.value) return;
  const roomId = room.value.id;
  const finish = beginRoomAction(roomId, 'pause-edit');
  if (!finish) return;
  try {
    setDetail(await pauseGroupMessage(roomId, id));
    if (active.value && selectedId.value === roomId) {
      editingMessage.value = { roomId, id, attachmentIds, accessMode: accessMode.value }; editObjective.value = text;
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法编辑消息'); }
  finally { finish(); }
}
async function saveEditedMessage() {
  const source = editingMessage.value;
  if (!source || !editObjective.value.trim() && !source.attachmentIds.length) return;
  const finish = beginRoomAction(source.roomId, 'revise');
  if (!finish) return;
  const text = editObjective.value.trim() || '请分析附加资料。';
  const selectedAccessMode = source.accessMode ?? accessMode.value;
  const fingerprint = JSON.stringify(['revise', source.roomId, source.id, text, selectedAccessMode]);
  const requestId = requestIds.get(fingerprint) || createRequestId(); requestIds.set(fingerprint, requestId);
  try {
    setDetail(await reviseGroupMessage(source.roomId, source.id, { requestId, text, accessMode: selectedAccessMode }));
    requestIds.delete(fingerprint);
    if (editingMessage.value === source) editingMessage.value = undefined;
    if (active.value && selectedId.value === source.roomId) { pinnedToBottom = true; void scrollPinnedResult(); }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '消息修订失败'); }
  finally { finish(); }
}
function attachmentFor(id: string) { return runs.value.flatMap(run => run.attachments || []).find(file => file.id === id); }
function runFor(turn: GroupTurn) { return runs.value.find(run => run.id === turn.runId); }
function turnResult(turn: GroupTurn) { const run = runFor(turn); return run ? run.result : turn.result; }
function roundReply(roundId: string) {
  return groupRoundReply(room.value?.rounds.find(round => round.id === roundId), runs.value);
}
function turnError(turn: GroupTurn) { const run = runFor(turn), view = turnView(turn); return view?.state === 'failed' && view.reason ? view.reason : run ? run.error : turn.error; }
function turnView(turn: GroupTurn) { return presentation.value.rounds.flatMap(round => round.turns).find(item => item.turn.id === turn.id); }
function turnStatus(turn: GroupTurn) { const view = turnView(turn); return view?.state === 'failed' ? view.label : feedbackByTurn.value.get(turn.id)?.statusLabel || summaryByTurn.value.get(turn.id)?.outcome?.label || view?.label || turn.status; }
function modelText(turn: GroupTurn) {
  const run = runFor(turn), binding = run || turn.executionBinding || turn.member.binding;
  return binding ? `${run ? '' : '计划使用 '}${agentProviderLabels[binding.provider]} · ${binding.model || 'CLI 默认'}` : '未设置模型';
}
function progress(turn: GroupTurn) {
  const run = runFor(turn), view = turnView(turn);
  if (run) {
    const latest = previewRunExecution(run);
    if (turnResult(turn)) return ['queued', 'running', 'saving'].includes(view?.state || '')
      ? latest.progress && latest.progress !== latest.summary ? latest.progress : view?.state === 'saving' ? '本轮执行已结束，正在保存结果。' : '' : '';
    return latest.progress || view?.reason || (view?.state === 'saving' ? '本轮执行已结束，正在保存结果。' : view?.state === 'running' ? '正在执行本轮任务，可查看执行记录了解详细进展。' : '');
  }
  return view?.reason || (view?.state === 'queued' ? '正在联系所选执行器。' : '');
}
function memberStatus(member: GroupMember) {
  return member.enabled ? member.binding ? member.binding.model || 'CLI 默认' : '待设置本机模型' : '未参与';
}
function onScroll() { const el = viewport.value; pinnedToBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 100; }
let pinnedToBottom = true;
watch(selectedId, () => { pinnedToBottom = true; });
async function scrollPinnedResult() {
  if (!active.value || !pinnedToBottom) return;
  const roomId = selectedId.value, el = viewport.value;
  await nextTick();
  if (active.value && el && viewport.value === el && selectedId.value === roomId && pinnedToBottom) el.scrollTop = el.scrollHeight;
}
watch(() => current.value, scrollPinnedResult);
async function chooseWorkspace() {
  if (selectedId.value || changing.value) return;
  const selected = await picker.choose(newWorkspace.value);
  if (selected) {
    const currentPaths = newWorkspaces.value.length ? newWorkspaces.value : (newWorkspace.value ? [newWorkspace.value] : []);
    const nextPaths = currentPaths.includes(selected.workspacePath) ? currentPaths : [...currentPaths, selected.workspacePath];
    newWorkspaces.value = nextPaths;
    newWorkspace.value = nextPaths[0] || selected.workspacePath;
  }
  if (picker.error.value) ElMessage.error(picker.error.value);
}
async function send() {
  if (!canSend.value) return;
  if (questionTarget.value) { await sendQuestionReply(); return; }
  const finish = beginRoomAction(selectedId.value, 'send');
  if (!finish) return;
  const key = draftKey.value, sourceRoom = selectedId.value, text = draft.value.trim() || '请分析附加资料。', sent = drafts.clear(key)!, expectedConfigRevision = config.value?.revision;
  const selectedMembers = targetMembers.value, memberIds = recipients.value.includes('all') ? undefined : selectedMembers.map(member => member.id);
  const extraWorkspaces = typeof newWorkspaces !== 'undefined' && newWorkspaces.value.length > 1 ? { workspacePaths: [...newWorkspaces.value] } : {};
  const input = { ...(sourceRoom ? { roomId: sourceRoom } : { workspacePath: newWorkspace.value, ...extraWorkspaces }), text,
    expectedConfigRevision, memberIds, attachmentIds: sent.attachments.map(file => file.id), accessMode: accessMode.value };
  const fingerprint = JSON.stringify([key, input]), requestId = requestIds.get(fingerprint) || createRequestId(); requestIds.set(fingerprint, requestId);
  pendingSends.value = [...pendingSends.value, { roomId: sourceRoom, requestId, text, attachments: [...sent.attachments], createdAt: new Date().toISOString(), accepted: false }];
  pinnedToBottom = true; void scrollPinnedResult();
  try {
    const result = await sendGroupMessage({ ...input, requestId }); setDetail(result); requestIds.delete(fingerprint);
    pendingSends.value = pendingSends.value.map(message => message.requestId === requestId ? { ...message, roomId: result.room.id, accepted: true } : message);
    drafts.move(key, result.room.id);
    if (selectedId.value === sourceRoom) {
      selectedId.value = result.room.id; emit('select', result.room.id); creating.value = false; pinnedToBottom = true;
    }
    pendingSends.value = pendingSends.value.filter(message => !pendingSendSaved(message));
  } catch (error) {
    pendingSends.value = pendingSends.value.filter(message => message.requestId !== requestId);
    drafts.restore(key, sent); ElMessage.error(error instanceof Error ? error.message : '消息发送失败，内容已保留');
  }
  finally { finish(); }
}
async function sendQuestionReply() {
  const target = questionTarget.value;
  if (!target || !draft.value.trim() || changing.value || files.pending.value) return;
  if (questionReply.value?.state !== 'pending') { ElMessage.error('该问题已回答或已过期，请取消回复后继续'); return; }
  const finish = beginRoomAction(selectedId.value, 'send');
  if (!finish) return;
  const key = draftKey.value, sent = drafts.clear(key)!;
  const input = { correlationId: target.questionId, text: sent.text.trim(), attachmentIds: sent.attachments.map(file => file.id), accessMode: accessMode.value };
  const fingerprint = JSON.stringify([target.taskId, input]), requestId = requestIds.get(fingerprint) || createRequestId();
  requestIds.set(fingerprint, requestId);
  try {
    const result = await answerTeamMessage(target.taskId, { ...input, requestId });
    client.setQueryData([...scope, 'collaboration', target.taskId], result);
    requestIds.delete(fingerprint);
    if (questionTarget.value === target) questionTarget.value = undefined;
    refresh();
  } catch (error) { drafts.restore(key, sent); ElMessage.error(error instanceof Error ? error.message : '回复失败，内容已保留'); }
  finally { finish(); }
}
async function trustTurn(turn: GroupTurn) {
  const run = runFor(turn), roomId = selectedId.value; if (!run || !roomId) return;
  const finish = beginRoomAction(roomId, 'trust');
  if (!finish) return;
  try { setDetail(await trustGroupTurn(roomId, { turnId: turn.id, runId: run.id, workspacePath: run.workspacePath, accessMode: accessMode.value })); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '成员重试失败'); } finally { finish(); }
}
function needsTrust(turn: GroupTurn) { const run = runFor(turn); return run?.provider === 'cursor' && ['failed', 'interrupted', 'cancelled'].includes(run.status) && /尚未信任|workspace trust/i.test(run.error); }
function canRetry(turn: GroupTurn) {
  const run = runFor(turn), round = room.value?.rounds.at(-1);
  if (!run || !round || round.state === 'cancelled' || needsTrust(turn) || pendingLogin.value
    || !round.turns.some(item => item.id === turn.id && item.runId === run.id)
    || !['failed', 'interrupted'].includes(run.status) || run.pid !== null
    || run.recovery && ['active', 'pending', 'needs-review'].includes(run.recovery.state)
    || run.status === 'interrupted' && !run.recovery) return false;
  if (!round.automatic?.taskId) return true;
  const task = collaborationTasks.value.find(task => task.id === round.automatic!.taskId), node = task?.nodes.find(node => node.id === turn.id);
  return !!task && !['completed', 'awaiting_acceptance', 'accepted', 'rejected', 'cancelled', 'taken_over'].includes(task.state)
    && node?.runId === run.id && node.round === task.round && ['blocked', 'needs_reconciliation'].includes(node.status);
}
async function retryTurn(turn: GroupTurn) {
  const run = runFor(turn), roomId = room.value?.id;
  if (!roomId || !run || !canRetry(turn)) return;
  const finish = beginRoomAction(roomId, `retry:${turn.id}`);
  if (!finish) return;
  try { setDetail(await retryGroupTurn(roomId, { turnId: turn.id, runId: run.id, accessMode: accessMode.value })); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '成员重试失败'); }
  finally { finish(); }
}
async function action(value: 'pause' | 'continue' | 'cancel') {
  const roomId = selectedId.value;
  if (!roomId) return;
  const finish = beginRoomAction(roomId, value);
  if (!finish) return;
  try { setDetail(await actOnGroup(roomId, value, value === 'continue' ? { accessMode: accessMode.value } : undefined)); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '团队操作失败'); }
  finally { finish(); }
}
async function rerunCollaboration() {
  const round = rerunnableRound.value, roomId = room.value?.id;
  if (!round || !roomId || changing.value) return;
  const selectedAccessMode = accessMode.value;
  const fingerprint = JSON.stringify(['rerun', roomId, round.id, selectedAccessMode]);
  const requestId = requestIds.get(fingerprint) || createRequestId();
  const finish = beginRoomAction(roomId, 'rerun');
  if (!finish) return;
  requestIds.set(fingerprint, requestId);
  pinnedToBottom = true;
  try {
    setDetail(await actOnGroup(roomId, 'rerun', { requestId, roundId: round.id, accessMode: selectedAccessMode }));
    requestIds.delete(fingerprint);
    if (selectedId.value === roomId) {
      await scrollPinnedResult();
      if (selectedId.value === roomId) ElMessage.success('已在当前群聊重新执行');
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '重新执行失败'); }
  finally { finish(); }
}
async function retryCollaboration() {
  if (!collaborationTask.value || changing.value) return;
  const roomId = selectedId.value, taskId = collaborationTask.value.id, createdAt = new Date().toISOString();
  const finish = beginRoomAction(roomId, 'retry');
  if (!finish) return;
  const source = collaboration.value;
  setRetryReceipt(roomId, { roomId, state: 'sending', createdAt });
  pinnedToBottom = true; void scrollPinnedResult();
  try {
    const result = await decideTeamTask(taskId, { action: 'retry', requestId: createRequestId(), accessMode: accessMode.value });
    client.setQueryData([...scope, 'collaboration', taskId], (cached: typeof source) => cached ? { ...cached, task: result } : source ? { ...source, task: result } : undefined);
    setRetryReceipt(roomId, { roomId, state: 'accepted', createdAt }); refresh();
    if (selectedId.value === roomId) ElMessage.success('重试请求已接收，正在核对派发状态');
  }
  catch (error) { setRetryReceipt(roomId); ElMessage.error(error instanceof Error ? error.message : '团队重试失败'); }
  finally { finish(); }
}
const teamOpen = shallowRef(false), roleOpen = shallowRef(false), configDraft = ref<GroupConfig>(), roleDraft = ref<GroupMember>(), roleIsNew = shallowRef(false);
const selectedRuntime = computed(() => props.runtimes.find(runtime => runtime.provider === roleDraft.value?.binding?.provider));
const models = computed(() => selectedRuntime.value?.models || []);
const fallbackRuntime = computed(() => props.runtimes.find(runtime => runtime.provider === roleDraft.value?.fallbackBinding?.provider));
const fallbackModels = computed(() => fallbackRuntime.value?.models || []);
const modelPicker = useAgentModelSelection(() => selectedRuntime.value,
  computed({ get: () => roleDraft.value?.binding?.model || '', set: value => { if (roleDraft.value?.binding) roleDraft.value.binding.model = value; } }),
  computed({ get: () => roleDraft.value?.binding?.reasoningEffort || '', set: value => { if (roleDraft.value?.binding) roleDraft.value.binding.reasoningEffort = value; } }),
  { allowDefaultEffort: true });
const fallbackPicker = useAgentModelSelection(() => fallbackRuntime.value,
  computed({ get: () => roleDraft.value?.fallbackBinding?.model || '', set: value => { if (roleDraft.value?.fallbackBinding) roleDraft.value.fallbackBinding.model = value; } }),
  computed({ get: () => roleDraft.value?.fallbackBinding?.reasoningEffort || '', set: value => { if (roleDraft.value?.fallbackBinding) roleDraft.value.fallbackBinding.reasoningEffort = value; } }),
  { allowDefaultEffort: true });
function clearEffortAlias(fallback = false) {
  const binding = fallback ? roleDraft.value?.fallbackBinding : roleDraft.value?.binding;
  const picker = fallback ? fallbackPicker : modelPicker;
  if (binding && picker.models.value.find(choice => choice.id === picker.model.value)?.embedded) delete binding.catalogAlias;
}
function setFallbackProvider(provider: AgentProvider | '') {
  if (!roleDraft.value) return;
  const runtime = props.runtimes.find(runtime => runtime.provider === provider);
  roleDraft.value.fallbackBinding = runtime ? { provider: runtime.provider, model: runtime.defaultModel,
    reasoningEffort: runtime.models.find(model => model.id === runtime.defaultModel)?.defaultEffort || '' } : null;
}
function fallbackModelChanged() {
  const binding = roleDraft.value?.fallbackBinding;
  if (!binding) return;
  delete binding.catalogAlias;
  binding.reasoningEffort = fallbackModels.value.find(model => model.id === binding.model)?.defaultEffort || '';
}
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
const teamNameInput = shallowRef<{ focus(): void }>();
const editingTeamName = shallowRef(false);
function openTeam() { if (!config.value) return; editingTeamName.value = false; configDraft.value = clone(config.value); teamOpen.value = true; }
function editTeamName() { openTeam(); editingTeamName.value = true; }
function focusTeamName() { if (editingTeamName.value) teamNameInput.value?.focus(); }
function openRole(member?: GroupMember) {
  if (!config.value) return; configDraft.value = clone(config.value); roleIsNew.value = !member;
  const runtime = props.runtimes.find(runtime => runtime.ready) || props.runtimes[0];
  roleDraft.value = member ? clone(member) : { id: createRequestId(), name: '', instructions: '', capability: 'read', enabled: true,
    ...(runtime ? { binding: { provider: runtime.provider, model: runtime.defaultModel, reasoningEffort: runtime.models.find(model => model.id === runtime.defaultModel)?.defaultEffort || '' } } : {}) };
  roleOpen.value = true;
}
function providerChanged() {
  if (!roleDraft.value?.binding || !selectedRuntime.value) return;
  roleDraft.value.binding.model = selectedRuntime.value.defaultModel; delete roleDraft.value.binding.catalogAlias; modelChanged();
}
function modelChanged() {
  const binding = roleDraft.value?.binding; if (!binding) return;
  delete binding.catalogAlias;
  const option = models.value.find(model => model.id === binding.model); binding.reasoningEffort = option?.defaultEffort || '';
}
function ensureBinding() { if (roleDraft.value && !roleDraft.value.binding) { const runtime = props.runtimes.find(runtime => runtime.ready) || props.runtimes[0]; if (runtime) roleDraft.value.binding = { provider: runtime.provider, model: runtime.defaultModel, reasoningEffort: '' }; } }
async function persistConfig(value: GroupConfig) {
  globalChanging.value = 'config';
  try { const saved = await saveGroupConfig(value); client.setQueryData(scope, { ...dashboard.data.value, config: saved }); refresh(); return true; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '团队配置保存失败'); return false; }
  finally { globalChanging.value = ''; }
}
async function saveRole() {
  if (!roleDraft.value || !configDraft.value || !roleDraft.value.name.trim() || !roleDraft.value.instructions.trim()) return;
  const value = clone(configDraft.value), role = clone(roleDraft.value), index = value.members.findIndex(member => member.id === role.id);
  if (index < 0) value.members.push(role); else value.members[index] = role;
  if (await persistConfig(value)) roleOpen.value = false;
}
async function removeRole() { if (!configDraft.value || !roleDraft.value) return; const value = clone(configDraft.value); value.members = value.members.filter(member => member.id !== roleDraft.value!.id); if (await persistConfig(value)) roleOpen.value = false; }
function moveRole(index: number, delta: number) { if (!configDraft.value) return; const list = configDraft.value.members; [list[index], list[index + delta]] = [list[index + delta], list[index]]; }
async function saveTeam() { if (!configDraft.value?.name.trim()) { ElMessage.error('请填写团队名称'); return; } if (await persistConfig(configDraft.value)) teamOpen.value = false; }
async function exportTeam() {
  try { const template = await readGroupTemplate(), url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${template.name.replace(/[^\p{L}\p{N}_-]/gu, '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '团队导出失败'); }
}
async function importTeam(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file || !config.value) return; globalChanging.value = 'import';
  try { const saved = await importGroupConfig(JSON.parse(await file.text()), config.value.revision); client.setQueryData(scope, { ...dashboard.data.value, config: saved }); refresh(); ElMessage.success('团队角色已导入，请为新增成员配置本机模型'); }
  catch (error) { ElMessage.error(error instanceof SyntaxError ? '文件不是有效的团队 JSON' : error instanceof Error ? error.message : '团队导入失败'); }
  finally { input.value = ''; globalChanging.value = ''; }
}
onActivated(() => { active.value = true; void scrollPinnedResult(); });
onDeactivated(() => {
  active.value = false;
  taskPromptDetail.value = undefined; editingMessage.value = undefined;
  membersOpen.value = false; teamOpen.value = false; roleOpen.value = false;
  if (picker.browserOpen.value) picker.completeBrowser(null);
});
onBeforeUnmount(() => { active.value = false; const pending = drafts.pendingAttachments(); drafts.dispose(); if (!globalChanging.value && pending.length) void removePendingAgentAttachments(pending); });
</script>

<template>
  <section class="group-workspace" :class="{ 'details-open': detailsOpen, 'narrow-sidebar-open': narrowSidebarOpen }" :style="{ '--group-details-width': `min(${detailsWidth}px, 28vw)` }" aria-label="团队群聊">
    <nav class="group-narrow-toolbar" aria-label="群聊面板切换">
      <button type="button" :aria-expanded="narrowSidebarOpen" aria-controls="group-room-sidebar" :aria-label="narrowSidebarOpen ? '收起群聊列表' : '展开群聊列表'" @click="narrowSidebarOpen = !narrowSidebarOpen"><Users :size="16" />{{ narrowSidebarOpen ? '收起列表' : '群聊列表' }}</button>
      <button v-if="narrowSidebarOpen || detailsOpen" type="button" aria-label="返回群聊聊天" @click="returnToChat"><ChevronLeft :size="16" />返回聊天</button>
    </nav>
    <aside id="group-room-sidebar" class="group-sidebar" aria-label="群聊列表">
      <AgentSidebarHeader mode="group" @select="emit('back')" @create="switchRoom('')" />
      <slot name="navigation" />
      <div v-if="batchMode" class="group-batch-toolbar">
        <label><input type="checkbox" aria-label="全选群聊" :checked="allChecked" :indeterminate="!!checkedRooms.length && !allChecked" :disabled="!!changing || !rooms.length" @change="checkedIds = allChecked ? new Set() : new Set(rooms.map(item => item.id))" />全选</label>
        <span>已选 {{ checkedRooms.length }}</span>
        <button type="button" :disabled="!!globalChanging || !checkedRooms.length || checkedRooms.some(item => roomBusy(item.id))" @click="removeRooms(checkedRooms)">删除</button>
        <button type="button" :disabled="!!changing" @click="cancelBatch">取消</button>
      </div>
      <div class="group-sidebar-heading"><strong>置顶与项目分组</strong><span>{{ rooms.length }}</span></div>
      <div class="group-rooms">
        <section v-for="section in roomSections" :key="section.id" class="group-room-section" :aria-label="section.label">
          <div v-if="section.pinned" class="group-room-section-heading group-pinned-heading"><Pin :size="12" /><strong>置顶</strong><span>{{ section.rooms.length }}</span></div>
          <button v-else type="button" class="group-room-section-heading" :title="section.path" :aria-expanded="batchMode || !sidebarPreferences.collapsedIds.has(section.id)" :disabled="batchMode" @click="toggleRoomSection(section.id)"><ChevronDown :size="12" :class="{ collapsed: !batchMode && sidebarPreferences.collapsedIds.has(section.id) }" /><Folder :size="13" /><strong>{{ section.label }}</strong><span>{{ section.rooms.length }}</span></button>
          <div v-show="section.pinned || batchMode || !sidebarPreferences.collapsedIds.has(section.id)">
            <div v-for="item in section.rooms" :key="item.id" class="group-room-row" :class="{ selected: selectedId === item.id }">
              <input v-if="batchMode" type="checkbox" :aria-label="`选择群聊 ${item.title}`" :checked="checkedIds.has(item.id)" :disabled="!!changing" @change="toggleChecked(item.id)" />
              <button type="button" class="group-room" :title="item.title" :aria-pressed="batchMode ? checkedIds.has(item.id) : selectedId === item.id" :disabled="batchMode && !!changing" @click="batchMode ? toggleChecked(item.id) : switchRoom(item.id)"><strong>{{ item.title }}</strong><small>{{ item.id === room?.id ? status : item.waitingForLogin ? '等待你登录测试环境' : item.state === 'failed' ? '被阻塞' : item.paused ? '已暂停' : item.activeMember ? `${item.activeMember}正在处理` : item.state === 'completed' ? '本轮完成' : item.state === 'cancelled' ? '已取消' : '待执行' }}</small></button>
              <button v-if="!batchMode" type="button" class="group-room-delete" :aria-label="`删除群聊 ${item.title}`" title="删除群聊" :disabled="roomBusy(item.id)" @click="removeRooms([item])"><Trash2 :size="14" /></button>
            </div>
          </div>
        </section>
      </div>
      <button type="button" class="group-batch-toggle" :disabled="!!changing || !rooms.length || batchMode" @click="batchMode = true"><Trash2 :size="15" />批量删除群聊</button>
      <div class="group-roster-entry"><button type="button" :aria-expanded="membersOpen" aria-haspopup="dialog" @click="membersOpen = true"><Users :size="18" /><strong>团队成员 · {{ members.length }}</strong><ChevronRight :size="15" /></button></div>
      <div class="group-share"><el-button size="small" :disabled="!!changing" @click="importInput?.click()"><Upload :size="13" />导入团队</el-button><el-button size="small" @click="exportTeam"><Download :size="13" />分享团队</el-button></div>
    </aside>
    <AgentPanelResize v-model="sidebarWidth" class="group-sidebar-resize" side="left" variant="project-studio" />
    <main class="group-main" :class="{ 'jira-group': !!room?.source, 'is-new-room': !selectedId && !visiblePendingSends.length }">
      <div class="group-masthead">
      <header class="group-header">
        <div class="group-title">
          <h1 :aria-label="config?.name || '团队群聊'"><button class="group-name-edit" type="button" :disabled="!!changing || !config" aria-label="修改团队名称" title="修改团队名称" @click="editTeamName">{{ config?.name || '团队群聊' }}<Pencil :size="13" /></button></h1>
          <p v-if="room" class="group-room-title" :title="room.title">{{ room.title }}</p>
        </div>
        <div class="group-header-actions">
          <span id="group-connection-status"></span>
          <el-button v-if="room || launchWorkspacePaths.length" size="small" :aria-expanded="detailsOpen" :aria-label="detailsOpen ? '收起会话详情' : '展开会话详情'" title="会话详情" @click="detailsCollapsed = !detailsCollapsed"><PanelRight :size="14" /><span class="group-header-action-label">会话详情</span></el-button>
          <el-button size="small" :disabled="!!changing" aria-label="团队设置" title="团队设置" @click="openTeam"><Settings2 :size="14" /><span class="group-header-action-label">团队设置</span></el-button>
          <el-dropdown v-if="room" trigger="click" popper-class="studio-conversation-menu">
            <button type="button" class="group-room-menu" aria-label="更多群聊操作" title="更多群聊操作"><Ellipsis :size="18" /></button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item :disabled="!!changing" @click="editRoomTitle"><Pencil :size="14" />修改标题</el-dropdown-item>
                <el-dropdown-item @click="toggleRoomPin"><Pin :size="14" />{{ sidebarPreferences.pinnedIds.has(room.id) ? '取消置顶' : '置顶群聊' }}</el-dropdown-item>
                <el-dropdown-item @click="groupInfoOpen = true"><Info :size="14" />群聊信息</el-dropdown-item>
                <el-dropdown-item divided @click="exportRoom('markdown')"><Download :size="14" />导出 Markdown</el-dropdown-item>
                <el-dropdown-item @click="exportRoom('json')"><Download :size="14" />导出 JSON</el-dropdown-item>
                <el-dropdown-item divided :disabled="!!changing" class="studio-delete-conversation" @click="removeRooms([room])"><Trash2 :size="14" />删除群聊</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <p class="group-header-progress"><span :title="`${headerProgress} · ${members.filter(member => member.enabled).length} 名可用成员`">{{ headerProgress }} · {{ members.filter(member => member.enabled).length }} 名可用成员</span><AgentElapsedTime class="group-header-elapsed" :timing="latestTiming" /></p>
      </header>
      <div v-if="quotaProviders.length" class="group-quotas" aria-label="本群模型额度">
        <div class="group-quota-list" tabindex="0" aria-label="模型额度，可横向滚动">
        <div v-for="provider in quotaProviders" :key="provider" class="group-quota" :title="quotaTitle(provider)">
          <strong>{{ agentProviderLabels[provider] }}</strong>
          <template v-if="provider === 'antigravity'">
            <span v-for="group in antigravityGroups" :key="group.name" class="group-quota-windows"><span class="quota-model-group">{{ group.name }}</span><template v-for="bucket in group.buckets" :key="bucket.id"><span v-if="!bucket.disabled" class="quota-value" :class="{ exhausted: !antigravityUsage?.stale && bucket.remainingPercent <= 0 }" :title="`${antigravityUsage?.stale ? '上次记录的重置时间' : '下次重置'}：${quotaReset(bucket.resetsAt)}`">{{ antigravityWindowSummary(bucket) }} <b>{{ antigravityUsage?.stale ? '上次剩余' : '剩余' }} {{ quotaPercent(bucket.remainingPercent) }}</b></span></template><span v-if="group.buckets.every(bucket => bucket.disabled)">额度未知</span></span>
            <span v-if="!antigravityGroups.length">{{ antigravityUnavailableLabel(antigravityUsage) }}</span>
          </template>
          <span v-else-if="quotaWindows(provider).length" class="group-quota-windows"><span v-for="(window, index) in quotaWindows(provider)" :key="index" class="quota-value" :class="{ exhausted: quotaDisplayState(quotas?.[provider]) === 'exhausted' && window!.remainingPercent <= 0 }" :title="`${quotas?.[provider]?.stale ? '上次记录的重置时间' : '重置'} ${quotaReset(window!.resetsAt)}`">{{ quotaWindow(window!.windowDurationMins) }} <b>{{ quotas?.[provider]?.stale ? '上次剩余' : '剩余' }} {{ quotaPercent(window!.remainingPercent) }}</b></span><span v-if="quotaCreditsLabel(quotas?.[provider])" class="quota-value quota-credits"><template v-if="agentQuotaState(quotas?.[provider]).usingCredits">用量来源：额度 · </template><b>{{ quotaCreditsLabel(quotas?.[provider]) }}</b></span></span>
          <span v-else>{{ quotaLabel(quotas?.[provider]) }}</span>
        </div>
        </div>
        <button type="button" :disabled="refreshing" :aria-busy="!!refreshing" @click="emit('refresh')">{{ refreshing ? '刷新中…' : '刷新额度' }}</button>
      </div>
      <div class="group-context">
        <div v-if="room?.source" class="group-task-context" aria-label="关联 Jira 研发任务">
          <strong>{{ room.source.workflow === 'jira' ? 'Jira 修复' : '需求开发' }}</strong><a v-if="room.source.issueUrl" :href="room.source.issueUrl" target="_blank" rel="noopener">{{ room.source.issueKey }}</a>
          <span v-for="project in room.source.projects" :key="project.workspacePath" :title="project.workspacePath">{{ project.path.split('/').filter(Boolean).at(-1) }} · {{ project.branchName }}</span>
          <a :href="`/agent?view=${room.source.workflow === 'jira' ? 'jira-fix' : 'design'}`">返回任务与交接</a>
        </div>
        <button v-if="room?.source" type="button" class="group-directory" :aria-expanded="workspaceExpanded" aria-controls="group-directory-path" :title="workspacePath" @click="workspaceExpanded = !workspaceExpanded"><FolderOpen :size="14" />工作目录</button>
        <AgentCursorButton v-if="room?.source && workspacePath && !workspaceExpanded" :workspace-path="workspacePath" size="small" />
        <div v-if="room?.source" v-show="workspaceExpanded" id="group-directory-path" class="group-directory-path">
          <div v-for="path in roomWorkspacePaths" :key="path" class="group-project-entry">
            <FolderOpen :size="14" />
            <span class="group-project-pill" :title="path"><strong>{{ projectDisplayLabel(path) }}</strong></span>
            <span class="group-project-raw" :title="path">{{ path }}</span>
            <AgentCursorButton :workspace-path="path" size="small" />
          </div>
        </div>
        <div v-else-if="!selectedId" class="group-project group-project-selector-bar">
          <AgentWorkspaceSelector
            v-model:workspace-path="newWorkspace"
            v-model:workspace-paths="newWorkspaces"
            :workspaces="workspaceOptions"
            placement="bottom-start"
            empty-label="选择项目工作区（支持多选）"
            :disabled="!!changing"
            @choose-workspace="chooseWorkspace"
          />
          <span class="group-project-hint">{{ newWorkspaces.length ? `已关联 ${newWorkspaces.length} 个项目工作区` : '未选择项目时使用独立会话目录' }}</span>
          <AgentCursorButton v-if="workspacePath" :workspace-path="workspacePath" size="small" />
        </div>
        <div v-else class="group-project group-project-list">
          <template v-if="roomWorkspacePaths.length">
            <div v-for="(path, idx) in roomWorkspacePaths" :key="path" class="group-project-entry">
              <FolderOpen :size="14" />
              <span class="group-project-pill" :class="{ 'is-primary': idx === 0 }" :title="path">
                <strong>{{ projectDisplayLabel(path) }}</strong>
                <small v-if="roomWorkspacePaths.length > 1 && idx === 0">主目录</small>
              </span>
              <span class="group-project-raw" :title="path">{{ path }}</span>
              <AgentCursorButton :workspace-path="path" size="small" />
            </div>
          </template>
          <span v-else>未选择项目，使用独立会话目录</span>
        </div>
      </div>
      </div>
      <div class="group-reading">
      <div ref="viewport" class="group-messages" aria-live="polite" @scroll.passive="onScroll">
        <el-skeleton v-if="dashboard.isPending.value || selectedId && detail.isPending.value" :rows="4" animated />
        <div v-else-if="!room && !visiblePendingSends.length" class="group-empty"><Users :size="34" /><h2>给团队一个目标</h2><p>团队会自动规划、分工、验证和处理返工，也可以选择成员提问。</p></div>
        <template v-for="view in presentation.rounds" :key="view.round.id">
        <component :is="rerunHistory.has(view.round.id) ? 'details' : 'div'" :class="{ 'group-rerun-history': rerunHistory.has(view.round.id) }" :data-history-round="rerunHistory.has(view.round.id) ? view.round.id : undefined" @toggle="onScroll">
          <summary v-if="rerunHistory.has(view.round.id)">重新执行前的记录 · {{ dateTime(view.round.createdAt) }}</summary>
          <article class="group-message user"><AgentAvatar user :size="30" /><div><header><strong>你</strong><time>{{ dateTime(view.round.createdAt) }}</time></header><p class="user-text">{{ roundMessages.get(view.round.id)?.text }}</p><div v-if="view.round.attachmentIds.length" class="message-attachments"><a v-for="id in view.round.attachmentIds" :key="id" :href="`/api/agent-runtimes/attachments/${encodeURIComponent(id)}`" target="_blank" rel="noopener"><img v-if="attachmentFor(id) && isAgentImageAttachment(attachmentFor(id)!)" :src="attachmentFor(id)!.url" :alt="attachmentFor(id)!.name" />{{ attachmentFor(id)?.name || '查看附件' }}</a></div><div class="group-user-tools"><button v-if="roundMessages.get(view.round.id)?.prompt" type="button" class="group-message-edit" @click="taskPromptDetail = roundMessages.get(view.round.id)?.prompt">查看完整提示词</button><button type="button" class="group-message-edit" :disabled="!!changing" @click="editMessage(view.round.id, view.round.text, view.round.attachmentIds)"><Pencil :size="12" />{{ ['queued', 'running'].includes(view.round.state) ? '暂停并编辑' : '编辑消息' }}</button><small v-if="view.round.revisesMessageId">修订后的消息</small></div></div></article>
          <p v-if="view.round.automatic?.error" class="turn-error" role="status">{{ view.round.automatic.error }}</p>
          <section v-if="!roundReply(view.round.id) && arrangedTurns(view.round.id).length" class="group-coordination" :data-round-id="view.round.id" aria-label="本轮执行安排">
            <header><strong>{{ view.round.automatic ? '协调安排' : '执行安排' }}</strong><span v-if="summaryByRound.get(view.round.id)?.coordinator">负责人：{{ summaryByRound.get(view.round.id)?.coordinator?.turn.member.name }}</span><small v-if="!view.round.automatic">按已保存分工整理</small></header>
            <details @toggle="onScroll"><summary><ChevronDown :size="14" aria-hidden="true" /><span>本轮分工</span><span class="group-record-count">{{ arrangedTurns(view.round.id).length }} 项</span></summary><ol><li v-for="item in arrangedTurns(view.round.id)" :key="item.turn.id"><strong>{{ item.turn.member.name }}</strong><p>{{ item.turn.member.instructions }}</p></li></ol></details>
          </section>
          <article v-if="roundReply(view.round.id)" class="group-message group-direct-reply" :data-reply-round="view.round.id">
            <AgentAvatar :provider="(view.turns[0]?.run || view.turns[0]?.turn.executionBinding || view.turns[0]?.turn.member.binding)?.provider" :model="(view.turns[0]?.run || view.turns[0]?.turn.executionBinding || view.turns[0]?.turn.member.binding)?.model" :size="30" />
            <div><header><strong>{{ view.turns[0]?.turn.member.name }}</strong><time>{{ dateTime(view.turns[0]?.run?.updatedAt || view.round.updatedAt) }}</time><span class="turn-status">{{ view.turns[0]?.label }}</span><AgentElapsedTime :timing="roundTimings.get(view.round.id)" /></header>
              <AgentMarkdown :source="roundReply(view.round.id)" />
              <template v-if="view.turns[0]?.run && ['queued', 'running', 'saving'].includes(view.turns[0].state)">
                <p v-if="execution(view.turns[0].run).activityStep" class="latest-action"><span>{{ execution(view.turns[0].run).activityStep!.status === 'running' ? '正在进行' : '最近动作' }}：{{ execution(view.turns[0].run).activityStep!.title }}</span><small v-if="execution(view.turns[0].run).activityStep!.target">{{ execution(view.turns[0].run).activityStep!.target }}</small></p>
                <p v-else-if="execution(view.turns[0].run).activity || progress(view.turns[0].turn)" class="turn-progress">{{ execution(view.turns[0].run).activity || progress(view.turns[0].turn) }}</p>
              </template>
              <p v-if="view.turns[0] && turnError(view.turns[0].turn)" class="turn-error">{{ turnError(view.turns[0].turn) }}</p>
              <details v-if="view.turns[0]?.run?.changedFiles?.length" class="member-files" @toggle="onScroll"><summary>成员文件 · {{ view.turns[0].run.changedFiles.length }}</summary><AgentChangedFiles :files="view.turns[0].run.changedFiles" :run-id="view.turns[0].run.id" /></details>
              <div class="latest-feedback-tools">
                <el-button v-if="view.turns[0] && canRetry(view.turns[0].turn)" link type="primary" :loading="changing === 'retry:' + view.turns[0].turn.id" :disabled="!!changing" @click="retryTurn(view.turns[0].turn)">{{ changing === 'retry:' + view.turns[0].turn.id ? '正在重试' : '重试此成员' }}</el-button>
                <el-button v-if="view.turns[0] && canFallback(view.turns[0].turn)" link type="primary" :disabled="!!changing" @click="fallbackTurn(view.turns[0].turn)">用备用模型继续</el-button>
                <el-button v-if="view.turns[0] && needsTrust(view.turns[0].turn)" link type="primary" :disabled="!!changing" @click="trustTurn(view.turns[0].turn)">重试此成员</el-button>
                <button v-if="view.turns[0]?.run" type="button" class="group-log" @click="inspectRun(view.turns[0].run)">查看执行记录</button>
              </div>
            </div>
          </article>
          <details v-if="!roundReply(view.round.id) && view.started.length" class="group-member-steps" @toggle="onScroll">
            <summary class="group-section-heading">
              <ChevronDown :size="14" aria-hidden="true" />
              <span>成员执行记录</span>
              <span class="group-record-count">{{ view.started.length }} 条</span>
            </summary>
            <template v-for="item in view.started" :key="item.turn.id">
              <div v-if="item === view.focus" class="group-step-heading">{{ view.summary }}</div>
              <article class="member-feedback" :class="{ current: item === view.focus }" :aria-current="item === view.focus ? 'step' : undefined" :data-member-id="item.turn.member.id" :data-turn-status="item.run?.status || item.turn.status">
                <details class="member-feedback-content" @toggle="onScroll">
                  <summary class="member-feedback-header">
                    <AgentAvatar :provider="(item.run || item.turn.executionBinding || item.turn.member.binding)?.provider" :model="(item.run || item.turn.executionBinding || item.turn.member.binding)?.model" :size="30" />
                    <span class="member-feedback-identity"><strong>{{ item.turn.member.name }}</strong><time>{{ dateTime(item.run?.updatedAt || item.turn.updatedAt) }}</time><small v-if="summaryByTurn.get(item.turn.id)?.current === false">历史记录</small><span class="turn-status" :class="{ 'member-needs-attention': item.state === 'failed' || ['failed', 'blocked'].includes(summaryByTurn.get(item.turn.id)?.outcome?.state || '') }">{{ turnStatus(item.turn) }}</span></span>
                    <span class="member-feedback-toggle"><span class="feedback-open-label">收起</span><span class="feedback-closed-label">展开</span><ChevronDown :size="14" aria-hidden="true" /></span>
                  </summary>
                <div class="member-feedback-body">
                  <AgentMarkdown v-if="groupMemberReply(summaryByTurn.get(item.turn.id))" class="member-local-summary" data-member-summary :source="groupMemberReply(summaryByTurn.get(item.turn.id))" />
                  <div v-else-if="feedbackByTurn.has(item.turn.id)" class="member-readable-feedback" data-member-summary>
                    <p><strong>{{ feedbackByTurn.get(item.turn.id)!.title }}</strong></p>
                    <p v-for="check in feedbackByTurn.get(item.turn.id)!.checks" :key="check.title"><strong>{{ check.title }}：</strong>{{ check.detail }}</p>
                    <p><strong>下一步：</strong>{{ feedbackByTurn.get(item.turn.id)!.nextStep }}</p>
                  </div>
                  <p v-else-if="turnResult(item.turn)" class="turn-progress">已保存本岗位汇报</p>
                  <details v-if="!roundReply(view.round.id) && (turnResult(item.turn) || item.run && execution(item.run).messages.length)" class="member-original" @toggle="onScroll"><summary>查看成员原始汇报</summary>
                    <AgentMarkdown v-for="message in item.run ? execution(item.run).messages : []" :key="message.id" :source="agentReplyText(message.message)" />
                    <AgentMarkdown v-if="turnResult(item.turn)" :source="agentReplyText(turnResult(item.turn))" />
                  </details>
                  <p v-if="progress(item.turn) && (!item.run || !execution(item.run).activity)" class="turn-progress"><span v-if="item.run?.result || item.turn.result">最新进展：</span>{{ progress(item.turn) }}</p>
                  <div v-if="item.run && (['queued', 'running', 'saving'].includes(item.state) || execution(item.run).toolCount)" class="turn-activity" aria-label="成员运行动态">
                    <p v-if="execution(item.run).activity && ['queued', 'running', 'saving'].includes(item.state)" class="current-action"><span>{{ execution(item.run).activityStep?.status === 'running' ? '正在进行' : '最近动作' }}<time :datetime="execution(item.run).activityAt">{{ activityTime(execution(item.run).activityAt) }}</time></span><span v-if="execution(item.run).activityStep"><strong>{{ execution(item.run).activityStep!.title }}</strong><em class="step-state" :class="execution(item.run).activityStep!.status">{{ execution(item.run).activityStep!.status === 'running' ? '进行中' : stepStatusLabels[execution(item.run).activityStep!.status] }}</em><small v-if="execution(item.run).activityStep!.target">{{ execution(item.run).activityStep!.target }}</small></span><span v-else>{{ execution(item.run).activity }}</span></p>
                    <details v-if="execution(item.run).toolCount" class="turn-tools" @toggle="onScroll">
                      <summary>{{ ['queued', 'running', 'saving'].includes(item.state) ? '执行进度' : '技术详情' }} <span>{{ execution(item.run).toolCount }} 条执行记录</span><span>最近更新 {{ activityTime(execution(item.run).steps.at(-1)!.createdAt) }}</span></summary>
                      <ol><li v-for="step in execution(item.run).steps" :key="step.id"><time :datetime="step.createdAt">{{ activityTime(step.createdAt) }}</time><div class="turn-step"><p class="step-heading"><strong>{{ step.title }}</strong><span class="step-state" :class="step.status">{{ stepStatusLabels[step.status] }}</span></p><p v-if="step.target" class="step-target">{{ step.target }}</p><details class="step-original" @toggle="onScroll"><summary>原始记录 · {{ step.events.length }} 条</summary><div v-for="event in step.events" :key="event.id"><small>{{ activityTime(event.createdAt) }}</small><code>{{ event.message }}</code></div></details></div></li></ol>
                    </details>
                    <p v-else class="no-tool-records">尚未收到工具执行记录</p>
                  </div>
                  <div v-for="(fallback, index) in item.turn.fallbacks || []" :key="index" class="turn-fallback"><strong>已启用备用模型 {{ fallback.to.model }}</strong><p>{{ agentProviderLabels[fallback.from.provider] }} → {{ agentProviderLabels[fallback.to.provider] }} · {{ fallback.reason }}</p><button v-if="fallback.runId && runs.find(run => run.id === fallback.runId)" type="button" @click="inspectRun(runs.find(run => run.id === fallback.runId)!)">查看原失败记录</button></div>
                  <p v-if="turnError(item.turn)" class="turn-error">{{ turnError(item.turn) }}</p>
                  <details v-if="item.run?.changedFiles?.length" class="member-files" @toggle="onScroll"><summary>成员文件 · {{ item.run.changedFiles.length }}</summary><AgentChangedFiles :files="item.run.changedFiles" :run-id="item.turn.runId" /></details>
                  <el-button v-if="canRetry(item.turn)" link type="primary" :loading="changing === 'retry:' + item.turn.id" :disabled="!!changing" @click="retryTurn(item.turn)">{{ changing === 'retry:' + item.turn.id ? '正在重试' : '重试此成员' }}</el-button>
                  <el-button v-if="canFallback(item.turn)" link type="primary" :disabled="!!changing" @click="fallbackTurn(item.turn)">用备用模型继续</el-button>
                  <el-button v-if="needsTrust(item.turn)" link type="primary" :disabled="!!changing" @click="trustTurn(item.turn)">重试此成员</el-button>
                  <div class="turn-details"><button v-if="item.run" class="group-log" type="button" @click="inspectRun(item.run!)">查看执行记录</button><details class="turn-model" @toggle="onScroll"><summary>模型详情</summary><p>{{ modelText(item.turn) }}</p></details></div>
                </div>
                </details>
              </article>
            </template>
          </details>
          <details v-if="view.pending.length" class="group-upcoming" :data-round-id="view.round.id" @toggle="onScroll">
            <summary><span>{{ view.round.state === 'cancelled' ? '未执行' : view.started.length ? '后续' : '待执行' }} {{ view.pending.length }} 步<template v-if="view.round.state !== 'cancelled'"> · {{ view.started.length ? '下一位' : '首位' }}：{{ view.pending[0]!.turn.member.name }}</template></span><small v-if="['被阻塞', '已暂停', '已取消'].includes(view.pending[0]!.label)">{{ view.pending[0]!.label }}</small></summary>
            <ol>
              <li v-for="item in view.pending" :key="item.turn.id" :data-member-id="item.turn.member.id" :data-turn-status="item.state">
                <details class="upcoming-step" @toggle="onScroll"><summary><span>{{ item.step }}. {{ item.turn.member.name }}</span><small>{{ item.label }}</small></summary><div><p>{{ modelText(item.turn) }}</p><p v-if="item.reason">{{ item.reason }}</p></div></details>
              </li>
            </ol>
          </details>
        <template v-for="block in collaborationBlocks.filter(item => item.message.task.id === view.round.automatic?.taskId)" :key="block.history[0]?.id || block.message.id">
          <details v-if="block.history.length" class="group-feedback-history" @toggle="onScroll">
            <summary>查看{{ collaborationMemberName(block.message) }}此前 {{ block.history.length }} 条反馈</summary>
            <article v-for="message in block.history" :key="message.id" class="group-message" :data-team-message-id="message.id">
              <AgentAvatar :provider="message.identity?.provider" :model="message.identity?.model" :size="30" />
              <div><header><strong>{{ collaborationMemberName(message) }}</strong><time>{{ dateTime(message.createdAt) }}</time></header><AgentMarkdown :source="message.text" /></div>
            </article>
          </details>
        <article v-for="message in [block.message]" :key="message.id" class="group-message" :class="{ user: message.role === 'user' }" :data-team-message-id="message.id">
          <AgentAvatar :user="message.role === 'user'" :provider="message.identity?.provider" :model="message.identity?.model" :size="30" />
          <div><header><strong>{{ message.role === 'user' ? '你' : message.hostGenerated ? '工作台回执' : collaborationMemberName(message) }}</strong><time>{{ dateTime(message.createdAt) }}</time></header>
            <AgentMarkdown :source="message.text" />
            <div v-if="message.role === 'user'" class="group-user-tools">
              <button type="button" class="group-message-edit" :disabled="!!changing" @click="editMessage(message.id, message.text, message.attachmentIds || [])"><Pencil :size="12" />编辑消息</button>
              <button v-if="canSteerMessage(message.id)" type="button" class="group-message-edit" title="停止当前阶段，并提前处理此消息" :disabled="!!changing || !!steeringMessage({ messageId: message.id })" @click="steerMessage({ messageId: message.id })"><CornerUpLeft :size="12" />{{ changing === `steer:${message.id}` || steeringMessage({ messageId: message.id })?.phase === 'stopping' ? '插队中' : steeringMessage({ messageId: message.id }) ? '已插队' : '插队' }}</button>
            </div>
            <AgentTeamQuestion v-if="message.kind === 'question'" :state="teamQuestionState(message.task, message, collaboration) || 'expired'" :changing="changing" :selected="questionTarget?.questionId === message.id" @reply="replyToQuestion(message.task.id, message.id)" />
          </div>
        </article>
        </template>
        <article v-if="pendingLogin?.id === view.round.id" class="group-message" aria-label="等待登录测试环境">
          <Users :size="30" />
          <div>
            <header><strong>需要你登录测试环境</strong></header>
            <p>{{ view.round.loginHandoff?.reason === 'session_expired' ? '测试环境的登录已过期。' : '当前页面要求登录。' }}请在浏览器完成登录，再回到这里继续验证。</p>
            <p>账号、密码和验证码只在登录页面填写。</p>
            <a v-if="loginUrl" :href="loginUrl" target="_blank" rel="noopener noreferrer">打开测试页面</a>
            <el-button size="small" :loading="changing === 'resume-login'" :disabled="!!changing" @click="resumeLogin">已登录，继续验证</el-button>
          </div>
        </article>
        <article v-if="!roundReply(view.round.id) && summaryByRound.get(view.round.id)?.ready" class="group-message group-team-summary" :data-team-summary="view.round.id" @toggle.capture="onScroll">
          <Users :size="30" />
          <div><header><strong>{{ finalDelivery(view.round.id) ? '总协调汇报' : summaryByRound.get(view.round.id)?.source?.workflow === 'requirement' ? '需求交付汇总' : '团队汇总' }}</strong><small>{{ finalDelivery(view.round.id) ? '依据团队已登记的交付证据' : '根据本轮已保存记录整理' }}</small><AgentElapsedTime :timing="roundTimings.get(view.round.id)" /></header>
            <AgentMarkdown v-if="finalDelivery(view.round.id)" :source="finalDeliveryOverview(view.round.id)" />
            <details v-if="finalDelivery(view.round.id)" class="group-summary-evidence"><summary>查看技术记录（命令、代码和日志）</summary><AgentMarkdown :source="finalDelivery(view.round.id)!.text" /><AgentGroupSummary :summary="summaryByRound.get(view.round.id)!" :delivery-text="finalDelivery(view.round.id)!.text" :local-delivery="view.round.id === room?.rounds.at(-1)?.id ? currentLocalDelivery : undefined" @inspect="inspectRun" /></details>
            <AgentGroupSummary v-else-if="summaryByRound.get(view.round.id)" :summary="summaryByRound.get(view.round.id)!" :delivery-text="finalDelivery(view.round.id)?.text" :local-delivery="view.round.id === room?.rounds.at(-1)?.id ? currentLocalDelivery : undefined" @inspect="inspectRun" />
          </div>
        </article>
        </component>
        </template>
        <article v-for="message in visiblePendingSends" :key="message.requestId" class="group-message user" :data-pending-send="message.requestId">
          <AgentAvatar user :size="30" /><div><header><strong>你</strong><time>{{ dateTime(message.createdAt) }}</time><span class="turn-status">{{ message.accepted ? '已接收，等待团队处理' : '发送中' }}</span></header><p class="user-text">{{ message.text }}</p>
            <div v-if="message.attachments.length" class="message-attachments"><a v-for="file in message.attachments" :key="file.id" :href="`/api/agent-runtimes/attachments/${encodeURIComponent(file.id)}`" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(file)" :src="file.url" :alt="file.name" />{{ file.name }}</a></div>
            <button v-if="canSteerPendingSend(message)" type="button" class="group-message-edit" title="停止当前阶段，并提前处理此消息" :disabled="!!changing || !!steeringMessage({ requestId: message.requestId })" @click="steerMessage({ requestId: message.requestId })"><CornerUpLeft :size="12" />{{ changing === `steer:${message.requestId}` || steeringMessage({ requestId: message.requestId })?.phase === 'stopping' ? '插队中' : steeringMessage({ requestId: message.requestId }) ? '已插队' : '插队' }}</button>
          </div>
        </article>
        <article v-if="retryReceipt?.roomId === selectedId" class="group-message group-latest-feedback" aria-label="重试请求状态" role="status">
          <Users :size="30" /><div><header><strong>团队执行</strong></header><p>{{ retryReceipt.state === 'sending' ? '正在提交重试请求…' : ['blocked', 'needs_decision', 'needs_reconciliation'].includes(collaborationTask?.state || '') ? '重试已接收，当前仍有阻塞，请核对任务状态。' : '重试已接收，等待最新执行状态。' }}</p></div>
        </article>
        <article v-for="item in recentTurns" :key="item.turn.runId || item.turn.id" class="group-message group-latest-feedback" :data-latest-run-id="item.turn.runId" aria-label="最新执行反馈">
          <AgentAvatar :provider="(item.run || item.turn.executionBinding || item.turn.member.binding)?.provider" :model="(item.run || item.turn.executionBinding || item.turn.member.binding)?.model" :size="30" />
          <div><header><strong>{{ item.turn.member.name }}</strong><span class="turn-status" :class="{ 'member-needs-attention': item.state === 'failed' || ['failed', 'blocked'].includes(summaryByTurn.get(item.turn.id)?.outcome?.state || '') }">{{ turnStatus(item.turn) }}</span><small v-if="item.turn.attempt > 1">第 {{ item.turn.attempt }} 次尝试</small></header>
            <template v-if="item.run && ['queued', 'running', 'saving'].includes(item.state)">
              <AgentMarkdown v-if="execution(item.run).progress" :source="execution(item.run).progress" />
              <p v-if="execution(item.run).activityStep" class="latest-action"><span>{{ execution(item.run).activityStep!.status === 'running' ? '正在进行' : '最近动作' }}：{{ execution(item.run).activityStep!.title }}</span><small v-if="execution(item.run).activityStep!.target" :title="execution(item.run).activityStep!.target">{{ execution(item.run).activityStep!.target }}</small></p>
              <p v-else class="turn-progress">{{ execution(item.run).activity || progress(item.turn) || '等待执行器返回进度。' }}</p>
            </template>
            <AgentMarkdown v-else-if="groupMemberReply(summaryByTurn.get(item.turn.id))" :source="groupMemberReply(summaryByTurn.get(item.turn.id))" />
            <div v-else-if="feedbackByTurn.has(item.turn.id)" class="member-readable-feedback" data-member-summary>
              <p><strong>{{ feedbackByTurn.get(item.turn.id)!.title }}</strong></p>
              <p v-for="check in feedbackByTurn.get(item.turn.id)!.checks" :key="check.title"><strong>{{ check.title }}：</strong>{{ check.detail }}</p>
              <p><strong>下一步：</strong>{{ feedbackByTurn.get(item.turn.id)!.nextStep }}</p>
              <details class="member-original"><summary>查看原始验证记录</summary><AgentMarkdown :source="agentReplyText(turnResult(item.turn))" /></details>
            </div>
            <p v-if="turnError(item.turn)" class="turn-error">{{ turnError(item.turn) }}</p>
            <div class="latest-feedback-tools">
              <el-button v-if="canRetry(item.turn)" link type="primary" :loading="changing === 'retry:' + item.turn.id" :disabled="!!changing" @click="retryTurn(item.turn)">{{ changing === 'retry:' + item.turn.id ? '正在重试' : '重试此成员' }}</el-button>
              <el-button v-if="canFallback(item.turn)" link type="primary" :disabled="!!changing" @click="fallbackTurn(item.turn)">用备用模型继续</el-button>
              <el-button v-if="needsTrust(item.turn)" link type="primary" :disabled="!!changing" @click="trustTurn(item.turn)">重试此成员</el-button>
              <time :datetime="item.run?.updatedAt || item.turn.updatedAt">最近更新 {{ activityTime(item.run?.updatedAt || item.turn.updatedAt) }}</time><button v-if="item.run" type="button" class="group-log" @click="inspectRun(item.run)">查看执行过程</button></div>
          </div>
        </article>
      </div>
      <section class="group-compose-area" aria-label="群聊消息与任务控制">
      <div class="group-control" v-if="room && (unfinished || rerunnableRound)">
        <span>{{ collaborationTask ? status : presentation.hint }}</span>
        <el-button v-if="collaborationTask && ['blocked', 'needs_decision', 'needs_reconciliation'].includes(collaborationTask.state) && !presentation.active" size="small" :loading="changing === 'retry'" :disabled="!!changing" @click="retryCollaboration">{{ changing === 'retry' ? '正在重试' : '重试当前步骤' }}</el-button>
        <el-button v-else-if="unfinished && room.paused && !pendingLogin" size="small" :disabled="!!changing || presentation.waitingForRun" @click="action('continue')">{{ presentation.waitingForRun ? '等待当前运行结束' : '继续执行' }}</el-button>
        <el-button v-else-if="unfinished && !pendingLogin" size="small" :disabled="!!changing" @click="action('pause')"><Square :size="12" />暂停</el-button>
        <el-button v-if="rerunnableRound" size="small" :loading="changing === 'rerun'" :disabled="!!changing" @click="rerunCollaboration">重新执行</el-button>
        <el-button v-if="unfinished" link size="small" :disabled="!!changing" @click="action('cancel')">取消待办</el-button>
      </div>
      <form class="group-composer" @submit.prevent="send">
        <div class="group-composer-targets">
          <el-select :model-value="recipients" multiple collapse-tags collapse-tags-tooltip size="small" aria-label="接收成员" :disabled="!!changing" @update:model-value="updateRecipients">
            <el-option value="all" label="发给全体成员" />
            <el-option v-for="member in members.filter(member => member.enabled)" :key="member.id" :value="member.id" :label="`发给 ${member.name}`" />
          </el-select>
          <el-select v-model="accessMode" size="small" aria-label="群聊访问权限" :disabled="!!changing">
            <el-option value="workspace" label="工作区访问" /><el-option value="full" label="完全访问" />
          </el-select>
        </div>
        <div v-if="questionTarget" class="group-reply"><span>{{ questionReply?.state === 'pending' ? '回复：' : '问题已回答或已过期：' }}{{ questionReply?.text }}</span><el-button link size="small" :disabled="!!changing" @click="questionTarget = undefined">取消回复</el-button></div>
        <AgentPromptEditor ref="composerInput" v-model="draft" v-model:attachments="attachments" class="group-composer-prompt"
          :workspace-path="workspacePath" :attachment-draft="attachmentDraft" :disabled="!!changing"
          input-label="发送给团队的消息" placeholder="给团队安排工作，或选择成员提问…" submit-on-enter @submit="send" />
        <div class="group-composer-footer">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <el-button native-type="submit" type="primary" :loading="changing === 'send'" :disabled="!canSend"><Send :size="14" />发送</el-button>
        </div>
      </form>
      </section>
      </div>
    </main>
    <AgentPanelResize v-if="detailsOpen" v-model="detailsWidth" class="group-details-resize" side="right" variant="project-studio" />
    <AgentGroupDetailsPanel v-show="detailsOpen" ref="detailsPanel" :visible="active && detailsOpen" :room="room" :runs="runs" :tasks="collaborationTasks" :task="collaborationTask || current?.collaboration?.task"
      :status="status" :runtimes="runtimes" :stream-status="streamStatus || 'connecting'" @collapse="detailsCollapsed = true" @compose="composeDetailsPrompt">
      <template v-if="launchWorkspacePaths.length" #project-launch><AgentProjectLaunch class="project-launch-sidebar" :workspace-paths="launchWorkspacePaths" /></template>
    </AgentGroupDetailsPanel>
    <input ref="importInput" type="file" accept=".json,application/json" hidden @change="importTeam" />
  </section>
  <AgentTaskPromptDrawer v-model="taskPromptDetail" />
  <el-dialog v-model="groupInfoOpen" title="群聊信息" width="min(560px, 94vw)" append-to-body>
    <dl v-if="room" class="group-room-info">
      <dt>群聊标题</dt><dd>{{ room.title }}</dd>
      <dt>群聊 ID</dt><dd>{{ room.id }}</dd>
      <dt>工作区</dt><dd><div v-for="path in roomWorkspacePaths" :key="path">{{ path }}</div><template v-if="!roomWorkspacePaths.length">未绑定工作区</template></dd>
      <dt>当前状态</dt><dd>{{ headerProgress }}</dd>
      <dt>轮次</dt><dd>{{ room.rounds.length }} 轮</dd>
      <dt>创建时间</dt><dd>{{ dateTime(room.createdAt) }}</dd>
      <dt>最近更新</dt><dd>{{ dateTime(room.updatedAt) }}</dd>
    </dl>
  </el-dialog>
  <el-drawer v-model="membersOpen" :title="`团队成员 · ${members.length}`" size="min(640px, 94vw)" append-to-body @open="dashboard.refetch()">
    <div class="group-roster-panel">
      <div class="roster-member-grid">
        <button v-for="member in members" :key="member.id" type="button" class="roster-member" :class="{ inactive: !member.enabled }" :aria-label="`编辑成员 ${member.name}`" :disabled="!!changing" @click="openRole(member)">
          <span class="roster-member-heading">
            <AgentAvatar :provider="memberBinding(member)?.provider" :model="memberBinding(member)?.model" :size="32" />
            <strong>{{ member.name }}</strong>
            <small v-if="memberBinding(member)" class="roster-member-quota" :class="quotaDisplayState(memberUsage(member))" :title="quotaTitle(memberBinding(member)!.provider)">{{ memberQuotaLabel(member) }}</small>
          </span>
          <span class="roster-member-models">
            <small class="roster-member-model">{{ memberBinding(member)?.model || memberStatus(member) }}</small>
            <small v-if="backupModel(member)" class="roster-member-backup">备用 {{ backupModel(member) }}</small>
          </span>
        </button>
      </div>
    </div>
    <template #footer><div class="roster-drawer-footer"><el-button type="primary" aria-label="添加成员角色" :disabled="!!changing" @click="openRole()"><Plus :size="14" />添加成员</el-button><el-button @click="membersOpen = false">关闭</el-button></div></template>
  </el-drawer>
  <AgentEditMessageDialog :open="!!editingMessage" v-model="editObjective" :source="editingSource" :submitting="changing === 'revise'" @submit="saveEditedMessage" @close="editingMessage = undefined" />
  <el-dialog v-model="teamOpen"  title="团队设置" width="min(600px, 94vw)" append-to-body @opened="focusTeamName">
    <el-form v-if="configDraft" label-position="top" @submit.prevent="saveTeam"><el-form-item label="团队名称" required><el-input ref="teamNameInput" v-model="configDraft.name" maxlength="100" show-word-limit aria-label="团队名称" /></el-form-item><div class="group-config-members"><div v-for="(member, index) in configDraft.members" :key="member.id"><el-checkbox v-model="member.enabled">{{ member.name }}</el-checkbox><span>{{ groupCapabilityLabels[member.capability] }}</span><el-button link :disabled="index === 0" :aria-label="`上移${member.name}`" @click="moveRole(index, -1)"><ChevronUp :size="14" /></el-button><el-button link :disabled="index === configDraft.members.length - 1" :aria-label="`下移${member.name}`" @click="moveRole(index, 1)"><ChevronDown :size="14" /></el-button></div></div><p class="group-setting-hint">按列表顺序接续处理。在团队成员中可修改职责和模型；已开始的消息保留当时的配置。</p></el-form>
    <template #footer><el-button @click="teamOpen = false">取消</el-button><el-button type="primary" :loading="changing === 'config'" @click="saveTeam">保存</el-button></template>
  </el-dialog>
  <el-dialog v-model="roleOpen" :title="roleIsNew ? '添加成员角色' : '编辑成员角色'" width="min(980px, 94vw)" top="24px" class="group-role-dialog" append-to-body>
    <el-form v-if="roleDraft" label-position="top" class="group-role-form" @submit.prevent="saveRole">
      <div class="group-role-fields">
        <div class="group-role-identity">
          <el-form-item label="角色名称"><el-input v-model="roleDraft.name" placeholder="自行填写，例如：接口联调专员" /></el-form-item>
          <el-form-item label="岗位分工"><el-select v-model="roleDraft.capability"><el-option v-for="(label, value) in groupCapabilityLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        </div>
        <el-form-item label="主要职责"><el-input v-model="roleDraft.instructions" type="textarea" :rows="9" resize="vertical" /></el-form-item>
        <el-form-item label="允许做什么"><el-input v-model="roleDraft.allowedActions" type="textarea" :rows="7" resize="vertical" :maxlength="12000" placeholder="自行定义，例如：核对接口字段、分析问题、提出修改建议" /></el-form-item>
      </div>
      <details class="group-personal-model group-role-models" open @toggle="ensureBinding">
        <summary>我的执行器与模型</summary>
        <p class="group-setting-hint">只保存在当前工作台，分享团队文件不携带个人模型绑定。</p>
        <div v-if="roleDraft.binding" class="group-role-model-fields">
          <el-form-item label="执行器"><el-select v-model="roleDraft.binding.provider" @change="providerChanged"><el-option v-for="runtime in runtimes" :key="runtime.provider" :value="runtime.provider" :label="`${runtime.label}${runtime.ready ? '' : '（未就绪）'}`" /></el-select></el-form-item>
          <el-form-item label="模型"><el-select v-model="modelPicker.model.value" filterable allow-create default-first-option :empty-values="[null, undefined]" @change="modelChanged"><el-option v-for="model in modelPicker.models.value" :key="model.id" :value="model.id" :label="model.label" /></el-select></el-form-item>
          <el-form-item v-if="modelPicker.efforts.value.length" label="推理强度"><el-select v-model="modelPicker.effort.value" :empty-values="[null, undefined]" @change="clearEffortAlias()"><el-option v-if="modelPicker.allowDefaultEffort.value" value="" label="模型默认" /><el-option v-for="effort in modelPicker.efforts.value" :key="effort" :value="effort" :label="effortLabels[effort]" /></el-select></el-form-item>
        </div>
        <div class="group-role-model-fields group-role-fallback">
          <el-form-item label="备用执行器"><el-select :model-value="roleDraft.fallbackBinding?.provider || ''" aria-label="备用执行器" @change="setFallbackProvider"><el-option value="" :label="roleDraft.fallbackBinding === undefined ? '未配置备用模型' : '不使用备用模型'" /><el-option v-for="runtime in runtimes" :key="runtime.provider" :value="runtime.provider" :label="runtime.label" /></el-select></el-form-item>
          <template v-if="roleDraft.fallbackBinding">
            <el-form-item label="备用模型"><el-select v-model="fallbackPicker.model.value" filterable :empty-values="[null, undefined]" aria-label="备用模型" @change="fallbackModelChanged"><el-option v-for="model in fallbackPicker.models.value" :key="model.id" :value="model.id" :label="model.label" /></el-select></el-form-item>
            <el-form-item v-if="fallbackPicker.efforts.value.length" label="备用推理强度"><el-select v-model="fallbackPicker.effort.value" :empty-values="[null, undefined]" @change="clearEffortAlias(true)"><el-option v-if="fallbackPicker.allowDefaultEffort.value" value="" label="模型默认" /><el-option v-for="effort in fallbackPicker.efforts.value" :key="effort" :value="effort" :label="effortLabels[effort]" /></el-select></el-form-item>
          </template>
        </div>
      </details>
    </el-form>
    <template #footer><div class="group-role-footer"><el-button v-if="!roleIsNew" link type="danger" :disabled="!!changing" @click="removeRole">移除此角色</el-button><div class="group-role-actions"><el-button @click="roleOpen = false">取消</el-button><el-button type="primary" :loading="changing === 'config'" :disabled="!roleDraft?.name.trim() || !roleDraft?.instructions.trim()" @click="saveRole">保存</el-button></div></div></template>
  </el-dialog>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
</template>

<style scoped>
.group-rerun-history{margin:0 0 24px}.group-rerun-history>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-rerun-history[open]>summary{margin-bottom:18px}
.group-header-elapsed{margin-left:12px}
.group-roster-entry{flex-shrink:0;padding:8px 12px;border-top:1px solid var(--agent-border)}.group-roster-entry>button{display:flex;align-items:center;gap:9px;width:100%;min-height:42px;padding:8px;border:0;border-radius:8px;background:transparent;color:var(--agent-text);font:12px var(--sans);cursor:pointer}.group-roster-entry>button:hover{background:var(--agent-raised)}.group-roster-entry strong{flex:1;min-width:0;font-weight:550;text-align:left;overflow-wrap:anywhere}.group-roster-entry>button>svg{flex-shrink:0;color:var(--agent-muted)}.group-roster-entry>button:focus-visible{outline:2px solid var(--agent-accent);outline-offset:1px}
.group-roster-panel{color:var(--ui-text);font-family:var(--sans)}.roster-member-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.roster-member{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:108px;padding:14px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-surface);color:var(--ui-text);font:inherit;text-align:left;cursor:pointer}.roster-member:hover{border-color:var(--ui-accent);background:var(--ui-hover)}.roster-member:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.roster-member.inactive{opacity:.5}.roster-member:disabled{cursor:not-allowed;opacity:.5}.roster-member-heading{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;min-width:0}.roster-member-heading>strong{min-width:0;font-size:13px;font-weight:600;line-height:1.6;overflow-wrap:anywhere}.roster-member-quota{font-size:11px;line-height:1.6;color:var(--ui-secondary);white-space:nowrap}.roster-member-quota.exhausted{color:var(--ui-danger)}.roster-member-models{display:grid;gap:4px;min-width:0;padding-left:42px;overflow-wrap:anywhere}.roster-member-model{font-size:12px;line-height:1.65;color:var(--ui-secondary)}.roster-member-backup{font-size:11px;line-height:1.65;color:var(--ui-muted)}.roster-drawer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.roster-drawer-footer :deep(.el-button){margin-left:0}.roster-drawer-footer :deep(.el-button>span){gap:6px}
@media(max-width:700px){.roster-member-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:480px){.group-roster-entry{padding:8px 6px}.group-roster-entry>button{gap:6px;padding:6px;font-size:11px}.roster-drawer-footer :deep(.el-button){min-height:44px}}
.group-feedback-history,.group-summary-evidence{margin:0 0 20px;min-width:0}.group-feedback-history>summary,.group-summary-evidence>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-feedback-history[open]>summary,.group-summary-evidence[open]>summary{margin-bottom:14px}
.group-message:not(.user){display:block;position:relative;padding:0;border:0;background:transparent}
.group-message:not(.user)>:deep(.agent-avatar),.group-message:not(.user)>svg{position:absolute;top:0;left:0}
.group-message:not(.user)>div{width:100%;max-width:100%}
.group-message:not(.user)>div>header{min-height:30px;margin:0 0 16px;padding-left:42px;gap:8px 10px}
.group-message:not(.user)>div>header time{order:1;margin-left:auto;font-size:11px}
.group-message:not(.user) :deep(.agent-markdown){font-size:15px;line-height:1.8}
.group-message:not(.user):not(.group-team-summary) :deep(.markdown-paragraph){margin-bottom:14px}
.group-message:not(.user):not(.group-team-summary) :deep(.markdown-paragraph:last-child){margin-bottom:0}

@media(max-width:480px){.group-message:not(.user)>div>header{padding-left:0}.group-message:not(.user)>svg{display:none}}
</style>

<style scoped>
.group-coordination{margin:8px 0 20px 42px;padding:12px 0;border-bottom:1px solid var(--agent-border);color:var(--agent-secondary);font-size:12px;overflow-wrap:anywhere}.group-coordination header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}.group-coordination header strong{color:var(--agent-text);font-size:13px}.group-coordination header small{color:var(--agent-muted);font-size:11px}.group-coordination details{margin-top:8px}.group-coordination summary,.member-original>summary,.member-files>summary,.team-summary-blockers>summary{cursor:pointer;color:var(--agent-accent);font-size:12px}.group-coordination ol{margin:10px 0 0;padding-left:20px}.group-coordination li{padding:5px 0}.group-coordination li p{margin:4px 0;line-height:1.7}
.group-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;padding:8px 0;color:var(--agent-muted);font-size:12px;font-weight:500;list-style:none}.group-member-steps{margin:0 0 16px;min-width:0}.group-member-steps>summary{cursor:pointer;color:var(--agent-accent);user-select:none}.group-member-steps[open]>summary{margin-bottom:12px;color:var(--agent-muted)}.group-member-steps>summary::-webkit-details-marker,.member-feedback-header::-webkit-details-marker{display:none}.group-member-steps>summary::marker,.member-feedback-header::marker{content:''}.group-member-steps>summary>svg{flex-shrink:0;transform:rotate(-90deg)}.group-member-steps[open]>summary>svg{transform:rotate(0)}
.member-feedback{min-width:0;max-width:100%;margin:0 0 14px;border:1px solid var(--agent-border);border-radius:12px;background:color-mix(in srgb,var(--agent-panel-strong) 70%,transparent)}.member-feedback-content{min-width:0;max-width:100%}.member-feedback-header{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0;padding:14px 16px;border-radius:11px;list-style:none;cursor:pointer;user-select:none}.member-feedback-header:hover{background:var(--agent-raised)}.member-feedback-header:focus-visible,.group-member-steps>summary:focus-visible{outline:2px solid var(--agent-accent);outline-offset:-3px}.member-feedback-content[open]>.member-feedback-header{border-radius:11px 11px 0 0}.member-feedback-identity{display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px;min-width:0;overflow-wrap:anywhere}.member-feedback-identity>strong{color:var(--agent-text);font-size:13px;font-weight:600;line-height:1.6}.member-feedback-identity>time,.member-feedback-identity>small{color:var(--agent-muted);font-size:11px}.member-feedback-toggle{display:flex;align-items:center;gap:5px;color:var(--agent-muted);font-size:11px;white-space:nowrap}.member-feedback-toggle>svg{flex-shrink:0;transform:rotate(-90deg)}.feedback-open-label{display:none}.member-feedback-content[open]>.member-feedback-header .feedback-open-label{display:inline}.member-feedback-content[open]>.member-feedback-header .feedback-closed-label{display:none}.member-feedback-content[open]>.member-feedback-header .member-feedback-toggle>svg{transform:rotate(0)}
.member-feedback-body{min-width:0;padding:0 16px 16px 58px;overflow-wrap:anywhere;color:var(--agent-text);font-size:15px;line-height:1.8}.member-feedback-body :deep(.agent-markdown){font-size:15px;line-height:1.8}.member-feedback-body :deep(.agent-markdown>:first-child){margin-top:0}.member-feedback-body :deep(.agent-markdown>:last-child){margin-bottom:0}.member-feedback-body>.turn-activity{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--agent-border)}.member-feedback-body>.turn-details{margin-top:12px;padding-top:10px;border-top:1px solid var(--agent-border)}
@media(max-width:600px){.member-feedback-header{grid-template-columns:26px minmax(0,1fr) auto;gap:8px;padding:12px}.member-feedback-header :deep(.agent-avatar){width:26px!important;height:26px!important}.member-feedback-identity{gap:3px 6px}.member-feedback-body{padding:0 12px 14px}.member-feedback{margin-bottom:12px}}
.member-local-summary{margin:8px 0;white-space:pre-line;overflow-wrap:anywhere;font-size:15px;line-height:1.8}.member-original,.member-files{margin:10px 0}.member-original[open]>summary,.member-files[open]>summary{margin-bottom:12px}.turn-status.member-needs-attention{color:var(--ui-danger)}
.member-readable-feedback{margin:8px 0;font-size:15px;line-height:1.8;overflow-wrap:anywhere}.member-readable-feedback p{margin:6px 0}.member-readable-feedback strong{font-weight:600}
.group-team-summary>svg{color:var(--agent-accent)}.group-team-summary header{flex-wrap:wrap}.group-team-summary header small,.team-summary-source{color:var(--agent-muted);font-size:11px}.team-summary-headline{color:var(--agent-text);font-size:13px;font-weight:600}.team-summary-blockers ul{padding:0;list-style:none}.team-summary-blockers li{padding:10px 0;border-top:1px solid var(--agent-border);font-size:12px;overflow-wrap:anywhere}.team-summary-blockers li p{margin:5px 0;white-space:pre-wrap;line-height:1.7}.team-summary-blockers button{padding:0;border:0;background:transparent;color:var(--agent-accent);font:inherit;cursor:pointer}
.team-summary-blockers li summary{display:flex;align-items:baseline;gap:10px;cursor:pointer}.team-summary-blockers li summary strong{flex-shrink:0}.team-summary-blockers li summary span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--agent-muted)}
@media(max-width:700px){.group-coordination,.group-section-heading{margin-left:0}}
.group-reply{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--agent-muted);font-size:12px}.group-reply>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-message :deep(.report-row summary){min-width:0}@media(max-width:480px){.group-message :deep(.report-row summary){grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.group-message :deep(.report-row summary small){grid-column:1/-1;text-align:left}}
.turn-activity{margin:10px 0;color:var(--agent-secondary);font-size:12px;line-height:1.7;min-width:0}.current-action{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}.current-action>span:first-child{flex-shrink:0;color:var(--agent-muted)}.current-action time{display:block;font:11px/1.7 var(--mono);color:var(--agent-muted)}.current-action>span:last-child{min-width:0;max-height:5.1em;overflow:auto}.turn-tools summary{cursor:pointer;color:var(--agent-secondary);line-height:1.8}.turn-tools summary>span{margin-left:12px;color:var(--agent-muted);font-size:11px}.turn-tools ol{list-style:none;margin:8px 0;padding:0}.turn-tools li{display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px;margin:7px 0}.turn-tools li time{color:var(--agent-muted);font:11px/1.7 var(--mono);white-space:nowrap}.turn-tools code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;max-height:10em;overflow:auto;font:12px/1.7 var(--mono);color:var(--agent-text)}.turn-tools small{display:block;color:var(--agent-muted);font-size:11px}.no-tool-records{margin:0;color:var(--agent-muted)}.turn-tools summary:focus-visible{outline:2px solid var(--agent-accent);outline-offset:3px;border-radius:3px}@media(max-width:480px){.turn-tools summary>span{display:block;margin-left:14px}.turn-tools li{grid-template-columns:60px minmax(0,1fr);gap:6px}}
.group-step-heading{margin:0 0 12px 42px;color:var(--agent-accent);font-size:12px;font-weight:600;line-height:1.6}.group-message.current header strong{color:var(--agent-text)}.turn-details{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}.turn-model{color:var(--agent-muted);font-size:11px;min-width:0}.turn-model summary{cursor:pointer}.turn-model p{margin:6px 0;overflow-wrap:anywhere}.group-upcoming{margin:0 0 26px 42px;border-top:1px solid var(--agent-border);color:var(--agent-muted);font-size:12px}.group-upcoming>summary{padding:12px 0;cursor:pointer;line-height:1.7}.group-upcoming>summary>small{margin-left:12px;color:var(--agent-secondary);font-size:11px}.group-upcoming ol{list-style:none;margin:0;padding:0}.group-upcoming li+li{border-top:1px solid var(--agent-border)}.upcoming-step>summary{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:9px 0;cursor:pointer}.upcoming-step>summary span{color:var(--agent-secondary);overflow-wrap:anywhere}.upcoming-step>summary small{flex-shrink:0;font-size:11px}.upcoming-step>div{padding:0 0 7px;font-size:11px;line-height:1.7;overflow-wrap:anywhere}.upcoming-step p{margin:0 0 5px}.group-upcoming summary:focus-visible,.turn-model summary:focus-visible{outline:2px solid var(--agent-accent);outline-offset:3px;border-radius:3px}@media(max-width:480px){.group-step-heading,.group-upcoming{margin-left:0}.group-upcoming>summary>small{display:block;margin-left:0}.upcoming-step>summary{gap:6px;font-size:11px}}
.group-workspace{display:grid;grid-template-columns:var(--session-column-width,250px) minmax(0,1fr);height:100%;min-height:0;background:var(--agent-bg);color:var(--agent-text)}.group-sidebar{display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--agent-panel-strong);border-right:1px solid var(--agent-border)}.group-rooms{flex:1;min-height:72px;overflow:auto;padding:0 8px;overscroll-behavior:contain}.group-room{display:grid;gap:5px;width:100%;padding:10px;border:0;border-radius:8px;background:transparent;color:var(--agent-secondary);text-align:left;cursor:pointer}.group-room.selected{background:color-mix(in srgb,var(--agent-accent) 24%,transparent);color:var(--agent-text)}.group-room strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.group-room small{font-size:10px;color:var(--agent-muted)}.group-share{display:flex;justify-content:center;gap:8px;margin-top:0;padding:8px 10px;border-top:1px solid var(--agent-border)}.group-share:deep(.el-button+.el-button){margin-left:0}.group-main{--conversation-reading-width:800px;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto minmax(0,1fr) auto auto;min-height:0;min-width:0;background:var(--agent-bg)}.group-header{display:flex;align-items:center;gap:12px;padding:17px 22px;border-bottom:1px solid var(--agent-border)}.group-header>div:first-child{flex:1}.group-header h1{margin:0;font-size:17px}.group-header p{margin:5px 0 0;color:var(--agent-muted);font-size:11px}.group-header:deep(.el-button){gap:5px}.group-project{display:flex;align-items:center;gap:7px;min-width:0;padding:8px 22px;border-bottom:1px solid var(--agent-border);color:var(--agent-muted);font-size:11px}.group-project>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-messages{min-height:0;overflow:auto;padding:32px max(24px,calc((100% - var(--conversation-reading-width))/2));scrollbar-gutter:stable}.group-empty{display:grid;justify-items:center;align-content:center;min-height:55vh;color:var(--agent-muted);text-align:center}.group-empty h2{font-size:20px;color:var(--agent-text)}.group-empty p{max-width:380px;font-size:12px;line-height:1.8}.group-message{display:flex;gap:12px;margin-bottom:32px;min-width:0}.group-message>div{min-width:0;max-width:calc(100% - 44px);flex:1}.group-message header{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:2px 0 8px}.group-message header strong{font-size:13px}.group-message header small,.group-message time{font-size:10px;color:var(--agent-muted)}.turn-status{font-size:10px;color:var(--agent-accent)}.group-message.user{flex-direction:row-reverse}.group-message.user>div{flex:0 1 auto;max-width:min(85%,640px)}.group-message.user header{justify-content:flex-end}.user-text{margin:0;padding:12px 16px;border-radius:16px;background:var(--ui-user-message-bg,color-mix(in srgb,var(--agent-accent) 17%,var(--agent-panel-strong)));color:var(--ui-user-message-text,var(--agent-text));white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.8}.group-message :deep(.agent-markdown){font-size:15px;line-height:1.8}.turn-progress{font-size:12px;color:var(--agent-muted);line-height:1.8}.turn-error{font-size:12px;color:var(--el-color-danger);white-space:pre-wrap}.group-log{border:0;padding:3px 0;background:transparent;color:var(--agent-accent);font-size:11px;cursor:pointer}.message-attachments{display:flex;gap:8px;font-size:11px}.message-attachments img{display:block;max-width:180px;max-height:150px;object-fit:contain;border-radius:7px}.message-attachments a{color:var(--agent-accent)}.group-control{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:8px max(24px,calc((100% - var(--conversation-reading-width))/2));color:var(--agent-muted);font-size:11px}.group-control>span{margin-right:auto}.group-composer{display:flex;flex-wrap:wrap;align-items:center;min-width:0;gap:9px 12px;margin:0 max(24px,calc((100% - var(--conversation-reading-width))/2)) 18px;padding:12px 13px;border:1px solid var(--agent-border);border-radius:14px;background:var(--agent-panel-strong)}
.group-composer-targets{display:flex;align-items:center;flex-wrap:wrap;flex:1 1 276px;gap:8px;min-width:0;max-width:100%;order:0}.group-composer-targets :deep(.el-select){flex:0 1 148px;width:148px;min-width:0;max-width:148px}.group-composer-targets :deep(.el-select:last-child){flex-basis:120px;width:120px;max-width:120px}.group-composer-targets :deep(.el-select__wrapper){min-height:30px;border-radius:7px}.group-composer-targets :deep(.el-select__selected-item){font-size:11px}
.group-composer-workspace{display:flex;align-items:center;flex-wrap:wrap;flex:1 0 100%;gap:8px;min-width:0;order:2}.group-composer-workspace :deep(.workspace-selector-wrap){flex:0 1 auto;min-width:0;max-width:100%}.group-composer-workspace :deep(.project-launch){flex:0 1 auto}.group-composer-workspace :deep(.el-select__wrapper){min-height:30px;border-radius:7px}
.group-composer-bound-workspaces{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(260px,100%);min-height:30px;padding:0 10px;border:1px solid color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));border-radius:8px;background:color-mix(in srgb,var(--agent-accent) 12%,var(--agent-panel));color:var(--agent-text);font-size:11px;white-space:nowrap}
.group-composer-bound-workspaces>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-composer-bound-workspaces>svg{color:var(--agent-accent);flex-shrink:0}
.group-composer-bound-workspaces>small{padding:1px 5px;border-radius:999px;background:color-mix(in srgb,var(--agent-accent) 22%,transparent);color:var(--agent-accent);font-size:10px;font-weight:600}
.group-composer-prompt{display:contents}.group-composer-prompt :deep(.prompt-tools){order:1;flex-wrap:wrap;min-width:0;max-width:100%;gap:2px;margin:0 0 0 auto}.group-composer-prompt :deep(.prompt-tools .el-button){height:30px;margin:0;padding:4px 6px;font-size:11px}.group-composer-prompt :deep(.editor-body){order:4;flex-basis:100%;min-width:0}.group-composer .group-reply{order:3;flex-basis:100%;min-width:0;margin:0}
.group-composer-prompt :deep(.el-textarea__inner),.group-composer-prompt :deep(.markdown-preview){background:var(--agent-panel);color:var(--agent-text);border-color:var(--agent-border)}.group-composer-prompt :deep(.el-textarea__inner::placeholder){color:var(--agent-muted)}.group-composer-prompt :deep(.el-textarea__inner:focus){border-color:var(--agent-accent)}
.group-composer-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;order:5;flex-basis:100%;min-width:0}.group-composer-footer>span{color:var(--agent-muted);font-size:11px;line-height:1.6}.group-composer-footer :deep(.el-button){gap:6px;min-width:88px;height:34px;margin-left:auto;border-radius:8px}.group-composer-footer :deep(.el-button>span){gap:6px}
.group-name-edit{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:inherit;text-align:left;overflow-wrap:anywhere;cursor:pointer}.group-name-edit svg{flex-shrink:0;color:var(--agent-muted)}.group-name-edit:hover svg{color:var(--agent-accent)}.group-name-edit:focus-visible{outline:2px solid var(--agent-accent);outline-offset:4px;border-radius:2px}.group-name-edit:disabled{cursor:default}
.group-config-members>div{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--el-border-color-lighter);padding:5px 0}.group-config-members>div>span{margin-left:auto;font-size:11px;color:var(--el-text-color-secondary)}.group-config-members :deep(.el-button+.el-button){margin-left:0}.group-setting-hint{font-size:11px;color:var(--el-text-color-secondary);line-height:1.7}.group-personal-model{padding-top:5px}.group-personal-model summary{cursor:pointer;font-size:13px;font-weight:600}.group-personal-model .el-form-item{margin-top:14px}@media(max-width:720px){.group-share{padding:8px 4px;gap:3px}.group-share :deep(.el-button){padding:6px;font-size:10px}.group-header{padding:12px}.group-header #group-connection-status{display:none}.group-header h1{font-size:14px}.group-header :deep(.el-button){padding:6px}.group-project{padding:7px 12px}.group-messages{padding:16px 12px}.group-message{gap:8px}.group-message header{gap:5px}.group-message header small{font-size:9px}.group-composer{margin:0 10px 10px;padding:9px}.group-control{padding:8px 10px;flex-wrap:wrap}.group-control>span{width:100%}}@media(max-width:480px){.group-message>:deep(.agent-avatar){display:none}.group-message>div{max-width:100%}.group-share{flex-direction:column}.group-header{flex-wrap:wrap}}
.current-action strong{font-weight:500;color:var(--agent-text)}.current-action small{display:block;margin-top:3px;color:var(--agent-muted);font-size:12px;line-height:1.6}.current-action .step-state{margin-left:8px}.step-state{flex-shrink:0;color:var(--agent-muted);font-size:11px;font-style:normal;font-weight:400}.step-state.running{color:var(--agent-accent)}.step-state.failed{color:var(--ui-danger)}.turn-step{min-width:0}.step-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 10px;margin:0;line-height:1.7}.step-heading strong{color:var(--agent-text);font-size:12px;font-weight:500}.step-target{margin:3px 0 0;color:var(--agent-secondary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.turn-tools .step-original{margin-top:5px}.turn-tools .step-original>summary{color:var(--agent-accent);font-size:11px}.step-original>div{margin-top:8px}.step-original small{margin-bottom:3px}
.group-feedback-history,.group-summary-evidence{margin:0 0 20px;min-width:0}.group-feedback-history>summary,.group-summary-evidence>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-feedback-history[open]>summary,.group-summary-evidence[open]>summary{margin-bottom:14px}
</style>

<style scoped>
.group-share{flex-shrink:0}
.group-messages{padding-block:0}.group-messages::before,.group-messages::after{content:"";display:block;height:32px}
@media(max-width:720px){.group-messages::before,.group-messages::after{height:16px}}
.group-header{grid-row:1}.group-quotas{grid-row:2}.group-context{grid-row:3}.group-messages{grid-row:4}.group-control{grid-row:5}.group-composer{grid-row:6}
.group-header{padding-block:10px}.group-title{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 14px;min-width:0}.group-title p{margin:0;line-height:1.6}
.group-room-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-room-info{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 16px;margin:0}
.group-room-info dt{color:var(--ui-secondary)}.group-room-info dd{margin:0;overflow-wrap:anywhere}
@media(max-width:720px){.group-header #group-connection-status{display:inline-flex}}
.group-context{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;min-width:0;padding:7px 22px;border-bottom:1px solid var(--agent-border);font-size:11px;color:var(--agent-secondary)}
.group-task-context{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;min-width:0;overflow-wrap:anywhere}.group-task-context strong{font-weight:500}.group-task-context a{color:var(--agent-accent)}
.group-directory{display:inline-flex;align-items:center;gap:5px;margin-left:auto;min-width:0;padding:0;border:0;background:transparent;color:var(--agent-muted);font:inherit;cursor:pointer;white-space:nowrap}.group-directory:hover{color:var(--agent-text)}.group-directory:focus-visible{outline:2px solid var(--agent-accent);outline-offset:2px}.group-directory-path{display:grid;flex:0 0 100%;order:1;gap:6px;min-width:0;margin:4px 0 0;color:var(--agent-muted)}.group-context .group-project{padding:0;border:0;flex:1;flex-wrap:wrap}.group-project>svg{flex-shrink:0}
.group-project-selector-bar{gap:10px}.group-project-selector-bar>.cursor-button{margin-left:auto}.group-context .group-project-list{display:grid;gap:6px}.group-project-entry{display:flex;align-items:center;gap:8px;min-width:0;width:100%}.group-project-entry>svg{flex-shrink:0}.group-project-entry>.group-project-pill{max-width:42%;min-width:0;flex-shrink:1;min-height:26px;box-sizing:border-box}.group-project-entry>.group-project-pill strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-project-entry>.group-project-raw{flex:1;min-width:0}.group-project-entry>.cursor-button{margin-left:auto;height:28px;font-size:11px}.group-project-hint{color:var(--agent-muted);font-size:11px}
.group-project-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-panel-strong);color:var(--agent-text);font-size:11px}.group-project-pill.is-primary{border-color:color-mix(in srgb,var(--agent-accent) 45%,var(--agent-border))}.group-project-pill strong{font-weight:550}.group-project-pill small{padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--agent-accent) 22%,transparent);color:var(--agent-accent);font-size:10px}.group-project-raw{color:var(--agent-muted);font:11px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-quotas{display:flex;align-items:center;flex-wrap:wrap;gap:6px 24px;padding:5px 22px;border-bottom:1px solid var(--agent-border);color:var(--agent-secondary);font-size:11px;line-height:1.7}.group-quota,.group-quota-windows{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;min-width:0}.group-quotas strong{font-size:11px;font-weight:600;color:var(--agent-text);white-space:nowrap}.quota-model-group{overflow-wrap:anywhere}.quota-value{white-space:nowrap}.quota-value b{font-weight:600;color:var(--agent-text)}.group-quotas .exhausted b{color:var(--ui-danger)}.group-quotas button{margin-left:auto;min-height:28px;padding:0 4px;border:0;background:transparent;color:var(--agent-accent);font:11px var(--sans);cursor:pointer;white-space:nowrap}.turn-fallback{margin:10px 0;font-size:12px;line-height:1.8;color:var(--agent-secondary)}.turn-fallback strong{color:var(--agent-text);font-weight:500}.turn-fallback p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}.turn-fallback button{padding:0;border:0;background:transparent;color:var(--agent-accent);font:12px var(--sans);cursor:pointer}@media(max-width:720px){.group-context{padding:7px 12px}.group-quotas{padding:5px 12px;gap:5px 12px}.group-quota{width:100%}.group-directory{margin-left:0}.group-title{gap:4px}.group-quotas button{min-height:32px}}
.group-feedback-history,.group-summary-evidence{margin:0 0 20px;min-width:0}.group-feedback-history>summary,.group-summary-evidence>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-feedback-history[open]>summary,.group-summary-evidence[open]>summary{margin-bottom:14px}
</style>

<style scoped>
.group-workspace{--group-sidebar-width:var(--session-column-width,250px);grid-template-columns:var(--group-sidebar-width) minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.group-workspace.details-open{grid-template-columns:var(--group-sidebar-width) minmax(0,1fr) var(--group-details-width)}
.group-sidebar{grid-column:1;grid-row:1}.group-main{grid-column:2;grid-row:1}.group-details-panel,.group-details-resize{grid-column:3;grid-row:1}.group-details-resize{justify-self:start;margin-left:0}
.group-narrow-toolbar{display:none}
@media(max-width:900px){
  .group-workspace,.group-workspace.details-open{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .group-narrow-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;grid-column:1;grid-row:1;min-height:42px;padding:4px 12px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel-strong)}
  .group-narrow-toolbar>button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--agent-secondary);font:12px var(--sans);cursor:pointer}
  .group-narrow-toolbar>button:hover{background:var(--agent-raised);color:var(--agent-text)}
  .group-narrow-toolbar>button:focus-visible{outline:2px solid var(--agent-accent);outline-offset:-2px}
  .group-sidebar,.group-main,.group-details-panel{grid-column:1;grid-row:2;width:100%;min-width:0;max-width:none}
  .group-sidebar{display:none;border-right:0}
  .group-workspace.narrow-sidebar-open .group-sidebar{display:flex}
  .group-workspace.details-open .group-main,.group-workspace.narrow-sidebar-open .group-main,.group-workspace.narrow-sidebar-open .group-details-panel{display:none}
  .group-details-panel :deep(.side-panel){border-left:0}
  .group-details-resize,.group-sidebar-resize{display:none}
}
@media(max-width:720px){.group-header{flex-wrap:wrap;gap:8px}.group-header>.group-title:first-child{flex:1 0 100%}}
@media(max-width:480px){
  .group-workspace .group-message>:deep(.agent-avatar){display:none}
  .group-quotas{flex-wrap:nowrap;overflow-x:auto}
  .group-quota{width:auto;flex:0 0 auto;flex-wrap:nowrap}
  .group-quota-windows{flex-wrap:nowrap}
  .group-quotas button{flex-shrink:0}
  .group-composer-targets{flex-wrap:nowrap;overflow-x:auto}
  .group-composer-targets>:deep(*){flex-shrink:0}
  .group-composer-targets :deep(.el-select){flex:0 0 148px}.group-composer-targets :deep(.el-select:last-child){flex-basis:120px}.group-project-entry{flex-wrap:wrap}.group-project-entry>.group-project-pill{max-width:calc(100% - 24px)}.group-project-entry>.group-project-raw{flex-basis:100%;order:2}.group-project-entry>.cursor-button{margin-left:0}
  .group-composer-prompt :deep(.prompt-tools){flex-wrap:nowrap;overflow-x:auto}
  .group-composer-prompt :deep(.prompt-tools .el-button){flex-shrink:0}
}

.group-latest-feedback .latest-action{display:grid;gap:6px}.group-latest-feedback .latest-action small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;color:var(--agent-muted);font-size:12px}.latest-feedback-tools{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-top:10px}.latest-feedback-tools>time{font-size:11px;color:var(--agent-muted)}
.group-feedback-history,.group-summary-evidence{margin:0 0 20px;min-width:0}.group-feedback-history>summary,.group-summary-evidence>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-feedback-history[open]>summary,.group-summary-evidence[open]>summary{margin-bottom:14px}
</style>

<style scoped>
.group-room-row{display:flex;align-items:center;min-width:0;border-radius:8px}
.group-sidebar-heading{display:flex;align-items:center;justify-content:space-between;padding:8px 16px 4px;color:var(--agent-muted);font-size:11px}.group-sidebar-heading strong{font-weight:400}.group-sidebar-heading span{font:10px var(--mono)}
.group-room-section{margin-bottom:6px;min-width:0}.group-room-section-heading{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:4px 7px;border:0;border-radius:6px;background:transparent;color:var(--agent-muted);text-align:left;cursor:pointer}.group-room-section-heading strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px var(--sans)}.group-room-section-heading span{font:10px var(--mono)}.group-room-section-heading svg{flex-shrink:0}.group-room-section-heading .collapsed{transform:rotate(-90deg)}.group-room-section-heading:hover{background:var(--agent-raised);color:var(--agent-text)}.group-room-section-heading:disabled{cursor:default}.group-pinned-heading{color:var(--agent-accent);cursor:default}.group-room-section:has(.group-pinned-heading){padding-bottom:6px;border-bottom:1px solid var(--agent-border)}
.group-room-menu{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--agent-muted);cursor:pointer}.group-room-menu:hover{background:var(--agent-raised);color:var(--agent-text)}.group-room-menu:focus-visible,.group-room-section-heading:focus-visible{outline:2px solid var(--agent-accent);outline-offset:-2px}
.group-room-row.selected{background:color-mix(in srgb,var(--agent-accent) 24%,transparent)}
.group-room-row .group-room{flex:1;min-width:0}
.group-room-row input,.group-batch-toolbar input{accent-color:var(--agent-accent)}
.group-room-delete{display:flex;align-items:center;padding:7px;border:0;background:transparent;color:var(--agent-muted);cursor:pointer;opacity:0;pointer-events:none}
.group-room-row:hover .group-room-delete,.group-room-delete:focus-visible{opacity:1;pointer-events:auto}
.group-room-delete:disabled{cursor:not-allowed}.group-room-row:hover .group-room-delete:disabled{opacity:.45}
.group-room-delete:hover{color:var(--el-color-danger)}
.group-batch-toolbar{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;color:var(--agent-secondary)}
.group-batch-toolbar label{display:flex;align-items:center;gap:4px}
.group-batch-toolbar>span{flex:1;white-space:nowrap}
.group-batch-toolbar button{padding:3px;border:0;background:transparent;color:var(--agent-secondary);cursor:pointer}
.group-batch-toolbar button:first-of-type{color:var(--el-color-danger)}
.group-batch-toggle{display:flex;align-items:center;gap:8px;margin:7px 12px;padding:8px;border:0;background:transparent;color:var(--agent-secondary);text-align:left;cursor:pointer;font-size:12px}
.group-user-tools{display:flex;align-items:center;gap:9px;justify-content:flex-end;margin-top:7px;color:var(--agent-muted);font-size:11px}
.group-message-edit{display:inline-flex;align-items:center;gap:4px;border:0;padding:2px 0;background:transparent;color:var(--agent-accent);cursor:pointer;font-size:11px}
.group-batch-toggle:disabled,.group-batch-toolbar button:disabled,.group-message-edit:disabled{opacity:.45;cursor:not-allowed}
.group-feedback-history,.group-summary-evidence{margin:0 0 20px;min-width:0}.group-feedback-history>summary,.group-summary-evidence>summary{padding:8px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.group-feedback-history[open]>summary,.group-summary-evidence[open]>summary{margin-bottom:14px}
</style>

<style scoped>
:global(.group-role-dialog.el-dialog){display:flex;flex-direction:column;max-height:calc(100dvh - 48px);margin-bottom:24px;padding:20px 24px}
:global(.group-role-dialog .el-dialog__header){flex-shrink:0;padding-bottom:18px}
:global(.group-role-dialog .el-dialog__body){min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
:global(.group-role-dialog .el-dialog__footer){flex-shrink:0;padding-top:16px;margin-top:20px;border-top:1px solid var(--el-border-color-lighter)}
.group-role-form{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,1fr);gap:28px;align-items:start}
.group-role-fields,.group-role-model-fields{display:grid;gap:18px;min-width:0}
.group-role-identity{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px}
.group-role-form .el-form-item{min-width:0;margin:0}
.group-role-form :deep(.el-form-item__label){margin-bottom:8px;line-height:20px}
.group-role-form :deep(.el-form-item__content){min-width:0}
.group-role-form :deep(.el-select){width:100%;min-width:0}
.group-role-form :deep(.el-textarea__inner){line-height:1.7}
.group-role-models{min-width:0;padding:0 0 0 28px;border-left:1px solid var(--el-border-color-lighter)}
.group-role-models .group-setting-hint{margin:10px 0 18px}
.group-role-fallback{margin-top:20px;padding-top:20px;border-top:1px solid var(--el-border-color-lighter)}
.group-role-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.group-role-actions{display:flex;gap:10px;margin-left:auto}
.group-role-actions :deep(.el-button){margin-left:0;min-width:76px}
@media(max-width:800px){
  .group-role-form{grid-template-columns:minmax(0,1fr);gap:24px}
  .group-role-models{padding:20px 0 0;border-left:0;border-top:1px solid var(--el-border-color-lighter)}
}
@media(max-width:480px){
  :global(.group-role-dialog.el-dialog){padding:16px}
  .group-role-identity{grid-template-columns:minmax(0,1fr);gap:18px}
  .group-role-footer{gap:8px}
  .group-role-actions{gap:8px}
  .group-role-actions :deep(.el-button){min-width:64px}
}
</style>

<style scoped src="./agent-group-layout.css"></style>

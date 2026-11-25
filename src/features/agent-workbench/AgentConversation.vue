<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
import AgentConversationWorkspaceContext from './AgentConversationWorkspaceContext.vue';
import type { ConversationWorkspace } from '../../../shared/conversation-workspaces';
/**
 * 设计说明：该组件把一次会话的运行链呈现为用户/Agent 消息，并提供唯一的会话输入口。
 * 它不直接请求后端，发送、停止和详情操作全部通过显式事件交给容器，避免隐藏副作用。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue';
import { Activity, ArrowDown, ArrowUp, Bookmark, PackageCheck, Check, ChevronDown, ChevronRight, CircleStop, CornerUpLeft, Copy, Download, Ellipsis, ExternalLink, File, FileText, Folder, GitBranch, GitFork, Info,
  ListOrdered, Pencil, Pin, Play, Quote, RotateCcw, Search, Trash2, X } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { agentProviderLabels, canContinueStoppedCodexRun, isAgentImageAttachment, type AgentAccessMode, type AgentAttachment, type AgentChangedFile, type AgentProvider, type AgentQueuePlacement, type AgentReasoningEffort, type AgentRun, type AgentRunMode, type AgentRuntimeHealth, type AgentServiceTier } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentComposer from './AgentComposer.vue';
import type { AgentTeamRequest } from './AgentTeamDialog.vue';
import AgentTerminalButton from './AgentTerminalButton.vue';
import AgentCursorButton from './AgentCursorButton.vue';
import AgentWorkspaceSelector from './AgentWorkspaceSelector.vue';
import type { AgentWorkspaceOption } from './workspace-catalog';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentLiveRunActivity from './AgentLiveRunActivity.vue';
import AgentPlanChecklistCard from './AgentPlanChecklistCard.vue';
const AgentTeamQuestion = defineAsyncComponent(() => import('./AgentTeamQuestion.vue'));
const AgentExecutionPanel = defineAsyncComponent(() => import('./AgentExecutionPanel.vue'));
const AgentRemoteDelivery = defineAsyncComponent(() => import('./AgentRemoteDelivery.vue'));
const AgentWorkspaceCodeArtifacts = defineAsyncComponent(() => import('./AgentWorkspaceCodeArtifacts.vue'));
const AgentConversationDeliveryBrief = defineAsyncComponent(() => import('./AgentConversationDeliveryBrief.vue'));
const AgentFailureRcaCard = defineAsyncComponent(() => import('./AgentFailureRcaCard.vue'));
import type { JiraDevTaskView } from '../../../shared/jira-dev';
import { jiraDevTaskDeliveryId, jiraDevTaskIssue, jiraDevTaskProjects, jiraDevTaskWorkspacePaths } from './jira-dev-context';
import { canRetryTeamReviewWithCodex } from '../../../shared/agent-team';
import AgentMarkdown from './AgentMarkdown.vue';
const PluginRecordQuickSave = defineAsyncComponent(() => import('../custom-plugins/PluginRecordQuickSave.vue'));
import AgentMessageText from './AgentMessageText.vue';
const AgentTaskPromptDrawer = defineAsyncComponent(() => import('./AgentTaskPromptDrawer.vue'));
import { jiraTaskPromptTitle } from './message-text';
import AgentTranslatedText from './AgentTranslatedText.vue';
import AgentTranslateToggle from './AgentTranslateToggle.vue';
import { agentConversationBranch, agentConversationCodePaths, agentConversationContinuation, agentConversationForkSource, agentConversationStatus, agentConversationWorkspacePath, agentConversationWorkspacePaths, canSteerAgentRun, agentRunErrorText, agentConversationProjectPath, agentRunStatus, isLegacyRestartContinuation, isRestartableAgentRun, isRetryableSessionBusyRun, type AgentConversation } from './conversation';
import { threadUrl } from '../workbench/domain';
import { downloadConversation } from './conversation-export';
import { conversationFileDeliveries, conversationResultDownloads } from './conversation-deliveries';
import type { AgentBusinessMention } from './agent-business-context';
import type { AgentAttachmentDraft } from './useAgentAttachments';
import { teamChatEntries, teamChatParticipant, teamChatActivity, teamChatActiveStates, teamQuestionReply, isCurrentTeamChatTask, type TeamQuestionTarget } from './team-chat';
import { agentReplyText } from './execution-summary';
import { formatChangedFileReference, formatQuoteReply, summarizeOutlineText } from './conversation-outline';
import { formatCodeBlockFollowUp } from './code-block-tools';
import { buildSelectionActionPrompt, looksLikeErrorSelection, type SelectionQuickActionKind } from './selection-quick-actions';
import { buildConversationClipboardDigest, countKeywordOccurrences, stepSearchMatchIndex } from './conversation-search-and-share';
import { useAgentBookmarks, type AgentMessageBookmark } from './useAgentBookmarks';
import { teamRoomAcceptanceRecord, type AdvancedTeamTask, type TeamRoom, type TeamDecision } from './team-api';

const props = defineProps<{ workspace?: ConversationWorkspace; workspaceName?: string; conversation?: AgentConversation; visible?: boolean; changing: string; runtimes: AgentRuntimeHealth[]; sideForkAvailable?: boolean; projectlessFork?: boolean; canBringToMain?: boolean;
  olderHistory?: boolean; loadingOlder?: boolean; historyError?: boolean; loadOlder?: () => Promise<unknown>; retryHistory?: () => unknown;
  workspaceOptions?: AgentWorkspaceOption[]; choosingWorkspace?: boolean;
  saveWorkspace?: (conversation: AgentConversation, paths: string[]) => Promise<boolean>;
  browseWorkspace?: (initialPath: string) => Promise<string | undefined>;
  pinned: boolean; businessOptions: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft; teamTasks?: AdvancedTeamTask[]; teamRoom?: TeamRoom; teamAttachments?: Record<string, AgentAttachment>; jiraTask?: JiraDevTaskView }>();
const automatic = defineModel<boolean>('automatic', { default: false });
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const emit = defineEmits<{ manageWorkspace: [id:string]; send: [selection: { provider: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean; team?: AgentTeamRequest; question?: TeamQuestionTarget }]; accessChange: [accessMode: AgentAccessMode]; stop: [run: AgentRun]; edit: [run: AgentRun]; steer: [run: AgentRun]; removeQueued: [run: AgentRun]; retry: [run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>]; fork: [run: AgentRun]; forkSide: [run: AgentRun]; pin: [conversation: AgentConversation]; rename: [conversation: AgentConversation]; renameTitle: [conversation: AgentConversation, title: string]; remove: [conversation: AgentConversation]; inspect: [run: AgentRun]; configureModels: []; teamDecision: [action: TeamDecision]; teamCommand: [command: '暂停任务' | '继续执行']; chooseTeamWorkspace: []; providerChange: [provider: AgentProvider]; openGroup: [roomId: string]; bringToMain: [text: string] }>();
const editingTitle = shallowRef(false);
const titleDraft = shallowRef('');
const titleInput = useTemplateRef<HTMLInputElement>('titleInput');
function startTitleEdit() {
  if (!props.conversation || props.changing) return;
  titleDraft.value = props.conversation.title;
  editingTitle.value = true;
  void nextTick(() => { titleInput.value?.focus(); titleInput.value?.select(); });
}
function cancelTitleEdit() { editingTitle.value = false; }
function commitTitleEdit() {
  if (!editingTitle.value) return;
  editingTitle.value = false;
  const target = props.conversation, trimmed = titleDraft.value.trim();
  if (!target || !trimmed || trimmed === target.title) return;
  if (trimmed.length > 120) { ElMessage.warning('会话标题不能超过 120 个字符'); return; }
  emit('renameTitle', target, trimmed);
}
const jiraTaskIssue = computed(() => props.jiraTask ? jiraDevTaskIssue(props.jiraTask) : undefined);
const jiraTaskProjects = computed(() => props.jiraTask ? jiraDevTaskProjects(props.jiraTask) : []);
const codePaths = computed(() => {
  const jiraPaths = jiraDevTaskWorkspacePaths(props.jiraTask);
  return agentConversationCodePaths(props.conversation).filter(path => !jiraPaths.includes(path));
});
const messageViewport = useTemplateRef<HTMLDivElement>('messageViewport');
const composer = useTemplateRef<InstanceType<typeof AgentComposer>>('composer');
const searchQuery = shallowRef('');
const activeSearchTurnIndex = shallowRef(0);
const awayFromLatest = shallowRef(false);
const openedExecution = shallowRef(false);
const nearLatest = (viewport: HTMLDivElement) => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
const conversationView = shallowRef<'chat' | 'execution' | 'delivery'>('chat');
const taskPromptDetail = shallowRef<string>();
const selectedQuoteText = shallowRef('');
const bookmarkStore = typeof useAgentBookmarks === 'function'
  ? useAgentBookmarks()
  : {
      bookmarks: shallowRef<AgentMessageBookmark[]>([]),
      isBookmarked: () => false,
      toggleBookmark: () => false,
      removeBookmark: () => {},
      reloadBookmarks: () => {},
    };
const bookmarkFilter = shallowRef('');
const filteredBookmarks = computed(() => {
  const term = bookmarkFilter.value.trim().toLowerCase();
  if (!term) return bookmarkStore.bookmarks.value;
  return bookmarkStore.bookmarks.value.filter(item =>
    `${item.conversationTitle} ${item.excerpt} ${item.content}`.toLowerCase().includes(term),
  );
});
const currentSessionBookmarks = computed(() =>
  filteredBookmarks.value.filter(item => item.conversationId === props.conversation?.id),
);
const otherSessionBookmarks = computed(() =>
  filteredBookmarks.value.filter(item => item.conversationId !== props.conversation?.id),
);
watch([() => props.conversation?.id, () => props.visible], ([id, visible], [previousId]) => {
  if (id !== previousId) { conversationView.value = 'chat'; editingTitle.value = false; selectedQuoteText.value = ''; }
  if (id !== previousId || visible === false) taskPromptDetail.value = undefined;
});
watch(conversationView, view => {
  if (view === 'execution') openedExecution.value = true;
  if (view !== 'chat') selectedQuoteText.value = '';
});
const copiedMessageId = shallowRef('');
const searchQueries = new Map<string, string>();
const scrollPositions = new Map<string, number>();
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const latest = computed(() => props.conversation?.latest);
const codexDesktopUrl = computed(() => {
  if (!props.conversation || props.conversation.teamChat) return;
  const run = agentConversationContinuation(props.conversation);
  return run.provider === 'codex' ? threadUrl(run.continuation?.sessionId || run.sessionId) : undefined;
});
function openCodexDesktop() {
  if (codexDesktopUrl.value) window.location.assign(codexDesktopUrl.value);
}
const forkSource = computed(() => agentConversationForkSource(props.conversation, props.projectlessFork));
const status = computed(() => props.conversation && agentConversationStatus(props.conversation));
const runtime = computed(() => props.runtimes.find((item) => item.provider === latest.value?.provider));
const teamTasks = computed(() => (props.teamTasks || []).filter(task => task.parentConversationId === props.conversation?.id).map(task => props.teamRoom?.task.id === task.id ? props.teamRoom.task : task));
const currentTeamTask = computed(() => {
  const task = teamTasks.value.at(-1);
  return task && props.conversation && isCurrentTeamChatTask(task, props.conversation) ? task : undefined;
});
const questionTarget = shallowRef<TeamQuestionTarget & { text: string }>();
const questionTargets = new Map<string, TeamQuestionTarget & { text: string }>();
const questionReply = computed(() => questionTarget.value
  ? teamQuestionReply(teamTasks.value, questionTarget.value, props.teamRoom) || { ...questionTarget.value, state: 'expired' as const } : undefined);
watch(() => props.conversation?.id, id => { questionTarget.value = id ? questionTargets.get(id) : undefined; });
function cancelQuestionReply() {
  if (props.conversation?.id) questionTargets.delete(props.conversation.id);
  questionTarget.value = undefined;
}
watch([() => questionReply.value?.state, draft, attachments], ([state, text, files]) => {
  if (state === 'answered' && !text.trim() && !files.length) cancelQuestionReply();
});
function replyToQuestion(target: TeamQuestionTarget) {
  const reply = teamQuestionReply(teamTasks.value, target, props.teamRoom);
  if (props.changing || reply?.state !== 'pending') return;
  questionTarget.value = { ...target, text: reply.text };
  if (props.conversation?.id) questionTargets.set(props.conversation.id, questionTarget.value);
  composer.value?.focusPrompt();
}
function sendFromComposer(selection: { provider: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean; team?: AgentTeamRequest }) {
  if (questionTarget.value && questionReply.value?.state !== 'pending') return;
  emit('send', { ...selection, ...(questionTarget.value ? { question: { taskId: questionTarget.value.taskId, questionId: questionTarget.value.questionId } } : {}) });
}
const fileDeliveries = computed(() => conversationFileDeliveries(props.conversation, currentTeamTask.value, props.teamRoom?.runs));
const currentFileDeliveries = computed(() => fileDeliveries.value.filter(item => item.current));
const historicalFileDeliveries = computed(() => fileDeliveries.value.filter(item => !item.current));
const currentFileCount = computed(() => currentFileDeliveries.value.reduce((count, item) => count + (item.run.changedFiles?.length || 0), 0));
const nextAccessMode = shallowRef<AgentAccessMode>('full');
watch([() => props.conversation?.id, () => currentTeamTask.value?.id], () => {
  nextAccessMode.value = currentTeamTask.value?.accessMode || 'full';
}, { immediate: true });
const effectiveAutomatic = computed({ get: () => automatic.value && props.conversation?.source !== 'codex', set: value => { automatic.value = value; } });
const showCurrentTeamStatus = computed(() => effectiveAutomatic.value && !!props.conversation?.teamChat);
const teamActivity = computed(() => teamChatActivity(currentTeamTask.value));
function chatAttachment(id: string) { return props.teamAttachments?.[id] || [...(props.teamRoom?.runs || []), ...(props.conversation?.runs || [])].flatMap(run => run.attachments || []).find(file => file.id === id); }
const teamAcceptance = computed(() => teamRoomAcceptanceRecord(props.teamRoom));
const teamResultSummary = computed(() => teamAcceptance.value?.acceptanceOverview?.summary || '');
const teamResultDownloads = computed(() => conversationResultDownloads(props.conversation, currentTeamTask.value, props.teamRoom?.runs));
const hasTeamDeliveryMessage = computed(() => currentTeamTask.value?.chat?.messages.some(message => message.kind === 'delivery'));
const teamResultVisible = computed(() => showCurrentTeamStatus.value && !!currentTeamTask.value && (!!teamResultSummary.value || hasTeamDeliveryMessage.value)
  && ['awaiting_acceptance', 'accepted', 'rejected', 'completed'].includes(currentTeamTask.value.state));
const teamProgressVisible = computed(() => showCurrentTeamStatus.value && !!currentTeamTask.value && (teamChatActiveStates.has(currentTeamTask.value.state)
  || currentTeamTask.value.nodes.some(node => node.profileId !== 'leader') || !!teamAcceptance.value));
const running = computed(() => !!latest.value && ['queued', 'running'].includes(latest.value.status)
  || !!currentTeamTask.value && ['planning', 'running'].includes(currentTeamTask.value.state));
const activeRun = computed(() => props.conversation?.runs.find((run) => run.status === 'running'));
const pausedRun = computed(() => props.conversation?.runs.find(run => run.pausedForEdit));
const continuableRun = computed(() => {
  if (props.conversation?.source !== 'workspace' || props.conversation.teamChat || running.value) return;
  const run = props.conversation.runs.filter(item => !item.syncedHistory).at(-1);
  if (run && (!pausedRun.value || pausedRun.value.id === run.id) && !run.resumeAfterWorkspaceRestart && canContinueStoppedCodexRun(run)) return run;
});
const stoppableRun = computed(() => activeRun.value || [...(props.conversation?.runs || [])].reverse().find((run) => run.status === 'queued'));
const latestActivity = (run: AgentRun) => run.events.at(-1)?.message || '等待执行器返回状态';
const modeLabel = computed(() => props.conversation?.source === 'codex' ? '历史会话'
  : latest.value?.mode === 'agent' ? 'Agent 模式' : latest.value?.mode === 'plan' ? 'Plan 模式' : 'Ask 模式');
const accessLabel = computed(() => effectiveAutomatic.value ? nextAccessMode.value === 'full' ? '下一轮完全访问' : '下一轮工作区访问' : !latest.value || latest.value.mode !== 'agent' ? '只读访问'
  : latest.value.accessMode === 'full' ? '完全访问' : '工作区访问');
const selectedModelLabel = computed(() => runtime.value?.models.find((model) => model.id === latest.value?.model)?.label || latest.value?.model || 'CLI 默认');
const projectPath = computed(() => props.conversation ? agentConversationProjectPath(props.conversation) : '');
const workspacePath = computed(() => props.conversation ? agentConversationWorkspacePath(props.conversation) : '');
const workspacePaths = computed(() => props.conversation ? agentConversationWorkspacePaths(props.conversation) : []);
const workspaceBranch = computed(() => props.conversation ? agentConversationBranch(props.conversation) : '');
const workspacePickerLabel = computed(() => projectPath.value ? '更换项目工作区' : '绑定项目工作区');
const canChangeWorkspace = computed(() => !!props.saveWorkspace && props.conversation?.source === 'workspace' && !props.conversation.teamChat
  && !pausedRun.value && !props.conversation.runs.some(run => run.team || run.task));
const workspacePickerDisabled = computed(() => !!props.changing || props.choosingWorkspace);
async function applyWorkspaceSelection(paths: string[]) {
  return props.conversation && props.saveWorkspace ? props.saveWorkspace(props.conversation, paths) : false;
}
const workspaceLabel = computed(() => {
  const parts = projectPath.value.replaceAll('\\', '/').split('/').filter(Boolean);
  const leaf = parts.at(-1) || '未绑定项目';
  return ['admin', 'delivery-admin'].includes(leaf.toLowerCase()) ? parts.at(-2) || leaf : leaf;
});
const visibleEntries = computed(() => teamChatEntries(props.conversation?.runs || [], teamTasks.value, searchQuery.value, props.teamRoom?.runs || [], props.teamRoom));
const legacyContinuations = computed(() => {
  const runs = props.conversation?.runs || [];
  return new Set(runs.filter((run, index) => isLegacyRestartContinuation(run, runs[index - 1])).map(run => run.id));
});
const transcriptEntries = computed(() => {
  type Entry = typeof visibleEntries.value[number];
  type RunEntry = Extract<Entry, { kind: 'run' }>;
  const groups: (Exclude<Entry, RunEntry> | { kind: 'run'; id: string; runs: RunEntry[] })[] = [];
  for (const entry of visibleEntries.value) {
    if (entry.kind !== 'run') { groups.push(entry); continue; }
    const previous = groups.at(-1);
    if (legacyContinuations.value.has(entry.run.id) && previous?.kind === 'run'
      && previous.runs.at(-1)?.run.id === entry.run.revisesRunId) previous.runs.push(entry);
    else groups.push({ kind: 'run', id: entry.id, runs: [entry] });
  }
  return groups;
});
const taskPromptTitles = computed(() => new Map(visibleEntries.value.flatMap(entry => {
  const text = entry.kind === 'run' ? entry.run.objective : entry.message.role === 'user' ? entry.message.text : '';
  const title = jiraTaskPromptTitle(text);
  return title ? [[entry.id, title] as const] : [];
})));
const turnOutlineItems = computed(() => {
  const items: { entryIndex: number; round: number; label: string; changedFiles: number }[] = [];
  let round = 0;
  for (let i = 0; i < transcriptEntries.value.length; i++) {
    const entry = transcriptEntries.value[i];
    if (entry.kind === 'run') {
      const first = entry.runs[0];
      const raw = taskPromptTitles.value.get(first.id) || first.run.objective || '';
      const changedFiles = entry.runs.reduce((sum, item) => sum + (item.run.changedFiles?.length || 0), 0);
      items.push({ entryIndex: i, round: ++round, label: summarizeOutlineText(raw, 56), changedFiles });
    } else if (entry.message.role === 'user') {
      const raw = taskPromptTitles.value.get(entry.id) || entry.message.text || '';
      items.push({ entryIndex: i, round: ++round, label: summarizeOutlineText(raw, 56), changedFiles: 0 });
    }
  }
  return items;
});
const entrySignature = computed(() => [visibleEntries.value.map(entry => entry.kind === 'run' ? `${entry.id}:${entry.run.updatedAt}:${entry.run.result.length}` : `${entry.id}:${entry.message.text.length}`).join('|'),
  currentTeamTask.value?.updatedAt || '', ...(props.teamRoom?.runs || []).map(run => `${run.id}:${run.updatedAt}:${run.events.length}:${run.result.length}`)].join('|'));

watch(() => props.conversation?.id, (id, previousId) => {
  const viewport = messageViewport.value;
  if (previousId && viewport?.clientHeight && conversationView.value === 'chat') {
    if (nearLatest(viewport)) scrollPositions.delete(previousId);
    else scrollPositions.set(previousId, viewport.scrollTop);
  }
  searchQuery.value = id ? searchQueries.get(id) || '' : '';
}, { immediate: true });
watch([conversationView, () => props.visible], (_value, [previousView, previousVisible]) => {
  if (previousView === 'chat' && previousVisible !== false) rememberScroll();
});
// 工作面板通过 v-show 隐藏会话；等容器挂载并真正显示后再恢复，不能在隐藏时把位置归零。
watch([() => props.conversation?.id, conversationView, () => props.visible, messageViewport], ([id, view, visible, viewport]) => {
  if (!id || view !== 'chat' || visible === false || !viewport?.clientHeight) return;
  if (!searchQuery.value) viewport.scrollTop = scrollPositions.get(id) ?? viewport.scrollHeight;
  awayFromLatest.value = !nearLatest(viewport);
}, { immediate: true, flush: 'post' });
watch(searchQuery, (value) => {
  activeSearchTurnIndex.value = 0;
  if (props.conversation?.id) searchQueries.set(props.conversation.id, value);
});
const searchHitTotal = computed(() => {
  const q = searchQuery.value.trim();
  if (!q || typeof countKeywordOccurrences !== 'function') return 0;
  let sum = 0;
  for (const entry of visibleEntries.value) {
    if (entry.kind === 'run') {
      sum += countKeywordOccurrences(entry.run.objective, q);
      sum += countKeywordOccurrences(entry.run.result, q);
      sum += countKeywordOccurrences(entry.run.error, q);
    } else {
      sum += countKeywordOccurrences(entry.message.text, q);
    }
  }
  return sum;
});
function stepSearchTurn(delta: 1 | -1) {
  const total = transcriptEntries.value.length;
  if (!total) return;
  const next = typeof stepSearchMatchIndex === 'function'
    ? stepSearchMatchIndex(activeSearchTurnIndex.value, total, delta)
    : (activeSearchTurnIndex.value + delta + total) % total;
  activeSearchTurnIndex.value = next;
  jumpToTurn(next);
}
let scrollQueued = false;
let prependingHistory = false;
async function loadOlderHistory() {
  const viewport = messageViewport.value;
  const id = props.conversation?.id;
  if (!viewport || !id || !props.loadOlder || prependingHistory) return;
  const top = viewport.scrollTop;
  const height = viewport.scrollHeight;
  prependingHistory = true;
  try {
    await props.loadOlder();
    await nextTick();
    if (props.conversation?.id === id && messageViewport.value === viewport) {
      viewport.scrollTop = top + Math.max(0, viewport.scrollHeight - height);
      rememberScroll();
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally { prependingHistory = false; }
}
watch(() => [props.conversation?.id, entrySignature.value] as const, async ([id], [previousId]) => {
  if (id !== previousId || scrollQueued || prependingHistory) return;
  const viewport = messageViewport.value;
  if (!viewport || !viewport.clientHeight || searchQuery.value || !isChatVisible()) return;
  const followsLatest = !awayFromLatest.value || nearLatest(viewport);
  if (!followsLatest) return;
  scrollQueued = true;
  try {
    // 批量合并同一微任务内的流式更新，避免 flush: 'sync' 在每个字符块触发强制同步布局回流。
    await nextTick();
    if (props.conversation?.id === id && messageViewport.value === viewport && viewport.clientHeight
      && isChatVisible() && !searchQuery.value && !awayFromLatest.value) jumpToLatest();
  } finally { scrollQueued = false; }
});

function isChatVisible() { return props.visible !== false && conversationView.value === 'chat'; }

function rememberScroll() {
  const viewport = messageViewport.value;
  if (!props.conversation?.id || !viewport?.clientHeight) return;
  awayFromLatest.value = !nearLatest(viewport);
  if (searchQuery.value || awayFromLatest.value) scrollPositions.set(props.conversation.id, viewport.scrollTop);
  else scrollPositions.delete(props.conversation.id);
}

function jumpToLatest() {
  const viewport = messageViewport.value;
  if (!viewport?.clientHeight) return;
  viewport.scrollTop = viewport.scrollHeight;
  rememberScroll();
}

function jumpToTop() {
  const viewport = messageViewport.value;
  if (!viewport?.clientHeight) return;
  viewport.scrollTop = 0;
  rememberScroll();
}

function jumpToTurn(entryIndex: number) {
  const viewport = messageViewport.value;
  if (!viewport) return;
  const target = viewport.querySelector<HTMLElement>(`[data-turn-index="${entryIndex}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stripMarkdownPlain(source: string): string {
  return source
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

async function copyMessage(id: string, content: string) {
  try {
    await navigator.clipboard.writeText(content);
    copiedMessageId.value = id;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedMessageId.value = ''; }, 1500);
  } catch { ElMessage.error('复制失败'); }
}

function exportConversation(format: unknown) {
  if (!props.conversation || !['markdown', 'json', 'handoff'].includes(String(format))) return;
  downloadConversation(props.conversation, format as 'markdown' | 'json' | 'handoff');
}

async function copyConversationDigest() {
  if (!props.conversation || typeof buildConversationClipboardDigest !== 'function') return;
  try {
    await navigator.clipboard.writeText(buildConversationClipboardDigest(props.conversation));
    ElMessage.success('已复制整场对话纪要，可直接粘贴到飞书、企微或笔记');
  } catch {
    ElMessage.error('复制对话纪要失败');
  }
}

async function applyPromptFromDelivery(prompt: string) {
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${prompt}` : prompt;
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  await nextTick();
  composer.value?.focusPrompt();
}

onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });

function focusComposer() { composer.value?.focusPrompt(); }

function captureViewportSelection() {
  const viewport = messageViewport.value;
  if (!viewport || typeof window === 'undefined' || !window.getSelection) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    selectedQuoteText.value = '';
    return;
  }
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !viewport.contains(anchor) || !viewport.contains(focus)) return;
  const text = selection.toString().trim();
  selectedQuoteText.value = text.length >= 2 && text.length <= 2400 ? text : '';
}

const selectionLooksLikeError = computed(() =>
  typeof looksLikeErrorSelection === 'function' && looksLikeErrorSelection(selectedQuoteText.value),
);

async function quoteTextToComposer(rawSnippet: string) {
  const next = formatQuoteReply(rawSnippet, draft.value);
  if (next === draft.value && !rawSnippet.trim()) return;
  draft.value = next;
  selectedQuoteText.value = '';
  if (typeof window !== 'undefined' && window.getSelection) {
    window.getSelection()?.removeAllRanges();
  }
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  await nextTick();
  composer.value?.focusPrompt();
}

async function applySelectionAction(action: SelectionQuickActionKind) {
  const raw = selectedQuoteText.value;
  if (!raw.trim()) return;
  const next = typeof buildSelectionActionPrompt === 'function'
    ? buildSelectionActionPrompt(raw, action, draft.value)
    : formatQuoteReply(raw, draft.value);
  draft.value = next;
  selectedQuoteText.value = '';
  if (typeof window !== 'undefined' && window.getSelection) {
    window.getSelection()?.removeAllRanges();
  }
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  await nextTick();
  composer.value?.focusPrompt();
}

async function copySelectedQuote() {
  const raw = selectedQuoteText.value;
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    selectedQuoteText.value = '';
    if (typeof window !== 'undefined' && window.getSelection) {
      window.getSelection()?.removeAllRanges();
    }
    ElMessage.success('已复制选中内容');
  } catch {
    ElMessage.error('复制选中内容失败');
  }
}

async function askCodeBlockToComposer(payload: { language: string | undefined; code: string }) {
  const next = typeof formatCodeBlockFollowUp === 'function'
    ? formatCodeBlockFollowUp(payload.language, payload.code, draft.value)
    : formatQuoteReply(payload.code, draft.value);
  draft.value = next;
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  await nextTick();
  composer.value?.focusPrompt();
}

async function askChangedFile(file: AgentChangedFile, line?: number, runWorkspace?: string) {
  const binding = props.conversation?.workspace;
  // 历史改动的相对路径以当轮目录为准，避免在新工作区引用同名文件。
  const filePath = binding && runWorkspace && runWorkspace !== binding.workspacePath && !/^(?:[/\\]|[a-z]:[/\\])/i.test(file.path)
    ? `${runWorkspace.replace(/[\\/]+$/, '')}/${file.path}` : file.path;
  const reference = formatChangedFileReference(filePath, line);
  if (!draft.value.includes(reference)) {
    draft.value = `${draft.value}${draft.value && !/\s$/.test(draft.value) ? ' ' : ''}${reference} `;
  }
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  await nextTick();
  composer.value?.focusPrompt();
}

function applyChangedFileReviewPrompt(prompt: string, runWorkspace: string) {
  const binding = props.conversation?.workspace;
  return applyPromptFromDelivery(binding && binding.workspacePath !== runWorkspace
    ? `这份批注来自该会话的历史工作区 ${runWorkspace}。以下相对路径以该目录为准。\n\n${prompt}` : prompt);
}

function toggleRunBookmark(run: AgentRun, entryIndex: number) {
  if (!props.conversation) return;
  const content = agentReplyText(run.result) || agentRunErrorText(run);
  if (!content.trim()) return;
  const added = bookmarkStore.toggleBookmark({
    conversationId: props.conversation.id,
    conversationTitle: props.conversation.title,
    messageKey: run.id,
    turnIndex: entryIndex + 1,
    content,
  });
  ElMessage.success(added ? '已加入重点收藏，可在顶部收藏夹或跨会话直接引用' : '已从重点收藏移除');
}

async function jumpToBookmarkedMessage(item: AgentMessageBookmark) {
  if (item.conversationId !== props.conversation?.id) return;
  if (conversationView.value !== 'chat') conversationView.value = 'chat';
  if (searchQuery.value) searchQuery.value = '';
  await nextTick();
  const idx = transcriptEntries.value.findIndex(entry =>
    (entry.kind === 'run' && entry.runs.some(r => r.run.id === item.messageKey))
    || entry.id === item.messageKey,
  );
  if (idx >= 0) jumpToTurn(idx);
}

function retryRun(run: AgentRun, continueOriginal = false) { emit('retry', run, continueOriginal ? undefined : composer.value?.retrySelection(run)); }

defineExpose({ focusComposer });

</script>

<template>
  <section class="conversation-pane" aria-label="Agent 会话窗口">
    <template v-if="conversation">
      <div class="conversation-masthead">
      <header class="conversation-header studio-conversation-header">
        <div class="conversation-title-copy">
          <div class="conversation-title-bar">
            <input v-if="editingTitle" ref="titleInput" v-model="titleDraft" class="conversation-title-input" maxlength="120" aria-label="修改会话标题" @keydown.enter.prevent="commitTitleEdit" @keydown.esc.prevent="cancelTitleEdit" @blur="commitTitleEdit" />
            <h1 v-else :title="`${conversation.title}（双击可直接重命名）`" class="editable-conversation-title" @dblclick="startTitleEdit">{{ conversation.title }}</h1>
            <div class="conversation-heading-row">
              <StatusPill v-if="status" v-bind="status" />
              <span class="meta-chip is-provider">{{ agentProviderLabels[conversation.latest.provider] }}</span>
              <span class="meta-chip" :title="selectedModelLabel">{{ selectedModelLabel }}</span>
              <span class="meta-chip is-mode">{{ modeLabel }} · {{ accessLabel }}</span>
            </div>
          </div>
          <AgentTranslatedText v-if="!editingTitle" class="title-translation" :source="conversation.title" compact />
        </div>
        <div class="conversation-actions">
          <slot name="header-actions" />
          <AgentTranslateToggle />
          <el-button v-if="stoppableRun && !pausedRun" link type="danger" :loading="changing === stoppableRun.id" @click="emit('stop', stoppableRun)"><CircleStop :size="14" /> 停止</el-button>
          <el-dropdown trigger="click" popper-class="studio-conversation-menu">
            <button type="button" class="studio-panel-toggle" aria-label="更多会话操作" title="更多会话操作"><Ellipsis :size="18" /></button>
            <template #dropdown><el-dropdown-menu>
              <el-dropdown-item v-if="codexDesktopUrl" @click="openCodexDesktop"><ExternalLink :size="14" />在 Codex 桌面端打开</el-dropdown-item>
              <el-dropdown-item v-if="forkSource" :disabled="!!changing" @click="emit('fork', forkSource)"><GitFork :size="14" />基于此会话新建</el-dropdown-item>
              <el-dropdown-item v-if="sideForkAvailable && forkSource" :disabled="!!changing" @click="emit('forkSide', forkSource)"><GitFork :size="14" />在侧边新建继承会话</el-dropdown-item>
              <el-dropdown-item :disabled="!!changing" @click="startTitleEdit"><Pencil :size="14" />修改标题</el-dropdown-item>
              <el-dropdown-item @click="emit('pin', conversation)"><Pin :size="14" />{{ pinned ? '取消置顶' : '置顶会话' }}</el-dropdown-item>
              <el-dropdown-item @click="emit('inspect', conversation.latest)"><Info :size="14" />会话信息</el-dropdown-item>
              <el-dropdown-item divided @click="copyConversationDigest"><Copy :size="14" />复制整场对话纪要（贴飞书/笔记）</el-dropdown-item>
              <el-dropdown-item @click="exportConversation('handoff')"><Download :size="14" />导出跨 Agent 交接简报</el-dropdown-item>
              <el-dropdown-item @click="exportConversation('markdown')"><Download :size="14" />导出 Markdown</el-dropdown-item>
              <el-dropdown-item @click="exportConversation('json')"><Download :size="14" />导出 JSON</el-dropdown-item>
              <el-dropdown-item divided :disabled="!!changing" class="studio-delete-conversation" @click="emit('remove', conversation)"><Trash2 :size="14" />删除会话</el-dropdown-item>
            </el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </header>
      <div class="conversation-toolbar" :style="workspace ? {flexWrap:'wrap'} : undefined">
        <a v-if="conversation.latest.task?.taskFlowUrl" class="context-block" :href="conversation.latest.task.taskFlowUrl"
          target="_blank" rel="noopener noreferrer">查看 TaskFlow 任务</a>
      <nav class="studio-conversation-tools" aria-label="会话视图">
        <button type="button" :class="{ active: conversationView === 'chat' }" :aria-pressed="conversationView === 'chat'" @click="conversationView = 'chat'">对话</button>
        <button type="button" :class="{ active: conversationView === 'execution' }" :aria-pressed="conversationView === 'execution'" @click="conversationView = 'execution'"><Activity :size="13" />执行记录</button>
        <button type="button" :class="{ active: conversationView === 'delivery' }" :aria-pressed="conversationView === 'delivery'" @click="conversationView = 'delivery'"><PackageCheck :size="13" />本轮交付<span class="tool-count">{{ currentFileCount }}</span></button>
      </nav>
      <div class="conversation-context" :style="workspace ? {flex:'1 1 600px',flexWrap:'wrap',height:'auto',overflow:'visible'} : undefined">
        <AgentConversationWorkspaceContext v-if="workspace" :workspace="workspace" :disabled="!!changing" @manage="emit('manageWorkspace',$event)">
          <template #execution>
            <div class="workspace-execution-context">
              <strong>当前会话执行目录</strong><small>{{workspacePath || '未绑定目录'}}<template v-if="workspaceBranch"> · {{workspaceBranch}}</template></small>
              <AgentWorkspaceSelector v-if="canChangeWorkspace" :key="conversation.id" :workspace-path="workspacePaths[0] || ''"
                :workspace-paths="workspacePaths" :workspaces="workspaceOptions || []" :disabled="workspacePickerDisabled"
                :has-active-runs="!!stoppableRun" :show-inline-tags="false" placement="bottom-start"
                :apply-selection="applyWorkspaceSelection" :browse-workspace="browseWorkspace" :binding-saved="!!conversation.workspace">
                <template #trigger><button type="button" class="context-block project-context-trigger" :disabled="workspacePickerDisabled" aria-label="调整此会话执行目录"><Folder :size="13"/><span>调整此会话执行目录</span><ChevronDown :size="12"/></button></template>
              </AgentWorkspaceSelector>
            </div>
          </template>
        </AgentConversationWorkspaceContext>
        <template v-else>
        <AgentWorkspaceSelector v-if="canChangeWorkspace" :key="conversation.id" :workspace-path="workspacePaths[0] || ''"
          :workspace-paths="workspacePaths" :workspaces="workspaceOptions || []" :disabled="workspacePickerDisabled"
          :has-active-runs="!!stoppableRun" :show-inline-tags="false" placement="bottom-start"
          :apply-selection="applyWorkspaceSelection" :browse-workspace="browseWorkspace" :binding-saved="!!conversation.workspace">
          <template #trigger>
            <button type="button" class="context-block project-context project-context-trigger" :disabled="workspacePickerDisabled"
              :aria-label="workspacePickerLabel" :title="[workspacePickerLabel, ...workspacePaths].join('\n')">
              <Folder :size="13" /><span><strong>{{ workspaceLabel }}</strong></span>
              <span v-if="workspacePaths.length > 1" class="tool-count">+{{ workspacePaths.length - 1 }}</span><ChevronDown :size="12" />
            </button>
          </template>
        </AgentWorkspaceSelector>
        <div v-else class="context-block project-context" :title="projectPath || '当前会话未绑定本地项目'"><Folder :size="13" /><span><strong>{{ workspaceLabel }}</strong></span></div>
        <div v-if="(!conversation.teamChat || conversation.teamChat.workspaceBound) && workspaceBranch" class="context-block branch-context" :title="workspaceBranch"><GitBranch :size="13" /><span><small>分支</small><strong>{{ workspaceBranch }}</strong></span></div>
        </template>
        <AgentTerminalButton v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" :workspace-path="workspacePath" />
        <AgentCursorButton v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" :workspace-path="workspacePath" />
        <el-dropdown v-if="conversationView === 'chat' && turnOutlineItems.length >= 2" trigger="click" popper-class="studio-turn-outline-popper">
          <button type="button" class="context-block turn-outline-trigger" title="对话轮次目录 · 快速跳转到任意提问轮次">
            <ListOrdered :size="12" />
            <span><strong>{{ turnOutlineItems.length }} 轮</strong></span>
            <ChevronDown :size="11" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="turn in turnOutlineItems" :key="turn.entryIndex" @click="jumpToTurn(turn.entryIndex)">
                <span class="turn-outline-num">#{{ String(turn.round).padStart(2, '0') }}</span>
                <span class="turn-outline-text">{{ turn.label }}</span>
                <small v-if="turn.changedFiles > 0" class="turn-outline-files">{{ turn.changedFiles }} 改</small>
              </el-dropdown-item>
              <el-dropdown-item divided @click="jumpToTop"><ArrowUp :size="13" /><span>回到首轮顶部</span></el-dropdown-item>
              <el-dropdown-item @click="jumpToLatest"><ArrowDown :size="13" /><span>跳至最新消息</span></el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <span v-else-if="conversationView === 'chat' && turnOutlineItems.length === 1" class="context-block turn-count-pill" title="当前会话共 1 轮对话">
          <ListOrdered :size="12" /><span><strong>1 轮</strong></span>
        </span>
        <el-popover v-if="bookmarkStore.bookmarks.value.length > 0" trigger="click" :width="368" placement="bottom-start" popper-class="studio-bookmark-popper">
          <template #reference>
            <button type="button" class="context-block turn-outline-trigger is-bookmark-trigger" title="重点收藏夹 · 快速定位本会话或跨会话复用已收藏的关键回复">
              <Bookmark :size="12" />
              <span><strong>收藏 · {{ bookmarkStore.bookmarks.value.length }}</strong></span>
            </button>
          </template>
          <div class="bookmark-popover-body">
            <div class="bookmark-popover-head">
              <strong>重点消息收藏夹</strong>
              <small>共 {{ bookmarkStore.bookmarks.value.length }} 条</small>
            </div>
            <input v-if="bookmarkStore.bookmarks.value.length > 3" v-model="bookmarkFilter" type="search" class="bookmark-filter-input" placeholder="搜收藏内容、命令或会话名…" />
            <div v-if="currentSessionBookmarks.length" class="bookmark-group">
              <header>当前会话（点击定位轮次）</header>
              <div v-for="item in currentSessionBookmarks" :key="item.id" class="bookmark-row">
                <button type="button" class="bookmark-main-btn" @click="jumpToBookmarkedMessage(item)">
                  <span v-if="item.turnIndex" class="bookmark-turn-badge">#{{ String(item.turnIndex).padStart(2, '0') }}</span>
                  <span class="bookmark-excerpt">{{ item.excerpt }}</span>
                </button>
                <div class="bookmark-row-actions">
                  <button v-if="!pausedRun" type="button" title="引用到当前输入框" @click="quoteTextToComposer(item.content)"><Quote :size="11" /></button>
                  <button type="button" title="复制完整内容" @click="copyMessage(`bm:${item.id}`, item.content)"><Check v-if="copiedMessageId === `bm:${item.id}`" :size="11" /><Copy v-else :size="11" /></button>
                  <button type="button" class="is-remove" title="取消收藏" @click="bookmarkStore.removeBookmark(item.id)"><Trash2 :size="11" /></button>
                </div>
              </div>
            </div>
            <div v-if="otherSessionBookmarks.length" class="bookmark-group">
              <header>其他会话（可跨会话直接引用或复制）</header>
              <div v-for="item in otherSessionBookmarks" :key="item.id" class="bookmark-row is-cross">
                <div class="bookmark-cross-info">
                  <small>{{ item.conversationTitle }}</small>
                  <span class="bookmark-excerpt">{{ item.excerpt }}</span>
                </div>
                <div class="bookmark-row-actions">
                  <button v-if="!pausedRun" type="button" title="跨会话引用到当前输入框" @click="quoteTextToComposer(item.content)"><Quote :size="11" /></button>
                  <button type="button" title="复制完整内容" @click="copyMessage(`bm:${item.id}`, item.content)"><Check v-if="copiedMessageId === `bm:${item.id}`" :size="11" /><Copy v-else :size="11" /></button>
                  <button type="button" class="is-remove" title="取消收藏" @click="bookmarkStore.removeBookmark(item.id)"><Trash2 :size="11" /></button>
                </div>
              </div>
            </div>
            <p v-if="!filteredBookmarks.length" class="bookmark-empty">没有匹配的收藏内容</p>
          </div>
        </el-popover>
        <label class="message-search" :class="{ 'has-query': Boolean(searchQuery.trim()) }">
          <Search :size="12" />
          <input v-model="searchQuery" type="search" placeholder="搜索对话内容…" @keydown.esc="searchQuery = ''" @keydown.enter.prevent="stepSearchTurn($event.shiftKey ? -1 : 1)" />
          <span v-if="searchQuery.trim()" class="message-search-counter" :title="`共匹配 ${transcriptEntries.length} 轮对话 · ${searchHitTotal} 处关键词（回车跳下一轮，Shift+回车上一轮）`">
            {{ transcriptEntries.length ? `${Math.min(activeSearchTurnIndex + 1, transcriptEntries.length)}/${transcriptEntries.length}` : '0' }}<template v-if="searchHitTotal > transcriptEntries.length"> · {{ searchHitTotal }}处</template>
          </span>
          <button v-if="searchQuery.trim() && transcriptEntries.length > 1" type="button" class="message-search-step" aria-label="上一处匹配轮次" title="上一处匹配轮次 (Shift+Enter)" @click.prevent="stepSearchTurn(-1)"><ArrowUp :size="11" /></button>
          <button v-if="searchQuery.trim() && transcriptEntries.length > 1" type="button" class="message-search-step" aria-label="下一处匹配轮次" title="下一处匹配轮次 (Enter)" @click.prevent="stepSearchTurn(1)"><ArrowDown :size="11" /></button>
          <button v-if="searchQuery" type="button" class="message-search-clear" aria-label="清空搜索" title="清空搜索 (Esc)" @click.prevent="searchQuery = ''"><X :size="11" /></button>
        </label>
      </div>
      <div v-if="jiraTask" class="conversation-jira-task" aria-label="关联 Jira 研发任务">
        <span class="conversation-workflow-pill" :data-workflow="jiraTask.workflow">{{ jiraTask.workflow === 'requirement' ? '需求开发' : 'Jira 修复' }}</span>
        <a v-if="jiraTaskIssue?.url" class="conversation-issue-pill" :href="jiraTaskIssue.url" target="_blank" rel="noreferrer">{{ jiraTaskIssue.key }}</a>
        <span v-else-if="jiraTaskIssue" class="conversation-issue-pill">{{ jiraTaskIssue.key }}</span>
        <span v-for="project in jiraTaskProjects" :key="`${project.path}:${project.branchName}`" class="conversation-repo-pill" :title="project.workspacePath || project.path"><GitBranch :size="12" />{{ project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path }} · {{ project.branchName }}</span>
        <div class="conversation-jira-links">
          <router-link :to="{ path: '/agent', query: { view: jiraTask.workflow === 'jira' ? 'jira-fix' : 'design', tab: 'records', taskId: jiraTask.taskId } }">返回任务与交接</router-link>
          <button v-if="jiraTask.launch?.groupRoomId" type="button" class="jira-group-link" @click="emit('openGroup', jiraTask.launch.groupRoomId)">打开团队群聊</button>
        </div>
      </div>
      </div>
      </div>
      <div class="conversation-reading">
      <AgentExecutionPanel v-if="openedExecution" v-show="conversationView === 'execution'" :visible="visible !== false && conversationView === 'execution'" class="studio-main-execution" :conversation="conversation" :team-room="teamRoom" :team-task="currentTeamTask" @inspect="emit('inspect', $event)" />
      <section v-if="conversationView === 'delivery'" class="studio-main-delivery" aria-label="本轮交付成果">
        <div v-if="codePaths.length || currentFileDeliveries.length" class="delivery-pipeline-bar" aria-label="一站式研发交付流转入口">
          <span class="delivery-pipeline-label">交付流转：</span>
          <RouterLink class="delivery-pipeline-link" :to="{ path: '/agent', query: { view: 'projects' } }">1. 项目 Git 提交与推送</RouterLink>
          <span class="delivery-pipeline-sep">→</span>
          <RouterLink class="delivery-pipeline-link" :to="{ path: '/agent', query: { view: 'queue' } }">2. 交付队列与合并请求</RouterLink>
          <span class="delivery-pipeline-sep">→</span>
          <RouterLink class="delivery-pipeline-link" :to="{ path: '/agent', query: { view: 'deployments' } }">3. 环境部署与验证</RouterLink>
        </div>
        <AgentWorkspaceCodeArtifacts v-if="codePaths.length || !jiraTask" :paths="codePaths" :bound="Boolean(conversation.workspace)" :conversation-id="jiraTask ? undefined : conversation.id" :active="visible" :run-key="conversation.latest.id" :run-state="conversation.latest.status" />
        <AgentRemoteDelivery v-if="jiraTask" :key="jiraDevTaskDeliveryId(jiraTask)" :target-id="jiraDevTaskDeliveryId(jiraTask)" :active="visible !== false && conversationView === 'delivery'" />
        <AgentConversationDeliveryBrief :conversation="conversation" :paused="!!pausedRun" @ask-test="applyPromptFromDelivery" />
        <h2>本轮交付</h2>
        <AgentChangedFiles v-for="item in currentFileDeliveries" :key="item.run.id" :files="item.run.changedFiles!" :run-id="item.run.id" :can-ask="!pausedRun" @ask-file="(file, line) => askChangedFile(file, line, item.run.workspacePath)" @apply-review-prompt="applyChangedFileReviewPrompt($event, item.run.workspacePath)" />
        <el-empty v-if="!currentFileDeliveries.length && !jiraTask" description="本轮暂无记录的改动文件" :image-size="56" />
        <details v-if="historicalFileDeliveries.length" class="delivery-file-history">
          <summary>历史文件</summary>
          <section v-for="item in historicalFileDeliveries" :key="item.run.id">
            <h3>第 {{ item.round }} 轮 · {{ dateTime(item.run.updatedAt) }}</h3>
            <AgentChangedFiles :files="item.run.changedFiles!" :run-id="item.run.id" :can-ask="!pausedRun" @ask-file="(file, line) => askChangedFile(file, line, item.run.workspacePath)" @apply-review-prompt="applyChangedFileReviewPrompt($event, item.run.workspacePath)" />
          </section>
        </details>
      </section>
      <div v-show="conversationView === 'chat'" ref="messageViewport" class="message-viewport" aria-live="polite" @scroll.passive="rememberScroll" @mouseup="captureViewportSelection" @keyup="captureViewportSelection">
        <div class="message-list">
          <div v-if="olderHistory" class="history-loading">
            <el-button link :loading="loadingOlder" @click="loadOlderHistory">加载更早的会话记录</el-button>
          </div>
          <template v-for="(entry, entryIndex) in transcriptEntries" :key="entry.id">
          <div v-if="entry.kind === 'run'" :data-turn-index="entryIndex" class="message-turn" :class="{ 'is-settled-turn': !searchQuery && entryIndex < transcriptEntries.length - 2 && entry.runs.every(item => !['running', 'queued'].includes(item.run.status) && !item.run.pausedForEdit) }">
            <template v-for="{ run, id } in entry.runs" :key="id">
            <article v-if="!legacyContinuations.has(run.id)" class="chat-message user-message"><AgentAvatar user class="message-avatar" /><div class="user-turn-stack"><div class="message-card user-card"><header class="user-card-header"><strong>你</strong><time>{{ dateTime(run.createdAt) }}</time></header><div v-if="run.attachments?.length" class="message-images"><a v-for="attachment in run.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" loading="lazy" decoding="async" /><span v-else class="message-file"><File :size="20" /></span><span>{{ attachment.name }}</span></a></div>
              <p v-if="taskPromptTitles.has(id)">{{ taskPromptTitles.get(id) }}</p>
              <AgentTranslatedText v-else :source="run.objective" replace><AgentMessageText :source="run.objective" :knowledge-context="run.knowledgeContext" :search-query="searchQuery" /></AgentTranslatedText>
            </div>
              <div class="message-tools user-message-tools" :class="{ 'is-pinned': taskPromptTitles.has(id) || !!run.revisesRunId }">
                <button v-if="taskPromptTitles.has(id)" type="button" class="event-link" aria-haspopup="dialog" @click="taskPromptDetail = run.objective">查看完整提示词</button>
                <button v-if="conversation.source !== 'codex' && (run.pausedForEdit || (!pausedRun && (run.status === 'running' || run.id === conversation.latest.id && ['queued', 'cancelled', 'interrupted', 'failed'].includes(run.status))))"
                  type="button" class="event-link" :disabled="!!changing" @click="emit('edit', run)"><Pencil :size="11" /> {{ ['running', 'queued'].includes(run.status) ? '暂停并编辑' : '编辑' }}</button>
                <span v-if="run.revisesRunId" class="event-link">已修订</span>
                <button v-if="forkSource && run.status === 'completed' && run.provider === 'codex' && run.codexTurnId"
                  type="button" class="event-link" :disabled="!!changing"
                  title="继承当前会话已完成的上下文，原会话保留不变"
                  @click="emit('fork', forkSource)"><GitFork :size="11" /> 分叉</button>
                <button type="button" class="message-copy" title="复制消息" @click="copyMessage(`user:${run.id}`, run.objective)"><Check v-if="copiedMessageId === `user:${run.id}`" :size="12" /><Copy v-else :size="12" /></button>
              </div></div></article>
            <article v-for="supplement in run.supplements || []" :key="supplement.id" class="chat-message user-message">
              <AgentAvatar user class="message-avatar" /><div class="user-turn-stack"><div class="message-card user-card"><header class="user-card-header"><strong>你 · 补充</strong><time>{{ dateTime(supplement.createdAt) }}</time></header>
                <div v-if="supplement.attachments.length" class="message-images"><a v-for="attachment in supplement.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" loading="lazy" decoding="async" /><span v-else class="message-file"><File :size="20" /></span><span>{{ attachment.name }}</span></a></div><AgentTranslatedText :source="supplement.objective" replace><AgentMessageText :source="supplement.objective" :knowledge-context="supplement.knowledgeContext" :search-query="searchQuery" /></AgentTranslatedText>
              </div></div>
            </article>
            <article class="chat-message agent-message"><AgentAvatar :provider="run.provider" :model="run.model" class="message-avatar" /><div class="message-card agent-card"><header><strong>{{ run.provider === 'codex' ? 'GPT / Codex' : run.provider === 'claude' ? 'Claude Code' : run.provider === 'kiro' ? 'Kiro CLI' : run.provider === 'antigravity' ? 'Antigravity CLI' : run.provider === 'api' ? '模型 API' : run.provider === 'deepseek' ? 'DeepSeek（官方 API）' : run.provider === 'workbuddy' ? '腾讯 WorkBuddy' : run.provider === 'grok' ? 'Grok（xAI）' : 'Cursor Agent' }}</strong><small class="message-model">{{ run.model || 'CLI 默认' }}</small><StatusPill v-bind="agentRunStatus(run)" /><small v-if="legacyContinuations.has(run.id)" class="continuation-label" title="沿用上一轮的 Codex 会话">续跑</small><time>{{ dateTime(run.updatedAt) }}</time></header><AgentLiveRunActivity :run="run" @inspect="emit('inspect', run)" /><AgentTranslatedText v-if="run.result" :source="agentReplyText(run.result)" :stable="!['queued', 'running'].includes(run.status)" markdown replace><AgentMarkdown class="agent-result" :source="agentReplyText(run.result)" :can-ask-code="!pausedRun && conversation.source !== 'codex'" @ask-code="askCodeBlockToComposer" /></AgentTranslatedText><AgentPlanChecklistCard v-if="run.status === 'completed' && run.result" :run="run" :reply-text="agentReplyText(run.result)" :can-apply-prompt="!pausedRun && conversation.source !== 'codex'" @apply-prompt="applyPromptFromDelivery" /><AgentTranslatedText v-if="run.error" :source="agentRunErrorText(run)" replace><p class="agent-error">{{ agentRunErrorText(run) }}</p></AgentTranslatedText><AgentFailureRcaCard v-if="run.status === 'failed' || run.status === 'interrupted'" :run="run" compact :can-apply-prompt="!pausedRun && conversation.source !== 'codex'" @apply-prompt="applyPromptFromDelivery" /><template v-else-if="!run.result && !['queued', 'running'].includes(run.status) && !run.events.length"><p class="agent-progress">该轮没有保存最终回复</p></template><AgentChangedFiles v-if="run.changedFiles" :files="run.changedFiles" :run-id="run.id" :can-ask="!pausedRun" @ask-file="(file, line) => askChangedFile(file, line, run.workspacePath)" @apply-review-prompt="applyChangedFileReviewPrompt($event, run.workspacePath)" /><div class="message-tools"><button v-if="run.result || run.error" type="button" class="event-link copy-md-link" title="复制 Markdown 原文" @click="copyMessage(`agent:${run.id}`, agentReplyText(run.result) || agentRunErrorText(run))"><Check v-if="copiedMessageId === `agent:${run.id}`" :size="12" /><Copy v-else :size="12" /> {{ copiedMessageId === `agent:${run.id}` ? '已复制' : '复制' }}</button><button v-if="run.result" type="button" class="event-link" title="去除 Markdown 格式复制纯文本（适合粘贴至企微或 Jira）" @click="copyMessage(`plain:${run.id}`, stripMarkdownPlain(agentReplyText(run.result)))"><Check v-if="copiedMessageId === `plain:${run.id}`" :size="12" /><FileText v-else :size="12" /> {{ copiedMessageId === `plain:${run.id}` ? '已复制纯文本' : '纯文本' }}</button><button v-if="!pausedRun && (run.result || run.error)" type="button" class="event-link" title="将该回复作为引用块填入输入框继续追问" @click="quoteTextToComposer(agentReplyText(run.result) || agentRunErrorText(run))"><Quote :size="12" /> 引用</button><button v-if="run.result || run.error" type="button" class="event-link" :class="{ 'is-bookmarked': bookmarkStore.isBookmarked(conversation.id, run.id) }" :title="bookmarkStore.isBookmarked(conversation.id, run.id) ? '取消重点收藏' : '收藏这条关键回复（可在顶部收藏夹或跨会话随时复用）'" @click="toggleRunBookmark(run, entryIndex)"><Bookmark :size="12" /> {{ bookmarkStore.isBookmarked(conversation.id, run.id) ? '已收藏' : '收藏' }}</button><PluginRecordQuickSave v-if="run.result" :title="run.objective" :content="agentReplyText(run.result)" /><button v-if="canSteerAgentRun(run, activeRun, conversation.runs)" type="button" class="event-link" :disabled="!!changing" title="停止当前轮，并提前执行此消息" @click="emit('steer', run)"><CornerUpLeft :size="12" /> 调整方向</button><button v-if="conversation.source !== 'codex' && run.status === 'queued' && run.parentRunId" type="button" class="event-link danger-link" :disabled="!!changing" title="从当前会话删除这条排队消息" @click="emit('removeQueued', run)"><Trash2 :size="12" /> {{ changing === `delete:${run.id}` ? '删除中' : '删除' }}</button><button v-if="!pausedRun && continuableRun?.id === run.id" type="button" class="event-link" :disabled="!!changing" title="在原轮次继续，沿用已保存的会话和权限" @click="retryRun(run, true)"><Play :size="12" /> 继续执行</button>
              <button v-else-if="isRestartableAgentRun(run) && !pausedRun && !canContinueStoppedCodexRun(run)" type="button" class="event-link" :disabled="!!changing" :title="isRetryableSessionBusyRun(run) ? '尝试续接原会话；真实运行中的任务不会被中断' : '从已保存状态重新执行该任务'" @click="retryRun(run)"><RotateCcw :size="12" /> 重新执行</button><button v-if="run.events.length" type="button" class="event-link" @click="emit('inspect', run)">{{ run.events.length }} 条运行事件</button></div></div></article>
            </template>
          </div>
          <article v-else :data-turn-index="entryIndex" class="chat-message team-chat-message" :class="[entry.message.role === 'user' ? 'user-message' : 'agent-message', { 'is-settled-turn': !searchQuery && entryIndex < transcriptEntries.length - 2 && !entry.pendingInput }]" :data-message-id="entry.id">
            <AgentAvatar :user="entry.message.role === 'user'" :provider="entry.identity?.provider" :model="entry.identity?.model" class="message-avatar" />
            <div class="message-card"><header><strong>{{ teamChatParticipant(entry.message) }}</strong><small v-if="entry.identity" class="message-model">{{ agentProviderLabels[entry.identity.provider] }} · {{ entry.identity.model || 'CLI 默认' }}</small><small v-if="entry.message.kind === 'handoff'">交接</small><small v-else-if="entry.message.kind === 'question'">问题</small><time>{{ dateTime(entry.message.createdAt) }}</time></header>
              <div v-if="entry.message.attachmentIds?.length" class="message-images"><a v-for="id in entry.message.attachmentIds" :key="id" :href="chatAttachment(id)?.url || `/api/agent-runtimes/attachments/${encodeURIComponent(id)}`" target="_blank" rel="noopener"><img v-if="chatAttachment(id) && isAgentImageAttachment(chatAttachment(id)!)" :src="chatAttachment(id)!.url" :alt="chatAttachment(id)!.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ chatAttachment(id)?.name || '附件' }}</span></a></div>
              <AgentMarkdown v-if="entry.message.role === 'assistant'" class="agent-result" :source="entry.message.text" :can-ask-code="!pausedRun && conversation.source !== 'codex'" @ask-code="askCodeBlockToComposer" />
              <template v-else-if="taskPromptTitles.has(entry.id)">
                <p>{{ taskPromptTitles.get(entry.id) }}</p>
                <div class="message-tools user-message-tools"><button type="button" class="event-link" aria-haspopup="dialog" @click="taskPromptDetail = entry.message.text">查看完整提示词</button></div>
              </template>
              <AgentMessageText v-else :source="entry.message.text" :search-query="searchQuery" />
              <AgentTeamQuestion v-if="entry.questionState" :key="entry.id" :state="entry.questionState" :selected="questionTarget?.questionId === entry.id && questionTarget?.taskId === entry.taskId" :changing="changing" @reply="replyToQuestion({ taskId: entry.taskId, questionId: entry.id })" />
              <small v-if="entry.pendingInput" class="agent-progress">已收到，等待负责人处理</small>
              <small v-if="entry.message.replyTo" class="agent-progress">对问题的回复</small>
            </div>
          </article>
          <article v-if="entry.kind === 'team' && entry.pendingInput" class="chat-message agent-message optimistic-team-ack" role="status">
            <AgentAvatar provider="codex" class="message-avatar" />
            <div class="message-card agent-card">
              <header><strong>任务助手</strong><StatusPill value="running" label="正在响应" /></header>
              <p class="agent-progress">已收到你的消息，正在唤醒任务协调器并分配执行步骤…</p>
            </div>
          </article>
          </template>
          <section v-if="teamResultVisible && currentTeamTask && !searchQuery && (!hasTeamDeliveryMessage || teamResultDownloads.length)" class="team-result-state" aria-label="任务结果">
            <div class="team-result-heading"><div><small>本轮已完成</small><strong>{{ hasTeamDeliveryMessage ? '交付文件' : '结果' }}</strong></div><el-button link class="team-progress-link" @click="conversationView = 'execution'">查看执行记录<ChevronRight :size="14" /></el-button></div>
            <p v-if="!hasTeamDeliveryMessage">{{ teamResultSummary }}</p>
            <div v-if="teamResultDownloads.length" class="team-result-downloads">
              <a v-for="file in teamResultDownloads" :key="file.key" :href="file.url" :download="file.name"><Download :size="15" /><span><small>交付文件</small>{{ file.name }}</span></a>
            </div>
          </section>
          <section v-if="teamProgressVisible && currentTeamTask && !searchQuery && !teamResultVisible" class="team-chat-state" :class="{ 'is-active': ['planning', 'running'].includes(currentTeamTask.state) }" aria-label="团队协作进度">
            <div class="team-chat-status"><span v-if="['planning', 'running'].includes(currentTeamTask.state)" class="team-live-dot" aria-hidden="true"></span><p role="status">{{ teamActivity }}</p><el-button v-if="currentTeamTask.nodes.length" link class="team-progress-link" @click="conversationView = 'execution'">查看协作进展<ChevronRight :size="14" /></el-button></div>
            <p v-if="currentTeamTask.reason && currentTeamTask.reason !== teamActivity && ['blocked','needs_decision','needs_reconciliation'].includes(currentTeamTask.state)">{{ currentTeamTask.reason }}</p>
            <div class="team-chat-decisions">
              <el-button v-if="!currentTeamTask.chat?.workspaceBound && ['awaiting_plan','waiting_input','blocked'].includes(currentTeamTask.state)" :disabled="!!changing" @click="emit('chooseTeamWorkspace')">选择项目</el-button>
              <el-button v-if="currentTeamTask.chat?.coordination?.phase === 'paused'" type="primary" :disabled="!!changing" @click="emit('teamCommand','继续执行')">继续执行</el-button>
              <el-button v-else-if="['blocked','needs_decision','needs_reconciliation'].includes(currentTeamTask.state) && currentTeamTask.chat?.coordination?.phase !== 'stopping'" type="primary" :disabled="!!changing" @click="emit('teamDecision','ask_leader')">请负责人继续处理</el-button>
              <details v-if="teamChatActiveStates.has(currentTeamTask.state) && (!['planning','running'].includes(currentTeamTask.state) || currentTeamTask.chat?.coordination?.phase === 'paused')" class="team-more-actions"><summary>更多操作</summary><div class="team-chat-decisions">
                <el-button v-if="['blocked','needs_decision','needs_reconciliation'].includes(currentTeamTask.state)" :disabled="!!changing" @click="emit('teamDecision','retry')">重试</el-button>
                <el-button v-if="canRetryTeamReviewWithCodex(currentTeamTask)" :disabled="!!changing" @click="emit('teamDecision','retry_review_codex')">改用 Codex 审查</el-button>
                <el-button v-if="currentTeamTask.state === 'needs_decision'" :disabled="!!changing" @click="emit('teamDecision','escalate')">升级模型再试</el-button>
                <el-button v-if="currentTeamTask.candidate?.integration.conflicts.length" :disabled="!!changing" @click="emit('teamDecision','resolve_conflicts')">由负责人处理冲突</el-button>
                <el-button :disabled="!!changing" @click="emit('teamDecision','takeover')">我来接手</el-button><el-button :disabled="!!changing" @click="emit('teamDecision','cancel')">取消任务</el-button>
              </div></details>
            </div>
            <AgentChangedFiles v-for="item in currentFileDeliveries" :key="item.run.id" :files="item.run.changedFiles!" :run-id="item.run.id" :can-ask="!pausedRun" @ask-file="(file, line) => askChangedFile(file, line, item.run.workspacePath)" @apply-review-prompt="applyChangedFileReviewPrompt($event, item.run.workspacePath)" />
          </section>
          <div v-if="!conversation.loaded" class="history-loading">
            <el-button v-if="historyError" link @click="retryHistory?.()">重新读取会话</el-button>
            <el-skeleton v-else :rows="2" animated />
          </div>
          <el-empty v-if="searchQuery && !visibleEntries.length" description="当前会话没有匹配内容" :image-size="56" />
        </div>
      </div>
      <button v-if="awayFromLatest && conversationView === 'chat' && !searchQuery" type="button" class="jump-to-latest" :class="{ 'is-behind-selection': !pausedRun && !!selectedQuoteText }" @click="jumpToLatest"><ArrowDown :size="14" /> 最新消息</button>
      <div class="selection-quote-anchor">
      <Transition name="selection-quote">
      <div v-if="!pausedRun && selectedQuoteText && conversationView === 'chat'" class="selection-quote-bar" role="region" aria-label="划词快捷操作">
        <Quote :size="13" class="selection-quote-icon" />
        <span class="selection-quote-preview">已选中 {{ selectedQuoteText.length }} 字：“{{ selectedQuoteText.slice(0, 48) }}{{ selectedQuoteText.length > 48 ? '…' : '' }}”</span>
        <div class="selection-quote-actions">
          <button v-if="selectionLooksLikeError" type="button" class="selection-quote-btn is-error-fix" title="把选中报错带入输入框并让 AI 定位根因与修复" @click="applySelectionAction('fix-error')">排查报错</button>
          <button type="button" class="selection-quote-btn" :class="{ 'is-secondary': selectionLooksLikeError }" title="仅作为引用块带入输入框自由追问" @click="applySelectionAction('quote')">引用追问</button>
          <button type="button" class="selection-quote-chip" title="让 AI 用通俗易懂的大白话解释这段内容" @click="applySelectionAction('explain')">通俗解释</button>
          <button v-if="!selectionLooksLikeError" type="button" class="selection-quote-chip" title="若这是异常信息，让 AI 直接排查原因并给修复方案" @click="applySelectionAction('fix-error')">排查报错</button>
          <button v-if="selectedQuoteText.length >= 24" type="button" class="selection-quote-chip" title="让 AI 提炼这段内容的核心要点与待办事项" @click="applySelectionAction('summarize')">提炼要点</button>
          <button v-if="canBringToMain" type="button" class="selection-quote-chip" @click="emit('bringToMain', selectedQuoteText); selectedQuoteText = ''">带回主会话</button>
          <button type="button" class="selection-quote-chip" title="复制选中文字" @click="copySelectedQuote">复制</button>
        </div>
        <button type="button" class="selection-quote-close" aria-label="关闭划词快捷提示" @click="selectedQuoteText = ''"><X :size="12" /></button>
      </div>
      </Transition>
      </div>
      <AgentComposer v-model:automatic="effectiveAutomatic" v-if="!pausedRun" ref="composer" v-model="draft" v-model:attachments="attachments" :conversation="conversation" :runtimes="runtimes" :automatic-access-mode="nextAccessMode" :changing="changing" :running="running" :can-insert="!!activeRun?.liveInputReady"
        :business-options="businessOptions" :attachment-draft="attachmentDraft" :question-reply="questionReply" :stopping="(effectiveAutomatic || !stoppableRun) && currentTeamTask?.chat?.coordination?.phase === 'stopping'"
        @send="sendFromComposer" @cancel-reply="cancelQuestionReply" @access-change="nextAccessMode = $event; emit('accessChange', $event)" @stop="(effectiveAutomatic || !stoppableRun) && currentTeamTask && teamChatActiveStates.has(currentTeamTask.state) ? emit('teamCommand', '暂停任务') : stoppableRun && emit('stop', stoppableRun)" @configure-models="emit('configureModels')" @provider-change="emit('providerChange', $event)" />
      <div v-if="pausedRun" class="paused-editor">
        <span>{{ pausedRun.resumeAfterWorkspaceRestart ? '等待工作台重启后续跑' : '会话已暂停' }}</span>
        <el-button v-if="!pausedRun.resumeAfterWorkspaceRestart" :type="continuableRun?.id === pausedRun.id ? 'default' : 'primary'" :disabled="!!changing" @click="emit('edit', pausedRun)"><Pencil :size="14" /> 编辑消息</el-button>
        <el-button v-if="continuableRun?.id === pausedRun.id" type="primary" :loading="changing === `retry:${pausedRun.id}`" :disabled="!!changing" @click="retryRun(pausedRun, true)"><Play :size="14" /> 继续执行</el-button>
      </div>
      </div>
    </template>
    <template v-else><header class="conversation-header studio-conversation-header"><div class="conversation-title-copy"></div><slot name="header-actions" /></header><el-empty description="选择左侧会话，或新建一个 Agent 会话" :image-size="70" /></template>
    <AgentTaskPromptDrawer v-if="taskPromptDetail !== undefined" v-model="taskPromptDetail" />
  </section>
</template>

<style scoped>
.workspace-execution-context{display:grid;gap:6px;padding-top:10px;font-size:12px}.workspace-execution-context small{color:var(--ui-muted);font-size:11px;overflow-wrap:anywhere}.workspace-execution-context .project-context-trigger{justify-self:start;width:max-content;max-width:100%;cursor:pointer}

.jump-to-latest{align-self:center;position:relative;margin:-36px 0 8px;z-index:2;display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-sm,999px);background:var(--ui-surface);color:var(--ui-text);box-shadow:var(--ui-shadow);font:600 12px/18px var(--sans);cursor:pointer}
.jump-to-latest:hover{color:var(--ui-accent);border-color:var(--ui-accent)}
.team-more-actions{font-size:12px;color:var(--ui-muted)}.team-more-actions summary{cursor:pointer;line-height:32px}.team-more-actions .team-chat-decisions{margin-top:4px}
.team-result-downloads{display:grid;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--ui-border)}.team-result-downloads a{display:flex;align-items:center;gap:8px;max-width:100%;padding:8px 12px;border:1px solid color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));border-radius:var(--ds-radius-sm,8px);background:var(--ui-accent-soft);color:var(--ui-accent);overflow-wrap:anywhere;text-decoration:none;transition:border-color 220ms cubic-bezier(0.22,1,0.36,1),background 220ms cubic-bezier(0.22,1,0.36,1)}.team-result-downloads a:hover{border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 16%,var(--ui-surface))}.team-result-downloads a>span{display:grid;gap:2px;min-width:0}.team-result-downloads small{color:var(--ui-muted);font-size:12px;line-height:16px}.team-result-downloads svg{flex-shrink:0}
.chat-message header{flex-wrap:wrap;row-gap:3px}.message-model{padding:0 5px;border:0;border-radius:4px;background:transparent;font:500 11px/16px var(--mono);color:var(--ui-muted);overflow-wrap:anywhere}
.continuation-label{color:var(--ui-accent);font-size:11px;line-height:16px;white-space:nowrap}
.conversation-title-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0}
.conversation-heading-row{display:inline-flex;align-items:center;flex-wrap:wrap;gap:5px;margin-bottom:0;min-width:0}
.editable-conversation-title{cursor:text;border-radius:5px;transition:background 140ms ease}
.editable-conversation-title:hover{background:color-mix(in srgb,var(--ui-accent-soft) 45%,transparent)}
.conversation-title-input{width:min(100%,460px);height:26px;padding:0 8px;border:1px solid var(--ui-accent);border-radius:var(--ds-radius-xs,5px);background:var(--ui-raised);color:var(--ui-text);font:600 13.5px/20px var(--sans);outline:none}
.conversation-zone-tag{font:700 9.5px/1 var(--mono);letter-spacing:0.12em;text-transform:uppercase;color:var(--ui-accent)}
.meta-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px solid color-mix(in srgb,var(--ui-border) 80%,transparent);border-radius:var(--ds-radius-xs,5px);background:var(--ui-raised);color:var(--ui-muted);font:500 11px/1 var(--mono);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta-chip.is-provider{border-color:color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}
.tool-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:15px;padding:0 4px;border-radius:var(--ds-radius-xs,999px);background:var(--ui-accent-soft);color:var(--ui-accent);font:600 10px/1 var(--mono)}
.role-kicker{font:700 9.5px/1 var(--mono);letter-spacing:0.14em;color:var(--ui-accent)}
.conversation-toolbar{display:contents}
.project-context-trigger{cursor:pointer}
.project-context-trigger svg{flex-shrink:0}
.project-context-trigger:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-accent)}
.project-context-trigger:disabled{opacity:.6;cursor:not-allowed}
.conversation-jira-task{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 20px;border-bottom:1px solid var(--ui-border);background:color-mix(in srgb,var(--ui-accent-soft) 35%,var(--ui-surface));color:var(--ui-secondary);font-size:12px;line-height:16px}
.conversation-workflow-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--ds-radius-xs,999px);background:var(--ui-accent);color:var(--ui-on-primary,#fff);font-size:11px;font-weight:600;white-space:nowrap}
.conversation-issue-pill{display:inline-flex;align-items:center;padding:2px 8px;border:1px solid color-mix(in srgb,var(--ui-accent) 32%,var(--ui-border));border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface);color:var(--ui-accent);font:600 11px/16px var(--mono);text-decoration:none;white-space:nowrap}
.conversation-repo-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface);color:var(--ui-text);font:11px/16px var(--mono);white-space:nowrap}
.conversation-jira-links{display:inline-flex;align-items:center;gap:10px;margin-left:auto}
.conversation-jira-task a{color:var(--ui-accent);text-decoration:none;font-weight:500}
.conversation-jira-task a:hover{text-decoration:underline}
.jira-group-link{padding:3px 9px;border:1px solid color-mix(in srgb,var(--ui-accent) 34%,var(--ui-border));border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface);color:var(--ui-accent);font:500 12px/16px var(--sans);cursor:pointer}
.jira-group-link:hover{border-color:var(--ui-accent);background:var(--ui-accent-soft)}
.studio-main-delivery{flex:1;min-height:0;overflow-y:auto;padding:24px clamp(20px,3vw,40px)}
.delivery-pipeline-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:10px 14px;margin-bottom:16px;border:1px solid color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));border-radius:var(--ds-radius-sm,8px);background:color-mix(in srgb,var(--ui-accent-soft) 40%,var(--ui-surface));font-size:12px;line-height:18px}
.delivery-pipeline-label{font:600 11px/16px var(--mono);color:var(--ui-muted)}
.delivery-pipeline-link{padding:2px 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface);color:var(--ui-accent);font-weight:500;text-decoration:none;transition:border-color 160ms ease,background 160ms ease}
.delivery-pipeline-link:hover{border-color:var(--ui-accent);background:var(--ui-accent-soft)}
.delivery-pipeline-sep{color:var(--ui-muted);font-family:var(--mono)}
.is-settled-turn{content-visibility:auto;contain-intrinsic-size:auto 220px}
.studio-main-delivery:deep(.remote-delivery){margin-bottom:16px;padding:12px 0;border-bottom:1px solid var(--ui-border)}
.delivery-file-history{margin-top:24px;color:var(--ui-muted);font-size:14px;line-height:20px}.delivery-file-history>summary{cursor:pointer}.delivery-file-history h3{margin:20px 0 0;font-size:12px;line-height:16px;font-weight:500}
.team-chat-state :deep(.changed-file-open code){white-space:normal;overflow-wrap:anywhere}
.team-result-state{margin:16px 0 12px;padding:16px;border:1px solid color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));border-radius:var(--ds-radius,12px);background:var(--ui-surface);font-size:14px;line-height:20px;color:var(--ui-secondary);box-shadow:var(--ds-shadow)}.team-result-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.team-result-heading>div{display:grid;gap:4px}.team-result-heading small{color:var(--ui-accent);font:500 12px/16px var(--mono)}.team-result-heading strong{font-size:16px;line-height:24px;font-weight:600;color:var(--ui-text)}.team-result-state>p{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:22px}.team-chat-status{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px}.team-progress-link{gap:4px;font-size:12px;color:var(--ui-muted)}.team-progress-link:hover{color:var(--ui-accent)}.team-chat-decisions:empty{display:none}
.team-chat-state{margin-top:4px;padding:12px 16px;border:1px solid color-mix(in srgb,var(--ui-accent) 26%,var(--ui-border));border-radius:var(--ds-radius,12px);background:color-mix(in srgb,var(--ui-accent-soft) 45%,var(--ui-surface));font-size:13px;line-height:20px;color:var(--ui-secondary)}.team-chat-state p{margin:4px 0;white-space:pre-wrap;color:var(--ui-text)}.team-live-dot{width:8px;height:8px;flex-shrink:0;border-radius:999px;background:var(--ui-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ui-accent) 22%,transparent)}.team-chat-decisions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}.team-chat-decisions:deep(.el-button+.el-button){margin-left:0}.team-chat-state details{margin-top:10px}.team-chat-state li{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}.team-chat-state ul{padding-left:16px}.team-chat-message header small{font-size:12px;color:var(--ui-muted)}
.title-translation{max-width:100%;margin:2px 0 0;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title-translation:deep(p){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-message:deep(.agent-translation){border-left-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-surface) 72%,transparent)}.user-message:deep(.translation-label),.user-message:deep(.translation-bar){color:var(--ui-secondary)}
.paused-editor>span{margin-inline-end:auto}
.paused-editor{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px 24px;border-top:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-muted);font-size:12px;line-height:16px}
.user-turn-stack{display:flex;flex-direction:column;align-items:flex-end;width:100%;max-width:100%;min-width:0}
.user-turn-stamp{align-self:center;margin:0 0 6px;color:var(--ui-muted);font:400 11px/15px var(--sans);font-variant-numeric:tabular-nums;opacity:0.86}
.user-card-header{display:none!important}
:root[data-theme='acid'] .user-card-header{display:flex!important}
:root[data-theme='acid'] .user-turn-stamp{display:none}
.user-message-tools{justify-content:flex-end;flex-wrap:wrap;gap:4px;margin-top:0;padding-top:0;border-top:0;max-height:0;overflow:hidden;opacity:0;pointer-events:none;transition:opacity 140ms ease,max-height 140ms ease,margin-top 140ms ease}.user-message:hover .user-message-tools,.user-message:focus-within .user-message-tools,.user-message-tools.is-pinned{margin-top:3px;max-height:40px;opacity:0.9;pointer-events:auto}.user-message .user-message-tools .message-copy{position:static}
.danger-link{border-color:color-mix(in srgb,var(--ui-danger) 48%,var(--ui-border));background:var(--ui-danger-bg);color:var(--ui-danger)}
.conversation-pane{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background:transparent;color:var(--ui-text)}.conversation-header{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;padding:6px 16px;border-bottom:1px solid var(--ui-border);background:color-mix(in srgb,var(--ui-surface) 92%,transparent);backdrop-filter:blur(16px)}.conversation-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}.conversation-actions:deep(.el-button){height:26px;margin-left:0;padding:4px 8px;border-radius:var(--ds-radius-xs,6px);color:var(--ui-secondary);font:500 11.5px/15px var(--sans)}.conversation-actions:deep(.el-button:hover){background:var(--ui-raised);color:var(--ui-text)}.conversation-context{display:flex;align-items:center;gap:6px;min-height:30px;padding:4px 16px;border-bottom:1px solid var(--ui-border);overflow:hidden;background:var(--ui-surface)}.context-block{display:inline-flex;align-items:center;gap:5px;min-width:0;height:24px;padding:0 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-raised);color:var(--ui-muted)}.context-block>span{display:flex;align-items:center;min-width:0;gap:4px}.context-block small{color:var(--ui-muted);font:500 10.5px/14px var(--mono);white-space:nowrap}:is(.project-context,.branch-context) small{display:none}.context-block strong{overflow:hidden;color:var(--ui-text);font:500 11.5px/15px var(--mono);text-overflow:ellipsis;white-space:nowrap}.project-context{max-width:200px;flex:0 1 auto}.branch-context{max-width:260px;flex:0 1 auto;border-color:color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));background:var(--ui-accent-soft)}.branch-context svg{flex:0 0 auto;color:var(--ui-accent)}.workspace-context{flex:1;min-width:0}.message-search{display:flex;align-items:center;gap:4px;width:168px;height:24px;margin-left:auto;padding:0 8px;flex-shrink:0;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-raised);color:var(--ui-muted);transition:width 160ms ease,border-color 160ms ease,box-shadow 160ms ease,background 160ms ease}.message-search.has-query{width:258px}.message-search:focus-within{border-color:var(--ui-accent);background:var(--ui-surface);color:var(--ui-accent);box-shadow:0 0 0 2px var(--ui-accent-soft)}.message-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--ui-text);font:400 11.5px/15px var(--sans)}.message-search input::placeholder{color:var(--ui-muted)}.message-search input[type="search"]::-webkit-search-cancel-button{-webkit-appearance:none;display:none}.message-search-counter{flex-shrink:0;padding:0 4px;border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);font:600 10px/15px var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}.message-search-step,.message-search-clear{display:grid;place-items:center;width:16px;height:16px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--ui-muted);cursor:pointer;flex-shrink:0}.message-search-step:hover,.message-search-clear:hover{background:var(--ui-hover);color:var(--ui-text)}
.message-viewport{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px clamp(18px,3vw,36px) 20px;background-color:var(--ui-bg);background-image:none}
:global(:root[data-theme='custom'] .message-viewport){background-image:linear-gradient(var(--agent-wallpaper-chat-shade),var(--agent-wallpaper-chat-shade)),var(--agent-wallpaper);background-position:center,var(--agent-wallpaper-position);background-size:auto,cover;background-repeat:no-repeat;background-attachment:scroll}
.message-list{display:flex;flex-direction:column;gap:14px;width:min(100%,840px);min-height:100%;margin:0 auto}.message-turn{display:flex;flex-direction:column;gap:10px}.message-turn:first-child{margin-top:auto}.chat-message{display:flex;align-items:flex-start;gap:10px}.chat-message>div{position:relative;min-width:0;max-width:100%}.message-avatar{display:grid;place-items:center;width:24px;height:24px;flex-shrink:0;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface);color:var(--ui-accent);box-shadow:none}.chat-message header{display:flex;align-items:center;gap:6px;margin:0 0 4px}.chat-message header strong{font:500 12px/16px var(--sans);color:var(--ui-secondary)}.chat-message time{font:400 11px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--ui-muted)}.chat-message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.58}.user-message{justify-content:flex-end}.user-message:not(.team-chat-message)>.message-avatar{display:none}.user-message .user-card,.user-message.team-chat-message>div{max-width:min(74%,560px);padding:7px 14px;border:1px solid color-mix(in srgb,var(--ui-accent) 26%,var(--ui-border));border-radius:18px;background:color-mix(in srgb,var(--ui-accent-soft) 82%,var(--ui-raised));color:var(--ui-text);box-shadow:none}.user-message header{justify-content:space-between;gap:10px;margin:0 0 3px;padding-bottom:0;border-bottom:0}.user-message header time{margin-left:auto;color:var(--ui-muted)}.user-message header strong{font:600 11.5px/15px var(--sans);color:var(--ui-secondary)}.user-message .message-avatar{border-color:var(--ui-border);background:var(--ui-surface);color:var(--ui-accent)}.user-message .message-copy{position:static;color:var(--ui-muted)}.agent-message:not(.team-chat-message)>.message-avatar{display:none}.agent-message>div{flex:1 1 auto;width:100%;max-width:100%;padding:2px 0;border:0;border-radius:0;background:transparent;box-shadow:none}.agent-message header time{margin-left:auto;opacity:0.82}.agent-result{color:var(--ui-text)}.agent-error{color:var(--ui-danger);font-size:12.5px;line-height:1.55}.agent-progress{color:var(--ui-muted);font-size:12.5px}.message-tools{display:flex;align-items:center;gap:4px;margin-top:4px}.message-tools:empty{display:none}.message-copy{display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:var(--ds-radius-xs,5px);background:transparent;color:var(--ui-muted);cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease}.message-copy:hover{border-color:var(--ui-border);background:var(--ui-raised);color:var(--ui-text)}.event-link{display:inline-flex;align-items:center;gap:3px;margin:0;padding:2px 7px;border:1px solid transparent;border-radius:var(--ds-radius-xs,5px);background:transparent;color:var(--ui-muted);font:500 11.5px/16px var(--sans);cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease}.event-link:hover{border-color:var(--ui-border);background:var(--ui-raised);color:var(--ui-text)}.event-link:disabled{cursor:not-allowed;opacity:.45}
.message-images{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;margin:0 0 8px}.message-images a{display:grid;gap:4px;width:96px;color:var(--ui-text);text-decoration:none}.message-images img{display:block;width:96px;height:72px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,8px);object-fit:cover}.message-images span{overflow:hidden;font-size:12px;line-height:16px;color:var(--ui-muted);text-overflow:ellipsis;white-space:nowrap}
.message-images a:has(> .message-file) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 0;
  max-width: min(100%, 360px);
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 8px);
  background: var(--ui-surface);
  color: var(--ui-text);
}
.message-images a:has(> .message-file):hover { border-color: var(--ui-accent); }
.message-images .message-file { display: inline-flex; flex: none; color: var(--ui-accent); opacity: 1; }
.message-images .message-file svg { width: 16px; height: 16px; }
.message-images .message-file + span {
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  opacity: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}
.user-message p:deep(a){color:var(--ui-accent);text-decoration:underline;text-underline-offset:3px}
.history-loading{width:min(100%,960px);margin:0 auto}.history-loading:deep(.el-skeleton__item){background:var(--ui-raised)}
.conversation-pane:deep(.el-empty){margin:auto}.conversation-pane:deep(.el-empty__description p){color:var(--ui-muted)}.conversation-pane:deep(.status-pill){padding:2px 8px;font-size:11.5px}
.turn-outline-trigger,.turn-count-pill{cursor:pointer;font-variant-numeric:tabular-nums;transition:border-color 140ms ease,background-color 140ms ease,color 140ms ease}
.turn-count-pill{cursor:default}
.turn-outline-trigger:hover{border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));background:var(--ui-surface);color:var(--ui-accent)}
.turn-outline-trigger strong,.turn-count-pill strong{font-variant-numeric:tabular-nums}
.copy-md-link{color:var(--ui-secondary)}
:global(.studio-turn-outline-popper.el-popper){--el-bg-color-overlay:var(--ui-surface);--el-text-color-regular:var(--ui-text);--el-fill-color-light:var(--ui-raised);border-color:var(--ui-border);border-radius:10px;background:var(--ui-surface);box-shadow:var(--ui-shadow)}
:global(.studio-turn-outline-popper .el-dropdown-menu){max-height:320px;overflow-y:auto;padding:4px}
:global(.studio-turn-outline-popper .el-dropdown-menu__item){display:flex;align-items:center;gap:8px;max-width:340px;padding:6px 10px;border-radius:7px;color:var(--ui-secondary);font-size:12px}
:global(.studio-turn-outline-popper .el-dropdown-menu__item:hover){background:var(--ui-raised);color:var(--ui-text)}
:global(.studio-turn-outline-popper .turn-outline-num){flex-shrink:0;padding:1px 5px;border:1px solid var(--ui-border);border-radius:4px;background:var(--ui-raised);color:var(--ui-accent);font:600 10.5px/14px var(--mono);font-variant-numeric:tabular-nums}
:global(.studio-turn-outline-popper .turn-outline-text){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text)}
:global(.studio-turn-outline-popper .turn-outline-files){flex-shrink:0;padding:1px 5px;border-radius:999px;border:1px solid var(--ui-border);background:var(--ui-raised);color:var(--ui-muted);font:600 10px/1.3 var(--mono)}
/* Zero-height anchor keeps selection actions outside the transcript/composer layout. */
.selection-quote-anchor{position:relative;flex:0 0 0;height:0;min-height:0;z-index:4}
.selection-quote-bar{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;box-sizing:border-box;width:min(calc(100% - 24px),840px);padding:7px 10px;border:1px solid color-mix(in srgb,var(--ui-accent) 25%,var(--ui-border));border-radius:10px;background:color-mix(in srgb,var(--ui-surface) 78%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 4px 18px color-mix(in srgb,var(--ui-text) 10%,transparent);color:var(--ui-secondary);font-size:12px;transition:background-color 200ms ease}
.selection-quote-bar:hover,.selection-quote-bar:focus-within{background:var(--ui-surface)}
.selection-quote-enter-active,.selection-quote-leave-active{transition:opacity 160ms ease,transform 160ms ease}
.selection-quote-enter-from,.selection-quote-leave-to{opacity:0;transform:translate(-50%,4px)}
.selection-quote-leave-active{pointer-events:none}
.jump-to-latest.is-behind-selection{visibility:hidden;pointer-events:none}
@media(prefers-reduced-motion:reduce){.selection-quote-bar,.selection-quote-enter-active,.selection-quote-leave-active{transition:none}}
.selection-quote-icon{flex-shrink:0;color:var(--ui-accent)}
.selection-quote-preview{flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text)}
.selection-quote-actions{display:inline-flex;align-items:center;flex-wrap:wrap;gap:5px}
.selection-quote-btn{flex-shrink:0;height:24px;padding:0 10px;border:0;border-radius:6px;background:var(--ui-accent);color:var(--ui-on-primary,#fff);font:600 11.5px/1 var(--sans);cursor:pointer;transition:opacity 140ms ease,background 140ms ease}
.selection-quote-btn.is-secondary{border:1px solid color-mix(in srgb,var(--ui-accent) 38%,var(--ui-border));background:var(--ui-surface);color:var(--ui-accent)}
.selection-quote-btn:hover{opacity:0.9}
.selection-quote-chip{flex-shrink:0;height:24px;padding:0 8px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface);color:var(--ui-secondary);font:500 11.5px/1 var(--sans);cursor:pointer;transition:border-color 140ms ease,color 140ms ease,background 140ms ease}
.selection-quote-chip:hover{border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));background:var(--ui-raised);color:var(--ui-text)}
.selection-quote-close{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ui-muted);cursor:pointer;flex-shrink:0}
.selection-quote-close:hover{background:var(--ui-hover);color:var(--ui-text)}
.is-bookmark-trigger{border-color:color-mix(in srgb,var(--ui-accent) 30%,var(--ui-border));color:var(--ui-accent)}
.event-link.is-bookmarked{border-color:color-mix(in srgb,var(--ui-accent) 36%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}
:global(.studio-bookmark-popper.el-popper){--el-bg-color-overlay:var(--ui-surface);border-color:var(--ui-border);border-radius:10px;background:var(--ui-surface);box-shadow:var(--ui-shadow);padding:10px}
:global(.studio-bookmark-popper .bookmark-popover-body){display:grid;gap:8px;max-height:360px;overflow-y:auto}
:global(.studio-bookmark-popper .bookmark-popover-head){display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--ui-text)}
:global(.studio-bookmark-popper .bookmark-popover-head small){color:var(--ui-muted);font-family:var(--mono);font-size:11px}
:global(.studio-bookmark-popper .bookmark-filter-input){width:100%;height:26px;padding:0 8px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised);color:var(--ui-text);font:400 11.5px/1 var(--sans);outline:none}
:global(.studio-bookmark-popper .bookmark-filter-input:focus){border-color:var(--ui-accent);background:var(--ui-surface)}
:global(.studio-bookmark-popper .bookmark-group){display:grid;gap:4px}
:global(.studio-bookmark-popper .bookmark-group header){font:600 10.5px/1.3 var(--sans);color:var(--ui-muted)}
:global(.studio-bookmark-popper .bookmark-row){display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid color-mix(in srgb,var(--ui-border) 75%,transparent);border-radius:7px;background:var(--ui-raised)}
:global(.studio-bookmark-popper .bookmark-main-btn){flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer}
:global(.studio-bookmark-popper .bookmark-main-btn:hover .bookmark-excerpt){color:var(--ui-accent)}
:global(.studio-bookmark-popper .bookmark-turn-badge){flex-shrink:0;padding:1px 4px;border-radius:4px;border:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-accent);font:600 10px/1.2 var(--mono)}
:global(.studio-bookmark-popper .bookmark-cross-info){flex:1;min-width:0;display:grid;gap:2px}
:global(.studio-bookmark-popper .bookmark-cross-info small){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-muted);font:500 10.5px/1.2 var(--sans)}
:global(.studio-bookmark-popper .bookmark-excerpt){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text);font-size:11.5px;line-height:1.35}
:global(.studio-bookmark-popper .bookmark-row-actions){display:inline-flex;align-items:center;gap:2px;flex-shrink:0}
:global(.studio-bookmark-popper .bookmark-row-actions button){display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--ui-secondary);cursor:pointer}
:global(.studio-bookmark-popper .bookmark-row-actions button:hover){border-color:var(--ui-border);background:var(--ui-surface);color:var(--ui-text)}
:global(.studio-bookmark-popper .bookmark-row-actions button.is-remove:hover){color:var(--ui-danger,#dc2626)}
:global(.studio-bookmark-popper .bookmark-empty){margin:0;padding:8px 0;text-align:center;color:var(--ui-muted);font-size:11.5px}
@media(max-width:1440px){.workspace-context{display:none}.message-search{width:154px}}
@media(max-width:1600px){.conversation-header{flex-wrap:wrap;gap:6px 10px;padding:6px 16px}.conversation-actions{flex-wrap:wrap;gap:4px;max-width:100%}.conversation-context{flex-wrap:wrap;padding:4px 16px}.message-search{min-width:136px}}
</style>

<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 设计说明：该组件把一次会话的运行链呈现为用户/Agent 消息，并提供唯一的会话输入口。
 * 它不直接请求后端，发送、停止和详情操作全部通过显式事件交给容器，避免隐藏副作用。
 */
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue';
import { Activity, PackageCheck, Check, ChevronRight, CircleStop, CornerUpLeft, Copy, Download, Ellipsis, File, Folder, GitBranch, GitFork, Info,
  Pencil, Pin, Play, RotateCcw, Search, Trash2 } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { agentProviderLabels, canContinueStoppedCodexRun, isAgentImageAttachment, type AgentAccessMode, type AgentAttachment, type AgentProvider, type AgentQueuePlacement, type AgentReasoningEffort, type AgentRun, type AgentRunMode, type AgentRuntimeHealth, type AgentServiceTier } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentComposer from './AgentComposer.vue';
import AgentTeamQuestion from './AgentTeamQuestion.vue';
import type { AgentTeamRequest } from './AgentTeamDialog.vue';
import AgentTerminalButton from './AgentTerminalButton.vue';
import AgentCursorButton from './AgentCursorButton.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentExecutionPanel from './AgentExecutionPanel.vue';
import AgentRemoteDelivery from './AgentRemoteDelivery.vue';
import AgentWorkspaceCodeArtifacts from './AgentWorkspaceCodeArtifacts.vue';
import type { JiraDevTaskView } from '../../../shared/jira-dev';
import { jiraDevTaskDeliveryId, jiraDevTaskIssue, jiraDevTaskProjects, jiraDevTaskWorkspacePaths } from './jira-dev-context';
import { canRetryTeamReviewWithCodex } from '../../../shared/agent-team';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentMessageText from './AgentMessageText.vue';
import AgentTaskPromptDrawer from './AgentTaskPromptDrawer.vue';
import { jiraTaskPromptTitle } from './message-text';
import AgentTranslatedText from './AgentTranslatedText.vue';
import AgentTranslateToggle from './AgentTranslateToggle.vue';
import { agentConversationCodePath, agentConversationStatus, canSteerAgentRun, agentRunErrorText, agentConversationProjectPath, agentRunStatus, isLegacyRestartContinuation, isRestartableAgentRun, isRetryableSessionBusyRun, type AgentConversation } from './conversation';
import { downloadConversation } from './conversation-export';
import { conversationFileDeliveries, conversationResultDownloads } from './conversation-deliveries';
import type { AgentBusinessMention } from './agent-business-context';
import type { AgentAttachmentDraft } from './useAgentAttachments';
import { teamChatEntries, teamChatParticipant, teamChatActivity, teamChatActiveStates, teamQuestionReply, isCurrentTeamChatTask, type TeamQuestionTarget } from './team-chat';
import { agentReplyText } from './execution-summary';
import { teamRoomAcceptanceRecord, type AdvancedTeamTask, type TeamRoom, type TeamDecision } from './team-api';

const props = defineProps<{ conversation?: AgentConversation; visible?: boolean; changing: string; runtimes: AgentRuntimeHealth[]; sideForkAvailable?: boolean; projectlessFork?: boolean;
  pinned: boolean; businessOptions: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft; teamTasks?: AdvancedTeamTask[]; teamRoom?: TeamRoom; teamAttachments?: Record<string, AgentAttachment>; jiraTask?: JiraDevTaskView }>();
const automatic = defineModel<boolean>('automatic', { default: false });
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const emit = defineEmits<{ send: [selection: { provider: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean; team?: AgentTeamRequest; question?: TeamQuestionTarget }]; accessChange: [accessMode: AgentAccessMode]; stop: [run: AgentRun]; edit: [run: AgentRun]; steer: [run: AgentRun]; removeQueued: [run: AgentRun]; retry: [run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>]; fork: [run: AgentRun]; forkSide: [run: AgentRun]; pin: [conversation: AgentConversation]; rename: [conversation: AgentConversation]; remove: [conversation: AgentConversation]; inspect: [run: AgentRun]; configureModels: []; teamDecision: [action: TeamDecision]; teamCommand: [command: '暂停任务' | '继续执行']; chooseTeamWorkspace: []; providerChange: [provider: AgentProvider]; openGroup: [roomId: string] }>();
const jiraTaskIssue = computed(() => props.jiraTask ? jiraDevTaskIssue(props.jiraTask) : undefined);
const jiraTaskProjects = computed(() => props.jiraTask ? jiraDevTaskProjects(props.jiraTask) : []);
const codePaths = computed(() => {
  const path = agentConversationCodePath(props.conversation);
  return path && !jiraDevTaskWorkspacePaths(props.jiraTask).includes(path) ? [path] : [];
});
const messageViewport = useTemplateRef<HTMLDivElement>('messageViewport');
const composer = useTemplateRef<InstanceType<typeof AgentComposer>>('composer');
const searchQuery = shallowRef('');
const conversationView = shallowRef<'chat' | 'execution' | 'delivery'>('chat');
const taskPromptDetail = shallowRef<string>();
watch([() => props.conversation?.id, () => props.visible], ([id, visible], [previousId]) => {
  if (id !== previousId) conversationView.value = 'chat';
  if (id !== previousId || visible === false) taskPromptDetail.value = undefined;
});
const copiedMessageId = shallowRef('');
const searchQueries = new Map<string, string>();
const scrollPositions = new Map<string, number>();
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const latest = computed(() => props.conversation?.latest);
const canFork = computed(() => props.conversation?.source === 'workspace' && latest.value?.provider === 'codex'
  && latest.value.status === 'completed' && !!latest.value.sessionId && !!latest.value.codexTurnId
  && (props.projectlessFork || latest.value.sourceWorkspacePath !== '' || !!latest.value.branch || !!latest.value.headSha));
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
const workspaceLabel = computed(() => {
  const path = props.conversation ? agentConversationProjectPath(props.conversation) : '';
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  const leaf = parts.at(-1) || '未指定工作区';
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
const entrySignature = computed(() => [visibleEntries.value.map(entry => entry.kind === 'run' ? `${entry.id}:${entry.run.updatedAt}:${entry.run.result.length}` : `${entry.id}:${entry.message.text.length}`).join('|'),
  currentTeamTask.value?.updatedAt || '', ...(props.teamRoom?.runs || []).map(run => `${run.id}:${run.updatedAt}:${run.events.length}:${run.result.length}`)].join('|'));

watch(() => props.conversation?.id, (id, previousId) => {
  if (previousId && messageViewport.value?.clientHeight) scrollPositions.set(previousId, messageViewport.value.scrollTop);
  searchQuery.value = id ? searchQueries.get(id) || '' : '';
}, { immediate: true });
watch([conversationView, () => props.visible], (_value, [previousView, previousVisible]) => {
  if (previousView === 'chat' && previousVisible !== false) rememberScroll();
});
// 工作面板通过 v-show 隐藏会话；等容器挂载并真正显示后再恢复，不能在隐藏时把位置归零。
watch([() => props.conversation?.id, conversationView, () => props.visible, messageViewport], ([id, view, visible, viewport]) => {
  if (!id || view !== 'chat' || visible === false || !viewport?.clientHeight) return;
  viewport.scrollTop = scrollPositions.get(id) ?? viewport.scrollHeight;
}, { immediate: true, flush: 'post' });
watch(searchQuery, (value) => { if (props.conversation?.id) searchQueries.set(props.conversation.id, value); });
watch(() => [props.conversation?.id, entrySignature.value] as const, async ([id], [previousId]) => {
  if (id !== previousId) return;
  const viewport = messageViewport.value;
  if (!viewport || !viewport.clientHeight || searchQuery.value || !isChatVisible()) return;
  const followsLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
  // 同步记录更新前的位置，等本轮响应式更新全部入队后再等待 DOM 完成。
  await Promise.resolve();
  await nextTick();
  if (followsLatest && props.conversation?.id === id && messageViewport.value === viewport && viewport.clientHeight
    && isChatVisible() && !searchQuery.value) viewport.scrollTop = viewport.scrollHeight;
}, { flush: 'sync' });

function isChatVisible() { return props.visible !== false && conversationView.value === 'chat'; }

function rememberScroll() {
  if (props.conversation?.id && messageViewport.value?.clientHeight) scrollPositions.set(props.conversation.id, messageViewport.value.scrollTop);
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
  if (!props.conversation || !['markdown', 'json'].includes(String(format))) return;
  downloadConversation(props.conversation, format as 'markdown' | 'json');
}

onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });

function focusComposer() { composer.value?.focusPrompt(); }

function retryRun(run: AgentRun, continueOriginal = false) { emit('retry', run, continueOriginal ? undefined : composer.value?.retrySelection(run)); }

defineExpose({ focusComposer });

</script>

<template>
  <section class="conversation-pane" aria-label="Agent 会话窗口">
    <template v-if="conversation">
      <div class="conversation-masthead">
      <header class="conversation-header studio-conversation-header">
        <div class="conversation-title-copy">
          <h1 :title="conversation.title">{{ conversation.title }}</h1>
          <AgentTranslatedText class="title-translation" :source="conversation.title" compact />
          <div class="conversation-meta"><span :title="agentConversationProjectPath(conversation)">{{ workspaceLabel }}</span><ChevronRight :size="12" /><span>{{ agentProviderLabels[conversation.latest.provider] }}</span><span>{{ modeLabel }}</span><span>访问权限：{{ accessLabel }}</span><span :title="selectedModelLabel">{{ selectedModelLabel }}</span></div>
        </div>
        <div class="conversation-actions">
          <slot name="header-actions" />
          <StatusPill v-bind="status" />
          <AgentTranslateToggle />
          <el-button v-if="stoppableRun && !pausedRun" link type="danger" :loading="changing === stoppableRun.id" @click="emit('stop', stoppableRun)"><CircleStop :size="14" /> 停止</el-button>
          <el-dropdown trigger="click" popper-class="studio-conversation-menu">
            <button type="button" class="studio-panel-toggle" aria-label="更多会话操作" title="更多会话操作"><Ellipsis :size="19" /></button>
            <template #dropdown><el-dropdown-menu>
              <el-dropdown-item v-if="canFork" :disabled="running || !!changing" @click="emit('fork', conversation.latest)"><GitFork :size="14" />基于此会话新建</el-dropdown-item>
              <el-dropdown-item v-if="sideForkAvailable" :disabled="!!changing" @click="emit('forkSide', conversation.latest)"><GitFork :size="14" />在侧边新建继承会话</el-dropdown-item>
              <el-dropdown-item :disabled="!!changing" @click="emit('rename', conversation)"><Pencil :size="14" />修改标题</el-dropdown-item>
              <el-dropdown-item @click="emit('pin', conversation)"><Pin :size="14" />{{ pinned ? '取消置顶' : '置顶会话' }}</el-dropdown-item>
              <el-dropdown-item @click="emit('inspect', conversation.latest)"><Info :size="14" />会话信息</el-dropdown-item>
              <el-dropdown-item divided @click="exportConversation('markdown')"><Download :size="14" />导出 Markdown</el-dropdown-item>
              <el-dropdown-item @click="exportConversation('json')"><Download :size="14" />导出 JSON</el-dropdown-item>
              <el-dropdown-item divided :disabled="!!changing" class="studio-delete-conversation" @click="emit('remove', conversation)"><Trash2 :size="14" />删除会话</el-dropdown-item>
            </el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </header>
      <div class="conversation-toolbar">
      <nav class="studio-conversation-tools" aria-label="会话视图">
        <button type="button" :class="{ active: conversationView === 'chat' }" :aria-pressed="conversationView === 'chat'" @click="conversationView = 'chat'">对话</button>
        <button type="button" :class="{ active: conversationView === 'execution' }" :aria-pressed="conversationView === 'execution'" @click="conversationView = 'execution'"><Activity :size="14" />执行记录</button>
        <button type="button" :class="{ active: conversationView === 'delivery' }" :aria-pressed="conversationView === 'delivery'" @click="conversationView = 'delivery'"><PackageCheck :size="14" />本轮交付<span>{{ currentFileCount }}</span></button>
      </nav>
      <div class="conversation-context">
        <div class="context-block project-context" :title="agentConversationProjectPath(conversation)"><Folder :size="14" /><span><small>当前项目</small><strong>{{ workspaceLabel }}</strong></span></div>
        <div v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" class="context-block branch-context" :title="conversation.latest.baseBranch || conversation.latest.branch || '普通文件夹'"><GitBranch :size="14" /><span><small>{{ conversation.latest.isolatedWorkspace ? '基线分支' : conversation.latest.branch ? '当前分支' : '工作区类型' }}</small><strong>{{ conversation.latest.baseBranch || conversation.latest.branch || '普通文件夹' }}</strong></span></div>
        <div v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" class="context-block workspace-context" :title="conversation.latest.workspacePath"><span><small>工作区</small><strong>{{ conversation.latest.workspacePath.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || conversation.latest.workspacePath }}</strong></span></div>
        <AgentTerminalButton v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" :workspace-path="conversation.latest.workspacePath" />
        <AgentCursorButton v-if="!conversation.teamChat || conversation.teamChat.workspaceBound" :workspace-path="conversation.latest.workspacePath" />
        <label class="message-search"><Search :size="12" /><input v-model="searchQuery" type="search" placeholder="搜索当前会话" /></label>
      </div>
      <div v-if="jiraTask" class="conversation-jira-task" aria-label="关联 Jira 研发任务">
        <strong>{{ jiraTask.workflow === 'requirement' ? '需求开发' : 'Jira 修复' }}</strong>
        <a v-if="jiraTaskIssue?.url" :href="jiraTaskIssue.url" target="_blank" rel="noreferrer">{{ jiraTaskIssue.key }}</a>
        <span v-else-if="jiraTaskIssue">{{ jiraTaskIssue.key }}</span>
        <span v-for="project in jiraTaskProjects" :key="`${project.path}:${project.branchName}`" :title="project.workspacePath || project.path">{{ project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path }} · {{ project.branchName }}</span>
        <router-link :to="{ path: '/delivery/handoff', query: { view: 'jira', workflow: jiraTask.workflow, taskId: jiraTask.taskId } }">返回任务与交接</router-link>
        <button v-if="jiraTask.launch?.groupRoomId" type="button" class="jira-group-link" @click="emit('openGroup', jiraTask.launch.groupRoomId)">打开团队群聊</button>
      </div>
      </div>
      </div>
      <div class="conversation-reading">
      <AgentExecutionPanel v-show="conversationView === 'execution'" :visible="visible !== false && conversationView === 'execution'" class="studio-main-execution" :conversation="conversation" :team-room="teamRoom" :team-task="currentTeamTask" @inspect="emit('inspect', $event)" />
      <section v-if="conversationView === 'delivery'" class="studio-main-delivery" aria-label="本轮交付成果">
        <AgentWorkspaceCodeArtifacts v-if="codePaths.length" :paths="codePaths" :active="visible" :run-state="conversation.latest.status" />
        <AgentRemoteDelivery v-if="jiraTask" :key="jiraDevTaskDeliveryId(jiraTask)" :target-id="jiraDevTaskDeliveryId(jiraTask)" :active="visible !== false && conversationView === 'delivery'" />
        <h2>本轮交付</h2>
        <AgentChangedFiles v-for="item in currentFileDeliveries" :key="item.run.id" :files="item.run.changedFiles!" :run-id="item.run.id" />
        <el-empty v-if="!currentFileDeliveries.length && !jiraTask" description="本轮暂无记录的改动文件" :image-size="56" />
        <details v-if="historicalFileDeliveries.length" class="delivery-file-history">
          <summary>历史文件</summary>
          <section v-for="item in historicalFileDeliveries" :key="item.run.id">
            <h3>第 {{ item.round }} 轮 · {{ dateTime(item.run.updatedAt) }}</h3>
            <AgentChangedFiles :files="item.run.changedFiles!" :run-id="item.run.id" />
          </section>
        </details>
      </section>
      <div v-show="conversationView === 'chat'" ref="messageViewport" class="message-viewport" aria-live="polite" @scroll.passive="rememberScroll">
        <div class="message-list">
          <template v-for="entry in transcriptEntries" :key="entry.id">
          <div v-if="entry.kind === 'run'" class="message-turn">
            <template v-for="{ run, id } in entry.runs" :key="id">
            <article v-if="!legacyContinuations.has(run.id)" class="chat-message user-message"><AgentAvatar user class="message-avatar" /><div><header><strong>你</strong><time>{{ dateTime(run.createdAt) }}</time></header><div v-if="run.attachments?.length" class="message-images"><a v-for="attachment in run.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ attachment.name }}</span></a></div>
              <p v-if="taskPromptTitles.has(id)">{{ taskPromptTitles.get(id) }}</p>
              <AgentTranslatedText v-else :source="run.objective" replace><AgentMessageText :source="run.objective" :search-query="searchQuery" /></AgentTranslatedText>
              <div class="message-tools user-message-tools">
                <button v-if="taskPromptTitles.has(id)" type="button" class="event-link" aria-haspopup="dialog" @click="taskPromptDetail = run.objective">查看完整提示词</button>
                <button v-if="conversation.source !== 'codex' && (run.pausedForEdit || (!pausedRun && (run.status === 'running' || run.id === conversation.latest.id && ['queued', 'cancelled', 'interrupted', 'failed'].includes(run.status))))"
                  type="button" class="event-link" :disabled="!!changing" @click="emit('edit', run)"><Pencil :size="12" /> {{ ['running', 'queued'].includes(run.status) ? '暂停并编辑' : '编辑消息' }}</button>
                <span v-if="run.revisesRunId" class="event-link">修订后的消息</span>
                <button v-if="canFork"
                  type="button" class="event-link" :disabled="running || !!changing"
                  title="继承当前会话已完成的上下文，原会话保留不变"
                  @click="emit('fork', conversation.latest)"><GitFork :size="12" /> 基于此会话新建</button>
                <button type="button" class="message-copy" title="复制消息" @click="copyMessage(`user:${run.id}`, run.objective)"><Check v-if="copiedMessageId === `user:${run.id}`" :size="12" /><Copy v-else :size="12" /></button>
              </div>
            </div></article>
            <article v-for="supplement in run.supplements || []" :key="supplement.id" class="chat-message user-message">
              <AgentAvatar user class="message-avatar" /><div><header><strong>你 · 补充</strong><time>{{ dateTime(supplement.createdAt) }}</time></header>
                <div v-if="supplement.attachments.length" class="message-images"><a v-for="attachment in supplement.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ attachment.name }}</span></a></div><AgentTranslatedText :source="supplement.objective" replace><AgentMessageText :source="supplement.objective" :search-query="searchQuery" /></AgentTranslatedText>
              </div>
            </article>
            <article class="chat-message agent-message"><AgentAvatar :provider="run.provider" :model="run.model" class="message-avatar" /><div><header><strong>{{ run.provider === 'codex' ? 'GPT / Codex' : run.provider === 'claude' ? 'Claude Code' : run.provider === 'kiro' ? 'Kiro CLI' : run.provider === 'antigravity' ? 'Antigravity CLI' : run.provider === 'api' ? '模型 API' : run.provider === 'deepseek' ? 'DeepSeek（官方 API）' : run.provider === 'workbuddy' ? '腾讯 WorkBuddy' : run.provider === 'grok' ? 'Grok（xAI）' : 'Cursor Agent' }}</strong><small class="message-model">{{ run.model || 'CLI 默认' }}</small><StatusPill v-bind="agentRunStatus(run)" /><small v-if="legacyContinuations.has(run.id)" class="continuation-label" title="沿用上一轮的 Codex 会话">续跑</small><time>{{ dateTime(run.updatedAt) }}</time></header><AgentTranslatedText v-if="run.result" :source="agentReplyText(run.result)" :stable="!['queued', 'running'].includes(run.status)" markdown replace><AgentMarkdown class="agent-result" :source="agentReplyText(run.result)" /></AgentTranslatedText><AgentTranslatedText v-if="run.error" :source="agentRunErrorText(run)" replace><p class="agent-error">{{ agentRunErrorText(run) }}</p></AgentTranslatedText><template v-else-if="!run.result"><AgentTranslatedText v-if="run.events.length" :source="latestActivity(run)" replace><p class="agent-progress">{{ latestActivity(run) }}</p></AgentTranslatedText><p v-else class="agent-progress">该轮没有保存最终回复</p></template><AgentChangedFiles v-if="run.changedFiles" :files="run.changedFiles" :run-id="run.id" /><div class="message-tools"><button v-if="run.result || run.error" type="button" class="message-copy" title="复制消息" @click="copyMessage(`agent:${run.id}`, agentReplyText(run.result) || agentRunErrorText(run))"><Check v-if="copiedMessageId === `agent:${run.id}`" :size="12" /><Copy v-else :size="12" /></button><button v-if="canSteerAgentRun(run, activeRun, conversation.runs)" type="button" class="event-link" :disabled="!!changing" title="停止当前轮，并提前执行此消息" @click="emit('steer', run)"><CornerUpLeft :size="12" /> 调整方向</button><button v-if="conversation.source !== 'codex' && run.status === 'queued' && run.parentRunId" type="button" class="event-link danger-link" :disabled="!!changing" title="从当前会话删除这条排队消息" @click="emit('removeQueued', run)"><Trash2 :size="12" /> {{ changing === `delete:${run.id}` ? '删除中' : '删除' }}</button><button v-if="!pausedRun && continuableRun?.id === run.id" type="button" class="event-link" :disabled="!!changing" title="在原轮次继续，沿用已保存的会话和权限" @click="retryRun(run, true)"><Play :size="12" /> 继续执行</button>
              <button v-else-if="isRestartableAgentRun(run) && !pausedRun && !canContinueStoppedCodexRun(run)" type="button" class="event-link" :disabled="!!changing" :title="isRetryableSessionBusyRun(run) ? '尝试续接原会话；真实运行中的任务不会被中断' : '从已保存状态重新执行该任务'" @click="retryRun(run)"><RotateCcw :size="12" /> 重新执行</button><button v-if="run.events.length" type="button" class="event-link" @click="emit('inspect', run)">{{ run.events.length }} 条运行事件</button></div></div></article>
            </template>
          </div>
          <article v-else class="chat-message team-chat-message" :class="entry.message.role === 'user' ? 'user-message' : 'agent-message'" :data-message-id="entry.id">
            <AgentAvatar :user="entry.message.role === 'user'" :provider="entry.identity?.provider" :model="entry.identity?.model" class="message-avatar" />
            <div><header><strong>{{ teamChatParticipant(entry.message) }}</strong><small v-if="entry.identity" class="message-model">{{ agentProviderLabels[entry.identity.provider] }} · {{ entry.identity.model || 'CLI 默认' }}</small><small v-if="entry.message.kind === 'handoff'">交接</small><small v-else-if="entry.message.kind === 'question'">问题</small><time>{{ dateTime(entry.message.createdAt) }}</time></header>
              <div v-if="entry.message.attachmentIds?.length" class="message-images"><a v-for="id in entry.message.attachmentIds" :key="id" :href="chatAttachment(id)?.url || `/api/agent-runtimes/attachments/${encodeURIComponent(id)}`" target="_blank" rel="noopener"><img v-if="chatAttachment(id) && isAgentImageAttachment(chatAttachment(id)!)" :src="chatAttachment(id)!.url" :alt="chatAttachment(id)!.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ chatAttachment(id)?.name || '附件' }}</span></a></div>
              <AgentMarkdown v-if="entry.message.role === 'assistant'" class="agent-result" :source="entry.message.text" />
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
          </template>
          <section v-if="teamResultVisible && currentTeamTask && !searchQuery && (!hasTeamDeliveryMessage || teamResultDownloads.length)" class="team-result-state" aria-label="任务结果">
            <div class="team-result-heading"><div><small>本轮已完成</small><strong>{{ hasTeamDeliveryMessage ? '交付文件' : '结果' }}</strong></div><el-button link class="team-progress-link" @click="conversationView = 'execution'">查看执行记录<ChevronRight :size="14" /></el-button></div>
            <p v-if="!hasTeamDeliveryMessage">{{ teamResultSummary }}</p>
            <div v-if="teamResultDownloads.length" class="team-result-downloads">
              <a v-for="file in teamResultDownloads" :key="file.key" :href="file.url" :download="file.name"><Download :size="15" /><span><small>交付文件</small>{{ file.name }}</span></a>
            </div>
          </section>
          <section v-if="teamProgressVisible && currentTeamTask && !searchQuery && !teamResultVisible" class="team-chat-state" aria-label="团队协作进度">
            <div class="team-chat-status"><p role="status">{{ teamActivity }}</p><el-button v-if="currentTeamTask.nodes.length" link class="team-progress-link" @click="conversationView = 'execution'">查看协作进展<ChevronRight :size="14" /></el-button></div>
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
            <AgentChangedFiles v-for="item in currentFileDeliveries" :key="item.run.id" :files="item.run.changedFiles!" :run-id="item.run.id" />
          </section>
          <div v-if="!conversation.loaded" class="history-loading"><el-skeleton :rows="2" animated /></div>
          <el-empty v-if="searchQuery && !visibleEntries.length" description="当前会话没有匹配内容" :image-size="56" />
        </div>
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
    <AgentTaskPromptDrawer v-model="taskPromptDetail" />
  </section>
</template>

<style scoped>
.team-more-actions{font-size:12px;color:var(--agent-muted)}.team-more-actions summary{cursor:pointer;line-height:32px}.team-more-actions .team-chat-decisions{margin-top:4px}
.team-result-downloads{display:grid;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--agent-border)}.team-result-downloads a{display:flex;align-items:center;gap:9px;max-width:100%;padding:8px 10px;border:1px solid color-mix(in srgb,var(--agent-accent) 28%,var(--agent-border));border-radius:8px;background:color-mix(in srgb,var(--agent-accent) 7%,var(--agent-panel-strong));color:var(--agent-accent);overflow-wrap:anywhere;text-decoration:none}.team-result-downloads a:hover{border-color:var(--agent-accent);background:color-mix(in srgb,var(--agent-accent) 13%,var(--agent-panel-strong))}.team-result-downloads a>span{display:grid;gap:2px;min-width:0}.team-result-downloads small{color:var(--agent-muted);font-size:10px}.team-result-downloads svg{flex-shrink:0}
.chat-message header{flex-wrap:wrap;row-gap:4px}.message-model{font-size:11px;color:var(--agent-muted);overflow-wrap:anywhere}
.continuation-label{color:var(--agent-accent);font-size:11px;white-space:nowrap}
.conversation-toolbar{display:contents}
.conversation-jira-task{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:6px 22px;border-bottom:1px solid var(--agent-border);background:color-mix(in srgb,var(--agent-panel) 84%,transparent);color:var(--agent-muted);font-size:12px}
.conversation-jira-task strong{color:var(--agent-text)}
.conversation-jira-task a{color:var(--agent-accent);text-decoration:none}
.conversation-jira-task a:hover{text-decoration:underline}
.jira-group-link{padding:0;border:0;background:transparent;color:var(--agent-accent);font-size:12px;cursor:pointer}
.jira-group-link:hover{text-decoration:underline}
.studio-main-delivery:deep(.remote-delivery){margin-bottom:16px;padding:12px 0;border-bottom:1px solid var(--agent-border)}
.delivery-file-history{margin-top:24px;color:var(--agent-muted);font-size:13px}.delivery-file-history>summary{cursor:pointer}.delivery-file-history h3{margin:20px 0 0;font-size:12px;font-weight:500}
.team-chat-state :deep(.changed-file-open code){white-space:normal;overflow-wrap:anywhere}
.team-result-state{margin:18px 0 10px;padding:16px;border:1px solid color-mix(in srgb,var(--agent-accent) 26%,var(--agent-border));border-radius:12px;background:linear-gradient(145deg,color-mix(in srgb,var(--agent-accent) 7%,var(--agent-panel-strong)),color-mix(in srgb,var(--agent-panel) 90%,transparent));font-size:13px;color:var(--agent-secondary)}.team-result-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.team-result-heading>div{display:grid;gap:3px}.team-result-heading small{color:var(--agent-accent);font-size:10px}.team-result-heading strong{font-size:15px;color:var(--agent-text)}.team-result-state>p{margin:11px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.team-chat-status{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px}.team-progress-link{gap:3px;font-size:12px;color:var(--agent-muted)}.team-progress-link:hover{color:var(--agent-accent)}.team-chat-decisions:empty{display:none}
.team-chat-state{font-size:12px;color:var(--agent-muted);padding:8px 0}.team-chat-state p{margin:6px 0;white-space:pre-wrap}.team-chat-decisions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.team-chat-decisions:deep(.el-button+.el-button){margin-left:0}.team-chat-state details{margin-top:12px}.team-chat-state li{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}.team-chat-state ul{padding-left:16px}.team-chat-message header small{font-size:10px;color:var(--agent-muted)}
.title-translation{max-width:100%;margin:2px 0 3px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title-translation:deep(p){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-message:deep(.agent-translation){border-left-color:#ffffffb3;background:#ffffff1f}.user-message:deep(.translation-label),.user-message:deep(.translation-bar){color:#ffffffc0}
.paused-editor>span{margin-inline-end:auto}
.paused-editor{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:18px 24px;border-top:1px solid var(--agent-border);background:var(--agent-panel);color:var(--agent-muted);font-size:12px}
.user-message-tools{justify-content:flex-end;flex-wrap:wrap}.user-message .user-message-tools .message-copy{position:static}
.danger-link{border-color:color-mix(in srgb,var(--el-color-danger) 56%,var(--agent-border));background:color-mix(in srgb,var(--el-color-danger) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--el-color-danger) 68%,#fff)}
.conversation-pane{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background:transparent;color:var(--agent-text)}.conversation-header{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:58px;padding:0 22px;border-bottom:1px solid var(--agent-border);background:color-mix(in srgb,var(--agent-panel) 90%,transparent);backdrop-filter:blur(16px)}.conversation-tabs{display:flex;align-items:center;gap:7px;min-width:0}.conversation-tabs strong,.conversation-tabs span{padding:5px 10px;border:1px solid transparent;border-radius:7px;font-size:10px;white-space:nowrap}.conversation-tabs strong{background:linear-gradient(120deg,var(--agent-cyan),var(--agent-accent));color:#fff;box-shadow:0 5px 16px color-mix(in srgb,var(--agent-accent) 25%,transparent)}.conversation-tabs span{color:var(--agent-muted);background:var(--agent-panel-strong)}.conversation-tabs span:last-child{max-width:190px;overflow:hidden;border-color:color-mix(in srgb,var(--agent-accent) 44%,var(--agent-border));color:var(--agent-secondary);background:var(--agent-raised);text-overflow:ellipsis}.conversation-actions{display:flex;align-items:center;gap:3px;flex-shrink:0}.conversation-actions:deep(.el-button){height:30px;margin-left:0;padding:5px 7px;border-radius:7px;color:color-mix(in srgb,var(--agent-accent) 48%,#dce8ff);font-size:10px}.conversation-actions:deep(.el-button:hover){background:var(--agent-panel-strong)}.conversation-context{display:flex;align-items:center;gap:8px;min-height:56px;padding:6px 22px;border-bottom:1px solid var(--agent-border);overflow:hidden;background:color-mix(in srgb,var(--agent-panel) 78%,transparent)}.context-block{display:flex;align-items:center;gap:8px;min-width:0;height:40px;padding:0 11px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong);color:var(--agent-muted)}.context-block>span{display:grid;min-width:0;gap:2px}.context-block small{color:var(--agent-muted);font-size:8px;line-height:1}.context-block strong{overflow:hidden;color:var(--agent-text);font-size:10px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.project-context{width:150px;flex:0 0 auto}.branch-context{width:min(34%,310px);border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong))}.branch-context svg{flex:0 0 auto;color:var(--agent-accent)}.workspace-context{flex:1}.message-search{display:flex;align-items:center;width:180px;height:32px;margin-left:auto;padding:0 9px;flex-shrink:0;border:1px solid var(--agent-border);border-radius:7px;background:var(--agent-panel-strong);color:var(--agent-muted)}.message-search:focus-within{border-color:var(--agent-accent);color:var(--agent-accent)}.message-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--agent-text);font-size:9px}.message-search input::placeholder{color:var(--agent-muted)}
.message-viewport{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:30px clamp(24px,3vw,52px) 22px;background-color:var(--agent-bg);background-image:linear-gradient(var(--agent-wallpaper-chat-shade),var(--agent-wallpaper-chat-shade)),radial-gradient(circle at 50% -8%,color-mix(in srgb,var(--agent-accent) 16%,transparent) 0,transparent 43%),var(--agent-wallpaper);background-position:center,center,var(--agent-wallpaper-position);background-size:auto,auto,cover;background-repeat:no-repeat;background-attachment:scroll}.message-list{display:flex;flex-direction:column;gap:28px;width:min(100%,1180px);min-height:100%;margin:0 auto}.message-turn{display:flex;flex-direction:column;gap:15px}.message-turn:first-child{margin-top:auto}.chat-message{display:flex;align-items:flex-start;gap:11px}.chat-message>div{position:relative;min-width:0;max-width:min(88%,960px);backdrop-filter:blur(10px)}.message-avatar{display:grid;place-items:center;width:32px;height:32px;flex-shrink:0;border:1px solid var(--agent-border);border-radius:9px;background:var(--agent-panel-strong);color:var(--agent-accent);box-shadow:0 6px 18px #0003}.chat-message header{display:flex;align-items:center;gap:8px;margin:0 0 8px}.chat-message header strong{font-size:10px;letter-spacing:.1px}.chat-message time{font:8px var(--mono);color:var(--agent-muted)}.chat-message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.76}.user-message{justify-content:flex-end}.user-message>div{order:-1;padding:12px 38px 12px 16px;border:1px solid color-mix(in srgb,var(--agent-cyan) 46%,transparent);border-radius:14px 4px 14px 14px;background:linear-gradient(125deg,color-mix(in srgb,var(--agent-cyan) var(--agent-message-opacity),transparent),color-mix(in srgb,var(--agent-accent) var(--agent-message-opacity),transparent));color:#fff;box-shadow:0 10px 28px color-mix(in srgb,var(--agent-accent) 22%,transparent)}.user-message header{justify-content:flex-end}.user-message header strong,.user-message time{color:#fff}.user-message time{opacity:.72}.user-message .message-avatar{border-color:var(--agent-border);background:var(--agent-panel-strong);color:var(--agent-cyan)}.user-message .message-copy{position:absolute;right:9px;bottom:8px;color:#fff}.agent-message>div{width:min(88%,960px);padding:15px 17px;border:1px solid var(--agent-border);border-radius:4px 14px 14px;background:linear-gradient(145deg,color-mix(in srgb,var(--agent-raised) var(--agent-message-opacity),transparent),color-mix(in srgb,var(--agent-panel-strong) var(--agent-message-opacity),transparent));box-shadow:0 12px 32px #0003}.agent-message header time{margin-left:auto}.agent-result{color:var(--agent-text)}.agent-error{color:#ff9aac}.agent-progress{color:var(--agent-muted)}.message-tools{display:flex;align-items:center;gap:7px;margin-top:10px}.message-copy{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--agent-muted);cursor:pointer}.message-copy:hover{border-color:var(--agent-border);background:var(--agent-raised);color:#fff}.event-link{display:inline-flex;align-items:center;gap:4px;margin:0;padding:4px 7px;border:1px solid color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--agent-accent) 45%,#fff);font-size:9px;cursor:pointer;transition:.16s ease}.event-link:hover{border-color:var(--agent-accent);background:var(--agent-raised);color:#fff}.event-link:disabled{cursor:not-allowed;opacity:.45}
.message-images{display:flex;flex-wrap:wrap;align-items:flex-start;gap:7px;margin:0 0 9px}.message-images a{display:grid;gap:3px;width:92px;color:#fff;text-decoration:none}.message-images img{display:block;width:92px;height:72px;border:1px solid #ffffff4d;border-radius:7px;object-fit:cover}.message-images span{overflow:hidden;font-size:8px;opacity:.8;text-overflow:ellipsis;white-space:nowrap}
.message-images a:has(> .message-file) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 0;
  max-width: min(100%, 360px);
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--agent-border);
  border-radius: 7px;
  background: var(--agent-panel);
  color: var(--agent-text);
}
.message-images a:has(> .message-file):hover { border-color: var(--agent-accent); }
.message-images .message-file { display: inline-flex; flex: none; color: var(--agent-accent); opacity: 1; }
.message-images .message-file svg { width: 16px; height: 16px; }
.message-images .message-file + span {
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}
.user-message p:deep(a){color:#fff;text-decoration:underline;text-underline-offset:3px}
.history-loading{width:min(100%,980px);margin:0 auto}.history-loading:deep(.el-skeleton__item){background:var(--agent-panel-strong)}
.conversation-pane:deep(.el-empty){margin:auto}.conversation-pane:deep(.el-empty__description p){color:var(--agent-muted)}.conversation-pane:deep(.status-pill){padding:3px 8px;font-size:9px}
@media(max-width:1440px){.workspace-context{display:none}.project-context{width:130px}.branch-context{width:auto;flex:1}.message-search{width:150px}}
@media(max-width:1600px){.conversation-header{flex-wrap:wrap;gap:8px;padding:12px 16px}.conversation-tabs{flex-wrap:wrap;gap:5px}.conversation-actions{flex-wrap:wrap;gap:4px;max-width:100%}.conversation-context{flex-wrap:wrap;padding:8px 16px}.message-search{flex:1;min-width:140px}.branch-context{flex:1;min-width:160px}.workspace-context{min-width:160px}}
</style>

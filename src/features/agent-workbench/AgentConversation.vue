<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 设计说明：该组件把一次会话的运行链呈现为用户/Agent 消息，并提供唯一的会话输入口。
 * 它不直接请求后端，发送、停止和详情操作全部通过显式事件交给容器，避免隐藏副作用。
 */
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue';
import { Check, CircleStop, CornerUpLeft, Copy, Download, File, Folder, GitBranch, GitFork, Info, PanelLeftClose, PanelLeftOpen,
  PanelRightClose, PanelRightOpen, Pencil, Pin, RotateCcw, Search, Trash2 } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { isAgentImageAttachment, type AgentAccessMode, type AgentAttachment, type AgentProvider, type AgentQueuePlacement, type AgentReasoningEffort, type AgentRun, type AgentRuntimeHealth, type AgentServiceTier } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentComposer from './AgentComposer.vue';
import AgentTerminalButton from './AgentTerminalButton.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentMessageText from './AgentMessageText.vue';
import { agentRunErrorText, agentRunProjectPath, isRestartableAgentRun, isRetryableSessionBusyRun, type AgentConversation } from './conversation';
import { downloadConversation } from './conversation-export';
import type { AgentBusinessMention } from './agent-business-context';

const props = defineProps<{ conversation?: AgentConversation; changing: string; runtimes: AgentRuntimeHealth[];
  pinned: boolean; leftCollapsed: boolean; rightCollapsed: boolean; businessOptions: AgentBusinessMention[] }>();
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const emit = defineEmits<{ send: [selection: { provider: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean }]; stop: [run: AgentRun]; edit: [run: AgentRun]; steer: [run: AgentRun]; removeQueued: [run: AgentRun]; retry: [run: AgentRun]; fork: [run: AgentRun]; pin: [conversation: AgentConversation]; rename: [conversation: AgentConversation]; remove: [conversation: AgentConversation]; inspect: [run: AgentRun]; configureModels: []; toggleLeft: []; toggleRight: [] }>();
const messageViewport = useTemplateRef<HTMLDivElement>('messageViewport');
const composer = useTemplateRef<InstanceType<typeof AgentComposer>>('composer');
const searchQuery = shallowRef('');
const copiedMessageId = shallowRef('');
const searchQueries = new Map<string, string>();
const scrollPositions = new Map<string, number>();
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const latest = computed(() => props.conversation?.latest);
const runtime = computed(() => props.runtimes.find((item) => item.provider === latest.value?.provider));
const running = computed(() => !!latest.value && ['queued', 'running'].includes(latest.value.status));
const activeRun = computed(() => props.conversation?.runs.find((run) => run.status === 'running'));
const pausedRun = computed(() => props.conversation?.runs.find(run => run.pausedForEdit));
const stoppableRun = computed(() => activeRun.value || [...(props.conversation?.runs || [])].reverse().find((run) => run.status === 'queued'));
const latestActivity = (run: AgentRun) => run.events.at(-1)?.message || '等待执行器返回状态';
const modeLabel = computed(() => props.conversation?.source === 'codex' ? '历史会话'
  : latest.value?.mode === 'agent' ? 'Agent 模式' : latest.value?.mode === 'plan' ? 'Plan 模式' : 'Ask 模式');
const selectedModelLabel = computed(() => runtime.value?.models.find((model) => model.id === latest.value?.model)?.label || latest.value?.model || 'CLI 默认');
const workspaceLabel = computed(() => {
  const path = latest.value ? agentRunProjectPath(latest.value) : '';
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  const leaf = parts.at(-1) || '未指定工作区';
  return ['admin', 'delivery-admin'].includes(leaf.toLowerCase()) ? parts.at(-2) || leaf : leaf;
});
const visibleRuns = computed(() => {
  const runs = props.conversation?.runs || [];
  const term = searchQuery.value.trim().toLowerCase();
  if (!term) return runs;
  return runs.filter((run) => [run.objective, run.result, run.error, ...(run.attachments?.map((item) => item.name) || []),
    ...(run.supplements || []).map(item => item.objective), ...run.events.map((event) => event.message)]
    .some((value) => value.toLowerCase().includes(term)));
});

watch(() => props.conversation?.id, async (id, previousId) => {
  if (previousId && messageViewport.value) scrollPositions.set(previousId, messageViewport.value.scrollTop);
  searchQuery.value = id ? searchQueries.get(id) || '' : '';
  await nextTick();
  if (!id || !messageViewport.value) return;
  messageViewport.value.scrollTop = scrollPositions.get(id) ?? messageViewport.value.scrollHeight;
}, { immediate: true });
watch(searchQuery, (value) => { if (props.conversation?.id) searchQueries.set(props.conversation.id, value); });
watch(() => props.conversation?.runs.map(run => `${run.id}:${run.updatedAt}:${run.result.length}`).join('|'), async () => {
  const viewport = messageViewport.value;
  if (!viewport || !viewport.clientHeight || searchQuery.value) return;
  const followsLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
  await nextTick();
  if (followsLatest && messageViewport.value) messageViewport.value.scrollTop = messageViewport.value.scrollHeight;
});

function rememberScroll() {
  if (props.conversation?.id && messageViewport.value) scrollPositions.set(props.conversation.id, messageViewport.value.scrollTop);
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

defineExpose({ focusComposer });

</script>

<template>
  <section class="conversation-pane" aria-label="Agent 会话窗口">
    <template v-if="conversation">
      <header class="conversation-header">
        <div class="conversation-tabs"><strong>启元</strong><span>{{ conversation.latest.provider === 'codex' ? 'Codex CLI' : 'Cursor CLI' }}</span><span>{{ modeLabel }}</span><span>{{ selectedModelLabel }}</span></div>
        <div class="conversation-actions"><StatusPill :value="pausedRun ? 'paused' : conversation.latest.status" /><el-button v-if="stoppableRun && !pausedRun" link type="danger" :loading="changing === stoppableRun.id" @click="emit('stop', stoppableRun)"><CircleStop :size="14" /> 停止</el-button><el-button v-if="conversation.latest.provider === 'codex' && conversation.latest.sessionId" link type="primary" :disabled="running || !!changing" :loading="changing === `fork:${conversation.latest.id}`" @click="emit('fork', conversation.latest)"><GitFork :size="14" /> 基于此会话新建</el-button><el-dropdown trigger="click" @command="exportConversation"><el-button link type="primary" title="导出会话"><Download :size="14" /> 导出</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="markdown">导出 Markdown</el-dropdown-item><el-dropdown-item command="json">导出 JSON</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button link type="primary" :loading="changing === `title:${conversation.id}`" @click="emit('rename', conversation)"><Pencil :size="14" /> 修改标题</el-button><el-button link type="primary" @click="emit('inspect', conversation.latest)"><Info :size="14" /> 会话信息</el-button><el-button link type="primary" :aria-pressed="pinned" @click="emit('pin', conversation)"><Pin :size="14" /> {{ pinned ? '取消置顶' : '置顶会话' }}</el-button><el-button link type="danger" :disabled="!!changing" :loading="changing === conversation.id" @click="emit('remove', conversation)"><Trash2 :size="14" /> 删除会话</el-button><el-button link type="primary" :title="leftCollapsed ? '展开会话列表' : '收起会话列表'" @click="emit('toggleLeft')"><component :is="leftCollapsed ? PanelLeftOpen : PanelLeftClose" :size="14" /></el-button><el-button link type="primary" :title="rightCollapsed ? '展开执行过程' : '收起执行过程'" @click="emit('toggleRight')"><component :is="rightCollapsed ? PanelRightOpen : PanelRightClose" :size="14" /></el-button></div>
      </header>
      <div class="conversation-context">
        <div class="context-block project-context" :title="agentRunProjectPath(conversation.latest)"><Folder :size="14" /><span><small>当前项目</small><strong>{{ workspaceLabel }}</strong></span></div>
        <div class="context-block branch-context" :title="conversation.latest.branch || '普通文件夹'"><GitBranch :size="14" /><span><small>{{ conversation.latest.isolatedWorkspace ? '基线分支' : conversation.latest.branch ? '当前分支' : '工作区类型' }}</small><strong>{{ conversation.latest.baseBranch || conversation.latest.branch || '普通文件夹' }}</strong></span></div>
        <div class="context-block workspace-context" :title="conversation.latest.workspacePath"><span><small>工作区</small><strong>{{ conversation.latest.workspacePath }}</strong></span></div>
        <AgentTerminalButton :workspace-path="conversation.latest.workspacePath" />
        <label class="message-search"><Search :size="12" /><input v-model="searchQuery" type="search" placeholder="搜索当前会话" /></label>
      </div>
      <div ref="messageViewport" class="message-viewport" aria-live="polite" @scroll.passive="rememberScroll">
        <div class="message-list">
          <div v-for="run in visibleRuns" :key="run.id" class="message-turn">
            <article class="chat-message user-message"><AgentAvatar user class="message-avatar" /><div><header><strong>你</strong><time>{{ dateTime(run.createdAt) }}</time></header><div v-if="run.attachments?.length" class="message-images"><a v-for="attachment in run.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ attachment.name }}</span></a></div><p><AgentMessageText :source="run.objective" /></p>
              <div class="message-tools user-message-tools">
                <button v-if="conversation.source !== 'codex' && (run.pausedForEdit || (!pausedRun && (run.status === 'running' || run.id === conversation.latest.id && ['queued', 'cancelled', 'interrupted', 'failed'].includes(run.status))))"
                  type="button" class="event-link" :disabled="!!changing" @click="emit('edit', run)"><Pencil :size="12" /> {{ ['running', 'queued'].includes(run.status) ? '暂停并编辑' : '编辑消息' }}</button>
                <span v-if="run.revisesRunId" class="event-link">修订后的消息</span>
                <button v-if="conversation.latest.provider === 'codex' && conversation.latest.sessionId"
                  type="button" class="event-link" :disabled="running || !!changing"
                  title="继承当前会话已完成的上下文，原会话保留不变"
                  @click="emit('fork', conversation.latest)"><GitFork :size="12" /> 基于此会话新建</button>
                <button type="button" class="message-copy" title="复制消息" @click="copyMessage(`user:${run.id}`, run.objective)"><Check v-if="copiedMessageId === `user:${run.id}`" :size="12" /><Copy v-else :size="12" /></button>
              </div>
            </div></article>
            <article v-for="supplement in run.supplements || []" :key="supplement.id" class="chat-message user-message">
              <AgentAvatar user class="message-avatar" /><div><header><strong>你 · 补充</strong><time>{{ dateTime(supplement.createdAt) }}</time></header>
                <div v-if="supplement.attachments.length" class="message-images"><a v-for="attachment in supplement.attachments" :key="attachment.id" :href="attachment.url" target="_blank" rel="noopener"><img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" /><span v-else class="message-file"><File :size="24" /></span><span>{{ attachment.name }}</span></a></div><p><AgentMessageText :source="supplement.objective" /></p>
              </div>
            </article>
            <article class="chat-message agent-message"><AgentAvatar class="message-avatar" /><div><header><strong>{{ run.provider === 'codex' ? '启元' : 'Cursor Agent' }}</strong><StatusPill :value="run.pausedForEdit ? 'paused' : run.status" /><time>{{ dateTime(run.updatedAt) }}</time></header><AgentMarkdown v-if="run.result" class="agent-result" :source="run.result" /><p v-if="run.error" class="agent-error">{{ agentRunErrorText(run) }}</p><p v-else-if="!run.result" class="agent-progress">{{ run.events.length ? latestActivity(run) : '该轮没有保存最终回复' }}</p><AgentChangedFiles v-if="run.changedFiles" :files="run.changedFiles" :run-id="run.id" /><div class="message-tools"><button v-if="run.result || run.error" type="button" class="message-copy" title="复制消息" @click="copyMessage(`agent:${run.id}`, run.result || agentRunErrorText(run))"><Check v-if="copiedMessageId === `agent:${run.id}`" :size="12" /><Copy v-else :size="12" /></button><button v-if="run.status === 'queued' && activeRun" type="button" class="event-link" :disabled="!!changing" title="停止当前轮，并提前执行此消息" @click="emit('steer', run)"><CornerUpLeft :size="12" /> 调整方向</button><button v-if="conversation.source !== 'codex' && run.status === 'queued' && run.parentRunId" type="button" class="event-link danger-link" :disabled="!!changing" title="从当前会话删除这条排队消息" @click="emit('removeQueued', run)"><Trash2 :size="12" /> {{ changing === `delete:${run.id}` ? '删除中' : '删除' }}</button><button v-if="isRestartableAgentRun(run) && !pausedRun" type="button" class="event-link" :disabled="!!changing" :title="isRetryableSessionBusyRun(run) ? '尝试续接原会话；真实运行中的任务不会被中断' : '从已保存状态重新执行该任务'" @click="emit('retry', run)"><RotateCcw :size="12" /> 重新执行</button><button v-if="run.events.length" type="button" class="event-link" @click="emit('inspect', run)">{{ run.events.length }} 条运行事件</button></div></div></article>
          </div>
          <div v-if="!conversation.loaded" class="history-loading"><el-skeleton :rows="2" animated /></div>
          <el-empty v-if="searchQuery && !visibleRuns.length" description="当前会话没有匹配内容" :image-size="56" />
        </div>
      </div>
      <AgentComposer v-if="!pausedRun" ref="composer" v-model="draft" v-model:attachments="attachments" :conversation="conversation" :runtimes="runtimes" :changing="changing" :running="running" :can-insert="!!activeRun?.liveInputReady"
        :business-options="businessOptions"
        @send="emit('send', $event)" @stop="stoppableRun && emit('stop', stoppableRun)" @configure-models="emit('configureModels')" />
      <div v-if="pausedRun" class="paused-editor"><span>会话已暂停，等待编辑后继续</span><el-button type="primary" :disabled="!!changing" @click="emit('edit', pausedRun)"><Pencil :size="14" /> 编辑消息</el-button></div>
    </template>
    <el-empty v-else description="选择左侧会话，或新建一个 Agent 会话" :image-size="70" />
  </section>
</template>

<style scoped>
.paused-editor{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 24px;border-top:1px solid var(--agent-border);background:var(--agent-panel);color:var(--agent-muted);font-size:12px}
.user-message-tools{justify-content:flex-end;flex-wrap:wrap}.user-message .user-message-tools .message-copy{position:static}
.danger-link{border-color:color-mix(in srgb,var(--el-color-danger) 56%,var(--agent-border));background:color-mix(in srgb,var(--el-color-danger) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--el-color-danger) 68%,#fff)}
.message-images .message-file{display:grid;place-items:center;width:92px;height:72px;border:1px solid #ffffff4d;border-radius:7px;background:#252c39;color:#b9b4ff;opacity:1}
.conversation-pane{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background:transparent;color:var(--agent-text)}.conversation-header{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:58px;padding:0 22px;border-bottom:1px solid var(--agent-border);background:color-mix(in srgb,var(--agent-panel) 90%,transparent);backdrop-filter:blur(16px)}.conversation-tabs{display:flex;align-items:center;gap:7px;min-width:0}.conversation-tabs strong,.conversation-tabs span{padding:5px 10px;border:1px solid transparent;border-radius:7px;font-size:10px;white-space:nowrap}.conversation-tabs strong{background:linear-gradient(120deg,var(--agent-cyan),var(--agent-accent));color:#fff;box-shadow:0 5px 16px color-mix(in srgb,var(--agent-accent) 25%,transparent)}.conversation-tabs span{color:var(--agent-muted);background:var(--agent-panel-strong)}.conversation-tabs span:last-child{max-width:190px;overflow:hidden;border-color:color-mix(in srgb,var(--agent-accent) 44%,var(--agent-border));color:var(--agent-secondary);background:var(--agent-raised);text-overflow:ellipsis}.conversation-actions{display:flex;align-items:center;gap:3px;flex-shrink:0}.conversation-actions:deep(.el-button){height:30px;margin-left:0;padding:5px 7px;border-radius:7px;color:color-mix(in srgb,var(--agent-accent) 48%,#dce8ff);font-size:10px}.conversation-actions:deep(.el-button:hover){background:var(--agent-panel-strong)}.conversation-context{display:flex;align-items:center;gap:8px;min-height:56px;padding:6px 22px;border-bottom:1px solid var(--agent-border);overflow:hidden;background:color-mix(in srgb,var(--agent-panel) 78%,transparent)}.context-block{display:flex;align-items:center;gap:8px;min-width:0;height:40px;padding:0 11px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong);color:var(--agent-muted)}.context-block>span{display:grid;min-width:0;gap:2px}.context-block small{color:var(--agent-muted);font-size:8px;line-height:1}.context-block strong{overflow:hidden;color:var(--agent-text);font-size:10px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.project-context{width:150px;flex:0 0 auto}.branch-context{width:min(34%,310px);border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong))}.branch-context svg{flex:0 0 auto;color:var(--agent-accent)}.workspace-context{flex:1}.message-search{display:flex;align-items:center;width:180px;height:32px;margin-left:auto;padding:0 9px;flex-shrink:0;border:1px solid var(--agent-border);border-radius:7px;background:var(--agent-panel-strong);color:var(--agent-muted)}.message-search:focus-within{border-color:var(--agent-accent);color:var(--agent-accent)}.message-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--agent-text);font-size:9px}.message-search input::placeholder{color:var(--agent-muted)}
.message-viewport{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:30px clamp(24px,3vw,52px) 22px;background-color:var(--agent-bg);background-image:linear-gradient(var(--agent-wallpaper-chat-shade),var(--agent-wallpaper-chat-shade)),radial-gradient(circle at 50% -8%,color-mix(in srgb,var(--agent-accent) 16%,transparent) 0,transparent 43%),var(--agent-wallpaper);background-position:center,center,var(--agent-wallpaper-position);background-size:auto,auto,cover;background-repeat:no-repeat;background-attachment:scroll}.message-list{display:flex;flex-direction:column;gap:28px;width:min(100%,1180px);min-height:100%;margin:0 auto}.message-turn{display:flex;flex-direction:column;gap:15px}.message-turn:first-child{margin-top:auto}.chat-message{display:flex;align-items:flex-start;gap:11px}.chat-message>div{position:relative;min-width:0;max-width:min(88%,960px);backdrop-filter:blur(10px)}.message-avatar{display:grid;place-items:center;width:32px;height:32px;flex-shrink:0;border:1px solid var(--agent-border);border-radius:9px;background:var(--agent-panel-strong);color:var(--agent-accent);box-shadow:0 6px 18px #0003}.chat-message header{display:flex;align-items:center;gap:8px;margin:0 0 8px}.chat-message header strong{font-size:10px;letter-spacing:.1px}.chat-message time{font:8px var(--mono);color:var(--agent-muted)}.chat-message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.76}.user-message{justify-content:flex-end}.user-message>div{order:-1;padding:12px 38px 12px 16px;border:1px solid color-mix(in srgb,var(--agent-cyan) 46%,transparent);border-radius:14px 4px 14px 14px;background:linear-gradient(125deg,color-mix(in srgb,var(--agent-cyan) var(--agent-message-opacity),transparent),color-mix(in srgb,var(--agent-accent) var(--agent-message-opacity),transparent));color:#fff;box-shadow:0 10px 28px color-mix(in srgb,var(--agent-accent) 22%,transparent)}.user-message header{justify-content:flex-end}.user-message header strong,.user-message time{color:#fff}.user-message time{opacity:.72}.user-message .message-avatar{border-color:var(--agent-border);background:var(--agent-panel-strong);color:var(--agent-cyan)}.user-message .message-copy{position:absolute;right:9px;bottom:8px;color:#fff}.agent-message>div{width:min(88%,960px);padding:15px 17px;border:1px solid var(--agent-border);border-radius:4px 14px 14px;background:linear-gradient(145deg,color-mix(in srgb,var(--agent-raised) var(--agent-message-opacity),transparent),color-mix(in srgb,var(--agent-panel-strong) var(--agent-message-opacity),transparent));box-shadow:0 12px 32px #0003}.agent-message header time{margin-left:auto}.agent-result{color:var(--agent-text)}.agent-error{color:#ff9aac}.agent-progress{color:var(--agent-muted)}.message-tools{display:flex;align-items:center;gap:7px;margin-top:10px}.message-copy{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--agent-muted);cursor:pointer}.message-copy:hover{border-color:var(--agent-border);background:var(--agent-raised);color:#fff}.event-link{display:inline-flex;align-items:center;gap:4px;margin:0;padding:4px 7px;border:1px solid color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--agent-accent) 45%,#fff);font-size:9px;cursor:pointer;transition:.16s ease}.event-link:hover{border-color:var(--agent-accent);background:var(--agent-raised);color:#fff}.event-link:disabled{cursor:not-allowed;opacity:.45}
.message-images{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 9px}.message-images a{display:grid;gap:3px;width:92px;color:#fff;text-decoration:none}.message-images img{display:block;width:92px;height:72px;border:1px solid #ffffff4d;border-radius:7px;object-fit:cover}.message-images span{overflow:hidden;font-size:8px;opacity:.8;text-overflow:ellipsis;white-space:nowrap}
.user-message p:deep(a){color:#fff;text-decoration:underline;text-underline-offset:3px}
.history-loading{width:min(100%,980px);margin:0 auto}.history-loading:deep(.el-skeleton__item){background:var(--agent-panel-strong)}
.conversation-pane:deep(.el-empty){margin:auto}.conversation-pane:deep(.el-empty__description p){color:var(--agent-muted)}.conversation-pane:deep(.status-pill){padding:3px 8px;background:#1d342d;color:#69ddb2;font-size:9px}
@media(max-width:1440px){.workspace-context{display:none}.project-context{width:130px}.branch-context{width:auto;flex:1}.message-search{width:150px}}
@media(max-width:1600px){.conversation-header{flex-wrap:wrap;gap:8px;padding:12px 16px}.conversation-tabs{flex-wrap:wrap;gap:5px}.conversation-actions{flex-wrap:wrap;gap:4px;max-width:100%}.conversation-context{flex-wrap:wrap;padding:8px 16px}.message-search{flex:1;min-width:140px}.branch-context{flex:1;min-width:160px}.workspace-context{min-width:160px}}
</style>

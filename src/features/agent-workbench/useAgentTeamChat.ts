import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { AgentAttachment } from '../../../shared/agent-runtime';
import { createRequestId } from '../requirement-development/request-id';
import { answerTeamMessage, decideTeamTask, readTeamRoom, readTeamTasks, sendTeamChat, type TeamRoom, type TeamChatRequest, type TeamChatResponse, type TeamDecision } from './team-api';
import { isChatTask, teamChatActiveStates, teamChatRequestKey, teamQuestionReply } from './team-chat';

/** 团队聊天常驻读状态，不以高级弹窗是否打开为前置。切会话使用独立查询键，避免串回旧房间。 */
export function useAgentTeamChat(conversationId: () => string) {
  const client = useQueryClient(), changing = shallowRef(''), scope = ['agent-team-chat'];
  const attachments = shallowRef<Record<string, AgentAttachment>>({});
  const tasksQuery = useQuery({ queryKey: [...scope, 'tasks'], retry: false, refetchInterval: 3000,
    queryFn: ({ signal }) => readTeamTasks(signal) });
  const allTasks = computed(() => (tasksQuery.data.value || []).filter(isChatTask));
  const tasks = computed(() => allTasks.value.filter(task => task.parentConversationId === conversationId())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)));
  const latestTask = computed(() => tasks.value.at(-1));
  const roomQuery = useQuery({ queryKey: computed(() => [...scope, 'room', latestTask.value?.id || '']),
    enabled: computed(() => !!latestTask.value?.id), retry: false, refetchInterval: 3000,
    queryFn: ({ signal }) => readTeamRoom(latestTask.value!.id, signal) });
  const room = computed(() => roomQuery.data.value?.task.id === latestTask.value?.id ? roomQuery.data.value : undefined);
  const task = computed(() => room.value?.task || latestTask.value);
  const active = computed(() => !!task.value && teamChatActiveStates.has(task.value.state));
  let source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  function refresh() {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void client.invalidateQueries({ queryKey: scope }); }, 100);
  }
  onMounted(() => {
    if (typeof EventSource === 'undefined') return;
    source = new EventSource('/api/agent-runtimes/team-tasks/events');
    for (const type of ['ready', 'workflow.updated', 'workflow.message', 'workflow.intent', 'workflow.decision']) source.addEventListener(type, refresh);
  });
  onUnmounted(() => { source?.close(); if (timer) clearTimeout(timer); void client.cancelQueries({ queryKey: scope }); });
  const requestIds = new Map<string, string>();
  async function send(input: Omit<TeamChatRequest, 'requestId'>, files: AgentAttachment[] = [], scopeId = input.taskId || input.parentRunId || 'new'): Promise<TeamChatResponse | undefined> {
    if (changing.value) return;
    const key = teamChatRequestKey(input, scopeId);
    const requestId = requestIds.get(key) || createRequestId(); requestIds.set(key, requestId);
    changing.value = 'team-chat';
    try {
      const result = await sendTeamChat({ ...input, requestId });
      attachments.value = { ...attachments.value, ...Object.fromEntries(files.map(file => [file.id, file])) };
      client.setQueryData([...scope, 'tasks'], (current: unknown) => [result.task,
        ...(Array.isArray(current) ? current.filter(task => task.id !== result.task.id) : [])]);
      requestIds.delete(key); refresh(); return result;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '消息发送失败'); }
    finally { changing.value = ''; }
  }
  async function decide(action: TeamDecision) {
    if (!task.value || changing.value) return;
    const id = task.value.id; changing.value = `team-${action}`;
    try { await decideTeamTask(id, { action, requestId: createRequestId() }); refresh(); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '团队操作失败'); }
    finally { changing.value = ''; }
  }
  async function command(objective: '暂停任务' | '继续执行') {
    if (!task.value || changing.value) return;
    return send({ taskId: task.value.id, objective, attachmentIds: [] }, [], conversationId());
  }
  async function answer(input: { taskId: string; questionId: string; text: string; attachmentIds?: string[] }, files: AgentAttachment[] = []) {
    if (changing.value || !input.text.trim()) return false;
    if (teamQuestionReply(allTasks.value, input, room.value)?.state !== 'pending') {
      ElMessage.error('该问题已回答或已过期，请重新选择要回复的问题'); return false;
    }
    const key = JSON.stringify(['answer', input]);
    const requestId = requestIds.get(key) || createRequestId(); requestIds.set(key, requestId);
    changing.value = `answer:${input.questionId}`;
    try {
      const result = await answerTeamMessage(input.taskId, { correlationId: input.questionId, text: input.text, requestId,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}) });
      attachments.value = { ...attachments.value, ...Object.fromEntries(files.map(file => [file.id, file])) };
      client.setQueryData<TeamRoom>([...scope, 'room', input.taskId], result);
      requestIds.delete(key); refresh(); return true;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '回复失败，内容已保留'); return false; }
    finally { changing.value = ''; }
  }
  return { allTasks, tasks, task, room, active, changing, attachments, send, decide, command, answer, refresh,
    refetch: () => tasksQuery.refetch(),
    error: computed(() => tasksQuery.error.value || roomQuery.error.value) };
}

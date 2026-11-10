/** Agent 运行只通过固定后端协议启停；页面刷新只读取状态，不会触发 CLI。 */
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { agentProviderLabels, codexWorkbenchDefaults } from '../../../shared/agent-runtime';
import { agentModelDefaults } from '../../shared/agent-model-defaults';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AgentAccessMode, AgentConversationDeleteResult, AgentCustomModelInput, AgentQueuePlacement, AgentReasoningEffort, AgentRun, AgentRunMode, AgentRuntimeDashboard, AgentServiceTier, CodexSessionDetail, SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput, AgentWorkflowAction, AgentWorkflowSummary } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';
import type { AdvancedTeamTask } from './team-api';
import { createRuntimeRefresh, createRuntimeStreamState } from './runtime-stream-state';
import { createRequestId } from '../requirement-development/request-id';

function eventRevision(event: Event) {
  try { return Number(JSON.parse((event as MessageEvent<string>).data || '{}').revision || 0); }
  catch { return 0; }
}

export function useAgentRuntimes() {
  const client = useQueryClient();
  const changing = shallowRef('');
  const refreshing = shallowRef(false);
  const streamConnected = shallowRef(false);
  const streamStatus = shallowRef<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const streamRevision = shallowRef(0);
  const codexDetails = shallowRef<Record<string, CodexSessionDetail>>({});
  const streamState = createRuntimeStreamState();
  let forceRefresh = false;
  const snapshotQuery = useQuery({ queryKey: ['agent-runtimes'], retry: false, refetchInterval: () => streamConnected.value ? 60_000 : 15_000,
    queryFn: async ({ signal }): Promise<AgentRuntimeDashboard> => {
      const response = await fetch('/api/agent-runtimes?status=0', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Agent 执行器状态读取失败');
      return streamState.snapshot(data);
    },
  });
  type RuntimeStatus = Pick<AgentRuntimeDashboard, 'runtimeStatusVersion' | 'runtimes' | 'codexUsage' | 'apiUsage' | 'cursorUsage' | 'claudeUsage' | 'antigravityUsage'>;
  const statusQuery = useQuery<RuntimeStatus>({ queryKey: ['agent-runtime-status'], retry: false, refetchInterval: query => {
    const usage = query.state.data?.codexUsage;
    return !usage || usage.stale || ['timeout', 'network'].includes(usage.errorKind || '') ? 10_000 : 60_000;
  },
    queryFn: async ({ signal }): Promise<RuntimeStatus> => {
      const force = forceRefresh; forceRefresh = false;
      const response = await fetch(`/api/agent-runtimes/status${force ? '?refresh=1' : ''}`, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Agent 执行器状态读取失败');
      return data;
    },
  });
  // 连接和额度的慢请求只投影状态字段，不能阻塞首屏或覆盖 SSE 正文。
  const query = { ...snapshotQuery, data: computed(() => {
    const snapshot = snapshotQuery.data.value, status = statusQuery.data.value;
    if (!snapshot || !status) return snapshot;
    // 账号维护或模型配置已推进时，旧连接结果和额度不能盖回最新快照。
    if ((status.runtimeStatusVersion || 0) < (snapshot.runtimeStatusVersion || 0)) return snapshot;
    const { runtimes, codexUsage, apiUsage, cursorUsage, claudeUsage, antigravityUsage } = status;
    return { ...snapshot, runtimeStatusVersion: status.runtimeStatusVersion ?? snapshot.runtimeStatusVersion,
      runtimes, codexUsage, apiUsage, cursorUsage, claudeUsage, antigravityUsage };
  }) };
  async function reloadStatus() {
    // 初次查询中的 refetch 会复用旧请求；取消后确保回读最新账号和模型目录。
    await client.cancelQueries({ queryKey: ['agent-runtime-status'], exact: true });
    forceRefresh = true;
    return (await statusQuery.refetch({ throwOnError: true })).data;
  }
  async function refreshStatus() {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
      const status = await reloadStatus();
      const usage = [status?.codexUsage, status?.antigravityUsage].find(item => item && (!item.available || item.stale));
      if (!status?.codexUsage) ElMessage.warning('连接状态已变化，额度尚未更新，请刷新重试');
      else if (usage) ElMessage.warning(usage.message || '额度暂未更新');
      else ElMessage.success('连接与额度已刷新');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '连接与额度刷新失败'); }
    finally { refreshing.value = false; }
  }
  let eventSource: EventSource | undefined;
  const refresh = createRuntimeRefresh(async () => {
    const result = await query.refetch({ cancelRefetch: false });
    if (result.data && (result.data.revision || 0) < streamRevision.value) refresh.request();
  });
  onMounted(() => {
    eventSource = new EventSource('/api/agent-runtimes/events?updates=runs');
    eventSource.addEventListener('open', () => { streamConnected.value = true; streamStatus.value = 'connected'; });
    eventSource.addEventListener('error', () => { streamConnected.value = false; streamStatus.value = 'reconnecting'; });
    eventSource.addEventListener('ready', (event) => {
      const revision = eventRevision(event);
      if (revision) streamRevision.value = revision;
      refresh.request();
    });
    eventSource.addEventListener('refresh', (event) => {
      const revision = eventRevision(event);
      if (revision) streamRevision.value = revision;
      refresh.request();
    });
    eventSource.addEventListener('runs', (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as { revision: number; runs: AgentRun[] };
        if (!Number.isFinite(update.revision) || !Array.isArray(update.runs)) return;
        streamRevision.value = Math.max(streamRevision.value, update.revision);
        client.setQueryData<AgentRuntimeDashboard>(['agent-runtimes'], (current) => streamState.receive(update.revision, update.runs, current));
      } catch { refresh.request(); }
    });
  });
  onUnmounted(() => {
    refresh.close();
    eventSource?.close();
  });
  async function post(path: string, body: unknown, refresh = true) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Agent 操作失败');
    if (refresh) await query.refetch();
    return data;
  }
  async function start(input: StartAgentRunInput) {
    if (changing.value) return undefined;
    // 确认框显示的目录与实际提交保持一致，避免等待确认期间表单变化改变执行范围。
    input = { ...input, attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined };
    try {
      const mode = input.mode === 'agent' ? 'Agent 执行' : input.mode === 'plan' ? '只读方案分析' : '只读问答';
      const boundary = input.mode !== 'agent' ? '不会修改工作区或外部系统。'
        : input.accessMode === 'full' ? '已选择完全访问，可访问工作区外的本机文件和网络；提交、推送或写入外部系统需在任务中明确要求。'
          : input.provider === 'kiro' ? '仅可读取和修改所选工作区文件，不执行命令。'
            : input.provider === 'antigravity' ? '可读取和修改所选工作区文件，并在沙箱内运行命令；网络和工作区外访问仍受权限限制。'
            : '可修改所选工作区并运行必要命令；提交、推送或写入外部系统需在任务中明确要求。';
      const workspaceContext = input.branch ? `以分支 ${input.branch}` : input.workspacePath ? '在所选本地文件夹' : '在自动创建的独立会话目录';
      const branchHint = input.isolateWorkspace && input.branch
        ? '创建隔离工作区；不会切换或修改原目录。'
        : input.branch ? '若与当前分支不同，确认后将先切换分支。' : '';
      const confirmBody = [
        `执行：${agentProviderLabels[input.provider]} · ${input.model || '默认模型'}`,
        `${workspaceContext}，${mode}。`,
        ...(branchHint ? [branchHint.trim()] : []),
        '',
        boundary.trim(),
      ].join('\n');
      await ElMessageBox.confirm(confirmBody,
        input.continueConversationId ? '切换当前对话的执行器' : '启动 Agent', { type: 'warning', confirmButtonText: '确认启动', cancelButtonText: '取消', closeOnClickModal: false });
    } catch { return undefined; }
    changing.value = 'start';
    try {
      const run = await post('/api/agent-runtimes/runs', { ...input,
        branch: input.branch?.trim() || undefined }) as AgentRun;
      ElMessage.success(input.continueConversationId ? run.status === 'queued' ? '消息已排队，等待切换执行器继续当前对话' : '已在当前对话切换执行器'
        : run.status === 'queued' ? '新 Agent 已创建，等待当前工作区任务完成'
        : run.isolatedWorkspace ? '隔离工作区已创建，Agent 已启动' : 'Agent 已启动');
      return run;
    }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function spawn(parent: AgentRun, input: SpawnAgentTaskInput) {
    if (changing.value) return undefined;
    changing.value = `spawn:${parent.id}`;
    try {
      const run = await post(`/api/agent-runtimes/runs/${parent.id}/spawn`, input) as AgentRun;
      ElMessage.success(run.status === 'queued' && input.dependsOnConversationIds.length
        ? '协作 Agent 已创建，等待前置任务完成' : '协作 Agent 已创建并开始执行');
      return run;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function orchestrate(parent: AgentRun, input: StartAgentTaskWorkflowInput) {
    if (changing.value) return undefined;
    changing.value = `orchestrate:${parent.id}`;
    try {
      const result = await post(`/api/agent-runtimes/runs/${parent.id}/orchestrate`, input, false) as
        { worker: AgentRun; reviewer: AgentRun } | { workflowId: string; firstRun: AgentRun };
      ElMessage.success('workflowId' in result ? '团队流程已启动：实现完成后自动在副本中验证，再交给另一家模型审查'
        : '工作流已启动：实现完成后将自动进入复核');
      // 统一返回首个执行节点，调用方据此切换会话。
      return { ...result, firstRun: 'workflowId' in result ? result.firstRun : result.worker };
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function decideWorkflow(workflowId: string, action: AgentWorkflowAction) {
    if (changing.value) return undefined;
    changing.value = `workflow:${workflowId}`;
    try {
      const summary = await post(`/api/agent-runtimes/workflows/${workflowId}/decision`, { action, requestId: createRequestId() }) as AgentWorkflowSummary;
      ElMessage.success(action === 'cancel' ? '团队流程已取消，已有改动保留' : action === 'takeover' ? '已由你接手，流程不再自动推进' : '已提交决定，流程继续推进');
      return summary;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function stop(run: AgentRun) {
    if (changing.value) return;
    try { await ElMessageBox.confirm('将停止该本机 CLI 进程；已生成的结果和会话 ID 会保留。', '停止 Agent',
      { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消', closeOnClickModal: false }); }
    catch { return; }
    changing.value = run.id;
    try { await post(`/api/agent-runtimes/runs/${run.id}/stop`, {}); ElMessage.success('正在停止 Agent'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  async function steer(run: AgentRun) {
    if (changing.value || run.status !== 'queued') return;
    changing.value = `steer:${run.id}`;
    try {
      await post(`/api/agent-runtimes/runs/${run.id}/steer`, {});
      ElMessage.success('已调整方向，正在停止当前轮并提前执行此消息');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  async function deleteQueuedRun(run: AgentRun) {
    if (changing.value || run.status !== 'queued' || !run.parentRunId) return false;
    changing.value = `delete:${run.id}`;
    try {
      await ElMessageBox.confirm('将从当前会话删除这条排队消息，删除后不会执行；当前正在运行和后续排队的消息不受影响。', '删除排队消息',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false });
      await post(`/api/agent-runtimes/runs/${run.id}/delete`, {});
      ElMessage.success('排队消息已删除');
      return true;
    } catch (error) {
      if (error instanceof Error && error.message !== 'cancel') ElMessage.error(error.message);
      return false;
    } finally { changing.value = ''; }
  }
  async function pauseForEdit(run: AgentRun) {
    if (changing.value) return undefined;
    changing.value = `edit:${run.id}`;
    try {
      if (!run.pausedForEdit && ['running', 'queued'].includes(run.status)) {
        try { await ElMessageBox.confirm('将暂停当前会话执行及排队消息，再编辑这条消息。已有结果、附件和文件改动会保留，不会回滚。', '暂停并编辑',
          { type: 'warning', confirmButtonText: '暂停并编辑', cancelButtonText: '取消', closeOnClickModal: false }); }
        catch { return undefined; }
      }
      return await post(`/api/agent-runtimes/runs/${run.id}/pause-edit`, {}) as AgentRun;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function revise(run: AgentRun, objective: string) {
    if (changing.value || (!objective.trim() && !run.attachments?.length)) return undefined;
    changing.value = `revise:${run.id}`;
    try {
      const next = await post(`/api/agent-runtimes/runs/${run.id}/revise`, { objective: objective.trim() }, false) as AgentRun;
      ElMessage.success('已按编辑后的内容继续，原消息和结果保留');
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function retry(run: AgentRun, selection?: Pick<AgentRun, 'mode' | 'accessMode'>) {
    if (changing.value) return undefined;
    run = { ...run };
    selection = selection ? { ...selection } : undefined;
    changing.value = `retry:${run.id}`;
    try {
      if (run.recovery && run.recovery.state !== 'resumed') {
        try { await ElMessageBox.confirm(`将继续原任务：${run.objective}\n工作区：${run.workspacePath}\n原会话：${run.sessionId || '排队时尚未取得'}\n请确认已核对已有结果和外部操作，继续可能重复执行原指令。`,
          '确认中断任务恢复', { type: 'warning', confirmButtonText: '已核对，继续', cancelButtonText: '取消', closeOnClickModal: false }); }
        catch { return undefined; }
      }
      const next = await post(`/api/agent-runtimes/runs/${run.id}/retry`, { ...selection }, false) as AgentRun;
      ElMessage.success(next.id === run.id ? '已提交原轮次续跑' : next.sessionId ? '已从保存的 CLI 会话继续执行' : '已重新启动该任务');
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function resume(run: AgentRun, objective: string, model: string, reasoningEffort: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = run.accessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier, mode?: AgentRunMode) {
    if (changing.value || (!objective.trim() && !attachmentIds.length)) return undefined;
    changing.value = run.id;
    try { const next = await post(`/api/agent-runtimes/runs/${run.id}/resume`, { objective: objective.trim(), model, reasoningEffort,
      attachmentIds, accessMode, queuePlacement, serviceTier, ...(mode ? { mode } : {}) }, false) as AgentRun;
      if (next.status === 'queued') ElMessage.success('消息已发送，正在排队');
      return next; }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function resumeCodexSession(sessionId: string, objective: string, model: string, reasoningEffort: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = 'full', serviceTier?: AgentServiceTier) {
    if (changing.value || (!objective.trim() && !attachmentIds.length)) return undefined;
    changing.value = sessionId;
    try {
      const next = await post(`/api/agent-runtimes/codex-sessions/${sessionId}/resume`,
        { objective: objective.trim(), model, reasoningEffort, attachmentIds, accessMode, serviceTier }, false) as AgentRun;
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function fork(run: AgentRun, objective: string, attachmentIds: string[] = []) {
    if (changing.value || run.provider !== 'codex' || !run.sessionId || (!objective.trim() && !attachmentIds.length)) return undefined;
    changing.value = `fork:${run.id}`;
    try {
      const next = await post(`/api/agent-runtimes/runs/${run.id}/fork`, {
        objective: objective.trim(), ...codexWorkbenchDefaults,
        ...((agentModelDefaults.value.provider || 'codex') === 'codex'
          ? { model: agentModelDefaults.value.model, reasoningEffort: agentModelDefaults.value.reasoningEffort } : {}), attachmentIds,
      }, false) as AgentRun;
      ElMessage.success('已基于原上下文创建新会话');
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function syncCodexSessions() {
    if (changing.value) return;
    changing.value = 'codex:sync';
    try {
      const state = await post('/api/agent-runtimes/codex-sessions/sync', {}) as { total: number };
      codexDetails.value = {};
      await query.refetch();
      ElMessage.success(`已同步 ${state.total} 个 Codex 会话`);
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  async function loadCodexSession(id: string) {
    if (codexDetails.value[id]) return codexDetails.value[id];
    const response = await fetch(`/api/agent-runtimes/codex-sessions/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Codex 会话历史读取失败');
    codexDetails.value = { ...codexDetails.value, [id]: data as CodexSessionDetail };
    return data as CodexSessionDetail;
  }
  async function removeConversation(conversationId: string, source: 'workspace' | 'codex') {
    if (changing.value) return false;
    changing.value = conversationId;
    const message = source === 'codex'
      ? '将从 Delivery Workspace 隐藏该会话；不会删除 Codex 中的原会话和历史记录。'
      : '将停止该会话中运行和排队的任务，再从 Delivery Workspace 删除该会话及全部续聊记录。不会删除工作区文件或 CLI 本机历史。';
    try { await ElMessageBox.confirm(message, '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false }); }
    catch { changing.value = ''; return false; }
    try {
      const path = source === 'codex' ? `/api/agent-runtimes/codex-sessions/${conversationId}/delete`
        : `/api/agent-runtimes/conversations/${conversationId}/delete`;
      await post(path, {});
      void client.invalidateQueries({ queryKey: ['requirement-development'] });
      if (source === 'codex') {
        const details = { ...codexDetails.value };
        delete details[conversationId];
        codexDetails.value = details;
      }
      ElMessage.success('会话已删除');
      return true;
    }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return false; }
    finally { changing.value = ''; }
  }
  async function updateConversationTitle(conversationId: string, title: string) {
    if (changing.value || !title.trim()) return false;
    changing.value = `title:${conversationId}`;
    try {
      await post(`/api/agent-runtimes/conversations/${conversationId}/title`, { title: title.trim() });
      ElMessage.success('会话标题已修改');
      return true;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return false; }
    finally { changing.value = ''; }
  }
  async function removeConversations(conversations: Pick<AgentConversation, 'id' | 'source' | 'teamChat'>[]) {
    if (changing.value || !conversations.length) return [];
    const targets = [...new Map(conversations.map(({ id, source }) => [`${source}:${id}`, { id, source }])).values()];
    const linkedTeamIds = new Set(conversations.filter(item => item.source === 'workspace' && item.teamChat).map(item => item.id));
    changing.value = 'conversations:delete';
    try {
      try {
        await ElMessageBox.confirm(`将删除选中的 ${targets.length} 个会话。将停止这些会话中的运行和排队任务；Codex 本机会话仅从工作台隐藏。不会删除工作区文件或 CLI 本机历史。`, '批量删除会话',
          { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false });
      } catch { return []; }
      let result: AgentConversationDeleteResult;
      try {
        result = await post('/api/agent-runtimes/conversations/delete-batch', { targets }, false) as AgentConversationDeleteResult;
      } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : String(error));
        void query.refetch({ cancelRefetch: false });
        return [];
      }
      const { removed, failures } = result;
      if (removed.length) {
        void client.invalidateQueries({ queryKey: ['requirement-development'] });
        const details = { ...codexDetails.value };
        for (const conversation of removed) if (conversation.source === 'codex') delete details[conversation.id];
        codexDetails.value = details;
        // 后续单 Agent 消息可以盖过团队展示，缓存中的旧团队任务仍可能重建被删会话。
        const teamTasks = client.getQueryData<AdvancedTeamTask[]>(['agent-team-chat', 'tasks']);
        const refreshTeam = removed.some(({ id, source }) => source === 'workspace' && (linkedTeamIds.has(id)
          || !teamTasks || teamTasks.some(task => !!task.chat && task.parentConversationId === id)));
        const refreshes = await Promise.allSettled([query.refetch({ throwOnError: true }), refreshTeam
          ? client.invalidateQueries({ queryKey: ['agent-team-chat'] }, { throwOnError: true }) : undefined]);
        if (refreshes.some(refresh => refresh.status === 'rejected')) ElMessage.error('会话已删除，列表刷新失败，请刷新页面。');
      }
      if (failures.length) ElMessage.error(`已删除 ${removed.length} 个会话，${failures.length} 个删除失败：${failures[0].message}`);
      else ElMessage.success(`已删除 ${removed.length} 个会话`);
      return removed;
    } finally { changing.value = ''; }
  }
  async function addCustomModel(input: AgentCustomModelInput) {
    if (changing.value) return;
    changing.value = 'model:add';
    try { await post('/api/agent-runtimes/models', input); await reloadStatus(); ElMessage.success('自定义模型已添加'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  async function removeCustomModel(id: string) {
    if (changing.value) return;
    try { await ElMessageBox.confirm('仅删除工作台中的自定义模型及其本机 API 配置，不会修改 CLI 配置。', '删除自定义模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false }); }
    catch { return; }
    changing.value = `model:${id}`;
    try { await post(`/api/agent-runtimes/models/${id}/delete`, {}); await reloadStatus(); ElMessage.success('自定义模型已删除'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  return { query, refreshStatus, refreshing, changing, streamConnected, streamStatus, streamRevision, codexDetails, start, spawn, orchestrate, decideWorkflow, stop, pauseForEdit, revise, steer, deleteQueuedRun, retry, resume, resumeCodexSession, fork, syncCodexSessions, loadCodexSession,
    removeConversation, removeConversations, updateConversationTitle, addCustomModel, removeCustomModel };
}

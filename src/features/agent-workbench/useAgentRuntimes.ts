/** Agent 运行只通过固定后端协议启停；页面刷新只读取状态，不会触发 CLI。 */
import { onMounted, onUnmounted, shallowRef } from 'vue';
import { codexWorkbenchDefaults } from '../../../shared/agent-runtime';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AgentAccessMode, AgentCustomModelInput, AgentQueuePlacement, AgentReasoningEffort, AgentRun, AgentRuntimeDashboard, AgentServiceTier, CodexSessionDetail, SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput } from '../../../shared/agent-runtime';
import { createRuntimeRefresh, createRuntimeStreamState } from './runtime-stream-state';

function eventRevision(event: Event) {
  try { return Number(JSON.parse((event as MessageEvent<string>).data || '{}').revision || 0); }
  catch { return 0; }
}

export function useAgentRuntimes() {
  const client = useQueryClient();
  const changing = shallowRef('');
  const streamConnected = shallowRef(false);
  const streamStatus = shallowRef<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const streamRevision = shallowRef(0);
  const codexDetails = shallowRef<Record<string, CodexSessionDetail>>({});
  const streamState = createRuntimeStreamState();
  const query = useQuery({ queryKey: ['agent-runtimes'], retry: false, refetchInterval: () => streamConnected.value ? 60_000 : 15_000,
    queryFn: async ({ signal }): Promise<AgentRuntimeDashboard> => {
      const response = await fetch('/api/agent-runtimes', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Agent 执行器状态读取失败');
      return streamState.snapshot(data);
    },
  });
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
    if (refresh) await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['agent-runtimes'] })]);
    return data;
  }
  async function start(input: StartAgentRunInput) {
    if (changing.value) return undefined;
    // 确认框显示的目录与实际提交保持一致，避免等待确认期间表单变化扩大信任范围。
    input = { ...input, attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined };
    try {
      const mode = input.mode === 'agent' ? 'Agent 执行' : input.mode === 'plan' ? '只读方案分析' : '只读问答';
      const boundary = input.mode !== 'agent' ? '不会修改工作区或外部系统。'
        : input.accessMode === 'full' ? '已选择完全访问，可访问工作区外的本机文件和网络；提交、推送或写入外部系统需在任务中明确要求。'
          : '可修改所选工作区并运行必要命令；提交、推送或写入外部系统需在任务中明确要求。';
      const workspaceContext = input.branch ? `以分支 ${input.branch}` : input.workspacePath ? '在所选本地文件夹' : '在自动创建的独立会话目录';
      const branchHint = input.isolateWorkspace && input.branch
        ? '创建隔离工作区；不会切换或修改原目录。'
        : input.branch ? '若与当前分支不同，确认后将先切换分支。' : '';
      const trustHint = input.provider === 'cursor'
        ? input.workspacePath
          ? `同时授权 Cursor 信任${input.isolateWorkspace ? '从以下目录创建的本次隔离工作区' : '以下工作区'}及其子目录：${input.workspacePath}。会读取其中的项目规则；不改变上述访问权限，不自动批准全部 MCP。`
          : '同时授权 Cursor 信任本次自动创建的独立会话目录；不信任其他项目，不改变上述访问权限，不自动批准全部 MCP。'
        : '';
      await ElMessageBox.confirm(`将通过本机 ${input.provider === 'codex' ? 'Codex' : 'Cursor'} CLI 以 ${input.model || '默认模型'} ${workspaceContext}启动${mode}。${branchHint}${boundary}${trustHint}`,
        '启动 Agent', { type: 'warning', confirmButtonText: input.provider === 'cursor' ? '信任并启动' : '确认启动', cancelButtonText: '取消', closeOnClickModal: false });
    } catch { return undefined; }
    changing.value = 'start';
    try {
      const run = await post('/api/agent-runtimes/runs', { ...input,
        branch: input.branch?.trim() || undefined,
        ...(input.provider === 'cursor' ? { cursorTrustPath: input.workspacePath } : {}) }) as AgentRun;
      ElMessage.success(run.status === 'queued' ? '新 Agent 已创建，等待当前工作区任务完成'
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
      const result = await post(`/api/agent-runtimes/runs/${parent.id}/orchestrate`, input, false) as { worker: AgentRun; reviewer: AgentRun };
      ElMessage.success('工作流已启动：实现完成后将自动进入复核');
      return result;
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
      if (run.provider === 'cursor') {
        try { await ElMessageBox.confirm(`将继续信任当前工作区及其子目录：${run.workspacePath}。沿用原模型和访问权限，按修改后的内容继续执行。`, '信任 Cursor 工作区并继续',
          { type: 'warning', confirmButtonText: '信任并继续', cancelButtonText: '取消', closeOnClickModal: false }); }
        catch { return undefined; }
      }
      const next = await post(`/api/agent-runtimes/runs/${run.id}/revise`, { objective: objective.trim(),
        ...(run.provider === 'cursor' ? { cursorTrustPath: run.workspacePath } : {}) }, false) as AgentRun;
      ElMessage.success('已按编辑后的内容继续，原消息和结果保留');
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function retry(run: AgentRun) {
    if (changing.value) return undefined;
    run = { ...run };
    changing.value = `retry:${run.id}`;
    try {
      if (run.provider === 'cursor') {
        try {
          await ElMessageBox.confirm(`将信任当前工作区及其子目录：${run.workspacePath}，并重新执行已保存的任务。Cursor 会读取项目规则；保留原访问权限（${run.accessMode === 'full' ? '完全访问' : '工作区访问'}），不自动批准全部 MCP。`,
            '信任 Cursor 工作区并重试', { type: 'warning', confirmButtonText: '信任并重试', cancelButtonText: '取消', closeOnClickModal: false });
        } catch { return undefined; }
      }
      const next = await post(`/api/agent-runtimes/runs/${run.id}/retry`,
        run.provider === 'cursor' ? { cursorTrustPath: run.workspacePath } : {}, false) as AgentRun;
      ElMessage.success(next.sessionId ? '已从保存的 CLI 会话继续执行' : '已重新启动该任务');
      return next;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function resume(run: AgentRun, objective: string, model: string, reasoningEffort: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = run.accessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier) {
    if (changing.value || (!objective.trim() && !attachmentIds.length)) return undefined;
    changing.value = run.id;
    try { const next = await post(`/api/agent-runtimes/runs/${run.id}/resume`, { objective: objective.trim(), model, reasoningEffort,
      attachmentIds, accessMode, queuePlacement, serviceTier }, false) as AgentRun;
      if (next.status === 'queued') ElMessage.success('消息已发送，正在排队');
      return next; }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { changing.value = ''; }
  }
  async function resumeCodexSession(sessionId: string, objective: string, model: string, reasoningEffort: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = 'workspace', serviceTier?: AgentServiceTier) {
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
        objective: objective.trim(), ...codexWorkbenchDefaults, attachmentIds,
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
      : '将停止该会话中运行和排队的任务，再从 Delivery Workspace 删除该会话及全部续聊记录。不会删除工作区文件或 Codex / Cursor 本机历史。';
    try { await ElMessageBox.confirm(message, '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false }); }
    catch { changing.value = ''; return false; }
    try {
      const path = source === 'codex' ? `/api/agent-runtimes/codex-sessions/${conversationId}/delete`
        : `/api/agent-runtimes/conversations/${conversationId}/delete`;
      await post(path, {});
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
  async function addCustomModel(input: AgentCustomModelInput) {
    if (changing.value) return;
    changing.value = 'model:add';
    try { await post('/api/agent-runtimes/models', input); ElMessage.success('自定义模型已添加'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  async function removeCustomModel(id: string) {
    if (changing.value) return;
    try { await ElMessageBox.confirm('仅从 Delivery Workspace 的模型选项中删除，不会修改 Codex 或 Cursor CLI 配置。', '删除自定义模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', closeOnClickModal: false }); }
    catch { return; }
    changing.value = `model:${id}`;
    try { await post(`/api/agent-runtimes/models/${id}/delete`, {}); ElMessage.success('自定义模型已删除'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = ''; }
  }
  return { query, changing, streamConnected, streamStatus, streamRevision, codexDetails, start, spawn, orchestrate, stop, pauseForEdit, revise, steer, deleteQueuedRun, retry, resume, resumeCodexSession, fork, syncCodexSessions, loadCodexSession,
    removeConversation, updateConversationTitle, addCustomModel, removeCustomModel };
}

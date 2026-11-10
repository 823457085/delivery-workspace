/**
 * 设计说明：后端按每次 CLI 运行保存记录，而会话窗口需要展示连续对话，因此这里优先按持久会话 ID
 * 聚合；旧记录才沿可见 parentRunId 链分组。它不修改运行状态，也不按 CLI session 合并独立会话。
 */
import type { AgentRun, CodexSessionDetail, CodexSessionSummary } from '../../../shared/agent-runtime';
import type { TeamTaskState } from '../../../shared/agent-team';
import { codexRunningMessage, codexWriterHeldMessage } from '../../../shared/codex-session-error';
import { jiraTaskPromptTitle } from './message-text';
import { teamRunCheckStatus, type TeamResultContext } from './team-result-status';

/** 仅用于页面投影，保留合并到本机会话中的同步历史来源。 */
export type AgentConversationRun = AgentRun & { syncedHistory?: true };

export interface AgentConversation {
  id: string;
  title: string;
  runs: AgentConversationRun[];
  latest: AgentConversationRun;
  updatedAt: string;
  source: 'workspace' | 'codex';
  loaded: boolean;
  /** 群聊成员发言的展示序号；同一次发言的重试沿用该序号。 */
  runRounds?: Record<string, { round: number; current: boolean }>;
  archived?: boolean;
  teamChat?: { state: TeamTaskState; lastUserAt: string; workspaceBound?: boolean; workspacePath?: string };
}

const legacyRestartPrompt = '继续刚才因 5288 工作台重启暂停的同一任务。沿用原工作区和已完成的进度，继续原目标和原授权范围内的剩余工作。先核对可能已执行的操作，再继续处理。';

/** 旧版用修订消息续跑；只有完整匹配既有提示和原生会话关联才合并展示。 */
export function isLegacyRestartContinuation(run: AgentConversationRun, previous?: AgentConversationRun) {
  return !!previous && !run.syncedHistory && !previous.syncedHistory
    && run.provider === 'codex' && previous.provider === 'codex'
    && run.parentRunId === previous.id && run.revisesRunId === previous.id
    && (previous.status === 'cancelled' || previous.status === 'interrupted')
    && !!run.sessionId && run.sessionId === previous.sessionId && run.workspacePath === previous.workspacePath
    && run.mode === previous.mode && run.accessMode === previous.accessMode && !run.attachments?.length
    && run.objective.trim() === legacyRestartPrompt;
}

/** 明确修订、恢复或调整方向的运行沿用原轮号，正常续聊仍递增。 */
export function agentConversationRunRounds(conversation?: AgentConversation): Map<string, number> {
  const rounds = new Map<string, number>();
  let latest = 0;
  for (const run of conversation?.runs || []) {
    const target = run.revisesRunId || run.recoveryOfRunId || run.roundContinuationOfRunId || (run.events.some(event => event.type === 'lifecycle'
      && event.message === '已调整方向：停止当前轮后将立即执行此消息') ? run.parentRunId : undefined);
    const round = conversation?.runRounds?.[run.id]?.round ?? (target ? rounds.get(target) : undefined) ?? latest + 1;
    rounds.set(run.id, round);
    latest = Math.max(latest, round);
  }
  return rounds;
}

export function agentConversationRoundCount(conversation?: AgentConversation) {
  return Math.max(0, ...agentConversationRunRounds(conversation).values());
}

function conversationSortTime(conversation: AgentConversation) {
  if (conversation.source === 'codex') return Date.parse(conversation.updatedAt) || 0;
  // 仅用户提交新轮次时前移；流式输出、工具事件和完成状态仍更新 updatedAt，但不改变列表顺序。
  return conversation.runs.reduce((latest, run) => run.syncedHistory ? latest
    : Math.max(latest, Date.parse(run.createdAt) || 0), Date.parse(conversation.teamChat?.lastUserAt || '') || 0);
}

export function compareAgentConversations(left: AgentConversation, right: AgentConversation) {
  return conversationSortTime(right) - conversationSortTime(left) || left.id.localeCompare(right.id);
}

/** 同步历史没有实时运行状态；本机完成仅表示这一轮正常结束，不代表业务验收。 */
export function agentRunStatus(run: AgentConversationRun, task?: TeamResultContext) {
  if (run.syncedHistory) return { value: 'history', label: '历史记录', title: '已同步历史记录，当前执行状态未确认' };
  if (!run.pausedForEdit && run.status === 'completed' && run.resultReady === false)
    return { value: 'running', label: '正在保存结果', title: '执行器已结束，工作台正在保存本轮结果' };
  const check = teamRunCheckStatus(run, task);
  if (check) return { value: check.value, label: `运行已结束 · ${check.label}`, title: check.detail };
  const value = run.pausedForEdit ? 'paused' : run.status;
  const labels: Record<string, string> = { running: '执行中', queued: '排队中', completed: '本轮完成', failed: '执行失败',
    cancelled: '已停止', interrupted: '已中断', paused: '等待编辑' };
  const label = labels[value] || value;
  return { value, label, title: value === 'completed' ? '本轮执行已正常结束；业务验收请查看交付结果'
    : value === 'interrupted' ? '运行已中断，未确认本轮完成' : label };
}

export function agentConversationStatus(conversation: AgentConversation) {
  if (conversation.source === 'codex') return { value: 'history', label: '已同步', title: '已同步历史记录，当前执行状态未确认' };
  if (conversation.teamChat) {
    const state = conversation.teamChat.state;
    const label = ({ planning: '正在安排', running: '团队执行中', waiting_input: '等待回复', awaiting_plan: '等待补充', blocked: '团队受阻',
      needs_decision: '等待决定', needs_reconciliation: '等待核对', awaiting_acceptance: '汇报就绪', accepted: '已验收', rejected: '已退回',
      cancelled: '已取消', taken_over: '已接手', completed: '本轮完成' } as Record<string, string>)[state] || state;
    const value = ['planning', 'running'].includes(state) ? 'running' : ['blocked', 'needs_reconciliation'].includes(state) ? 'failed'
      : ['waiting_input', 'awaiting_plan', 'needs_decision', 'awaiting_acceptance'].includes(state) ? 'queued' : 'completed';
    return { value, label, title: label };
  }
  return agentRunStatus(conversation.runs.find(run => run.pausedForEdit) || conversation.latest);
}

export function resumedConversationId(_conversation: AgentConversation, run: AgentRun) {
  // 已分配的会话 ID 在新运行和 Codex 分叉后仍属于原侧栏行。
  return run.conversationId || run.id;
}

/** 输入框跟随最后发送的消息；运行中的旧执行器仍由 latest 展示进度。 */
export function agentConversationContinuation(conversation: AgentConversation) {
  const submitted = [...conversation.runs].reverse().find(run => !run.syncedHistory) || conversation.latest;
  return conversation.latest.continuation && conversation.latest.provider === submitted.provider ? conversation.latest : submitted;
}

export function agentConversationInsertRun(conversation: AgentConversation) {
  const source = agentConversationContinuation(conversation);
  return conversation.runs.find(run => run.status === 'running' && run.provider === source.provider
    && (run.id === source.id || !!source.sessionId && run.sessionId === source.sessionId));
}

export function canSteerAgentRun(run: AgentRun, activeRun: AgentRun | undefined, runs: AgentRun[]) {
  if (run.status !== 'queued' || activeRun?.status !== 'running' || run.provider !== activeRun.provider) return false;
  const seen = new Set<string>();
  let current: AgentRun | undefined = run;
  while (current && current.id !== activeRun.id && !seen.has(current.id)) {
    if (current.provider !== activeRun.provider || current.providerSwitch) return false;
    seen.add(current.id);
    current = runs.find(item => item.id === current!.parentRunId);
  }
  return true;
}

export function findAgentConversation(conversations: AgentConversation[], id: string) {
  const direct = conversations.find((conversation) => conversation.id === id)
    || conversations.find((conversation) => conversation.runs.some((run) => run.id === id));
  if (direct) return direct;
  const byOrigin = conversations.filter((conversation) => conversation.runs.some((run) => run.originSessionId === id));
  return byOrigin.length === 1 ? byOrigin[0] : undefined;
}

/** 只沿已知运行定位同一会话，不按目录或 CLI session 猜测，避免跳到同项目的其他会话。 */
export function reconcileAgentConversation(conversations: AgentConversation[], id: string,
  previous: AgentConversation[] = []) {
  const direct = findAgentConversation(conversations, id);
  if (direct) return direct;
  const before = findAgentConversation(previous, id);
  return before ? findAgentConversation(conversations, before.latest.id) : undefined;
}

/** 保留用户选择的上下文目录；展示分组不能改变工作流、日报或文件查询的目录。 */
export function agentRunContextPath(run: AgentRun) {
  // 空源目录表示未绑定项目的独立会话，不能把内部会话目录当成最近项目。
  return run.sourceWorkspacePath ?? run.workspacePath;
}

export function agentRunProjectPath(run: AgentRun) {
  return run.sourceWorkspacePath === '' ? '' : run.projectWorkspacePath ?? agentRunContextPath(run);
}

/** 聊天的临时读取目录不是业务项目；只改变页面展示，不覆盖原始 Run 的真实路径。 */
export function agentConversationProjectPath(conversation: AgentConversation) {
  if (conversation.teamChat) return conversation.teamChat.workspaceBound ? conversation.teamChat.workspacePath || '' : '';
  if (conversation.runs.some(run => run.team?.interactionMode === 'chat')) return '';
  return agentRunProjectPath(conversation.latest);
}

export function agentConversationCodePath(conversation?: AgentConversation) {
  if (!conversation) return '';
  const project = agentConversationProjectPath(conversation);
  return project ? (conversation.teamChat ? project : conversation.latest.workspacePath || project) : '';
}

const legacyActiveWriterError = /^thread [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12} already has an active writer$/i;

export function agentRunErrorText(run: AgentRun) {
  return run.error;
}

export function isRetryableSessionBusyRun(run: AgentRun) {
  return run.provider === 'codex' && run.status === 'failed'
    && (legacyActiveWriterError.test(run.error) || run.error === codexWriterHeldMessage || run.error === codexRunningMessage
      || run.error.includes('原会话正在其他 Codex 窗口运行')
      || run.error.includes('原会话不可用或正在被占用') || run.error.includes('原会话已有正在执行的任务'));
}

export function isRestartableAgentRun(run: AgentRun) {
  return ['failed', 'interrupted', 'cancelled'].includes(run.status);
}

export function buildAgentConversations(runs: AgentRun[]): AgentConversation[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const groups = new Map<string, AgentRun[]>();
  function rootId(run: AgentRun) {
    if (run.conversationId) return run.conversationId;
    const visited = new Set<string>();
    let current = run;
    while (current.parentRunId && byId.has(current.parentRunId) && !visited.has(current.parentRunId)) {
      visited.add(current.id);
      current = byId.get(current.parentRunId)!;
      if (current.conversationId) return current.conversationId;
    }
    return current.id;
  }
  for (const run of runs) {
    const root = rootId(run);
    groups.set(root, [...(groups.get(root) || []), run]);
  }
  return [...groups.entries()].map(([id, items]) => {
    // 后端按新到旧保存运行；同毫秒发送时也要保持这个插入顺序。
    const ordered = [...items].reverse().sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const priority = (run: AgentRun) => run.status === 'running' ? 2 : run.status === 'queued' ? 1 : 0;
    const latest = ordered.reduce((current, candidate) => {
      if (priority(candidate) !== priority(current)) return priority(candidate) > priority(current) ? candidate : current;
      return Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt) ? candidate : current;
    });
    const updatedAt = ordered.reduce((time, run) => Date.parse(run.updatedAt) > Date.parse(time) ? run.updatedAt : time,
      ordered[0].updatedAt);
    let titleIndex = ordered.indexOf(latest);
    while (isLegacyRestartContinuation(ordered[titleIndex], ordered[titleIndex - 1])) titleIndex--;
    const title = ordered[titleIndex].objective;
    return { id, title: jiraTaskPromptTitle(title) || title, runs: ordered, latest, updatedAt,
      source: 'workspace' as const, loaded: true };
  }).sort(compareAgentConversations);
}

function codexRun(session: CodexSessionSummary, id: string, objective: string, result: string, createdAt: string, updatedAt: string): AgentConversationRun {
  return {
    id,
    syncedHistory: true,
    provider: 'codex',
    mode: 'ask',
    accessMode: 'workspace',
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    objective,
    workspacePath: session.workspacePath,
    projectWorkspacePath: session.projectWorkspacePath,
    branch: session.branch,
    headSha: session.headSha,
    status: 'completed',
    sessionId: session.id,
    pid: null,
    result,
    error: '',
    events: [],
    createdAt,
    updatedAt,
  };
}

function codexTitle(session: CodexSessionSummary, source = session.title) {
  const request = source.match(/## My request:\s*([\s\S]+)/)?.[1]?.trim();
  const workspaceRequest = source.match(/^你由 Delivery Workspace 以[\s\S]*?用户任务如下：\s*([\s\S]+)$/)?.[1]?.trim();
  const reorderedRequest = source.match(/^用户任务如下：\s*([\s\S]+?)(?:\n\s*工作台执行上下文：|$)/)?.[1]?.trim();
  const value = request || workspaceRequest || reorderedRequest || source;
  return (jiraTaskPromptTitle(value) || value).replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名 Codex 会话';
}

export function buildSyncedCodexConversation(session: CodexSessionSummary, detail?: CodexSessionDetail): AgentConversation {
  const runs = detail?.turns.length
    ? detail.turns.map((turn) => codexRun(session, turn.id, turn.userMessage, turn.agentMessage, turn.createdAt, turn.updatedAt))
    : [codexRun(session, session.id, session.title, session.preview, session.createdAt, session.updatedAt)];
  const latestTitle = detail?.turns.length ? codexTitle(session, runs.at(-1)!.objective) : codexTitle(session);
  return { id: session.id, title: latestTitle,
    runs, latest: runs.at(-1)!, updatedAt: session.updatedAt,
    source: 'codex', loaded: !!detail, archived: session.archived };
}

export function buildAgentConversationList(runs: AgentRun[], sessions: CodexSessionSummary[],
  details: Record<string, CodexSessionDetail>, titles: Record<string, string> = {}): AgentConversation[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const importedSessionIds = new Set<string>();
  const localSessionIds = new Set<string>();
  const localConversations = buildAgentConversations(runs);
  const originOwners = new Map<string, number>();
  localConversations.forEach((conversation) => {
    const origin = conversation.runs.find((run) => run.originSessionId)?.originSessionId;
    if (origin) originOwners.set(origin, (originOwners.get(origin) || 0) + 1);
  });
  const local = localConversations.map((conversation) => {
    conversation.runs.forEach((run) => {
      if (run.sessionId) localSessionIds.add(run.sessionId);
      if (run.continuation?.sessionId) localSessionIds.add(run.continuation.sessionId);
    });
    const originSessionId = conversation.runs.find((run) => run.originSessionId)?.originSessionId;
    if (!originSessionId) return conversation;
    importedSessionIds.add(originSessionId);
    const session = sessionById.get(originSessionId);
    if (!session || (originOwners.get(originSessionId) || 0) > 1) return conversation;
    const history = buildSyncedCodexConversation(session, details[originSessionId]);
    return { ...conversation, title: conversation.title || history.title,
      runs: [...history.runs, ...conversation.runs], loaded: history.loaded };
  });
  const synced = sessions.filter((session) => !localSessionIds.has(session.id) && !importedSessionIds.has(session.id))
    .map((session) => buildSyncedCodexConversation(session, details[session.id]));
  return [...local, ...synced].map((conversation) => ({
    ...conversation,
    title: titles[conversation.id] || conversation.title,
  })).sort(compareAgentConversations);
}

/**
 * 设计说明：后端按每次 CLI 运行保存记录，而会话窗口需要展示连续对话，因此这里优先按持久会话 ID
 * 聚合；旧记录才沿可见 parentRunId 链分组。它不修改运行状态，也不按 CLI session 合并独立会话。
 */
import type { AgentRun, CodexSessionDetail, CodexSessionSummary } from '../../../shared/agent-runtime';
import { codexRunningMessage, codexWriterHeldMessage } from '../../../shared/codex-session-error';

export interface AgentConversation {
  id: string;
  title: string;
  runs: AgentRun[];
  latest: AgentRun;
  updatedAt: string;
  source: 'workspace' | 'codex';
  loaded: boolean;
  archived?: boolean;
}

export function resumedConversationId(_conversation: AgentConversation, run: AgentRun) {
  // 已分配的会话 ID 在新运行和 Codex 分叉后仍属于原侧栏行。
  return run.conversationId || run.id;
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

export function agentRunProjectPath(run: AgentRun) {
  // 空源目录表示未绑定项目的独立会话，不能把内部会话目录当成最近项目。
  return run.sourceWorkspacePath ?? run.workspacePath;
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
    const ordered = [...items].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const priority = (run: AgentRun) => run.status === 'running' ? 2 : run.status === 'queued' ? 1 : 0;
    const latest = ordered.reduce((current, candidate) => {
      if (priority(candidate) !== priority(current)) return priority(candidate) > priority(current) ? candidate : current;
      return Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt) ? candidate : current;
    });
    const updatedAt = ordered.reduce((time, run) => Date.parse(run.updatedAt) > Date.parse(time) ? run.updatedAt : time,
      ordered[0].updatedAt);
    return { id, title: latest.objective, runs: ordered, latest, updatedAt,
      source: 'workspace' as const, loaded: true };
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function codexRun(session: CodexSessionSummary, id: string, objective: string, result: string, createdAt: string, updatedAt: string): AgentRun {
  return {
    id,
    provider: 'codex',
    mode: 'ask',
    accessMode: 'workspace',
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    objective,
    workspacePath: session.workspacePath,
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

function codexTitle(session: CodexSessionSummary) {
  const request = session.title.match(/## My request:\s*([\s\S]+)/)?.[1]?.trim();
  const value = request || session.title;
  return value.replace(/\s+/g, ' ').trim().slice(0, 240) || '未命名 Codex 会话';
}

export function buildSyncedCodexConversation(session: CodexSessionSummary, detail?: CodexSessionDetail): AgentConversation {
  const runs = detail?.turns.length
    ? detail.turns.map((turn) => codexRun(session, turn.id, turn.userMessage, turn.agentMessage, turn.createdAt, turn.updatedAt))
    : [codexRun(session, session.id, session.title, session.preview, session.createdAt, session.updatedAt)];
  return { id: session.id, title: detail?.turns.length ? runs.at(-1)!.objective || codexTitle(session) : codexTitle(session),
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
    return { ...conversation, title: conversation.latest.objective || history.title,
      runs: [...history.runs, ...conversation.runs], loaded: history.loaded };
  });
  const synced = sessions.filter((session) => !localSessionIds.has(session.id) && !importedSessionIds.has(session.id))
    .map((session) => buildSyncedCodexConversation(session, details[session.id]));
  return [...local, ...synced].map((conversation) => ({
    ...conversation,
    title: titles[conversation.id] || conversation.title,
  })).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

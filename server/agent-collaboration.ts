/** 持久问答、派发意图和写入租约。原生 Run 的状态仍以 agent-runtime 为准。 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { teamProfileIds, type TeamProfileId } from '../shared/agent-team.js';

const participantSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('profile'), profileId: z.string().min(1).max(80) }).strict(), z.object({ kind: z.literal('user') }).strict()]);
export type ParticipantRef = z.infer<typeof participantSchema>;
const timestamp = z.string().min(1);
const messageSchema = z.object({
  id: z.string(), workflowId: z.string(), nodeId: z.string().optional(), type: z.enum(['ask', 'back', 'handoff', 'cancel', 'progress']),
  from: participantSchema, to: participantSchema, correlationId: z.string(), causationId: z.string(), sequence: z.number().int().nonnegative(),
  dedupeKey: z.string(), body: z.object({ text: z.string().max(20000), refs: z.array(z.string()).max(100) }),
  blocking: z.boolean(), forwarded: z.number().int().min(0).max(1), answerTo: z.string().optional(),
  delivery: z.enum(['queued', 'delivered', 'acknowledged']), processing: z.enum(['pending', 'processing', 'answered', 'failed', 'expired']),
  createdAt: timestamp, updatedAt: timestamp,
}).strict();
export type AgentCollaborationMessage = z.infer<typeof messageSchema>;
const intentSchema = z.object({ id: z.string(), workflowId: z.string(), stageKey: z.string(), attempt: z.number().int().positive(),
  state: z.enum(['intended', 'started', 'linked', 'abandoned']), runId: z.string().optional(), settled: z.boolean(),
  reconciliation: z.enum(['ready', 'needs_reconciliation']).optional(), createdAt: timestamp, updatedAt: timestamp }).strict();
export type AgentDispatchIntent = z.infer<typeof intentSchema>;
const leaseSchema = z.object({ path: z.string(), ownerRunId: z.string(), nodeId: z.string().optional(), fencingToken: z.number().int().positive(),
  state: z.enum(['active', 'released', 'needs_reconciliation']), acquiredAt: timestamp, updatedAt: timestamp }).strict();
export type AgentWriteLease = z.infer<typeof leaseSchema>;
const eventSchema = z.object({ eventId: z.string(), workflowId: z.string(), revision: z.number().int(), type: z.string(), data: z.unknown(), createdAt: timestamp }).strict();
export const collaborationStateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), nextFencingToken: z.number().int().nonnegative(),
  messages: z.array(messageSchema), intents: z.array(intentSchema), leases: z.array(leaseSchema), events: z.array(eventSchema),
  budgets: z.record(z.string(), z.object({ reservedRuns: z.number().int().nonnegative(), usedRuns: z.number().int().nonnegative(), limit: z.number().int().positive().nullable().transform(() => null as number | null) }).strict()),
  idempotency: z.record(z.string(), z.object({ requestHash: z.string(), response: z.unknown(), at: timestamp }).strict()),
}).strict();
export type AgentCollaborationState = z.infer<typeof collaborationStateSchema>;
export interface SendCollaborationMessage {
  workflowId: string; nodeId?: string; type: AgentCollaborationMessage['type']; from: ParticipantRef; to: ParticipantRef;
  text: string; refs?: string[]; dedupeKey: string; correlationId?: string; causationId?: string; answerTo?: string; blocking?: boolean;
}
export const questionTargets = (profileId: string): readonly (TeamProfileId | 'user')[] => teamProfileIds.some(id => id === profileId)
  ? [...teamProfileIds.filter(id => id !== profileId), 'user'] : [];
const participantKey = (value: ParticipantRef) => value.kind === 'user' ? 'user' : value.profileId;
const hashRequest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function overlap(first: string, second: string) { return first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`); }

export async function createAgentCollaborationStore(directory: string, options: {
  writeJson?: (relativePath: string, value: unknown) => Promise<void>;
  now?: () => string;
} = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'collaboration-state.json');
  const now = options.now || (() => new Date().toISOString());
  let state: AgentCollaborationState;
  try { state = collaborationStateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`协作账本不可读：${error instanceof Error ? error.message : String(error)}`);
    state = { version: 1, revision: 0, nextFencingToken: 0, messages: [], intents: [], leases: [], events: [], budgets: {}, idempotency: {} };
  }
  let lock: Promise<unknown> = Promise.resolve();
  const copy = <T>(value: T): T => structuredClone(value);
  async function mutate<T>(action: (draft: AgentCollaborationState) => T | Promise<T>,
    readIfUnchanged?: (current: AgentCollaborationState) => T | undefined): Promise<T> {
    const pending = lock.then(async () => {
      const unchanged = readIfUnchanged?.(state);
      if (unchanged !== undefined) return copy(unchanged);
      const draft = copy(state);
      const result = await action(draft);
      draft.revision += 1;
      collaborationStateSchema.parse(draft);
      if (options.writeJson) await options.writeJson('agent-runtimes/collaboration-state.json', draft);
      else {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify(draft, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
      state = draft;
      return copy(result);
    });
    lock = pending.catch(() => {});
    return pending;
  }
  function event(draft: AgentCollaborationState, workflowId: string, type: string, data: unknown) {
    draft.events.push({ eventId: randomUUID(), workflowId, revision: draft.revision + 1, type, data: copy(data), createdAt: now() });
  }
  function sendIn(draft: AgentCollaborationState, input: SendCollaborationMessage, forwarded = 0, memberIds?: Partial<Record<TeamProfileId, string>>): AgentCollaborationMessage {
    if (!input.workflowId || !input.dedupeKey || !input.text.trim()) throw new Error('消息缺少流程、去重标识或正文');
    const key = `message:${input.workflowId}:${input.dedupeKey}`;
    const digest = hashRequest(input);
    const existing = draft.idempotency[key];
    if (existing) {
      if (existing.requestHash !== digest) throw new Error('相同消息 requestId 对应不同内容');
      const previous = draft.messages.find(item => item.id === existing.response);
      if (!previous) throw new Error('消息去重记录与账本不一致');
      return previous;
    }
    const from = participantKey(input.from), to = participantKey(input.to);
    if (input.type === 'ask') {
      if (from === to || (input.from.kind !== 'user' && !questionTargets(from).some(target => target === to))) {
        throw new Error(`不允许 ${from} 向 ${to} 提问`);
      }
      const identity = (value: ParticipantRef) => value.kind === 'user' ? 'user' : `profile:${memberIds?.[value.profileId as TeamProfileId] || value.profileId}`;
      const sender = identity(input.from);
      const pending = draft.messages.filter(item => item.workflowId === input.workflowId && item.type === 'ask' && !['answered', 'expired'].includes(item.processing));
      const reaches = (target: string, visited = new Set<string>()): boolean => {
        if (target === sender) return true;
        if (visited.has(target)) return false;
        visited.add(target);
        return pending.filter(item => identity(item.from) === target).some(item => reaches(identity(item.to), visited));
      };
      if (reaches(identity(input.to))) throw new Error('问题会形成循环，已拒绝派发');
    }
    const createdAt = now();
    const message = messageSchema.parse({ id: randomUUID(), workflowId: input.workflowId, ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      type: input.type, from: input.from, to: input.to, correlationId: input.correlationId || randomUUID(), causationId: input.causationId || '',
      sequence: Math.max(0, ...draft.messages.filter(item => item.workflowId === input.workflowId).map(item => item.sequence)) + 1,
      dedupeKey: input.dedupeKey, body: { text: input.text.trim(), refs: input.refs || [] }, blocking: input.blocking ?? true,
      forwarded, ...(input.answerTo ? { answerTo: input.answerTo } : {}), delivery: 'queued', processing: 'pending', createdAt, updatedAt: createdAt });
    draft.messages.push(message);
    draft.idempotency[key] = { requestHash: digest, response: message.id, at: createdAt };
    event(draft, input.workflowId, 'workflow.message', { messageId: message.id });
    return message;
  }
  function getIntent(draft: AgentCollaborationState, id: string) { const intent = draft.intents.find(item => item.id === id); if (!intent) throw new Error('找不到派发意图'); return intent; }
  return {
    snapshot: () => copy(state),
    messages: (workflowId: string) => copy(state.messages.filter(item => item.workflowId === workflowId)),
    events: (workflowId: string, sinceRevision = 0) => copy(state.events.filter(item => item.workflowId === workflowId && item.revision > sinceRevision)),
    send: async (input: SendCollaborationMessage) => {
      const result = await mutate(draft => {
        try { return { message: sendIn(draft, input) }; }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          event(draft, input.workflowId, 'workflow.message_rejected', { reason });
          return { error: reason };
        }
      });
      if (result.error) throw new Error(result.error);
      return result.message!;
    },
    sendQuestions: async (workflowId: string, inputs: Omit<SendCollaborationMessage, 'workflowId' | 'type'>[], memberIds?: Partial<Record<TeamProfileId, string>>) => {
      const result = await mutate(draft => {
        // sendIn appends messages/events and adds idempotency keys. Stage those writes together.
        const batch = { ...draft, messages: [...draft.messages], events: [...draft.events], idempotency: { ...draft.idempotency } };
        try {
          const messages = inputs.map(input => sendIn(batch, { ...input, workflowId, type: 'ask' }, 0, memberIds));
          Object.assign(draft, batch);
          return { messages };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          event(draft, workflowId, 'workflow.message_rejected', { reason });
          return { error: reason };
        }
      });
      if (result.error) throw new Error(result.error);
      return result.messages!;
    },
    recordEvent: (workflowId: string, type: string, data: unknown) => mutate(draft => { event(draft, workflowId, type, data); return draft.events.at(-1)!; }),
    claim: (workflowId: string, to: ParticipantRef, eligibleId?: string) => mutate(draft => {
      const target = participantKey(to);
      const pending = draft.messages.filter(item => item.workflowId === workflowId && participantKey(item.to) === target && item.type === 'ask'
        && !['answered', 'expired'].includes(item.processing) && (!eligibleId || item.id === eligibleId)).sort((left, right) => left.sequence - right.sequence);
      if (!pending.length || !eligibleId && pending[0].processing === 'processing') return undefined;
      if (pending[0].processing === 'processing') return pending[0];
      const message = pending[0]; message.delivery = 'delivered'; message.processing = 'processing'; message.updatedAt = now();
      event(draft, workflowId, 'workflow.message', { messageId: message.id });
      return message;
    }),
    acknowledge: (messageId: string) => mutate(draft => {
      const message = draft.messages.find(item => item.id === messageId); if (!message) throw new Error('找不到消息');
      message.delivery = 'acknowledged'; message.updatedAt = now(); event(draft, message.workflowId, 'workflow.message', { messageId }); return message;
    }),
    answer: (askId: string, input: { from: ParticipantRef; text: string; refs?: string[]; dedupeKey: string }) => mutate(draft => {
      const ask = draft.messages.find(item => item.id === askId && item.type === 'ask'); if (!ask) throw new Error('找不到原始问题');
      if (participantKey(ask.to) !== participantKey(input.from)) throw new Error('只有指定接收方可以回答问题');
      if (ask.processing === 'expired') throw new Error('问题已过期');
      if (ask.processing === 'answered' && !draft.idempotency[`message:${ask.workflowId}:${input.dedupeKey}`]) throw new Error('问题已经回答');
      const reply = sendIn(draft, { workflowId: ask.workflowId, nodeId: ask.nodeId, type: 'back', from: input.from, to: ask.from,
        text: input.text, refs: input.refs, dedupeKey: input.dedupeKey, correlationId: ask.correlationId, causationId: ask.id, answerTo: ask.id, blocking: false });
      ask.processing = 'answered'; ask.updatedAt = now();
      if (ask.forwarded && ask.answerTo) {
        const original = draft.messages.find(item => item.id === ask.answerTo && item.type === 'ask');
        if (original && original.processing !== 'expired') {
          sendIn(draft, { workflowId: original.workflowId, nodeId: original.nodeId, type: 'back', from: original.to, to: original.from,
            text: input.text, refs: input.refs, dedupeKey: `${input.dedupeKey}:forwarded`, correlationId: original.correlationId,
            causationId: reply.id, answerTo: original.id, blocking: false });
          original.processing = 'answered'; original.updatedAt = now();
        }
      }
      return reply;
    }),
    forward: (askId: string, input: { from: ParticipantRef; to: ParticipantRef; text: string; dedupeKey: string }) => mutate(draft => {
      const ask = draft.messages.find(item => item.id === askId && item.type === 'ask'); if (!ask) throw new Error('找不到原始问题');
      if (participantKey(ask.to) !== participantKey(input.from)) throw new Error('只有接收方可以转交问题');
      const previous = draft.idempotency[`message:${ask.workflowId}:${input.dedupeKey}`];
      if ((ask.forwarded || ['answered', 'expired'].includes(ask.processing)) && !previous) throw new Error('问题最多转交一次');
      const message = sendIn(draft, { workflowId: ask.workflowId, nodeId: ask.nodeId, type: 'ask', from: input.from, to: input.to,
        text: input.text, dedupeKey: input.dedupeKey, correlationId: ask.correlationId, causationId: ask.id, answerTo: ask.id, blocking: ask.blocking }, 1);
      if (!previous) { ask.forwarded = 1; ask.processing = 'processing'; ask.updatedAt = now(); }
      return message;
    }),
    expireNodeQuestions: (workflowId: string, nodeId: string) => mutate(draft => {
      for (const message of draft.messages.filter(item => item.workflowId === workflowId && item.nodeId === nodeId && item.type === 'ask' && item.processing !== 'answered')) {
        message.processing = 'expired'; message.updatedAt = now();
      }
      event(draft, workflowId, 'question.expire', { nodeId });
    }),
    cancelWorkflow: (workflowId: string) => mutate(draft => {
      for (const message of draft.messages.filter(item => item.workflowId === workflowId && item.type === 'ask' && item.processing !== 'answered')) {
        message.processing = 'expired'; message.updatedAt = now();
      }
      event(draft, workflowId, 'workflow.cancel', {});
    }),
    reserveDispatch: (input: { workflowId: string; stageKey: string; attempt: number; limit: number | null }) => mutate(draft => {
      if (!input.workflowId || !input.stageKey || !Number.isInteger(input.attempt) || input.attempt < 1
        || (input.limit !== null && (!Number.isInteger(input.limit) || input.limit < 1))) throw new Error('派发参数无效');
      const existing = draft.intents.find(item => item.workflowId === input.workflowId && item.stageKey === input.stageKey && item.attempt === input.attempt);
      if (existing) return existing;
      const budget = draft.budgets[input.workflowId] ||= { reservedRuns: 0, usedRuns: 0, limit: null };
      budget.limit = null;
      budget.reservedRuns += 1;
      const at = now();
      const intent: AgentDispatchIntent = { id: randomUUID(), workflowId: input.workflowId, stageKey: input.stageKey, attempt: input.attempt,
        state: 'intended', settled: false, createdAt: at, updatedAt: at };
      draft.intents.push(intent); event(draft, input.workflowId, 'workflow.intent', { intentId: intent.id }); return intent;
    }),
    extendBudget: (workflowId: string, _limit: number | null) => mutate(draft => {
      const budget = draft.budgets[workflowId]; if (!budget) throw new Error('找不到流程执行计数');
      if (_limit !== null && (!Number.isInteger(_limit) || _limit < 1)) throw new Error('派发参数无效');
      budget.limit = null; event(draft, workflowId, 'workflow.budget', budget); return budget;
    }),
    markStarted: (intentId: string) => mutate(draft => { const intent = getIntent(draft, intentId); if (intent.state === 'intended') intent.state = 'started'; intent.updatedAt = now(); return intent; }),
    linkIntent: (intentId: string, runId: string) => mutate(draft => {
      const intent = getIntent(draft, intentId); if (intent.runId && intent.runId !== runId) throw new Error('意图已经关联其他运行');
      if (intent.state === 'abandoned') throw new Error('意图已放弃');
      intent.runId = runId; intent.state = 'linked'; intent.reconciliation = 'ready'; intent.updatedAt = now();
      event(draft, intent.workflowId, 'workflow.intent', { intentId, runId }); return intent;
    }),
    settleIntent: (intentId: string, abandoned = false) => mutate(draft => {
      const intent = getIntent(draft, intentId); if (intent.settled) return intent;
      if (abandoned && intent.state !== 'intended') throw new Error('已启动或状态未知的意图不能自动放弃');
      const budget = draft.budgets[intent.workflowId]; budget.reservedRuns = Math.max(0, budget.reservedRuns - 1);
      if (!abandoned) budget.usedRuns += 1;
      intent.settled = true; if (abandoned) intent.state = 'abandoned'; intent.updatedAt = now();
      event(draft, intent.workflowId, 'workflow.budget', budget); return intent;
    }),
    reconcileIntents: (workflowId: string, lookup: (intent: AgentDispatchIntent) => Promise<{ kind: 'absent' | 'found' | 'unknown'; runId?: string }>) => {
      const needsCheck = (item: AgentDispatchIntent) => item.workflowId === workflowId && item.state !== 'abandoned' && !item.settled;
      return mutate(async draft => {
        const results: { intentId: string; action: 'dispatch' | 'linked' | 'needs_reconciliation' }[] = [];
        for (const intent of draft.intents.filter(needsCheck)) {
          const found = await lookup(copy(intent));
          if (found.kind === 'found' && found.runId) {
            if (intent.runId && intent.runId !== found.runId) { intent.reconciliation = 'needs_reconciliation'; results.push({ intentId: intent.id, action: 'needs_reconciliation' }); }
            else { intent.runId = found.runId; intent.state = 'linked'; intent.reconciliation = 'ready'; results.push({ intentId: intent.id, action: 'linked' }); }
          } else if (found.kind === 'absent' && intent.state === 'intended') { intent.reconciliation = 'ready'; results.push({ intentId: intent.id, action: 'dispatch' }); }
          else { intent.reconciliation = 'needs_reconciliation'; results.push({ intentId: intent.id, action: 'needs_reconciliation' }); }
          intent.updatedAt = now(); event(draft, workflowId, 'workflow.intent', { intentId: intent.id, reconciliation: intent.reconciliation });
        }
        return results;
      }, current => current.intents.some(needsCheck) ? undefined : []);
    },
    acquireLease: async (workspacePath: string, ownerRunId: string, nodeId?: string) => {
      const canonical = await fs.realpath(workspacePath);
      return mutate(draft => {
        const existing = draft.leases.find(item => overlap(item.path, canonical) && item.state !== 'released');
        if (existing) { if (existing.ownerRunId === ownerRunId && existing.path === canonical && existing.state === 'active') return existing; throw new Error(existing.state === 'needs_reconciliation' ? '写入租约需要核对，不能自动释放' : '工作区已有写入者'); }
        const at = now();
        const lease: AgentWriteLease = { path: canonical, ownerRunId, ...(nodeId ? { nodeId } : {}), fencingToken: ++draft.nextFencingToken, state: 'active', acquiredAt: at, updatedAt: at };
        draft.leases = [...draft.leases.filter(item => item.path !== canonical), lease]; return lease;
      });
    },
    bindLeaseRun: async (workspacePath: string, ownerId: string, runId: string, token: number) => {
      const canonical = await fs.realpath(workspacePath);
      return mutate(draft => { const lease = draft.leases.find(item => item.path === canonical && item.ownerRunId === ownerId && item.fencingToken === token && item.state === 'active');
        if (!lease) throw new Error('写入租约已转移'); lease.ownerRunId = runId; lease.updatedAt = now(); return lease; });
    },
    releaseLease: async (workspacePath: string, ownerRunId: string, token: number, processExited: boolean) => {
      const canonical = await fs.realpath(workspacePath);
      return mutate(draft => { const lease = draft.leases.find(item => item.path === canonical && item.ownerRunId === ownerRunId && item.fencingToken === token);
        if (!lease) throw new Error('写入租约已转移');
        if (!processExited) { lease.state = 'needs_reconciliation'; lease.updatedAt = now(); return lease; }
        lease.state = 'released'; lease.updatedAt = now(); return lease; });
    },
    assertLease: async (workspacePath: string, ownerRunId: string, token: number, requireActive = false) => {
      const canonical = await fs.realpath(workspacePath);
      const lease = state.leases.find(item => item.path === canonical && item.ownerRunId === ownerRunId && item.fencingToken === token);
      if (!lease || lease.state === 'needs_reconciliation' || (requireActive && lease.state !== 'active')) throw new Error('补丁来源写入租约已过期或需要核对');
      return copy(lease);
    },
    archiveCompleted: (workflowIds: string[]) => mutate(async draft => {
      const cutoff = Date.parse(now()) - 30 * 24 * 60 * 60 * 1000;
      const archived: string[] = [];
      for (const workflowId of [...new Set(workflowIds)]) {
        const messages = draft.messages.filter(item => item.workflowId === workflowId);
        const intents = draft.intents.filter(item => item.workflowId === workflowId);
        const events = draft.events.filter(item => item.workflowId === workflowId);
        const records = [...messages, ...intents, ...events];
        if (!records.length || records.some(item => Date.parse(item.createdAt) > cutoff)) continue;
        if (intents.some(item => !item.settled && item.state !== 'abandoned')) throw new Error('流程还有未核对的派发意图，不能归档');
        const archiveDirectory = path.join(directory, 'collaboration-archive');
        await fs.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
        const archiveFile = path.join(archiveDirectory, `${hashRequest(workflowId)}.json`);
        const previous = await fs.readFile(archiveFile, 'utf8').then(value => JSON.parse(value) as { messages?: AgentCollaborationMessage[]; intents?: AgentDispatchIntent[]; events?: AgentCollaborationState['events'] },
          (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return { messages: [], intents: [], events: [] }; throw error; });
        const merge = <T extends { id?: string; eventId?: string }>(before: T[], after: T[]) => [...new Map([...before, ...after].map(item => [item.id || item.eventId, item])).values()];
        const temporary = `${archiveFile}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, workflowId, archivedAt: now(),
            messages: merge(previous.messages || [], messages), intents: merge(previous.intents || [], intents), events: merge(previous.events || [], events) }, null, 2), { mode: 0o600 });
          await fs.rename(temporary, archiveFile);
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        const ids = new Set(messages.map(item => item.id));
        draft.messages = draft.messages.filter(item => item.workflowId !== workflowId);
        draft.intents = draft.intents.filter(item => item.workflowId !== workflowId);
        draft.events = draft.events.filter(item => item.workflowId !== workflowId);
        for (const [key, value] of Object.entries(draft.idempotency)) if (typeof value.response === 'string' && ids.has(value.response)) delete draft.idempotency[key];
        // 执行计数和 fencing tombstone 保留，归档不重置已执行次数或使旧补丁重新有效。
        archived.push(workflowId);
      }
      return archived;
    }),
    reconcileLeases: (probe: (lease: AgentWriteLease) => Promise<'exited' | 'active' | 'unknown'>) => mutate(async draft => {
      for (const lease of draft.leases.filter(item => item.state !== 'released')) {
        const result = await probe(copy(lease));
        lease.state = result === 'exited' ? 'released' : result === 'active' ? 'active' : 'needs_reconciliation'; lease.updatedAt = now();
      }
      return draft.leases;
    }, current => current.leases.every(lease => lease.state === 'released') ? current.leases : undefined),
  };
}
export type AgentCollaborationStore = Awaited<ReturnType<typeof createAgentCollaborationStore>>;

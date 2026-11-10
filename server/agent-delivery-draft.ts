/** 交付整理只生成本机草稿；候选、验证、审查与人工验收必须同源。没有任何 Jira 发布能力。 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deliveryAcceptanceRecordSchema, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatusLabels,
  sameDeliverySource, type DeliveryAcceptanceRecord, type DeliveryAcceptanceSource, type DeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentWorkspaceVersion } from '../shared/agent-runtime.js';

export interface AgentDeliveryDraftSource {
  taskId: string; objective: string; candidate: AgentWorkspaceVersion;
  implementation: { runId: string; summary: string; files: string[] };
  verification: { runId: string; candidate: AgentWorkspaceVersion; passed: boolean; evidence: DeliveryEvidence; refs: string[] };
  reviews: { runId: string; candidate: AgentWorkspaceVersion; approved: boolean; summary: string; refs: string[] }[];
  acceptance?: DeliveryAcceptanceRecord; currentSource: DeliveryAcceptanceSource; jiraFixId?: string;
}
export interface AgentDeliveryDraftInput {
  taskId: string; objective: string; candidate: AgentWorkspaceVersion;
  implementation: AgentDeliveryDraftSource['implementation'];
  validation: { kind: string; status: string; evidence: string; refs: string[] }[];
  reviews: { summary: string; refs: string[] }[];
  acceptance: { recordId: string; revision: number; summary: string };
}
export interface AgentDeliveryDraftSections { reason: string; changes: string[]; unverified: string[]; risks: string[] }
export interface AgentDeliveryDraft {
  taskId: string; revision: number; sourceFingerprint: string; text: string; evidenceRefs: string[];
  generatedAt: string; updatedAt: string; jiraHandoff?: { path: string; recordId: string; requiresConfirmation: true };
  jiraDraft: { cause: string; impact: string; suggestion: string; conclusion: string };
}
export interface AgentSecondOpinion { id: string; taskId: string; requestId?: string; candidate: AgentWorkspaceVersion; text: string; createdAt: string; readOnly: true }
const sameVersion = (left: AgentWorkspaceVersion, right: AgentWorkspaceVersion) => left.kind === right.kind && left.value === right.value;
function sourceFingerprint(source: AgentDeliveryDraftSource) { return createHash('sha256').update(JSON.stringify(source)).digest('hex'); }
function requireReady(source: AgentDeliveryDraftSource | undefined): AgentDeliveryDraftSource & { acceptance: DeliveryAcceptanceRecord } {
  if (!source || !source.taskId || !source.candidate.value || !source.verification.passed || !source.reviews.length
    || !sameVersion(source.candidate, source.verification.candidate)
    || source.reviews.some(review => !review.approved || !sameVersion(source.candidate, review.candidate))) throw new Error('当前候选的验证和审查尚未全部通过');
  const acceptance = deliveryAcceptanceRecordSchema.safeParse(source.acceptance);
  if (!acceptance.success || acceptance.data.decision !== 'accepted' || !sameDeliverySource(acceptance.data.source, source.currentSource)) throw new Error('只有当前版本通过人工验收后才能整理交付');
  if (!source.verification.refs.length || source.reviews.some(review => !review.refs.length)) throw new Error('验证或审查缺少可追溯证据链接');
  return { ...source, acceptance: acceptance.data };
}
export function agentDeliveryDraftInput(source: AgentDeliveryDraftSource): AgentDeliveryDraftInput {
  const ready = requireReady(source);
  return { taskId: ready.taskId, objective: ready.objective, candidate: structuredClone(ready.candidate),
    implementation: structuredClone(ready.implementation),
    validation: deliveryEvidenceKinds.map(kind => ({ kind, status: ready.verification.evidence[kind].status,
      evidence: ready.verification.evidence[kind].evidence, refs: [...ready.verification.refs] })),
    reviews: ready.reviews.map(review => ({ summary: review.summary, refs: [...review.refs] })),
    acceptance: { recordId: ready.acceptance.recordId, revision: ready.acceptance.revision, summary: ready.acceptance.summary } };
}
function sections(raw: AgentDeliveryDraftSections) {
  if (!raw || typeof raw.reason !== 'string' || raw.reason.length > 6000 || !Array.isArray(raw.changes)
    || !Array.isArray(raw.unverified) || !Array.isArray(raw.risks)
    || [...raw.changes, ...raw.unverified, ...raw.risks].some(value => typeof value !== 'string' || value.length > 6000)) throw new Error('交付整理结果格式无效');
  return structuredClone(raw);
}
function render(input: AgentDeliveryDraftInput, generated: AgentDeliveryDraftSections) {
  const lines = (values: string[]) => values.length ? values.map(value => `- ${value}`).join('\n') : '- 无';
  return [`# 变更说明\n\n${input.objective}\n\n${generated.reason}\n\n${lines(generated.changes)}`,
    '# 验证情况\n\n' + input.validation.map(item => `- ${deliveryEvidenceLabels[item.kind as keyof DeliveryEvidence]}：${deliveryEvidenceStatusLabels[item.status as keyof typeof deliveryEvidenceStatusLabels]}。${item.evidence} ${item.refs.map(ref => `[证据](${ref})`).join(' ')}`).join('\n'),
    '# 独立审查\n\n' + input.reviews.map(review => `- ${review.summary} ${review.refs.map(ref => `[审查证据](${ref})`).join(' ')}`).join('\n'),
    `# 人工验收\n\n${input.acceptance.summary}（记录 ${input.acceptance.recordId}，修订 ${input.acceptance.revision}）`,
    '# 未验证项\n\n' + lines([...new Set([...input.validation.filter(item => item.status === 'pending').map(item => `${deliveryEvidenceLabels[item.kind as keyof DeliveryEvidence]}：${item.evidence || '未执行'}`), ...generated.unverified])]),
    '# 已知风险\n\n' + lines(generated.risks),
    `候选版本：${input.candidate.kind}:${input.candidate.value}`].join('\n\n');
}

export async function createAgentDeliveryDraftService(directory: string, options: {
  generate: (input: AgentDeliveryDraftInput, context: { requestId: string }) => Promise<AgentDeliveryDraftSections>;
  currentSource: (taskId: string) => AgentDeliveryDraftSource | undefined | Promise<AgentDeliveryDraftSource | undefined>;
  writeJson?: (relative: string, value: unknown) => Promise<void>;
}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'agent-delivery-drafts.json');
  let drafts: AgentDeliveryDraft[] = [], opinions: AgentSecondOpinion[] = [];
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.drafts) || !Array.isArray(state.opinions)) throw new Error('交付草稿格式无效');
    drafts = state.drafts; opinions = state.opinions;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let writing: Promise<unknown> = Promise.resolve();
  const generating = new Map<string, Promise<AgentDeliveryDraft>>();
  const opinionPending = new Map<string, Promise<AgentSecondOpinion>>();
  let closing = false;
  function persist() {
    const state = { version: 1, drafts: structuredClone(drafts), opinions: structuredClone(opinions) };
    const next = writing.then(async () => {
      if (options.writeJson) await options.writeJson('agent-runtimes/agent-delivery-drafts.json', state);
      else { await fs.writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
    }); writing = next.catch(() => undefined); return next;
  }
  function generate(taskId: string, requestId?: string) {
    if (closing) return Promise.reject(new Error('交付整理服务正在关闭'));
    if (generating.has(taskId)) return generating.get(taskId)!;
    const task = (async () => {
      const source = requireReady(await options.currentSource(taskId)), fingerprint = sourceFingerprint(source);
      const previous = drafts.find(draft => draft.taskId === taskId);
      if (previous?.sourceFingerprint === fingerprint) return structuredClone(previous);
      const input = agentDeliveryDraftInput(source), generated = sections(await options.generate(input, { requestId: requestId || `source:${fingerprint}` }));
      if (sourceFingerprint(requireReady(await options.currentSource(taskId))) !== fingerprint) throw new Error('生成期间候选或验收已变化，草稿未保存');
      const now = new Date().toISOString();
      const record: AgentDeliveryDraft = { taskId, revision: (previous?.revision || 0) + 1, sourceFingerprint: fingerprint,
        text: render(input, generated), evidenceRefs: [...new Set([...source.verification.refs, ...source.reviews.flatMap(review => review.refs)])],
        generatedAt: now, updatedAt: now,
        jiraDraft: { cause: generated.reason || input.objective, impact: generated.changes.join('\n') || source.implementation.summary,
          suggestion: input.validation.map(item => `${item.kind}: ${item.evidence} ${item.refs.join(' ')}`).join('\n'), conclusion: input.acceptance.summary },
        ...(source.jiraFixId ? { jiraHandoff: { path: '/agent?view=jira-fix', recordId: source.jiraFixId, requiresConfirmation: true as const } } : {}) };
      drafts = [...drafts.filter(draft => draft.taskId !== taskId), record]; await persist(); return structuredClone(record);
    })();
    generating.set(taskId, task); void task.finally(() => generating.delete(taskId)).catch(() => undefined); return task;
  }
  async function save(taskId: string, expectedRevision: number, text: string) {
    if (closing) throw new Error('交付整理服务正在关闭');
    if (!text.trim() || text.length > 50_000) throw new Error('交付草稿内容无效');
    if (generating.has(taskId)) throw new Error('交付草稿正在生成');
    const source = requireReady(await options.currentSource(taskId)), record = drafts.find(draft => draft.taskId === taskId);
    if (!record || record.revision !== expectedRevision) throw new Error('交付草稿已更新，请重新读取');
    if (record.sourceFingerprint !== sourceFingerprint(source)) throw new Error('交付来源已变化，请重新生成草稿');
    const next = { ...record, revision: record.revision + 1, text, updatedAt: new Date().toISOString() };
    drafts = drafts.map(draft => draft.taskId === taskId ? next : draft); await persist(); return structuredClone(next);
  }
  function secondOpinion(taskId: string, callback: (source: Omit<AgentDeliveryDraftSource, 'acceptance'>) => Promise<string>, requestId: string = randomUUID()) {
    if (closing) return Promise.reject(new Error('交付整理服务正在关闭'));
    const existing = opinions.find(opinion => opinion.taskId === taskId && opinion.requestId === requestId);
    if (existing) return Promise.resolve(structuredClone(existing));
    const key = `${taskId}:${requestId}`;
    if (opinionPending.has(key)) return opinionPending.get(key)!;
    const task = (async () => {
      const source = await options.currentSource(taskId);
      if (!source) throw new Error('找不到当前任务材料');
      const { acceptance: _acceptance, ...input } = structuredClone(source);
      const text = await callback(input);
      if (typeof text !== 'string' || !text.trim() || text.length > 50_000) throw new Error('第二意见结果无效');
      const record: AgentSecondOpinion = { id: randomUUID(), taskId, requestId, candidate: source.candidate, text, createdAt: new Date().toISOString(), readOnly: true };
      opinions.push(record); await persist(); return structuredClone(record);
    })();
    opinionPending.set(key, task); void task.finally(() => opinionPending.delete(key)).catch(() => undefined); return task;
  }
  return { generate, save, secondOpinion, get: (taskId: string) => structuredClone(drafts.find(draft => draft.taskId === taskId)),
    list: () => structuredClone(drafts), opinions: (taskId?: string) => structuredClone(opinions.filter(opinion => !taskId || opinion.taskId === taskId)),
    close: async () => { closing = true; await Promise.allSettled([...generating.values(), ...opinionPending.values()]); await writing; } };
}

/** 修复与 Jira 交接分离；逐步持久化外部写入结果，超时/重启不盲目重放评论。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRun } from '../shared/agent-runtime.js';
import { jiraIssueKey, type JiraFixRecord } from '../shared/jira-fix.js';
import { jiraFixHandoffInputSchema, jiraFixHandoffComment, type JiraFixHandoffState, type JiraFixHandoffContext,
  jiraCommentGenerateSchema, jiraCommentDraftSchema, jiraStatusChangeInputSchema, jiraTestingPath, validateJiraTransitionFields, type JiraStatusChangeState, type JiraCommentDraft, type JiraHandoffStep } from '../shared/jira-fix-handoff.js';
import type { JiraHandoffSource } from './jira-handoff-client.js';
import { generateJiraComment, type JiraCommentGenerator } from './jira-comment-generator.js';

export async function createJiraFixHandoffService(directory: string,
  find: (id: string) => { record: JiraFixRecord; run?: AgentRun; history?: { objective: string; result: string; status: string }[] } | undefined,
  source: JiraHandoffSource, generator: JiraCommentGenerator = generateJiraComment) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const states = new Map<string, JiraFixHandoffState>();
  const pending = new Map<string, Promise<JiraFixHandoffState>>();
  const statusPending = new Map<string, Promise<JiraStatusChangeState>>();
  const statusChanges = new Map<string, JiraStatusChangeState[]>();
  const generating = new Map<string, { controller: AbortController; task: Promise<JiraCommentDraft> }>();
  for (const file of await fs.readdir(directory)) if (/^[0-9a-f-]{36}\.status\.json$/.test(file)) {
    const changes = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as JiraStatusChangeState[];
    for (const state of changes) if (state.status === 'submitting') {
      state.status = 'uncertain'; state.error = '服务中断，状态写入结果待核对，不会自动重放。';
    }
    statusChanges.set(file.slice(0, -12), changes);
  }
  for (const file of await fs.readdir(directory)) if (/^[0-9a-f-]{36}\.json$/.test(file)) {
    const state = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as JiraFixHandoffState;
    if (state.status === 'submitting') {
      state.status = state.inFlight && state.inFlight !== 'verify' ? 'uncertain' : 'failed';
      state.error = state.status === 'uncertain' ? '服务中断，写入结果不确定；请到 Jira 核对，系统不会自动重放。' : '服务中断，可重试剩余步骤。';
    }
    states.set(file.slice(0, -5), state);
  }
  async function save(id: string, state: JiraFixHandoffState) {
    state.updatedAt = new Date().toISOString();
    const file = path.join(directory, `${id}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  function ready(id: string, runId?: string) {
    const found = find(id);
    if (!found) throw new Error('找不到 Jira 修复记录');
    if (!found.run || found.run.status !== 'completed' || found.run.pausedForEdit || runId && found.run.id !== runId) {
      throw new Error('修复会话尚未结束或已有新一轮执行，请刷新后核对结果');
    }
    return { ...found, run: found.run, key: jiraIssueKey(found.record.input.issueKey) };
  }
  async function saveStatus(id: string) {
    const file = path.join(directory, `${id}.status.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(statusChanges.get(id)), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  async function checkStatus(id: string, key: string) {
    const last = statusChanges.get(id)?.at(-1);
    if (last?.status === 'uncertain') {
      const issue = await source.readIssue(key);
      if (issue.status.id !== (last.inFlightStatusId || last.input.targetStatusId)) throw new Error('上次状态写入结果不确定，请先到 Jira 核对；系统不会重复流转。');
      last.status = issue.status.id === last.input.targetStatusId ? 'completed' : 'failed';
      last.result = issue; last.error = last.status === 'failed' ? `已核对停在“${issue.status.name}”，请重新选择目标继续。` : ''; last.updatedAt = new Date().toISOString();
      await saveStatus(id);
    }
  }
  async function changeStatus(id: string, raw: unknown): Promise<JiraStatusChangeState> {
    const input = jiraStatusChangeInputSchema.parse(raw);
    const { key } = ready(id, input.runId);
    if (states.has(id)) throw new Error('已有交接记录，不能单独修改已确认的交接目标');
    await checkStatus(id, key);
    const changes = statusChanges.get(id) || [];
    const previous = changes.find(item => item.input.requestId === input.requestId);
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error('同一状态请求不能更换目标');
      return previous;
    }
    const issue = await source.readIssue(key);
    if (issue.status.id !== input.fromStatusId) throw new Error('Jira 当前状态已变化，请重新打开后选择');
    if (input.fromStatusId === input.targetStatusId) throw new Error('请选择不同于当前状态的目标');
    const transitions = await source.transitions(key);
    const targets = [...(input.viaStatusIds || []), input.targetStatusId];
    if (input.viaStatusIds) {
      const plan = jiraTestingPath(issue, await source.statuses(key), transitions);
      if (!plan || plan.transitionId !== input.transitionId || JSON.stringify(plan.statuses.map(item => item.id)) !== JSON.stringify(targets)) throw new Error('提测路径已变化，请重新打开核对后确认');
    } else if (!transitions.some(item => item.id === input.transitionId && item.to.id === input.targetStatusId)) throw new Error('所选流转已不可用，请重新读取 Jira 状态');
    validateJiraTransitionFields(transitions.find(item => item.id === input.transitionId)!, input.transitionFields);
    ready(id, input.runId);
    const state: JiraStatusChangeState = { input, status: 'submitting', error: '', updatedAt: new Date().toISOString() };
    changes.push(state); statusChanges.set(id, changes);
    // 先持久化写入意图；网络超时或服务中断只回读核对，不重放流转。
    await saveStatus(id);
    for (const [index, target] of targets.entries()) {
      // 每一步重新确认当前状态和真实流转，不能将完整状态目录当作权限或可达性证明。
      try {
        ready(id, input.runId);
        const current = await source.readIssue(key);
        if (current.status.id !== (index ? targets[index - 1] : input.fromStatusId)) throw new Error('Jira 当前状态发生变化，已停止后续流转');
        const available = await source.transitions(key);
        const matches = available.filter(item => item.to.id === target && (index > 0 || item.id === input.transitionId));
        if (matches.length !== 1) throw new Error(`当前“${current.status.name}”不允许下一步流转，已停止；请核对工作流或权限`);
        const fields = index === 0 ? input.transitionFields : undefined;
        validateJiraTransitionFields(matches[0]!, fields);
        state.inFlightStatusId = target; state.status = 'submitting'; await saveStatus(id);
        try {
          await source.transition(key, matches[0]!.id, fields);
          state.status = 'uncertain';
        } catch (error) {
          state.status = (error as { definite?: boolean }).definite ? 'failed' : 'uncertain';
          state.error = error instanceof Error ? error.message : '状态写入失败';
        }
        if (state.status === 'uncertain') {
          try {
            state.result = await source.readIssue(key);
            if (state.result.status.id === target) { state.status = target === input.targetStatusId ? 'completed' : 'submitting'; state.error = ''; }
          } catch { /* 保留不确定状态，不重放当前步骤。 */ }
          if (state.status === 'uncertain') state.error = '状态写入结果尚未回读确认，请到 Jira 核对，系统不会自动重放。';
        }
      } catch (error) {
        state.status = 'failed'; state.error = error instanceof Error ? error.message : '状态生效失败';
      }
      state.updatedAt = new Date().toISOString(); await saveStatus(id);
      if (state.status === 'failed' || state.status === 'uncertain') break;
    }
    state.updatedAt = new Date().toISOString(); await saveStatus(id);
    return state;
  }
  async function context(id: string): Promise<JiraFixHandoffContext> {
    const { key, run } = ready(id);
    const [issue, transitions, catalog] = await Promise.all([source.readIssue(key), source.transitions(key),
      source.statuses(key).then(statuses => ({ statuses, statusWarning: '' })).catch(() => ({
        statuses: undefined, statusWarning: '完整状态读取失败，当前仅展示可直接流转的状态；请重新打开后重试。',
      }))]);
    return { issue, transitions, ...catalog, testingPath: jiraTestingPath(issue, catalog.statuses || [], transitions),
      runId: run.id, result: run.result, handoff: states.get(id), statusChange: statusChanges.get(id)?.at(-1) };
  }
  async function execute(id: string, raw: unknown): Promise<JiraFixHandoffState> {
    const input = jiraFixHandoffInputSchema.parse(raw);
    const { key } = ready(id, input.runId);
    await checkStatus(id, key);
    let state = states.get(id);
    if (state) {
      if (JSON.stringify(state.input) !== JSON.stringify(input)) throw new Error('已有交接记录，请沿用原内容核对或重试，不能重复创建评论');
      if (state.status === 'completed' || state.status === 'uncertain') return state;
    }
    // 写入前重新读取，禁止按过期状态或同名展示文案猜测报告人。
    const issue = await source.readIssue(key);
    if (!issue.reporter?.active || issue.reporter.id !== input.reporterId) throw new Error('报告人缺失、已停用或发生变化，请重新打开核对');
    if (issue.status.id !== input.targetStatusId && !state?.transitioned) {
      const transitions = await source.transitions(key);
      if (!transitions.some(item => item.id === input.transitionId && item.to.id === input.targetStatusId)) {
        throw new Error('所选流转已不可用，请重新读取 Jira 状态');
      }
      validateJiraTransitionFields(transitions.find(item => item.id === input.transitionId)!, input.transitionFields);
    }
    ready(id, input.runId);
    state ||= { input, status: 'submitting', commentId: '', transitioned: false, assigned: false, error: '', updatedAt: '' };
    state.status = 'submitting'; state.error = ''; states.set(id, state);
    await save(id, state);
    const checkpoint = async (step: JiraHandoffStep, action: () => Promise<void>) => {
      state!.inFlight = step; await save(id, state!);
      await action();
      state!.inFlight = undefined; await save(id, state!);
    };
    try {
      if (!state.commentId) await checkpoint('comment', async () => { state!.commentId = await source.comment(key, jiraFixHandoffComment(input)); });
      if (!state.transitioned) await checkpoint('transition', async () => {
        const current = await source.readIssue(key);
        if (current.status.id !== input.targetStatusId) await source.transition(key, input.transitionId, input.transitionFields);
        state!.transitioned = true;
      });
      if (!state.assigned) await checkpoint('assign', async () => {
        const current = await source.readIssue(key);
        if (current.reporter?.id !== input.reporterId || !current.reporter.active) {
          throw Object.assign(new Error('报告人在交接期间发生变化，请到 Jira 核对后处理'), { definite: true });
        }
        if (current.assignee?.id !== input.reporterId) await source.assign(key, current.reporter);
        state!.assigned = true;
      });
      await checkpoint('verify', async () => {
        const [result, comment] = await Promise.all([source.readIssue(key), source.readComment(key, state!.commentId)]);
        state!.result = result;
        if (result.status.id !== input.targetStatusId || result.assignee?.id !== input.reporterId || comment !== jiraFixHandoffComment(input)) {
          throw new Error('Jira 回读与交接目标不一致，请到 Jira 核对；不会重复执行已完成的步骤');
        }
      });
      state.status = 'completed';
    } catch (error) {
      const uncertain = state.inFlight && state.inFlight !== 'verify' && !(error as { definite?: boolean }).definite;
      state.status = uncertain ? 'uncertain' : 'failed';
      state.error = (error instanceof Error ? error.message : '交接失败') + (uncertain ? '；写入结果不确定，请到 Jira 核对，系统不会自动重放。' : '');
      if (!uncertain) state.inFlight = undefined;
    }
    await save(id, state);
    return state;
  }
  return {
    context, state: (id: string) => states.get(id),
    applyStatus(id: string, raw: unknown) {
      if (pending.has(id) || statusPending.has(id) || generating.has(id)) return Promise.reject(new Error('该事项正在处理，请稍候再修改状态'));
      const task = changeStatus(id, raw).finally(() => statusPending.delete(id));
      statusPending.set(id, task); return task;
    },
    async generate(id: string, raw: unknown, signal?: AbortSignal) {
      const input = jiraCommentGenerateSchema.parse(raw);
      const { record, run, history, key } = ready(id, input.runId);
      if (states.has(id) || pending.has(id)) throw new Error('已有交接记录，不能重新生成已确认的评论');
      if (statusPending.has(id)) throw new Error('状态正在生效，请稍候');
      if (generating.has(id)) throw new Error('评论正在生成，请稍候');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const task = (async () => {
        controller.signal.throwIfAborted();
        const issue = await source.readIssue(key);
        const result = history?.length ? JSON.stringify(history) : run.result;
        if (!result.trim() || result.length > 200_000) throw new Error('修复结果缺失或过长，请先在修复会话整理交接结果');
        const draft = jiraCommentDraftSchema.parse(await generator({
          issue: { key: issue.key, summary: issue.summary, description: record.issue?.description },
          notes: record.input.notes || '', result, model: run.provider === 'codex' ? run.model : '',
          draft: input.draft, feedback: input.feedback,
        }, controller.signal));
        controller.signal.throwIfAborted();
        ready(id, input.runId);
        return draft;
      })().finally(() => { generating.delete(id); signal?.removeEventListener('abort', abort); });
      generating.set(id, { controller, task });
      return task;
    },
    submit(id: string, raw: unknown) {
      if (statusPending.has(id)) return Promise.reject(new Error('状态正在生效，请稍候'));
      if (generating.has(id)) return Promise.reject(new Error('请等待评论生成完成并预览后再提交'));
      if (pending.has(id)) return Promise.reject(new Error('该交接正在提交，请勿重复操作'));
      const task = execute(id, raw).finally(() => pending.delete(id));
      pending.set(id, task); return task;
    },
    close: () => {
      for (const item of generating.values()) item.controller.abort();
      return Promise.allSettled([...pending.values(), ...statusPending.values(), ...[...generating.values()].map(item => item.task)]);
    },
  };
}

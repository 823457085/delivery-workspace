import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AgentRun } from '../shared/agent-runtime.js';
import { readDeliveryEvidenceReport } from '../shared/delivery-acceptance.js';
import { readAgentDeliveryReport } from '../shared/delivery-report.js';
import type { AutomationSettings, JiraIssue } from '../shared/hub.js';
import type { JiraDevAutomationResult, JiraDevAutomationStep, JiraDevLaunch } from '../shared/jira-dev.js';
import { jiraDevBoundIssue, type JiraDevAutomationPrompt } from './jira-dev-prompt.js';
import { inspectTaskWorkspace, type JiraDevTaskRecord } from './jira-dev/index.mjs';
import { jiraDevAutomationWorkspaceReady, resolveJiraDevMrProject, type JiraDevMergeRequestResult } from './jira-dev-automation-mr.js';
import type { JiraDevStatusPhase, JiraDevStatusResult } from './jira-dev-automation-status.js';
import { readProjectGitSnapshot, redact } from './project-git.js';
import { jiraDevVerificationFingerprint } from './agent-runtime.js';

type Binding = { key: string; url: string };
type LaunchBinding = Pick<JiraDevLaunch, 'runId' | 'teamTaskId' | 'groupRoomId' | 'conversationId'>;
type Entry = {
  taskId: string; workflow: JiraDevTaskRecord['workflow']; issue: Binding; startedAt: string; policy: string;
  launch?: LaunchBinding; resultVersion?: string; mergeHead?: string; mrApproved?: boolean; results: JiraDevAutomationResult;
};
type Options = {
  directory: string;
  readSettings(): Promise<AutomationSettings>;
  readTask(taskId: string): Promise<JiraDevTaskRecord>;
  readIssue(binding: Binding): Promise<JiraIssue>;
  readRun(taskId: string, workflow: JiraDevTaskRecord['workflow'], launch: LaunchBinding): Promise<AgentRun | undefined>;
  advance(binding: Binding, status: string, phase: JiraDevStatusPhase, beforeWrite: () => Promise<void>): Promise<JiraDevStatusResult>;
  mergeRequest(input: { issue: JiraIssue; settings: AutomationSettings; sourceProjectPath: string; workspacePath: string;
    branchName: string; baseSha: string; verifiedHead: string }, beforeCreate: () => Promise<void>): Promise<JiraDevMergeRequestResult>;
};

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const reportSchema = z.object({ jiraDevDelivery: z.object({
  issueKey: z.string(), status: z.enum(['passed', 'blocked']), verifiedHead: z.string().optional(),
}).strict(), requirementDelivery: z.object({
  scenarios: z.array(z.object({ status: z.string() })).optional(),
  i18n: z.object({ status: z.string() }).optional(),
  api: z.object({ status: z.string() }).optional(),
}).optional() });
function verification(result: string, issueKey: string) {
  const report = reportSchema.safeParse(readAgentDeliveryReport(result));
  const evidence = readDeliveryEvidenceReport(result);
  if (!report.success || report.data.jiraDevDelivery.issueKey !== issueKey || report.data.jiraDevDelivery.status !== 'passed'
    || evidence?.tests.status !== 'passed' || !['passed', 'not_applicable'].includes(evidence.browser.status)
    || evidence.remote.status === 'failed' || evidence.deployment.status === 'failed') {
    throw new Error('本轮未提供与该事项绑定的验证通过报告，或适用检查尚未通过。');
  }
  const detail = report.data.requirementDelivery;
  if (detail?.scenarios?.some(item => item.status !== 'passed')
    || (detail?.i18n && !['ready', 'not_applicable'].includes(detail.i18n.status))
    || (detail?.api && !['passed', 'not_applicable'].includes(detail.api.status))) {
    throw new Error('业务场景、多语言或接口验证仍有未通过项。');
  }
  return report.data.jiraDevDelivery.verifiedHead || '';
}

function policy(settings: AutomationSettings) {
  if (!settings.enabled || !settings.jiraDevAutomationApproved || !(settings.autoTransitionJira || settings.autoCreateMergeRequest)) return '';
  return createHash('sha256').update(JSON.stringify([settings.autoTransitionJira, settings.startStatus, settings.completedStatus,
    settings.autoCreateMergeRequest, settings.reviewer, settings.projectProfiles])).digest('hex');
}
function blocked(error: unknown): JiraDevAutomationStep {
  return { status: (error as { uncertain?: boolean })?.uncertain ? 'uncertain' : 'blocked',
    message: redact(error instanceof Error ? error.message : '自动交付失败，请核对任务。').slice(0, 800) };
}

export async function createJiraDevAutomation(options: Options) {
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<void>>();
  const wake = new Set<string>();
  let closed = false;
  async function save(entry: Entry) {
    const filename = path.join(options.directory, `${entry.taskId}.json`);
    await fs.writeFile(`${filename}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(`${filename}.tmp`, filename);
  }
  for (const filename of await fs.readdir(options.directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
    const entry = await fs.readFile(path.join(options.directory, filename), 'utf8')
      .then(text => JSON.parse(text) as Entry).catch(() => undefined);
    if (!entry?.results || `${entry.taskId}.json` !== filename) continue;
    let interrupted = false;
    for (const key of ['start', 'mergeRequest', 'complete'] as const) if (entry.results[key]?.status === 'running') {
      entry.results[key] = { status: 'uncertain', message: '上次自动操作结果待回读，请到对应平台核对。' };
      interrupted = true;
    }
    if (interrupted) await save(entry);
    entries.set(entry.taskId, entry);
  }
  async function prepare(task: JiraDevTaskRecord, launch: JiraDevLaunch): Promise<JiraDevAutomationPrompt | undefined> {
    const issue = jiraDevBoundIssue(task);
    if (!issue?.key || !issue.url || closed) return;
    let settings: AutomationSettings;
    try { settings = await options.readSettings(); } catch { return; }
    const approved = policy(settings);
    if (!approved) return;
    const entry: Entry = { taskId: task.taskId, workflow: task.workflow, issue: { key: issue.key, url: issue.url },
      startedAt: launch.startedAt, policy: approved, results: {} };
    const prompt: JiraDevAutomationPrompt = { report: true };
    if (settings.autoCreateMergeRequest) {
      try {
        if (task.projects && task.projects.length > 1) throw new Error('多项目交付需逐仓库核对。');
        const found = await resolveJiraDevMrProject(await options.readIssue(entry.issue), settings, task.sourceProjectPath);
        const [snapshot] = await inspect(task);
        if (!snapshot || !jiraDevAutomationWorkspaceReady(snapshot, entry.issue.key)) throw new Error('任务工作区有预先存在的未核对改动，请先处理。');
        entry.mrApproved = true;
        if (launch.runtime.collaborationMode !== 'automatic') {
          prompt.git = { repositoryUrl: redact(found.profile.repositoryUrl), targetBranch: found.profile.targetBranch };
        }
      } catch (error) { entry.results.mergeRequest = blocked(error); }
    }
    await save(entry);
    entries.set(task.taskId, entry);
    return prompt;
  }
  async function assertPolicy(entry: Entry) {
    const settings = await options.readSettings();
    if (closed || policy(settings) !== entry.policy) throw new Error('自动交付设置已变化，请核对本次任务的交付方式。');
    return settings;
  }
  async function step(entry: Entry, key: 'start' | 'mergeRequest' | 'complete', action: () => Promise<JiraDevAutomationStep>) {
    entry.results[key] = { status: 'running', message: '正在执行并回读核对。' };
    await save(entry);
    try { entry.results[key] = await action(); }
    catch (error) { entry.results[key] = blocked(error); }
    await save(entry);
  }
  async function checkTask(entry: Entry) {
    const task = await options.readTask(entry.taskId);
    const bound = jiraDevBoundIssue(task);
    if (bound?.key !== entry.issue.key || bound.url !== entry.issue.url || task.workflow !== entry.workflow) {
      throw new Error('当前 Jira 事项与任务启动时的绑定不一致。');
    }
    return task;
  }
  async function inspect(task: JiraDevTaskRecord) {
    const projects = task.projects?.length ? task.projects : [{
      path: task.sourceProjectPath, workspacePath: task.projectPath, branchName: task.branchName, baseSha: task.baseSha,
    }];
    return Promise.all(projects.map(async project => {
      if (!project.workspacePath || !project.baseSha) throw new Error('未找到已绑定的任务工作区和基准提交。');
      const workspace = await inspectTaskWorkspace({ projectPath: project.workspacePath, sourceProjectPath: project.path,
        branchName: project.branchName, baseSha: project.baseSha });
      const snapshot = await readProjectGitSnapshot(workspace.workspacePath);
      if (!snapshot.isGit || snapshot.directory !== workspace.workspacePath || snapshot.branch !== project.branchName
        || snapshot.mergeInProgress || snapshot.counts.conflicts || snapshot.truncated) throw new Error('任务工作区有冲突、改动列表不完整或分支不一致。');
      return snapshot;
    }));
  }
  async function advance(entry: Entry, phase: JiraDevStatusPhase, target: string, check: () => Promise<void>) {
    const result = await options.advance(entry.issue, target, phase, check);
    return { status: 'completed' as const, message: result.reason ? `${result.currentStatus} · ${result.reason}` : `已回读 Jira 状态「${result.currentStatus}」。` };
  }
  async function assertVerifiedVersion(run: AgentRun, snapshots: Awaited<ReturnType<typeof inspect>>, issueKey: string) {
    const versions = await Promise.all(snapshots.map(snapshot => jiraDevVerificationFingerprint(snapshot.directory, issueKey)));
    if (!run.jiraDevVerification || versions.length !== run.jiraDevVerification.length
      || versions.some((version, index) => version !== run.jiraDevVerification?.[index])) {
      throw new Error('当前工作区内容与运行结束时核对的验证版本不一致，请重新验证。');
    }
  }
  async function process(entry: Entry) {
    const launch = entry.launch!;
    const run = await options.readRun(entry.taskId, entry.workflow, launch);
    if (!run || run.status === 'queued') return;
    const settings = await assertPolicy(entry);
    const task = await checkTask(entry);
    if (settings.autoTransitionJira && !entry.results.start && ['running', 'completed'].includes(run.status)) {
      await step(entry, 'start', () => advance(entry, 'start', settings.startStatus, async () => {
        await assertPolicy(entry);
        await checkTask(entry);
        const current = await options.readRun(entry.taskId, entry.workflow, launch);
        if (!current || !['running', 'completed'].includes(current.status)) throw new Error('任务未处于实际运行或已完成状态。');
      }));
    }
    if (run?.status !== 'completed' || !run.resultReady || run.mode !== 'agent'
      || Date.parse(run.createdAt) < Date.parse(entry.startedAt)) return;
    const runUpdatedAt = run.updatedAt;
    const resultVersion = `${run.id}:${runUpdatedAt}`;
    if (entry.resultVersion === resultVersion) return;
    if (entry.results.complete?.status === 'completed' || entry.results.complete?.status === 'uncertain'
      || entry.results.mergeRequest?.status === 'uncertain') return;
    let verifiedHead: string, snapshots: Awaited<ReturnType<typeof inspect>>;
    try {
      if (!launch.groupRoomId && !launch.teamTaskId && await fs.realpath(run.workspacePath) !== await fs.realpath(task.projectPath)) {
        throw new Error('本轮验证所在的工作区与 Jira 任务不一致。');
      }
      verifiedHead = verification(run.result, entry.issue.key);
      snapshots = await inspect(task);
      await assertVerifiedVersion(run, snapshots, entry.issue.key);
      if (verifiedHead && (!sha.test(verifiedHead) || snapshots[0]!.head !== verifiedHead)) {
        throw new Error('任务分支 HEAD 与报告中的验证提交不一致。');
      }
      entry.results.verification = { status: 'completed', message: '已核对当前任务的验证报告及工作区。' };
    } catch (error) {
      entry.results.verification = blocked(error);
      entry.resultVersion = resultVersion;
      await save(entry);
      return;
    }
    await save(entry);
    async function current() {
      await assertPolicy(entry);
      await checkTask(entry);
      const latest = await options.readRun(entry.taskId, entry.workflow, launch);
      if (latest?.id !== run!.id || latest.updatedAt !== runUpdatedAt || !latest.resultReady) throw new Error('任务已进入新的执行轮次，请等待本轮验证。');
      await assertVerifiedVersion(latest, snapshots, entry.issue.key);
    }
    if (settings.autoCreateMergeRequest && entry.mrApproved
      && (entry.results.mergeRequest?.status !== 'completed' || entry.mergeHead !== verifiedHead)) {
      await step(entry, 'mergeRequest', async () => {
        await current();
        if (snapshots.length !== 1) throw new Error('多项目交付需逐仓库确认，当前自动 MR 仅接收单仓库验证结果。');
        if (!sha.test(verifiedHead) || !task.baseSha) throw new Error('请提交本次验证过的改动，并在本轮报告中填写完整提交 SHA。');
        const result = await options.mergeRequest({ issue: await options.readIssue(entry.issue), settings, sourceProjectPath: task.sourceProjectPath,
          workspacePath: task.projectPath, branchName: task.branchName, baseSha: task.baseSha, verifiedHead }, current);
        if (result.status === 'created' || result.status === 'existing') entry.mergeHead = verifiedHead;
        return { status: result.status === 'created' || result.status === 'existing' ? 'completed' : 'blocked',
          message: result.message, ...('url' in result ? { url: result.url } : {}) };
      });
    }
    if (settings.autoTransitionJira && entry.results.start?.status !== 'uncertain'
      && (!settings.autoCreateMergeRequest || entry.results.mergeRequest?.status === 'completed')) {
      await step(entry, 'complete', () => advance(entry, 'complete', settings.completedStatus, async () => {
        await current();
        const latest = await inspect(task);
        if (latest.some((snapshot, index) => settings.autoCreateMergeRequest
          ? snapshot.head !== verifiedHead || !jiraDevAutomationWorkspaceReady(snapshot, entry.issue.key)
          : snapshot.revision !== snapshots[index]?.revision)) {
          throw new Error('验证后工作区又有变化，请重新验证。');
        }
      }));
    }
    entry.resultVersion = resultVersion;
    await save(entry);
  }
  function refresh(taskId: string) {
    const entry = entries.get(taskId);
    if (!entry?.launch || closed) return;
    wake.add(taskId);
    if (pending.has(taskId)) return;
    const work = Promise.resolve().then(async () => {
      while (wake.delete(taskId) && !closed) {
        try { await process(entry); }
        catch (error) {
          if (!entry.results.verification) {
            entry.results.verification = blocked(error);
            await save(entry);
          }
        }
      }
    }).catch(error => console.error('无法保存 Jira 研发自动交付状态：', blocked(error).message))
      .finally(() => { pending.delete(taskId); if (wake.has(taskId) && !closed) refresh(taskId); });
    pending.set(taskId, work);
  }
  async function activate(task: JiraDevTaskRecord, launch: JiraDevLaunch) {
    const entry = entries.get(task.taskId);
    if (!entry || entry.startedAt !== launch.startedAt || !['started'].includes(launch.status) || closed) return;
    if (!entry.launch) {
      const { runId, teamTaskId, groupRoomId, conversationId } = launch;
      entry.launch = { runId, teamTaskId, groupRoomId, conversationId };
      await save(entry);
    }
    refresh(task.taskId);
  }
  return {
    prepare, activate, refresh,
    refreshTeam(teamTaskId: string) {
      for (const entry of entries.values()) if (entry.launch?.teamTaskId === teamTaskId) refresh(entry.taskId);
    },
    refreshGroup(groupRoomId: string) {
      for (const entry of entries.values()) if (entry.launch?.groupRoomId === groupRoomId) refresh(entry.taskId);
    },
    status(taskId: string) { return entries.has(taskId) ? structuredClone(entries.get(taskId)!.results) : undefined; },
    isIdle: () => pending.size === 0,
    close: async () => { closed = true; await Promise.allSettled([...pending.values()]); },
  };
}

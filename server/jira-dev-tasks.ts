/**
 * 设计说明：搬运 Jira 研发助手插件的“预览 → 确认 Jira 写入 → 创建独立 worktree”流程，
 * 最后一步由新建 Codex 聊天改为在工作台按所选 CLI / 模型启动会话，并登记为原有修复或需求记录。
 * Jira 连接沿用插件选定的本人来源；任务计划与项目默认值保存在工作台数据目录，不改插件数据。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createConnectionSettings, createProjectPreferences, createRequirementStore, createTaskRecords, createTaskWorkspace, groupRepositories,
  inspectTaskWorkspace, prepareTask, readBranchOptions, readProjectStatus, readTaskIssue, repositoryIdentity, scanProjects,
  type JiraDevClient, type JiraDevIssue, type JiraDevPlan, type JiraDevTaskRecord, type JiraDevWorkspace } from './jira-dev/index.mjs';
import { buildJiraDevPrompt, buildRequirementPreparationPrompt, jiraDevBoundIssue, jiraDevTaskTitle } from './jira-dev-prompt.js';
import { jiraDevApplySchema, jiraDevCheckSchema, jiraDevNeedsApply, jiraDevPrepareSchema, jiraDevPreferenceSaveSchema, jiraDevProjectSchema, jiraDevScanSchema,
  jiraDevSourceSchema, jiraDevStartBlocker, jiraDevStartSchema, jiraDevTaskSchema, jiraDevVersionSchema,
  jiraDevRequirementDocumentSchema, jiraDevRequirementPhaseStartSchema, jiraDevRequirementLabels, type JiraDevRequirementDocument, type JiraDevRequirementPhase,
  type JiraDevAutomationResult, type JiraDevIssueReadResult, type JiraDevLaunch, type JiraDevPlanView, type JiraDevTaskView, type JiraDevProjectSelection } from '../shared/jira-dev.js';
import type { AgentAccessMode, AgentRun, AgentRunStatus, StartAgentRunInput } from '../shared/agent-runtime.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development.js';
import type { JiraDevScanPreview, JiraIssue, PlanItem } from '../shared/hub.js';
import { readDeliveryReport } from '../shared/delivery-report.js';
import { groupRunStatus, type GroupBinding, type GroupJiraSource, type GroupExecutionProgress } from '../shared/agent-group-chat.js';

const exec = promisify(execFile);
const failure = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });

interface Runtime {
  startJiraFix(input: StartAgentRunInput, sourceId: string, title: string): Promise<AgentRun>;
  findJiraFix(sourceId: string): AgentRun | undefined;
  startRequirementDevelopment(input: StartAgentRunInput, sourceId: string, title: string, modelAlias?: GroupBinding['catalogAlias']): Promise<AgentRun>;
  findRequirementDevelopment(sourceId: string): AgentRun | undefined;
  getRun?(id: string): AgentRun | undefined;
}
export interface JiraDevTeamLaunch {
  teamTaskId: string; conversationId: string; runId: string; runStatus?: AgentRunStatus;
}
export interface JiraDevGroupLaunch { groupRoomId: string; groupProgress: GroupExecutionProgress; runId: string }
interface Options {
  dataDirectory: string;
  /** 插件保存“Jira 连接”选择的目录；只读取，不改写插件连接。 */
  connectionDirectory?: string;
  runtime: Runtime;
  startTeam?(input: { objective: string; workspacePath: string; accessMode: AgentAccessMode; requestId: string }): Promise<JiraDevTeamLaunch>;
  findTeam?(requestId: string): JiraDevTeamLaunch | undefined;
  preflightGroup?(revision: number | undefined, workspacePath: string, accessMode: AgentAccessMode, sourceProjectPaths?: string[]): Promise<void>;
  requirementReader?(revision: number | undefined): Promise<GroupBinding>;
  startGroup?(input: { source: GroupJiraSource; objective: string; workspacePath: string; accessMode: AgentAccessMode; requestId: string; expectedConfigRevision: number }): Promise<JiraDevGroupLaunch>;
  findGroup?(taskId: string): JiraDevGroupLaunch | undefined;
  adoptJiraFix(record: JiraFixRecord): Promise<unknown>;
  adoptRequirement(record: RequirementDevelopmentRecord): Promise<unknown>;
  onLaunch?(task: JiraDevTaskRecord, launch: JiraDevLaunch): void | Promise<void>;
  prepareAutomationDelivery?(task: JiraDevTaskRecord, launch: JiraDevLaunch): Promise<{ git?: { repositoryUrl: string; targetBranch: string }; report?: boolean } | undefined>;
  automationDeliveryStatus?(taskId: string): JiraDevAutomationResult | undefined;
  readHubIssue?(key: string): Promise<JiraIssue>;
  workspaceCreator?: typeof createTaskWorkspace;
  jiraClient?: () => Promise<JiraDevClient>;
  sourceIdentity?: (source: string) => Promise<{ key: string; url: string }>;
}

export const pluginDataDirectory = path.join(os.homedir(), ...(process.platform === 'darwin'
  ? ['Library', 'Application Support', 'JiraDevWorkbench'] : ['.local', 'share', 'JiraDevWorkbench']));

export async function createJiraDevTaskService(options: Options) {
  const { dataDirectory, runtime } = options;
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const connection = createConnectionSettings({ dataDirectory: options.connectionDirectory || pluginDataDirectory });
  const client = options.jiraClient || (() => connection.client());
  // 与插件相同：每次调用取得当前连接，切换连接后新的调用使用新来源。
  const jira = new Proxy({}, { get: (_, method) => {
    if (typeof method !== 'string' || method === 'then') return undefined;
    if (method === 'sourceIdentity') return options.sourceIdentity || ((source: string) => connection.sourceIdentity(source));
    return async (...args: unknown[]) => {
      const value = (await client())[method];
      if (typeof value !== 'function') throw new Error(`Jira 连接不支持 ${method}`);
      return value(...args);
    };
  } }) as JiraDevClient;
  const tasks = createTaskRecords({ dataDirectory });
  const requirements = createRequirementStore({ jira, dataDirectory });
  const preferences = createProjectPreferences({ dataDirectory });
  const createWorkspace = options.workspaceCreator || createTaskWorkspace;
  const launchFile = path.join(dataDirectory, 'launches.json');
  const launches = new Map<string, JiraDevLaunch>(Object.entries(await fs.readFile(launchFile, 'utf8')
    .then(text => JSON.parse(text) as Record<string, JiraDevLaunch>)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {}; throw error; })));
  const preparationDirectory = path.join(dataDirectory, 'requirement-preparation');
  await fs.mkdir(preparationDirectory, { recursive: true, mode: 0o700 });
  const phaseAttempts = new Map<string, string>();
  for (const name of await fs.readdir(preparationDirectory)) {
    if (!/^[0-9a-f-]{36}-(review|design)\.ref$/.test(name)) continue;
    const attempt = (await fs.readFile(path.join(preparationDirectory, name), 'utf8')).trim();
    if (/^[0-9a-f-]{36}$/.test(attempt)) phaseAttempts.set(name.slice(0, -4), attempt);
  }
  const preparing = new Set<string>();
  const phaseSource = (key: string, attempt: string) => `preparation:${key}:${attempt}`;
  function phaseDocument(taskId: string, phase: JiraDevRequirementPhase): JiraDevRequirementDocument | undefined {
    const key = `${taskId}-${phase}`, attempt = phaseAttempts.get(key);
    if (!attempt) return;
    const run = runtime.findRequirementDevelopment(phaseSource(key, attempt));
    if (preparing.has(key) || run && (['queued', 'running'].includes(run.status) || run.resultReady === false && run.status === 'completed')) {
      return { status: 'running', summary: `正在生成${jiraDevRequirementLabels[phase]}…`, ...(run ? { runId: run.id } : {}) };
    }
    if (!run || run.status !== 'completed') return { status: 'failed', summary: run?.error || `${jiraDevRequirementLabels[phase]}未完成，可重新生成。`, ...(run ? { runId: run.id } : {}) };
    try {
      const report = readDeliveryReport(run.result) as { version?: unknown; requirementDocument?: unknown };
      if (report?.version !== 1) throw new Error('报告版本不正确。');
      return { ...jiraDevRequirementDocumentSchema.parse(report.requirementDocument), runId: run.id };
    } catch {
      return { status: 'failed', summary: '执行器未返回有效的需求文档，原始会话已保留。', runId: run.id };
    }
  }
  async function savePhaseDocument(taskId: string, phase: JiraDevRequirementPhase, document: JiraDevRequirementDocument) {
    if (!document.markdown || !document.runId) return;
    const file = path.join(preparationDirectory, `${taskId}-${phase}-${document.runId}.md`);
    const body = document.markdown + '\n';
    if (await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    }) === body) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function requireReadyPhase(taskId: string, phase: JiraDevRequirementPhase) {
    const document = phaseDocument(taskId, phase);
    if (document?.status !== 'ready') throw failure(`请先在预览中完成${jiraDevRequirementLabels[phase]}。`);
    await savePhaseDocument(taskId, phase, document);
    return document.markdown!;
  }
  const pending = new Set<string>();
  const groupSyncs = new Map<string, Promise<void>>();
  let writing = Promise.resolve();
  function saveLaunches() {
    const write = writing.then(async () => {
      const temporary = `${launchFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(launches)), { mode: 0o600 });
      await fs.rename(temporary, launchFile);
    });
    writing = write.catch(() => undefined);
    return write;
  }

  const findRun = (task: Pick<JiraDevTaskRecord, 'taskId' | 'workflow'>) => task.workflow === 'jira'
    ? runtime.findJiraFix(task.taskId) : runtime.findRequirementDevelopment(task.taskId);
  const teamRequestId = (taskId: string) => `jira-dev:${taskId}`;
  const projectSelections = (task: JiraDevTaskRecord): JiraDevProjectSelection[] => task.projects?.length ? task.projects : [
    { path: task.sourceProjectPath, baseBranch: task.baseBranch, branchName: task.branchName,
      ...(task.projectPath ? { workspacePath: task.projectPath, baseSha: task.baseSha } : {}) }];
  function reconcile(task: JiraDevTaskRecord): JiraDevTaskView['launch'] {
    const launch = launches.get(task.taskId);
    if (launch?.runtime.collaborationMode === 'group') {
      const group = options.findGroup?.(task.taskId);
      if (group) return { ...launch, ...group, status: 'started', runStatus: groupRunStatus(group.groupProgress) };
      if (launch.groupRoomId) return { ...launch, conversationMissing: true, status: 'uncertain', error: '关联群聊暂不可核对，请刷新后核对原群聊；不会重复创建任务或执行。' };
    }
    if (launch?.runtime.collaborationMode === 'automatic') {
      const team = options.findTeam?.(teamRequestId(task.taskId));
      if (team) return { ...launch, ...team, conversationMissing: !!team.runId && !!runtime.getRun && !runtime.getRun(team.runId), status: team.runId ? 'started' : 'uncertain',
        error: team.runId ? launch.status === 'started' ? launch.error : '' : '团队任务已创建，负责人会话尚待核对；不会重复创建团队。' };
    }
    const run = findRun(task) || (launch?.runId ? runtime.getRun?.(launch.runId) : undefined);
    if (!launch) return run ? { status: 'started', runtime: { provider: run.provider, model: run.model, reasoningEffort: '', accessMode: run.accessMode || 'workspace' },
      workspacePath: run.workspacePath, baseSha: task.baseSha || '', runId: run.id, error: '', startedAt: run.createdAt, runStatus: run.status } : undefined;
    if (run) return { ...launch, status: 'started', runId: run.id, runStatus: run.status, error: launch.status === 'started' ? launch.error : '' };
    if (launch.runId) return { ...launch, conversationMissing: true };
    if (['preparing', 'starting'].includes(launch.status) && !pending.has(task.taskId)) {
      return { ...launch, status: 'uncertain', error: '服务曾中断，请核对已创建的工作区与会话；不会自动重复创建或执行。' };
    }
    return { ...launch };
  }
  const planOf = (task: JiraDevTaskRecord) => (task.workflow === 'jira' ? task.repairPlan : task.requirementPlan) as JiraDevPlanView | undefined;
  function view(task: JiraDevTaskRecord): JiraDevTaskView {
    const launch = reconcile(task);
    const plan = planOf(task);
    const workspace = launch?.workspacePath && launch.baseSha ? { workspacePath: launch.workspacePath, baseSha: launch.baseSha }
      : task.projectPath && task.baseSha ? { workspacePath: task.projectPath, baseSha: task.baseSha } : undefined;
    const issue = task.sourceIssue;
    const warning = [issue?.materialStatus ? issue.materialWarning || '本次使用用户提供的材料，未实时刷新 Jira。' : '', plan?.warning].filter(Boolean).join('；');
    const preparation = task.workflow === 'requirement' ? { review: phaseDocument(task.taskId, 'review'), design: phaseDocument(task.taskId, 'design') } : undefined;
    const automationDelivery = options.automationDeliveryStatus?.(task.taskId);
    return { taskId: task.taskId, workflow: task.workflow, ...(preparation?.review || preparation?.design ? { preparation } : {}), ...buildJiraDevPrompt(task, workspace, launch?.runtime.collaborationMode), ...(warning ? { warning } : {}),
      ...(task.useI18n === undefined ? {} : { useI18n: task.useI18n }), projectPath: task.sourceProjectPath, baseBranch: task.baseBranch,
      branchName: task.branchName, ...(task.workflow === 'jira' ? { repairMode: task.repairPlan ? task.repairPlan.repairMode || 'create' : 'direct' } : {}),
      ...(task.projects?.length ? { projects: task.projects.map(item => ({ ...item })) } : {}),
      ...(plan ? { plan } : {}), ...(launch ? { launch } : {}), ...(automationDelivery ? { automationDelivery } : {}) };
  }
  async function requireTask(taskId: string) {
    const task = await tasks.get(taskId);
    if (!task) throw failure('任务记录不存在，请重新生成预览', 404);
    return task;
  }

  const preparationByIssue = new Map<string, Promise<JiraDevTaskView>>();
  const currentAutomationIssue = (issue: JiraDevIssue | undefined, expected: JiraIssue) =>
    !!issue && !issue.materialStatus && issue.key === expected.key && issue.url === expected.url
      && (!issue.issueType?.name || issue.issueType.name.trim().toLowerCase() === expected.issueType.trim().toLowerCase())
      && !/已完成|关闭|done|closed/i.test(`${issue.status || ''} ${issue.statusCategory || ''}`);
  function automationScope(issue: JiraDevIssue | undefined) {
    if (!issue) return;
    const { summary, description, assignee, assigneeId, startDate, endDate, dueDate, project, issueType,
      fixVersions, components, labels, parent, subtasks, links } = issue;
    return { summary, description, assignee, assigneeId, startDate, endDate, dueDate, project, issueType,
      fixVersions, components, labels, parent, subtasks, links };
  }
  async function prepare(raw: unknown, automation?: { issue: JiraIssue; repositoryUrl: string }) {
    const input = jiraDevPrepareSchema.parse(raw);
    const source = input.source.trim();
    if (input.workflow === 'jira' && !source) throw failure('请填写需要修复的 Jira Key 或链接。', 400);
    if (input.workflow === 'requirement' && input.sourceKind === 'frontend' && !source) throw failure('请填写要复用的 Jira 主任务或子任务编号。', 400);
    if (input.workflow === 'requirement' && !source && !input.details.trim()) throw failure('请填写需求 Jira 或需求正文。', 400);
    const identity = source ? await jira.sourceIdentity!(source) : undefined;
    const queueKey = identity?.url || identity?.key;
    if (!queueKey) return preparePreview(input, source, identity, automation);
    const previous = preparationByIssue.get(queueKey);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => preparePreview(input, source, identity, automation));
    preparationByIssue.set(queueKey, operation);
    try { return await operation; }
    finally { if (preparationByIssue.get(queueKey) === operation) preparationByIssue.delete(queueKey); }
  }
  async function preparePreview(input: ReturnType<typeof jiraDevPrepareSchema.parse>, source: string,
    identity: { key: string; url: string } | undefined, automation?: { issue: JiraIssue; repositoryUrl: string }) {
    const records = identity ? (await tasks.list()).reverse() : [];
    if (automation) {
      if (!identity?.url || identity.key !== automation.issue.key || identity.url !== automation.issue.url) throw failure('巡检事项与研发 Jira 连接不一致。');
      const matched = records.filter(task => [task.sourceIssue, task.issueSnapshot].some(issue => issue?.key === identity.key && issue.url === identity.url));
      const existing = matched.find(task => reconcile(task) || planOf(task)?.status === 'applied') || matched[0];
      if (existing) return view(existing);
    }
    const cachedIssue = records.find(task => task.issueSnapshot?.key === identity?.key && (!identity?.url || task.issueUrl === identity.url))?.issueSnapshot;
    const jiraIssue = source ? await readTaskIssue(jira, source, { details: input.details, cachedIssue }) : undefined;
    if (automation && !currentAutomationIssue(jiraIssue, automation.issue)) {
      throw failure('巡检事项已变化或 Jira 核对未完成。');
    }
    const taskId = randomUUID();
    const prepared = await prepareTask({ ...input, jira: jiraIssue, taskId });
    const repositories = new Map<string, string[]>();
    for (const project of prepared.projects || []) {
      const commonPath = (await exec('git', ['-C', project.path, 'rev-parse', '--git-common-dir'], { timeout: 5000 })).stdout.trim();
      const repositoryPath = await fs.realpath(path.resolve(project.path, commonPath));
      const branches = repositories.get(repositoryPath) || [];
      if (branches.some(branch => branch === project.branchName || branch.startsWith(`${project.branchName}/`) || project.branchName.startsWith(`${branch}/`))) {
        throw failure(`${project.path}：同一仓库的不同检出不能使用相同或相互冲突的工作分支，请为各项目填写不同且不冲突的分支。`, 400);
      }
      branches.push(project.branchName); repositories.set(repositoryPath, branches);
    }
    const repository = async () => (await groupRepositories([{ name: path.basename(prepared.projectPath), path: prepared.projectPath, markers: ['.git'] }])).projects[0]!;
    const repositoryInfo = automation ? await repository() : undefined;
    if (automation && repositoryIdentity(automation.repositoryUrl)?.repositoryId !== repositoryInfo?.repositoryId) {
      throw failure('本地目录的 Git 远端与匹配的项目不一致。');
    }
    let requirementPlan: JiraDevPlan | undefined, repairPlan: JiraDevPlan | undefined;
    if (input.workflow === 'requirement') {
      const { repositoryId, name } = repositoryInfo || await repository();
      const { designDestination } = await preferences.get({ projectPath: prepared.projectPath });
      requirementPlan = await requirements.prepare({ taskId, sourceIssue: jiraIssue, sourceKind: input.sourceKind, developmentKey: input.developmentKey, details: input.details,
        businessModule: input.businessModule, schedules: input.schedules, repositoryId, repositoryName: name,
        repositoryNames: (prepared.projects || [{ path: prepared.projectPath }]).map(project => path.basename(project.path)), designDestination });
    }
    if (input.workflow === 'jira' && (input.repairMode === 'create' || input.repairMode === 'reuse')) {
      const { repositoryId, name } = await repository();
      repairPlan = await requirements.prepare({ ...input, taskId, sourceIssue: jiraIssue, sourceKind: 'defect',
        schedules: { implementation: { startDate: input.repairStartDate, endDate: input.repairEndDate } }, repositoryId, repositoryName: name });
    }
    const record = await tasks.create({ taskId, workflow: input.workflow, key: jiraIssue?.key || '', issueUrl: jiraIssue?.url || '', issueSnapshot: jiraIssue,
      sourceIssue: jiraIssue, source: input.source, details: input.details, designSource: input.designSource,
      ...(input.useI18n === undefined ? {} : { useI18n: input.useI18n }), sourceProjectPath: prepared.projectPath, branchName: prepared.branchName,
      baseBranch: prepared.baseBranch, projectPath: '', ...(automation ? { automationPreview: true } : {}), ...(repairPlan ? { repairPlan } : {}),
      ...(prepared.projects?.length ? { projects: prepared.projects } : {}),
      ...(requirementPlan ? { requirementPlan, technicalDesign: { status: 'pending' } } : {}) });
    return view(record);
  }
  async function prepareAutomationPreviews(plan: PlanItem[], limit: number, mode: 'preview' | 'start' = 'preview',
    mayStart?: () => Promise<boolean>): Promise<JiraDevScanPreview[]> {
    const previews: JiraDevScanPreview[] = [];
    // 预览模式限制本轮新建预览，启动模式限制通过核对后实际尝试启动的事项。
    const existing = new Set((await tasks.list()).flatMap(task => [task.sourceIssue?.url, task.issueSnapshot?.url].filter(Boolean)));
    let prepared = 0, attempted = 0;
    for (const { issue, projectRouting } of plan) {
      const profile = projectRouting?.status === 'matched' ? projectRouting.profile : undefined;
      if (!profile) continue;
      const workflow = /缺陷|故障|bug|defect/i.test(issue.issueType) ? 'jira' : 'requirement';
      const row = { issueKey: issue.key, summary: issue.summary, workflow } as const;
      if (!profile.localPath) {
        previews.push({ ...row, ...(mode === 'start' ? { launchStatus: 'blocked' as const } : {}), error: '请在项目匹配中配置本地目录。' });
        continue;
      }
      if (!existing.has(issue.url)) {
        if (limit && (mode === 'preview' ? prepared : attempted) >= limit) continue;
        if (mode === 'preview') prepared++;
      }
      let result: JiraDevScanPreview = row;
      try {
        const task = await prepare({ workflow, source: issue.url, projectPath: profile.localPath,
          baseBranch: profile.targetBranch, branchName: `feature/${issue.key}`, sourceKind: 'frontend', repairMode: 'direct' },
        { issue, repositoryUrl: profile.repositoryUrl });
        result = { ...row, workflow: task.workflow, taskId: task.taskId, projectPath: task.projectPath };
        if (mode === 'start') {
          if (task.launch) {
            result = task.launch.status === 'started' && task.launch.runId && !task.launch.conversationMissing
              ? { ...result, launchStatus: 'existing', runId: task.launch.runId }
              : { ...result, launchStatus: 'blocked', error: '已有启动记录，请在研发页面核对。' };
          } else {
            const record = await requireTask(task.taskId);
            if (!record.automationPreview || task.workflow !== workflow
              || (task.repairMode && task.repairMode !== 'direct') || task.plan?.designPublicationAuthorized) {
              result = { ...result, launchStatus: 'awaiting_confirmation', error: '已有待确认的研发任务，请在对应页面核对后开始。' };
            } else if (!limit || attempted < limit) {
              result = { ...result, ...await startAutomationPreview(record, issue, profile, () => { attempted++; }, mayStart) };
            }
          }
        }
      } catch {
        result = { ...result, ...(mode === 'start' ? { launchStatus: 'blocked' as const } : {}),
          error: 'Jira 或本地仓库核对失败，请在对应页面检查研发任务。' };
      }
      previews.push(result);
    }
    return previews;
  }
  async function startAutomationPreview(record: JiraDevTaskRecord, issue: JiraIssue,
    profile: { localPath: string; repositoryUrl: string; targetBranch: string },
    recordAttempt: () => void, mayStart?: () => Promise<boolean>): Promise<Pick<JiraDevScanPreview, 'launchStatus' | 'runId' | 'error'>> {
    const repository = repositoryIdentity(profile.repositoryUrl);
    const actualRemote = repositoryIdentity(await originUrl(record.sourceProjectPath));
    if (!repository || repository.repositoryId !== actualRemote?.repositoryId
      || record.sourceProjectPath !== await fs.realpath(profile.localPath)
      || record.baseBranch !== profile.targetBranch.replace(/^origin\//, '') || record.branchName !== `feature/${issue.key}`) {
      return { launchStatus: 'awaiting_confirmation', error: '项目目录、Git 远端或分支已变化，请核对后开始。' };
    }
    const fresh = await jira.readIssue(issue.url);
    if (!currentAutomationIssue(fresh, issue)) {
      return { launchStatus: 'blocked', error: '巡检事项已变化或 Jira 核对未完成。' };
    }
    if (!isDeepStrictEqual(automationScope(fresh), automationScope(record.sourceIssue))) {
      return { launchStatus: 'awaiting_confirmation', error: 'Jira 内容或任务范围已更新，请重新生成预览并核对后开始。' };
    }
    if (record.workflow === 'requirement') {
      try {
        await savePlan(record, await requirements.bindExistingForAutomation({ taskId: record.taskId, issueKey: issue.key, issueUrl: issue.url }));
      } catch {
        return { launchStatus: 'awaiting_confirmation', error: '需求计划需要人工核对，请打开巡检预览后确认。' };
      }
    }
    recordAttempt();
    const started = await start({ taskId: record.taskId, confirmed: true,
      runtime: { provider: 'codex', model: '', reasoningEffort: '', accessMode: 'workspace', collaborationMode: 'manual' } }, mayStart);
    if (started.launch?.status === 'started' && started.launch.runId && !started.launch.conversationMissing) {
      return { launchStatus: 'started', runId: started.launch.runId };
    }
    return { launchStatus: 'blocked', error: 'Codex 会话尚未启动，请在研发页面核对启动记录。' };
  }
  async function savePlan(task: JiraDevTaskRecord, plan: JiraDevPlan) {
    return view(task.workflow === 'jira' ? await tasks.repair(task.taskId, plan) : await tasks.requirement(task.taskId, plan));
  }
  async function apply(raw: unknown) {
    const { taskId, group } = jiraDevApplySchema.parse(raw);
    const task = await requireTask(taskId);
    if (!planOf(task)) throw failure('该任务无需创建或关联 Jira。');
    if (launches.get(taskId)?.runId || launches.get(taskId)?.teamTaskId || launches.get(taskId)?.groupRoomId) throw failure('任务已启动会话，不再修改 Jira 计划。');
    if (task.workflow === 'requirement' && (group || phaseAttempts.has(`${taskId}-review`))) await requireReadyPhase(taskId, 'review');
    return savePlan(task, await requirements.apply({ taskId, confirmed: true }));
  }
  async function prepareRequirementDocument(raw: unknown) {
    const { taskId, phase, runtime: selection } = jiraDevRequirementPhaseStartSchema.parse(raw);
    const task = await requireTask(taskId);
    if (task.workflow !== 'requirement' || selection.collaborationMode !== 'group' || !options.requirementReader) throw failure('此操作仅用于需求开发团队群聊。');
    if (pending.has(taskId) || launches.has(taskId)) throw failure('任务已进入启动流程，不能重新生成前置文档。');
    const key = `${taskId}-${phase}`;
    if (['running', 'ready'].includes(phaseDocument(taskId, phase)?.status || '') || preparing.has(key)) return view(task);
    preparing.add(key);
    try {
      let review = '';
      if (phase === 'design') {
        review = await requireReadyPhase(taskId, 'review');
        const preview = view(task);
        const blocker = jiraDevStartBlocker(preview);
        if (blocker || jiraDevNeedsApply(preview)) throw failure(blocker || '请先确认 Jira 任务和排期。');
      }
      const binding = await options.requirementReader(selection.groupConfigRevision);
      const attempt = randomUUID(), file = path.join(preparationDirectory, `${key}.ref`);
      const temporary = `${file}.${attempt}.tmp`;
      try {
        await fs.writeFile(temporary, attempt, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      phaseAttempts.set(key, attempt);
      await runtime.startRequirementDevelopment({ ...binding, mode: 'ask', accessMode: 'workspace', workspacePath: task.sourceProjectPath,
        objective: buildRequirementPreparationPrompt(task, phase, review) }, phaseSource(key, attempt), `${jiraDevRequirementLabels[phase]} · ${jiraDevTaskTitle(task)}`, binding.catalogAlias);
    } finally { preparing.delete(key); }
    return view(task);
  }
  async function requirementDocument(taskId: string, phase: JiraDevRequirementPhase) {
    const task = await requireTask(taskId);
    const document = task.workflow === 'requirement' ? phaseDocument(taskId, phase) : undefined;
    if (!document?.markdown) throw failure('前置文档尚未生成。', 404);
    await savePhaseDocument(taskId, phase, document);
    return document.markdown + '\n';
  }
  async function check(raw: unknown, refreshCandidates = true) {
    const { taskId, developmentKey } = jiraDevCheckSchema.parse(raw);
    const task = await requireTask(taskId);
    const plan = planOf(task);
    const refreshFrontend = refreshCandidates && task.workflow === 'requirement' && plan?.sourceKind === 'frontend' && plan.status === 'local' && !task.projectPath && !reconcile(task);
    if (developmentKey) {
      if (!refreshFrontend) throw failure('当前任务预览不能选择关联 Jira 开发主任务。');
      return savePlan(task, await requirements.get({ taskId, refreshFrontend, developmentKey }));
    }
    await synchronizeGroup(task);
    if (task.workflow === 'requirement') for (const phase of ['review', 'design'] as const) {
      const document = phaseDocument(taskId, phase);
      if (document?.markdown) await savePhaseDocument(taskId, phase, document);
    }
    if (!plan) return view(task);
    return savePlan(task, await requirements.get({ taskId, refreshFrontend }));
  }

  async function originUrl(projectPath: string) {
    try { return (await exec('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 5000 })).stdout.trim(); }
    catch { return ''; }
  }
  function hubIssue(issue: JiraDevIssue): JiraIssue {
    return { key: issue.key, url: issue.url, summary: issue.summary, description: typeof issue.description === 'string' ? issue.description : JSON.stringify(issue.description ?? ''),
      status: issue.status || '', statusCategory: '', issueType: issue.issueType?.name || '', priority: '', project: issue.project?.key || issue.key.split('-')[0]!,
      projectName: issue.project?.name || '', assignee: issue.assignee || '', fixVersions: issue.fixVersions?.map(item => item.name) || [], created: '', updated: '',
      dueDate: null, startDate: issue.startDate || null, endDate: issue.endDate || null, resolutionDate: null, parent: null, subtasks: [] };
  }
  /** 登记失败不影响已启动的会话，只提示在工作台核对；会话仍可通过 sourceId 找到。 */
  async function adopt(task: JiraDevTaskRecord, launch: JiraDevLaunch) {
    const issue = jiraDevBoundIssue(task);
    const common = { workspacePath: launch.workspacePath, headSha: launch.baseSha, runId: launch.runId, error: '', createdAt: launch.startedAt, status: 'started' as const,
      ...(launch.groupRoomId ? { groupRoomId: launch.groupRoomId, groupProgress: launch.groupProgress } : {}) };
    const repository = await originUrl(task.sourceProjectPath);
    if (task.workflow === 'jira') {
      let snapshot = issue ? hubIssue(issue) : undefined;
      if (issue && options.readHubIssue) snapshot = await options.readHubIssue(issue.key).catch(() => snapshot);
      await options.adoptJiraFix({ id: task.taskId, ...common, ...(snapshot ? { issue: snapshot } : {}),
        input: { issueKey: issue?.key || task.key, repository, parentDirectory: path.dirname(launch.workspacePath), baseBranch: task.baseBranch,
          branch: task.branchName, notes: task.details, rememberProject: false } });
      return;
    }
    const plan = task.requirementPlan;
    const schedule = plan?.items.find(item => item.role === 'implementation')?.schedule;
    const destination = plan?.designPublicationAuthorized ? plan.designDestination : undefined;
    await options.adoptRequirement({ id: task.taskId, ...common,
      input: { title: jiraDevTaskTitle(task).replace(/^需求开发 · /, ''), issueKey: issue?.key || task.sourceIssue?.key || '', prdUrl: '', requirement: task.details,
        project: issue?.project?.key || task.sourceIssue?.project?.key || '', fixVersion: '', assignee: '', startDate: schedule?.startDate || '', endDate: schedule?.endDate || '',
        repository, parentDirectory: path.dirname(launch.workspacePath), branch: task.branchName, confluenceParentUrl: destination?.url || '' } });
  }
  async function adoptLaunch(task: JiraDevTaskRecord, launch: JiraDevLaunch) {
    await adopt(task, launch);
    if (options.onLaunch && (launch.runId || launch.groupRoomId)) {
      const snapshot = structuredClone(launch);
      void Promise.resolve().then(() => options.onLaunch?.(task, snapshot)).catch(() => undefined);
    }
  }
  function synchronizeGroup(task: JiraDevTaskRecord): Promise<void> {
    if (pending.has(task.taskId)) return Promise.resolve();
    const existing = groupSyncs.get(task.taskId); if (existing) return existing;
    const work = (async () => {
      const saved = launches.get(task.taskId), current = reconcile(task);
      if (!saved || !current?.groupRoomId || current.status !== 'started' || saved.adoptedRunId === current.runId) return;
      Object.assign(saved, current);
      try { await adoptLaunch(task, saved); saved.adoptedRunId = current.runId; saved.error = ''; }
      catch (error) { saved.error = `群聊已创建，但任务记录或交接同步失败：${error instanceof Error ? error.message : String(error)}`; }
      await saveLaunches();
    })().finally(() => { groupSyncs.delete(task.taskId); });
    groupSyncs.set(task.taskId, work); return work;
  }
  async function start(raw: unknown, mayStart?: () => Promise<boolean>) {
    const { taskId, runtime: selection } = jiraDevStartSchema.parse(raw);
    if (mayStart && !await mayStart()) throw failure('自动研发策略已变更，请在下次巡检重新核对。');
    if (pending.has(taskId)) throw failure('该任务正在准备工作区或启动会话，请稍候。');
    let task = await requireTask(taskId);
    const current = reconcile(task);
    if (current && current.status !== 'failed') {
      if (current.status === 'uncertain') throw failure(current.error);
      if (current.groupRoomId) await synchronizeGroup(task);
      else if (current.teamTaskId && current.runId) {
        launches.set(taskId, current); await saveLaunches();
        try { await adoptLaunch(task, current); }
        catch (error) { current.error = `会话已启动，但未登记任务记录：${error instanceof Error ? error.message : String(error)}`; await saveLaunches(); }
      }
      return view(task);
    }
    const preview = view(task);
    const blocker = jiraDevStartBlocker(preview);
    if (blocker) throw failure(blocker);
    if (jiraDevNeedsApply(preview)) throw failure('请先确认任务计划中的 Jira 创建或关联，再启动会话。');
    if (projectSelections(task).length > 1 && selection.accessMode !== 'full') throw failure('多项目任务需要完全访问权限，请选择完全访问后开始。');
    if (selection.collaborationMode === 'automatic' && !options.startTeam) throw failure('自动协作服务尚未就绪，请稍后重新读取。');
    if (selection.collaborationMode === 'group') {
      if (!options.startGroup || !options.preflightGroup) throw failure('团队群聊服务尚未就绪，请稍后重新读取。');
      await options.preflightGroup(selection.groupConfigRevision, task.sourceProjectPath, selection.accessMode, projectSelections(task).map(project => project.path));
    }
    const preparation = task.workflow === 'requirement' && selection.collaborationMode === 'group' ? {
      review: await requireReadyPhase(taskId, 'review'), design: await requireReadyPhase(taskId, 'design'),
    } : undefined;
    const projects = projectSelections(task).map(item => {
      const saved = current?.projects?.find(previous => previous.path === item.path);
      return { ...saved, ...item, workspacePath: item.workspacePath || saved?.workspacePath, baseSha: item.baseSha || saved?.baseSha };
    });
    const launch: JiraDevLaunch = { status: 'preparing', runtime: selection, workspacePath: current?.workspacePath || task.projectPath || '',
      baseSha: current?.baseSha || task.baseSha || '', runId: '', error: '', startedAt: new Date().toISOString(), projects };
    if (pending.has(taskId)) throw failure('该任务正在准备工作区或启动群聊，请稍候。');
    pending.add(taskId);
    try {
      launches.set(taskId, launch); await saveLaunches();
      for (const [index, project] of projects.entries()) {
        // 每个已建工作区在登记任务前先保存，后续项目失败时重试复用全部已建结果。
        const existingPath = project.workspacePath || (index === 0 ? launch.workspacePath : '');
        const existingSha = project.baseSha || (index === 0 ? launch.baseSha : '');
        let workspace: JiraDevWorkspace;
        if (existingPath && existingSha) {
          workspace = await inspectTaskWorkspace({ projectPath: existingPath, sourceProjectPath: project.path, branchName: project.branchName, baseSha: existingSha });
        } else {
          const issue = jiraDevBoundIssue(task);
          workspace = await createWorkspace({ projectPath: project.path, baseBranch: project.baseBranch, branchName: project.branchName, taskName: issue?.key || task.taskId.slice(0, 8) });
        }
        Object.assign(project, { workspacePath: workspace.workspacePath, baseSha: workspace.baseSha });
        if (index === 0) Object.assign(launch, { workspacePath: workspace.workspacePath, baseSha: workspace.baseSha });
        await saveLaunches();
        task = await tasks.workspace(taskId, workspace, index);
      }
      Object.assign(launch, { status: 'starting', workspacePath: task.projectPath, baseSha: task.baseSha }); await saveLaunches();
      const delivery = await options.prepareAutomationDelivery?.(task, structuredClone(launch));
      if (mayStart && !await mayStart()) throw failure('自动研发策略已变更，尚未启动会话。');
      const { title, prompt } = buildJiraDevPrompt(task, { workspacePath: task.projectPath, baseSha: task.baseSha! }, selection.collaborationMode, preparation, delivery);
      if (selection.collaborationMode === 'group') {
        const issue = jiraDevBoundIssue(task) || task.sourceIssue;
        const source: GroupJiraSource = { taskId, workflow: task.workflow, title, issueKey: issue?.key || '', issueUrl: issue?.url || '',
          ...(preparation ? { requirementPreparation: true,
            requirementTasks: task.requirementPlan?.status === 'applied' ? task.requirementPlan.items.filter(item => item.key).slice(0, 100).map(item => ({
              role: item.role, key: item.key!, url: item.url || '', summary: item.summary.slice(0, 500),
              startDate: item.schedule?.startDate || '', endDate: item.schedule?.endDate || '',
            })) : [] } : {}),
          projects: projects.map(project => ({ ...project, workspacePath: project.workspacePath!, baseSha: project.baseSha! })) };
        const group = await options.startGroup!({ source, objective: prompt, workspacePath: task.projectPath, accessMode: selection.accessMode,
          requestId: teamRequestId(taskId), expectedConfigRevision: selection.groupConfigRevision! });
        Object.assign(launch, group, { status: 'started' });
      } else if (selection.collaborationMode === 'automatic') {
        const team = await options.startTeam!({ objective: prompt, workspacePath: task.projectPath, accessMode: selection.accessMode, requestId: teamRequestId(taskId) });
        Object.assign(launch, team, { status: team.runId ? 'started' : 'uncertain',
          error: team.runId ? '' : '团队任务已创建，负责人会话尚待核对；不会重复创建团队。' });
      } else {
        const input: StartAgentRunInput = { provider: selection.provider, mode: 'agent', accessMode: selection.accessMode, model: selection.model,
          reasoningEffort: selection.reasoningEffort, workspacePath: task.projectPath, branch: task.branchName, objective: prompt };
        const run = await (task.workflow === 'jira' ? runtime.startJiraFix(input, taskId, title) : runtime.startRequirementDevelopment(input, taskId, title));
        Object.assign(launch, { status: 'started', runId: run.id });
      }
      await saveLaunches();
      if (!launch.runId && !launch.groupRoomId) return view(task);
      try { await adoptLaunch(task, launch); if (launch.groupRoomId) { launch.adoptedRunId = launch.runId; await saveLaunches(); } }
      catch (error) { launch.error = `会话已启动，但未登记到${task.workflow === 'jira' ? 'Jira 修复' : '需求开发'}记录：${error instanceof Error ? error.message : String(error)}`; await saveLaunches(); }
    } catch (error) {
      const group = selection.collaborationMode === 'group' ? options.findGroup?.(taskId) : undefined;
      const team = selection.collaborationMode === 'automatic' ? options.findTeam?.(teamRequestId(taskId)) : undefined;
      const run = !['automatic', 'group'].includes(selection.collaborationMode || '') ? findRun(task) : undefined;
      if (group) Object.assign(launch, group, { status: 'started' });
      else if (team) Object.assign(launch, team, { status: team.runId ? 'started' : 'uncertain',
        error: team.runId ? '' : '团队任务已创建，负责人会话尚待核对；不会重复创建团队。' });
      else if (run) Object.assign(launch, { status: 'started', runId: run.id });
      else {
        const detail = error instanceof Error ? error.message : String(error);
        Object.assign(launch, { status: 'failed', error: launch.workspacePath ? `${detail}；工作区已保留：${launch.workspacePath}，重试会复用该工作区。` : detail });
      }
      await saveLaunches().catch(() => undefined);
      if (launch.runId || launch.groupRoomId) {
        try { await adoptLaunch(task, launch); if (launch.groupRoomId) { launch.adoptedRunId = launch.runId; await saveLaunches(); } }
        catch (adoptError) { launch.error = `会话已启动，但未登记任务记录：${adoptError instanceof Error ? adoptError.message : String(adoptError)}`; await saveLaunches().catch(() => undefined); }
      }
    } finally { pending.delete(taskId); }
    await synchronizeGroup(task);
    return view(task);
  }
  async function list() {
    const records = (await tasks.list()).filter(task => launches.has(task.taskId) || findRun(task));
    for (const task of records) await synchronizeGroup(task);
    return records.map(view).sort((a, b) => (b.launch?.startedAt || '').localeCompare(a.launch?.startedAt || ''));
  }

  return {
    prepare, prepareAutomationPreviews, apply, check, start, list, prepareRequirementDocument, requirementDocument,
    deliveryTask: requireTask,
    async deliveryJiraTasks(task: JiraDevTaskRecord) {
      const plan = task.requirementPlan;
      const issue = plan?.sourceIssue || task.sourceIssue;
      if (task.workflow !== 'requirement' || plan?.sourceKind !== 'frontend' || plan.reuseRuleVersion || !issue?.key || !issue.url) return;
      return requirements.lookupFrontend(issue);
    },
    async saveDeliveryDesign(taskId: string, input: { body: string; publication: unknown }) {
      const task = await requireTask(taskId);
      const plan = task.requirementPlan;
      if (!plan?.designDestination || task.workflow !== 'requirement') throw failure('该任务未绑定技术方案归档目录。');
      if (!plan.designPublicationAuthorized) await tasks.requirement(taskId, { ...plan, designPublicationAuthorized: true });
      return tasks.technicalDesign(taskId, { body: input.body,
        evidence: typeof task.technicalDesign?.evidence === 'string' ? task.technicalDesign.evidence : '用户在本任务群聊核对本地方案预览并确认发布；已回读核验远端正文、目录与版本。',
        ...(task.technicalDesign?.source ? { source: task.technicalDesign.source } : {}), publication: input.publication });
    },
    async publishDeliveryComment(taskId: string, body: string) {
      const task = await requireTask(taskId), issue = jiraDevBoundIssue(task) || task.sourceIssue;
      if (!issue?.url || !issue.key) throw Object.assign(failure('任务未绑定可核对的 Jira 来源。'), { definite: true });
      let current: JiraDevIssue;
      try { current = await jira.readIssue(issue.url); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error('Jira 来源无法读取。'), { definite: true }); }
      if (current.key !== issue.key || current.url !== issue.url) throw Object.assign(failure('当前 Jira 连接与任务来源不一致，请检查连接后重新预览。'), { definite: true });
      try { return await (jira.publishComment as (source: string, body: string) => Promise<{ url: string; verified: boolean }>)(issue.url, body); }
      catch (error) {
        const failure = error as { uncertain?: boolean; code?: string };
        if (failure.uncertain === false || ['JIRA_CONFIG', 'JIRA_AUTH', 'JIRA_SOURCE', 'JIRA_COMMENT', 'JIRA_SITE_MISMATCH'].includes(failure.code || '')) {
          throw Object.assign(error instanceof Error ? error : new Error('Jira 评论未写入。'), { definite: true });
        }
        throw error;
      }
    },
    synchronizeGroup: async (taskId: string) => synchronizeGroup(await requireTask(taskId)),
    task: (raw: unknown) => check(jiraDevTaskSchema.parse(raw), false),
    connection: () => connection.read(),
    readIssue: async (raw: unknown): Promise<JiraDevIssueReadResult> => {
      const { source, includeDevelopmentCandidates } = jiraDevSourceSchema.parse(raw);
      const issue = await jira.readIssue(source);
      const result = { issue, connection: await jira.connection().catch(() => undefined) };
      if (!includeDevelopmentCandidates) return result;
      try { return { ...result, developmentCandidates: await requirements.lookupFrontendCandidates(issue) }; }
      catch (error) { return { ...result, developmentCandidateError: error instanceof Error ? error.message : String(error) }; }
    },
    versions: async (raw: unknown) => {
      const { source, projectKey } = jiraDevVersionSchema.parse(raw);
      const context = await jira.readRequirementContext(source, { projectKey });
      const values = context.issueTypes.flatMap(type => type.fields?.fixVersions?.allowedValues || []);
      const versions = [...new Map(values.filter(item => item.id != null && typeof item.name === 'string')
        .map(item => [String(item.id), { id: String(item.id), name: item.name as string }])).values()];
      return { projectKey: context.project?.key || context.issue.project?.key || '', versions: versions.slice(0, 500), truncated: versions.length > 500 };
    },
    scan: (raw: unknown) => scanProjects(jiraDevScanSchema.parse(raw)),
    projectStatus: (raw: unknown) => readProjectStatus(jiraDevProjectSchema.parse(raw)),
    preferences: async (raw: unknown) => {
      const input = jiraDevProjectSchema.parse(raw);
      return { ...(await preferences.get(input)), ...(await readBranchOptions(input)) };
    },
    savePreferences: (raw: unknown) => preferences.set(jiraDevPreferenceSaveSchema.parse(raw)),
    isIdle: () => !pending.size && !groupSyncs.size && !preparing.size,
    close: async () => { await Promise.allSettled([...groupSyncs.values()]); await writing; },
  };
}

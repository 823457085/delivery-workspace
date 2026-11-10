import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createJiraIssueService, createJiraIssueRoute } from './jira-issue.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createService } from './service.js';
import { proxySource } from './source-proxy.js';
import { createSourceBackend } from './source-backend.js';
import { createDesignExecutor } from './design-executor/service.js';
import { createCliQueue } from './cli-queue.js';
import { createAgentTeamService } from './agent-team-service.js';
import { createAgentGroupChat } from './agent-group-chat.js';
import { createAgentGroupChatRoutes } from './agent-group-chat-routes.js';
import { createAgentRemoteDelivery } from './agent-remote-delivery.js';
import { createAgentRemoteDeliveryConfluence } from './agent-remote-delivery-confluence.js';
import { createAgentUsageStore } from './agent-usage.js';
import { createAgentTeamGovernance } from './agent-team-governance.js';
import { createAgentTeamRoutes } from './agent-team-routes.js';
import { createAgentRuntimeService } from './agent-runtime.js';
import { createCursorAccountsService } from './cursor-accounts.js';
import { createCursorAccountsRoute } from './cursor-accounts-route.js';
import { createDesktopAccountsService, createDesktopAccountsRoute, DesktopAccountError } from './desktop-accounts.js';
import { accountProviders, type AccountProvider } from '../shared/cursor-accounts.js';
import { agentAccessSchema, agentAttachmentIdsSchema, agentReasoningSchema, agentServiceTierSchema, agentStartSchema, agentCustomModelSchema } from './agent-runtime-input.js';
import { createAgentRuntimeStream } from './agent-runtime-stream.js';
import { createAgentAttachmentStore } from './agent-attachments.js';
import { isAgentImageAttachment, maxAgentAttachmentBytes } from '../shared/agent-runtime.js';
import { listCodexSkills } from './codex-skills.js';
import { createWorkspacePickerRoute } from './workspace-picker.js';
import { createWorkspaceAppRoute, createWorkspaceTerminalRoute, openWorkspaceCursor } from './workspace-terminal.js';
import { createIntegrationStore } from './api-integration.js';
import { loadIntegrationCatalog } from './integration-catalog.js';
import { createApexBffReviewStore } from './apex-bff-review.js';
import { createWecomIntegration } from './wecom-integration.js';
import { createWorkspaceTodos } from './workspace-todos.js';
import { createOverseasRequirements, createOverseasRequirementRoutes } from './overseas-requirements.js';
import { createWorkspaceTodoRoutes } from './workspace-todo-routes.js';
import { createProjectWorkspaces } from './project-workspaces.js';
import { createProjectWorkspaceRoutes } from './project-workspace-routes.js';
import { createProjectLaunch, createProjectLaunchRoutes } from './project-launch.js';
import { createWorkspaceUsageCheck } from './project-workspace-usage.js';
import { createWorkspaceReports } from './workspace-reports.js';
import { createWorkspaceReportRoutes } from './workspace-report-routes.js';
import { readWorkspaceReportSnapshot } from './workspace-report-source.js';
import { createClaudeUsageReader } from './claude-usage.js';
import { createCodexPlanUsageReader, createCodexUsageReader } from './codex-usage.js';
import { createCursorUsageReader } from './cursor-usage.js';
import { createAntigravityUsageReader } from './antigravity-usage.js';
import { createAgentNoteStore } from './agent-notes.js';
import { createConfluenceKnowledge } from './confluence-knowledge.js';
import { createSystemCatalog, createSystemCatalogRoutes } from './system-catalog.js';
import { createInterfaceCenter, createInterfaceCenterRoutes } from './interface-center.js';
import { createRefactorControl } from './refactor-control.js';
import { createRequirementDevelopmentService } from './requirement-development.js';
import { createJiraFixService } from './jira-fix.js';
import { createJiraFixHandoffService } from './jira-fix-handoff.js';
import { createJiraDevTaskService } from './jira-dev-tasks.js';
import { createJiraDevAutomation } from './jira-dev-automation.js';
import { advanceJiraDevStatus } from './jira-dev-automation-status.js';
import { deliverJiraDevMergeRequest } from './jira-dev-automation-mr.js';
import { createConnectionSettings } from './jira-dev/index.mjs';
import { createJiraDevSync } from './jira-dev-sync.js';
import { createJiraHandoffClient } from './jira-handoff-client.js';
import { jiraReferenceSchema } from '../shared/jira-fix.js';
import { acquireStateServiceLease, createStateBackupStore, startPeriodicStateBackup } from './state-backup.js';
import { createDeliveryAcceptanceStore } from './delivery-acceptance.js';
import { createDeliveryAcceptanceSourceResolver } from './delivery-acceptance-source.js';
import type { JiraDevScanPreview, MergeData } from '../shared/hub.js';
import { createWorkspaceVersionReader, workspaceStaticCacheControl } from './workspace-version.js';
import { ensureWorkspaceBuild } from './workspace-build.js';
import { createWorkspaceRestart, createWorkspaceRestartRoute, isPm2ManagedWorkspace, restartTaskActive as activeStatus } from './workspace-restart.js';
import { createJenkinsDeployments } from './jenkins-deployments.js';
import { createJenkinsDeploymentsRoute } from './jenkins-deployments-route.js';
import { createYunxiaoDeployments } from './yunxiao-deployments.js';
import { createAgentTranslateService } from './agent-translate.js';
import { executePortAction, parsePortList, scanListeningPorts, type PortActionRequest } from './port-monitor.js';
import { createRefactorWorkspace } from './refactor-workspace.js';
import {
  readProjectGitSnapshot,
  readProjectTree,
  readProjectCode,
  saveProjectCode,
  readProjectDiff,
  executeProjectGitAction,
  readShareConfig,
  updateShareConfig,
} from './project-git.js';
import { listProjectMergeRequests, prepareProjectMergeRequest, createProjectMergeRequest, updateProjectMergeRequestTitle } from './project-merge-request.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.resolve(process.env.DELIVERY_DIST_DIR || path.join(root, 'dist'));
const readVersion = await createWorkspaceVersionReader(root, distDirectory);
let startupBuildError: string | undefined;
const readWorkspaceVersion = async () => {
  const version = await readVersion();
  // 页面已由后续构建更新时，清除启动阶段遗留的构建失败提示。
  if (version.frontend && version.frontend.buildSourceHash === version.diskBuildSourceHash) startupBuildError = undefined;
  return { ...version, ...(startupBuildError ? { buildError: startupBuildError } : {}) };
};
const port = Number(process.env.PORT ?? 5199);
const dataDirectory = process.env.DELIVERY_DATA_DIR ?? path.join(root, '.data');
const workspaceBuildOptions = { logFile: path.join(dataDirectory, 'workspace-build.log') };
const releaseStateLease = await acquireStateServiceLease(dataDirectory);
if (!process.argv.includes('--dev')) {
  try {
    const result = await ensureWorkspaceBuild(root, distDirectory, workspaceBuildOptions);
    console.log(result.rebuilt ? '页面自动构建完成' : '页面构建已是最新');
  } catch (error) {
    startupBuildError = error instanceof Error ? error.message : '页面自动构建失败，请重试重启。';
    console.error(startupBuildError);
  }
}
const stateBackup = await createStateBackupStore(dataDirectory);
const initialBackup = await stateBackup.snapshot();
for (const entry of initialBackup.entries.filter(entry => entry.status === 'failed')) console.error(`关键状态备份失败：${entry.path}：${entry.error}`);
const stopStateBackup = startPeriodicStateBackup(stateBackup);
const sourceBackend = await createSourceBackend(port);
const jiraIssueRoute = createJiraIssueRoute(createJiraIssueService(sourceBackend.jiraIssueRequest));
const service = await createService(dataDirectory, {
  model: process.env.DELIVERY_MODEL || undefined,
  readSource: () => sourceBackend.readMergePlan(false),
});
const designExecutor = await createDesignExecutor(path.join(dataDirectory, 'design-executor'));
const cliQueue = await createCliQueue(dataDirectory);
const agentAttachments = await createAgentAttachmentStore(path.join(dataDirectory, 'agent-runtimes', 'attachments'));
const agentNotes = await createAgentNoteStore(path.join(dataDirectory, 'agent-notes'));
const confluenceKnowledge = await createConfluenceKnowledge(path.join(dataDirectory, 'confluence-knowledge'), sourceBackend.confluenceReadRequest);
const systemCatalog = await createSystemCatalog(path.join(dataDirectory, 'system-catalog'), sourceBackend.confluenceReadRequest, undefined, sourceBackend.readLocalProjects);
const systemCatalogRoutes = createSystemCatalogRoutes(systemCatalog, { json, body, port });
const interfaceCenter = await createInterfaceCenter(path.join(dataDirectory, 'interface-center'));
const interfaceCenterRoutes = createInterfaceCenterRoutes(interfaceCenter, { json, body, port });
const agentTranslate = createAgentTranslateService();
// 团队流程派发前读取 Claude 额度，用尽时改用 Codex；需在运行时服务创建（及其启动恢复）之前就绪。
const readClaudeUsage = createClaudeUsageReader();
const agentUsage = await createAgentUsageStore(path.join(dataDirectory, 'agent-runtimes'), { writeJson: stateBackup.writeJson });
const agentRuntimes = await createAgentRuntimeService(path.join(dataDirectory, 'agent-runtimes'), {
  browserRootDirectory: root,
  workspaceSnapshotExclusions: [dataDirectory, path.join(root, '.local', 'logs'),
    ...(process.env.DELIVERY_SOURCE_DATA_DIR ? [process.env.DELIVERY_SOURCE_DATA_DIR] : [])],
  readProviderUsage: { claude: readClaudeUsage },
  onFinalized: run => agentUsage.upsert({ runId: run.id, workflowId: run.team?.taskId.replace(/^(?:draft|opinion):/, '') || run.task?.workflow?.id, profileId: run.team?.profileId || run.task?.profileId,
    provider: run.provider, model: run.model, createdAt: run.createdAt, completedAt: run.updatedAt, round: run.task?.workflow?.round, usage: run.usage! }).then(() => {}),
  stateBackup,
  resolveKnowledge: async objective => (await Promise.all([
    agentNotes.resolveReferences(objective), confluenceKnowledge.resolveReferences(objective),
  ])).filter(Boolean).join('\n\n'),
  resolveAttachments: agentAttachments.resolve,
  removeAttachments: agentAttachments.remove,
});
const desktopAccounts = createDesktopAccountsService();
const accountServices = Object.fromEntries(accountProviders.map(provider =>
  [provider, createCursorAccountsService(agentRuntimes, { provider, openDesktop: async () => {
    const desktop = await desktopAccounts.dashboard(provider);
    if (!desktop.canOpen) return { status: 'skipped' as const, message: desktop.message };
    const opened = await desktopAccounts.open(provider);
    return { status: 'opened' as const, message: opened.message };
  } })])) as Record<AccountProvider, ReturnType<typeof createCursorAccountsService>>;
const accountRoutes = Object.fromEntries(accountProviders.map(provider =>
  [provider, createCursorAccountsRoute(accountServices[provider], provider)])) as Record<AccountProvider, ReturnType<typeof createCursorAccountsRoute>>;
const desktopAccountRoute = createDesktopAccountsRoute({ dashboard: desktopAccounts.dashboard, open: async provider => {
  if (!accountProviders.includes(provider as AccountProvider)) return desktopAccounts.open(provider);
  try { return await accountServices[provider as AccountProvider].withDesktopOpen(() => desktopAccounts.open(provider)); }
  catch (error) {
    if (error instanceof DesktopAccountError) throw error;
    const message = error instanceof Error && ['工作台正在退出', '另一个账号管理操作正在运行，请完成后再打开桌面应用',
      '桌面应用未能打开，请稍后重试'].includes(error.message) ? error.message : '桌面端登录入口暂不可用，请稍后重试。';
    throw new DesktopAccountError(message);
  }
} });
const workspacePicker = createWorkspacePickerRoute();
const workspaceTerminal = createWorkspaceTerminalRoute();
const workspaceCursor = createWorkspaceAppRoute('Cursor', directory => openWorkspaceCursor(directory, path.join(dataDirectory, 'cursor-workspaces')));
let groupChat: Awaited<ReturnType<typeof createAgentGroupChat>> | undefined;
const jiraRuntime = { ...agentRuntimes,
  findJiraFix: (id: string) => { const group = groupChat?.jiraExecution(id); return group ? group.run : agentRuntimes.findJiraFix(id); },
  findRequirementDevelopment: (id: string) => { const group = groupChat?.jiraExecution(id); return group ? group.run : agentRuntimes.findRequirementDevelopment(id); },
};
const requirementDevelopment = await createRequirementDevelopmentService(path.join(dataDirectory, 'requirement-development'), jiraRuntime,
  undefined, { writeJson: stateBackup.writeJson, groupExecution: id => groupChat?.jiraExecution(id) });
const jiraFix = await createJiraFixService(path.join(dataDirectory, 'jira-fix'), jiraRuntime, sourceBackend, undefined, { groupExecution: id => groupChat?.jiraExecution(id) });
const jiraDevSync = createJiraDevSync({ dataDirectory });
let agentTeams: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
let jiraDevAutomation: Awaited<ReturnType<typeof createJiraDevAutomation>> | undefined;
const jiraDev = await createJiraDevTaskService({ dataDirectory: path.join(dataDirectory, 'jira-dev'),
  connectionDirectory: path.join(dataDirectory, 'jira-dev'), runtime: agentRuntimes,
  prepareAutomationDelivery: async (task, launch) => jiraDevAutomation?.prepare(task, launch),
  automationDeliveryStatus: taskId => jiraDevAutomation?.status(taskId),
  onLaunch: async (task, launch) => jiraDevAutomation?.activate(task, launch),
  adoptJiraFix: record => jiraFix.adopt(record), adoptRequirement: async record => {
    const result = await requirementDevelopment.adopt(record);
    if (record.groupRoomId) await requirementDevelopment.synchronizeGroup(record.id);
    return result;
  },
  preflightGroup: (revision, workspacePath, accessMode, sourceProjectPaths) => {
    if (!groupChat) throw new Error('团队群聊服务尚未就绪');
    return groupChat.preflightJira(revision, workspacePath, accessMode, sourceProjectPaths);
  },
  requirementReader: revision => {
    if (!groupChat) throw new Error('团队群聊服务尚未就绪');
    return groupChat.requirementReader(revision);
  },
  startGroup: async input => {
    if (!groupChat) throw new Error('团队群聊服务尚未就绪');
    await groupChat.startJira(input);
    const result = groupChat.jiraExecution(input.source.taskId)!;
    return { groupRoomId: result.groupRoomId, groupProgress: result.groupProgress, runId: result.run?.id || '' };
  },
  findGroup: id => { const result = groupChat?.jiraExecution(id); return result ? { groupRoomId: result.groupRoomId, groupProgress: result.groupProgress, runId: result.run?.id || '' } : undefined; },
  startTeam: async input => {
    if (!agentTeams) throw new Error('自动协作服务尚未就绪');
    const result = await agentTeams.chat({ ...input, attachmentIds: [] });
    return { teamTaskId: result.task.id, conversationId: result.conversationId, runId: result.runId,
      runStatus: agentRuntimes.getRun(result.runId)?.status };
  },
  findTeam: requestId => {
    const task = agentTeams?.list().find(item => item.requestIds?.[`chat:${requestId}`] || item.requestIds?.[`create:${requestId}`]);
    if (!task) return undefined;
    const runId = [...task.nodes].reverse().find(node => node.profileId === 'leader' && node.runId)?.runId || '';
    return { teamTaskId: task.id, conversationId: task.parentConversationId, runId, runStatus: agentRuntimes.getRun(runId)?.status };
  },
  readHubIssue: key => sourceBackend.readJiraFixIssue(key) });
const resolveLegacyAcceptance = createDeliveryAcceptanceSourceResolver(async () => {
    const [automation, catchup, merge, design, runtime] = await Promise.all([
      sourceBackend.readAutomation(), sourceBackend.readCatchup(), sourceBackend.readMergePlan(false),
      designExecutor.dashboard(), agentRuntimes.dashboard(),
    ]);
    return { automation, catchup, merge: merge as MergeData, design, runs: runtime.runs, workflows: runtime.workflows,
      requirements: requirementDevelopment.list(), fixes: jiraFix.list() };
  });
const deliveryAcceptance = await createDeliveryAcceptanceStore(path.join(dataDirectory, 'delivery-acceptance'),
  id => id.startsWith('team:') ? agentTeams?.acceptanceSource(id.slice(5)) : resolveLegacyAcceptance(id), { writeJson: stateBackup.writeJson });
const jiraFixHandoff = await createJiraFixHandoffService(path.join(dataDirectory, 'jira-fix-handoffs'), id => {
  const record = jiraFix.list().find(item => item.id === id);
  const group = groupChat?.jiraExecution(id);
  return record ? { record, run: jiraRuntime.findJiraFix(id), history: group ? group.runs.map(run => ({ objective: run.objective, result: run.result, status: run.status })) : agentRuntimes.jiraFixResults(id) } : undefined;
}, createJiraHandoffClient(sourceBackend.jiraFixHandoffRequest), undefined, agentRuntimes);
const integrationCatalog = await loadIntegrationCatalog();
const integration = await createIntegrationStore(dataDirectory, integrationCatalog);
const apexBffReview = await createApexBffReviewStore(dataDirectory, integrationCatalog);
const wecomIntegration = await createWecomIntegration(dataDirectory, { catalog: integrationCatalog });
const workspaceTodos = await createWorkspaceTodos(path.join(dataDirectory, 'workspace-todos'));
const overseasRequirements = await createOverseasRequirements(path.join(dataDirectory, 'overseas-requirements'),
  id => requirementDevelopment.list().some(record => record.id === id));
const reportBot = await createWecomIntegration(path.join(dataDirectory, 'workspace-reports'), {
  configFile: path.join(dataDirectory, 'workspace-reports', 'bot.json'),
  catalog: integrationCatalog,
});
const workspaceReports = await createWorkspaceReports(path.join(dataDirectory, 'workspace-reports'), {
  bots: { integration: wecomIntegration, dedicated: reportBot },
  readSnapshot: () => readWorkspaceReportSnapshot({
    jira: () => sourceBackend.readIssues(), automation: () => sourceBackend.readAutomation(),
    runtime: () => agentRuntimes.dashboard(), design: () => designExecutor.dashboard(),
    requirements: () => requirementDevelopment.list(), fixes: () => jiraFix.list(),
    catchup: () => sourceBackend.readCatchup(), merge: async () => await sourceBackend.readMergePlan(false) as MergeData,
    teams: () => agentTeams?.list() || [], groups: () => groupChat?.dashboard().rooms || [], todos: () => workspaceTodos.list(),
  }),
  onError: () => console.error('综合汇报调度失败，请在汇报策略中查看状态并核对本机存储或任务来源'),
});
const workspaceTodoRoutes = createWorkspaceTodoRoutes(workspaceTodos, { json, body, port });
const overseasRequirementRoutes = createOverseasRequirementRoutes(overseasRequirements, { json, body, port });
const projectWorkspaces = await createProjectWorkspaces(path.join(dataDirectory, 'project-workspaces'), {
  readProjects: refresh => sourceBackend.readLocalProjects(refresh),
  withWorkspace: (directory, owner, action) => agentRuntimes.withTeamWorkspace(directory, owner, action),
  checkBusy: createWorkspaceUsageCheck(() => agentRuntimes.activeWorkspacePaths()),
  protectedPaths: [root, dataDirectory, distDirectory],
  workspaceRoots: [path.join(root, 'workspaces'), ...['workspaces', 'team-workspaces', 'group-verifications']
    .map(name => path.join(dataDirectory, 'agent-runtimes', name))],
  canRun: () => !workspaceRestart.isRestarting(),
});
const projectWorkspaceRoutes = createProjectWorkspaceRoutes(projectWorkspaces, { json, body, port });
const projectLaunch = createProjectLaunch(path.join(dataDirectory, 'project-launch'), { root, dataDir: dataDirectory, selfPort: port });
const projectLaunchRoutes = createProjectLaunchRoutes(projectLaunch, { json, body, port });
const workspaceReportRoutes = createWorkspaceReportRoutes(workspaceReports, { json, body, port });

const codexUsageReader = createCodexUsageReader();
async function readCodexUsage(force = false) {
  const version = agentRuntimes.runtimeStatusVersion();
  const usage = await codexUsageReader(force, String(version));
  // 团队派发也会读取额度，账号切换期间的旧结果不能用于新账号的门禁。
  return version === agentRuntimes.runtimeStatusVersion() ? usage : {
    available: false, checkedAt: new Date().toISOString(), errorKind: 'unavailable' as const,
    message: '账号状态已变化，请刷新额度',
  };
}
const readCodexPlanUsage = createCodexPlanUsageReader();
const readCursorUsage = createCursorUsageReader();
const readAntigravityUsage = createAntigravityUsageReader();
agentTeams = await createAgentTeamService(path.join(dataDirectory, 'agent-runtimes'), agentRuntimes, {
  writeJson: stateBackup.writeJson, readAcceptance: deliveryAcceptance.get,
  readLegacyAcceptanceSource: resolveLegacyAcceptance,
  readProviderUsage: { codex: readCodexUsage, claude: readClaudeUsage, cursor: readCursorUsage },
  readWorkspaceCandidates: async () => {
    const local = await sourceBackend.readLocalProjects().catch(() => undefined);
    return [root, ...(local?.projects || []).map(project => project.path)];
  },
});
const teamGovernance = await createAgentTeamGovernance(path.join(dataDirectory, 'agent-runtimes'), agentRuntimes, agentTeams, {
  usageStore: agentUsage, writeJson: stateBackup.writeJson,
  readProviderUsage: { codex: readCodexUsage, claude: readClaudeUsage, cursor: readCursorUsage },
});
const teamRoutes = createAgentTeamRoutes(agentTeams, teamGovernance, agentUsage, { json, body, port });
groupChat = await createAgentGroupChat(path.join(dataDirectory, 'agent-runtimes'), agentRuntimes, { profiles: () => agentTeams!.profiles.read(), automatic: agentTeams, writeJson: stateBackup.writeJson,
  readProviderUsage: { codex: readCodexUsage, claude: readClaudeUsage, cursor: readCursorUsage },
  onJiraCompleted: async taskId => { await jiraDev.synchronizeGroup(taskId); jiraDevAutomation?.refresh(taskId); } });
const jiraDevConnection = createConnectionSettings({ dataDirectory: path.join(dataDirectory, 'jira-dev') });
jiraDevAutomation = await createJiraDevAutomation({
  directory: path.join(dataDirectory, 'jira-dev', 'automation-delivery'),
  readSettings: async () => (await sourceBackend.readAutomation()).settings,
  readTask: jiraDev.deliveryTask,
  readIssue: async binding => {
    const issue = await sourceBackend.readJiraFixIssue(binding.key);
    if (!issue || issue.key !== binding.key || issue.url !== binding.url) throw new Error('巡检 Jira 来源与已绑定事项不一致。');
    return issue;
  },
  readRun: async (taskId, workflow, launch) => {
    if (launch.groupRoomId) {
      const group = groupChat?.jiraExecution(taskId);
      if (group?.groupRoomId !== launch.groupRoomId) return;
      const detail = groupChat!.detail(launch.groupRoomId);
      const round = detail.room.rounds.at(-1);
      if (group.groupProgress.state === 'running') {
        return round?.turns.map(turn => detail.runs.find(run => run.id === turn.runId)).find(run => run?.status === 'running');
      }
      if (group.groupProgress.state !== 'completed') return;
      const verifier = round?.turns.filter(turn => turn.member.capability === 'verify' && turn.status === 'completed').at(-1);
      return detail.runs.find(run => run.id === verifier?.runId);
    }
    if (launch.teamTaskId) {
      const task = agentTeams?.getTask(launch.teamTaskId);
      if (!task) return;
      if (!['awaiting_acceptance', 'accepted', 'completed'].includes(task.state)) {
        return ['running', 'planning'].includes(task.state) ? agentRuntimes.teamRuns(task.id).find(run => run.status === 'running') : undefined;
      }
      const current = await agentTeams?.acceptanceSource(task.id);
      if (!current || current.active) return;
      const verifier = task.nodes.filter(node => node.round === task.round && node.stage === 'verify' && node.status === 'completed').at(-1);
      return verifier?.runId ? agentRuntimes.getRun(verifier.runId) : undefined;
    }
    const runs = agentRuntimes.jiraDevRuns(taskId, workflow);
    return runs.some(run => run.id === launch.runId) ? runs.at(-1) : undefined;
  },
  advance: async (binding, status, phase, beforeWrite) => advanceJiraDevStatus(await jiraDevConnection.client(), binding, status, phase, beforeWrite),
  mergeRequest: (input, beforeCreate) => deliverJiraDevMergeRequest(input, { dataDirectory, beforeCreate, pushVerifiedHead: true }),
});
const unsubscribeJiraDevRuns = agentRuntimes.subscribe((_revision, run, finalized) => {
  const source = /^(?:jira-fix|requirement):([a-f0-9-]{36})$/.exec(run?.task?.sourceId || '');
  if (source && (finalized || run?.status === 'running')) jiraDevAutomation?.refresh(source[1]!);
  if (run?.team?.interactionMode === 'group' && run.status === 'running') jiraDevAutomation?.refreshGroup(run.team.taskId);
});
const unsubscribeJiraDevTeams = agentTeams.subscribe(event => jiraDevAutomation?.refreshTeam(event.taskId));
for (const task of await jiraDev.list()) {
  if (task.launch && jiraDevAutomation.status(task.taskId)) {
    await jiraDevAutomation.activate(await jiraDev.deliveryTask(task.taskId), task.launch);
  }
}
sourceBackend.connectJiraDevPreviews(jiraDev.prepareAutomationPreviews);
const confluenceDelivery = createAgentRemoteDeliveryConfluence(sourceBackend.confluenceReadRequest,
  (resource, method, body) => {
    if (!sourceBackend.confluencePublishRequest) throw new Error('Confluence 发布连接尚未就绪。');
    return sourceBackend.confluencePublishRequest(resource, method, body);
  });
const remoteDelivery = await createAgentRemoteDelivery({ directory: path.join(dataDirectory, 'agent-remote-delivery'),
  find: id => groupChat!.detail(id),
  findGroup: id => { const result = groupChat?.jiraExecution(id); return result ? { groupRoomId: result.groupRoomId } : undefined; },
  taskRuns: (taskId, workflow) => {
    const teamTask = agentTeams?.list().find(item => item.requestIds?.[`chat:jira-dev:${taskId}`] || item.requestIds?.[`create:jira-dev:${taskId}`]);
    return [
      ...agentRuntimes.jiraDevRuns(taskId, workflow, teamTask?.parentConversationId || ''),
      ...(teamTask ? agentRuntimes.teamRuns(teamTask.id) : []),
    ];
  },
  task: id => jiraDev.deliveryTask(id), lookupJiraTasks: task => jiraDev.deliveryJiraTasks(task), source: sourceBackend,
  lookupDesign: input => confluenceDelivery.lookup(input),
  publishComment: (taskId, body) => jiraDev.publishDeliveryComment(taskId, body), publishDesign: input => confluenceDelivery.publish(input),
  saveDesign: (taskId, input) => jiraDev.saveDeliveryDesign(taskId, input) });
const groupChatRoutes = createAgentGroupChatRoutes(groupChat, { json, body, port }, remoteDelivery);
const deployments = await createJenkinsDeployments(dataDirectory, { readProjects: () => sourceBackend.readLocalProjects() });
const yunxiaoDeployments = await createYunxiaoDeployments(dataDirectory);
const deploymentsRoute = createJenkinsDeploymentsRoute(deployments, yunxiaoDeployments);
const vite = process.argv.includes('--dev') ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const workflowContextSchema = z.object({ conversationId: z.string().trim().min(1).max(200), agentRunId: z.string().trim().min(1).max(200),
  workspacePath: z.string().trim().min(1).max(1000), branch: z.string().trim().max(300), provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity']) }).strict();
const startSchema = z.object({ requirementId: z.string().regex(/^REQ-(?:CU-)?\d{3}$/), scenario: z.enum(['standard', 'missing-evidence', 'merge-conflict']),
  context: workflowContextSchema.optional() }).strict();
const resumeSchema = z.object({ action: z.enum(['approve', 'retest']) });
const agentResumeSchema = z.object({ objective: z.string().max(200_000), attachmentIds: agentAttachmentIdsSchema,
  model: z.string().trim().max(100).optional(), reasoningEffort: agentReasoningSchema.optional(), serviceTier: agentServiceTierSchema.optional(), accessMode: agentAccessSchema.optional(),
  queuePlacement: z.enum(['append', 'next']).default('append') }).strict()
  .refine((input) => !!input.objective.trim() || !!input.attachmentIds.length, { message: '请填写消息或添加附件' });
const agentContinueSchema = agentResumeSchema.safeExtend({ mode: z.enum(['agent', 'plan', 'ask']).optional() });
const agentSpawnSchema = z.object({ title: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(200_000),
  role: z.enum(['worker', 'reviewer']).default('worker'),
  dependsOnConversationIds: z.array(z.string().trim().min(1).max(200)).max(12).default([]) }).strict();
const agentTaskWorkflowSchema = z.object({ templateId: z.literal('implement-review'),
  objective: z.string().trim().min(1).max(200_000), model: z.string().trim().max(100).optional(),
  reasoningEffort: agentReasoningSchema.optional(), serviceTier: agentServiceTierSchema.optional(), accessMode: agentAccessSchema.optional(),
  attachmentIds: agentAttachmentIdsSchema }).strict();
// 团队模板的岗位、模型与权限由岗位配置决定，不接受输入框中的模型或访问模式。
const agentTeamWorkflowSchema = z.object({ templateId: z.enum(['engineering', 'frontend']),
  objective: z.string().trim().min(1).max(200_000), attachmentIds: agentAttachmentIdsSchema,
  acceptanceCriteria: z.array(z.string().trim().max(2000)).max(30).default([]),
  allowedPaths: z.array(z.string().trim().max(300)).max(30).default([]) }).strict();
const agentWorkflowDecisionSchema = z.object({ action: z.enum(['extend', 'escalate', 'retry', 'takeover', 'cancel']),
  requestId: z.string().trim().min(8).max(100) }).strict();
const maxAgentAttachmentBase64Length = Math.ceil(maxAgentAttachmentBytes / 3) * 4;
const agentAttachmentUploadSchema = z.object({ name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  data: z.string().min(1).max(maxAgentAttachmentBase64Length) }).strict();
const agentConversationTitleSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
const agentConversationDeleteBatchSchema = z.object({
  targets: z.array(z.object({
    id: z.string().regex(/^[0-9a-f-]{36}$/),
    source: z.enum(['workspace', 'codex']),
  }).strict()).min(1),
}).strict();

let pendingMutations = 0;
async function restartBlockers() {
  const [cli, design, automation, catchup, merge] = await Promise.all([
    cliQueue.dashboard(), designExecutor.dashboard(), sourceBackend.readAutomation(), sourceBackend.readCatchup(), sourceBackend.readMergePlan(false),
  ]) as [Awaited<ReturnType<typeof cliQueue.dashboard>>, Awaited<ReturnType<typeof designExecutor.dashboard>>,
    Awaited<ReturnType<typeof sourceBackend.readAutomation>>, Awaited<ReturnType<typeof sourceBackend.readCatchup>>, MergeData];
  if (!Array.isArray(automation.jobs) || !Array.isArray(catchup.requirements) || !Array.isArray(merge.items)) {
    throw new Error('暂时无法核验后台任务状态，未执行重启。');
  }
  const blockers: string[] = [];
  if (pendingMutations) blockers.push('正在处理的请求');
  if (!workspaceReports.isIdle()) blockers.push('任务汇报生成或推送');
  if (!projectWorkspaces.isIdle()) blockers.push('工作区清理');
  if (projectLaunch.isBusy()) blockers.push('项目启动或配置操作');
  if (!agentRuntimes.isIdle()) blockers.push('Agent 任务或工作区占用');
  if (agentTeams && !agentTeams.isIdle()) blockers.push('团队步骤衔接');
  if (groupChat && !groupChat.isIdle()) blockers.push('团队群聊派发');
  if (cli.enabled || ['running', 'draining'].includes(cli.status) || cli.runs.length) blockers.push('CLI 执行队列');
  if (design.runs.some(run => activeStatus(run.status))) blockers.push('设计任务');
  if (!sourceBackend.isIdle() || automation.running || automation.weeklyReport.running || automation.jobs.some(job => activeStatus(job.status))) blockers.push('自动化任务');
  if (catchup.requirements.some(item => activeStatus(item.session?.status))) blockers.push('追平任务');
  if (activeStatus(merge.pipeline?.status, false) || merge.items.some(item => activeStatus(item.pipeline?.status, false))) blockers.push('合入任务');
  if (!service.isIdle()) blockers.push('交付流程');
  if (refactorControl && !refactorControl.isIdle(false)) blockers.push('复测准备');
  if (!remoteDelivery.isIdle()) blockers.push('远端交付操作');
  if (!jiraDevAutomation?.isIdle()) blockers.push('研发任务自动交付');
  if (!requirementDevelopment.isIdle() || !jiraFix.isIdle() || !jiraFixHandoff.isIdle() || !jiraDev.isIdle()) blockers.push('需求、修复或交接处理');
  if (Object.values(accountServices).some(accounts => !accounts.isIdle())) blockers.push('账号操作');
  if (!deployments.isIdle()) blockers.push('Jenkins 部署或日志读取');
  if (!yunxiaoDeployments.isIdle()) blockers.push('云效部署或状态读取');
  return blockers;
}
const workspaceRestart = createWorkspaceRestart({
  available: () => isPm2ManagedWorkspace(root), prepare: () => agentRuntimes.prepareWorkspaceRestart(),
  update: process.argv.includes('--dev') ? undefined : async () => {
    const { backend } = await readVersion();
    const next = await ensureWorkspaceBuild(root, distDirectory, { ...workspaceBuildOptions, prepareOnly: true });
    if (next.build.backendSourceHash !== backend.sourceHash) return 'restart';
    if (!next.rebuilt) return 'current';
    await ensureWorkspaceBuild(root, distDirectory, { ...workspaceBuildOptions, backendSourceHash: backend.sourceHash });
    return 'refresh';
  },
  blockers: restartBlockers, hold: () => sourceBackend.holdForRestart(), idleChecks: 1,
  restart: async () => {
    const backup = await stateBackup.snapshot();
    if (backup.entries.some(entry => entry.status === 'failed')) throw new Error('关键状态备份失败，未执行重启，请检查本机存储。');
    if ((await restartBlockers()).length) throw new Error('任务状态发生变化，未执行重启，请重试。');
    await shutdown();
  },
});
const workspaceRestartRoute = createWorkspaceRestartRoute(workspaceRestart);
let refactorControl: Awaited<ReturnType<typeof createRefactorControl>>;
const refactorWorkspace = await createRefactorWorkspace(root, path.join(dataDirectory, 'refactor-workspace'), { control: () => refactorControl });
refactorControl = await createRefactorControl(root, path.join(dataDirectory, 'refactor-control'), agentRuntimes, {
  teams: agentTeams, groups: groupChat, catalog: integrationCatalog,
  extraModules: () => refactorWorkspace.modules(), moduleConfig: module => refactorWorkspace.projectConfig(module),
  allowDispatch: async () => !['waiting', 'restarting'].includes((await workspaceRestart.dashboard()).status),
});

async function body(request: http.IncomingMessage, limit = 300_000): Promise<unknown> {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > limit) throw new Error('请求内容过大'); }
  return JSON.parse(text || '{}');
}
function json(response: http.ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (workspaceRestart.isRestarting() && url.pathname.startsWith('/api/')
    && !['/api/health', '/api/workspace/restart'].includes(url.pathname)) {
    json(response, 503, { message: '后端正在重启，请等待连接恢复后重试。' }); return;
  }
  const mutation = request.method !== 'GET' && request.method !== 'HEAD' && url.pathname !== '/api/workspace/restart';
  if (mutation) pendingMutations++;
  try {
    if (url.pathname.startsWith('/api/')) {
      if (await systemCatalogRoutes(request, response, url)) return;
      if (await interfaceCenterRoutes(request, response, url)) return;
      if (url.pathname.startsWith('/api/jira/issues/')) { await jiraIssueRoute(request, response, port); return; }
      if (url.pathname === '/api/workspace/select') { await workspacePicker(request, response, port); return; }
      if (url.pathname === '/api/workspace/terminal') { await workspaceTerminal(request, response, port); return; }
      if (url.pathname === '/api/workspace/cursor') { await workspaceCursor(request, response, port); return; }
      if (await projectWorkspaceRoutes(request, response, url)) return;
      if (await projectLaunchRoutes(request, response, url)) return;
      if (url.pathname === '/api/share/config') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET') { json(response, 200, readShareConfig()); return; }
        if (request.method === 'POST') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await updateShareConfig((await body(request)) as Record<string, unknown>, sourceBackend)); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname.startsWith('/api/projects/git/')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/projects/git/snapshot') {
          json(response, 200, await readProjectGitSnapshot(url.searchParams.get('path') || '')); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/projects/git/tree') {
          json(response, 200, await readProjectTree(url.searchParams.get('path') || '', url.searchParams.get('dir') || '')); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/projects/git/code') {
          json(response, 200, await readProjectCode(url.searchParams.get('path') || '', url.searchParams.get('file') || '')); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/projects/git/code') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await saveProjectCode((await body(request, 13_000_000)) as Record<string, unknown>)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/projects/git/diff') {
          json(response, 200, await readProjectDiff(url.searchParams.get('path') || '', url.searchParams.get('file') || '', url.searchParams.get('staged') === 'true')); return;
        }
        if (request.method === 'POST' && ['/api/projects/git/merge-request/list', '/api/projects/git/merge-request/prepare', '/api/projects/git/merge-request/create', '/api/projects/git/merge-request/title'].includes(url.pathname)) {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          if (url.pathname.endsWith('/title') && request.headers['x-delivery-confirmed'] !== 'yes') {
            json(response, 403, { message: '请在合并请求列表确认修改标题' }); return;
          }
          const input = (await body(request)) as Record<string, unknown>;
          const operation = url.pathname.endsWith('/list') ? listProjectMergeRequests
            : url.pathname.endsWith('/title') ? updateProjectMergeRequestTitle
            : url.pathname.endsWith('/create') ? createProjectMergeRequest : prepareProjectMergeRequest;
          json(response, 200, await operation(input, { dataDirectory })); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/projects/git/action') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          const input = (await body(request)) as Record<string, unknown>;
          if (input.action === 'discard' && typeof input.path === 'string') {
            const repo = await readProjectGitSnapshot(input.path);
            if (!repo.isGit) { json(response, 400, { message: '当前目录不是可用的 Git 仓库。' }); return; }
            json(response, 200, await agentRuntimes.withTeamWorkspace(repo.directory, `git-discard:${randomUUID()}`,
              () => executeProjectGitAction({ ...input, path: repo.directory }, sourceBackend)));
          } else json(response, 200, await executeProjectGitAction(input, sourceBackend));
          return;
        }
        json(response, 404, { message: 'Git 操作接口不存在' }); return;
      }
      if (url.pathname === '/api/ports' || url.pathname === '/api/ports/action') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/ports') {
          json(response, 200, await scanListeningPorts(parsePortList(url.searchParams.get('ports')), { readProjects: sourceBackend.readLocalProjects, root, dataDir: dataDirectory, selfPort: port })); return;
        }
        if (request.method === 'POST') {
          const origin = request.headers.origin;
          if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) { json(response, 403, { message: '请求来源不匹配' }); return; }
          if (!request.headers['content-type']?.includes('application/json')) { json(response, 415, { message: '请发送 JSON' }); return; }
          const payload = (await body(request)) as PortActionRequest;
          json(response, 200, await executePortAction(payload, {
            readProjects: sourceBackend.readLocalProjects,
            root,
            dataDir: dataDirectory,
            selfPort: port,
            requestedPorts: parsePortList(payload.ports || url.searchParams.get('ports')),
          }));
          return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) { json(response, 403, { message: '请求来源不匹配' }); return; }
        if (!request.headers['content-type']?.includes('application/json')) { json(response, 415, { message: '请发送 JSON' }); return; }
      }
      if (url.pathname === '/api/workspace/restart') { await workspaceRestartRoute(request, response, port); return; }
      if (request.method === 'GET' && url.pathname === '/api/workspace/workbench-dismissals') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        const stored = await fs.readFile(path.join(dataDirectory, 'workbench-dismissals.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '[]';
          throw error;
        });
        json(response, 200, { keys: z.array(z.string()).parse(JSON.parse(stored)) }); return;
      }
      if (url.pathname === '/api/deployments' || url.pathname.startsWith('/api/deployments/')) {
        await deploymentsRoute(request, response, port); return;
      }
      if (url.pathname === '/api/refactor-integration') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET') { json(response, 200, integration.snapshot()); return; }
        if (request.method === 'POST') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await integration.update(await body(request))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (await workspaceTodoRoutes(request, response, url)) return;
      if (await overseasRequirementRoutes(request, response, url)) return;
      if (await workspaceReportRoutes(request, response, url)) return;
      if (url.pathname.startsWith('/api/integration-wecom')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
        if (url.pathname === '/api/integration-wecom/messages/history' && request.method === 'GET') { json(response, 200, wecomIntegration.messageHistory()); return; }
        if (url.pathname === '/api/integration-wecom/messages/library') {
          if (request.method === 'GET') { json(response, 200, wecomIntegration.messageLibrary()); return; }
          if (request.method === 'POST') { json(response, 200, await wecomIntegration.saveMessage(await body(request, 60_000))); return; }
        }
        if (url.pathname === '/api/integration-wecom/messages/library/delete' && request.method === 'POST') { json(response, 200, await wecomIntegration.deleteMessage(await body(request, 1000))); return; }
        if (url.pathname === '/api/integration-wecom/messages/preview' && request.method === 'POST') { json(response, 200, wecomIntegration.messagePreview(await body(request, 60_000))); return; }
        if (url.pathname === '/api/integration-wecom/messages/send' && request.method === 'POST') {
          if (request.headers['x-delivery-confirmed'] !== 'yes') { json(response, 403, { message: '请先预览并确认发送到企业微信群' }); return; }
          json(response, 200, await wecomIntegration.sendMessage(await body(request, 60_000))); return;
        }
        if (url.pathname === '/api/integration-wecom/config') {
          if (request.method === 'GET') { json(response, 200, wecomIntegration.config()); return; }
          if (request.method === 'POST') { json(response, 200, await wecomIntegration.configure(await body(request, 30_000))); return; }
        }
        if (url.pathname === '/api/integration-wecom/reports' && request.method === 'GET') { json(response, 200, wecomIntegration.history(url.searchParams.get('interfaceId') || '')); return; }
        if (url.pathname === '/api/integration-wecom/preview' && request.method === 'POST') { json(response, 200, wecomIntegration.preview(await body(request, 60_000))); return; }
        if (url.pathname === '/api/integration-wecom/send' && request.method === 'POST') {
          if (request.headers['x-delivery-confirmed'] !== 'yes') { json(response, 403, { message: '请先预览并确认发送到企业微信群' }); return; }
          json(response, 200, await wecomIntegration.send(await body(request, 60_000))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname === '/api/integration-catalog' && request.method === 'GET') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        json(response, 200, integrationCatalog); return;
      }
      if (url.pathname === '/api/apex-bff-review') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET') { json(response, 200, apexBffReview.snapshot()); return; }
        if (request.method === 'POST') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await apexBffReview.update(await body(request, 50_000))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname.startsWith('/api/cli-executor')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '') || request.headers['x-delivery-confirmed'] !== 'yes')) { json(response, 403, { message: '请在当前面板确认 CLI 执行操作' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/cli-executor') { json(response, 200, await cliQueue.dashboard()); return; }
        if (request.method === 'POST' && ['/api/cli-executor/start', '/api/cli-executor/pause'].includes(url.pathname)) {
          z.object({}).strict().parse(await body(request));
          const starting = url.pathname.endsWith('/start');
          const state = await (starting ? cliQueue.start() : cliQueue.pause());
          json(response, 200, { ...state, message: starting ? 'Codex CLI 队列已启动，仅领取已授权任务' : '已暂停新任务领取，正在执行的任务会继续完成' }); return;
        }
        json(response, 404, { message: 'CLI 执行接口不存在' }); return;
      }
      if (url.pathname.startsWith('/api/agent-runtimes')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '') || request.headers['x-delivery-confirmed'] !== 'yes')) {
          json(response, 403, { message: '请在当前面板确认本机 Agent 操作' }); return;
        }
        if (await groupChatRoutes(request, response, url)) return;
        if (await teamRoutes(request, response, url)) return;
        if (url.pathname === '/api/agent-runtimes/refactor-control' && request.method === 'GET') {
          json(response, 200, await refactorControl.dashboard()); return;
        }
        if (url.pathname.startsWith('/api/agent-runtimes/refactor-control/')) {
          const action = url.pathname.slice('/api/agent-runtimes/refactor-control/'.length);
          if (action === 'workspace' && request.method === 'GET') { json(response, 200, await refactorWorkspace.snapshot()); return; }
          if (action === 'workspace/import' && request.method === 'POST') { json(response, 200, await refactorWorkspace.importDocument(await body(request, 57_000_000))); return; }
          if (action === 'workspace/bind' && request.method === 'POST') { json(response, 200, await refactorWorkspace.bind(await body(request))); return; }
          if (action === 'workspace/projects' && request.method === 'GET') { json(response, 200, await refactorWorkspace.projects.snapshot()); return; }
          if (action === 'workspace/projects' && request.method === 'POST') { json(response, 200, await refactorWorkspace.projects.configure(await body(request))); return; }
          if (action === 'workspace/projects/start' && request.method === 'POST') { json(response, 202, await refactorWorkspace.projects.start(await body(request))); return; }
          const document = action.match(/^workspace\/documents\/([a-f0-9-]{36})\/(original|export)$/);
          if (document && request.method === 'GET') {
            const format = document[2] as 'original' | 'export';
            const filename = await refactorWorkspace.download(document[1], format, url.searchParams.get('jobId') ?? undefined);
            const downloadName = encodeURIComponent(refactorWorkspace.downloadName(document[1], format))
              .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
            response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename="refactor-${document[2]}.xlsx"; filename*=UTF-8''${downloadName}`, 'Cache-Control': 'no-store' });
            createReadStream(filename).pipe(response); return;
          }
          const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
            config: refactorControl.configure, preview: refactorControl.preview, start: refactorControl.start, branches: refactorControl.branches,
          };
          if (request.method === 'POST' && handlers[action]) { json(response, action === 'start' ? 202 : 200, await handlers[action](await body(request))); return; }
          const stopJob = action.match(/^jobs\/([a-f0-9-]{36})\/stop$/);
          if (request.method === 'POST' && stopJob) { z.object({}).strict().parse(await body(request)); json(response, 200, await refactorControl.stop(stopJob[1])); return; }
          const artifact = action.match(/^artifacts\/([a-f0-9-]{36})\/(.+)$/);
          if (request.method === 'GET' && (artifact || action === 'source-artifact')) {
            const file = artifact ? await refactorControl.artifact(artifact[1], decodeURIComponent(artifact[2]))
              : await refactorControl.sourceArtifact(z.string().max(2000).parse(url.searchParams.get('file')));
            const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf' };
            response.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
              'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
            createReadStream(file).pipe(response); return;
          }
          if (request.method === 'GET' && action === 'export') {
            const input = z.object({ format: z.enum(['md', 'json']), modules: z.string().max(600).default('') }).parse(Object.fromEntries(url.searchParams));
            const output = await refactorControl.export(input.format, input.modules.split(',').filter(Boolean));
            response.writeHead(200, { 'Content-Type': input.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
              'Content-Disposition': `attachment; filename="refactor-report.${input.format}"` }); response.end(output); return;
          }
          json(response, 404, { message: '重构管理接口不存在' }); return;
        }
        if (url.pathname.startsWith('/api/agent-runtimes/confluence/')) {
          const action = url.pathname.slice('/api/agent-runtimes/confluence/'.length);
          if (action === 'config' && request.method === 'GET') {
            json(response, 200, await confluenceKnowledge.config(url.searchParams.get('workspacePath') || '')); return;
          }
          if (action === 'config' && request.method === 'POST') {
            const input = z.object({ workspacePath: z.string().min(1).max(1000), scope: z.unknown() }).strict().parse(await body(request));
            json(response, 200, await confluenceKnowledge.configure(input.workspacePath, input.scope)); return;
          }
          if (action === 'search' && request.method === 'GET') {
            const input = z.object({ workspacePath: z.string().max(1000).default(''), q: z.string().trim().max(200).default(''),
              start: z.coerce.number().int().min(0).max(10000).default(0), field: z.enum(['title', 'text']).default('title') }).parse(Object.fromEntries(url.searchParams));
            json(response, 200, await confluenceKnowledge.search(input.workspacePath, input.q, input.start, input.field)); return;
          }
          if (action === 'page' && request.method === 'GET') {
            const reference = z.string().min(1).max(2000).parse(url.searchParams.get('reference'));
            json(response, 200, await confluenceKnowledge.read(reference)); return;
          }
          if (action === 'related' && request.method === 'POST') {
            const input = z.object({ text: z.string().max(100000) }).strict().parse(await body(request, 150000));
            json(response, 200, await confluenceKnowledge.related(input.text)); return;
          }
          json(response, 404, { message: 'Confluence 文档接口不存在' }); return;
        }
        if (url.pathname === '/api/agent-runtimes/desktop-accounts' || url.pathname.startsWith('/api/agent-runtimes/desktop-accounts/')) {
          await desktopAccountRoute(request, response, port); return;
        }
        if (url.pathname === '/api/agent-runtimes/cursor-accounts' || url.pathname.startsWith('/api/agent-runtimes/cursor-accounts/')) {
          await accountRoutes.cursor(request, response, port); return;
        }
        if (url.pathname === '/api/agent-runtimes/accounts' || url.pathname.startsWith('/api/agent-runtimes/accounts/')) {
          const provider = url.pathname.split('/')[4];
          if (!accountProviders.includes(provider as AccountProvider)) { json(response, 404, { message: '账号平台不存在' }); return; }
          await accountRoutes[provider as AccountProvider](request, response, port); return;
        }
        if (url.pathname === '/api/agent-runtimes/recovery') {
          if (request.method === 'GET') { json(response, 200, { runs: agentRuntimes.recoveryRuns() }); return; }
          if (request.method === 'POST') {
            z.object({}).strict().parse(await body(request));
            json(response, 200, { runs: await agentRuntimes.reconcileRecovery() }); return;
          }
        }
        if (url.pathname === '/api/agent-runtimes/translate' && request.method === 'POST') {
          const controller = new AbortController();
          const abort = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', abort);
          try { json(response, 200, await agentTranslate.translate(await body(request, 100_000), controller.signal)); }
          finally { response.off('close', abort); }
          return;
        }
        if (url.pathname.startsWith('/api/agent-runtimes/jira-dev/')) {
          const action = url.pathname.slice('/api/agent-runtimes/jira-dev/'.length);
          if (request.method === 'GET' && action === 'automation-previews') {
            const workflow = url.searchParams.get('workflow');
            if (workflow !== 'jira' && workflow !== 'requirement') { json(response, 400, { message: '请选择研发任务类型' }); return; }
            const automation = await sourceBackend.readAutomation();
            const byIssue = new Map<string, JiraDevScanPreview>();
            for (const run of automation.runs) for (const preview of run.jiraDevPreviews || []) {
              if (preview.workflow === workflow && !byIssue.has(preview.issueKey)) byIssue.set(preview.issueKey, preview);
            }
            json(response, 200, { previews: [...byIssue.values()].slice(0, 100), error: automation.lastRun?.jiraDevPreviewError }); return;
          }
          if (request.method === 'GET' && action === 'tasks') { json(response, 200, { tasks: await jiraDev.list() }); return; }
          if (request.method === 'GET' && action === 'connection') { json(response, 200, await jiraDev.connection()); return; }
          if (action === 'sync' && request.method === 'GET') { json(response, 200, await jiraDevSync.status()); return; }
          if (action === 'sync' && request.method === 'POST') { json(response, 200, await jiraDevSync.sync(await body(request))); return; }
          const document = action.match(/^requirement-document\/([0-9a-f-]{36})\/(review|design)$/);
          if (request.method === 'GET' && document) {
            const phase = document[2] === 'review' ? 'review' : 'design';
            const markdown = await jiraDev.requirementDocument(document[1]!, phase);
            response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="requirement-${phase}.md"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            response.end(markdown); return;
          }
          const handlers: Record<string, (input: unknown) => Promise<unknown>> = { 'requirement-prepare': jiraDev.prepareRequirementDocument, issue: jiraDev.readIssue, versions: jiraDev.versions, scan: jiraDev.scan,
            'project-status': jiraDev.projectStatus, preferences: jiraDev.preferences, 'preferences/save': jiraDev.savePreferences,
            prepare: jiraDev.prepare, apply: jiraDev.apply, check: jiraDev.check, start: jiraDev.start, task: jiraDev.task };
          if (request.method === 'POST' && handlers[action]) { json(response, 200, await handlers[action](await body(request))); return; }
          json(response, 404, { message: 'Jira 研发接口不存在' }); return;
        }
        if (url.pathname === '/api/agent-runtimes/jira-fix/resolve' && request.method === 'POST') {
          const input = z.object({ issueKey: jiraReferenceSchema }).strict().parse(await body(request));
          json(response, 200, await jiraFix.resolve(input.issueKey)); return;
        }
        if (url.pathname === '/api/agent-runtimes/jira-fix') {
          if (request.method === 'GET') { json(response, 200, { records: jiraFix.list().map(record => ({ ...record, handoff: jiraFixHandoff.state(record.id) })) }); return; }
          if (request.method === 'POST') { json(response, 202, jiraFix.start(await body(request))); return; }
        }
        const draft = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff\/draft$/);
        if (draft && request.method === 'POST') {
          const controller = new AbortController();
          const abort = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', abort);
          try { json(response, 200, await jiraFixHandoff.generate(draft[1], await body(request), controller.signal)); }
          finally { response.off('close', abort); }
          return;
        }
        const statusChange = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff\/status$/);
        if (statusChange && request.method === 'POST') {
          json(response, 200, await jiraFixHandoff.applyStatus(statusChange[1], await body(request))); return;
        }
        const handoff = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff$/);
        if (handoff) {
          if (request.method === 'GET') { json(response, 200, await jiraFixHandoff.context(handoff[1])); return; }
          if (request.method === 'POST') { json(response, 200, await jiraFixHandoff.submit(handoff[1], await body(request))); return; }
        }
        if (url.pathname === '/api/agent-runtimes/requirement-development') {
          if (request.method === 'GET') { json(response, 200, { records: requirementDevelopment.list() }); return; }
          if (request.method === 'POST') { json(response, 202, await requirementDevelopment.start(await body(request))); return; }
        }
        const removeRequirementRecord = url.pathname.match(/^\/api\/agent-runtimes\/requirement-development\/([0-9a-f-]{36})\/delete$/);
        if (removeRequirementRecord && request.method === 'POST') {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await requirementDevelopment.remove(removeRequirementRecord[1])); return;
        }
        if (url.pathname === '/api/agent-runtimes/delivery-acceptance') {
          if (request.method === 'GET') { json(response, 200, { records: deliveryAcceptance.list() }); return; }
          if (request.method === 'POST') { const saved = await deliveryAcceptance.save(await body(request));
            await agentTeams?.onAcceptance(saved);
            const teamTask = agentTeams?.list().find(task => (task.legacyAcceptanceRecordId || `team:${task.id}`) === saved.recordId);
            if (teamTask && saved.decision === 'accepted') void teamGovernance.drafts.generate(teamTask.id)
              .catch(error => agentTeams?.ledger.recordEvent(teamTask.id, 'workflow.report_blocked', { reason: error instanceof Error ? error.message : String(error) }));
            json(response, 200, saved); return; }
        }
        const requirementProgress = url.pathname.match(/^\/api\/agent-runtimes\/requirement-development\/([0-9a-f-]{36})\/progress(\/import)?$/);
        if (requirementProgress && request.method === 'POST') {
          const [, id, importing] = requirementProgress;
          json(response, 200, importing ? await requirementDevelopment.importProgress(id, await body(request))
            : await requirementDevelopment.updateProgress(id, await body(request))); return;
        }
        if (url.pathname === '/api/agent-runtimes/obsidian/config') {
          if (request.method === 'GET') { json(response, 200, await agentNotes.config()); return; }
          if (request.method === 'POST') {
            const input = z.object({ path: z.string().trim().max(1000) }).strict().parse(await body(request));
            json(response, 200, await agentNotes.configure(input.path)); return;
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/obsidian/folders') {
          json(response, 200, await agentNotes.folders()); return;
        }
        if (url.pathname === '/api/agent-runtimes/obsidian/notes') {
          if (request.method === 'GET') {
            const input = z.object({ q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
            json(response, 200, await agentNotes.search(input.q)); return;
          }
          if (request.method === 'POST') {
            const input = z.object({ filename: z.string().min(1).max(180), content: z.string().min(1).max(256_000), vaultId: z.string().regex(/^[a-f0-9]{16}$/), folder: z.string().max(1000).default('') }).strict().parse(await body(request));
            json(response, 201, await agentNotes.create(input.filename, input.content, input.vaultId, input.folder)); return;
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/obsidian/note') {
          const input = z.object({ reference: z.string().min(1).max(2000) }).parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentNotes.read(input.reference)); return;
        }
        const agentAttachment = url.pathname.match(/^\/api\/agent-runtimes\/attachments\/([0-9a-f-]{36})$/);
        if (request.method === 'GET' && agentAttachment) {
          const item = await agentAttachments.read(agentAttachment[1]);
          response.writeHead(200, { 'Content-Type': item.attachment.mimeType, 'Content-Length': item.content.length,
            ...(isAgentImageAttachment(item.attachment) ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.attachment.name)}` }),
            'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
          response.end(item.content); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/attachments') {
          const input = agentAttachmentUploadSchema.parse(await body(request, maxAgentAttachmentBase64Length + 100_000));
          json(response, 201, await agentAttachments.upload(input)); return;
        }
        const removeAgentAttachment = url.pathname.match(/^\/api\/agent-runtimes\/attachments\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && removeAgentAttachment) {
          z.object({}).strict().parse(await body(request));
          await agentAttachments.remove([removeAgentAttachment[1]]);
          json(response, 200, { deleted: true }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes' && url.searchParams.get('status') === '0') {
          json(response, 200, agentRuntimes.snapshot()); return;
        }
        if (request.method === 'GET' && (url.pathname === '/api/agent-runtimes' || url.pathname === '/api/agent-runtimes/status')) {
          const force = url.searchParams.get('refresh') === '1';
          const statusVersion = agentRuntimes.runtimeStatusVersion();
          const [, codexUsage, savedPlanUsage, cursorUsage, claudeUsage, antigravityUsage] = await Promise.all([
            agentRuntimes.runtimeStatuses(force),
            readCodexUsage(force), readCodexPlanUsage?.(force, String(statusVersion)), readCursorUsage(force), readClaudeUsage(force), readAntigravityUsage(force, String(statusVersion)),
          ]);
          const { apiUsage, ...codexPlanUsage } = codexUsage;
          const status = agentRuntimes.runtimeStatusResult(statusVersion, { codexUsage: savedPlanUsage || codexPlanUsage, apiUsage: apiUsage || {
            available: false,
            checkedAt: codexUsage.checkedAt,
            message: codexUsage.message?.includes('API 密钥') ? '当前 API 密钥未返回可读取的 API 额度' : 'API 额度暂不可用',
          }, cursorUsage, claudeUsage, antigravityUsage });
          json(response, 200, url.pathname.endsWith('/status') ? status : { ...agentRuntimes.snapshot(), ...status }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const currentRevision = agentRuntimes.revision();
          response.write(`id: ${currentRevision}\nevent: ready\ndata: ${JSON.stringify({ revision: currentRevision })}\n\n`);
          const lastRevision = Number(request.headers['last-event-id'] || 0);
          if (Number.isFinite(lastRevision) && lastRevision > 0 && lastRevision < currentRevision) {
            response.write(`id: ${currentRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: currentRevision, recovered: true })}\n\n`);
          }
          const stream = createAgentRuntimeStream((frame) => { if (!response.destroyed) response.write(frame); }, url.searchParams.get('updates') === 'runs');
          const unsubscribe = agentRuntimes.subscribe(stream.update);
          const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
          request.on('close', () => { clearInterval(heartbeat); stream.close(); unsubscribe(); });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/codex-sessions/sync') {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.syncCodexSessions()); return;
        }
        const codexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})$/);
        if (request.method === 'GET' && codexSession) {
          json(response, 200, await agentRuntimes.codexSession(codexSession[1])); return;
        }
        const resumeCodexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})\/resume$/);
        if (request.method === 'POST' && resumeCodexSession) {
          const input = agentResumeSchema.parse(await body(request));
          json(response, 202, await agentRuntimes.resumeCodexSession(resumeCodexSession[1], input.objective, input.model,
            input.reasoningEffort, input.attachmentIds, input.accessMode, input.serviceTier)); return;
        }
        const removeCodexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && removeCodexSession) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.removeCodexSession(removeCodexSession[1])); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/files') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), q: z.string().trim().max(200).default('') })
            .parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentRuntimes.workspaceFiles(input.workspacePath, input.q)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/mentions') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity']),
            q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
          const files = await agentRuntimes.workspaceFiles(input.workspacePath, input.q);
          const skills = input.provider === 'codex' ? await listCodexSkills(files.workspacePath, input.q) : [];
          json(response, 200, { ...files, skills }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/knowledge') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity']),
            q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
          const [files, contents, skills] = await Promise.all([
            agentRuntimes.workspaceFiles(input.workspacePath, input.q),
            agentRuntimes.workspaceKnowledge(input.workspacePath, input.q),
            input.provider === 'codex' ? listCodexSkills(input.workspacePath, input.q) : [],
          ]);
          json(response, 200, { ...files, ...contents, skills }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/branches') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000) }).parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentRuntimes.workspaceBranches(input.workspacePath)); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/models') {
          json(response, 201, await agentRuntimes.addCustomModel(agentCustomModelSchema.parse(await body(request)))); return;
        }
        const agentModel = url.pathname.match(/^\/api\/agent-runtimes\/models\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && agentModel) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.removeCustomModel(agentModel[1])); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/runs') {
          json(response, 202, await agentRuntimes.start(agentStartSchema.parse(await body(request)))); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/conversation-ids/migrate') {
          const input = z.object({ assignments: z.array(z.object({ runId: z.string().uuid(), conversationId: z.string().uuid(),
            codexTurnId: z.string().uuid().optional() }).strict()).min(1).max(100) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.migrateConversationIds(input.assignments)); return;
        }
        const prepareIsolation = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/prepare-isolation$/);
        if (request.method === 'POST' && prepareIsolation) {
          const input = z.object({ preparedWorkspacePath: z.string().trim().min(1).max(1000).optional() }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.prepareConversationIsolation(prepareIsolation[1], input.preparedWorkspacePath)); return;
        }
        const spawnAgentTask = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/spawn$/);
        if (request.method === 'POST' && spawnAgentTask) {
          json(response, 202, await agentRuntimes.spawn(spawnAgentTask[1], agentSpawnSchema.parse(await body(request)))); return;
        }
        const orchestrateAgentTask = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/orchestrate$/);
        if (request.method === 'POST' && orchestrateAgentTask) {
          const input = await body(request) as { templateId?: unknown };
          json(response, 202, input?.templateId === 'engineering' || input?.templateId === 'frontend'
            ? await agentRuntimes.startTeamWorkflow(orchestrateAgentTask[1], agentTeamWorkflowSchema.parse(input))
            : await agentRuntimes.orchestrate(orchestrateAgentTask[1], agentTaskWorkflowSchema.parse(input))); return;
        }
        const decideAgentWorkflow = url.pathname.match(/^\/api\/agent-runtimes\/workflows\/([0-9a-f-]{36})\/decision$/);
        if (request.method === 'POST' && decideAgentWorkflow) {
          const input = agentWorkflowDecisionSchema.parse(await body(request));
          json(response, 200, await agentRuntimes.decideWorkflow(decideAgentWorkflow[1], input.action, input.requestId)); return;
        }
        const downloadAgentFile = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/download-file$/);
        if (request.method === 'GET' && downloadAgentFile) {
          const input = z.object({ path: z.string().min(1).max(2000) }).strict().parse(Object.fromEntries(url.searchParams));
          const file = await agentRuntimes.downloadChangedFile(downloadAgentFile[1], input.path);
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          const stream = createReadStream(file.path);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response); return;
        }
        const openAgentFile = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/open-file$/);
        if (request.method === 'POST' && openAgentFile) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.openChangedFile(openAgentFile[1], input.path)); return;
        }
        const revealAgentFile = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/reveal-file$/);
        if (request.method === 'POST' && revealAgentFile) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.revealChangedFile(revealAgentFile[1], input.path)); return;
        }
        const openAgentFileInBrowser = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/open-browser$/);
        if (request.method === 'POST' && openAgentFileInBrowser) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.openChangedFileInBrowser(openAgentFileInBrowser[1], input.path)); return;
        }
        const agentRun = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/(stop|pause-edit|revise|steer|resume|fork|retry|delete)$/);
        if (request.method === 'POST' && agentRun) {
          const [, id, action] = agentRun;
          if (action === 'delete') { z.object({}).strict().parse(await body(request)); json(response, 200, await agentRuntimes.removeQueuedRun(id)); return; }
          if (action === 'pause-edit') { z.object({}).strict().parse(await body(request)); json(response, 200, await agentRuntimes.pauseForEdit(id)); return; }
          if (action === 'revise') {
            const input = z.object({ objective: z.string().max(200_000), cursorTrustPath: z.string().trim().min(1).max(1000).optional() }).strict().parse(await body(request));
            json(response, 202, await agentRuntimes.revise(id, input.objective, input.cursorTrustPath)); return;
          }
          if (action === 'stop') { z.object({}).strict().parse(await body(request)); json(response, 202, await agentRuntimes.stop(id)); return; }
          if (action === 'steer') { z.object({}).strict().parse(await body(request)); json(response, 202, await agentRuntimes.steer(id)); return; }
          if (action === 'retry') {
            const input = z.object({ cursorTrustPath: z.string().trim().min(1).max(1000).optional(),
              mode: z.enum(['agent', 'plan', 'ask']).optional(), accessMode: agentAccessSchema.optional() }).strict().parse(await body(request));
            json(response, 202, await agentRuntimes.retry(id, input.cursorTrustPath, input)); return;
          }
          if (action === 'fork') {
            const input = agentResumeSchema.parse(await body(request));
            json(response, 202, await agentRuntimes.fork(id, input.objective, input.model, input.reasoningEffort, input.attachmentIds, input.serviceTier)); return;
          }
          const input = agentContinueSchema.parse(await body(request));
          json(response, 202, await agentRuntimes.resume(id, input.objective, input.model, input.reasoningEffort, input.attachmentIds, input.accessMode,
            input.queuePlacement, input.serviceTier, input.mode)); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/conversations/delete-batch') {
          const { targets } = agentConversationDeleteBatchSchema.parse(await body(request));
          json(response, 200, await agentTeams!.removeConversations(targets)); return;
        }
        const agentConversation = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && agentConversation) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentTeams!.removeConversation(agentConversation[1])); return;
        }
        const agentConversationTitle = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/title$/);
        if (request.method === 'POST' && agentConversationTitle) {
          const input = agentConversationTitleSchema.parse(await body(request));
          json(response, 200, await agentRuntimes.updateConversationTitle(agentConversationTitle[1], input.title)); return;
        }
        json(response, 404, { message: 'Agent 执行接口不存在' }); return;
      }
      if (url.pathname.startsWith('/api/design-executor')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '自动执行命令必须来自本机看板' }); return; }
        if (request.method === 'POST' && request.headers['x-delivery-confirmed'] !== 'yes') { json(response, 403, { message: '必须先确认自动执行对 Confluence 和 Jira 的影响' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/design-executor') { json(response, 200, await designExecutor.dashboard()); return; }
        if (request.method === 'POST' && url.pathname === '/api/design-executor/runs') { json(response, 202, await designExecutor.start(await body(request))); return; }
        const execution = url.pathname.match(/^\/api\/design-executor\/runs\/([0-9a-f-]{36})\/(resume|stop|snapshot|desktop|claim|submit)$/);
        if (execution) {
          const [, id, action] = execution;
          if (request.method === 'GET' && action === 'desktop') { json(response, 200, designExecutor.desktop(id)); return; }
          if (request.method === 'POST' && action === 'claim') { json(response, 200, await designExecutor.claim(id, await body(request))); return; }
          if (request.method === 'POST' && action === 'submit') { json(response, 200, await designExecutor.submit(id, await body(request))); return; }
          if (request.method === 'GET' && action === 'snapshot') { json(response, 200, await designExecutor.snapshot(id)); return; }
          if (request.method === 'POST' && action === 'resume') { json(response, 202, await designExecutor.resume(id, await body(request))); return; }
          if (request.method === 'POST' && action === 'stop') { const data = z.object({ revision: z.number().int() }).strict().parse(await body(request)); json(response, 202, await designExecutor.stop(id, data.revision)); return; }
        }
        json(response, 404, { message: '自动执行接口不存在' }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/source/refresh') { json(response, 200, await service.refreshSource()); return; }
      if (url.pathname.startsWith('/api/source/')) { await proxySource(request, response, url, sourceBackend); return; }
      if (sourceBackend.handles(url.pathname)) { await sourceBackend.dispatch(request, response, `${url.pathname}${url.search}`); return; }
      if (request.method === 'GET' && url.pathname === '/api/health') { json(response, 200, { ok: true, app: 'Delivery Workspace', source: 'embedded', labEngine: 'Mastra', labDemoOnly: true, designExecutor: 'Codex desktop session', version: await readWorkspaceVersion() }); return; }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') { json(response, 200, await service.dashboard()); return; }
      if (request.method === 'GET' && url.pathname === '/api/workflow/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const currentRevision = service.revision();
        response.write(`id: ${currentRevision}\nevent: ready\ndata: ${JSON.stringify({ revision: currentRevision })}\n\n`);
        const lastRevision = Number(request.headers['last-event-id'] || 0);
        if (Number.isFinite(lastRevision) && lastRevision > 0 && lastRevision < currentRevision) {
          response.write(`id: ${currentRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: currentRevision, recovered: true })}\n\n`);
        }
        const unsubscribe = service.subscribe((eventRevision) => {
          if (!response.destroyed) response.write(`id: ${eventRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: eventRevision })}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
        request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const data = startSchema.parse(await body(request)); json(response, 202, await service.start(data.requirementId, data.scenario, undefined, data.context)); return;
      }
      const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(?:\/(resume|rework|snapshot))?$/);
      if (match) {
        const [, runId, action] = match;
        if (request.method === 'GET' && !action) { json(response, 200, await service.getRun(runId)); return; }
        if (request.method === 'GET' && action === 'snapshot') { json(response, 200, await service.rawSnapshot(runId)); return; }
        if (request.method === 'POST' && action === 'resume') { const data = resumeSchema.parse(await body(request)); json(response, 202, await service.resume(runId, data.action)); return; }
        if (request.method === 'POST' && action === 'rework') { json(response, 202, await service.rework(runId)); return; }
      }
      json(response, 404, { message: '接口不存在' }); return;
    }
    if (sourceBackend.handles(url.pathname)) { await sourceBackend.dispatch(request, response, `${url.pathname}${url.search}`); return; }
    if (vite) { vite.middlewares(request, response); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(distDirectory, relative || 'index.html');
    if (!file.startsWith(`${distDirectory}${path.sep}`)) { response.writeHead(404); response.end(); return; }
    try {
      const spa = !path.extname(relative);
      const content = await fs.readFile(spa ? path.join(distDirectory, 'index.html') : file);
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': spa ? mime['.html'] : mime[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': workspaceStaticCacheControl(spa ? 'index.html' : relative) }); response.end(content);
    } catch { response.writeHead(404); response.end('Not found'); }
  } catch (error) {
    const status = error && typeof error === 'object' && 'statusCode' in error && [404, 409].includes(Number(error.statusCode)) ? Number(error.statusCode) : 400;
    json(response, status, { message: error instanceof z.ZodError ? '输入格式不正确' : error instanceof Error ? error.message : String(error) });
  } finally {
    if (mutation) pendingMutations--;
  }
});
server.listen(port, '127.0.0.1', () => {
  if (process.env.DELIVERY_SCHEDULER_DISABLED !== '1') sourceBackend.start();
workspaceReports.start();
  if (process.env.DELIVERY_SCHEDULER_DISABLED !== '1') projectWorkspaces.start();
  console.log(`Delivery Workspace: http://localhost:${port} · unified backend · Mastra lab /lab`);
});
let shutdownTask: Promise<void> | undefined;
function shutdown() {
  return shutdownTask ??= (async () => {
  workspaceRestart.close();
    unsubscribeJiraDevRuns(); unsubscribeJiraDevTeams();
    await jiraDevAutomation?.close();
  await projectLaunch.close();
  await projectWorkspaces.close();
  await remoteDelivery.close();
  await systemCatalog.close();
  await interfaceCenter.close();
  server.close(); await workspaceReports.close(); await groupChat?.close(); await refactorControl.close(workspaceRestart.isRestarting()); await refactorWorkspace.close(); await agentTeams?.close(); await teamGovernance.close(); sourceBackend.close(); await Promise.all(Object.values(accountServices).map(accounts => accounts.close())); await stopStateBackup(); await Promise.all([requirementDevelopment.close(), deliveryAcceptance.close(), jiraFix.close(), jiraFixHandoff.close(), jiraDev.close()]); await Promise.all([cliQueue.close(), agentRuntimes.close(), designExecutor.close(), integration.close(), confluenceKnowledge.close(), apexBffReview.close(), wecomIntegration.close(), reportBot.close(), deployments.close(), yunxiaoDeployments.close()]); await vite?.close(); await agentUsage.close(); await service.close(); await stateBackup.close(); await releaseStateLease(); process.exit(0);
  })();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void shutdown(); });

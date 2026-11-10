import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentGroupChat } from '../server/agent-group-chat.js';
import { createJiraDevTaskService } from '../server/jira-dev-tasks.js';
import { createJiraFixService } from '../server/jira-fix.js';
import { createRequirementDevelopmentService } from '../server/requirement-development.js';
import { createJiraFixHandoffService } from '../server/jira-fix-handoff.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { jiraDevNeedsApply } from '../shared/jira-dev.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { GroupMember } from '../shared/agent-group-chat.js';
import type { JiraIssue } from '../shared/hub.js';
import { launchDeliveryRecords, reconcileDeliveryRecords } from '../src/features/workbench/domain.js';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args]);
const waitFor = async <T>(read: () => T, predicate: (value: T) => boolean) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('群聊任务状态超时：' + JSON.stringify(read()));
};
const roles: GroupMember[] = ([['architect-custom', '需求核对', 'read'], ['ui-custom', '页面实现', 'write'], ['qa-custom', '独立测试', 'verify'], ['review-custom', '代码复核', 'review'], ['delivery-custom', '交接整理', 'read']] as const)
  .map(([id, name, capability]) => ({ id, name, capability, enabled: true, instructions: `仅执行${name}职责`, binding: { provider: 'codex', model: 'fixture', reasoningEffort: '' } }));
const requirementReport = '```delivery-report\n' + JSON.stringify({ version: 1, requirementProgress: { issueKeys: ['TEST-123'], stages: Object.fromEntries(
  ['intake', 'tasks', 'design', 'development', 'verification', 'handoff'].map(stage => [stage, { status: 'completed', evidence: `夹具已核验 ${stage}` }])) } }) + '\n```';
const fixReport = '```delivery-report\n' + JSON.stringify({ version: 1, jiraHandoff: { cause: '夹具已定位旧值', impact: '仅夹具 value.txt', suggestion: '核验新值与隔离副本', conclusion: '实际读取夹具新值；未验证业务接口' } }) + '\n```';

async function fixture(options: { gate?: Promise<void>; failReview?: () => boolean; lostReceipt?: boolean; loginRequired?: boolean } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jira-group-'))), origin = path.join(directory, 'origin.git'), project = path.join(directory, 'web');
  await exec('git', ['init', '--bare', '-b', 'master', origin]); await exec('git', ['clone', origin, project]);
  await fs.writeFile(path.join(project, 'value.txt'), 'base'); await git(project, 'add', 'value.txt'); await git(project, 'commit', '-m', 'base'); await git(project, 'push', 'origin', 'HEAD:master');
  await fs.writeFile(path.join(project, 'dirty.txt'), '保留原检出');
  const calls: AgentRun[] = [], preflightPaths: (string[] | undefined)[] = [];
  let group: Awaited<ReturnType<typeof createAgentGroupChat>>, service: Awaited<ReturnType<typeof createJiraDevTaskService>>, lastTaskId = '', starts = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Codex', binary: 'fixture', version: 'fixture', ready: true, authenticated: true,
    message: '', modes: ['ask', 'agent'], accessModes: ['workspace', 'full'], models: [{ id: 'fixture', label: 'fixture' }], defaultModel: 'fixture', writable: true, checkedAt: '' }),
    execute: async ({ run }) => {
      if (run.task?.sourceId?.startsWith('requirement:preparation:')) {
        assert.equal(run.mode, 'ask');
        assert.equal(run.workspacePath, project);
        const stage = run.task.sourceId.includes('-review:') ? '需求评审' : '前端技术方案';
        return '\`\`\`delivery-report' + '\n' + JSON.stringify({ version: 1, requirementDocument: {
          status: 'ready', summary: `完成${stage}`, markdown: `# ${stage}\n\n夹具业务：只改 value.txt。`,
        } }) + '\n\`\`\`';
      }
      calls.push(run);
      if (run.team?.profileId === 'ui-custom') for (const workspace of run.team.workspacePaths || []) await fs.writeFile(path.join(workspace, 'value.txt'), 'changed');
      if (run.team?.profileId === 'qa-custom') for (const workspace of run.team.workspacePaths || []) {
        assert.equal(await fs.readFile(path.join(workspace, 'value.txt'), 'utf8'), 'changed');
        await fs.writeFile(path.join(workspace, 'verification-only.txt'), 'not in task worktree');
        assert.ok(run.objective.includes(workspace));
      }
      if (options.loginRequired && run.team?.profileId === 'qa-custom' && calls.filter(item => item.team?.profileId === 'qa-custom').length === 1) {
        return '```delivery-report\n' + JSON.stringify({ version: 1,
          requirementLogin: { reason: 'session_expired', url: 'http://127.0.0.1:5231/country' },
        }) + '\n```';
      }
      if (run.team?.profileId === 'review-custom' && options.failReview?.()) throw new Error('fixture-review-blocked');
      if (run.team?.profileId === 'delivery-custom') { await options.gate; return group.detail(run.team.taskId).room.source?.workflow === 'jira' ? fixReport : requirementReport; }
      return `实际完成：${run.team?.profileId}`;
    } };
  const runtime = await createAgentRuntimeService(path.join(directory, 'runtime'), { adapters: [adapter] });
  const linkedRuntime = { ...runtime,
    findJiraFix: (id: string) => { const value = group?.jiraExecution(id); return value ? value.run : runtime.findJiraFix(id); },
    findRequirementDevelopment: (id: string) => { const value = group?.jiraExecution(id); return value ? value.run : runtime.findRequirementDevelopment(id); } };
  const source = { readJiraFixIssue: async () => ({ key: 'TEST-123', summary: 'Jira 夹具任务', project: 'TEST', status: '待处理', url: 'https://jira.example.test/browse/TEST-123' } as JiraIssue), readLocalProjects: async () => ({ projects: [] }) as never };
  const fixes = await createJiraFixService(path.join(directory, 'fixes'), linkedRuntime, source, undefined, { groupExecution: id => group?.jiraExecution(id) });
  const requirements = await createRequirementDevelopmentService(path.join(directory, 'requirements'), linkedRuntime, undefined, { groupExecution: id => group?.jiraExecution(id) });
  group = await createAgentGroupChat(path.join(directory, 'runtime'), runtime, { profiles: defaultTeamProfileConfig, onJiraCompleted: id => service.synchronizeGroup(id) });
  await group.saveConfig({ expectedRevision: 1, name: '我的自定义研发组', members: roles });
  const developmentIssue = { key: 'TEST-123', url: 'https://jira.example.test/browse/TEST-123', summary: 'Jira 夹具任务', description: '只修改 value.txt', project: { key: 'TEST' },
    issueType: { name: 'Task', subtask: false }, startDate: '', endDate: '' };
  service = await createJiraDevTaskService({ dataDirectory: path.join(directory, 'jira-dev'), runtime: linkedRuntime,
    jiraClient: async () => ({ readIssue: async () => developmentIssue,
      findRequirementIssues: async () => ({ sourceIssue: developmentIssue, issues: [], truncated: false }),
      connection: async () => ({ site: 'https://jira.example.test', account: { id: 'fixture', name: 'fixture' } }) }) as never,
    sourceIdentity: async () => ({ key: 'TEST-123', url: 'https://jira.example.test/browse/TEST-123' }),
    adoptJiraFix: record => fixes.adopt(record), adoptRequirement: async record => { const result = await requirements.adopt(record); if (record.groupRoomId) await requirements.synchronizeGroup(record.id); return result; },
    preflightGroup: (revision, workspacePath, accessMode, sourceProjectPaths) => {
      preflightPaths.push(sourceProjectPaths);
      return group.preflightJira(revision, workspacePath, accessMode, sourceProjectPaths);
    },
    requirementReader: revision => group.requirementReader(revision),
    startGroup: async input => { starts++; await group.startJira(input); if (options.lostReceipt && starts === 1) throw new Error('fixture lost receipt'); const value = group.jiraExecution(input.source.taskId)!; return { groupRoomId: value.groupRoomId, groupProgress: value.groupProgress, runId: value.run?.id || '' }; },
    findGroup: id => { const value = group.jiraExecution(id); return value ? { groupRoomId: value.groupRoomId, groupProgress: value.groupProgress, runId: value.run?.id || '' } : undefined; },
  });
  async function prepare(workflow: 'jira' | 'requirement', additionalProject?: string) {
    const preview = await service.prepare({ workflow, repairMode: 'direct', sourceKind: 'frontend', source: 'TEST-123', projectPath: project, baseBranch: 'master', branchName: `feature/${workflow}-123`, details: '只修改 value.txt',
      ...(additionalProject ? { projects: [{ path: project, baseBranch: 'master', branchName: 'feature/web-123' }, { path: additionalProject, baseBranch: 'master', branchName: 'feature/api-123' }] } : {}) });
    lastTaskId = preview.taskId;
    if (workflow === 'jira' && jiraDevNeedsApply(preview)) await service.apply({ taskId: preview.taskId, confirmed: true });
    return preview;
  }
  const selection = () => ({ provider: 'codex', model: 'unused-in-group', reasoningEffort: '', collaborationMode: 'group', groupConfigRevision: group.dashboard().config.revision, accessMode: 'full' });
  return { directory, project, origin, runtime, group, service, requirements, fixes, calls, preflightPaths, prepare, selection, starts: () => starts, taskId: () => lastTaskId,
    cleanup: async () => { await group.close(); await service.close(); await fixes.close(); await requirements.close(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('Jira 需求使用自定义团队与全部独立工作区；整组完成后同步阶段报告，首个回复不算完成', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve), f = await fixture({ gate, loginRequired: true });
  try {
    const secondary = path.join(f.directory, 'api'); await exec('git', ['clone', f.origin, secondary]);
    const preview = await f.prepare('requirement', secondary);
    const start = { taskId: preview.taskId, runtime: f.selection(), confirmed: true };
    await assert.rejects(f.service.apply({ taskId: preview.taskId, group: true, confirmed: true }), /先.*需求评审/);
    await assert.rejects(f.service.prepareRequirementDocument({ taskId: start.taskId, runtime: start.runtime, phase: 'design' }), /先.*需求评审/);
    const preparePhase = async (phase: 'review' | 'design') => {
      const value = await f.service.prepareRequirementDocument({ taskId: start.taskId, runtime: start.runtime, phase });
      const runId = value.preparation?.[phase]?.runId;
      assert.ok(runId);
      await waitFor(() => f.runtime.getRun(runId), run => run?.status === 'completed' && run.resultReady !== false);
      const report = (await f.service.task({ taskId: start.taskId })).preparation?.[phase];
      assert.equal(report?.status, 'ready');
      assert.match(await f.service.requirementDocument(start.taskId, phase), /夹具业务：只改 value.txt/);
      assert.equal((await git(f.project, 'worktree', 'list', '--porcelain')).stdout.split('worktree ').length, 2);
    };
    await preparePhase('review');
    if (jiraDevNeedsApply(preview)) await f.service.apply({ taskId: preview.taskId, group: true, confirmed: true });
    await assert.rejects(f.service.start(start), /先.*前端技术方案/);
    await preparePhase('design');
    const started = await f.service.start(start);
    assert.deepEqual(f.preflightPaths.at(-1), [f.project, secondary], '启动前模型检查必须收到全部项目，不能把多仓联调按主仓裁剪');
    assert.ok(started.launch?.groupRoomId); assert.equal(started.launch?.status, 'started');
    const roomId = started.launch!.groupRoomId!;
    const waiting = await waitFor(() => f.group.detail(roomId).room.rounds[0]!, round => round.loginHandoff?.answered === false);
    const blocked = f.group.jiraExecution(preview.taskId);
    assert.equal(blocked?.groupProgress.waitingForLogin, true);
    assert.equal(blocked?.groupProgress.state, 'paused');
    assert.equal(blocked?.run, undefined);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), roles.slice(0, 3).map(role => role.id));
    const login = { roundId: waiting.id, runId: waiting.loginHandoff!.runId, accessMode: 'workspace' as const };
    await assert.rejects(f.group.action(roomId, 'continue'), /完成登录/);
    await Promise.all([f.group.resumeLogin(roomId, login), f.group.resumeLogin(roomId, login)]);
    await waitFor(() => f.calls.length, count => count === 6);
    assert.equal(f.calls[2]!.workspacePath, f.calls[3]!.workspacePath, '只继续原验证副本');
    assert.equal(f.calls[2]!.accessMode, 'full'); assert.equal(f.calls[3]!.accessMode, 'workspace');
    assert.ok(f.calls.slice(3).every(run => run.accessMode === 'workspace'));
    assert.match(f.calls[3]!.teamContext || '', /持续授权.*不逐次要求确认/);
    assert.match(f.calls[3]!.teamContext || '', /已登录，继续验证/);
    assert.ok(f.runtime.getRun(login.runId)?.result.includes('session_expired'), '保留原有验证记录');
    const inProgress = f.requirements.list()[0]!;
    assert.equal(inProgress.runStatus, 'running'); assert.equal(inProgress.runId, ''); assert.equal(inProgress.groupProgress?.completed, 4);
    assert.equal(f.group.detail(roomId).room.source?.issueKey, 'TEST-123'); assert.equal(f.group.detail(roomId).room.source?.projects.length, 2);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['architect-custom', 'ui-custom', 'qa-custom', 'qa-custom', 'review-custom', 'delivery-custom']);
    assert.doesNotMatch(f.group.detail(roomId).room.rounds[0]!.text, /JIRA_DEV_TASK_ID|SKILL.md/);
    assert.match(f.calls[1]!.objective, /JIRA_DEV_TASK_ID/); assert.doesNotMatch(f.calls[1]!.objective, /该主项目 worktree 只作为团队来源/);
    for (const project of started.launch!.projects!) {
      assert.equal(await fs.readFile(path.join(project.workspacePath!, 'value.txt'), 'utf8'), 'changed');
      await assert.rejects(fs.stat(path.join(project.workspacePath!, 'verification-only.txt')));
    }
    assert.equal(await fs.readFile(path.join(f.project, 'value.txt'), 'utf8'), 'base'); assert.equal(await fs.readFile(path.join(f.project, 'dirty.txt'), 'utf8'), '保留原检出');
    const records = reconcileDeliveryRecords(launchDeliveryRecords(f.requirements.list()), [], f.calls, { runtimeKnown: true });
    assert.equal(records[0]!.currentStatus, 'running'); assert.match(records[0]!.detailPath, /group=1&room=/);
    release();
    await waitFor(() => f.requirements.list()[0], record => record?.progress?.source === 'agent-result');
    const complete = await f.service.task({ taskId: preview.taskId });
    assert.equal(complete.launch?.groupProgress?.state, 'completed'); assert.equal(f.requirements.list()[0]?.runId, f.calls.at(-1)?.id);
    const again = await f.service.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true });
    assert.equal(again.launch?.groupRoomId, roomId); assert.equal(f.starts(), 1);
  } finally { release(); await f.cleanup(); }
});

test('Jira 修复失败后复用原群聊和 worktree；最后成员完成前禁止交接，完成后自动读取交接草稿', async () => {
  let failing = true; const f = await fixture({ failReview: () => failing, lostReceipt: true });
  let handoff: Awaited<ReturnType<typeof createJiraFixHandoffService>> | undefined;
  try {
    const preview = await f.prepare('jira'), started = await f.service.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true });
    const roomId = started.launch!.groupRoomId!, workspace = started.launch!.workspacePath;
    await waitFor(() => f.group.jiraExecution(preview.taskId), value => value?.groupProgress.state === 'failed');
    const failed = f.fixes.list()[0]!; assert.equal(failed.runStatus, 'failed'); assert.equal(failed.runId, ''); assert.match(failed.runError!, /fixture-review-blocked/);
    assert.equal(failed.groupProgress?.activeMember, '代码复核');
    const result = reconcileDeliveryRecords(launchDeliveryRecords([], f.fixes.list()), [], f.calls, { runtimeKnown: true }); assert.equal(result[0]?.currentStatus, 'blocked');
    handoff = await createJiraFixHandoffService(path.join(f.directory, 'handoff'), id => {
      const record = f.fixes.list().find(record => record.id === id), execution = f.group.jiraExecution(id);
      return record ? { record, run: execution?.run } : undefined;
    }, { readIssue: async () => ({ key: 'TEST-123', status: { id: 'open', name: '待处理' } }), transitions: async () => [], statuses: async () => [] } as never);
    await assert.rejects(handoff.context(preview.taskId), /尚未结束/);
    await waitFor(() => f.calls.some(run => f.runtime.isRunActive(run.id)), active => !active);
    failing = false; await f.group.action(roomId, 'continue');
    await waitFor(() => f.group.jiraExecution(preview.taskId), value => value?.groupProgress.state === 'completed');
    await f.service.synchronizeGroup(preview.taskId);
    const context = await handoff.context(preview.taskId);
    assert.equal(context.draft?.draft.cause, '夹具已定位旧值');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'ui-custom').length, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'review-custom').length, 2);
    const again = await f.service.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true });
    assert.equal(again.launch?.groupRoomId, roomId); assert.equal(again.launch?.workspacePath, workspace); assert.equal(f.starts(), 1);
  } finally { await handoff?.close(); await f.cleanup(); }
});

test('失效团队版本或缺少实现成员在创建工作区前拒绝，原 Jira 任务和来源检出保持不变', async () => {
  const f = await fixture();
  try {
    const preview = await f.prepare('jira'), selection = f.selection();
    await assert.rejects(f.service.start({ taskId: preview.taskId, runtime: { ...selection, groupConfigRevision: 1 }, confirmed: true }), /重新核对/);
    await assert.rejects(fs.stat(`${f.project}-tasks`));
    await f.group.saveConfig({ expectedRevision: 2, name: '只读组', members: roles.filter(role => role.capability !== 'write') });
    await assert.rejects(f.service.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true }), /没有启用可修改代码/);
    assert.equal(f.group.dashboard().rooms.length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('重载任务和群聊账本后按原关联恢复，不重复创建群聊、工作区或模型运行', async () => {
  const f = await fixture();
  let restoredGroup: Awaited<ReturnType<typeof createAgentGroupChat>> | undefined, restoredService: Awaited<ReturnType<typeof createJiraDevTaskService>> | undefined;
  try {
    const preview = await f.prepare('jira'), started = await f.service.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true });
    await waitFor(() => f.group.jiraExecution(preview.taskId), value => value?.groupProgress.state === 'completed');
    await f.service.synchronizeGroup(preview.taskId); await f.group.close(); await f.service.close();
    const count = f.calls.length;
    restoredGroup = await createAgentGroupChat(path.join(f.directory, 'runtime'), f.runtime, { profiles: defaultTeamProfileConfig });
    restoredService = await createJiraDevTaskService({ dataDirectory: path.join(f.directory, 'jira-dev'), runtime: f.runtime,
      adoptJiraFix: record => f.fixes.adopt(record), adoptRequirement: record => f.requirements.adopt(record),
      findGroup: id => { const value = restoredGroup!.jiraExecution(id); return value ? { groupRoomId: value.groupRoomId, groupProgress: value.groupProgress, runId: value.run?.id || '' } : undefined; } });
    const recovered = await restoredService.start({ taskId: preview.taskId, runtime: f.selection(), confirmed: true });
    assert.equal(recovered.launch?.groupRoomId, started.launch?.groupRoomId); assert.equal(recovered.launch?.workspacePath, started.launch?.workspacePath);
    assert.equal(recovered.launch?.groupProgress?.state, 'completed'); assert.equal(f.calls.length, count);
  } finally { await restoredGroup?.close(); await restoredService?.close(); await f.cleanup(); }
});

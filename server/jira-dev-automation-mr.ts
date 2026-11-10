import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AutomationSettings, JiraIssue } from '../shared/hub.js';
import { resolveAutomationProject } from './jira-backend/automation-project-routing.mjs';
import { inspectTaskWorkspace, repositoryIdentity } from './jira-dev/index.mjs';
import { readProjectGitSnapshot, redact, withProjectGitLock, type ProjectGitSnapshot } from './project-git.js';
import { createProjectMergeRequest, prepareProjectMergeRequest } from './project-merge-request.js';

type Issue = Pick<JiraIssue, 'key' | 'summary' | 'description' | 'project' | 'components' | 'labels' | 'parent'>;
type Policy = Pick<AutomationSettings, 'autoCreateMergeRequest' | 'reviewer' | 'projectProfiles'>;
type Options = { dataDirectory: string; fetcher?: typeof fetch; beforeCreate?: () => Promise<void>; pushVerifiedHead?: boolean };
export type JiraDevMergeRequestResult =
  | { status: 'skipped' | 'blocked'; message: string }
  | { status: 'created' | 'existing'; message: string; url: string };
const exec = promisify(execFile);
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const localArtifact = (file: string, issueKey: string) =>
  file.startsWith('tempdocs/') || file === `docs/requirements/${issueKey}-tech-design.md`;

export function jiraDevAutomationWorkspaceReady(snapshot: Pick<ProjectGitSnapshot, 'files' | 'mergeInProgress' | 'truncated'>, issueKey: string) {
  return !snapshot.mergeInProgress && !snapshot.truncated && snapshot.files.every(file => file.untracked && !file.staged
    && localArtifact(file.path, issueKey));
}

function git(directory: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return exec('git', ['--no-replace-objects', '-C', directory, ...args], { env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}

function matchOrigin(snapshot: ProjectGitSnapshot, repositoryUrl: string) {
  const origin = snapshot.remotes.find(remote => remote.name === 'origin');
  const expected = repositoryIdentity(repositoryUrl)?.repositoryId;
  if (!expected || !origin || repositoryIdentity(origin.url)?.repositoryId !== expected
    || origin.pushUrls.length !== 1 || repositoryIdentity(origin.pushUrls[0]!)?.repositoryId !== expected) {
    throw new Error('来源仓库的 origin 与项目配置不一致，或没有唯一的推送地址。');
  }
  return origin;
}

export async function resolveJiraDevMrProject(issue: Issue, settings: Policy, sourceProjectPath: string) {
  if (!settings.autoCreateMergeRequest) throw new Error('自动创建合并请求未开启。');
  const source = await readProjectGitSnapshot(sourceProjectPath);
  if (!source.isGit || source.directory !== await realpath(sourceProjectPath)) throw new Error('来源目录不是任务仓库的检出根目录。');
  // 新流程要求一条明确的已保存项目配置，不能回退到旧队列的全局仓库。
  const routing = resolveAutomationProject(issue, [], { projectProfiles: settings.projectProfiles ?? [] },
    { path: source.directory, remoteUrl: source.remotes.find(remote => remote.name === 'origin')?.url });
  if (routing.status !== 'matched' || !routing.profile) throw new Error(routing.reason);
  const reviewer = settings.reviewer.trim();
  if (!reviewer) throw new Error('请在策略设置中配置合并请求审核人。');
  if (matchOrigin(source, routing.profile.repositoryUrl).provider !== 'Codeup') {
    throw new Error('当前自动创建合并请求仅支持 Codeup，请在代码平台处理此任务。');
  }
  return { profile: routing.profile, reviewer };
}

async function publishVerifiedHead(snapshot: ProjectGitSnapshot, targetBranch: string, checkAuthorization: () => Promise<void>) {
  return withProjectGitLock(snapshot.directory, async () => {
    const run = (args: string[]) => git(snapshot.directory, args);
    const sourceRef = `refs/heads/${snapshot.branch}`, targetRef = `refs/heads/${targetBranch}`;
    if (sourceRef === targetRef) throw new Error('任务分支与 MR 目标分支相同。');
    await run(['check-ref-format', targetRef]).catch(() => { throw new Error('MR 目标分支格式不正确。'); });
    async function readRefs() {
      const { stdout } = await run(['ls-remote', '--heads', 'origin', sourceRef, targetRef])
        .catch(() => { throw new Error('无法回读 origin 分支，请核对网络和仓库权限。'); });
      return new Map(stdout.split('\n').map(line => {
        const [head, ref] = line.split('\t');
        return [ref, head];
      }));
    }
    const refs = await readRefs(), sourceHead = refs.get(sourceRef), targetHead = refs.get(targetRef);
    if (!targetHead || !sha.test(targetHead)) throw new Error('MR 目标分支在 origin 中不存在或无法核对。');
    if (sourceHead === snapshot.head) return false;
    if (sourceHead && (!sha.test(sourceHead) || !await run(['merge-base', '--is-ancestor', sourceHead, snapshot.head]).then(() => true, () => false))) {
      throw new Error('远端任务分支已分叉或无法验证快进关系，请先核对分支。');
    }
    if (targetHead === snapshot.head || await run(['merge-base', '--is-ancestor', snapshot.head, targetHead]).then(() => true, () => false)) {
      throw new Error('目标分支已包含任务提交，无需推送或创建合并请求。');
    }
    if ((await readProjectGitSnapshot(snapshot.directory)).revision !== snapshot.revision) {
      throw new Error('任务工作区或 origin 配置已变化，已停止推送。');
    }
    await checkAuthorization();
    await run(['push', '--no-force', '--no-mirror', '--no-follow-tags', '--porcelain', 'origin', `${snapshot.head}:${sourceRef}`])
      .catch(() => { /* 即使连接中断，远端也可能收到提交。统一只读回查。 */ });
    const confirmed = await readRefs().catch(() => undefined);
    if (!confirmed) throw new Error('任务分支推送结果待核对，请先读取远端分支再处理 MR。');
    if (confirmed.get(sourceRef) !== snapshot.head) throw new Error('远端任务分支未指向已验证提交，请核对推送权限和分支状态。');
    return true;
  });
}

export async function deliverJiraDevMergeRequest(input: {
  issue: Issue; settings: Policy; sourceProjectPath: string; workspacePath: string;
  branchName: string; baseSha: string; verifiedHead: string;
}, options: Options): Promise<JiraDevMergeRequestResult> {
  if (!input.settings.autoCreateMergeRequest) return { status: 'skipped', message: '自动创建合并请求未开启。' };
  let pushed = false;
  try {
    const { issue, settings, sourceProjectPath, workspacePath, branchName, baseSha, verifiedHead } = input;
    if (!sha.test(verifiedHead)) throw new Error('缺少当前成功运行所验证的提交 SHA。');
    if (verifiedHead === baseSha) throw new Error('任务分支没有独立提交，请先按任务范围提交并验证。');
    const { profile, reviewer } = await resolveJiraDevMrProject(issue, settings, sourceProjectPath);
    const workspace = await inspectTaskWorkspace({ projectPath: workspacePath, sourceProjectPath, branchName, baseSha });
    async function verifiedSnapshot() {
      const snapshot = await readProjectGitSnapshot(workspace.workspacePath);
      if (!snapshot.isGit || snapshot.directory !== workspace.workspacePath || snapshot.branch !== branchName
        || snapshot.head !== verifiedHead || !jiraDevAutomationWorkspaceReady(snapshot, issue.key)) {
        throw new Error('任务工作区、分支或改动与已验证提交不一致，请核对后重新验证。');
      }
      matchOrigin(snapshot, profile.repositoryUrl);
      return snapshot;
    }
    let snapshot = await verifiedSnapshot();
    const diff = await git(snapshot.directory, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '-z', baseSha, verifiedHead, '--'])
      .catch(() => { throw new Error('无法核对已验证提交的任务改动。'); });
    const files = diff.stdout.split('\0').filter(Boolean);
    if (!files.length) throw new Error('任务提交没有可交付的代码改动。');
    if (files.some(file => file === 'tempdocs' || localArtifact(file, issue.key))) {
      throw new Error('已验证提交包含本地交付产物，请核对提交范围后重新验证。');
    }
    if (options.pushVerifiedHead) {
      if (!options.beforeCreate) throw new Error('缺少本次任务的推送授权核对。');
      pushed = await publishVerifiedHead(snapshot, profile.targetBranch, options.beforeCreate);
      if (pushed) snapshot = await verifiedSnapshot();
    }
    const request = {
      path: snapshot.directory, remote: 'origin', sourceBranch: branchName, targetBranch: profile.targetBranch,
      revision: snapshot.revision,
      title: `${issue.key}: ${issue.summary}`.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256),
      description: `关联 Jira：${issue.key}\n\n已验证并回读的源提交：${verifiedHead}`,
    };
    const prepared = await prepareProjectMergeRequest(request, options);
    if (!prepared.canCreate && !prepared.existing) throw new Error(prepared.reason || '无法创建合并请求，请检查远端设置。');
    const result = await createProjectMergeRequest({
      ...request, expectedSourceSha: verifiedHead, expectedTargetSha: prepared.targetSha,
    }, { ...options, reviewer });
    return result.created
      ? { status: 'created', message: '已创建合并请求并回读审核人。', url: result.request.url }
      : { status: 'existing', message: '已复用相同源分支和目标分支的合并请求，保留原审核设置。', url: result.request.url };
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : '无法核对合并请求。').slice(0, 800);
    return { status: 'blocked', message: pushed ? `已推送并回读任务提交。${detail}` : detail };
  }
}

/**
 * 设计说明：本模块是 Delivery 与本机 Agent CLI 之间的受控适配层。
 * 它开放受限工作区写入、用户显式选择的完全访问、只读 plan/ask 模式、精确会话恢复和进程停止；
 * 不同会话可并行执行，同一会话内的连续消息保持串行；共享 Git 工作区运行中禁止切换分支；
 * 现有自动交付队列继续独立运行，不接受任意 CLI 参数透传。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deliveryOutputPaths, readDeliveryReport } from '../shared/delivery-report.js';
import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { canSchedule, type SchedulerJob } from './agent-scheduler.js';
import { extractAgentUsage, emptyAgentUsage } from './agent-usage.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { cliBinary, codexChildEnvironment, cursorBinary, claudeBinary, claudeChildEnvironment, kiroBinary, antigravityBinary } from './cli-runtime.js';
import { forkCodexThread, runCodexLiveTurn, type LiveSteer } from './codex-live-turn.js';
import { prepareAgentBrowserRuntime } from './agent-browser-runtime.js';
import { openCursorEditor } from './cursor-desktop.mjs';
import { codexSessionErrorText } from '../shared/codex-session-error.js';
import { createCodexModelReader, requestCodexModels } from './codex-models.js';
import { claudeDefaultModel, requestClaudeModels } from './claude-models.js';
import { createCodexSessionSource, type CodexSessionSource } from './codex-session-source.js';
import { checkAgentRecovery } from './agent-recovery.js';
import { CodexDesktopTurnUnconfirmedError, readCodexDesktopSnapshot } from './codex-desktop-turn.js';
import type { createStateBackupStore } from './state-backup.js';
import { resolveRenamedWorkspace } from './generated-workspace.js';
import { createWorkspaceProjectResolver } from './workspace-project.js';
import type { ResolvedAgentAttachment } from './agent-attachments.js';
import { canContinueStoppedCodexRun, isAgentImageAttachment } from '../shared/agent-runtime.js';
import { createKiroAdapter } from './kiro-runtime.js';
import { createAntigravityAdapter } from './antigravity-runtime.js';
import { createApiModelAdapter, normalizeApiBaseUrl } from './api-model-runtime.js';
import { createGrokAdapter, normalizeGrokBaseUrl } from './grok-runtime.js';
import { createDeepseekAdapter, normalizeDeepseekBaseUrl } from './deepseek-runtime.js';
import { createWorkbuddyAdapter } from './workbuddy-runtime.js';
import { prepareClaudeInput } from './claude-input.js';
import { saveAgentUserContext, removeAgentUserContext, type AgentUserInput } from './agent-user-context.js';
import { agentRoleProfiles, agentTeamTemplates, codexFallbackFor, reviewChoiceFor, type AgentModelChoice } from '../shared/agent-roles.js';
import {
  applyWorkflowDecision, evaluateWorkflow, evaluateWorkflowStep, implementationProfile, workflowRuns, workflowStageLabels,
  type AgentWorkflowNextStep, type AgentWorkflowRecord,
} from '../shared/agent-workflow.js';
import { buildWorkflowContext, changedPathsOf, localWorkflowWorkspace, writeReviewMaterials, type AgentWorkflowWorkspace } from './agent-workflow.js';
import type {
  AgentTaskRole, AgentAccessMode, AgentAttachment, AgentChangedFile, AgentContinuation, AgentConversationDeleteResult, AgentConversationDeleteTarget, AgentCustomModelInput, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentServiceTier, AgentRun, AgentRunEvent, AgentRunMode,
  AgentKnowledgeMatch, AgentRuntimeDashboard, AgentRuntimeHealth, AgentTaskLink, AgentWorkspaceBranches, CodexSessionDetail, CodexSessionSummary, CodexSyncState,
  SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput, AgentProfileId, AgentTeamTemplateId, AgentWorkflowAction,
  AgentWorkflowStage, AgentWorkspaceVersion, AgentUsageLimits,
} from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const sessionPattern = /^[A-Za-z0-9_-]{8,200}$/;
const codexTurnPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const activeStatuses = new Set(['queued', 'running']);
const providerNames: Record<AgentProvider, string> = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code', kiro: 'Kiro', antigravity: 'Antigravity', api: '模型 API', deepseek: 'DeepSeek', workbuddy: 'WorkBuddy', grok: 'Grok' };
function compareConversationLatest(left: AgentRun, right: AgentRun) {
  const priority = (run: AgentRun) => run.status === 'running' ? 2 : run.status === 'queued' ? 1 : 0;
  return priority(right) - priority(left)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || Date.parse(right.createdAt) - Date.parse(left.createdAt);
}
const codexEfforts: AgentReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const cursorFallbackModels = [
  { id: '', label: 'Cursor 默认（Auto）' },
  { id: 'auto', label: 'Auto' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'sonnet-4-thinking', label: 'Sonnet 4 Thinking' },
];

interface ExecutionContext {
  onUsage?(event: unknown): void;
  run: AgentRun;
  resumeSessionId?: string;
  continueOriginal?: boolean;
  forkSessionId?: string;
  forkLastTurnId?: string;
  imagePaths: string[];
  fileAttachments: { name: string; path: string }[];
  attachmentDirectory?: string;
  attachmentReadDirectories?: string[];
  signal: AbortSignal;
  onPid(pid: number): void | Promise<void>;
  onSession(sessionId: string): void | Promise<void>;
  onBeforeTurn?(): void | Promise<void>;
  onTurn?(turnId: string): void | Promise<void>;
  onEvent(type: AgentRunEvent['type'], message: string): void;
  onOutput?(text: string): void;
  onSteer?(steer: LiveSteer | undefined): void;
}

interface PendingAgentRun {
  adapter: AgentRuntimeAdapter;
  resumeSessionId: string;
  continueOriginal?: boolean;
  forkSessionId: string;
  forkLastTurnId: string;
  imagePaths: string[];
  fileAttachments: { name: string; path: string }[];
  queuePlacement: AgentQueuePlacement;
  queueKey: string;
}

export interface AgentRuntimeAdapter {
  id: AgentProvider;
  health(force?: boolean): Promise<AgentRuntimeHealth>;
  execute(context: ExecutionContext): Promise<string>;
}

interface WorkspaceIdentity {
  workspacePath: string;
  branch: string;
  headSha: string;
}

interface IsolatedWorkspaceIdentity extends WorkspaceIdentity {
  sourceWorkspacePath: string;
  baseBranch: string;
  isolatedWorkspace: boolean;
}

interface ServiceOptions {
  /** 工作台根目录；浏览器登录状态保存在本机私有数据目录。 */
  browserRootDirectory?: string;
  onFinalized?: (run: AgentRun) => Promise<void> | void;
  /** 宿主持续写入的状态和日志目录；只排除当前工作区内部的子目录。 */
  workspaceSnapshotExclusions?: string[];
  stateBackup?: Awaited<ReturnType<typeof createStateBackupStore>>;
  resolveKnowledge?: (objective: string) => Promise<string>;
  adapters?: AgentRuntimeAdapter[];
  /** 指定测试/嵌入适配器时，按需加入内置 API 执行器。 */
  apiModels?: boolean;
  resolveWorkspace?: (workspacePath: string) => Promise<WorkspaceIdentity>;
  switchWorkspaceBranch?: (workspacePath: string, branch: string) => Promise<WorkspaceIdentity>;
  createIsolatedWorkspace?: (workspacePath: string, branch: string, workspaceId: string,
    branchPrefix?: 'codex/' | 'feature/') => Promise<IsolatedWorkspaceIdentity>;
  forkCodexThread?: typeof forkCodexThread;
  codexSessionSource?: CodexSessionSource;
  readCodexDesktopSnapshot?: typeof readCodexDesktopSnapshot;
  resolveAttachments?: (ids: string[]) => Promise<ResolvedAgentAttachment[]>;
  removeAttachments?: (ids: string[]) => Promise<void>;
  openBrowserFile?: (filePath: string) => Promise<void>;
  /** 团队流程的版本标识、验证副本与 diff；测试可替换为内存实现。 */
  workflowWorkspace?: AgentWorkflowWorkspace;
  /** 读取执行器账户额度；团队流程据此判断 Claude 额度是否用尽。 */
  readProviderUsage?: Partial<Record<AgentProvider, () => Promise<AgentUsageLimits>>>;
}

type AgentRuntimeSubscriber = (revision: number, run?: AgentRun, finalized?: boolean) => void;

interface StoredCustomModel extends AgentCustomModelInput {
  id: string;
  createdAt: string;
}

interface StoredCodexSessions {
  syncedAt: string;
  sessions: CodexSessionSummary[];
  details?: Record<string, CodexSessionDetail>;
}

interface GitWorkspaceFileState {
  status: AgentChangedFile['status'];
  fingerprint: string;
}

const ignoredWorkspaceDirectories = new Set(['.git', '.delivery-artifacts', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt']);
const knowledgeTextExtensions = new Set([
  '.c', '.conf', '.cpp', '.css', '.go', '.graphql', '.gql', '.h', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md', '.mjs',
  '.php', '.properties', '.proto', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const knowledgeTextNames = new Set(['dockerfile', 'makefile', 'readme', 'license', 'agents.md', '.editorconfig', '.gitignore', '.gitmessage']);
const sensitiveKnowledgeFile = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|id_rsa$|id_ed25519$)|(?:secret|credential|private[-_.]?key|access[-_.]?token)/i;

export interface GitWorkspaceSnapshot {
  headSha: string;
  files: Record<string, GitWorkspaceFileState>;
}

function cleanText(value: unknown, limit = 12_000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit) : '';
}

function storedAttachments(value: unknown): AgentAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AgentAttachment => !!item && typeof item === 'object'
    && /^[0-9a-f-]{36}$/.test(String(item.id))
    && typeof item.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)
    && typeof item.name === 'string' && Number.isInteger(item.size) && item.size > 0)
    .slice(0, 6).map((item) => ({ id: item.id, name: cleanText(item.name, 200), mimeType: item.mimeType,
      size: item.size, url: `/api/agent-runtimes/attachments/${item.id}` }));
}

function storedChangedFiles(value: unknown): AgentChangedFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is AgentChangedFile => !!item && typeof item === 'object'
    && typeof item.path === 'string' && item.path.length > 0 && item.path.length <= 1000
    && ['added', 'modified', 'deleted', 'renamed', 'generated'].includes(String(item.status)))
    .slice(0, 300).map((item) => ({ path: item.path, status: item.status }));
}

const profileIds = new Set<AgentProfileId>(['engineer', 'frontend', 'verifier', 'reviewer']);
const workflowStages = new Set<AgentWorkflowStage>(['implement', 'verify', 'review']);

function storedWorkflowLink(value: unknown): AgentTaskLink['workflow'] {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as NonNullable<AgentTaskLink['workflow']>;
  if (!/^[0-9a-f-]{36}$/.test(String(input.id)) || !(input.templateId in agentTeamTemplates) || !workflowStages.has(input.stage)
    || !Number.isInteger(input.round) || input.round < 0 || !Number.isInteger(input.step) || input.step < 1) return undefined;
  return { id: input.id, templateId: input.templateId, stage: input.stage, round: input.round, step: input.step };
}

function storedTask(value: unknown): AgentTaskLink | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<AgentTaskLink>;
  if (!cleanText(input.parentConversationId, 200) || !['worker', 'verifier', 'reviewer'].includes(String(input.role))
    || !['manual', 'workflow', 'automation'].includes(String(input.source))) return undefined;
  const workflow = storedWorkflowLink(input.workflow);
  return {
    ...(input.profileId && profileIds.has(input.profileId) ? { profileId: input.profileId } : {}),
    ...(workflow ? { workflow } : {}),
    parentConversationId: cleanText(input.parentConversationId, 200),
    dependsOnConversationIds: Array.isArray(input.dependsOnConversationIds)
      ? [...new Set(input.dependsOnConversationIds.map((item) => cleanText(item, 200)).filter(Boolean))].slice(0, 12) : [],
    role: input.role as AgentTaskLink['role'],
    title: cleanText(input.title, 200) || '并行任务',
    source: input.source as AgentTaskLink['source'],
    ...(cleanText(input.sourceId, 200) ? { sourceId: cleanText(input.sourceId, 200) } : {}),
  };
}

/** Reject a dependency edge that would leave an Agent task graph waiting on itself. */
export function hasAgentTaskDependencyCycle(parentConversationId: string, dependencyIds: string[], resolve: (conversationId: string) => Pick<AgentRun, 'task'> | undefined) {
  const reachesParent = (conversationId: string, visited: Set<string>): boolean => {
    if (conversationId === parentConversationId) return true;
    if (visited.has(conversationId)) return false;
    const task = resolve(conversationId)?.task;
    if (!task) return false;
    const nextVisited = new Set(visited).add(conversationId);
    return task.dependsOnConversationIds.some((dependencyId) => reachesParent(dependencyId, nextVisited));
  };
  return dependencyIds.some((conversationId) => reachesParent(conversationId, new Set()));
}

function gitFileStatus(code: string): AgentChangedFile['status'] {
  if (code.includes('R') || code.includes('C')) return 'renamed';
  if (code === '??' || code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

async function fileFingerprint(workspacePath: string, relativePath: string) {
  try {
    const target = path.resolve(workspacePath, relativePath);
    if (target !== workspacePath && !target.startsWith(`${workspacePath}${path.sep}`)) return '';
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return `link:${await fs.readlink(target)}`;
    if (!stat.isFile()) return `type:${stat.mode}`;
    return createHash('sha1').update(await fs.readFile(target)).digest('hex');
  } catch { return ''; }
}

async function plainWorkspaceFiles(workspacePath: string, limit = 20_000, excludedDirectories: string[] = []) {
  const files: string[] = [];
  const pending = [''];
  while (pending.length && files.length < limit) {
    const relativeDirectory = pending.pop()!;
    const directory = path.join(workspacePath, relativeDirectory);
    let entries: Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolute = path.resolve(workspacePath, relativePath);
      if (excludedDirectories.some(root => absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`))) continue;
      if (entry.isDirectory()) {
        if (!ignoredWorkspaceDirectories.has(entry.name)) pending.push(relativePath);
      } else if (entry.isFile()) files.push(relativePath.split(path.sep).join('/'));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function searchableKnowledgeFile(relativePath: string) {
  if (sensitiveKnowledgeFile.test(relativePath)) return false;
  const basename = path.basename(relativePath).toLowerCase();
  return knowledgeTextNames.has(basename) || knowledgeTextExtensions.has(path.extname(basename));
}

function knowledgeExcerpt(line: string, matchIndex: number) {
  const normalized = line.trim();
  const adjustedIndex = Math.max(0, matchIndex - (line.length - line.trimStart().length));
  const start = Math.max(0, adjustedIndex - 80);
  const excerpt = normalized.slice(start, start + 240);
  return `${start ? '…' : ''}${excerpt}${normalized.length > start + excerpt.length ? '…' : ''}`;
}

async function searchWorkspaceContents(workspacePath: string, files: string[], query: string) {
  const matches: AgentKnowledgeMatch[] = [];
  const term = query.toLocaleLowerCase();
  let scannedFiles = 0;
  let scannedBytes = 0;
  const candidates = files.filter(searchableKnowledgeFile);
  for (const relativePath of candidates) {
    if (matches.length >= 40 || scannedFiles >= 1500 || scannedBytes >= 8_000_000) break;
    const target = path.resolve(workspacePath, relativePath);
    if (target !== workspacePath && !target.startsWith(`${workspacePath}${path.sep}`)) continue;
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000 || scannedBytes + stat.size > 8_000_000) continue;
      const content = await fs.readFile(target);
      scannedFiles += 1;
      scannedBytes += content.length;
      if (content.includes(0)) continue;
      const lines = content.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < 40; index += 1) {
        const matchIndex = lines[index].toLocaleLowerCase().indexOf(term);
        if (matchIndex >= 0) matches.push({ path: relativePath, line: index + 1, excerpt: knowledgeExcerpt(lines[index], matchIndex) });
      }
    } catch { /* Files can change while a search is running. */ }
  }
  return { matches, scannedFiles, truncated: candidates.length > scannedFiles || matches.length >= 40 };
}

async function searchGitWorkspaceContents(workspacePath: string, files: string[], query: string) {
  const searchable = new Set(files.filter(searchableKnowledgeFile));
  try {
    const output = await exec('git', ['-C', workspacePath, 'grep', '-n', '-z', '-I', '-i', '-F', '-e', query, '--'],
      { timeout: 10_000, maxBuffer: 2_000_000 });
    const allMatches = Array.from(output.stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)\n?/g))
      .map((match) => ({ path: match[1], line: Number(match[2]), excerpt: knowledgeExcerpt(match[3], match[3].toLocaleLowerCase().indexOf(query.toLocaleLowerCase())) }))
      .filter((match) => searchable.has(match.path));
    return { matches: allMatches.slice(0, 40), scannedFiles: searchable.size, truncated: allMatches.length > 40 };
  } catch (reason) {
    if ((reason as { code?: number }).code === 1) return { matches: [], scannedFiles: searchable.size, truncated: false };
    return searchWorkspaceContents(workspacePath, files, query);
  }
}

async function snapshotPlainWorkspace(workspacePath: string, excludedDirectories: string[] = []): Promise<GitWorkspaceSnapshot> {
  const files: Record<string, GitWorkspaceFileState> = {};
  for (const relativePath of await plainWorkspaceFiles(workspacePath, 20_000, excludedDirectories)) {
    try {
      const stat = await fs.stat(path.join(workspacePath, relativePath));
      files[relativePath] = { status: 'modified', fingerprint: `${stat.size}:${stat.mtimeMs}` };
    } catch { /* Files may disappear while the Agent is running. */ }
  }
  return { headSha: '', files };
}

function childSnapshotExclusions(workspacePath: string, directories: string[]) {
  return directories.map(root => path.resolve(root)).filter(root => root.startsWith(`${path.resolve(workspacePath)}${path.sep}`));
}

export async function snapshotGitWorkspace(workspacePath: string, excludedDirectories: string[] = []): Promise<GitWorkspaceSnapshot> {
  // 隔离 worktree 本身可能位于数据目录内，只排除工作区内部的数据子目录。
  excludedDirectories = childSnapshotExclusions(workspacePath, excludedDirectories);
  try {
    if (!(await fs.stat(workspacePath)).isDirectory()) return { headSha: '', files: {} };
    const [head, status] = await Promise.all([
      exec('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], { timeout: 5000, maxBuffer: 100_000 }),
      exec('git', ['-C', workspacePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 5000, maxBuffer: 2_000_000 }),
    ]);
    const entries = status.stdout.split('\0');
    const files: Record<string, GitWorkspaceFileState> = {};
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const relativePath = entry.slice(3);
      if (!relativePath || relativePath === '.delivery-artifacts' || relativePath.startsWith('.delivery-artifacts/')) continue;
      const absolute = path.resolve(workspacePath, relativePath);
      const excluded = excludedDirectories.some(root => absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`));
      if (!excluded) files[relativePath] = { status: gitFileStatus(code), fingerprint: await fileFingerprint(workspacePath, relativePath) };
      if (code.includes('R') || code.includes('C')) index += 1;
    }
    return { headSha: head.stdout.trim(), files };
  } catch {
    try { return await snapshotPlainWorkspace(workspacePath, excludedDirectories); }
    catch { return { headSha: '', files: {} }; }
  }
}

export async function jiraDevVerificationFingerprint(workspacePath: string, issueKey: string) {
  const { headSha, files } = await snapshotGitWorkspace(workspacePath);
  if (!headSha) throw new Error('无法读取验证工作区的 Git 版本。');
  const entries = await Promise.all(Object.keys(files).sort()
    .filter(file => !file.startsWith('tempdocs/') && file !== `docs/requirements/${issueKey}-tech-design.md`)
    .map(async file => {
      const mode = await fs.lstat(path.join(workspacePath, file)).then(stat => stat.mode, () => 0);
      return [file, mode, files[file]!.fingerprint];
    }));
  return createHash('sha256').update(JSON.stringify([headSha, entries])).digest('hex');
}

async function captureJiraDevVerification(run: AgentRun) {
  run.jiraDevVerification = undefined;
  if (run.status !== 'completed' || !run.result.includes('"jiraDevDelivery"')) return;
  try {
    const report = readDeliveryReport(run.result, true) as { jiraDevDelivery?: { issueKey?: string; status?: string } };
    const proof = report?.jiraDevDelivery;
    if (!proof?.issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(proof.issueKey) || proof.status !== 'passed') return;
    const paths = run.team?.workspacePaths?.length ? run.team.workspacePaths : [run.workspacePath];
    run.jiraDevVerification = await Promise.all(paths.map(directory => jiraDevVerificationFingerprint(directory, proof.issueKey!)));
  } catch { /* 结果可继续交接，但无有效版本证据时不能自动交付。 */ }
}

export async function changedFilesSince(workspacePath: string, before: GitWorkspaceSnapshot, excludedDirectories: string[] = []): Promise<AgentChangedFile[]> {
  excludedDirectories = childSnapshotExclusions(workspacePath, excludedDirectories);
  const after = await snapshotGitWorkspace(workspacePath, excludedDirectories);
  const changed = new Map<string, AgentChangedFile['status']>();
  for (const relativePath of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const previous = before.files[relativePath];
    const current = after.files[relativePath];
    if (!previous || !current || previous.status !== current.status || previous.fingerprint !== current.fingerprint) {
      changed.set(relativePath, !previous ? 'added' : !current ? 'deleted' : current.status);
    }
  }
  if (before.headSha && after.headSha && before.headSha !== after.headSha) {
    try {
      const diff = await exec('git', ['-C', workspacePath, 'diff', '--name-status', '--find-renames', before.headSha, after.headSha],
        { timeout: 5000, maxBuffer: 2_000_000 });
      for (const line of diff.stdout.split(/\r?\n/).filter(Boolean)) {
        const [code, ...paths] = line.split('\t');
        const relativePath = paths.at(-1);
        if (relativePath) changed.set(relativePath, gitFileStatus(code));
      }
    } catch { /* Dirty workspace evidence remains available when the commit diff cannot be read. */ }
  }
  return [...changed.entries()].filter(([relativePath]) => {
    const absolute = path.resolve(workspacePath, relativePath);
    return !excludedDirectories.some(root => absolute === root || absolute.startsWith(`${root}${path.sep}`));
  }).map(([relativePath, status]) => ({ path: relativePath, status }))
    .sort((left, right) => left.path.localeCompare(right.path)).slice(0, 300);
}

export async function resultArtifactFiles(workspacePath: string, result: string): Promise<AgentChangedFile[]> {
  const candidates = [
    ...[...result.matchAll(/\]\(<?(\/[^)>\r\n]+)>?\)/g)].map(match => ({ value: match[1], structured: false })),
    ...deliveryOutputPaths(result).map(value => ({ value, structured: true })),
  ];
  const workspace = await fs.realpath(workspacePath).catch(() => workspacePath);
  const files = new Map<string, AgentChangedFile>();
  for (const candidate of candidates) {
    let decoded = candidate.value;
    if (!candidate.structured) {
      try { decoded = decodeURIComponent(decoded); } catch { /* Keep the original local path. */ }
    }
    const targets = candidate.structured ? [path.resolve(workspace, decoded)] : [decoded, decoded.replace(/:\d+(?::\d+)?$/, '')];
    for (const localPath of new Set(targets)) {
      try {
        const target = await fs.realpath(localPath);
        if (candidate.structured && !target.startsWith(`${workspace}${path.sep}`)) continue;
        if (!(await fs.stat(target)).isFile()) continue;
        const relativePath = path.relative(workspace, target);
        const displayPath = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
          ? relativePath : path.normalize(localPath);
        files.set(displayPath, { path: displayPath, status: 'generated' });
        break;
      } catch { /* A stale or non-file link is not a local artifact. */ }
    }
  }
  return [...files.values()].slice(0, 300);
}

function mergeChangedFiles(primary: AgentChangedFile[], generated: AgentChangedFile[]) {
  const files = new Map(primary.map((file) => [file.path, file]));
  for (const file of generated) if (!files.has(file.path)) files.set(file.path, file);
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path)).slice(0, 300);
}

/** CLI 额度或速率限制的常见表述；命中时错误信息使用稳定前缀，供团队流程判断是否切换执行器。 */
const quotaDiagnostic = /usage limit|limit reached|hit your (?:\w+ )?limit|out of (?:extra )?usage|rate[_ ]?limit|quota|credit balance|insufficient (?:credits|funds)|(?:used|exhausted) all (?:your )?(?:credits|requests)|(?:spending|spend) limit|too many requests|\b429\b/i;
export const agentQuotaExhaustedText = '额度已用尽';
export function isAgentQuotaDiagnostic(diagnostic: string) { return quotaDiagnostic.test(diagnostic); }
export function isAgentQuotaExhaustedError(message: string) { return message.includes(agentQuotaExhaustedText); }

export function isAgentSessionBusyDiagnostic(diagnostic: string) {
  return /session.*(?:in use|locked|busy|active|in progress)|thread.*(?:in use|locked|busy|active|in progress)|active turn|already running/i.test(diagnostic);
}

export function agentCliFailureMessage(provider: AgentProvider, code: number | null, diagnostic: string) {
  const prefix = `${providerNames[provider]} CLI 执行失败（退出码 ${code ?? '未知'}）`;
  if (provider === 'cursor' && /workspace trust required|workspace is not trusted|trust the contents of this directory/i.test(diagnostic)) {
    return `${prefix}：当前工作区尚未信任，请点击“重新执行”并确认信任此目录`;
  }
  if (/not logged in|unauthenticated|unauthorized|forbidden/i.test(diagnostic)) return `${prefix}：本机 CLI 尚未登录或登录已失效`;
  if (isAgentQuotaDiagnostic(diagnostic)) return `${prefix}：${agentQuotaExhaustedText}或触发速率限制，请等待额度恢复`;
  if (/permission denied|operation not permitted/i.test(diagnostic)) return `${prefix}：工作区或 CLI 权限不足`;
  if (/network|connection|handshake|stream disconnected|timed? ?out/i.test(diagnostic)) return `${prefix}：网络连接或请求超时`;
  if (isAgentSessionBusyDiagnostic(diagnostic)) return `${prefix}：原会话正在其他 ${providerNames[provider]} 窗口运行，请结束或等待当前任务完成后重试`;
  if (/no session found|session.*not found|thread.*not found|cannot find.*(?:session|thread)/i.test(diagnostic)) {
    return provider === 'codex' ? `${prefix}：CLI 找不到原会话，请先重新同步 Codex 会话`
      : `${prefix}：CLI 找不到原会话，请核对原会话或新建会话`;
  }
  if (/session|thread|chat/i.test(diagnostic)) return `${prefix}：原会话无法恢复，请查看运行事件后重试`;
  return `${prefix}：未识别的 CLI 运行错误，原始诊断未展示以保护本机信息`;
}

function eventSession(provider: AgentProvider, event: Record<string, unknown>) {
  const value = provider === 'codex' ? event.thread_id : event.session_id ?? event.sessionId;
  return typeof value === 'string' && sessionPattern.test(value) ? value : '';
}

function eventMessage(provider: AgentProvider, event: Record<string, unknown>) {
  if (provider === 'codex') {
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message') return cleanText(item.text ?? item.message);
    return '';
  }
  if (event.type === 'result') return cleanText(event.result ?? event.text);
  // Cursor 默认输出完整 assistant 消息；thinking delta 不能成为进度或覆盖正文。
  if (event.type !== 'assistant') return '';
  const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
  const content = message?.content ?? event.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) return cleanText(content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as Record<string, unknown>;
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).filter(Boolean).join('\n'));
  return cleanText(event.text);
}

function lifecycleMessage(provider: AgentProvider, mode: AgentRunMode, event: Record<string, unknown>) {
  const type = String(event.type || '');
  const writable = mode === 'agent';
  if (provider === 'codex') {
    if (type === 'turn.started') return writable ? 'Codex 已开始执行任务' : 'Codex 已开始只读分析';
    if (type === 'turn.completed') return 'Codex 已结束本轮任务';
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
    if (type === 'item.started' && item?.type === 'command_execution') return writable ? 'Codex 正在执行工作区命令' : 'Codex 正在执行只读检查';
    if (type === 'item.completed' && item?.type === 'command_execution') return `${writable ? '工作区命令' : '只读检查'}${item.exit_code === 0 ? '已完成' : '未通过'}`;
  } else if (provider === 'claude') {
    if (type === 'system' && event.subtype === 'init') return writable ? 'Claude Code 已初始化 Agent 会话' : 'Claude Code 已初始化只读会话';
    const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
    if (type === 'assistant' && Array.isArray(message?.content)
      && message.content.some(part => part?.type === 'tool_use')) return writable ? 'Claude Code 正在调用工作区工具' : 'Claude Code 正在执行只读检查';
  } else {
    if (type === 'system') return writable ? 'Cursor 已初始化 Agent 会话' : 'Cursor 已初始化只读会话';
    if (type === 'tool_call') return writable ? 'Cursor 正在调用工作区工具' : 'Cursor 正在执行只读检查';
  }
  return '';
}

function executionPrompt(mode: AgentRunMode, objective: string, accessMode: AgentAccessMode, revisesRunId?: string) {
  if (revisesRunId) objective = `用户已暂停并编辑上一条任务，本条内容替代被暂停的任务要求。请基于已完成的实际结果，按以下修订后的要求继续，不再执行旧要求中被撤回的部分；不要自动回滚已有改动。\n\n${objective}`;
  const task = objective;
  if (mode === 'agent') {
    const boundary = accessMode === 'full'
      ? '用户已为当前会话任务选择完全访问，续聊、重试和恢复持续沿用该选择，可访问工作区外的本机文件和网络；用户主动更改访问范围后按新选择执行。'
      : '本轮仅允许写入所选工作区。';
    return `${task}\n\n工作台执行上下文：你由 Delivery Workspace 以 Agent 模式调用。${boundary}请完成上述用户任务并运行必要命令。已有明确授权在原范围持续有效，不因换轮、重试、恢复或执行器切换缩成单次授权；完成已授权任务所必需的登录、认证续期和重复验证不再逐次询问，优先安全复用已有登录与用户提供的凭据，秘密不写入命令参数、日志或报告。仅执行用户明确要求的范围；提交、推送或更改外部系统必须由用户在任务中明确要求。`;
  }
  const purpose = mode === 'plan' ? '分析现状并输出可执行方案' : '基于仓库事实回答问题';
  return `${task}\n\n工作台执行上下文：你由 Delivery Workspace 以只读模式调用。请${purpose}。不得修改文件、运行会产生写入的命令、提交、推送或更改外部系统。`;
}

function executionAccess(run: Pick<AgentRun, 'mode' | 'accessMode'>) {
  return run.mode === 'agent' ? run.accessMode : 'read-only';
}

function configuredNativeTools(run: Pick<AgentRun, 'provider' | 'mode' | 'accessMode'>) {
  return run.mode === 'agent' && run.accessMode === 'full' && ['claude', 'kiro', 'antigravity'].includes(run.provider);
}

export function agentExecutionPrompt(run: AgentRun, continueOriginal = false) {
  if (continueOriginal) return executionPrompt(run.mode,
    '续接刚暂停的原任务。沿用已有进度、用户要求和原授权范围。先核对已完成的步骤及可能已生效的操作，只继续剩余工作。', run.accessMode);
  return executionPrompt(run.mode, run.objective, run.accessMode, run.revisesRunId)
    + (run.teamContext ? `\n\n${run.teamContext}` : '')
    + (run.providerSwitch?.context ? `\n\n${run.providerSwitch.context}` : '')
    + (run.accessTransition?.context ? `\n\n${run.accessTransition.context}` : '')
    + (run.knowledgeContext ? `\n\n${run.knowledgeContext}` : '')
    + (run.workflowContext ? `\n\n${run.workflowContext}` : '');
}

function withFileAttachments(prompt: string, files: { name: string; path: string }[]) {
  return files.length ? `${prompt}\n\n本轮附加的本地文件（已验证）：\n${files.map(file => `- ${JSON.stringify(file.name)}：${JSON.stringify(file.path)}`).join('\n')}` : prompt;
}

export function codexRunArguments(workspacePath: string, mode: AgentRunMode, model = '', reasoningEffort: AgentReasoningEffort | '' = '',
  sessionId = '', imagePaths: string[] = [], accessMode: AgentAccessMode = mode === 'agent' ? 'full' : 'workspace') {
  const sandboxMode = mode !== 'agent' ? 'read-only' : accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
  const fixed = ['-c', `sandbox_mode="${sandboxMode}"`, '-c', 'approval_policy="never"',
    ...(sandboxMode === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...(model ? ['--model', model] : []), '--thread-source', 'cli', '--json',
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath])];
  return sessionId ? ['exec', 'resume', sessionId, ...fixed, '-'] : ['exec', '--cd', workspacePath, ...fixed, '-'];
}

export function codexForkArguments(mode: AgentRunMode, model = '', reasoningEffort: AgentReasoningEffort | '' = '',
  sessionId = '', imagePaths: string[] = [], accessMode: AgentAccessMode = mode === 'agent' ? 'full' : 'workspace') {
  const sandboxMode = mode !== 'agent' ? 'read-only' : accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
  const fixed = ['-c', `sandbox_mode="${sandboxMode}"`, '-c', 'approval_policy="never"',
    ...(sandboxMode === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...(model ? ['--model', model] : []), '--thread-source', 'cli', '--json',
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath])];
  return ['exec', 'fork', sessionId, ...fixed, '-'];
}

export function cursorRunArguments(workspacePath: string, mode: AgentRunMode, model = '', sessionId = '', prompt = '',
  accessMode: AgentAccessMode = mode === 'agent' ? 'full' : 'workspace', cursorTrustPath = '') {
  const fullAccess = mode === 'agent' && accessMode === 'full';
  return ['-p', '--output-format', 'stream-json', ...(mode === 'agent' ? [fullAccess ? '--force' : '--auto-review'] : ['--mode', mode]),
    '--sandbox', fullAccess ? 'disabled' : 'enabled', ...(model ? ['--model', model] : []), '--workspace', workspacePath,
    ...(cursorTrustPath && cursorTrustPath === workspacePath ? ['--trust'] : []),
    ...(sessionId ? ['--resume', sessionId] : []), prompt];
}

async function runCli(provider: AgentProvider, binary: string, args: string[], context: ExecutionContext, stdin = '') {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli-start-gate.mjs', import.meta.url))], {
      cwd: context.run.workspacePath, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: false,
      detached: process.platform !== 'win32', env: provider === 'codex' ? codexChildEnvironment()
        : provider === 'claude' ? claudeChildEnvironment() : process.env });
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let buffer = '';
    let diagnostic = '';
    let result = '';
    const cursorAssistantMessages: string[] = [];
    let cursorAssistantLength = 0;
    let completedResult = provider !== 'claude';
    let claudeSessionId = context.resumeSessionId || '';
    let confirmedClaudeSession = false;
    let stopped = false;
    let failure = '';
    let childClosed = false;
    let pidRecording: Promise<void> = Promise.resolve();
    let outputProcessing: Promise<void> = Promise.resolve();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else if (child.connected) child.send({ type: 'stop', signal }, error => { if (error) child.kill(signal); });
        else child.kill(signal);
      } catch { /* Process already exited. */ }
    };
    const terminate = (message: string) => {
      if (failure) return;
      failure = message;
      if (childClosed) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    const stop = () => { stopped = true; terminate('运行已停止'); };
    // CLI 可以持续执行长任务；只在主动中断、异常或进程结束时收尾。
    context.signal.addEventListener('abort', stop, { once: true });
    child.on('error', () => reject(new Error(`${providerNames[provider]} CLI 进程未能启动`)));
    child.stderr!.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + stderr.write(chunk)).slice(-16_384); });
    const acceptLine = (line: string) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; }
        catch { return; /* CLI diagnostics can share stdout; never echo unparsed content to the page. */ }
        outputProcessing = outputProcessing.then(async () => {
          if (failure || stopped) return;
          context.onUsage?.(event);
          const sessionId = eventSession(provider, event);
          if (provider === 'claude' && sessionId) {
            if (claudeSessionId && claudeSessionId !== sessionId) { terminate('Claude Code 返回的会话 ID 与本轮不一致，已停止运行'); return; }
            claudeSessionId = sessionId;
            confirmedClaudeSession = true;
          }
          if (sessionId) await context.onSession(sessionId);
          if (provider === 'claude' && event.type === 'result') {
            if (event.is_error === true || event.subtype !== 'success') {
              const detail = [typeof event.result === 'string' ? event.result : '',
                ...(Array.isArray(event.errors) ? event.errors.filter((item): item is string => typeof item === 'string') : [])].join('\n');
              terminate(isAgentQuotaDiagnostic(detail) ? `Claude Code ${agentQuotaExhaustedText}或触发速率限制，本轮未完成`
                : 'Claude Code 未成功完成本轮，请检查登录、额度和运行权限后重试'); return;
            }
            if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
              terminate('Claude Code 工具权限被拒绝，本轮未完整执行；请核对任务范围后重试'); return;
            }
            completedResult = true;
          }
          let message = eventMessage(provider, event);
          if (provider === 'cursor' && message) {
            if (event.type === 'assistant') {
              cursorAssistantMessages.push(message); cursorAssistantLength += message.length;
              while (cursorAssistantLength > 12_000 && cursorAssistantMessages.length > 1) cursorAssistantLength -= cursorAssistantMessages.shift()!.length;
            } else if (event.type === 'result' && cursorAssistantMessages.length > 1) {
              const finalAssistant = cursorAssistantMessages.at(-1)!;
              let joined = finalAssistant;
              for (let index = cursorAssistantMessages.length - 2; index >= 0 && joined.length < message.length; index -= 1) {
                joined = cursorAssistantMessages[index] + joined;
                if (joined !== message) continue;
                const prefix = cursorAssistantMessages.slice(index, -1);
                if (prefix.some(text => text.includes('```') || text.includes('~~~') || text.startsWith('{') || text.startsWith('['))) break;
                // Cursor may concatenate completed messages without a boundary. Keep the observed final report intact.
                try { readDeliveryReport(finalAssistant); message = finalAssistant; } catch { /* Ordinary text and examples retain the original result. */ }
                break;
              }
            }
          }
          if (message) { result = message; context.onEvent('message', message); }
          const lifecycle = lifecycleMessage(provider, context.run.mode, event);
          if (lifecycle) context.onEvent(lifecycle.includes('检查') ? 'tool' : 'lifecycle', lifecycle);
        }).catch(() => terminate('CLI 会话记录保存失败，已停止本轮'));
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += stdout.write(chunk);
      if (buffer.length > 2_000_000) { context.onEvent('diagnostic', 'CLI 事件输出超过限制，已停止运行'); terminate('CLI 事件输出超过大小限制'); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        acceptLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    });
    child.on('close', async (code) => {
      childClosed = true;
      buffer += stdout.end();
      diagnostic = (diagnostic + stderr.end()).slice(-16_384);
      if (buffer.trim()) acceptLine(buffer);
      await pidRecording;
      await outputProcessing;
      clearTimeout(killTimer);
      context.signal.removeEventListener('abort', stop);
      if (stopped || context.signal.aborted) { reject(new Error('运行已停止')); return; }
      if (failure) { reject(new Error(failure)); return; }
      if (code !== 0) { reject(new Error(agentCliFailureMessage(provider, code, diagnostic))); return; }
      if (!completedResult) { reject(new Error('Claude Code 未返回本轮成功结束记录，请核对已有结果后重试')); return; }
      if (provider === 'claude' && !confirmedClaudeSession) { reject(new Error('Claude Code 未返回可确认的会话 ID')); return; }
      resolve(result || 'CLI 已完成本轮任务，但没有返回可展示的最终文本。');
    });
    child.stdin!.on('error', () => { /* close/error reports the actual failure */ });
    pidRecording = Promise.resolve().then(async () => {
      if (child.pid) await context.onPid(child.pid);
      if (!childClosed && !context.signal.aborted) {
        await new Promise<void>((resolve, reject) => child.send({ type: 'start', command: binary, args, stdin },
          error => { if (error) reject(error); else resolve(); }));
        child.stdin!.end();
      }
    }).catch(() => terminate('执行进程记录保存失败，已停止本轮'));
    if (context.signal.aborted) stop();
  });
}

function cachedHealth(check: () => Promise<Omit<AgentRuntimeHealth, 'checkedAt'>>, ttlMs = 30_000) {
  let cached: AgentRuntimeHealth | undefined;
  return async (force = false) => {
    if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < ttlMs) return cached;
    cached = { ...await check(), checkedAt: new Date().toISOString() };
    return cached;
  };
}

export function createCodexAdapter(binary = cliBinary, browserRootDirectory?: string): AgentRuntimeAdapter {
  const readModels = createCodexModelReader(() => requestCodexModels(binary));
  const health = cachedHealth(async () => {
    const [version, login] = await Promise.allSettled([
      exec(binary, ['--version'], { timeout: 10_000 }),
      exec(binary, ['login', 'status'], { timeout: 10_000 }),
    ]);
    const versionText = version.status === 'fulfilled' ? cleanText(version.value.stdout, 200) : '';
    const loginText = login.status === 'fulfilled' ? `${login.value.stdout}\n${login.value.stderr}` : '';
    const authenticated = /(?:Logged in|API key configured)/i.test(loginText);
    const ready = !!versionText && authenticated;
    const catalog = ready ? await readModels() : { models: [{ id: '', label: 'CLI 默认（当前配置）' }], defaultModel: '', message: '',
      configuredModel: undefined, configuredServiceTier: undefined };
    return { provider: 'codex' as const, label: 'Codex CLI', binary, version: versionText, authenticated, ready,
      message: ready ? catalog.message || '本机 Codex CLI 可用于 Agent、Plan 和 Ask 模式' : !versionText ? '未找到可用的 Codex CLI' : 'Codex CLI 尚未登录',
      modes: ['agent', 'plan', 'ask'] as AgentRunMode[], models: catalog.models, defaultModel: catalog.defaultModel,
      configuredModel: catalog.configuredModel, configuredServiceTier: catalog.configuredServiceTier, writable: true };
  });
  return { id: 'codex', health,
    execute: async (context) => {
      const run = context.run;
      const scope = run.team ? `team:${run.team.taskId}:${run.team.profileId}`
        : `conversation:${run.conversationId || run.queueRootId || run.id}`;
      const chromeReuseEnabled = process.platform === 'darwin' && process.env.DELIVERY_AGENT_BROWSER_REUSE_CHROME === '1';
      const canReuseChrome = !run.team || (run.accessMode === 'full' && run.task?.role === 'main' && !run.task.workflow);
      const chromeDebugPortFile = chromeReuseEnabled && canReuseChrome
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort')
        : undefined;
      const browser = browserRootDirectory ? await prepareAgentBrowserRuntime({ rootDirectory: browserRootDirectory, scope, chromeDebugPortFile }) : undefined;
      if (browser?.config) context.onEvent('lifecycle', '已配置任务浏览器通道；实际连接和页面登录状态在使用时核验');
      else if (browser) context.onEvent('lifecycle', browser.instructions.split('\n')[0]!);
      const browserInstructions = [browser?.instructions, chromeReuseEnabled && !canReuseChrome
        ? 'Jira 和 Confluence 请在用户日常使用的 Chrome 中打开。当前分工的独立浏览器用于测试页面，不要在其中打开这些登录页面或要求用户重新登录。'
        : ''].filter(Boolean).join('\n');
      return runCodexLiveTurn(binary, { ...context, browserConfig: browser?.config },
        withFileAttachments(agentExecutionPrompt(run, context.continueOriginal), context.fileAttachments)
          + (browserInstructions ? `\n\n${browserInstructions}` : ''));
    } };
}

export function cursorModels(output: string) {
  const ids = output.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .map((line) => line.match(/^(?:[-*]\s*)?([a-z0-9][a-z0-9._:[\]=,-]*)(?:\s+-\s+\S.*)?$/i)?.[1] || '')
    .filter((id) => id && !['available', 'models', 'model', 'default'].includes(id.toLowerCase()));
  return ids.length ? [{ id: '', label: 'Cursor 默认（Auto）' }, ...[...new Set(ids)].slice(0, 50).map((id) => ({ id, label: id }))] : cursorFallbackModels;
}

export function createCursorAdapter(binary = cursorBinary): AgentRuntimeAdapter {
  const health = cachedHealth(async () => {
    const [version, login] = await Promise.allSettled([
      exec(binary, ['--version'], { timeout: 10_000 }),
      exec(binary, ['status', '--format', 'json'], { timeout: 35_000 }),
    ]);
    const versionText = version.status === 'fulfilled' ? cleanText(version.value.stdout || version.value.stderr, 200) : '';
    // 与账号页使用同一结构化状态；超时、网络失败和无效响应不能当作已退出登录。
    const loginText = login.status === 'fulfilled' ? login.value.stdout : login.reason?.stdout;
    const loginTimedOut = login.status === 'rejected' && login.reason?.killed === true;
    let loginState: boolean | undefined;
    try {
      const status: unknown = JSON.parse(loginText || '');
      if (!loginTimedOut && status && typeof status === 'object' && 'isAuthenticated' in status
        && typeof status.isAuthenticated === 'boolean') loginState = status.isAuthenticated;
    } catch { /* 保留未知状态，不转发可能包含账号或凭据的 CLI 原始输出。 */ }
    const authenticated = login.status === 'fulfilled' && loginState === true;
    const ready = !!versionText && authenticated;
    let models = cursorFallbackModels;
    if (ready) {
      try { models = cursorModels((await exec(binary, ['--list-models'], { timeout: 15_000 })).stdout); } catch { /* Keep documented fallback choices. */ }
    }
    return { provider: 'cursor' as const, label: 'Cursor CLI', binary, version: versionText, authenticated, ready,
      message: ready ? '本机 Cursor CLI 可用于 Agent、Plan 和 Ask 模式' : !versionText ? '未找到可用的 Cursor CLI'
        : loginState === false ? 'Cursor CLI 尚未登录'
        : `暂时无法确认登录状态：Cursor CLI ${loginTimedOut ? '登录检查超时' : '登录检查失败'}，请刷新连接状态后重试`,
      modes: ['agent', 'plan', 'ask'] as AgentRunMode[], models, defaultModel: 'auto', writable: true };
  });
  return { id: 'cursor', health,
    execute: (context) => runCli('cursor', binary,
      cursorRunArguments(context.run.workspacePath, context.run.mode, context.run.model, context.resumeSessionId,
        withFileAttachments(agentExecutionPrompt(context.run), context.fileAttachments), context.run.accessMode,
        context.run.cursorTrustPath), context) };
}

export function claudeRunArguments(workspacePath: string, mode: AgentRunMode, model = '', sessionId = '',
  accessMode: AgentAccessMode = mode === 'agent' ? 'full' : 'workspace', readOnlyDirectories: string[] = [], extraDeniedWritePaths: string[] = [],
  reasoningEffort: AgentReasoningEffort | '' = '') {
  if (accessMode === 'full' && mode !== 'agent') throw new Error('只有 Agent 模式可使用完全访问');
  const fullAccess = mode === 'agent' && accessMode === 'full';
  const deniedWritePaths = [...new Set([...readOnlyDirectories, ...extraDeniedWritePaths])];
  const settings = fullAccess ? { sandbox: { enabled: false } } : {
    permissions: { deny: deniedWritePaths.map(directory => `Edit(//${directory.replace(/^\/+/, '')}/**)`) },
    sandbox: { enabled: mode === 'agent', failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [], allowAppleEvents: false,
      filesystem: { disabled: false, allowWrite: [], denyWrite: deniedWritePaths },
      network: { allowedDomains: ['*'], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false } },
  };
  return ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    ...(fullAccess ? [] : ['--restricted', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-chrome', '--tools', mode === 'agent' ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep']),
    '--permission-prompts', 'none',
    '--permission-mode', fullAccess ? 'bypassPermissions' : mode === 'agent' ? 'acceptEdits' : mode === 'plan' ? 'plan' : 'dontAsk',
    '--settings', JSON.stringify(settings),
    ...(readOnlyDirectories.length ? ['--add-dir', ...readOnlyDirectories] : []),
    ...(model ? ['--model', model] : []), ...(sessionId ? ['--resume', sessionId] : []),
    ...(reasoningEffort ? ['--effort', reasoningEffort] : [])];
}

export function createClaudeAdapter(binary = claudeBinary): AgentRuntimeAdapter {
  const health = cachedHealth(async () => {
    const env = claudeChildEnvironment();
    const [version, login, help] = await Promise.allSettled([
      exec(binary, ['--version'], { env, timeout: 10_000 }),
      exec(binary, ['auth', 'status', '--json'], { env, timeout: 10_000 }),
      exec(binary, ['--help'], { env, timeout: 10_000, maxBuffer: 256_000 }),
    ]);
    const versionText = version.status === 'fulfilled' ? cleanText(version.value.stdout, 200) : '';
    let authenticated = false;
    if (login.status === 'fulfilled') {
      try { authenticated = JSON.parse(login.value.stdout)?.loggedIn === true; } catch { /* Invalid auth output is not a login. */ }
    }
    const compatible = help.status === 'fulfilled'
      && ['--restricted', '--safe-mode', '--permission-prompts', '--strict-mcp-config'].every(flag => help.value.stdout.includes(flag));
    const supportsFullAccess = compatible && help.status === 'fulfilled'
      && help.value.stdout.includes('--permission-mode') && help.value.stdout.includes('bypassPermissions');
    const ready = !!versionText && authenticated && compatible;
    let models = [claudeDefaultModel];
    let modelMessage = '';
    if (ready) {
      try { models = await requestClaudeModels(binary); }
      catch { modelMessage = '模型同步失败，可使用 Claude Code 默认或自定义模型'; }
    }
    return { provider: 'claude' as const, label: 'Claude Code', binary, version: versionText, authenticated, ready,
      message: !versionText ? '未找到可用的 Claude Code CLI' : !compatible ? '请更新 Claude Code CLI，以支持受限工具和非交互权限控制'
        : !authenticated ? 'Claude Code CLI 尚未登录，请在 AI 账号管理中完成官方登录' : modelMessage || '本机 Claude Code 可用于 Agent、Plan 和 Ask 模式',
      modes: ['agent', 'plan', 'ask'] as AgentRunMode[], accessModes: (supportsFullAccess ? ['workspace', 'full'] : ['workspace']) as AgentAccessMode[],
      models, defaultModel: '', writable: true };
  });
  return { id: 'claude', health, execute: async context => {
    if (context.run.accessMode === 'full' && context.run.mode !== 'agent') throw new Error('只有 Agent 模式可使用完全访问');
    if (context.fileAttachments.length && !context.attachmentDirectory) throw new Error('Claude Code 附件暂存目录不可用');
    const input = await prepareClaudeInput(agentExecutionPrompt(context.run), context.imagePaths, context.fileAttachments,
      context.attachmentDirectory || '');
    const deniedWritePaths: string[] = [];
    if (context.run.mode === 'agent' && context.run.accessMode !== 'full') {
      try {
        const common = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          { cwd: context.run.workspacePath, timeout: 5000, maxBuffer: 16_000 });
        const commonDirectory = path.resolve(context.run.workspacePath, common.stdout.trim());
        const relative = path.relative(context.run.workspacePath, commonDirectory);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) deniedWritePaths.push(commonDirectory);
      } catch { /* Plain workspaces have no shared Git directory. */ }
    }
    const readOnlyDirectories = [...new Set([...(context.attachmentReadDirectories || []), ...input.readOnlyDirectories])];
    return runCli('claude', binary, claudeRunArguments(context.run.workspacePath, context.run.mode, context.run.model,
      context.resumeSessionId, context.run.accessMode, readOnlyDirectories, deniedWritePaths, context.run.reasoningEffort), context, input.stdin);
  } };
}

export async function resolveWorkspace(workspacePath: string): Promise<WorkspaceIdentity> {
  if (!path.isAbsolute(workspacePath)) throw new Error('工作区必须通过本机文件夹选择器选择');
  const selected = await fs.realpath(workspacePath);
  if (!(await fs.stat(selected)).isDirectory()) throw new Error('所选工作区不是有效文件夹');
  let root = '';
  try { root = (await exec('git', ['-C', selected, 'rev-parse', '--show-toplevel'], { timeout: 5000 })).stdout.trim(); }
  catch { return { workspacePath: selected, branch: '', headSha: '' }; }
  const workspace = await fs.realpath(root);
  const [branch, head] = await Promise.allSettled([
    exec('git', ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 }),
    exec('git', ['-C', workspace, 'rev-parse', 'HEAD'], { timeout: 5000 }),
  ]);
  return { workspacePath: workspace,
    branch: branch.status === 'fulfilled' ? branch.value.stdout.trim() : 'detached HEAD',
    headSha: head.status === 'fulfilled' ? head.value.stdout.trim() : '' };
}

export async function listGitBranches(workspacePath: string): Promise<AgentWorkspaceBranches> {
  const identity = await resolveWorkspace(workspacePath);
  if (!identity.branch && !identity.headSha) return { workspacePath: identity.workspacePath, current: '', branches: [] };
  const output = await exec('git', ['-C', identity.workspacePath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { timeout: 5000, maxBuffer: 500_000 });
  const branches = [...new Set(output.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return { workspacePath: identity.workspacePath, current: identity.branch === 'detached HEAD' ? '' : identity.branch, branches };
}

export async function switchGitWorkspaceBranch(workspacePath: string, branch: string): Promise<WorkspaceIdentity> {
  const target = cleanText(branch, 300);
  const state = await listGitBranches(workspacePath);
  if (!state.branches.length) throw new Error('所选工作区不是 Git 仓库，无法切换分支');
  if (!target || !state.branches.includes(target)) throw new Error('所选分支不是该仓库的本地分支');
  if (target === state.current) return resolveWorkspace(state.workspacePath);
  const status = await exec('git', ['-C', state.workspacePath, 'status', '--porcelain'], { timeout: 5000, maxBuffer: 1_000_000 });
  if (status.stdout.trim()) throw new Error('工作区存在未提交改动，请处理后再切换分支');
  try { await exec('git', ['-C', state.workspacePath, 'switch', target], { timeout: 15_000, maxBuffer: 1_000_000 }); }
  catch { throw new Error('分支切换失败，请确认该分支未被其他工作区占用'); }
  return resolveWorkspace(state.workspacePath);
}

export async function createIsolatedGitWorkspace(directory: string, workspacePath: string, branch: string,
  workspaceId: string, branchPrefix: 'codex/' | 'feature/' = 'codex/'): Promise<IsolatedWorkspaceIdentity> {
  const source = await resolveWorkspace(workspacePath);
  if (!source.branch && !source.headSha) {
    return { ...source, sourceWorkspacePath: source.workspacePath, baseBranch: '', isolatedWorkspace: false };
  }
  const state = await listGitBranches(source.workspacePath);
  const baseBranch = cleanText(branch, 300) || state.current;
  if (!baseBranch || !state.branches.includes(baseBranch)) throw new Error('所选分支不是该仓库的本地分支');
  const branchStem = baseBranch.replace(/^refs\/heads\//, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const isolatedBranch = `${branchPrefix}delivery-agent-${branchStem.slice(-80)}-${workspaceId.slice(0, 8)}`;
  const target = path.join(directory, 'workspaces', workspaceId);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await exec('git', ['-C', source.workspacePath, 'worktree', 'add', '-b', isolatedBranch, target, baseBranch],
      { timeout: 60_000, maxBuffer: 2_000_000 });
  } catch {
    await fs.rm(target, { recursive: true, force: true });
    throw new Error('隔离工作区创建失败，请确认所选分支仍然存在');
  }
  const isolated = await resolveWorkspace(target);
  return { ...isolated, sourceWorkspacePath: source.workspacePath, baseBranch, isolatedWorkspace: true };
}

const workflowActions = new Set<AgentWorkflowAction>(['extend', 'escalate', 'retry', 'takeover', 'cancel']);

function storedWorkflowRecord(value: unknown): AgentWorkflowRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as AgentWorkflowRecord;
  if (!/^[0-9a-f-]{36}$/.test(String(input.id)) || !(input.templateId in agentTeamTemplates)
    || !cleanText(input.parentConversationId, 200) || !cleanText(input.objective, 200_000)) return undefined;
  const createdAt = cleanText(input.createdAt, 40) || new Date(0).toISOString();
  return {
    id: input.id, templateId: input.templateId, parentConversationId: cleanText(input.parentConversationId, 200),
    objective: cleanText(input.objective, 200_000),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria
      .map(item => ({ id: cleanText(item?.id, 40), text: cleanText(item?.text, 2000) })).filter(item => item.id && item.text).slice(0, 30) : [],
    allowedPaths: Array.isArray(input.allowedPaths) ? input.allowedPaths.map(item => cleanText(item, 300)).filter(Boolean).slice(0, 30) : [],
    attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds.filter(id => /^[0-9a-f-]{36}$/.test(String(id))).slice(0, 6) : [],
    maxRounds: null,
    escalated: input.escalated === true,
    ...(input.closed && ['cancel', 'takeover'].includes(input.closed.action)
      ? { closed: { action: input.closed.action, at: cleanText(input.closed.at, 40) } } : {}),
    ...(input.providerFallback?.from === 'claude' && input.providerFallback.to === 'codex'
      ? { providerFallback: { from: 'claude' as const, to: 'codex' as const, reason: cleanText(input.providerFallback.reason, 1000),
        at: cleanText(input.providerFallback.at, 40) } } : {}),
    ...(input.dispatchError && Number.isInteger(input.dispatchError.step)
      ? { dispatchError: { step: input.dispatchError.step, message: cleanText(input.dispatchError.message, 1000), at: cleanText(input.dispatchError.at, 40) } } : {}),
    decisions: Array.isArray(input.decisions) ? input.decisions.filter(item => item && workflowActions.has(item.action))
      .map(item => ({ requestId: cleanText(item.requestId, 100), action: item.action, step: Number(item.step) || 0, at: cleanText(item.at, 40) }))
      .slice(-50) : [],
    createdAt, updatedAt: cleanText(input.updatedAt, 40) || createdAt,
  };
}

export async function createAgentRuntimeService(directory: string, options: ServiceOptions = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  const snapshotExclusions = [directory, ...(options.workspaceSnapshotExclusions || [])];
  const file = path.join(directory, 'agent-runs.json');
  const customModelFile = path.join(directory, 'custom-models.json');
  // 密钥独立保存在本机，不进入模型目录、运行记录或通用状态备份。
  const apiCredentialFile = path.join(directory, 'api-model-credentials.json');
  let apiCredentials: Record<string, string> = {};
  try {
    const saved = JSON.parse(await fs.readFile(apiCredentialFile, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || Object.entries(saved).some(([id, value]) => !/^[0-9a-f-]{36}$/.test(id) || typeof value !== 'string')) throw new Error();
    apiCredentials = saved;
    await fs.chmod(apiCredentialFile, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机模型 API 密钥配置不可读');
  }
  async function persistApiCredentials(next: Record<string, string>) {
    const temporary = `${apiCredentialFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temporary, apiCredentialFile);
      apiCredentials = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  const codexSessionFile = path.join(directory, 'codex-sessions.json');
  const hiddenCodexSessionFile = path.join(directory, 'hidden-codex-sessions.json');
  const conversationTitleFile = path.join(directory, 'conversation-titles.json');
  const claudeAttachmentDirectory = (runId: string) => path.join(directory, 'claude-attachments', createHash('sha256').update(runId).digest('hex'));
  const kiroAttachmentDirectory = (runId: string) => path.join(directory, 'kiro-attachments', createHash('sha256').update(runId).digest('hex'));
  const antigravityAttachmentDirectory = (runId: string) => path.join(directory, 'antigravity-attachments', createHash('sha256').update(runId).digest('hex'));
  const runtimeAttachmentDirectory = (run: AgentRun) => run.provider === 'antigravity' ? antigravityAttachmentDirectory(run.id)
    : run.provider === 'kiro' ? kiroAttachmentDirectory(run.id) : claudeAttachmentDirectory(run.id);
  const readState = async <T = unknown>(filename: string): Promise<T> => options.stateBackup
    ? options.stateBackup.readJson<T>(`agent-runtimes/${path.basename(filename)}`)
    : JSON.parse(await fs.readFile(filename, 'utf8')) as T;
  const writeState = async (filename: string, value: unknown) => {
    if (options.stateBackup) { await options.stateBackup.writeJson(`agent-runtimes/${path.basename(filename)}`, value); return; }
    const temporary = `${filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporary, filename);
  };
  const adapters = new Map((options.adapters || [createCodexAdapter(cliBinary, options.browserRootDirectory), createCursorAdapter(), createClaudeAdapter(), createKiroAdapter(kiroBinary, agentExecutionPrompt),
    createAntigravityAdapter(antigravityBinary, agentExecutionPrompt), createWorkbuddyAdapter()]).map((adapter) => [adapter.id, adapter]));
  const workspaceIdentity = options.resolveWorkspace || resolveWorkspace;
  const resolveProject = createWorkspaceProjectResolver();
  async function exposeProjectWorkspace<T extends { workspacePath: string; sourceWorkspacePath?: string }>(run: T) {
    Object.defineProperty(run, 'projectWorkspacePath', { configurable: true, enumerable: true,
      value: await resolveProject(run) });
    return run;
  }
  const workspaceBranchSwitcher = options.switchWorkspaceBranch || switchGitWorkspaceBranch;
  const isolatedWorkspaceCreator = options.createIsolatedWorkspace
    || ((workspacePath: string, branch: string, workspaceId: string, branchPrefix?: 'codex/' | 'feature/') =>
      createIsolatedGitWorkspace(directory, workspacePath, branch, workspaceId, branchPrefix));
  const codexThreadForker = options.forkCodexThread || forkCodexThread;
  const codexSessionSource = options.codexSessionSource || createCodexSessionSource();
  const attachmentResolver = options.resolveAttachments;
  const attachmentRemover = options.removeAttachments;
  let runs: AgentRun[] = [];
  let customModels: StoredCustomModel[] = [];
  const redactApiSecrets = (text: string) => Object.values(apiCredentials).filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((value, key) => value.split(JSON.stringify(key).slice(1, -1)).join('[redacted]').split(key).join('[redacted]'), text);
  for (const provider of ['grok', 'deepseek'] as const) {
    if ((!options.adapters || options.apiModels) && !adapters.has(provider)) {
      const createAdapter = provider === 'grok' ? createGrokAdapter : createDeepseekAdapter;
      adapters.set(provider, createAdapter({
        directory,
        models: () => customModels.filter(model => model.provider === provider && !!model.api),
        apiKey: async id => apiCredentials[id] || '',
        redact: redactApiSecrets,
        history: run => {
          const history: AgentRun[] = [], visited = new Set<string>();
          let parent = runs.find(item => item.id === run.parentRunId);
          while (parent && !visited.has(parent.id) && parent.provider === provider && parent.workspacePath === run.workspacePath) {
            visited.add(parent.id);
            if (['completed', 'failed', 'interrupted', 'cancelled'].includes(parent.status)) history.unshift(parent);
            parent = runs.find(item => item.id === parent!.parentRunId);
          }
          return history;
        },
      }));
    }
  }
  if ((!options.adapters || options.apiModels) && !adapters.has('api')) adapters.set('api', createApiModelAdapter({
    models: () => customModels.filter((model) => model.provider === 'api' && !!model.api)
      .map(model => ({ ...model, api: { baseUrl: model.api!.baseUrl } })),
    apiKey: async id => apiCredentials[id] || '',
    history: run => {
      const history: AgentRun[] = [], visited = new Set<string>();
      let parent = runs.find(item => item.id === run.parentRunId);
      while (parent && !visited.has(parent.id)) {
        visited.add(parent.id);
        if (parent.status === 'completed' && parent.provider === 'api') history.unshift(parent);
        parent = runs.find(item => item.id === parent!.parentRunId);
      }
      return history;
    },
  }));
  let codexSessions: CodexSessionSummary[] = [];
  let codexSessionDetails: Record<string, CodexSessionDetail> = {};
  let conversationTitles: Record<string, string> = {};
  let codexSync: CodexSyncState = { syncedAt: '', total: 0, hidden: 0 };
  let hiddenCodexSessionIds = new Set<string>();
  // 同步只刷新工作台已关联的线程；目录、标题和旧同步缓存都不能证明个人会话属于工作台。
  function filterCodexSessions(sessions: CodexSessionSummary[]) {
    const linkedIds = new Set(runs.filter((run) => run.provider === 'codex' || run.providerSwitch?.from === 'codex')
      .flatMap((run) => [run.originSessionId,
        ...(run.provider === 'codex' ? [run.sessionId, run.continuation?.sessionId] : [])]).filter(Boolean));
    return sessions.filter((session) => linkedIds.has(session.id) && !session.archived && !hiddenCodexSessionIds.has(session.id));
  }
  try {
    const parsed = await readState<AgentRun[]>(file);
    runs = Array.isArray(parsed) ? parsed.map((run) => ({ ...run, model: cleanText(run.model, 100),
      accessMode: run.accessMode === 'full' && run.mode === 'agent' ? 'full' : 'workspace',
      serviceTier: run.serviceTier === 'default' || run.serviceTier === 'priority' ? run.serviceTier : undefined,
      reasoningEffort: cleanText(run.reasoningEffort, 20) as AgentReasoningEffort | '', attachments: storedAttachments(run.attachments), liveInputReady: false,
      ...(storedTask(run.task) ? { task: storedTask(run.task) } : {}),
      ...(storedChangedFiles(run.changedFiles) !== undefined ? { changedFiles: storedChangedFiles(run.changedFiles) } : {}) })) : [];
    runs = await Promise.all(runs.map(async (stored) => {
      const run = await exposeProjectWorkspace(await resolveRenamedWorkspace(stored));
      const generated = await resultArtifactFiles(run.workspacePath, run.result);
      return generated.length ? { ...run, changedFiles: mergeChangedFiles(run.changedFiles || [], generated) } : run;
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Agent 运行记录不可读：${error instanceof Error ? error.message : String(error)}`); }
  // 修正旧版将 writer 占用误报为执行中的文案；由接口返回准确文案，前端原样显示。
  let migratedSessionErrors = false;
  runs = runs.map(run => {
    if (run.provider !== 'codex' || run.status !== 'failed') return run;
    const error = codexSessionErrorText(run.error);
    if (error === run.error) return run;
    migratedSessionErrors = true;
    return { ...run, error };
  });
  // 旧记录没有队列根时，按当前可见的父链补齐一次；之后由新运行继承，历史截断不再改变队列。
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const queueRootFor = (run: AgentRun) => {
    const visited = new Set<string>();
    let current = run;
    while (!visited.has(current.id)) {
      visited.add(current.id);
      if (current.queueRootId) return current.queueRootId;
      const parent = current.parentRunId ? runsById.get(current.parentRunId) : undefined;
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };
  const migratedQueueRoots = runs.some((run) => !run.queueRootId);
  runs = runs.map((run) => ({ ...run, queueRootId: queueRootFor(run) }));
  try {
    const parsed = await readState<StoredCustomModel[]>(customModelFile);
    customModels = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object')
      .map((item) => ({ id: cleanText(item.id, 80), provider: item.provider, modelId: cleanText(item.modelId, 100),
        label: cleanText(item.label, 80), createdAt: cleanText(item.createdAt, 40),
        ...(['api', 'grok', 'deepseek'].includes(item.provider) && item.api ? { api: { baseUrl: item.provider === 'grok'
          ? normalizeGrokBaseUrl(item.api.baseUrl) : item.provider === 'deepseek' ? normalizeDeepseekBaseUrl(item.api.baseUrl) : normalizeApiBaseUrl(item.api.baseUrl) } } : {}) }))
      .filter((item): item is StoredCustomModel => !!item.id && ['codex', 'cursor', 'claude', 'kiro', 'antigravity', 'api', 'deepseek', 'workbuddy', 'grok'].includes(item.provider)
        && (!['api', 'grok', 'deepseek'].includes(item.provider) || !!item.api)
        && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(item.modelId) && !!item.label) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`自定义模型配置不可读：${error instanceof Error ? error.message : String(error)}`); }
  try {
    const parsed = await readState<StoredCodexSessions>(codexSessionFile);
    codexSessions = Array.isArray(parsed.sessions) ? await Promise.all(parsed.sessions.map(resolveRenamedWorkspace)) : [];
    codexSessionDetails = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
      ? Object.fromEntries(await Promise.all(Object.entries(parsed.details).filter(([id, detail]) => sessionPattern.test(id)
        && detail && typeof detail === 'object' && Array.isArray(detail.turns)).map(async ([id, detail]) => [id, await resolveRenamedWorkspace(detail)]))) : {};
    codexSync = { syncedAt: cleanText(parsed.syncedAt, 40), total: codexSessions.length, hidden: 0 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Codex 会话缓存不可读：${error instanceof Error ? error.message : String(error)}`); }
  try {
    const parsed = await readState<string[]>(hiddenCodexSessionFile);
    hiddenCodexSessionIds = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && sessionPattern.test(id)) : []);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Codex 会话隐藏记录不可读：${error instanceof Error ? error.message : String(error)}`); }
  try {
    const parsed = await readState<Record<string, string>>(conversationTitleFile);
    conversationTitles = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([id, title]) => [id, cleanText(title, 120)])
        .filter(([id, title]) => sessionPattern.test(id) && !!title)) : {};
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`会话标题配置不可读：${error instanceof Error ? error.message : String(error)}`); }
  const cachedSessionCount = codexSessions.length;
  const cachedDetailCount = Object.keys(codexSessionDetails).length;
  codexSessions = await Promise.all(filterCodexSessions(codexSessions).map(exposeProjectWorkspace));
  const visibleCodexSessionIds = new Set(codexSessions.map((session) => session.id));
  codexSessionDetails = Object.fromEntries(Object.entries(codexSessionDetails)
    .filter(([id]) => visibleCodexSessionIds.has(id)));
  const migratedCodexSessions = cachedSessionCount !== codexSessions.length
    || cachedDetailCount !== Object.keys(codexSessionDetails).length;
  codexSync = { ...codexSync, total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
  const now = new Date().toISOString();
  let recovered = false;
  runs = runs.map((run) => activeStatuses.has(run.status) ? { ...run, status: 'interrupted', pid: null,
    recovery: { previousStatus: run.status as 'running' | 'queued', previousPid: run.pid, state: 'pending', checkedAt: '',
      message: '服务重启后待核对原执行状态，未自动重复执行。' },
    error: '5199 服务重启中断了本机 CLI 观察；未自动重复执行，请先核对原会话。', updatedAt: now }
    : run.provider === 'codex' && run.status === 'failed' && run.sessionId && run.codexTurnId
      && run.error.startsWith('未确认桌面端本轮结束') ? { ...run, status: 'interrupted', pid: null, updatedAt: now,
      recovery: { previousStatus: 'running', previousPid: null, nativeObservation: 'codex-desktop', state: 'pending', checkedAt: '',
        message: '正在重新核对桌面原轮次，未重复派发。' } }
    : run.status === 'interrupted' && !run.recovery ? { ...run,
      recovery: { previousStatus: 'interrupted', previousPid: null, state: 'pending', checkedAt: '',
        message: '历史中断任务尚未核对，未自动重复执行。' } } : run);
  recovered = runs.some((run) => run.updatedAt === now && run.status === 'interrupted');
  // 结果版本独立于可变运行对象；保留现有实时引用，任何正文或来源时间变化都会先失效，落盘成功后才恢复。
  const readyResultVersions = new Map<string, Pick<AgentRun, 'result' | 'updatedAt'>>(runs
    .filter(run => run.status === 'completed' && run.pid === null)
    .map(run => [run.id, { result: run.result, updatedAt: run.updatedAt }]));
  function exposeResultReady(run: AgentRun) {
    return Object.defineProperty(run, 'resultReady', { configurable: true, enumerable: true, get: () => {
      const saved = readyResultVersions.get(run.id);
      return run.status === 'completed' && run.pid === null && !!saved
        && saved.result === run.result && saved.updatedAt === run.updatedAt;
    } });
  }
  runs.forEach(exposeResultReady);
  const workflowFile = path.join(directory, 'agent-workflows.json');
  const workflowWorkspace = options.workflowWorkspace || localWorkflowWorkspace;
  const workflowArtifactRoot = path.join(directory, 'workflow-artifacts');
  const verificationRoot = path.join(directory, 'verify');
  // 当工作台自身是目标项目时，数据目录在源码内；副本必须放到源目录外，避免递归复制。
  const externalVerificationRoot = path.join(os.tmpdir(), `delivery-team-verify-${createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 20)}`);
  let workflows: AgentWorkflowRecord[] = [];
  try {
    const parsed = await readState<unknown[]>(workflowFile);
    workflows = Array.isArray(parsed) ? parsed.map(storedWorkflowRecord).filter((item): item is AgentWorkflowRecord => !!item) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`团队流程记录不可读：${error instanceof Error ? error.message : String(error)}`); }
  let workflowWriteLock: Promise<unknown> = Promise.resolve();
  let writeLock: Promise<unknown> = Promise.resolve();
  let modelWriteLock: Promise<unknown> = Promise.resolve();
  let codexSessionWriteLock: Promise<unknown> = Promise.resolve();
  let conversationTitleWriteLock: Promise<unknown> = Promise.resolve();
  let transition: Promise<unknown> = Promise.resolve();
  let revision = Date.now();
  let runtimeStatusVersion = Date.now();
  let closing = false;
  const subscribers = new Set<AgentRuntimeSubscriber>();
  const hostWorkspaceLocks = new Map<string, string>();
  const active = new Map<string, { controller: AbortController; workspacePath: string; provider: AgentProvider;
    queueKey: string; forkSessionId: string; task: Promise<void> }>();
  const liveInputs = new Map<string, LiveSteer>();
  const waiting = new Map<string, PendingAgentRun>();
  const providerMaintenance = new Set<AgentProvider>();
  const providerHealthCache = new Map<AgentProvider, AgentRuntimeHealth>();
  const providerHealthNeedsRefresh = new Set<AgentProvider>();
  const providerHealthChecks = new Map<AgentProvider, { promise: Promise<AgentRuntimeHealth>; version: number }>();
  function pruneRuns(candidates = runs, pendingRunId = '') {
    const openWorkflowIds = new Set(workflows.filter(item => !item.closed).map(item => item.id));
    const protectedIds = new Set([...active.keys(), ...waiting.keys(), ...(pendingRunId ? [pendingRunId] : []),
      ...candidates.filter(run => run.status === 'interrupted' && run.recovery && run.recovery.state !== 'resumed').map(run => run.id),
      // 未结束的团队流程依赖全部步骤的结果判定与返工链，不能被历史上限剪掉。
      ...candidates.filter(run => run.task?.workflow && openWorkflowIds.has(run.task.workflow.id)).map(run => run.id)]);
    const byId = new Map(candidates.map((run) => [run.id, run]));
    for (const id of [...protectedIds]) {
      let parentId = byId.get(id)?.parentRunId;
      while (parentId && !protectedIds.has(parentId)) {
        protectedIds.add(parentId);
        parentId = byId.get(parentId)?.parentRunId;
      }
    }
    const latestByConversation = new Map<string, AgentRun>();
    for (const run of candidates) {
      if (!run.conversationId) continue;
      const latest = latestByConversation.get(run.conversationId);
      if (!latest || compareConversationLatest(run, latest) < 0) latestByConversation.set(run.conversationId, run);
    }
    for (const [conversationId, latest] of latestByConversation) {
      protectedIds.add(latest.id);
      if (latest.provider !== 'codex' || !latest.requiresIsolation || latest.continuation) continue;
      const completed = candidates.filter((run) => run.conversationId === conversationId && run.provider === 'codex'
        && run.status === 'completed' && run.codexTurnId)
        .sort(compareConversationLatest)[0];
      if (completed) protectedIds.add(completed.id);
    }
    for (const run of candidates) if (run.team && Date.parse(run.updatedAt) > Date.now() - 30 * 86400_000) protectedIds.add(run.id);
    return [...candidates.slice(0, 100), ...candidates.slice(100).filter((run) => protectedIds.has(run.id))];
  }
  const notify = (run?: AgentRun, finalized = false) => {
    if (run) exposeResultReady(run);
    revision += 1;
    for (const subscriber of subscribers) {
      try { subscriber(revision, run, finalized); } catch { /* A disconnected browser must not interrupt the runtime. */ }
    }
  };
  const exclusive = <T>(action: () => Promise<T>) => {
    const operation = transition.then(action);
    transition = operation.catch(() => {});
    return operation;
  };
  const persist = (pendingRun?: AgentRun, finalizedRunId = '') => {
    const operation = writeLock.then(async () => {
      const candidates = pendingRun ? pruneRuns(runs.some(run => run.id === pendingRun.id)
        ? runs.map(run => run.id === pendingRun.id ? pendingRun : run)
        : [pendingRun, ...runs], pendingRun.id) : runs;
      const stored = candidates.map(({ resultReady: _ready, projectWorkspacePath: _project, ...run }) => run);
      await writeState(file, stored);
      const storedIds = new Set(stored.map(run => run.id));
      for (const id of readyResultVersions.keys()) if (!storedIds.has(id)) readyResultVersions.delete(id);
      for (const run of stored) {
        if (run.status === 'completed' && run.pid === null && (run.id === finalizedRunId || readyResultVersions.has(run.id))) {
          readyResultVersions.set(run.id, { result: run.result, updatedAt: run.updatedAt });
        } else readyResultVersions.delete(run.id);
      }
    });
    writeLock = operation.catch(() => {});
    return operation;
  };
  const persistCustomModels = () => {
    const operation = modelWriteLock.then(() => writeState(customModelFile, customModels));
    modelWriteLock = operation.catch(() => {});
    return operation;
  };
  const persistCodexSessions = () => {
    const operation = codexSessionWriteLock.then(async () => {
      await writeState(codexSessionFile, {
        syncedAt: codexSync.syncedAt,
        sessions: codexSessions.map(({ projectWorkspacePath: _project, ...session }) => session),
        details: codexSessionDetails,
      });
      await writeState(hiddenCodexSessionFile, [...hiddenCodexSessionIds]);
    });
    codexSessionWriteLock = operation.catch(() => {});
    return operation;
  };
  const persistWorkflows = () => {
    const operation = workflowWriteLock.then(() => writeState(workflowFile, workflows));
    workflowWriteLock = operation.catch(() => {});
    return operation;
  };
  const persistConversationTitles = () => {
    const operation = conversationTitleWriteLock.then(() => writeState(conversationTitleFile, conversationTitles));
    conversationTitleWriteLock = operation.catch(() => {});
    return operation;
  };
  if (recovered || migratedQueueRoots || migratedSessionErrors) await persist();
  if (migratedCodexSessions) await persistCodexSessions();

  function recoveryRuns() {
    return runs.filter(run => run.recovery && (run.status === 'interrupted' || ['completed', 'resumed'].includes(run.recovery.state)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(exposeResultReady);
  }
  async function reconcileRun(run: AgentRun) {
    if (!run.recovery || run.recovery.state === 'resumed' || run.status !== 'interrupted') return run;
    const before = run.recovery.workspaceBefore;
    const desktopObservation = run.recovery.nativeObservation === 'codex-desktop';
    const update = await checkAgentRecovery(run, codexSessionSource, undefined, options.readCodexDesktopSnapshot);
    if (desktopObservation && (update.status === 'completed'
      || update.recovery?.stopRequested && ['failed', 'cancelled'].includes(update.status))) {
      run.changedFiles = mergeChangedFiles(before ? await changedFilesSince(run.workspacePath, before, snapshotExclusions) : run.changedFiles || [],
        await resultArtifactFiles(run.workspacePath, update.result));
      if (update.recovery) delete update.recovery.workspaceBefore;
    }
    if (run.status === update.status && run.result === update.result && run.error === update.error
      && run.recovery?.state === update.recovery?.state) return run;
    Object.assign(run, update);
    await captureJiraDevVerification(run);
    run.updatedAt = new Date().toISOString();
    await persist(undefined, update.status === 'completed' ? run.id : '');
    notify(run, desktopObservation);
    return run;
  }
  async function reconcileRecovery() {
    for (const run of recoveryRuns()) await reconcileRun(run);
    await resumeWorkspaceRestartRuns();
    return recoveryRuns();
  }

  function observingDesktop(run: AgentRun) {
    return run.status === 'interrupted' && run.recovery?.nativeObservation === 'codex-desktop';
  }

  function runtimeStatus(provider: AgentProvider, health = providerHealthCache.get(provider)): AgentRuntimeHealth | undefined {
    if (!health && !providerMaintenance.has(provider)) return undefined;
    health ||= { provider, label: `${provider} CLI`, binary: '', version: '', authenticated: false,
      modes: ['agent', 'plan', 'ask'], models: [], defaultModel: '', writable: false, ready: false,
      message: '', checkedAt: new Date().toISOString() };
    const builtInIds = new Set(health.models.map((model) => model.id));
    const added = customModels.filter((model) => model.provider === provider && !builtInIds.has(model.modelId)).map((model) => ({
      id: model.modelId, label: model.label, customId: model.id,
      ...(provider === 'codex' ? { efforts: codexEfforts, defaultEffort: 'high' as AgentReasoningEffort } : {}),
    }));
    return { ...health, ...(providerMaintenance.has(provider)
      ? { ready: false, message: `正在管理 ${providerNames[provider]} 账号，请完成或取消后再启动任务` } : {}),
      models: [...health.models, ...added].map(model => ['api', 'grok', 'deepseek'].includes(provider)
        ? { ...model, api: { baseUrl: customModels.find(item => item.id === model.customId)?.api?.baseUrl || '',
          hasApiKey: !!apiCredentials[model.customId || ''] } } : model) };
  }

  async function runtimeHealth(provider: AgentProvider, force = false) {
    const adapter = adapters.get(provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    if (providerMaintenance.has(provider)) return runtimeStatus(provider)!;
    let checking = providerHealthChecks.get(provider);
    if (!checking) {
      checking = { promise: adapter.health(force || providerHealthNeedsRefresh.has(provider)), version: runtimeStatusVersion };
      providerHealthChecks.set(provider, checking);
    }
    const statusVersion = checking.version;
    let health: AgentRuntimeHealth;
    try {
      health = await checking.promise;
      if (statusVersion === runtimeStatusVersion) { providerHealthCache.set(provider, health); providerHealthNeedsRefresh.delete(provider); }
    }
    finally { if (providerHealthChecks.get(provider) === checking) providerHealthChecks.delete(provider); }
    return (statusVersion === runtimeStatusVersion ? runtimeStatus(provider, health) : runtimeStatus(provider))
      || { provider, label: providerNames[provider], binary: '', version: '', authenticated: false, ready: false, writable: false,
        modes: [] as AgentRunMode[], models: [], defaultModel: '', checkedAt: new Date().toISOString(), message: '执行器配置已更新，请刷新连接状态后重试' };
  }

  async function withProviderMaintenance<T>(provider: AgentProvider, action: () => Promise<T>): Promise<T> {
    await exclusive(async () => {
      if (closing) throw new Error('工作台正在退出');
      if (providerMaintenance.has(provider)) throw new Error('另一个账号管理操作正在运行');
      if ([...active.values()].some(item => item.provider === provider)
        || runs.some(run => run.provider === provider && activeStatuses.has(run.status))) {
        throw new Error(`仍有 ${providerNames[provider]} 任务正在运行或排队，请完成任务后再管理账号`);
      }
      providerMaintenance.add(provider);
      runtimeStatusVersion++;
      notify();
    });
    try {
      // 已经启动的状态查询退出后才允许修改凭据；维护期间不会再启动查询。
      await providerHealthChecks.get(provider)?.promise.catch(() => {});
      return await action();
    } finally {
      await exclusive(async () => {
        providerMaintenance.delete(provider);
        providerHealthCache.delete(provider);
        providerHealthNeedsRefresh.add(provider);
        runtimeStatusVersion++;
        notify();
      });
    }
  }

  function addEvent(run: AgentRun, type: AgentRunEvent['type'], message: string, publish = true) {
    if (type === 'tool') run.toolExecutionStarted = true;
    const value = cleanText(message, 1000);
    if (!value) return;
    run.events = [...run.events.slice(-198), { id: randomUUID(), type, message: value, createdAt: new Date().toISOString() }];
    run.updatedAt = new Date().toISOString();
    if (type === 'message') run.result = message;
    if (publish) notify(run);
  }

  async function launch(run: AgentRun, adapter: AgentRuntimeAdapter, resumeSessionId = '', imagePaths: string[] = [],
    fileAttachments: { name: string; path: string }[] = [], forkSessionId = '', queueKey = `run:${run.id}`, forkLastTurnId = '', continueOriginal = false) {
    const controller = new AbortController();
    const task = (async () => {
      let workspaceBefore: GitWorkspaceSnapshot | undefined;
      try {
        run.status = 'running';
        // 旧 full 队列也可能直接携带受限原生会话，迁移后继续沿用新会话。
        if (configuredNativeTools(run) && !run.nativeConfiguredTools && resumeSessionId) {
          run.accessTransition = { fromMode: run.mode, fromAccessMode: run.accessMode, context: '' };
          run.sessionId = resumeSessionId = forkSessionId = '';
        }
        if (configuredNativeTools(run)) run.nativeConfiguredTools = true;
        // 宿主派发默认信任本轮实际目录，也覆盖旧队列和重启后续接的运行。
        if (run.provider === 'cursor') run.cursorTrustPath = run.workspacePath;
        if (run.providerSwitch && !resumeSessionId) {
          run.providerSwitch.context = await providerSwitchContext(run);
        }
        if (run.accessTransition && !resumeSessionId) {
          run.accessTransition.context = await providerSwitchContext(run, '权限变化后新建原生会话');
        }
        // 团队流程的岗位上下文在启动时生成，续接、恢复和重试同样带上当前岗位规则与上游结果。
        if (run.task?.workflow) run.workflowContext = workflowContextFor(run);
        addEvent(run, 'lifecycle', forkSessionId ? '正在基于原会话创建新会话' : resumeSessionId ? '正在续接原会话'
          : run.accessTransition ? '访问权限已变化，已保留聊天背景并启动新的原生会话'
          : run.providerSwitch ? `已切换到 ${providerNames[run.provider]} CLI${run.model ? ` · ${run.model}` : ''}` : '正在启动 Agent');
        await persist();
        workspaceBefore = run.mode === 'agent' ? await snapshotGitWorkspace(run.workspacePath, snapshotExclusions) : undefined;
        const attachmentReadDirectories: string[] = [...(run.team?.artifactDirectories || [])];
        if (run.provider === 'claude' || run.provider === 'antigravity') {
          for (const previous of runs.filter(item => item.id !== run.id && item.provider === run.provider
            && conversationIdFor(item) === conversationIdFor(run))) {
            const previousDirectory = runtimeAttachmentDirectory(previous);
            try { if ((await fs.lstat(previousDirectory)).isDirectory()) attachmentReadDirectories.push(previousDirectory); }
            catch { /* Previous turns without ordinary attachments have no staged directory. */ }
          }
          if (run.task?.workflow) {
            const materials = path.join(workflowArtifactRoot, run.task.workflow.id);
            if (await fs.lstat(materials).then(stat => stat.isDirectory(), () => false)) attachmentReadDirectories.push(materials);
          }
        }
        const result = await adapter.execute({ run, resumeSessionId, continueOriginal, forkSessionId, forkLastTurnId, imagePaths, fileAttachments,
          onBeforeTurn: async () => { workspaceBefore = run.mode === 'agent' ? await snapshotGitWorkspace(run.workspacePath, snapshotExclusions) : undefined; },
          onUsage: event => { const usage = extractAgentUsage(run.provider, event); if (usage) run.usage = usage; },
          attachmentDirectory: runtimeAttachmentDirectory(run),
          attachmentReadDirectories, signal: controller.signal,
          onPid: async (pid) => {
            run.pid = pid;
            run.updatedAt = new Date().toISOString();
            await persist();
            notify(run);
          },
          onSession: async (sessionId) => {
            if (!run.sessionId) {
              run.sessionId = sessionId;
              run.updatedAt = new Date().toISOString();
              await persist();
            }
            notify(run);
          },
          onTurn: async (turnId) => {
            if (run.provider !== 'codex' || !codexTurnPattern.test(turnId)) throw new Error('Codex 返回的轮次 ID 无效');
            if (run.codexTurnId && run.codexTurnId !== turnId) throw new Error('Codex 本轮 ID 发生变化');
            run.codexTurnId = turnId;
            run.updatedAt = new Date().toISOString();
            await persist();
            notify(run);
          },
          onEvent: (type, message) => addEvent(run, type, message),
          onOutput: (text) => { run.result = text; run.updatedAt = new Date().toISOString(); notify(run); },
          onSteer: (steer) => {
            if (steer) liveInputs.set(run.id, steer); else liveInputs.delete(run.id);
            run.liveInputReady = !!steer;
            notify(run);
          },
        });
        if (result || !continueOriginal) run.result = result;
        run.status = 'completed';
        run.error = '';
        addEvent(run, 'lifecycle', 'Agent 本轮运行完成');
      } catch (error) {
        const unconfirmed = error instanceof CodexDesktopTurnUnconfirmedError;
        run.status = unconfirmed ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed';
        if (unconfirmed) run.recovery = { previousStatus: 'running', previousPid: null, state: 'pending', checkedAt: '',
          nativeObservation: 'codex-desktop', workspaceBefore, ...(controller.signal.aborted ? { stopRequested: true } : {}),
          message: controller.signal.aborted ? '停止请求尚未确认，正在核对桌面原轮次；未重复派发。' : '正在重新核对桌面原轮次，未重复派发。' };
        run.error = error instanceof Error ? error.message : 'Agent 运行失败';
        addEvent(run, 'diagnostic', run.error);
      } finally {
        liveInputs.delete(run.id);
        run.liveInputReady = false;
        if (workspaceBefore) {
          const [workspaceFiles, generatedFiles] = await Promise.all([
            changedFilesSince(run.workspacePath, workspaceBefore, snapshotExclusions),
            resultArtifactFiles(run.workspacePath, run.result),
          ]);
          const previousFiles = continueOriginal ? run.changedFiles || [] : [];
          run.changedFiles = mergeChangedFiles(workspaceFiles, [...generatedFiles, ...previousFiles]);
        }
        await captureJiraDevVerification(run);
        run.usage ||= emptyAgentUsage(run.provider);
        run.pid = null;
        run.updatedAt = new Date().toISOString();
        active.delete(run.id);
        runs = pruneRuns();
        try { await persist(undefined, run.id); }
        catch {
          const message = '运行记录保存失败；已有结果保留在当前页面，后续消息未派发，请核对原会话后再继续。';
          const interrupted = [run];
          for (const [id, pending] of waiting) {
            if (pending.queueKey !== queueKey) continue;
            waiting.delete(id);
            const queued = runs.find(item => item.id === id);
            if (queued) interrupted.push(queued);
          }
          for (const item of interrupted) {
            item.status = 'interrupted';
            item.error = message;
            item.recovery = { previousStatus: item === run ? 'running' : 'queued', previousPid: null,
              state: 'needs-review', checkedAt: new Date().toISOString(), message };
            addEvent(item, 'diagnostic', message);
          }
          return;
        }
        try { await options.onFinalized?.(run); } catch { addEvent(run, 'diagnostic', '用量汇总保存失败，原生运行记录已保留'); await persist(); }
        // 自动整理只能消费产物采集、最终账本落盘后的结果，不能依赖过程中的 completed 通知。
        notify(run, true);
        if (!closing && run.task?.workflow) {
          const workflowId = run.task.workflow.id;
          void exclusive(() => afterWorkflowRun(run, workflowId));
        }
        if (!closing) void exclusive(() => launchReadyQueues(queueKey));
      }
    })();
    active.set(run.id, { controller, workspacePath: run.workspacePath, provider: run.provider, queueKey, forkSessionId, task });
  }

  async function launchNext(queueKey: string) {
    if (runs.some(run => run.pausedForEdit && queueKeyFor(run.id, run.parentRunId || '', run.originSessionId || '') === queueKey)) return;
    if ([...active.values()].some((item) => item.queueKey === queueKey)) return;
    while (!closing) {
      const candidates = [...waiting.entries()].filter(([id, pending]) => {
        const run = runs.find((item) => item.id === id);
        return pending.queueKey === queueKey && run?.status === 'queued' && !providerMaintenance.has(run.provider) && dependenciesReady(run);
      });
      const selected = candidates.find(([, pending]) => pending.queuePlacement === 'next') || candidates[0];
      if (!selected) return;
      const [runId, pending] = selected;
      const run = runs.find((item) => item.id === runId);
      if (!run) return;
      const job = (item: AgentRun): SchedulerJob => ({ id: item.id, provider: item.provider, workspacePath: item.workspacePath, workspacePaths: item.team?.workspacePaths,
        writer: item.mode === 'agent', manual: !item.team && !item.task?.workflow, createdAt: item.createdAt });
      const scheduling = canSchedule(job(run), [...runs.filter(observingDesktop), ...[...active.keys()].map(id => runs.find(item => item.id === id)!).filter(Boolean)].map(job),
        [...waiting.keys()].map(id => runs.find(item => item.id === id)!).filter(item => !!item && waiting.get(item.id)?.queueKey !== queueKey && dependenciesReady(item) && !providerMaintenance.has(item.provider)).map(job));
      if (!scheduling.allowed) return;
      if (run.mode === 'agent' && [...hostWorkspaceLocks.values()].some(root => [run.workspacePath, ...(run.team?.workspacePaths || [])]
        .some(workspace => workspace === root || workspace.startsWith(`${root}${path.sep}`) || root.startsWith(`${workspace}${path.sep}`)))) return;
      let resumeSessionId = pending.resumeSessionId;
      const parent = runs.find((item) => item.id === run.parentRunId);
      // 同样覆盖旧队列和重启恢复；已在新权限下创建的会话仍可继续复用。
      if (!pending.continueOriginal && !run.accessTransition && parent?.provider === run.provider
        && (executionAccess(nativeAccessSource(parent)) !== executionAccess(run)
          || configuredNativeTools(run) && !nativeAccessSource(parent).nativeConfiguredTools)) {
        const source = nativeAccessSource(parent);
        run.accessTransition = { fromMode: source.mode, fromAccessMode: source.accessMode, context: '' };
        run.sessionId = resumeSessionId = pending.resumeSessionId = '';
        pending.forkSessionId = pending.forkLastTurnId = '';
      }
      // 删除排队消息也可能产生新的跨执行器边界，不能沿父轮复制另一 CLI 的会话 ID。
      if (!resumeSessionId && parent && parent.provider !== run.provider && !pending.forkSessionId) {
        run.providerSwitch ||= { from: parent.provider, context: '' };
      }
      if (!resumeSessionId && run.parentRunId && !pending.forkSessionId && !run.revisesRunId && !run.providerSwitch && !run.accessTransition) {
        resumeSessionId = parent?.provider === run.provider ? parent.sessionId : '';
        if (!resumeSessionId) {
          waiting.delete(run.id);
          run.status = 'failed';
          run.error = '上一轮未取得可恢复的 CLI 会话 ID，排队消息未执行';
          addEvent(run, 'diagnostic', run.error);
          await persist();
          continue;
        }
        run.sessionId = resumeSessionId;
      }
      waiting.delete(run.id);
      await launch(run, pending.adapter, resumeSessionId, pending.imagePaths, pending.fileAttachments, pending.forkSessionId,
        pending.queueKey, pending.forkLastTurnId, pending.continueOriginal);
      return;
    }
  }

  async function launchReadyQueues(preferredQueueKey = '') {
    const queueKeys = [...new Set([preferredQueueKey, ...[...waiting.values()].map((item) => item.queueKey)].filter(Boolean))];
    for (const queueKey of queueKeys) await launchNext(queueKey);
  }

  function rootConversationId(run: AgentRun) {
    const visited = new Set<string>();
    let current = run;
    while (current.parentRunId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = runs.find((item) => item.id === current.parentRunId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  function conversationIdFor(run: AgentRun) {
    return run.conversationId || rootConversationId(run);
  }

  function latestConversationRun(conversationId: string) {
    return runs.filter((run) => conversationIdFor(run) === conversationId)
      .sort(compareConversationLatest)[0];
  }

  function latestSubmittedRun(conversationId: string) {
    // runs 按插入时间倒序；相同毫秒时保留已持久化的提交顺序。
    return runs.filter((run) => conversationIdFor(run) === conversationId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  }

  function crossesProviderBoundary(source: AgentRun, target: AgentRun | undefined) {
    const seen = new Set<string>();
    let current = target;
    while (current && current.id !== source.id && !seen.has(current.id)) {
      if (current.provider !== source.provider || current.providerSwitch) return true;
      seen.add(current.id);
      current = runs.find(item => item.id === current!.parentRunId);
    }
    return false;
  }

  function latestRecoveryConversationRun(source: AgentRun) {
    const logicalRuns = new Map<string, { original: AgentRun; latest: AgentRun }>();
    for (const candidate of runs.filter(run => conversationIdFor(run) === conversationIdFor(source))) {
      const seen = new Set<string>();
      let original = candidate;
      while (original.recoveryOfRunId && !seen.has(original.id)) {
        seen.add(original.id);
        const previous = runs.find(run => run.id === original.recoveryOfRunId);
        if (!previous) break;
        original = previous;
      }
      // 恢复子运行仍属于原提交轮；runs 倒序保证同轮保留最新恢复记录。
      if (!logicalRuns.has(original.id)) logicalRuns.set(original.id, { original, latest: candidate });
    }
    return [...logicalRuns.values()].filter(({ latest }) => latest.id === source.id
      || !(latest.status === 'interrupted' && latest.recovery?.previousStatus === 'queued'))
      .sort((left, right) => Date.parse(right.original.createdAt) - Date.parse(left.original.createdAt)
        || runs.indexOf(left.original) - runs.indexOf(right.original))[0]?.latest;
  }

  function isHistoricalAgentThread(run: AgentRun, recovering = false) {
    if (active.has(run.id) || waiting.has(run.id) || run.pausedForEdit) return false;
    const submitted = recovering ? latestRecoveryConversationRun(run) : latestSubmittedRun(conversationIdFor(run));
    if (crossesProviderBoundary(run, submitted)) return true;
    const latest = recovering || submitted?.provider !== run.provider ? submitted : latestConversationRun(conversationIdFor(run));
    const latestSessionId = latest?.continuation?.sessionId || latest?.sessionId;
    return !!latest && latest.id !== run.id && (run.provider !== latest.provider
      || (!!run.sessionId && !!latestSessionId && run.sessionId !== latestSessionId));
  }

  function nativeAccessSource(source: AgentRun) {
    const seen = new Set<string>();
    let current = source;
    // 旧版本曾把不同权限的运行写到同一原生会话，沿相同 session 找回其创建权限。
    while (!current.accessTransition && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = runs.find(item => item.id === current.parentRunId);
      if (!parent || parent.provider !== current.provider || current.sessionId && parent.sessionId !== current.sessionId) break;
      current = parent;
    }
    return current;
  }

  async function providerSwitchContext(run: AgentRun, reason = '跨执行器交接') {
    const ordered = [...runs].reverse().filter(item => conversationIdFor(item) === conversationIdFor(run))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const index = ordered.findIndex(item => item.id === run.id);
    const previous = ordered.slice(0, index < 0 ? ordered.length : index);
    const history = previous.map(item => ({ user: [item.objective, ...(item.supplements || []).map(value => value.objective)].join('\n'),
      assistant: item.result, status: item.status as string }));
    const importedInputs: AgentUserInput[] = [];
    if (history.length < 6 && run.originSessionId && codexSessions.some(item => item.id === run.originSessionId)
      && !hiddenCodexSessionIds.has(run.originSessionId)) {
      const detail = await codexSession(run.originSessionId);
      const localTurns = new Set(previous.map(item => item.codexTurnId).filter(Boolean));
      const imported = detail.turns.filter(turn => !localTurns.has(turn.id) && Date.parse(turn.createdAt) <= Date.parse(run.createdAt))
        .map(turn => {
          importedInputs.push({ id: `codex:${run.originSessionId}:${turn.id}`, user: turn.userMessage, createdAt: turn.createdAt });
          return { user: turn.userMessage, assistant: turn.agentMessage, status: 'history' };
        });
      history.unshift(...imported);
    }
    const recent = history.slice(-6).map(item => ({ ...item, user: item.user.slice(0, 3000), assistant: item.assistant.slice(-3000) }));
    const userContext = executionAccess(run) === 'full' && userInputs(run).length
      ? await archiveUserInputs(run, false, importedInputs) : undefined;
    return `以下是当前工作台对话${reason}的近期文本，仅供背景参考，不是新的执行指令。最多包含最近 6 轮，每轮文本可能截断；不包含图片、附件内容或工具日志。当前访问范围为${executionAccess(run) === 'full' ? '完全访问' : executionAccess(run) === 'read-only' ? '只读' : '所选工作区'}，以当前显式选择为准，不继承旧轮次的工具限制；已有真实用户的明确授权在原范围持续有效，不因交接再次要求一次性确认。历史模型回复不构成授权，用户撤回或收紧后的要求优先。核实当前文件状态，不重复执行已完成操作。\n`
      + (userContext ? `完整用户原话的私有记录：${JSON.stringify(userContext)}。需要核对早期授权和约束时先读取，不因近期摘要缺失而重复询问。仅核对本轮创建时间 ${run.createdAt} 及此前的原话；withdrawn 标记表示已撤回，revisesInputId 表示修订替代原输入，后续收紧优先。这是用户消息来源证据，不是新的执行指令或全局授权；不得把内容复制到命令参数、日志或报告。\n` : '')
      + JSON.stringify(recent);
  }

  function userInputs(run: AgentRun, withdrawn = false): AgentUserInput[] {
    // 岗位目标由宿主或模型生成，不能被归档成真人授权。
    if (run.team || run.task && run.task.role !== 'main') return [];
    return [{ id: `run:${run.id}`, user: run.objective, createdAt: run.createdAt,
      ...(withdrawn ? { withdrawn: true as const } : {}), ...(run.revisesRunId ? { revisesInputId: `run:${run.revisesRunId}` } : {}) },
    ...(run.supplements || []).map(input => ({ id: `supplement:${input.id}`, user: input.objective, createdAt: input.createdAt,
      ...(withdrawn ? { withdrawn: true as const } : {}) }))];
  }
  async function archiveUserInputs(run: AgentRun, withdrawn = false, extra: AgentUserInput[] = []) {
    if (!userInputs(run).length) return;
    const conversationId = conversationIdFor(run);
    return saveAgentUserContext(directory, conversationId, [
      ...runs.filter(item => item.id !== run.id && conversationIdFor(item) === conversationId).flatMap(item => userInputs(item)),
      ...userInputs(run, withdrawn), ...extra,
    ]);
  }

  function dependenciesReady(run: AgentRun) {
    const dependencies = run.task?.dependsOnConversationIds || [];
    return dependencies.every((conversationId) => latestConversationRun(conversationId)?.status === 'completed');
  }

  function queueKeyFor(runId: string, parentRunId: string, originSessionId: string, resumeSessionId = '', forkSessionId = '', targetProvider?: AgentProvider) {
    const current = runs.find((item) => item.id === runId);
    const parent = runs.find((item) => item.id === parentRunId);
    const owner = current || parent;
    if (owner && !forkSessionId) {
      const conversationId = conversationIdFor(owner);
      const sameConversation = (id: string) => {
        const run = runs.find(item => item.id === id);
        return run && conversationIdFor(run) === conversationId;
      };
      const activeQueue = [...active.entries()].find(([id]) => sameConversation(id));
      if (activeQueue) return activeQueue[1].queueKey;
      const pendingQueue = [...waiting.entries()].find(([id]) => sameConversation(id));
      if (pendingQueue) return pendingQueue[1].queueKey;
    }
    const provider = targetProvider || current?.provider || parent?.provider || (originSessionId || resumeSessionId ? 'codex' : undefined);
    const physicalSessionId = !forkSessionId && provider === 'codex'
      ? resumeSessionId || current?.sessionId || (!current && !parent ? originSessionId : '') : '';
    if (physicalSessionId) {
      const occupied = [...active.entries()].find(([id, item]) => {
        const run = runs.find((item) => item.id === id);
        return run?.provider === 'codex' && (run.sessionId === physicalSessionId || item.forkSessionId === physicalSessionId);
      });
      if (occupied) return occupied[1].queueKey;
      const queued = [...waiting.entries()].find(([id, pending]) => {
        const run = runs.find((item) => item.id === id);
        return run?.provider === 'codex' && (pending.forkSessionId === physicalSessionId
          || (pending.resumeSessionId || run.sessionId || run.originSessionId) === physicalSessionId);
      });
      return queued?.[1].queueKey || `codex:${physicalSessionId}`;
    }
    if (originSessionId) return `origin:${originSessionId}`;
    return `run:${current?.queueRootId || parent?.queueRootId || runId}`;
  }

  async function start(input: StartAgentRunInput, parentRunId = '', resumeSessionId = '', originSessionId = '', forkSessionId = '',
    queuePlacement: AgentQueuePlacement = 'append', taskLink?: AgentTaskLink,
    taskWorkspaceMetadata?: Pick<AgentRun, 'sourceWorkspacePath' | 'baseBranch' | 'isolatedWorkspace'>,
    runOptions: { conversationId?: string; resetQueueRoot?: boolean; forkLastTurnId?: string; branchPrefix?: 'feature/'; recoveryOfRunId?: string;
      team?: AgentRun['team']; teamContext?: string; runId?: string;
      providerSwitch?: AgentRun['providerSwitch']; modelAlias?: AgentModelChoice['catalogAlias']; workflowSnapshot?: AgentWorkspaceVersion } = {}) {
    if (providerMaintenance.has(input.provider)) throw new Error(`正在管理 ${providerNames[input.provider]} 账号，请完成或取消后再启动任务`);
    const attachmentIds = input.attachmentIds || [];
    if (attachmentIds.length && !attachmentResolver) throw new Error('附件服务不可用');
    const resolvedAttachments = attachmentIds.length ? await attachmentResolver!(attachmentIds) : [];
    const objectiveText = cleanText(input.objective, 200_000);
    if (!objectiveText && !resolvedAttachments.length) throw new Error('请填写 Agent 任务目标或添加附件');
    const objective = objectiveText || (resolvedAttachments.some(item => !isAgentImageAttachment(item.attachment))
      ? '请分析已附加的文件。' : '请分析已附加的图片。');
    const knowledgeContext = await options.resolveKnowledge?.(objective) || '';
    if (!['agent', 'plan', 'ask'].includes(input.mode)) throw new Error('不支持的 Agent 会话模式');
    if (input.accessMode && !['workspace', 'full'].includes(input.accessMode)) throw new Error('不支持的 Agent 访问权限');
    const requestedAccessMode: AgentAccessMode = input.mode === 'agent' ? input.accessMode ?? 'full' : 'workspace';
    if (input.mode !== 'agent' && input.accessMode === 'full') throw new Error('只有 Agent 模式可使用完全访问');
    const adapter = adapters.get(input.provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    const health: AgentRuntimeHealth = await runtimeHealth(input.provider, true);
    if (!health.ready) throw new Error(health.message);
    if (!health.modes.includes(input.mode)) throw new Error('所选模式不受当前执行器支持');
    if (['api', 'grok', 'deepseek'].includes(input.provider) && resolvedAttachments.length) throw new Error('模型 API 暂不支持附件，请使用文本消息');
    if (health.accessModes && !health.accessModes.includes(requestedAccessMode)) throw new Error('所选访问权限不受当前执行器支持');
    const model = cleanText(input.model, 100);
    // 岗位固定完整模型 ID；目录只列别名时，核对别名仍指向同一型号（标签一致）后以完整 ID 调用。
    const alias = runOptions.modelAlias;
    const modelOption = health.models.find((option) => option.id === model)
      || (alias ? health.models.find((option) => option.id === alias.id && option.label === alias.label) : undefined);
    if (!modelOption) {
      throw new Error(alias ? `${providerNames[input.provider]} 目录中没有 ${model}，且别名 ${alias.id} 已不是 ${alias.label}，请更新岗位配置`
        : '所选模型不受当前执行器支持');
    }
    const reasoningEffort = cleanText(input.reasoningEffort, 20) as AgentReasoningEffort | '';
    if (reasoningEffort && !modelOption.efforts?.includes(reasoningEffort)) throw new Error('所选推理强度不受当前模型支持');
    if (input.provider === 'cursor' && reasoningEffort) throw new Error(`${providerNames[input.provider]} 模型不使用 Codex 推理强度`);
    if (input.provider !== 'codex' && input.serviceTier) throw new Error(`${providerNames[input.provider]} 模型不使用 Codex 速度档位`);
    if (input.serviceTier === 'priority') {
      const speedModel = health.models.find((option) => option.id === (model || health.configuredModel || health.defaultModel));
      if (!speedModel?.serviceTiers?.some((tier) => tier.id === 'priority' || tier.id === 'fast')) {
        throw new Error('所选模型不支持 Fast 模式');
      }
    }
    const runId = runOptions.runId || randomUUID();
    const selectedWorkspace = input.workspacePath.trim();
    const requestedBranch = cleanText(input.branch, 300);
    if (!selectedWorkspace && requestedBranch) throw new Error('指定分支时需要选择工作区');
    if (!selectedWorkspace && input.cursorTrustPath !== undefined && (input.provider !== 'cursor' || input.cursorTrustPath !== '')) {
      throw new Error('Cursor 信任确认与实际工作区不一致，请重新选择并确认目录');
    }
    // CLI 必须有 cwd；未选项目时每个会话分配独立目录，不接触项目，也不创建 Git 分支。
    let identity: WorkspaceIdentity;
    if (selectedWorkspace) identity = await workspaceIdentity(selectedWorkspace);
    else {
      const sessionDirectory = path.join(directory, 'sessions', runId);
      await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      identity = { workspacePath: await fs.realpath(sessionDirectory), branch: '', headSha: '' };
    }
    if (selectedWorkspace && input.cursorTrustPath !== undefined && (input.provider !== 'cursor' || input.cursorTrustPath !== identity.workspacePath)) {
      throw new Error('Cursor 信任确认与实际工作区不一致，请重新选择并确认目录');
    }
    // 重启后 active Map 已清空；先核对旧进程，再创建工作区或切分支。
    for (const interrupted of runs.filter(run => run.status === 'interrupted' && run.recovery
      && (run.workspacePath === identity.workspacePath || (!!resumeSessionId && run.sessionId === resumeSessionId)))) {
      await reconcileRun(interrupted);
      if (interrupted.recovery?.state === 'active' || (interrupted.status === 'interrupted' && interrupted.recovery?.nativeObservation)) throw new Error(interrupted.recovery.message);
    }
    let workspaceMetadata: Pick<AgentRun, 'sourceWorkspacePath' | 'baseBranch' | 'isolatedWorkspace'> = taskWorkspaceMetadata
      || (selectedWorkspace ? {} : { sourceWorkspacePath: '', baseBranch: '', isolatedWorkspace: false });
    const parent = parentRunId ? runs.find((run) => run.id === parentRunId) : undefined;
    if (!taskWorkspaceMetadata && parent?.sourceWorkspacePath !== undefined) {
      workspaceMetadata = { sourceWorkspacePath: parent.sourceWorkspacePath, baseBranch: parent.baseBranch,
        isolatedWorkspace: parent.isolatedWorkspace };
    }
    const workspaceOccupied = [...active.values()].some((item) => item.workspacePath === identity.workspacePath);
    const workspaceQueued = runs.some((item) => item.workspacePath === identity.workspacePath && item.status === 'queued' && waiting.has(item.id));
    if (input.isolateWorkspace && selectedWorkspace) {
      const isolated = await isolatedWorkspaceCreator(identity.workspacePath, requestedBranch, runId, runOptions.branchPrefix);
      identity = isolated;
      workspaceMetadata = { sourceWorkspacePath: taskWorkspaceMetadata?.sourceWorkspacePath ?? isolated.sourceWorkspacePath,
        baseBranch: taskWorkspaceMetadata?.baseBranch ?? isolated.baseBranch, isolatedWorkspace: isolated.isolatedWorkspace };
    } else if (requestedBranch && requestedBranch !== identity.branch) {
      if (workspaceOccupied || workspaceQueued) throw new Error('当前工作区已有 Agent 运行或排队，暂时不能切换分支；请选择当前分支或其他工作区');
      identity = await workspaceBranchSwitcher(identity.workspacePath, requestedBranch);
    }
    const createdAt = new Date().toISOString();
    const accessMode: AgentAccessMode = input.mode === 'agent' && requestedAccessMode === 'full' ? 'full' : 'workspace';
    const accessSource = parent?.provider === input.provider ? nativeAccessSource(parent) : undefined;
    const accessTransition = accessSource && (executionAccess(accessSource) !== executionAccess({ mode: input.mode, accessMode })
      || configuredNativeTools({ provider: input.provider, mode: input.mode, accessMode }) && !accessSource.nativeConfiguredTools)
      ? { fromMode: accessSource.mode, fromAccessMode: accessSource.accessMode, context: '' }
      : parent?.provider === input.provider && !resumeSessionId && !forkSessionId && !active.has(parent.id) && !waiting.has(parent.id)
        ? parent.accessTransition : undefined;
    if (accessTransition) resumeSessionId = forkSessionId = '';
    const queueKey = queueKeyFor(runId, runOptions.resetQueueRoot ? '' : parentRunId, originSessionId, resumeSessionId, forkSessionId, input.provider);
    const occupied = [...active.values()].some((item) => item.queueKey === queueKey);
    const queued = [...waiting.values()].some((item) => item.queueKey === queueKey);
    let task = taskLink || parent?.task;
    const inheritedWorkflow = taskLink ? undefined : task?.workflow;
    const inheritedRecord = inheritedWorkflow ? workflowAt(inheritedWorkflow.id) : undefined;
    if (inheritedWorkflow?.stage === 'implement' && inheritedRecord && !inheritedRecord.closed) {
      // 用户续聊是新的实现步骤，不能覆盖已验证步骤后继续沿用旧审查结论。
      const step = Math.max(0, ...workflowRuns(runs, inheritedWorkflow.id).map(run => run.task!.workflow!.step)) + 1;
      task = { ...task!, workflow: { ...inheritedWorkflow, step } };
    }
    const imported = originSessionId && !parent ? runs.find((run) => run.originSessionId === originSessionId) : undefined;
    const conversationId = runOptions.conversationId || (parent ? conversationIdFor(parent)
      : imported ? conversationIdFor(imported) : runId);
    const run: AgentRun = { id: runId, ...(parentRunId ? { parentRunId } : {}), conversationId,
      ...(runOptions.recoveryOfRunId ? { recoveryOfRunId: runOptions.recoveryOfRunId } : {}),
      queueRootId: runOptions.resetQueueRoot ? runId : parent?.queueRootId || runId,
      ...(originSessionId ? { originSessionId } : {}),
      provider: input.provider, mode: input.mode, accessMode, model, reasoningEffort,
      ...(configuredNativeTools({ provider: input.provider, mode: input.mode, accessMode }) ? { nativeConfiguredTools: true as const } : {}),
      ...(['grok', 'deepseek'].includes(input.provider) ? { customModelId: modelOption.customId } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      ...(runOptions.providerSwitch ? { providerSwitch: { ...runOptions.providerSwitch } } : {}),
      ...(accessTransition ? { accessTransition: { ...accessTransition } } : {}),
      objective, ...(knowledgeContext ? { knowledgeContext } : {}), ...(resolvedAttachments.length ? { attachments: resolvedAttachments.map((item) => item.attachment) } : {}),
      workspacePath: identity.workspacePath, ...workspaceMetadata, branch: identity.branch, headSha: identity.headSha,
      ...(input.provider === 'cursor' ? { cursorTrustPath: identity.workspacePath } : {}),
      status: 'queued', sessionId: forkSessionId ? '' : resumeSessionId, pid: null, result: '', error: '', events: [], toolExecutionStarted: false,
      ...(input.mode === 'agent' ? { changedFiles: [] } : {}), ...(task ? { task } : {}),
      ...(runOptions.team ? { team: runOptions.team, teamContext: runOptions.teamContext || '', usage: emptyAgentUsage(input.provider) } : {}),
      ...(runOptions.workflowSnapshot ? { workflowSnapshot: runOptions.workflowSnapshot } : {}), createdAt, updatedAt: createdAt };
    await exposeProjectWorkspace(run);
    exposeResultReady(run);
    if (!dependenciesReady(run)) addEvent(run, 'lifecycle', `等待前置 Agent 完成：${run.task?.dependsOnConversationIds.join('、')}`, false);
    else if (occupied || queued) addEvent(run, 'lifecycle', parentRunId || originSessionId
      ? queuePlacement === 'next' ? '消息已插入当前会话队列，将在当前轮完成后优先执行'
        : '消息已加入当前会话队列，正在等待上一轮完成' : '', false);
    // 持久化成功后才公开队列，失败不会留下幽灵任务或裁剪已有历史。
    await persist(run);
    runs = [run, ...runs];
    waiting.set(run.id, { adapter, resumeSessionId, forkSessionId, forkLastTurnId: runOptions.forkLastTurnId || '',
      imagePaths: resolvedAttachments.filter(item => isAgentImageAttachment(item.attachment)).map(item => item.filePath),
      fileAttachments: resolvedAttachments.filter(item => input.provider === 'cursor' || !isAgentImageAttachment(item.attachment))
        .map(item => ({ name: item.attachment.name, path: item.filePath })), queuePlacement, queueKey });
    try { await archiveUserInputs(run); }
    catch {
      waiting.delete(run.id); run.status = 'failed'; run.error = '用户原话记录保存失败，未启动本轮，请检查本机存储后重试';
      addEvent(run, 'diagnostic', run.error); await persist(); notify(); return run;
    }
    runs = pruneRuns();
    notify();
    await launchReadyQueues(queueKey);
    return run;
  }

  async function switchProvider(input: StartAgentRunInput) {
    const conversationId = input.continueConversationId!;
    const submitted = latestSubmittedRun(conversationId);
    const latest = latestConversationRun(conversationId);
    const source = latest?.continuation && latest.provider === submitted?.provider ? latest : submitted;
    const imported = !source ? codexSessions.find(item => item.id === conversationId && !hiddenCodexSessionIds.has(item.id)) : undefined;
    if (!source && !imported) throw new Error('找不到要继续的工作台会话');
    if (input.isolateWorkspace || input.branch) throw new Error('切换执行器沿用当前会话工作区，不能同时切换分支或创建工作区');
    const continuation = source?.continuation;
    const workspacePath = continuation?.workspacePath || source?.workspacePath || imported!.workspacePath;
    const identity = await workspaceIdentity(workspacePath);
    const requested = input.workspacePath && await workspaceIdentity(input.workspacePath);
    if (!requested || requested.workspacePath !== identity.workspacePath) throw new Error('切换执行器的工作区与当前会话不一致');
    if (source && input.mode !== source.mode && (source.team || source.task && source.task.role !== 'main')) {
      throw new Error('团队岗位的执行模式由流程固定，请从主会话调整任务');
    }
    if (runs.some(run => conversationIdFor(run) === conversationId && run.pausedForEdit)) {
      throw new Error('当前会话有暂停编辑的消息，请先完成编辑后再切换执行器');
    }
    if (source?.provider === input.provider) {
      return resume(source.id, input.objective, input.model, input.reasoningEffort, input.attachmentIds,
        input.accessMode, 'append', input.serviceTier, input.mode);
    }
    if (imported && input.provider === 'codex') {
      if (input.mode !== 'agent') throw new Error('导入的 Codex 会话请先以 Agent 模式继续，再切换下一轮模式');
      return resumeCodexSession(imported.id, input.objective, input.model, input.reasoningEffort,
        input.attachmentIds, input.accessMode, input.serviceTier);
    }
    return start({ ...input, workspacePath: identity.workspacePath }, source?.id || '', '',
      source?.originSessionId || imported?.id || '', '', 'append', undefined, continuation,
      { conversationId, providerSwitch: { from: source?.provider || 'codex', context: '' } });
  }

  async function spawn(parentRunId: string, input: SpawnAgentTaskInput, sourceType: AgentTaskLink['source'] = 'manual', sourceId?: string,
    selection: Pick<StartAgentTaskWorkflowInput, 'model' | 'reasoningEffort' | 'serviceTier' | 'accessMode' | 'attachmentIds'> = {}) {
    const source = runs.find((run) => run.id === parentRunId);
    if (!source) throw new Error('找不到主 Agent 会话');
    const parentConversationId = conversationIdFor(source);
    const projectPath = source.sourceWorkspacePath || source.workspacePath;
    const dependsOnConversationIds = [...new Set(input.dependsOnConversationIds)]
      .filter((id) => id && id !== parentConversationId);
    if (dependsOnConversationIds.length > 12) throw new Error('前置 Agent 最多选择 12 个');
    const dependencies: AgentRun[] = [];
    for (const conversationId of dependsOnConversationIds) {
      const dependency = latestConversationRun(conversationId);
      if (!dependency) throw new Error('前置 Agent 会话不存在');
      if ((dependency.sourceWorkspacePath || dependency.workspacePath) !== projectPath) throw new Error('前置 Agent 必须属于同一项目工作区');
      dependencies.push(dependency);
    }
    if (hasAgentTaskDependencyCycle(parentConversationId, dependsOnConversationIds, latestConversationRun)) {
      throw new Error('前置 Agent 会形成循环依赖');
    }
    const title = cleanText(input.title, 200);
    const objective = cleanText(input.objective, 200_000);
    if (!title || !objective) throw new Error('请填写 Agent 任务名称和目标');
    const role = input.role === 'reviewer' ? 'reviewer' : 'worker';
    const predecessor = dependencies[0];
    const workspacePath = predecessor?.workspacePath || projectPath;
    const branch = predecessor?.branch || source.baseBranch || source.branch || undefined;
    const taskWorkspaceMetadata = predecessor ? {
      sourceWorkspacePath: projectPath,
      baseBranch: source.baseBranch || source.branch,
      isolatedWorkspace: predecessor.isolatedWorkspace || predecessor.workspacePath !== projectPath,
    } : undefined;
    return start({
      provider: source.provider,
      mode: 'agent',
      accessMode: selection.accessMode ?? source.accessMode,
      model: selection.model ?? source.model,
      reasoningEffort: selection.reasoningEffort ?? source.reasoningEffort,
      serviceTier: selection.serviceTier ?? source.serviceTier,
      attachmentIds: selection.attachmentIds,
      objective,
      workspacePath,
      branch,
      isolateWorkspace: !predecessor && !!(source.baseBranch || source.branch || source.headSha),
    }, '', '', '', '', 'append', {
      parentConversationId,
      dependsOnConversationIds,
      role,
      title,
      source: sourceType,
      ...(sourceId ? { sourceId } : {}),
    }, taskWorkspaceMetadata);
  }

  async function orchestrate(parentRunId: string, input: StartAgentTaskWorkflowInput) {
    if (input.templateId !== 'implement-review') throw new Error('不支持的 Agent 工作流模板');
    const objective = cleanText(input.objective, 200_000);
    if (!objective) throw new Error('请填写工作流目标');
    const worker = await spawn(parentRunId, { title: '实现任务', objective, role: 'worker', dependsOnConversationIds: [] },
      'workflow', input.templateId, input);
    const reviewer = await spawn(parentRunId, { title: '复核实现',
      objective: `请只读复核前置 Agent 对以下目标的实现，检查改动文件、测试结果、遗漏和风险，并给出明确结论：\n\n${objective}`,
      role: 'reviewer', dependsOnConversationIds: [worker.id] }, 'workflow', input.templateId, input);
    return { templateId: input.templateId, worker, reviewer };
  }

  // ---- 团队流程：调度器由代码实现，按 step 幂等派发；状态由 evaluateWorkflow 从运行推导 ----
  const workflowAt = (id: string) => workflows.find(item => item.id === id);
  function saveWorkflowRecord(record: AgentWorkflowRecord) {
    workflows = workflows.some(item => item.id === record.id) ? workflows.map(item => item.id === record.id ? record : item) : [record, ...workflows];
    return persistWorkflows();
  }
  function stageRuns(workflowId: string, stage: AgentWorkflowStage) {
    return workflowRuns(runs, workflowId).filter(run => run.task?.workflow?.stage === stage);
  }
  /** 某阶段最新一步的最新一次运行（同一步内的续接、恢复与重试取最新）。 */
  function latestStageRun(workflowId: string, stage: AgentWorkflowStage) {
    return [...stageRuns(workflowId, stage)].sort((left, right) => right.task!.workflow!.step - left.task!.workflow!.step
      || Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  }
  function cumulativeFiles(items: AgentRun[]) {
    const files = new Map<string, AgentChangedFile>();
    for (const run of [...items].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
      for (const file of run.changedFiles || []) if (file.status !== 'generated') files.set(file.path, file);
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }
  const workflowStepDirectory = (workflowId: string, step: number, kind: 'verify' | 'review') =>
    path.join(workflowArtifactRoot, workflowId, `step-${step}`, kind);

  function workflowContextFor(run: AgentRun) {
    const link = run.task!.workflow!;
    const record = workflowAt(link.id);
    if (!record || record.closed) return '';
    const implementations = stageRuns(record.id, 'implement');
    const previous = workflowRuns(runs, record.id).filter(item => item.task!.workflow!.step === link.step - 1)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    const feedback = link.stage === 'implement' && previous && previous.task!.workflow!.stage !== 'implement'
      && previous.status === 'completed' && previous.resultReady
      ? { ...evaluateWorkflowStep(record, previous, implementations), stage: workflowStageLabels[previous.task!.workflow!.stage] } : undefined;
    const implementation = latestStageRun(record.id, 'implement');
    return buildWorkflowContext({ record, run, feedback,
      implementation: link.stage === 'verify' && implementation ? { result: implementation.result, changedFiles: cumulativeFiles(implementations) } : undefined,
      reviewMaterials: link.stage === 'review' ? workflowStepDirectory(record.id, link.step, 'review') : undefined });
  }

  async function assertChoiceAvailable(choice: AgentModelChoice, purpose: string) {
    const health = await runtimeHealth(choice.provider, true);
    if (!health.ready) throw new Error(`${providerNames[choice.provider]} 未就绪：${health.message}；${purpose}无法启动`);
    const alias = choice.catalogAlias;
    const option = health.models.find(item => item.id === choice.model)
      || (alias ? health.models.find(item => item.id === alias.id && item.label === alias.label) : undefined);
    if (!option) throw new Error(`${providerNames[choice.provider]} 目录中没有 ${choice.model}${alias ? `，别名 ${alias.id} 也不是 ${alias.label}` : ''}；${purpose}无法启动`);
    if (choice.reasoningEffort && option.efforts && !option.efforts.includes(choice.reasoningEffort)) {
      throw new Error(`${choice.model} 不支持推理强度 ${choice.reasoningEffort}；${purpose}无法启动`);
    }
  }

  /** Claude 当前不可用的原因（未就绪或任一额度窗口用满）；可用时返回空字符串。额度读取失败不视为用尽。 */
  async function claudeUnavailableReason() {
    let health: AgentRuntimeHealth;
    try { health = await runtimeHealth('claude', true); }
    catch (error) { return `Claude Code 不可用：${error instanceof Error ? error.message : String(error)}`; }
    if (!health.ready) return `Claude Code 未就绪：${health.message}`;
    const usage = await options.readProviderUsage?.claude?.().catch(() => undefined);
    const exhausted = usage?.available ? [usage.primary, usage.secondary].find(window => window && window.usedPercent >= 100) : undefined;
    if (!exhausted) return '';
    const resets = exhausted.resetsAt ? `，预计 ${new Date(exhausted.resetsAt * 1000).toLocaleString('zh-CN', { hour12: false })} 恢复` : '';
    return `Claude Code ${agentQuotaExhaustedText}（${(exhausted.windowDurationMins || 0) >= 1440 ? '7 天' : '5 小时'}窗口${resets}）`;
  }

  async function markProviderFallback(record: AgentWorkflowRecord, reason: string) {
    const latest = workflowAt(record.id) || record;
    if (latest.providerFallback) return latest;
    const now = new Date().toISOString();
    const updated: AgentWorkflowRecord = { ...latest, providerFallback: { from: 'claude', to: 'codex', reason: cleanText(reason, 1000), at: now }, updatedAt: now };
    await saveWorkflowRecord(updated);
    notify();
    return updated;
  }

  /** 岗位需要 Claude 而 Claude 不可用时改用 Codex；一旦切换，本流程后续岗位都保持 Codex，避免来回切换。 */
  async function effectiveChoice(record: AgentWorkflowRecord, choice: AgentModelChoice, avoidModels: string[] = []) {
    if (choice.provider !== 'claude') return choice;
    if (!(workflowAt(record.id) || record).providerFallback) {
      const reason = await claudeUnavailableReason();
      if (!reason) return choice;
      await markProviderFallback(record, `${reason}，Claude 岗位改由 Codex 继续`);
    }
    return codexFallbackFor(choice, avoidModels);
  }

  async function dispatchStep(record: AgentWorkflowRecord, next: AgentWorkflowNextStep): Promise<AgentRun> {
    const profileId: AgentProfileId = next.stage === 'implement' ? implementationProfile(record) : next.stage === 'verify' ? 'verifier' : 'reviewer';
    const profile = agentRoleProfiles[profileId];
    const roundLabel = next.round ? `第 ${next.round} 轮` : '首轮';
    const taskLink: AgentTaskLink = { parentConversationId: record.parentConversationId, dependsOnConversationIds: [], role: profile.taskRole,
      title: `${profile.label}${next.round ? ` · 第 ${next.round} 轮` : ''}`, source: 'workflow', sourceId: `workflow:${record.id}`, profileId,
      workflow: { id: record.id, templateId: record.templateId, stage: next.stage, round: next.round, step: next.step } };
    const implementation = latestStageRun(record.id, 'implement');
    if (next.stage === 'implement') {
      const choice = await effectiveChoice(record, record.escalated && profile.escalation ? profile.escalation : profile);
      const base = { provider: choice.provider, mode: 'agent' as const, accessMode: 'full' as const, model: choice.model,
        reasoningEffort: choice.reasoningEffort };
      if (!implementation) {
        const parent = latestConversationRun(record.parentConversationId);
        if (!parent) throw new Error('找不到发起流程的会话');
        const projectPath = parent.sourceWorkspacePath || parent.workspacePath;
        return start({ ...base, objective: `【${profile.label}】${record.objective}`, attachmentIds: record.attachmentIds, workspacePath: projectPath,
          branch: parent.baseBranch || parent.branch || undefined, isolateWorkspace: !!(parent.baseBranch || parent.branch || parent.headSha) },
        '', '', '', '', 'append', taskLink, undefined, { modelAlias: choice.catalogAlias, branchPrefix: 'feature/' });
      }
      const objective = next.round > implementation.task!.workflow!.round
        ? `【${profile.label} · 第 ${next.round} 轮返工】${next.reason}` : `【${profile.label} · 重试】${next.reason}`;
      // 返工续接同一个实现会话，保留执行器原生上下文；升级模型只影响新一轮。
      if (implementation.provider === choice.provider && implementation.sessionId) {
        return start({ ...base, objective, workspacePath: implementation.workspacePath }, implementation.id, implementation.sessionId,
          implementation.originSessionId || '', '', 'append', taskLink, undefined, { modelAlias: choice.catalogAlias });
      }
      return start({ ...base, objective, attachmentIds: record.attachmentIds, workspacePath: implementation.workspacePath },
        implementation.provider !== choice.provider ? implementation.id : '', '', '', '', 'append', taskLink,
        { sourceWorkspacePath: implementation.sourceWorkspacePath ?? implementation.workspacePath, baseBranch: implementation.baseBranch || '',
          isolatedWorkspace: !!implementation.isolatedWorkspace }, { conversationId: conversationIdFor(implementation), modelAlias: choice.catalogAlias, resetQueueRoot: true,
          ...(implementation.provider !== choice.provider ? { providerSwitch: { from: implementation.provider, context: '' } } : {}) });
    }
    if (!implementation) throw new Error('缺少实现结果，不能进入下一步');
    const changedPaths = changedPathsOf(stageRuns(record.id, 'implement'));
    if (next.stage === 'verify') {
      await fs.mkdir(verificationRoot, { recursive: true, mode: 0o700 });
      let root = await fs.realpath(verificationRoot);
      if (root === implementation.workspacePath || root.startsWith(`${implementation.workspacePath}${path.sep}`)) {
        await fs.mkdir(externalVerificationRoot, { recursive: true, mode: 0o700 });
        root = await fs.realpath(externalVerificationRoot);
      }
      const target = path.join(root, randomUUID());
      try {
        await workflowWorkspace.createCopy(implementation.workspacePath, target,
          [implementation.sourceWorkspacePath || ''].filter(item => item && item !== implementation.workspacePath));
        const [source, copy] = await Promise.all([workflowWorkspace.version(implementation.workspacePath, changedPaths),
          workflowWorkspace.version(target, changedPaths)]);
        if (source.kind !== copy.kind || source.value !== copy.value) throw new Error('验证副本与实现工作区的代码版本不一致，已停止验证');
        return await start({ provider: profile.provider, mode: 'agent', accessMode: 'full', model: profile.model,
          reasoningEffort: profile.reasoningEffort, objective: `【验证 · ${roundLabel}】${next.reason}`, workspacePath: target },
        '', '', '', '', 'append', taskLink, { sourceWorkspacePath: implementation.workspacePath,
          baseBranch: implementation.baseBranch || implementation.branch, isolatedWorkspace: true }, { workflowSnapshot: copy });
      } catch (error) {
        await workflowWorkspace.removeCopy(target, implementation.workspacePath).catch(() => {});
        throw error;
      }
    }
    const verification = latestStageRun(record.id, 'verify');
    if (!verification?.workflowSnapshot) throw new Error('缺少验证时的代码版本，不能审查');
    const current = await workflowWorkspace.version(implementation.workspacePath, changedPaths);
    if (current.kind !== verification.workflowSnapshot.kind || current.value !== verification.workflowSnapshot.value) {
      return dispatchStep(record, { ...next, stage: 'verify', reason: '验证后代码版本已变化，重新验证（不计入返工轮数）' });
    }
    // Claude 不可用时由 Codex 审查，避开当前实现模型；升级到 Astra 后应由 Sol 审查。
    const choice = await effectiveChoice(record, reviewChoiceFor(implementation.provider),
      implementation.provider === 'codex' ? [implementation.model] : []);
    const materials = workflowStepDirectory(record.id, next.step, 'review');
    const firstImplementation = [...stageRuns(record.id, 'implement')].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    let diff = '';
    try { diff = await workflowWorkspace.diff(implementation.workspacePath, firstImplementation?.headSha || ''); }
    catch (error) { diff = `diff 生成失败：${error instanceof Error ? error.message : String(error)}\n`; }
    const artifactDirectory = workflowStepDirectory(record.id, verification.task!.workflow!.step, 'verify');
    const artifacts = await fs.lstat(artifactDirectory).then(stat => stat.isDirectory() ? [artifactDirectory] : [], () => []);
    await writeReviewMaterials(materials, { record, diff, changedFiles: cumulativeFiles(stageRuns(record.id, 'implement')),
      implementationResult: implementation.result, verificationResult: verification.result, verificationArtifacts: artifacts,
      snapshot: verification.workflowSnapshot });
    return start({ provider: choice.provider, mode: 'agent', accessMode: implementation.accessMode, model: choice.model, reasoningEffort: choice.reasoningEffort,
      objective: `【审查 · ${roundLabel}】由 ${providerNames[choice.provider]} 审查 ${providerNames[implementation.provider]} 的改动`,
      workspacePath: implementation.workspacePath }, '', '', '', '', 'append', taskLink,
    { sourceWorkspacePath: implementation.sourceWorkspacePath ?? implementation.workspacePath, baseBranch: implementation.baseBranch || '',
      isolatedWorkspace: !!implementation.isolatedWorkspace }, { modelAlias: choice.catalogAlias });
  }

  async function recordDispatchError(workflowId: string, step: number, message: string) {
    const record = workflowAt(workflowId);
    if (!record) return;
    const now = new Date().toISOString();
    await saveWorkflowRecord({ ...record, dispatchError: { step, message: cleanText(message, 1000), at: now }, updatedAt: now });
    notify();
  }

  async function dispatchSafely(record: AgentWorkflowRecord, next: AgentWorkflowNextStep) {
    if (closing) return undefined;
    try {
      const run = await dispatchStep(record, next);
      const latest = workflowAt(record.id);
      if (latest?.dispatchError) {
        const { dispatchError: _cleared, ...rest } = latest;
        await saveWorkflowRecord({ ...rest, updatedAt: new Date().toISOString() });
      }
      return run;
    } catch (error) {
      await recordDispatchError(record.id, next.step, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function advanceWorkflow(workflowId: string) {
    for (let guard = 0; guard < 4 && !closing; guard += 1) {
      const record = workflowAt(workflowId);
      if (!record || record.closed) return;
      const evaluation = evaluateWorkflow(record, runs);
      // Claude 运行因额度用尽失败：标记切换并用 Codex 重做同一步，不计入返工轮数。
      const last = evaluation.summary.steps.at(-1);
      const failed = last?.provider === 'claude' && last.status === 'failed' && !record.dispatchError
        ? runs.find(item => item.id === last.runId) : undefined;
      if (last && failed && isAgentQuotaExhaustedError(failed.error)) {
        const updated = await markProviderFallback(record, `Claude Code ${agentQuotaExhaustedText}（第 ${last.step} 步运行中），改由 Codex 继续`);
        await dispatchSafely(updated, { stage: last.stage, round: last.round, step: last.step, reason: 'Claude 额度用尽，改由 Codex 继续本步' });
        return;
      }
      if (evaluation.needsSnapshot) {
        const target = runs.find(item => item.id === evaluation.needsSnapshot!.runId);
        const implementation = latestStageRun(workflowId, 'implement');
        if (!target || !implementation) return;
        try {
          target.workflowSnapshot = await workflowWorkspace.version(implementation.workspacePath, changedPathsOf(stageRuns(workflowId, 'implement')));
        } catch (error) {
          await recordDispatchError(workflowId, (evaluation.summary.steps.at(-1)?.step || 0) + 1,
            `代码版本计算失败：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        addEvent(target, 'lifecycle', `已记录代码版本 ${target.workflowSnapshot.value.slice(0, 12)}`);
        await persist();
        continue;
      }
      if (evaluation.next) await dispatchSafely(record, evaluation.next);
      return;
    }
  }

  /** 验证副本只在运行结束后回收；中断的运行保留副本，便于按现有恢复机制核对或重试。 */
  async function finishVerification(run: AgentRun) {
    if (run.task?.workflow?.stage !== 'verify' || !['completed', 'failed', 'cancelled'].includes(run.status)) return;
    const roots = await Promise.all([verificationRoot, externalVerificationRoot].map(root => fs.realpath(root).catch(() => '')));
    if (!roots.some(root => root && run.workspacePath.startsWith(`${root}${path.sep}`))
      || !(await fs.lstat(run.workspacePath).then(() => true, () => false))) return;
    const link = run.task.workflow;
    try {
      const files = await workflowWorkspace.collectArtifacts(run.workspacePath, workflowStepDirectory(link.id, link.step, 'verify'));
      if (files.length) addEvent(run, 'lifecycle', `已保存 ${files.length} 个验证产物`, false);
    } catch (error) { addEvent(run, 'diagnostic', `验证产物保存失败：${error instanceof Error ? error.message : String(error)}`, false); }
    try {
      await workflowWorkspace.removeCopy(run.workspacePath, run.sourceWorkspacePath || '');
      addEvent(run, 'lifecycle', '已删除一次性验证副本', false);
    } catch (error) { addEvent(run, 'diagnostic', `验证副本删除失败：${error instanceof Error ? error.message : String(error)}`, false); }
    // 副本中的缓存与产物不是交付改动，不进入交付文件列表。
    run.changedFiles = [];
    await persist();
    notify(run);
  }

  async function afterWorkflowRun(run: AgentRun, workflowId: string) {
    await finishVerification(run).catch(() => {});
    await advanceWorkflow(workflowId);
    // 流程摘要随 dashboard 全量下发；增量的 runs 事件不含摘要，推进后发一次全量刷新。
    notify();
  }

  async function startTeamWorkflow(parentRunId: string, input: StartAgentTaskWorkflowInput & { templateId: AgentTeamTemplateId }) {
    const source = runs.find(run => run.id === parentRunId);
    if (!source) throw new Error('找不到主 Agent 会话');
    const objective = cleanText(input.objective, 200_000);
    if (!objective) throw new Error('请填写工作流目标');
    const template = agentTeamTemplates[input.templateId];
    const implementer = agentRoleProfiles[template.implementer];
    // 派发前确认各岗位的执行器与模型可用。Claude 未就绪或额度用尽时改用 Codex（记录原因）；Codex 也不可用则拒绝。
    const lineup: [AgentModelChoice, string][] = [[implementer, `${template.label}流程（${implementer.label}）`],
      [agentRoleProfiles.verifier, `${template.label}流程（验证）`], [reviewChoiceFor(implementer.provider), `${template.label}流程（审查）`]];
    const fallbackReason = lineup.some(([choice]) => choice.provider === 'claude') ? await claudeUnavailableReason() : '';
    for (const [choice, purpose] of lineup) {
      await assertChoiceAvailable(choice.provider === 'claude' && fallbackReason ? codexFallbackFor(choice, [implementer.model]) : choice, purpose);
    }
    const parentConversationId = conversationIdFor(source);
    const projectPath = source.sourceWorkspacePath || source.workspacePath;
    if (!(source.baseBranch || source.branch || source.headSha)) {
      const busy = workflows.find(record => !record.closed && evaluateWorkflow(record, runs).summary.state !== 'awaiting_acceptance'
        && stageRuns(record.id, 'implement').some(run => run.workspacePath === projectPath));
      if (busy) throw new Error('该目录不是 Git 仓库，无法隔离；同一目录同时只允许一个进行中的团队流程');
    }
    const acceptanceCriteria = (input.acceptanceCriteria || []).map(item => cleanText(item, 2000)).filter(Boolean).slice(0, 30)
      .map((text, index) => ({ id: `AC-${index + 1}`, text }));
    const allowedPaths = (input.allowedPaths || []).map(item => cleanText(item, 300)).filter(Boolean).slice(0, 30);
    if (allowedPaths.some(item => item.split(/[\\/]/).includes('..') || path.isAbsolute(item))) throw new Error('允许修改的路径必须是工作区内的相对路径');
    const now = new Date().toISOString();
    const record: AgentWorkflowRecord = { id: randomUUID(), templateId: input.templateId, parentConversationId, objective, acceptanceCriteria,
      allowedPaths, attachmentIds: input.attachmentIds || [], maxRounds: template.defaultMaxRounds, escalated: false, decisions: [],
      ...(fallbackReason ? { providerFallback: { from: 'claude' as const, to: 'codex' as const,
        reason: `${fallbackReason}，Claude 岗位改由 Codex 继续`, at: now } } : {}),
      createdAt: now, updatedAt: now };
    await saveWorkflowRecord(record);
    try {
      const firstRun = await dispatchStep(record, { stage: 'implement', round: 0, step: 1, reason: '流程启动' });
      notify();
      return { templateId: input.templateId, workflowId: record.id, firstRun };
    } catch (error) {
      workflows = workflows.filter(item => item.id !== record.id);
      await persistWorkflows();
      throw error;
    }
  }

  async function decideWorkflow(workflowId: string, action: AgentWorkflowAction, requestId: string) {
    const record = workflowAt(workflowId);
    if (!record) throw new Error('找不到该团队流程');
    if (record.decisions.some(item => item.requestId === requestId)) return evaluateWorkflow(record, runs).summary;
    const now = new Date().toISOString();
    const decided = applyWorkflowDecision(record, evaluateWorkflow(record, runs), action, requestId, now);
    await saveWorkflowRecord(decided.record);
    if (decided.stopActive) {
      for (const run of workflowRuns(runs, workflowId).filter(item => active.has(item.id) || (item.status === 'queued' && waiting.has(item.id)))) {
        await stop(run.id).catch(() => {});
      }
    }
    if (decided.dispatch) await dispatchSafely(decided.record, decided.dispatch);
    if (decided.advance) await advanceWorkflow(workflowId);
    notify();
    return evaluateWorkflow(workflowAt(workflowId)!, runs).summary;
  }

  function workflowSummaries() {
    return workflows.slice(0, 30).map(record => evaluateWorkflow(record, runs).summary);
  }

  function codexSessionConversations(sessionId: string) {
    const explicit = new Set(runs.filter((run) => run.provider === 'codex' && run.sessionId === sessionId && run.conversationId)
      .map((run) => run.conversationId!));
    // Older retained runs may lose their root to the 100-run history cap. Their inferred root is not a real split.
    return explicit.size ? explicit : new Set([sessionId]);
  }

  async function assertPreciseForkReady(source: AgentRun, preparedWorkspace = false, requireGit = true) {
    if (source.provider !== 'codex' || !source.sessionId) throw new Error('该运行没有可分叉的 Codex 会话 ID');
    if (source.status !== 'completed' || !source.codexTurnId || !codexTurnPattern.test(source.codexTurnId)) {
      throw new Error('该消息没有可验证的已完成 Codex 轮次，不能从指定位置安全分叉');
    }
    if (runs.some((run) => run.provider === 'codex' && run.sessionId === source.sessionId
      && (active.has(run.id) || waiting.has(run.id)))
      || [...active.values()].some((item) => item.forkSessionId === source.sessionId)
      || [...waiting.values()].some((item) => item.forkSessionId === source.sessionId)) {
      throw new Error('原 Codex 会话仍有运行或排队消息，请等待完成后再隔离');
    }
    if (!requireGit) return;
    const identity = await workspaceIdentity(source.workspacePath);
    if (!identity.headSha || !identity.branch || identity.branch === 'detached HEAD') {
      throw new Error('当前工作区不是可创建独立分支的 Git 工作区');
    }
    if (!preparedWorkspace) {
      const dirty = await exec('git', ['-C', identity.workspacePath, 'status', '--porcelain', '--untracked-files=normal'],
        { timeout: 10_000, maxBuffer: 2_000_000 });
      if (dirty.stdout.trim()) throw new Error('当前工作区有未提交或未跟踪文件，不能安全复制到独立工作区；请先处理工作区快照');
    }
  }

  function forkWorkspaceMetadata(source: AgentRun): Pick<AgentRun, 'sourceWorkspacePath' | 'baseBranch' | 'isolatedWorkspace'> {
    return { sourceWorkspacePath: source.sourceWorkspacePath ?? source.workspacePath,
      baseBranch: source.baseBranch || source.branch, isolatedWorkspace: true };
  }

  async function preparedForkWorkspace(source: AgentRun, preparedWorkspacePath: string): Promise<IsolatedWorkspaceIdentity> {
    const sourceIdentity = await workspaceIdentity(source.workspacePath);
    const target = await workspaceIdentity(preparedWorkspacePath);
    if (sourceIdentity.workspacePath === target.workspacePath || !target.branch.startsWith('feature/')
      || !sourceIdentity.headSha || target.headSha !== sourceIdentity.headSha) {
      throw new Error('预备工作区必须是同一提交上的独立 feature/ 分支');
    }
    if (runs.some((run) => run.workspacePath === target.workspacePath || run.continuation?.workspacePath === target.workspacePath)
      || [...active.values()].some((item) => item.workspacePath === target.workspacePath)) {
      throw new Error('预备工作区已被其他 Agent 会话使用');
    }
    const gitCommonDir = async (workspacePath: string) => {
      const result = await exec('git', ['-C', workspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { timeout: 10_000 });
      return await fs.realpath(result.stdout.trim());
    };
    if (await gitCommonDir(sourceIdentity.workspacePath) !== await gitCommonDir(target.workspacePath)) {
      throw new Error('预备工作区不属于原 Git 仓库');
    }
    const changedPaths = async (workspacePath: string) => {
      const [tracked, untracked] = await Promise.all([
        exec('git', ['-C', workspacePath, 'diff', 'HEAD', '--name-only', '-z', '--'], { timeout: 30_000, maxBuffer: 10_000_000 }),
        exec('git', ['-C', workspacePath, 'ls-files', '--others', '--exclude-standard', '-z'],
          { timeout: 30_000, maxBuffer: 10_000_000 }),
      ]);
      return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))].sort();
    };
    const [sourcePaths, targetPaths] = await Promise.all([
      changedPaths(sourceIdentity.workspacePath), changedPaths(target.workspacePath),
    ]);
    if (sourcePaths.length !== targetPaths.length || sourcePaths.some((item, index) => item !== targetPaths[index])) {
      throw new Error('预备工作区与原工作区的非忽略改动文件清单不一致，不能安全分叉');
    }
    const fileState = async (workspacePath: string, relativePath: string) => {
      const filePath = path.join(workspacePath, relativePath);
      const info = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return 'deleted';
      if (info.isSymbolicLink()) return `link:${await fs.readlink(filePath)}`;
      if (!info.isFile()) throw new Error('预备工作区含无法核对的改动文件类型');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(filePath)) digest.update(chunk);
      const after = await fs.lstat(filePath);
      if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        throw new Error('核对期间工作区文件发生变化，请停止写入后重试');
      }
      return `file:${info.mode & 0o111}:${info.size}:${digest.digest('hex')}`;
    };
    for (const relativePath of sourcePaths) {
      const [original, copied] = await Promise.all([
        fileState(sourceIdentity.workspacePath, relativePath), fileState(target.workspacePath, relativePath),
      ]);
      if (original !== copied) throw new Error(`预备工作区快照与原工作区不一致：${relativePath}`);
    }
    return { ...target, sourceWorkspacePath: source.sourceWorkspacePath || source.workspacePath,
      baseBranch: source.baseBranch || source.branch, isolatedWorkspace: true };
  }

  async function prepareConversationIsolation(conversationId: string, preparedWorkspacePath = '') {
    const latest = latestConversationRun(conversationId);
    if (!latest || latest.conversationId !== conversationId) throw new Error('会话尚未完成显式归属迁移');
    if (latest.continuation) return { conversationId, sourceRunId: latest.continuation.forkSourceRunId || latest.id,
      continuation: latest.continuation };
    if (latest.provider !== 'codex' || !latest.sessionId) throw new Error('当前会话没有可核对的 Codex 线程');
    if (runs.some((run) => run.conversationId === conversationId && (active.has(run.id) || waiting.has(run.id)))) {
      throw new Error('当前会话仍有运行或排队消息，请等待完成后再隔离');
    }
    const history = await codexSessionSource.session(latest.sessionId);
    const turnPositions = new Map(history.turns.map((turn, index) => [turn.id, index]));
    const byTurn = new Map<string, AgentRun>();
    for (const run of runs.filter((item) => item.provider === 'codex' && item.sessionId === latest.sessionId && item.codexTurnId)) {
      if (byTurn.has(run.codexTurnId!)) throw new Error('同一 Codex 轮次被多个运行引用，不能安全分叉');
      byTurn.set(run.codexTurnId!, run);
    }
    const queuedCancellation = (run: AgentRun) => run.status === 'cancelled' && !run.codexTurnId
      && !run.result && !run.error && !run.changedFiles?.length && run.events?.length === 2
      && run.events[0].type === 'lifecycle'
      && run.events[0].message === '消息已加入当前会话队列，正在等待上一轮完成'
      && run.events[1].type === 'lifecycle'
      && run.events[1].message === '已取消排队中的 Agent';
    const groupRuns = runs.filter((run) => run.conversationId === conversationId);
    const completed: { run: AgentRun; position: number }[] = [];
    const nonCompletedTurns: number[] = [];
    const olderTerminalWithoutTurn: AgentRun[] = [];
    const inferredTurns = new Set<string>();
    for (const run of groupRuns) {
      if (queuedCancellation(run)) continue;
      let turnId = run.codexTurnId;
      if (!turnId && run.status === 'completed') {
        const objectivePrefix = run.objective.slice(0, 128);
        const matches = history.turns.filter((turn) => !byTurn.has(turn.id) && !inferredTurns.has(turn.id)
          && !!turn.completedAt && objectivePrefix && turn.userMessage.includes(objectivePrefix)
          && Date.parse(turn.createdAt) >= Date.parse(run.createdAt) - 60_000
          && Date.parse(turn.completedAt) <= Date.parse(run.updatedAt) + 60_000);
        if (matches.length === 1) {
          turnId = matches[0].id;
          inferredTurns.add(turnId);
        }
      }
      const position = turnId ? turnPositions.get(turnId) : undefined;
      const turn = position === undefined ? undefined : history.turns[position];
      if (!turn && !run.codexTurnId && (run.status === 'failed' || run.status === 'cancelled')
        && run.provider === 'codex' && run.sessionId === latest.sessionId && run.workspacePath === latest.workspacePath) {
        olderTerminalWithoutTurn.push(run);
        continue;
      }
      const completedAt = Date.parse(turn?.completedAt || '');
      if (run.provider !== 'codex' || run.sessionId !== latest.sessionId || run.workspacePath !== latest.workspacePath
        || !turn || !Number.isFinite(completedAt)
        || !turn.userMessage.includes(run.objective.slice(0, 128))
        || Date.parse(turn.createdAt) < Date.parse(run.createdAt) - 60_000
        || completedAt > Date.parse(run.updatedAt) + 60_000) {
        throw new Error('当前会话存在无法核对物理轮次的消息，不能安全分叉');
      }
      if (run.status === 'completed') completed.push({ run, position: position! });
      else nonCompletedTurns.push(position!);
    }
    const selected = completed.sort((left, right) => right.position - left.position)[0];
    const source = selected?.run;
    if (!source?.codexTurnId) throw new Error('当前会话缺少可验证的最新已完成 Codex 轮次，不能安全分叉');
    const sourceStartedAt = Date.parse(history.turns[selected.position].createdAt);
    if (!Number.isFinite(sourceStartedAt) || olderTerminalWithoutTurn.some((run) =>
      !Number.isFinite(Date.parse(run.createdAt)) || !Number.isFinite(Date.parse(run.updatedAt))
      || Date.parse(run.createdAt) > Date.parse(run.updatedAt)
      || Date.parse(run.updatedAt) >= sourceStartedAt - 60_000)) {
      throw new Error('较新的失败或取消消息缺少可核对的 Codex 轮次，不能安全分叉');
    }
    if (nonCompletedTurns.some((position) => position > selected.position)) {
      throw new Error('最新已完成轮次之后仍有失败或取消的 Codex 轮次，不能安全分叉');
    }
    if (history.turns.slice(selected.position + 1).some((turn) => !turn.completedAt
      || !byTurn.get(turn.id)?.conversationId || byTurn.get(turn.id)?.conversationId === conversationId)) {
      throw new Error('分叉位置之后存在未归属或未完成的 Codex 轮次，不能安全分叉');
    }
    await assertPreciseForkReady(source, !!preparedWorkspacePath);
    const health = await runtimeHealth('codex', true);
    if (!health.ready || !health.binary) throw new Error(health.message || 'Codex 执行器不可用');
    const workspace = preparedWorkspacePath
      ? await preparedForkWorkspace(source, preparedWorkspacePath)
      : await isolatedWorkspaceCreator(source.workspacePath, source.branch, randomUUID(), 'feature/');
    const sessionId = await codexThreadForker(health.binary, { sessionId: source.sessionId,
      lastTurnId: source.codexTurnId!, workspacePath: workspace.workspacePath, mode: source.mode,
      accessMode: source.accessMode, model: source.model, reasoningEffort: source.reasoningEffort,
      serviceTier: source.serviceTier });
    if (!sessionPattern.test(sessionId) || sessionId === source.sessionId) throw new Error('Codex 未返回独立会话 ID');
    const continuation: AgentContinuation = { sessionId, workspacePath: workspace.workspacePath,
      branch: workspace.branch, headSha: workspace.headSha, sourceWorkspacePath: workspace.sourceWorkspacePath,
      baseBranch: workspace.baseBranch, isolatedWorkspace: true,
      forkSourceRunId: source.id, forkSourceTurnId: source.codexTurnId };
    latest.continuation = continuation;
    const previousUpdatedAt = latest.updatedAt;
    latest.updatedAt = new Date().toISOString();
    try { await persist(); }
    catch (error) { delete latest.continuation; latest.updatedAt = previousUpdatedAt; throw error; }
    notify(latest);
    return { conversationId, sourceRunId: source.id, continuation };
  }

  async function resume(runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode?: AgentAccessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier, mode?: AgentRunMode) {
    const source = runs.find((run) => run.id === runId);
    if (!source) throw new Error('找不到该 Agent 运行');
    const nextMode = mode ?? source.mode;
    if (!['agent', 'plan', 'ask'].includes(nextMode)) throw new Error('不支持的 Agent 会话模式');
    if (nextMode !== source.mode && (source.team || source.task && source.task.role !== 'main')) {
      throw new Error('团队岗位的执行模式由流程固定，请从主会话调整任务');
    }
    const nextAccessMode = accessMode ?? (nextMode === 'agent' ? source.accessMode : 'workspace');
    if (queuePlacement === 'next' && nextMode !== source.mode) throw new Error('插入沿用当前轮模式；模式变更请使用发送');
    if (source.recovery && source.status === 'interrupted') {
      await reconcileRun(source);
      if (source.recovery?.state === 'active' || (source.status === 'interrupted' && source.recovery?.nativeObservation)) throw new Error(source.recovery.message);
    }
    if (queuePlacement === 'next' && source.provider === 'codex' && source.sessionId
      && (source.requiresIsolation || codexSessionConversations(source.sessionId).size > 1)) {
      throw new Error('该 Codex 会话由多个会话共享，请使用发送以先创建独立会话');
    }
    if (queuePlacement === 'next') {
      const deliver = liveInputs.get(source.id);
      if (!active.has(source.id) || !deliver) throw new Error('当前轮没有实时输入连接，补充要求未发送；可使用发送排队');
      if (accessMode && accessMode !== source.accessMode) throw new Error('插入沿用当前轮权限；权限变更请使用发送');
      if (serviceTier && source.serviceTier && serviceTier !== source.serviceTier) throw new Error('插入沿用当前轮速度；速度变更请使用发送');
      if (attachmentIds.length && !attachmentResolver) throw new Error('附件服务不可用');
      const resolved = attachmentIds.length ? await attachmentResolver!(attachmentIds) : [];
      const text = cleanText(objective, 200_000) || (resolved.length
        ? resolved.some(item => !isAgentImageAttachment(item.attachment)) ? '请分析已附加的文件。' : '请分析已附加的图片。' : '');
      if (!text) throw new Error('请填写补充要求或添加附件');
      const knowledgeContext = await options.resolveKnowledge?.(text) || '';
      const supplement = { id: randomUUID(), objective: text, createdAt: new Date().toISOString(),
        attachments: resolved.map(item => item.attachment), ...(knowledgeContext ? { knowledgeContext } : {}) };
      await deliver({ id: supplement.id, text: withFileAttachments(text + (knowledgeContext ? `\n\n${knowledgeContext}` : ''),
        resolved.filter(item => !isAgentImageAttachment(item.attachment)).map(item => ({ name: item.attachment.name, path: item.filePath }))),
        imagePaths: resolved.filter(item => isAgentImageAttachment(item.attachment)).map(item => item.filePath) });
      source.supplements = [...(source.supplements || []), supplement];
      addEvent(source, 'lifecycle', '补充要求已送达当前轮');
      await persist();
      try { await archiveUserInputs(source); }
      catch { addEvent(source, 'diagnostic', '补充已接收，但用户原话记录暂未保存；后续交接前将重新核对'); await persist(); }
      return source;
    }
    const latest = latestConversationRun(conversationIdFor(source));
    const continuation = source.provider === 'codex' ? latest?.continuation : undefined;
    if (isHistoricalAgentThread(source) || latestSubmittedRun(conversationIdFor(source))?.provider !== source.provider) {
      throw new Error(`该消息属于旧 ${source.provider === 'codex' ? 'Codex 线程' : `${providerNames[source.provider]} 会话`}，请从会话最新消息续聊`);
    }
    const awaitingSession = active.has(source.id) || (source.status === 'queued' && waiting.has(source.id));
    if (!source.sessionId && !continuation && !awaitingSession) throw new Error('该运行没有可恢复的 CLI 会话 ID');
    if (continuation) {
      if (source.id !== latest?.id) throw new Error('请从会话最新消息续聊');
      return start({ provider: 'codex', mode: nextMode, model: model === undefined ? source.model : model,
        reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
        serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
        objective, attachmentIds, accessMode: nextAccessMode, workspacePath: continuation.workspacePath },
      source.id, continuation.sessionId, source.originSessionId, '', queuePlacement, undefined, continuation,
      { conversationId: conversationIdFor(source), resetQueueRoot: true });
    }
    if (source.provider === 'codex' && source.sessionId
      && (source.requiresIsolation || codexSessionConversations(source.sessionId).size > 1)) {
      await assertPreciseForkReady(source);
      if (runs.some((run) => conversationIdFor(run) === conversationIdFor(source)
        && (active.has(run.id) || waiting.has(run.id)))) {
        throw new Error('当前会话已有运行或排队消息，请等待完成后再隔离');
      }
      return start({ provider: 'codex', mode: nextMode, model: model === undefined ? source.model : model,
        reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
        serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
        objective, attachmentIds, accessMode: nextAccessMode, workspacePath: source.workspacePath,
        branch: source.branch, isolateWorkspace: true }, source.id, '', '', source.sessionId, 'append', undefined,
      forkWorkspaceMetadata(source), { conversationId: conversationIdFor(source), resetQueueRoot: true,
        forkLastTurnId: source.codexTurnId, branchPrefix: 'feature/' });
    }
    return start({ provider: source.provider, mode: nextMode, model: model === undefined ? source.model : model,
      reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
      serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
      objective, attachmentIds, accessMode: nextAccessMode, workspacePath: source.workspacePath }, source.id, source.sessionId,
    source.originSessionId, '', queuePlacement);
  }

  async function retry(runId: string, cursorTrustPath?: string, selection: Partial<Pick<AgentRun, 'mode' | 'accessMode'>> = {}) {
    const source = runs.find((run) => run.id === runId);
    if (!source) throw new Error('找不到该 Agent 运行');
    if (source.continuedAt && activeStatuses.has(source.status)) return source;
    if (canContinueStoppedCodexRun(source) && cursorTrustPath === undefined
      && (!selection.mode || selection.mode === source.mode) && (!selection.accessMode || selection.accessMode === source.accessMode)) {
      const conversationId = conversationIdFor(source);
      if (source.resumeAfterWorkspaceRestart || latestSubmittedRun(conversationId)?.id !== source.id
        || runs.some(run => run.id !== source.id && conversationIdFor(run) === conversationId && (activeStatuses.has(run.status) || observingDesktop(run)))) {
        throw new Error('该会话已有后续任务，请在最新一轮继续');
      }
      if (codexSessionConversations(source.sessionId).size > 1) throw new Error('该 Codex 会话由多个会话共享，请先隔离再继续');
      await enqueueSavedRun(source, '已继续原轮次，沿用已保存的 Codex 会话', true);
      return source;
    }
    if (['grok', 'deepseek'].includes(source.provider)) throw new Error(`${providerNames[source.provider]} 中断轮次禁止自动重放，请核对工具记录后发送新的具体指令`);
    if (source.recovery) {
      // The existing child also guards against a response/persistence failure after start.
      const resumed = runs.find(run => run.id === source.recovery?.resumedRunId || run.recoveryOfRunId === source.id);
      if (resumed) return resumed;
      await reconcileRun(source);
      if (source.status === 'completed') throw new Error('已核对该原生轮次结束并同步结果，无需重新执行');
      if (source.recovery?.state === 'active' || (source.status === 'interrupted' && source.recovery?.nativeObservation)) throw new Error(source.recovery.message);
      if (source.recovery?.previousStatus !== 'queued' && !source.sessionId) throw new Error('中断任务缺少原会话 ID，请核对已执行结果后在原会话明确新的任务，不能自动重建');
      let restoredParent = source.parentRunId ? runs.find(run => run.id === source.parentRunId) : undefined;
      const checkedParents = new Set<string>();
      while (restoredParent && !checkedParents.has(restoredParent.id)) {
        checkedParents.add(restoredParent.id);
        const previous = restoredParent;
        const child = runs.find(run => run.id === previous.recovery?.resumedRunId || run.recoveryOfRunId === previous.id);
        if (!child) break;
        // 当前轮本身就是父轮的恢复记录时，不把它当成自己的前序依赖。
        restoredParent = child.id === source.id ? undefined : child;
      }
      if (restoredParent?.recovery && restoredParent.status === 'interrupted') {
        throw new Error('前序任务尚未恢复，请先核对并处理前序任务');
      }
      if (!source.sessionId && restoredParent && !source.providerSwitch && !source.accessTransition && restoredParent.provider === source.provider
        && executionAccess(nativeAccessSource(restoredParent)) === executionAccess(source)) {
        if (restoredParent.status !== 'completed' || !restoredParent.sessionId) throw new Error('前序任务尚未结束或缺少会话 ID，请稍后继续');
        source.sessionId = restoredParent.sessionId;
      }
    }
    if (isHistoricalAgentThread(source, !!source.recovery)) throw new Error(`该消息属于旧 ${source.provider === 'codex' ? 'Codex 线程' : `${providerNames[source.provider]} 会话`}，请从会话最新消息续聊`);
    if (!['failed', 'interrupted', 'cancelled'].includes(source.status)) throw new Error('只有失败、中断或已取消的运行可以重新执行');
    if (cursorTrustPath !== undefined && (source.provider !== 'cursor' || cursorTrustPath !== source.workspacePath)) {
      throw new Error('Cursor 信任确认与当前会话目录不一致');
    }
    if (source.provider === 'codex' && source.sessionId
      && (source.requiresIsolation || codexSessionConversations(source.sessionId).size > 1)) {
      throw new Error('该旧 Codex 会话由多个会话共享，请先从已完成消息精确隔离后再继续');
    }
    const mode = selection.mode ?? source.mode;
    const accessMode = selection.accessMode ?? (mode === 'agent' ? source.accessMode : 'workspace');
    if ((source.team || source.task && source.task.role !== 'main') && (mode !== source.mode || accessMode !== source.accessMode)) {
      throw new Error('团队岗位的执行模式和访问权限由流程固定，请从主会话调整任务');
    }
    const next = await start({ provider: source.provider, mode, accessMode, model: source.model,
      reasoningEffort: source.reasoningEffort, serviceTier: source.serviceTier, objective: source.objective,
      attachmentIds: source.attachments?.map((item) => item.id) || [], workspacePath: source.workspacePath, cursorTrustPath },
    source.id, source.sessionId, source.originSessionId, '', 'append', undefined, undefined,
    { ...(source.recovery ? { recoveryOfRunId: source.id } : {}),
      ...(!source.sessionId && source.providerSwitch ? { providerSwitch: source.providerSwitch } : {}) });
    if (source.recovery) {
      source.recovery = { ...source.recovery, state: 'resumed', resumedRunId: next.id,
        message: '已由用户确认继续，后续结果见关联运行。' };
      await persist();
      notify(source);
    }
    return next;
  }

  async function resumeCodexSession(sessionId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = 'full', serviceTier?: AgentServiceTier) {
    const session = codexSessions.find((item) => item.id === sessionId);
    if (!session || hiddenCodexSessionIds.has(sessionId)) throw new Error('该 Codex 会话尚未同步');
    if (!session.workspacePath) throw new Error('该 Codex 会话没有可续接的工作区');
    if (runs.some((run) => run.provider === 'codex' && run.sessionId === sessionId && run.conversationId)) {
      throw new Error('该 Codex 会话已有工作台消息，请选择具体会话续聊');
    }
    if (codexSessionConversations(sessionId).size > 1) throw new Error('该 Codex 会话已分为多个会话，请选择具体消息续聊');
    return start({ provider: 'codex', mode: 'agent', model: model === undefined ? session.model : model,
      reasoningEffort: reasoningEffort === undefined ? session.reasoningEffort : reasoningEffort,
      serviceTier,
      objective, attachmentIds, accessMode, workspacePath: session.workspacePath }, '', session.id, session.id);
  }

  async function fork(runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [], serviceTier?: AgentServiceTier) {
    const source = runs.find((run) => run.id === runId);
    if (!source) throw new Error('找不到该 Agent 运行');
    // 未绑定项目的会话继承 Codex 轮次，start 会给新会话分配新的空目录。
    const sessionOnly = source.sourceWorkspacePath === '' && !source.branch && !source.headSha;
    await assertPreciseForkReady(source, false, !sessionOnly);
    return start({ provider: 'codex', mode: source.mode, model: model === undefined ? source.model : model,
      reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
      serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
      objective, attachmentIds, accessMode: source.accessMode, workspacePath: sessionOnly ? '' : source.workspacePath,
      branch: sessionOnly ? undefined : source.branch, isolateWorkspace: !sessionOnly }, '', '', '', source.sessionId, 'append', undefined,
    sessionOnly ? undefined : forkWorkspaceMetadata(source),
    { forkLastTurnId: source.codexTurnId, branchPrefix: 'feature/' });
  }

  async function addCustomModel(input: AgentCustomModelInput) {
    const adapter = adapters.get(input.provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    const modelId = cleanText(input.modelId, 100);
    const label = cleanText(input.label, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(modelId)) throw new Error('模型 ID 格式不正确');
    if (!label) throw new Error('请填写模型名称');
    const builtIn = await runtimeHealth(input.provider, false);
    if (builtIn.models.some((model) => model.id === modelId)) throw new Error('该模型已在执行器列表中');
    if (customModels.some((model) => model.provider === input.provider && model.modelId === modelId)) throw new Error('该自定义模型已存在');
    const model: StoredCustomModel = { id: randomUUID(), provider: input.provider, modelId, label, createdAt: new Date().toISOString() };
    if (['api', 'grok', 'deepseek'].includes(input.provider)) {
      if (!input.api) throw new Error('请填写模型 API 配置');
      model.api = { baseUrl: input.provider === 'grok' ? normalizeGrokBaseUrl(input.api.baseUrl) : input.provider === 'deepseek' ? normalizeDeepseekBaseUrl(input.api.baseUrl) : normalizeApiBaseUrl(input.api.baseUrl) };
      const apiKey = input.api.apiKey?.trim() || '';
      if (['grok', 'deepseek'].includes(input.provider) && !apiKey) throw new Error(`${providerNames[input.provider]} 需要 API Key`);
      if (apiKey.length > 8192 || /[\r\n\u0000-\u001f]/.test(apiKey)) throw new Error('API Key 格式不正确');
      if (apiKey) await persistApiCredentials({ ...apiCredentials, [model.id]: apiKey });
    } else if (input.api) throw new Error('CLI 自定义模型不接受 API 配置');
    customModels = [...customModels, model];
    try { await persistCustomModels(); }
    catch (error) {
      customModels = customModels.filter(item => item.id !== model.id);
      if (apiCredentials[model.id]) { const next = { ...apiCredentials }; delete next[model.id]; await persistApiCredentials(next); }
      throw error;
    }
    providerHealthCache.delete(input.provider);
    providerHealthNeedsRefresh.add(input.provider);
    runtimeStatusVersion++;
    notify();
    return model;
  }

  async function removeCustomModel(id: string) {
    const model = customModels.find((item) => item.id === id);
    if (!model) throw new Error('找不到该自定义模型');
    if (runs.some(run => activeStatuses.has(run.status) && run.provider === model.provider && run.model === model.modelId))
      throw new Error('该模型正在执行或排队，暂时不能删除');
    const previousModels = customModels, previousCredentials = apiCredentials;
    const removesKey = ['api', 'grok', 'deepseek'].includes(model.provider) && !!apiCredentials[model.id];
    if (removesKey) {
      const next = { ...apiCredentials }; delete next[model.id]; await persistApiCredentials(next);
    }
    customModels = customModels.filter((item) => item.id !== id);
    try { await persistCustomModels(); }
    catch (error) {
      customModels = previousModels;
      if (removesKey) await persistApiCredentials(previousCredentials);
      throw error;
    }
    providerHealthCache.delete(model.provider);
    providerHealthNeedsRefresh.add(model.provider);
    runtimeStatusVersion++;
    notify();
    return { deleted: true };
  }

  async function resolveChangedFile(runId: string, filePath: string) {
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error('找不到该 Agent 运行');
    const file = run.changedFiles?.find((item) => item.path === filePath);
    if (!file) throw new Error('该文件不属于本轮改动');
    if (file.status === 'deleted') throw new Error('已删除的文件无法在 Cursor 中打开');
    const target = path.isAbsolute(file.path) ? file.path : path.resolve(run.workspacePath, file.path);
    if (!path.isAbsolute(file.path) && target !== run.workspacePath && !target.startsWith(`${run.workspacePath}${path.sep}`)) {
      throw new Error('文件路径超出运行工作区');
    }
    let resolved = '';
    try {
      resolved = await fs.realpath(target);
      if (!(await fs.stat(resolved)).isFile()) throw new Error();
    } catch { throw new Error('本地文件已不存在'); }
    return { file, resolved };
  }

  async function openChangedFile(runId: string, filePath: string) {
    const { file, resolved } = await resolveChangedFile(runId, filePath);
    await openCursorEditor(['--reuse-window', '--goto', resolved]);
    return { opened: true, path: file.path };
  }

  async function downloadChangedFile(runId: string, filePath: string) {
    const { file, resolved } = await resolveChangedFile(runId, filePath);
    const run = runs.find(item => item.id === runId)!;
    if (!path.isAbsolute(file.path)) {
      const workspace = await fs.realpath(run.workspacePath);
      if (!resolved.startsWith(`${workspace}${path.sep}`)) throw new Error('文件路径超出运行工作区');
    }
    return { path: resolved, name: path.basename(file.path), size: (await fs.stat(resolved)).size };
  }

  async function revealChangedFile(runId: string, filePath: string) {
    const { file, resolved } = await resolveChangedFile(runId, filePath);
    try {
      await exec('/usr/bin/open', ['-R', resolved], { timeout: 5000, maxBuffer: 64_000 });
    } catch { throw new Error('无法在文件夹中显示该文件'); }
    return { revealed: true, path: file.path };
  }

  async function openChangedFileInBrowser(runId: string, filePath: string) {
    const { file, resolved } = await resolveChangedFile(runId, filePath);
    if (!/\.(?:html?|svg)$/i.test(resolved)) throw new Error('仅支持在浏览器中打开 HTML 或 SVG 文件');
    try {
      if (options.openBrowserFile) await options.openBrowserFile(resolved);
      else await exec('/usr/bin/open', ['-a', 'Google Chrome', resolved], { timeout: 5000, maxBuffer: 64_000 });
    } catch { throw new Error('无法在浏览器中打开该文件'); }
    return { opened: true, path: file.path };
  }

  async function workspaceFiles(workspacePath: string, query = '') {
    const identity = await workspaceIdentity(workspacePath);
    let files: string[];
    try {
      const output = await exec('git', ['-C', identity.workspacePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { timeout: 5000, maxBuffer: 2_000_000 });
      files = output.stdout.split('\0').filter(Boolean);
    } catch { files = await plainWorkspaceFiles(identity.workspacePath); }
    const term = cleanText(query, 200).toLowerCase();
    const ranked = files.filter((file) => !term || file.toLowerCase().includes(term)).sort((left, right) => {
      const leftName = path.basename(left).toLowerCase();
      const rightName = path.basename(right).toLowerCase();
      const leftScore = !term ? 0 : leftName.startsWith(term) ? 0 : left.toLowerCase().startsWith(term) ? 1 : 2;
      const rightScore = !term ? 0 : rightName.startsWith(term) ? 0 : right.toLowerCase().startsWith(term) ? 1 : 2;
      return leftScore - rightScore || left.length - right.length || left.localeCompare(right);
    });
    return { workspacePath: identity.workspacePath, files: ranked.slice(0, 60) };
  }

  async function workspaceKnowledge(workspacePath: string, query = '') {
    const identity = await workspaceIdentity(workspacePath);
    const term = cleanText(query, 200);
    if (term.length < 2) return { workspacePath: identity.workspacePath, branch: identity.branch, headSha: identity.headSha,
      matches: [], scannedFiles: 0, truncated: false };
    let files: string[];
    try {
      const output = await exec('git', ['-C', identity.workspacePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { timeout: 5000, maxBuffer: 2_000_000 });
      files = output.stdout.split('\0').filter(Boolean);
    } catch { files = await plainWorkspaceFiles(identity.workspacePath); }
    const result = identity.branch || identity.headSha
      ? await searchGitWorkspaceContents(identity.workspacePath, files, term)
      : await searchWorkspaceContents(identity.workspacePath, files, term);
    return { workspacePath: identity.workspacePath, branch: identity.branch, headSha: identity.headSha, ...result };
  }

  async function migrateConversationIds(assignments: { runId: string; conversationId: string; codexTurnId?: string }[]) {
    if (!assignments.length || assignments.length > runs.length) throw new Error('会话迁移映射不完整');
    const byRun = new Map(assignments.map((item) => [item.runId, item]));
    if (byRun.size !== assignments.length) throw new Error('会话迁移映射包含重复运行');
    const targets = assignments.map(({ runId, conversationId, codexTurnId }) => {
      const run = runs.find((item) => item.id === runId);
      if (!run || !sessionPattern.test(conversationId)) throw new Error('会话迁移映射包含无效运行或会话 ID');
      if (codexTurnId && (run.provider !== 'codex' || run.status !== 'completed'
        || !codexTurnPattern.test(codexTurnId) || (run.codexTurnId && run.codexTurnId !== codexTurnId))) {
        throw new Error('Codex 轮次映射无效');
      }
      return { run, conversationId, codexTurnId };
    });
    const sessionIds = new Set(targets.map(({ run }) => run.sessionId).filter(Boolean));
    if (runs.some((run) => sessionIds.has(run.sessionId) && (active.has(run.id) || waiting.has(run.id)))
      || [...active.values()].some((item) => sessionIds.has(item.forkSessionId))
      || [...waiting.values()].some((item) => sessionIds.has(item.forkSessionId) || sessionIds.has(item.resumeSessionId))) {
      throw new Error('待迁移 Codex 会话仍有运行或排队消息');
    }
    for (const run of runs) {
      if (sessionIds.has(run.sessionId) && !byRun.has(run.id)) throw new Error('会话迁移必须覆盖相关底层会话的全部已保存运行');
    }
    for (const { run, conversationId } of targets) {
      const oldId = run.conversationId;
      if (!oldId || oldId === conversationId) continue;
      const sharedRootTargets = targets.filter((item) => item.run.provider === 'codex'
        && item.run.sessionId === run.sessionId && item.run.queueRootId === oldId);
      const branches = new Set(sharedRootTargets.map((item) => item.conversationId));
      const parent = run.parentRunId ? runs.find((item) => item.id === run.parentRunId) : undefined;
      const parentAssignment = parent ? byRun.get(parent.id) : undefined;
      const legacyRoot = run.provider === 'codex' && !!run.sessionId && oldId === run.queueRootId
        && !run.continuation && branches.size > 1
        && !!parent && parent.sessionId === run.sessionId && parent.workspacePath === run.workspacePath
        && parent.queueRootId === oldId && parentAssignment?.conversationId === conversationId
        && sharedRootTargets.every((item) => !item.run.continuation && item.run.workspacePath === run.workspacePath)
        && !targets.some((item) => item.run.sessionId === run.sessionId && item.conversationId === oldId)
        && !runs.some((item) => item.conversationId === oldId
          && (item.sessionId !== run.sessionId || item.queueRootId !== oldId || item.workspacePath !== run.workspacePath));
      if (!legacyRoot) throw new Error('运行已归属其他会话，不能覆盖非共享旧队列根');
    }
    const histories = new Map<string, CodexSessionDetail>();
    const claimedTurns = new Set<string>();
    for (const { run, codexTurnId } of targets) {
      if (!codexTurnId) continue;
      const turnKey = `${run.sessionId}:${codexTurnId}`;
      if (claimedTurns.has(turnKey)) throw new Error('重复的 Codex 轮次不能映射到多个运行');
      claimedTurns.add(turnKey);
      let history = histories.get(run.sessionId);
      if (!history) {
        history = await codexSessionSource.session(run.sessionId);
        histories.set(run.sessionId, history);
      }
      const turn = history.turns.find((item) => item.id === codexTurnId);
      const objectivePrefix = run.objective.slice(0, 128);
      if (!turn || !turn.completedAt || !Number.isFinite(Date.parse(turn.completedAt))
        || !objectivePrefix || !turn.userMessage.includes(objectivePrefix)
        || Date.parse(turn.createdAt) < Date.parse(run.createdAt) - 60_000
        || Date.parse(turn.completedAt) > Date.parse(run.updatedAt) + 60_000) {
        throw new Error('Codex 轮次与运行记录无法核对，未迁移');
      }
    }
    const groupsBySession = new Map<string, Set<string>>();
    for (const { run, conversationId } of targets) {
      if (run.provider !== 'codex' || !run.sessionId) continue;
      const groups = groupsBySession.get(run.sessionId) || new Set<string>();
      groups.add(conversationId);
      groupsBySession.set(run.sessionId, groups);
    }
    const prior = targets.map(({ run }) => ({ run, conversationId: run.conversationId,
      codexTurnId: run.codexTurnId, requiresIsolation: run.requiresIsolation }));
    for (const { run, conversationId, codexTurnId } of targets) {
      run.conversationId = conversationId;
      if (codexTurnId) run.codexTurnId = codexTurnId;
      if (run.provider === 'codex' && (groupsBySession.get(run.sessionId)?.size || 0) > 1) run.requiresIsolation = true;
    }
    try { await persist(); }
    catch (error) {
      for (const { run, conversationId, codexTurnId, requiresIsolation } of prior) {
        if (conversationId === undefined) delete run.conversationId;
        else run.conversationId = conversationId;
        if (codexTurnId === undefined) delete run.codexTurnId;
        else run.codexTurnId = codexTurnId;
        if (requiresIsolation === undefined) delete run.requiresIsolation;
        else run.requiresIsolation = requiresIsolation;
      }
      throw error;
    }
    notify();
    return { updated: targets.length };
  }

  function conversationRemoval(runId: string) {
    const root = runs.find((run) => run.conversationId === runId || run.id === runId);
    if (!root) throw new Error('找不到该 Agent 会话');
    const conversationId = conversationIdFor(root);
    const ids = new Set(runs.filter((run) => conversationIdFor(run) === conversationId).map((run) => run.id));
    if (!root.conversationId && root.provider === 'codex' && runs.some((run) => !ids.has(run.id)
      && run.provider === 'codex' && run.sessionId && run.sessionId === root.sessionId)) {
      throw new Error('旧 Codex 会话尚未确认归属，不能安全删除');
    }
    return { conversationId, ids };
  }

  async function removeConversationRecords(conversationIds: Set<string>, ids: Set<string>, explicitCodexIds: Set<string>) {
    if (!ids.size && !explicitCodexIds.size) return;
    const hiddenSessionIds = new Set(explicitCodexIds);
    let removedRuns: AgentRun[] = [], orphanedAttachmentIds: string[] = [];
    if (ids.size) {
      // 先移除所选会话的全部排队项，再停止并等待执行收尾，防止下一条消息被派发。
      for (const run of runs) {
        if (ids.has(run.id) && waiting.delete(run.id)) {
          run.status = 'cancelled';
          run.error = '';
          addEvent(run, 'lifecycle', '删除会话，已取消排队', false);
        }
      }
      const stopping = [...active.entries()].filter(([id]) => ids.has(id)).map(([, process]) => process);
      for (const process of stopping) process.controller.abort();
      await Promise.all(stopping.map((process) => process.task));

      removedRuns = runs.filter(run => ids.has(run.id));
      runs = runs.filter(run => !ids.has(run.id)).map(run => !run.task ? run : conversationIds.has(run.task.parentConversationId)
        ? { ...run, task: undefined }
        : run.task.dependsOnConversationIds.some(id => conversationIds.has(id))
          ? { ...run, task: { ...run.task, dependsOnConversationIds: run.task.dependsOnConversationIds.filter(id => !conversationIds.has(id)) } }
          : run);

      const sessionIds = (run: AgentRun) => [run.originSessionId, ...(run.provider === 'codex' ? [run.sessionId, run.continuation?.sessionId] : [])];
      const retainedSessionIds = new Set(runs.flatMap(sessionIds));
      for (const id of removedRuns.flatMap(sessionIds)) {
        if (id && !retainedSessionIds.has(id)) hiddenSessionIds.add(id);
      }
      const attachmentIds = (run: AgentRun) => [...(run.attachments || []), ...(run.supplements || []).flatMap(item => item.attachments)].map(item => item.id);
      const removedAttachmentIds = new Set(removedRuns.flatMap(attachmentIds));
      if (removedAttachmentIds.size) {
        const retainedAttachmentIds = new Set(runs.flatMap(attachmentIds));
        orphanedAttachmentIds = [...removedAttachmentIds].filter(id => !retainedAttachmentIds.has(id));
      }
    }
    for (const sessionId of hiddenSessionIds) hiddenCodexSessionIds.add(sessionId);
    for (const conversationId of conversationIds) delete conversationTitles[conversationId];
    for (const sessionId of hiddenSessionIds) delete conversationTitles[sessionId];
    if (hiddenSessionIds.size) {
      codexSessions = codexSessions.filter((session) => !hiddenSessionIds.has(session.id));
      for (const sessionId of hiddenSessionIds) delete codexSessionDetails[sessionId];
      codexSync = { ...codexSync, total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
    }
    await Promise.all([
      persistConversationTitles(),
      ...(ids.size ? [persist()] : []),
      ...(hiddenSessionIds.size ? [persistCodexSessions()] : []),
    ]);
    try {
      await Promise.all([
        ...[...conversationIds].map(id => removeAgentUserContext(directory, id)),
        ...(attachmentRemover && orphanedAttachmentIds.length ? [attachmentRemover(orphanedAttachmentIds)] : []),
        ...removedRuns.filter(run => ['claude', 'kiro', 'antigravity'].includes(run.provider)).map(run =>
          fs.rm(runtimeAttachmentDirectory(run), { recursive: true, force: true })),
      ]);
    } finally { notify(); }
  }

  async function removeConversation(runId: string) {
    const { conversationId, ids } = conversationRemoval(runId);
    await removeConversationRecords(new Set([conversationId]), ids, new Set());
    return { deleted: ids.size };
  }

  async function removeConversations(targets: AgentConversationDeleteTarget[]): Promise<AgentConversationDeleteResult> {
    const removed: AgentConversationDeleteTarget[] = [], failures: AgentConversationDeleteResult['failures'] = [];
    const conversationIds = new Set<string>(), ids = new Set<string>(), codexIds = new Set<string>();
    const knownCodexIds = new Set(codexSessions.map(session => session.id));
    for (const target of targets) {
      try {
        if (target.source === 'codex') {
          if (!knownCodexIds.has(target.id)) throw new Error('找不到该 Codex 会话');
          codexIds.add(target.id);
        } else {
          const removal = conversationRemoval(target.id);
          conversationIds.add(removal.conversationId);
          for (const id of removal.ids) ids.add(id);
        }
        removed.push(target);
      } catch (error) {
        failures.push({ ...target, message: error instanceof Error ? error.message : String(error) });
      }
    }
    await removeConversationRecords(conversationIds, ids, codexIds);
    return { removed, failures };
  }

  async function removeQueuedRun(runId: string) {
    const run = runs.find((item) => item.id === runId);
    const pending = waiting.get(runId);
    if (!run || !pending || run.status !== 'queued' || !run.parentRunId) {
      throw new Error('只有排队中的续聊消息可以删除；首条消息请删除会话');
    }
    const queueKey = pending.queueKey;
    const parentRunId = run.parentRunId;
    const removedAttachmentIds = new Set([...(run.attachments || []),
      ...(run.supplements || []).flatMap((item) => item.attachments)].map((item) => item.id));
    waiting.delete(run.id);
    for (const child of runs) {
      if (child.parentRunId === run.id) child.parentRunId = parentRunId;
    }
    runs = runs.filter((item) => item.id !== run.id);
    const retainedAttachmentIds = new Set(runs.flatMap((item) => [...(item.attachments || []),
      ...(item.supplements || []).flatMap((supplement) => supplement.attachments)].map((attachment) => attachment.id)));
    const orphanedAttachmentIds = [...removedAttachmentIds].filter((id) => !retainedAttachmentIds.has(id));
    await archiveUserInputs(run, true);
    await persist();
    if (attachmentRemover && orphanedAttachmentIds.length) await attachmentRemover(orphanedAttachmentIds);
    if (run.provider === 'claude') await fs.rm(claudeAttachmentDirectory(run.id), { recursive: true, force: true });
    if (run.provider === 'kiro') await fs.rm(kiroAttachmentDirectory(run.id), { recursive: true, force: true });
    if (run.provider === 'antigravity') await fs.rm(antigravityAttachmentDirectory(run.id), { recursive: true, force: true });
    notify();
    await launchNext(queueKey);
    return { deleted: true };
  }

  async function syncCodexSessions() {
    const sessions = await Promise.all(filterCodexSessions(await codexSessionSource.listSessions()).map(async session =>
      exposeProjectWorkspace(await resolveRenamedWorkspace(session))));
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const nextSessions = filterCodexSessions([...byId.values()])
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const nextDetails: Record<string, CodexSessionDetail> = {};
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, nextSessions.length) }, async () => {
      while (cursor < nextSessions.length) {
        const session = nextSessions[cursor++];
        nextDetails[session.id] = await resolveRenamedWorkspace(await codexSessionSource.session(session.id));
      }
    }));
    codexSessions = nextSessions;
    codexSessionDetails = nextDetails;
    codexSync = { syncedAt: new Date().toISOString(), total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
    await persistCodexSessions();
    notify();
    return codexSync;
  }

  async function codexSession(id: string) {
    if (hiddenCodexSessionIds.has(id)) throw new Error('该 Codex 会话已从 Delivery Workspace 删除');
    if (!codexSessions.some((session) => session.id === id)) throw new Error('该 Codex 会话尚未同步');
    const session = codexSessionDetails[id] || await resolveRenamedWorkspace(await codexSessionSource.session(id));
    return { ...session, projectWorkspacePath: await resolveProject(session) };
  }

  async function removeCodexSession(id: string) {
    if (!codexSessions.some((session) => session.id === id)) throw new Error('找不到该 Codex 会话');
    await removeConversationRecords(new Set(), new Set(), new Set([id]));
    return { deleted: true };
  }

  async function updateConversationTitle(id: string, title: string) {
    const value = cleanText(title, 120);
    if (!value) throw new Error('请输入会话标题');
    const exists = runs.some((run) => conversationIdFor(run) === id || run.id === id)
      || codexSessions.some((session) => session.id === id);
    if (!exists) throw new Error('找不到该 Agent 会话');
    conversationTitles = { ...conversationTitles, [id]: value };
    await persistConversationTitles();
    notify();
    return { id, title: value };
  }

  async function stop(runId: string) {
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error('找不到该 Agent 运行');
    const process = active.get(runId);
    if (!process && waiting.has(runId) && run.status === 'queued') {
      const queueKey = waiting.get(runId)!.queueKey;
      waiting.delete(runId);
      run.status = 'cancelled';
      run.error = '';
      addEvent(run, 'lifecycle', '已取消排队中的 Agent');
      await persist();
      notify();
      await launchNext(queueKey);
      return run;
    }
    if (!process) throw new Error('该 Agent 当前没有运行中的本机进程');
    process.controller.abort();
    return run;
  }

  // 在同一状态锁内先锁住会话队列，再等 CLI 退出；不能使用 stop 后前端立即编辑，否则会自动启动下一条。
  async function pauseForEditInternal(runId: string, resumeAfterWorkspaceRestart = false) {
    const run = runs.find(item => item.id === runId);
    if (!run) throw new Error('找不到该 Agent 运行');
    if (isHistoricalAgentThread(run)) throw new Error(`该消息属于旧 ${run.provider === 'codex' ? 'Codex 线程' : `${providerNames[run.provider]} 会话`}，不能暂停编辑`);
    if (run.status === 'completed') throw new Error('已完成的消息不能暂停编辑，请发送新的要求');
    const queueKey = queueKeyFor(run.id, run.parentRunId || '', run.originSessionId || '');
    if ([...active.entries()].some(([id, process]) => {
      if (process.queueKey !== queueKey) return false;
      const current = runs.find((item) => item.id === id);
      return !current || conversationIdFor(current) !== conversationIdFor(run);
    })) {
      throw new Error('另一会话正在使用同一个 Codex 线程，不能暂停其任务');
    }
    const paused = runs.find(item => item.pausedForEdit && queueKeyFor(item.id, item.parentRunId || '', item.originSessionId || '') === queueKey);
    if (paused && paused.id !== run.id) throw new Error('请先完成当前暂停消息的编辑');
    if (run.pausedForEdit) return run;
    const newer = runs.some(item => item.parentRunId === run.id && !['queued', 'cancelled', 'interrupted', 'failed'].includes(item.status));
    if (newer) throw new Error('后续消息已经执行，不能再编辑这条历史消息');
    run.pausedForEdit = true;
    if (resumeAfterWorkspaceRestart) run.resumeAfterWorkspaceRestart = true;
    else delete run.resumeAfterWorkspaceRestart;
    if (waiting.has(run.id)) {
      waiting.delete(run.id);
      run.status = 'cancelled';
    }
    await persist();
    const processes = [...active.entries()].filter(([, process]) => process.queueKey === queueKey);
    for (const [, process] of processes) process.controller.abort();
    await Promise.all(processes.map(([, process]) => process.task));
    if (!run.sessionId && !run.providerSwitch && !run.accessTransition) run.sessionId = processes.map(([id]) => runs.find(item => item.id === id))
      .find(item => item?.provider === run.provider && executionAccess(nativeAccessSource(item)) === executionAccess(run))?.sessionId || '';
    run.error = '';
    addEvent(run, 'lifecycle', '会话已暂停，等待编辑消息后继续；已有结果和文件改动保留');
    await persist();
    notify(run);
    return run;
  }

  async function prepareWorkspaceRestart() {
    const activeQueueKeys = new Set([...active.values()].map(process => process.queueKey));
    const targetIds = [...new Set([...active.keys(), ...waiting.keys()])].filter(id => {
      const run = runs.find(item => item.id === id);
      if (!run || run.pausedForEdit) return false;
      // Pause every queue that would otherwise block the restart. The queue is
      // restored in order after startup, so queued follow-up messages are kept.
      return active.has(id) || !activeQueueKeys.has(queueKeyFor(run.id, run.parentRunId || '', run.originSessionId || ''));
    });
    for (const id of targetIds) await pauseForEditInternal(id, true);
    for (const id of [...waiting.keys()]) {
      const run = runs.find(item => item.id === id);
      if (!run || run.status !== 'queued') continue;
      run.pausedForEdit = true;
      run.resumeAfterWorkspaceRestart = true;
      run.status = 'cancelled';
      waiting.delete(id);
      addEvent(run, 'lifecycle', '工作台更新，已保存排队消息，重启后按原顺序继续');
    }
    await persist();
  }

  async function resumeAfterWorkspaceRestart(run: AgentRun) {
    if (!run.resumeAfterWorkspaceRestart || !run.pausedForEdit) return;
    if (run.status === 'interrupted' && run.recovery?.nativeObservation === 'codex-desktop') {
      await reconcileRun(run);
      if (run.status === 'interrupted') return;
    }
    // 停止与正常完成可能同时发生。原轮已完成就保留成果，不能因重启标记再次执行。
    if (run.status === 'completed') {
      run.pausedForEdit = false; delete run.resumeAfterWorkspaceRestart;
      addEvent(run, 'lifecycle', '已核对重启前的原轮次完成，保留结果，不重复执行');
      await persist(undefined, run.id); notify(run, true); return;
    }
    await enqueueSavedRun(run, '工作台重启完成，自动继续刚刚暂停的任务', canContinueStoppedCodexRun(run), true);
  }

  async function enqueueSavedRun(run: AgentRun, message: string, continueOriginal: boolean, afterRestart = false) {
    const adapter = adapters.get(run.provider);
    if (!adapter) throw new Error(`不支持的 ${providerNames[run.provider]} 执行器`);
    const attachmentIds = (run.attachments || []).map(item => item.id);
    if (attachmentIds.length && !attachmentResolver) throw new Error('附件服务不可用');
    const resolvedAttachments = attachmentIds.length ? await attachmentResolver!(attachmentIds) : [];
    const queueKey = queueKeyFor(run.id, run.parentRunId || '', run.originSessionId || '');
    const now = new Date().toISOString();
    const updates: Partial<AgentRun> = { pausedForEdit: false, resumeAfterWorkspaceRestart: undefined,
      workspaceRestartResumedAt: afterRestart ? now : run.workspaceRestartResumedAt,
      continuedAt: continueOriginal ? now : run.continuedAt,
      recovery: run.recovery?.stopRequested && run.recovery.nativeObservation === 'codex-desktop' ? undefined : run.recovery,
      status: 'queued', pid: null, error: '' };
    // 续接同一 Codex 会话会产生新的 turn；旧轮次只用于历史核对，不能限制本轮回写。
    if (run.provider === 'codex') updates.codexTurnId = undefined;
    const queued = { ...run, ...updates };
    addEvent(queued, 'lifecycle', message, false);
    await persist(queued);
    Object.assign(run, updates, { events: queued.events, updatedAt: queued.updatedAt });
    waiting.set(run.id, { adapter, resumeSessionId: run.sessionId || '', continueOriginal, forkSessionId: '', forkLastTurnId: '',
      imagePaths: resolvedAttachments.filter(item => isAgentImageAttachment(item.attachment)).map(item => item.filePath),
      fileAttachments: resolvedAttachments.filter(item => run.provider === 'cursor' || !isAgentImageAttachment(item.attachment))
        .map(item => ({ name: item.attachment.name, path: item.filePath })), queuePlacement: 'append', queueKey });
    notify(run);
    await launchReadyQueues(queueKey);
  }

  async function resumeWorkspaceRestartRuns() {
    const candidates = runs.filter(run => run.resumeAfterWorkspaceRestart && run.pausedForEdit)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    for (const run of candidates) {
      try { await resumeAfterWorkspaceRestart(run); }
      catch (error) {
        run.error = error instanceof Error ? error.message : '重启后自动继续任务失败';
        addEvent(run, 'diagnostic', run.error);
        await persist();
      }
    }
  }

  async function revise(runId: string, objective: string, cursorTrustPath?: string) {
    const source = runs.find(run => run.id === runId);
    if (!source?.pausedForEdit || active.has(runId)) throw new Error('请先暂停该消息再编辑');
    if (isHistoricalAgentThread(source)) throw new Error(`该消息属于旧 ${source.provider === 'codex' ? 'Codex 线程' : `${providerNames[source.provider]} 会话`}，不能修订`);
    if (cursorTrustPath !== undefined && (source.provider !== 'cursor' || cursorTrustPath !== source.workspacePath)) {
      throw new Error('Cursor 信任确认与当前会话目录不一致');
    }
    if (source.provider === 'codex' && source.sessionId
      && (source.requiresIsolation || codexSessionConversations(source.sessionId).size > 1)) {
      throw new Error('该旧 Codex 会话由多个会话共享，不能直接修订后写回原线程');
    }
    // 保留旧消息及结果，修订作为原会话的新一轮；启动前仍保持队列暂停，防止后续消息抢先执行。
    const next = await start({ provider: source.provider, mode: source.mode, accessMode: source.accessMode,
      model: source.model, reasoningEffort: source.reasoningEffort, serviceTier: source.serviceTier, objective,
      attachmentIds: source.attachments?.map(item => item.id) || [], workspacePath: source.workspacePath, cursorTrustPath },
    source.id, source.sessionId, source.originSessionId, '', 'next', undefined, undefined,
    !source.sessionId && source.providerSwitch ? { providerSwitch: source.providerSwitch } : {});
    next.revisesRunId = source.id;
    await archiveUserInputs(next);
    for (const [id, pending] of waiting) {
      const queued = runs.find(run => run.id === id);
      if (queued && queued.id !== next.id && queued.parentRunId === source.id) {
        queued.parentRunId = next.id;
        pending.resumeSessionId = queued.provider === next.provider && !queued.providerSwitch && !queued.accessTransition
          && executionAccess(nativeAccessSource(next)) === executionAccess(queued) ? next.sessionId : '';
      }
    }
    source.pausedForEdit = false;
    addEvent(source, 'lifecycle', '已保留原消息，按编辑后的内容继续');
    await persist();
    await launchReadyQueues(queueKeyFor(next.id, next.parentRunId || '', next.originSessionId || ''));
    return next;
  }

  async function steer(runId: string) {
    const run = runs.find((item) => item.id === runId);
    const pending = waiting.get(runId);
    if (!run || !pending || run.status !== 'queued') throw new Error('只有排队中的消息可以调整方向');
    const activeEntry = [...active.entries()].find(([, item]) => item.queueKey === pending.queueKey);
    if (!activeEntry) throw new Error('当前会话没有正在执行的 Agent');
    const [activeRunId, process] = activeEntry;
    const activeRun = runs.find((item) => item.id === activeRunId);
    if (!activeRun) throw new Error('找不到当前正在执行的 Agent');
    if (conversationIdFor(activeRun) !== conversationIdFor(run)) {
      throw new Error('另一会话正在使用同一个 Codex 线程，不能调整其任务方向');
    }
    if (run.provider !== activeRun.provider || crossesProviderBoundary(activeRun, run)) {
      throw new Error('切换执行器的消息只能排队，不能插入另一原生会话');
    }
    for (const candidate of waiting.values()) {
      if (candidate.queueKey === pending.queueKey) candidate.queuePlacement = 'append';
    }
    pending.queuePlacement = 'next';
    pending.resumeSessionId = !run.accessTransition && executionAccess(nativeAccessSource(activeRun)) === executionAccess(run)
      ? activeRun.sessionId : '';
    run.parentRunId = activeRun.id;
    run.roundContinuationOfRunId = activeRun.id;
    addEvent(run, 'lifecycle', '已调整方向：停止当前轮后将立即执行此消息');
    addEvent(activeRun, 'lifecycle', '收到调整方向，正在停止当前轮');
    await persist();
    process.controller.abort();
    return run;
  }

  function runtimeStatuses(force = false) {
    return Promise.all([...adapters.keys()].map((provider) => runtimeHealth(provider, force)));
  }

  function snapshot(runtimes = [...adapters.keys()].flatMap(provider => runtimeStatus(provider) || [])): AgentRuntimeDashboard {
    const recent = runs.slice(0, 50);
    const recentIds = new Set(recent.map((run) => run.id));
    const latestByConversation = new Map<string, AgentRun>();
    for (const run of runs) {
      const conversationId = conversationIdFor(run);
      const latest = latestByConversation.get(conversationId);
      if (!latest || compareConversationLatest(run, latest) < 0) latestByConversation.set(conversationId, run);
    }
    const anchors = [...latestByConversation.values()].filter((run) => !recentIds.has(run.id))
      .sort(compareConversationLatest);
    return { revision, runtimeStatusVersion, projectlessFork: true, runtimes, runs: [...recent, ...anchors].map(exposeResultReady), codexSessions, conversationTitles, codexSync,
      workflows: workflowSummaries(),
      activeWorkspaceLocks: [...active.entries()].map(([runId, item]) => ({
      workspacePath: item.workspacePath, runId, provider: item.provider,
    })) };
  }

  async function dashboard(force = false): Promise<AgentRuntimeDashboard> {
    return snapshot(await runtimeStatuses(force));
  }

  function runtimeStatusResult<T extends object>(requestedVersion: number, status: T) {
    return { ...(requestedVersion === runtimeStatusVersion ? status : {}), runtimeStatusVersion, runtimes: snapshot().runtimes };
  }

  function subscribe(subscriber: AgentRuntimeSubscriber) {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  // 只恢复观察已派发的桌面轮次，绝不重新发送提示词；串行核对避免重叠。
  let desktopRecoveryPending = false;
  const desktopRecoveryTimer = setInterval(() => {
    if (closing || desktopRecoveryPending || !runs.some(observingDesktop)) return;
    desktopRecoveryPending = true;
    void exclusive(async () => {
      if (closing) return;
      for (const run of runs.filter(observingDesktop)) await reconcileRun(run);
      await resumeWorkspaceRestartRuns();
      await launchReadyQueues();
    }).catch(() => {}).finally(() => { desktopRecoveryPending = false; });
  }, 5000);
  desktopRecoveryTimer.unref();

  // 工作台立即重启前已明确标记的任务，在团队服务恢复前先重新入队，避免被恢复扫描误判为失败。
  await resumeWorkspaceRestartRuns();

  // 重启后：回收已结束验证的副本，并对未结束流程补做一次推进（推进按 step 幂等，不会重复派发）。
  if (workflows.some(record => !record.closed)) {
    void exclusive(async () => {
      for (const record of workflows.filter(item => !item.closed)) {
        for (const run of stageRuns(record.id, 'verify')) await finishVerification(run).catch(() => {});
        await advanceWorkflow(record.id).catch(() => {});
      }
    });
  }

  async function startTeamNode(input: StartAgentRunInput, metadata: { team: NonNullable<AgentRun['team']>; context: string;
    runId?: string; resumeRunId?: string; parentConversationId: string; conversationId?: string; workspaceBound?: boolean; sourceWorkspacePath?: string; title: string; role?: AgentTaskRole;
    modelAlias?: AgentModelChoice['catalogAlias'] }) {
    const existing = runs.find(run => run.team?.stageKey === metadata.team.stageKey);
    if (existing) return existing;
    const previous = metadata.resumeRunId ? runs.find(run => run.id === metadata.resumeRunId) : undefined;
    const sameProvider = previous?.provider === input.provider && !!previous.sessionId;
    return start({ ...input, accessMode: input.mode === 'agent' ? input.accessMode ?? 'full' : 'workspace' }, previous ? previous.id : '', sameProvider ? previous!.sessionId : '', '', '', 'append',
      { parentConversationId: metadata.conversationId && metadata.team.profileId === 'leader' ? '' : metadata.parentConversationId,
        dependsOnConversationIds: [], role: metadata.conversationId && metadata.team.profileId === 'leader' ? 'main' : metadata.role || 'worker',
        title: metadata.title, source: 'workflow', sourceId: `team:${metadata.team.taskId}` },
      previous ? { sourceWorkspacePath: previous.sourceWorkspacePath || previous.workspacePath, baseBranch: previous.baseBranch || previous.branch,
        isolatedWorkspace: !!previous.isolatedWorkspace } : metadata.workspaceBound === false ? { sourceWorkspacePath: '', baseBranch: '', isolatedWorkspace: false }
          : metadata.sourceWorkspacePath !== undefined ? { sourceWorkspacePath: metadata.sourceWorkspacePath } : undefined,
      { team: metadata.team, teamContext: metadata.context, runId: metadata.runId, branchPrefix: 'feature/', modelAlias: metadata.modelAlias,
        ...(metadata.conversationId && metadata.team.profileId === 'leader' ? { conversationId: metadata.conversationId }
          : previous ? { conversationId: conversationIdFor(previous) } : {}),
        ...(previous && previous.provider !== input.provider ? { resetQueueRoot: true, providerSwitch: { from: previous.provider, context: '' } } : {}) });
  }

  return { dashboard, snapshot, runtimeStatuses, runtimeStatusResult, runtimeStatusVersion: () => runtimeStatusVersion, withProviderMaintenance, recoveryRuns,
    activeWorkspacePaths: () => runs.filter(run => activeStatuses.has(run.status) || observingDesktop(run))
      .flatMap(run => [run.workspacePath, run.sourceWorkspacePath, ...(run.team?.workspacePaths || [])].filter((value): value is string => !!value)),
    health: runtimeHealth,
    withTeamWorkspace: async <T>(workspacePath: string, owner: string, action: () => Promise<T>) => {
      const canonical = await fs.realpath(workspacePath).catch(async () => path.join(await fs.realpath(path.dirname(workspacePath)), path.basename(workspacePath)));
      await exclusive(async () => {
        if ([...hostWorkspaceLocks.values()].some(root => canonical === root || canonical.startsWith(`${root}${path.sep}`) || root.startsWith(`${canonical}${path.sep}`))
          || runs.some(run => (active.has(run.id) || observingDesktop(run)) && run.mode === 'agent' && [run.workspacePath, ...(run.team?.workspacePaths || [])]
            .some(workspace => workspace === canonical || canonical.startsWith(`${workspace}${path.sep}`) || workspace.startsWith(`${canonical}${path.sep}`)))) throw new Error('候选目录正在被其他写入者使用');
        hostWorkspaceLocks.set(owner, canonical);
      });
      try { return await action(); }
      finally { await exclusive(async () => { hostWorkspaceLocks.delete(owner); await launchReadyQueues(); }); }
    },
    getRun: (id: string) => runs.find(run => run.id === id),
    knowledgeCitations(reference: string) {
      const resourceField = `"reference":${JSON.stringify(reference)}`;
      return runs.filter(run => run.knowledgeContext?.includes(resourceField) || run.supplements?.some(item => item.knowledgeContext?.includes(resourceField)))
        .map(run => ({ runId: run.id, title: run.objective.slice(0, 120), createdAt: run.createdAt, url: `/agent?run=${encodeURIComponent(run.id)}` })).slice(0, 50);
    },
    isRunActive: (id: string) => active.has(id) || waiting.has(id),
    teamRuns: (taskId?: string) => runs.filter(run => run.team && (!taskId || run.team.taskId === taskId)),
    startTeamNode: (input: StartAgentRunInput, metadata: Parameters<typeof startTeamNode>[1]) => exclusive(() => startTeamNode(input, metadata)),
    isIdle: () => !hostWorkspaceLocks.size && !active.size && !waiting.size && !providerMaintenance.size && !runs.some(run => activeStatuses.has(run.status) || observingDesktop(run)),
    reconcileRecovery: () => exclusive(reconcileRecovery),
    start: (input: StartAgentRunInput) => exclusive(() => input.continueConversationId ? switchProvider(input) : start(input)),
    startManagedRefactor: (input: StartAgentRunInput, jobId: string, title: string) => exclusive(() => start(input, '', '', '', '', 'append',
      { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title, source: 'workflow', sourceId: `refactor-control:${jobId}` })),
    findManagedRefactor: (jobId: string) => runs.find(run => run.task?.sourceId === `refactor-control:${jobId}`),
    migrateConversationIds: (assignments: { runId: string; conversationId: string; codexTurnId?: string }[]) =>
      exclusive(() => migrateConversationIds(assignments)),
    prepareConversationIsolation: (conversationId: string, preparedWorkspacePath = '') =>
      exclusive(() => prepareConversationIsolation(conversationId, preparedWorkspacePath)),
    startRequirementDevelopment: (input: StartAgentRunInput, sourceId: string, title: string, modelAlias?: AgentModelChoice['catalogAlias']) => exclusive(() => start(input, '', '', '', '', 'append',
      { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title, source: 'workflow', sourceId: `requirement:${sourceId}` }, undefined, { modelAlias })),
    findRequirementDevelopment: (sourceId: string) => runs.find(run => run.task?.sourceId === `requirement:${sourceId}`),
    startJiraFix: (input: StartAgentRunInput, sourceId: string, title: string) => exclusive(() => start(input, '', '', '', '', 'append',
      { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title, source: 'workflow', sourceId: `jira-fix:${sourceId}` })),
    findJiraFix: (sourceId: string) => runs.find(run => run.task?.sourceId === `jira-fix:${sourceId}`),
    jiraDevRuns: (sourceId: string, workflow: 'jira' | 'requirement', conversationId = '') => {
      const targetSourceId = `${workflow === 'jira' ? 'jira-fix' : 'requirement'}:${sourceId}`;
      const seedRuns = runs.filter(run => run.task?.sourceId === targetSourceId
        || (conversationId && (run.conversationId === conversationId || run.id === conversationId)));
      if (!seedRuns.length) return [];
      const conversationIds = new Set(seedRuns.map(run => run.conversationId || run.queueRootId || run.id).filter(Boolean));
      const rootIds = new Set(seedRuns.map(run => run.queueRootId || run.id).filter(Boolean));
      return runs.filter(run => run.task?.sourceId === targetSourceId
        || (run.conversationId && conversationIds.has(run.conversationId))
        || (run.queueRootId && rootIds.has(run.queueRootId)))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    jiraFixResults: (sourceId: string) => {
      const history: { objective: string; result: string; status: string }[] = [], seen = new Set<string>();
      let run = runs.find(item => item.task?.sourceId === `jira-fix:${sourceId}`);
      while (run && !seen.has(run.id) && run.task?.sourceId === `jira-fix:${sourceId}`) {
        seen.add(run.id);
        history.unshift({ objective: run.objective, result: run.result, status: run.status });
        run = runs.find(item => item.id === run!.parentRunId);
      }
      return history;
    },
    spawn: (parentRunId: string, input: SpawnAgentTaskInput) => exclusive(() => spawn(parentRunId, input)),
    orchestrate: (parentRunId: string, input: StartAgentTaskWorkflowInput) => exclusive(() => orchestrate(parentRunId, input)),
    startTeamWorkflow: (parentRunId: string, input: StartAgentTaskWorkflowInput & { templateId: AgentTeamTemplateId }) =>
      exclusive(() => startTeamWorkflow(parentRunId, input)),
    decideWorkflow: (workflowId: string, action: AgentWorkflowAction, requestId: string) => exclusive(() => decideWorkflow(workflowId, action, requestId)),
    workflows: () => workflowSummaries(),
    resume: (runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [],
      accessMode?: AgentAccessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier, mode?: AgentRunMode) => exclusive(() => resume(runId, objective, model, reasoningEffort,
      attachmentIds, accessMode, queuePlacement, serviceTier, mode)),
    retry: (runId: string, cursorTrustPath?: string, selection?: Partial<Pick<AgentRun, 'mode' | 'accessMode'>>) => exclusive(() => retry(runId, cursorTrustPath, selection)),
    resumeCodexSession: (sessionId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [], accessMode: AgentAccessMode = 'full', serviceTier?: AgentServiceTier) => exclusive(() => resumeCodexSession(sessionId, objective, model, reasoningEffort, attachmentIds, accessMode, serviceTier)),
    fork: (runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [], serviceTier?: AgentServiceTier) => exclusive(() => fork(runId, objective, model, reasoningEffort, attachmentIds, serviceTier)),
    addCustomModel: (input: AgentCustomModelInput) => exclusive(() => addCustomModel(input)),
    removeCustomModel: (id: string) => exclusive(() => removeCustomModel(id)),
    workspaceFiles,
    workspaceKnowledge,
    openChangedFile,
    downloadChangedFile,
    revealChangedFile,
    openChangedFileInBrowser,
    workspaceBranches: listGitBranches,
    updateConversationTitle: (id: string, title: string) => exclusive(() => updateConversationTitle(id, title)),
    removeConversation: (runId: string) => exclusive(() => removeConversation(runId)),
    removeConversations: (targets: AgentConversationDeleteTarget[]) => exclusive(() => removeConversations(targets)),
    removeQueuedRun: (runId: string) => exclusive(() => removeQueuedRun(runId)),
    syncCodexSessions: () => exclusive(() => syncCodexSessions()),
    codexSession,
    removeCodexSession: (id: string) => exclusive(() => removeCodexSession(id)),
    stop: (runId: string) => exclusive(() => stop(runId)),
    prepareWorkspaceRestart: () => exclusive(prepareWorkspaceRestart),
    pauseForEdit: (runId: string) => exclusive(() => pauseForEditInternal(runId)),
    revise: (runId: string, objective: string, cursorTrustPath?: string) => exclusive(() => revise(runId, objective, cursorTrustPath)),
    steer: (runId: string) => exclusive(() => steer(runId)),
    subscribe,
    revision: () => revision,
    close: async () => { closing = true; clearInterval(desktopRecoveryTimer); subscribers.clear(); waiting.clear(); for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map((item) => item.task)); await Promise.all([writeLock, modelWriteLock, codexSessionWriteLock, conversationTitleWriteLock]); },
  };
}

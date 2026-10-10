/**
 * 设计说明：本模块是 Delivery 与本机 Agent CLI 之间的受控适配层。
 * 它开放受限工作区写入、用户显式选择的完全访问、只读 plan/ask 模式、精确会话恢复和进程停止；
 * 不同会话可并行执行，同一会话内的连续消息保持串行；共享 Git 工作区运行中禁止切换分支；
 * 现有自动交付队列继续独立运行，不接受任意 CLI 参数透传。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { cliBinary, codexChildEnvironment, cursorBinary } from './cli-runtime.js';
import { forkCodexThread, runCodexLiveTurn, type LiveSteer } from './codex-live-turn.js';
import { codexSessionErrorText } from '../shared/codex-session-error.js';
import { createCodexModelReader, requestCodexModels } from './codex-models.js';
import { createCodexSessionSource, type CodexSessionSource } from './codex-session-source.js';
import { resolveRenamedWorkspace } from './generated-workspace.js';
import type { ResolvedAgentAttachment } from './agent-attachments.js';
import { isAgentImageAttachment } from '../shared/agent-runtime.js';
import type {
  AgentAccessMode, AgentAttachment, AgentChangedFile, AgentContinuation, AgentCustomModelInput, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentServiceTier, AgentRun, AgentRunEvent, AgentRunMode,
  AgentKnowledgeMatch, AgentRuntimeDashboard, AgentRuntimeHealth, AgentTaskLink, AgentWorkspaceBranches, CodexSessionDetail, CodexSessionSummary, CodexSyncState,
  SpawnAgentTaskInput, StartAgentRunInput, StartAgentTaskWorkflowInput,
} from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const sessionPattern = /^[A-Za-z0-9_-]{8,200}$/;
const codexTurnPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const activeStatuses = new Set(['queued', 'running']);
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
  run: AgentRun;
  resumeSessionId?: string;
  forkSessionId?: string;
  forkLastTurnId?: string;
  imagePaths: string[];
  fileAttachments: { name: string; path: string }[];
  signal: AbortSignal;
  onPid(pid: number): void;
  onSession(sessionId: string): void | Promise<void>;
  onTurn?(turnId: string): void | Promise<void>;
  onEvent(type: AgentRunEvent['type'], message: string): void;
  onOutput?(text: string): void;
  onSteer?(steer: LiveSteer | undefined): void;
}

interface PendingAgentRun {
  adapter: AgentRuntimeAdapter;
  resumeSessionId: string;
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
  resolveKnowledge?: (objective: string) => Promise<string>;
  adapters?: AgentRuntimeAdapter[];
  resolveWorkspace?: (workspacePath: string) => Promise<WorkspaceIdentity>;
  switchWorkspaceBranch?: (workspacePath: string, branch: string) => Promise<WorkspaceIdentity>;
  createIsolatedWorkspace?: (workspacePath: string, branch: string, workspaceId: string,
    branchPrefix?: 'codex/' | 'feature/') => Promise<IsolatedWorkspaceIdentity>;
  forkCodexThread?: typeof forkCodexThread;
  codexSessionSource?: CodexSessionSource;
  resolveAttachments?: (ids: string[]) => Promise<ResolvedAgentAttachment[]>;
  removeAttachments?: (ids: string[]) => Promise<void>;
  openBrowserFile?: (filePath: string) => Promise<void>;
}

type AgentRuntimeSubscriber = (revision: number, run?: AgentRun) => void;

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

const ignoredWorkspaceDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt']);
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

function storedTask(value: unknown): AgentTaskLink | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<AgentTaskLink>;
  if (!cleanText(input.parentConversationId, 200) || !['worker', 'reviewer'].includes(String(input.role))
    || !['manual', 'workflow', 'automation'].includes(String(input.source))) return undefined;
  return {
    parentConversationId: cleanText(input.parentConversationId, 200),
    dependsOnConversationIds: Array.isArray(input.dependsOnConversationIds)
      ? [...new Set(input.dependsOnConversationIds.map((item) => cleanText(item, 200)).filter(Boolean))].slice(0, 12) : [],
    role: input.role as AgentTaskLink['role'],
    title: cleanText(input.title, 200) || '并行任务',
    source: input.source as AgentTaskLink['source'],
    ...(cleanText(input.sourceId, 200) ? { sourceId: cleanText(input.sourceId, 200) } : {}),
  };
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

async function plainWorkspaceFiles(workspacePath: string, limit = 20_000) {
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

async function snapshotPlainWorkspace(workspacePath: string): Promise<GitWorkspaceSnapshot> {
  const files: Record<string, GitWorkspaceFileState> = {};
  for (const relativePath of await plainWorkspaceFiles(workspacePath)) {
    try {
      const stat = await fs.stat(path.join(workspacePath, relativePath));
      files[relativePath] = { status: 'modified', fingerprint: `${stat.size}:${stat.mtimeMs}` };
    } catch { /* Files may disappear while the Agent is running. */ }
  }
  return { headSha: '', files };
}

export async function snapshotGitWorkspace(workspacePath: string): Promise<GitWorkspaceSnapshot> {
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
      if (!relativePath) continue;
      files[relativePath] = { status: gitFileStatus(code), fingerprint: await fileFingerprint(workspacePath, relativePath) };
      if (code.includes('R') || code.includes('C')) index += 1;
    }
    return { headSha: head.stdout.trim(), files };
  } catch {
    try { return await snapshotPlainWorkspace(workspacePath); }
    catch { return { headSha: '', files: {} }; }
  }
}

export async function changedFilesSince(workspacePath: string, before: GitWorkspaceSnapshot): Promise<AgentChangedFile[]> {
  const after = await snapshotGitWorkspace(workspacePath);
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
  return [...changed.entries()].map(([relativePath, status]) => ({ path: relativePath, status }))
    .sort((left, right) => left.path.localeCompare(right.path)).slice(0, 300);
}

export async function resultArtifactFiles(workspacePath: string, result: string): Promise<AgentChangedFile[]> {
  const candidates = [...result.matchAll(/\]\(<?(\/[^)>\r\n]+)>?\)/g)].map((match) => match[1]);
  const files = new Map<string, AgentChangedFile>();
  for (const candidate of candidates) {
    let decoded = candidate;
    try { decoded = decodeURIComponent(candidate); } catch { /* Keep the original local path. */ }
    const targets = [decoded, decoded.replace(/:\d+(?::\d+)?$/, '')];
    for (const localPath of new Set(targets)) {
      try {
        const target = await fs.realpath(localPath);
        if (!(await fs.stat(target)).isFile()) continue;
        const relativePath = path.relative(workspacePath, target);
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

export function isAgentSessionBusyDiagnostic(diagnostic: string) {
  return /session.*(?:in use|locked|busy|active|in progress)|thread.*(?:in use|locked|busy|active|in progress)|active turn|already running/i.test(diagnostic);
}

export function agentCliFailureMessage(provider: AgentProvider, code: number | null, diagnostic: string) {
  const prefix = `${provider === 'codex' ? 'Codex' : 'Cursor'} CLI 执行失败（退出码 ${code ?? '未知'}）`;
  if (provider === 'cursor' && /workspace trust required|workspace is not trusted|trust the contents of this directory/i.test(diagnostic)) {
    return `${prefix}：当前工作区尚未信任，请点击“重新执行”并确认信任此目录`;
  }
  if (/not logged in|unauthenticated|unauthorized|forbidden/i.test(diagnostic)) return `${prefix}：本机 CLI 尚未登录或登录已失效`;
  if (/permission denied|operation not permitted/i.test(diagnostic)) return `${prefix}：工作区或 CLI 权限不足`;
  if (/network|connection|handshake|stream disconnected|timed? ?out/i.test(diagnostic)) return `${prefix}：网络连接或请求超时`;
  if (isAgentSessionBusyDiagnostic(diagnostic)) return `${prefix}：原会话正在其他 Codex 窗口运行，请结束或等待当前任务完成后重试`;
  if (/no session found|session.*not found|thread.*not found|cannot find.*(?:session|thread)/i.test(diagnostic)) {
    return `${prefix}：CLI 找不到原会话，请先重新同步 Codex 会话`;
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
  const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
  const content = message?.content ?? event.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) return cleanText(content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as Record<string, unknown>;
    return typeof item.text === 'string' ? item.text : '';
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
  } else {
    if (type === 'system') return writable ? 'Cursor 已初始化 Agent 会话' : 'Cursor 已初始化只读会话';
    if (type === 'tool_call') return writable ? 'Cursor 正在调用工作区工具' : 'Cursor 正在执行只读检查';
  }
  return '';
}

function executionPrompt(mode: AgentRunMode, objective: string, accessMode: AgentAccessMode, revisesRunId?: string) {
  if (revisesRunId) objective = `用户已暂停并编辑上一条任务，本条内容替代被暂停的任务要求。请基于已完成的实际结果，按以下修订后的要求继续，不再执行旧要求中被撤回的部分；不要自动回滚已有改动。\n\n${objective}`;
  if (mode === 'agent') {
    const boundary = accessMode === 'full'
      ? '用户已为本轮选择完全访问，可访问工作区外的本机文件和网络。'
      : '本轮仅允许写入所选工作区。';
    return `你由 Delivery Workspace 以 Agent 模式调用。${boundary}请完成用户任务并运行必要命令。仅执行用户明确要求的范围；提交、推送或更改外部系统必须由用户在任务中明确要求。用户任务如下：\n\n${objective}`;
  }
  const purpose = mode === 'plan' ? '分析现状并输出可执行方案' : '基于仓库事实回答问题';
  return `你由 Delivery Workspace 以只读模式调用。请${purpose}。不得修改文件、运行会产生写入的命令、提交、推送或更改外部系统。用户任务如下：\n\n${objective}`;
}

function withFileAttachments(prompt: string, files: { name: string; path: string }[]) {
  return files.length ? `${prompt}\n\n本轮附加的本地文件（已验证）：\n${files.map(file => `- ${JSON.stringify(file.name)}：${JSON.stringify(file.path)}`).join('\n')}` : prompt;
}

export function codexRunArguments(workspacePath: string, mode: AgentRunMode, model = '', reasoningEffort: AgentReasoningEffort | '' = '',
  sessionId = '', imagePaths: string[] = [], accessMode: AgentAccessMode = 'workspace') {
  const sandboxMode = mode !== 'agent' ? 'read-only' : accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
  const fixed = ['-c', `sandbox_mode="${sandboxMode}"`, '-c', 'approval_policy="never"',
    ...(sandboxMode === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...(model ? ['--model', model] : []), '--thread-source', 'cli', '--json',
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath])];
  return sessionId ? ['exec', 'resume', sessionId, ...fixed, '-'] : ['exec', '--cd', workspacePath, ...fixed, '-'];
}

export function codexForkArguments(mode: AgentRunMode, model = '', reasoningEffort: AgentReasoningEffort | '' = '',
  sessionId = '', imagePaths: string[] = [], accessMode: AgentAccessMode = 'workspace') {
  const sandboxMode = mode !== 'agent' ? 'read-only' : accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
  const fixed = ['-c', `sandbox_mode="${sandboxMode}"`, '-c', 'approval_policy="never"',
    ...(sandboxMode === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...(model ? ['--model', model] : []), '--thread-source', 'cli', '--json',
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath])];
  return ['exec', 'fork', sessionId, ...fixed, '-'];
}

export function cursorRunArguments(workspacePath: string, mode: AgentRunMode, model = '', sessionId = '', prompt = '',
  accessMode: AgentAccessMode = 'workspace', cursorTrustPath = '') {
  const fullAccess = mode === 'agent' && accessMode === 'full';
  return ['-p', '--output-format', 'stream-json', ...(mode === 'agent' ? [fullAccess ? '--force' : '--auto-review'] : ['--mode', mode]),
    '--sandbox', fullAccess ? 'disabled' : 'enabled', ...(model ? ['--model', model] : []), '--workspace', workspacePath,
    ...(cursorTrustPath && cursorTrustPath === workspacePath ? ['--trust'] : []),
    ...(sessionId ? ['--resume', sessionId] : []), prompt];
}

async function runCli(provider: AgentProvider, binary: string, args: string[], context: ExecutionContext, stdin = '') {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { cwd: context.run.workspacePath, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      detached: process.platform !== 'win32', env: provider === 'codex' ? codexChildEnvironment() : process.env });
    if (child.pid) context.onPid(child.pid);
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let buffer = '';
    let diagnostic = '';
    let result = '';
    let stopped = false;
    let failure = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already exited. */ }
    };
    const terminate = (message: string) => {
      if (failure) return;
      failure = message;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    const stop = () => { stopped = true; terminate('运行已停止'); };
    // CLI 可以持续执行长任务；只在主动中断、异常或进程结束时收尾。
    context.signal.addEventListener('abort', stop, { once: true });
    child.on('error', () => reject(new Error(`${provider === 'codex' ? 'Codex' : 'Cursor'} CLI 进程未能启动`)));
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + stderr.write(chunk)).slice(-16_384); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += stdout.write(chunk);
      if (buffer.length > 2_000_000) { context.onEvent('diagnostic', 'CLI 事件输出超过限制，已停止运行'); terminate('CLI 事件输出超过大小限制'); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const sessionId = eventSession(provider, event);
          if (sessionId) context.onSession(sessionId);
          const message = eventMessage(provider, event);
          if (message) { result = message; context.onEvent('message', message); }
          const lifecycle = lifecycleMessage(provider, context.run.mode, event);
          if (lifecycle) context.onEvent(lifecycle.includes('检查') ? 'tool' : 'lifecycle', lifecycle);
        } catch { /* CLI diagnostics can share stdout; never echo unparsed content to the page. */ }
      }
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      context.signal.removeEventListener('abort', stop);
      if (stopped || context.signal.aborted) { reject(new Error('运行已停止')); return; }
      if (failure) { reject(new Error(failure)); return; }
      if (code !== 0) { reject(new Error(agentCliFailureMessage(provider, code, diagnostic))); return; }
      resolve(result || 'CLI 已完成本轮任务，但没有返回可展示的最终文本。');
    });
    child.stdin.on('error', () => { /* close/error reports the actual failure */ });
    child.stdin.end(stdin);
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

export function createCodexAdapter(binary = cliBinary): AgentRuntimeAdapter {
  const readModels = createCodexModelReader(() => requestCodexModels(binary));
  const health = cachedHealth(async () => {
    const [version, login] = await Promise.allSettled([
      exec(binary, ['--version'], { timeout: 10_000 }),
      exec(binary, ['login', 'status'], { timeout: 10_000 }),
    ]);
    const versionText = version.status === 'fulfilled' ? cleanText(version.value.stdout, 200) : '';
    const loginText = login.status === 'fulfilled' ? `${login.value.stdout}\n${login.value.stderr}` : '';
    const authenticated = /Logged in/i.test(loginText);
    const ready = !!versionText && authenticated;
    const catalog = ready ? await readModels() : { models: [{ id: '', label: 'CLI 默认（当前配置）' }], defaultModel: '', message: '',
      configuredModel: undefined, configuredServiceTier: undefined };
    return { provider: 'codex' as const, label: 'Codex CLI', binary, version: versionText, authenticated, ready,
      message: ready ? catalog.message || '本机 Codex CLI 可用于 Agent、Plan 和 Ask 模式' : !versionText ? '未找到可用的 Codex CLI' : 'Codex CLI 尚未登录',
      modes: ['agent', 'plan', 'ask'] as AgentRunMode[], models: catalog.models, defaultModel: catalog.defaultModel,
      configuredModel: catalog.configuredModel, configuredServiceTier: catalog.configuredServiceTier, writable: true };
  });
  return { id: 'codex', health,
    execute: (context) => runCodexLiveTurn(binary, context,
      withFileAttachments(executionPrompt(context.run.mode, context.run.objective, context.run.accessMode, context.run.revisesRunId)
        + (context.run.knowledgeContext ? `\n\n${context.run.knowledgeContext}` : ''), context.fileAttachments)) };
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
      exec(binary, ['status'], { timeout: 10_000 }),
    ]);
    const versionText = version.status === 'fulfilled' ? cleanText(version.value.stdout || version.value.stderr, 200) : '';
    const loginText = login.status === 'fulfilled' ? `${login.value.stdout}\n${login.value.stderr}`.trim() : '';
    const authenticated = !!loginText && !/not logged in/i.test(loginText);
    const ready = !!versionText && authenticated;
    let models = cursorFallbackModels;
    if (ready) {
      try { models = cursorModels((await exec(binary, ['--list-models'], { timeout: 15_000 })).stdout); } catch { /* Keep documented fallback choices. */ }
    }
    return { provider: 'cursor' as const, label: 'Cursor CLI', binary, version: versionText, authenticated, ready,
      message: ready ? '本机 Cursor CLI 可用于 Agent、Plan 和 Ask 模式' : !versionText ? '未找到可用的 Cursor CLI' : 'Cursor CLI 尚未登录',
      modes: ['agent', 'plan', 'ask'] as AgentRunMode[], models, defaultModel: 'auto', writable: true };
  });
  return { id: 'cursor', health,
    execute: (context) => runCli('cursor', binary,
      cursorRunArguments(context.run.workspacePath, context.run.mode, context.run.model, context.resumeSessionId,
        withFileAttachments(executionPrompt(context.run.mode, context.run.objective, context.run.accessMode, context.run.revisesRunId)
          + (context.run.knowledgeContext ? `\n\n${context.run.knowledgeContext}` : ''), context.fileAttachments), context.run.accessMode,
        context.run.cursorTrustPath), context) };
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

export async function createAgentRuntimeService(directory: string, options: ServiceOptions = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'agent-runs.json');
  const customModelFile = path.join(directory, 'custom-models.json');
  const codexSessionFile = path.join(directory, 'codex-sessions.json');
  const hiddenCodexSessionFile = path.join(directory, 'hidden-codex-sessions.json');
  const conversationTitleFile = path.join(directory, 'conversation-titles.json');
  const adapters = new Map((options.adapters || [createCodexAdapter(), createCursorAdapter()]).map((adapter) => [adapter.id, adapter]));
  const workspaceIdentity = options.resolveWorkspace || resolveWorkspace;
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
  let codexSessions: CodexSessionSummary[] = [];
  let codexSessionDetails: Record<string, CodexSessionDetail> = {};
  let conversationTitles: Record<string, string> = {};
  let codexSync: CodexSyncState = { syncedAt: '', total: 0, hidden: 0 };
  let hiddenCodexSessionIds = new Set<string>();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    runs = Array.isArray(parsed) ? parsed.map((run) => ({ ...run, model: cleanText(run.model, 100),
      accessMode: run.accessMode === 'full' && run.mode === 'agent' ? 'full' : 'workspace',
      serviceTier: run.serviceTier === 'default' || run.serviceTier === 'priority' ? run.serviceTier : undefined,
      reasoningEffort: cleanText(run.reasoningEffort, 20), attachments: storedAttachments(run.attachments), liveInputReady: false,
      ...(storedTask(run.task) ? { task: storedTask(run.task) } : {}),
      ...(storedChangedFiles(run.changedFiles) !== undefined ? { changedFiles: storedChangedFiles(run.changedFiles) } : {}) })) : [];
    runs = await Promise.all(runs.map(async (stored) => {
      const run = await resolveRenamedWorkspace(stored);
      const generated = await resultArtifactFiles(run.workspacePath, run.result);
      return generated.length ? { ...run, changedFiles: mergeChangedFiles(run.changedFiles || [], generated) } : run;
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Agent 运行记录不可读'); }
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
    const parsed = JSON.parse(await fs.readFile(customModelFile, 'utf8'));
    customModels = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object')
      .map((item) => ({ id: cleanText(item.id, 80), provider: item.provider, modelId: cleanText(item.modelId, 100),
        label: cleanText(item.label, 80), createdAt: cleanText(item.createdAt, 40) }))
      .filter((item): item is StoredCustomModel => !!item.id && ['codex', 'cursor'].includes(item.provider)
        && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(item.modelId) && !!item.label) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('自定义模型配置不可读'); }
  try {
    const parsed = JSON.parse(await fs.readFile(codexSessionFile, 'utf8')) as StoredCodexSessions;
    codexSessions = Array.isArray(parsed.sessions) ? await Promise.all(parsed.sessions.map(resolveRenamedWorkspace)) : [];
    codexSessionDetails = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
      ? Object.fromEntries(await Promise.all(Object.entries(parsed.details).filter(([id, detail]) => sessionPattern.test(id)
        && detail && typeof detail === 'object' && Array.isArray(detail.turns)).map(async ([id, detail]) => [id, await resolveRenamedWorkspace(detail)]))) : {};
    codexSync = { syncedAt: cleanText(parsed.syncedAt, 40), total: codexSessions.length, hidden: 0 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex 会话缓存不可读'); }
  try {
    const parsed = JSON.parse(await fs.readFile(hiddenCodexSessionFile, 'utf8'));
    hiddenCodexSessionIds = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && sessionPattern.test(id)) : []);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex 会话隐藏记录不可读'); }
  try {
    const parsed = JSON.parse(await fs.readFile(conversationTitleFile, 'utf8'));
    conversationTitles = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([id, title]) => [id, cleanText(title, 120)])
        .filter(([id, title]) => sessionPattern.test(id) && !!title)) : {};
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('会话标题配置不可读'); }
  codexSessions = codexSessions.filter((session) => !hiddenCodexSessionIds.has(session.id));
  const visibleCodexSessionIds = new Set(codexSessions.map((session) => session.id));
  codexSessionDetails = Object.fromEntries(Object.entries(codexSessionDetails)
    .filter(([id]) => visibleCodexSessionIds.has(id)));
  codexSync = { ...codexSync, total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
  const now = new Date().toISOString();
  let recovered = false;
  runs = runs.map((run) => activeStatuses.has(run.status) ? { ...run, status: 'interrupted', pid: null,
    error: '5199 服务重启中断了本机 CLI 观察；未自动重复执行，请从原会话精确续跑。', updatedAt: now } : run);
  recovered = runs.some((run) => run.updatedAt === now && run.status === 'interrupted');
  let writeLock: Promise<unknown> = Promise.resolve();
  let modelWriteLock: Promise<unknown> = Promise.resolve();
  let codexSessionWriteLock: Promise<unknown> = Promise.resolve();
  let conversationTitleWriteLock: Promise<unknown> = Promise.resolve();
  let transition: Promise<unknown> = Promise.resolve();
  let revision = Date.now();
  let closing = false;
  const subscribers = new Set<AgentRuntimeSubscriber>();
  const active = new Map<string, { controller: AbortController; workspacePath: string; provider: AgentProvider;
    queueKey: string; forkSessionId: string; task: Promise<void> }>();
  const liveInputs = new Map<string, LiveSteer>();
  const waiting = new Map<string, PendingAgentRun>();
  function pruneRuns() {
    const protectedIds = new Set([...active.keys(), ...waiting.keys()]);
    const byId = new Map(runs.map((run) => [run.id, run]));
    for (const id of [...protectedIds]) {
      let parentId = byId.get(id)?.parentRunId;
      while (parentId && !protectedIds.has(parentId)) {
        protectedIds.add(parentId);
        parentId = byId.get(parentId)?.parentRunId;
      }
    }
    const latestByConversation = new Map<string, AgentRun>();
    for (const run of runs) {
      if (!run.conversationId) continue;
      const latest = latestByConversation.get(run.conversationId);
      if (!latest || compareConversationLatest(run, latest) < 0) latestByConversation.set(run.conversationId, run);
    }
    for (const [conversationId, latest] of latestByConversation) {
      protectedIds.add(latest.id);
      if (latest.provider !== 'codex' || !latest.requiresIsolation || latest.continuation) continue;
      const completed = runs.filter((run) => run.conversationId === conversationId && run.provider === 'codex'
        && run.status === 'completed' && run.codexTurnId)
        .sort(compareConversationLatest)[0];
      if (completed) protectedIds.add(completed.id);
    }
    runs = [...runs.slice(0, 100), ...runs.slice(100).filter((run) => protectedIds.has(run.id))];
  }
  const notify = (run?: AgentRun) => {
    revision += 1;
    for (const subscriber of subscribers) {
      try { subscriber(revision, run); } catch { /* A disconnected browser must not interrupt the runtime. */ }
    }
  };
  const exclusive = <T>(action: () => Promise<T>) => {
    const operation = transition.then(action);
    transition = operation.catch(() => {});
    return operation;
  };
  const persist = () => {
    const operation = writeLock.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(runs, null, 2), { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    writeLock = operation.catch(() => {});
    return operation;
  };
  const persistCustomModels = () => {
    const operation = modelWriteLock.then(async () => {
      const temporary = `${customModelFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(customModels, null, 2), { mode: 0o600 });
      await fs.rename(temporary, customModelFile);
    });
    modelWriteLock = operation.catch(() => {});
    return operation;
  };
  const persistCodexSessions = () => {
    const operation = codexSessionWriteLock.then(async () => {
      const cacheTemporary = `${codexSessionFile}.${process.pid}.tmp`;
      const hiddenTemporary = `${hiddenCodexSessionFile}.${process.pid}.tmp`;
      await fs.writeFile(cacheTemporary, JSON.stringify({
        syncedAt: codexSync.syncedAt,
        sessions: codexSessions,
        details: codexSessionDetails,
      }, null, 2), { mode: 0o600 });
      await fs.writeFile(hiddenTemporary, JSON.stringify([...hiddenCodexSessionIds], null, 2), { mode: 0o600 });
      await fs.rename(cacheTemporary, codexSessionFile);
      await fs.rename(hiddenTemporary, hiddenCodexSessionFile);
    });
    codexSessionWriteLock = operation.catch(() => {});
    return operation;
  };
  const persistConversationTitles = () => {
    const operation = conversationTitleWriteLock.then(async () => {
      const temporary = `${conversationTitleFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(conversationTitles, null, 2), { mode: 0o600 });
      await fs.rename(temporary, conversationTitleFile);
    });
    conversationTitleWriteLock = operation.catch(() => {});
    return operation;
  };
  if (recovered || migratedQueueRoots || migratedSessionErrors) await persist();

  async function runtimeHealth(provider: AgentProvider, force = false) {
    const adapter = adapters.get(provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    const health = await adapter.health(force);
    const builtInIds = new Set(health.models.map((model) => model.id));
    const added = customModels.filter((model) => model.provider === provider && !builtInIds.has(model.modelId)).map((model) => ({
      id: model.modelId, label: model.label, customId: model.id,
      ...(provider === 'codex' ? { efforts: codexEfforts, defaultEffort: 'high' as AgentReasoningEffort } : {}),
    }));
    return { ...health, models: [...health.models, ...added] };
  }

  function addEvent(run: AgentRun, type: AgentRunEvent['type'], message: string) {
    const value = cleanText(message, 1000);
    if (!value) return;
    run.events = [...run.events.slice(-198), { id: randomUUID(), type, message: value, createdAt: new Date().toISOString() }];
    run.updatedAt = new Date().toISOString();
    if (type === 'message') run.result = message;
    notify(run);
  }

  async function launch(run: AgentRun, adapter: AgentRuntimeAdapter, resumeSessionId = '', imagePaths: string[] = [],
    fileAttachments: { name: string; path: string }[] = [], forkSessionId = '', queueKey = `run:${run.id}`, forkLastTurnId = '') {
    const controller = new AbortController();
    const task = (async () => {
      run.status = 'running';
      addEvent(run, 'lifecycle', forkSessionId ? '正在基于原会话创建新会话' : resumeSessionId ? '正在续接原会话' : '正在启动 Agent');
      await persist();
      const workspaceBefore = run.mode === 'agent' ? await snapshotGitWorkspace(run.workspacePath) : undefined;
      try {
        run.result = await adapter.execute({ run, resumeSessionId, forkSessionId, forkLastTurnId, imagePaths, fileAttachments, signal: controller.signal,
          onPid: (pid) => { run.pid = pid; run.updatedAt = new Date().toISOString(); notify(run); },
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
        run.status = 'completed';
        run.error = '';
        addEvent(run, 'lifecycle', 'Agent 本轮运行完成');
      } catch (error) {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = error instanceof Error ? error.message : 'Agent 运行失败';
        addEvent(run, 'diagnostic', run.error);
      } finally {
        liveInputs.delete(run.id);
        run.liveInputReady = false;
        if (workspaceBefore) {
          const [workspaceFiles, generatedFiles] = await Promise.all([
            changedFilesSince(run.workspacePath, workspaceBefore),
            resultArtifactFiles(run.workspacePath, run.result),
          ]);
          run.changedFiles = mergeChangedFiles(workspaceFiles, generatedFiles);
        }
        run.pid = null;
        run.updatedAt = new Date().toISOString();
        active.delete(run.id);
        pruneRuns();
        await persist();
        notify(run);
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
        return pending.queueKey === queueKey && run?.status === 'queued' && dependenciesReady(run);
      });
      const selected = candidates.find(([, pending]) => pending.queuePlacement === 'next') || candidates[0];
      if (!selected) return;
      const [runId, pending] = selected;
      const run = runs.find((item) => item.id === runId);
      if (!run) return;
      let resumeSessionId = pending.resumeSessionId;
      if (!resumeSessionId && run.parentRunId && !pending.forkSessionId && !run.revisesRunId) {
        resumeSessionId = runs.find((item) => item.id === run.parentRunId)?.sessionId || '';
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
        pending.queueKey, pending.forkLastTurnId);
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

  function isHistoricalCodexThread(run: AgentRun) {
    if (run.provider !== 'codex') return false;
    const latest = latestConversationRun(conversationIdFor(run));
    return !!latest && latest.id !== run.id && !!run.sessionId
      && run.sessionId !== (latest.continuation?.sessionId || latest.sessionId);
  }

  function dependenciesReady(run: AgentRun) {
    const dependencies = run.task?.dependsOnConversationIds || [];
    return dependencies.every((conversationId) => latestConversationRun(conversationId)?.status === 'completed');
  }

  function queueKeyFor(runId: string, parentRunId: string, originSessionId: string, resumeSessionId = '', forkSessionId = '') {
    const current = runs.find((item) => item.id === runId);
    const parent = runs.find((item) => item.id === parentRunId);
    const physicalSessionId = !forkSessionId && (current?.provider === 'codex' || parent?.provider === 'codex'
      || (!current && !parent && (!!originSessionId || !!resumeSessionId)))
      ? resumeSessionId || current?.sessionId || originSessionId || parent?.sessionId || '' : '';
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
    runOptions: { conversationId?: string; resetQueueRoot?: boolean; forkLastTurnId?: string; branchPrefix?: 'feature/' } = {}) {
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
    if (input.mode !== 'agent' && input.accessMode === 'full') throw new Error('只有 Agent 模式可使用完全访问');
    const adapter = adapters.get(input.provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    const health: AgentRuntimeHealth = await runtimeHealth(input.provider, true);
    if (!health.ready) throw new Error(health.message);
    const model = cleanText(input.model, 100);
    const modelOption = health.models.find((option) => option.id === model);
    if (!modelOption) throw new Error('所选模型不受当前执行器支持');
    const reasoningEffort = cleanText(input.reasoningEffort, 20) as AgentReasoningEffort | '';
    if (reasoningEffort && !modelOption.efforts?.includes(reasoningEffort)) throw new Error('所选推理强度不受当前模型支持');
    if (input.provider === 'cursor' && reasoningEffort) throw new Error('Cursor 模型不使用 Codex 推理强度');
    if (input.provider === 'cursor' && input.serviceTier) throw new Error('Cursor 模型不使用 Codex 速度档位');
    if (input.serviceTier === 'priority') {
      const speedModel = health.models.find((option) => option.id === (model || health.configuredModel || health.defaultModel));
      if (!speedModel?.serviceTiers?.some((tier) => tier.id === 'priority' || tier.id === 'fast')) {
        throw new Error('所选模型不支持 Fast 模式');
      }
    }
    const runId = randomUUID();
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
    const accessMode: AgentAccessMode = input.mode === 'agent' && input.accessMode === 'full' ? 'full' : 'workspace';
    const queueKey = queueKeyFor(runId, runOptions.resetQueueRoot ? '' : parentRunId, originSessionId, resumeSessionId, forkSessionId);
    const occupied = [...active.values()].some((item) => item.queueKey === queueKey);
    const queued = [...waiting.values()].some((item) => item.queueKey === queueKey);
    const task = taskLink || parent?.task;
    const imported = originSessionId && !parent ? runs.find((run) => run.originSessionId === originSessionId) : undefined;
    const conversationId = runOptions.conversationId || (parent ? conversationIdFor(parent)
      : imported ? conversationIdFor(imported) : runId);
    const run: AgentRun = { id: runId, ...(parentRunId ? { parentRunId } : {}), conversationId,
      queueRootId: runOptions.resetQueueRoot ? runId : parent?.queueRootId || runId,
      ...(originSessionId ? { originSessionId } : {}),
      provider: input.provider, mode: input.mode, accessMode, model, reasoningEffort,
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      objective, ...(knowledgeContext ? { knowledgeContext } : {}), ...(resolvedAttachments.length ? { attachments: resolvedAttachments.map((item) => item.attachment) } : {}),
      workspacePath: identity.workspacePath, ...workspaceMetadata, branch: identity.branch, headSha: identity.headSha,
      ...(input.cursorTrustPath !== undefined ? { cursorTrustPath: identity.workspacePath } : {}),
      status: 'queued', sessionId: forkSessionId ? '' : resumeSessionId, pid: null, result: '', error: '', events: [],
      ...(input.mode === 'agent' ? { changedFiles: [] } : {}), ...(task ? { task } : {}), createdAt, updatedAt: createdAt };
    runs = [run, ...runs];
    waiting.set(run.id, { adapter, resumeSessionId, forkSessionId, forkLastTurnId: runOptions.forkLastTurnId || '',
      imagePaths: resolvedAttachments.filter(item => isAgentImageAttachment(item.attachment)).map(item => item.filePath),
      fileAttachments: resolvedAttachments.filter(item => input.provider === 'cursor' || !isAgentImageAttachment(item.attachment))
        .map(item => ({ name: item.attachment.name, path: item.filePath })), queuePlacement, queueKey });
    pruneRuns();
    if (!dependenciesReady(run)) addEvent(run, 'lifecycle', `等待前置 Agent 完成：${run.task?.dependsOnConversationIds.join('、')}`);
    else if (occupied || queued) addEvent(run, 'lifecycle', parentRunId || originSessionId
      ? queuePlacement === 'next' ? '消息已插入当前会话队列，将在当前轮完成后优先执行'
        : '消息已加入当前会话队列，正在等待上一轮完成' : '');
    await persist();
    notify();
    await launchReadyQueues(queueKey);
    return run;
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
      mode: role === 'reviewer' ? 'ask' : 'agent',
      accessMode: role === 'reviewer' ? 'workspace' : selection.accessMode ?? source.accessMode,
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

  function codexSessionConversations(sessionId: string) {
    const explicit = new Set(runs.filter((run) => run.provider === 'codex' && run.sessionId === sessionId && run.conversationId)
      .map((run) => run.conversationId!));
    // Older retained runs may lose their root to the 100-run history cap. Their inferred root is not a real split.
    return explicit.size ? explicit : new Set([sessionId]);
  }

  async function assertPreciseForkReady(source: AgentRun, preparedWorkspace = false) {
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
    accessMode?: AgentAccessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier) {
    const source = runs.find((run) => run.id === runId);
    if (!source) throw new Error('找不到该 Agent 运行');
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
      return source;
    }
    const latest = latestConversationRun(conversationIdFor(source));
    const continuation = source.provider === 'codex' ? latest?.continuation : undefined;
    if (isHistoricalCodexThread(source)) {
      throw new Error('该消息属于旧 Codex 线程，请从会话最新消息续聊');
    }
    const awaitingSession = active.has(source.id) || (source.status === 'queued' && waiting.has(source.id));
    if (!source.sessionId && !continuation && !awaitingSession) throw new Error('该运行没有可恢复的 CLI 会话 ID');
    if (continuation) {
      if (source.id !== latest?.id) throw new Error('请从会话最新消息续聊');
      return start({ provider: 'codex', mode: source.mode, model: model === undefined ? source.model : model,
        reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
        serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
        objective, attachmentIds, accessMode: accessMode ?? source.accessMode, workspacePath: continuation.workspacePath },
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
      return start({ provider: 'codex', mode: source.mode, model: model === undefined ? source.model : model,
        reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
        serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
        objective, attachmentIds, accessMode: accessMode ?? source.accessMode, workspacePath: source.workspacePath,
        branch: source.branch, isolateWorkspace: true }, source.id, '', '', source.sessionId, 'append', undefined,
      forkWorkspaceMetadata(source), { conversationId: conversationIdFor(source), resetQueueRoot: true,
        forkLastTurnId: source.codexTurnId, branchPrefix: 'feature/' });
    }
    return start({ provider: source.provider, mode: source.mode, model: model === undefined ? source.model : model,
      reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
      serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
      objective, attachmentIds, accessMode: accessMode ?? source.accessMode, workspacePath: source.workspacePath }, source.id, source.sessionId,
    source.originSessionId, '', queuePlacement);
  }

  async function retry(runId: string, cursorTrustPath?: string) {
    const source = runs.find((run) => run.id === runId);
    if (!source) throw new Error('找不到该 Agent 运行');
    if (isHistoricalCodexThread(source)) throw new Error('该消息属于旧 Codex 线程，请从会话最新消息续聊');
    if (!['failed', 'interrupted', 'cancelled'].includes(source.status)) throw new Error('只有失败、中断或已取消的运行可以重新执行');
    if (cursorTrustPath !== undefined && (source.provider !== 'cursor' || cursorTrustPath !== source.workspacePath)) {
      throw new Error('Cursor 信任确认与当前会话目录不一致');
    }
    if (source.provider === 'codex' && source.sessionId
      && (source.requiresIsolation || codexSessionConversations(source.sessionId).size > 1)) {
      throw new Error('该旧 Codex 会话由多个会话共享，请先从已完成消息精确隔离后再继续');
    }
    return start({ provider: source.provider, mode: source.mode, accessMode: source.accessMode, model: source.model,
      reasoningEffort: source.reasoningEffort, serviceTier: source.serviceTier, objective: source.objective,
      attachmentIds: source.attachments?.map((item) => item.id) || [], workspacePath: source.workspacePath, cursorTrustPath },
    source.id, source.sessionId, source.originSessionId, '', 'append');
  }

  async function resumeCodexSession(sessionId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [],
    accessMode: AgentAccessMode = 'workspace', serviceTier?: AgentServiceTier) {
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
    await assertPreciseForkReady(source);
    return start({ provider: 'codex', mode: source.mode, model: model === undefined ? source.model : model,
      reasoningEffort: reasoningEffort === undefined ? source.reasoningEffort : reasoningEffort,
      serviceTier: serviceTier === undefined ? source.serviceTier : serviceTier,
      objective, attachmentIds, accessMode: source.accessMode, workspacePath: source.workspacePath, branch: source.branch,
      isolateWorkspace: true }, '', '', '', source.sessionId, 'append', undefined, forkWorkspaceMetadata(source),
    { forkLastTurnId: source.codexTurnId, branchPrefix: 'feature/' });
  }

  async function addCustomModel(input: AgentCustomModelInput) {
    const adapter = adapters.get(input.provider);
    if (!adapter) throw new Error('不支持的 Agent 执行器');
    const modelId = cleanText(input.modelId, 100);
    const label = cleanText(input.label, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(modelId)) throw new Error('模型 ID 格式不正确');
    if (!label) throw new Error('请填写模型名称');
    const builtIn = await adapter.health(false);
    if (builtIn.models.some((model) => model.id === modelId)) throw new Error('该模型已在执行器列表中');
    if (customModels.some((model) => model.provider === input.provider && model.modelId === modelId)) throw new Error('该自定义模型已存在');
    const model: StoredCustomModel = { id: randomUUID(), provider: input.provider, modelId, label, createdAt: new Date().toISOString() };
    customModels = [...customModels, model];
    await persistCustomModels();
    notify();
    return model;
  }

  async function removeCustomModel(id: string) {
    const model = customModels.find((item) => item.id === id);
    if (!model) throw new Error('找不到该自定义模型');
    if ([...active.keys()].some((runId) => {
      const run = runs.find((item) => item.id === runId);
      return run?.provider === model.provider && run.model === model.modelId;
    })) throw new Error('该模型正在执行，暂时不能删除');
    customModels = customModels.filter((item) => item.id !== id);
    await persistCustomModels();
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
    try {
      await exec('/opt/homebrew/bin/cursor', ['--reuse-window', '--goto', resolved], { timeout: 5000, maxBuffer: 64_000 });
      await exec('/usr/bin/open', ['-a', 'Cursor'], { timeout: 5000, maxBuffer: 64_000 });
    } catch { throw new Error('无法在 Cursor 中打开该文件'); }
    return { opened: true, path: file.path };
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

  async function removeConversation(runId: string) {
    const root = runs.find((run) => run.conversationId === runId || run.id === runId);
    if (!root) throw new Error('找不到该 Agent 会话');
    const conversationId = conversationIdFor(root);
    const ids = new Set(runs.filter((run) => conversationIdFor(run) === conversationId).map((run) => run.id));
    if (!root.conversationId && root.provider === 'codex' && runs.some((run) => !ids.has(run.id)
      && run.provider === 'codex' && run.sessionId && run.sessionId === root.sessionId)) {
      throw new Error('旧 Codex 会话尚未确认归属，不能安全删除');
    }
    // 删除在状态锁内完成：先移除整条会话的排队项，再停止并等待执行收尾。
    // 不能逐条调用 stop，否则它会启动下一条排队消息；也不能先删记录再等退出。
    for (const run of runs) {
      if (ids.has(run.id) && waiting.delete(run.id)) {
        run.status = 'cancelled';
        run.error = '';
        addEvent(run, 'lifecycle', '删除会话，已取消排队');
      }
    }
    const stopping = [...active.entries()].filter(([id]) => ids.has(id)).map(([, process]) => process);
    for (const process of stopping) process.controller.abort();
    await Promise.all(stopping.map((process) => process.task));
    const removedRuns = runs.filter((run) => ids.has(run.id));
    const removedAttachmentIds = new Set(removedRuns.flatMap((run) => [...(run.attachments || []), ...(run.supplements || []).flatMap(item => item.attachments)].map(item => item.id)));
    const removedSessionIds = new Set(removedRuns.filter((run) => run.provider === 'codex')
      .flatMap((run) => [run.originSessionId, run.sessionId, run.continuation?.sessionId])
      .filter((sessionId): sessionId is string => !!sessionId));
    runs = runs.filter((run) => !ids.has(run.id));
    const hiddenSessionIds = new Set([...removedSessionIds]
      .filter((sessionId) => !runs.some((run) => run.provider === 'codex'
        && [run.originSessionId, run.sessionId, run.continuation?.sessionId].includes(sessionId))));
    runs = runs.map((run) => !run.task ? run : run.task.parentConversationId === conversationId
      ? { ...run, task: undefined }
      : run.task.dependsOnConversationIds.includes(conversationId)
        ? { ...run, task: { ...run.task, dependsOnConversationIds: run.task.dependsOnConversationIds.filter((id) => id !== conversationId) } }
        : run);
    const retainedAttachmentIds = new Set(runs.flatMap((run) => [...(run.attachments || []), ...(run.supplements || []).flatMap(item => item.attachments)].map(item => item.id)));
    const orphanedAttachmentIds = [...removedAttachmentIds].filter((id) => !retainedAttachmentIds.has(id));
    for (const sessionId of hiddenSessionIds) hiddenCodexSessionIds.add(sessionId);
    delete conversationTitles[conversationId];
    for (const sessionId of hiddenSessionIds) delete conversationTitles[sessionId];
    if (hiddenSessionIds.size) {
      codexSessions = codexSessions.filter((session) => !hiddenSessionIds.has(session.id));
      for (const sessionId of hiddenSessionIds) delete codexSessionDetails[sessionId];
      codexSync = { ...codexSync, total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
      await Promise.all([persist(), persistCodexSessions(), persistConversationTitles()]);
    } else await Promise.all([persist(), persistConversationTitles()]);
    if (attachmentRemover && orphanedAttachmentIds.length) await attachmentRemover(orphanedAttachmentIds);
    notify();
    return { deleted: ids.size };
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
    await persist();
    if (attachmentRemover && orphanedAttachmentIds.length) await attachmentRemover(orphanedAttachmentIds);
    notify();
    await launchNext(queueKey);
    return { deleted: true };
  }

  async function syncCodexSessions() {
    const sessions = await Promise.all((await codexSessionSource.listSessions()).map(resolveRenamedWorkspace));
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const nextSessions = [...byId.values()].filter((session) => !session.archived && !hiddenCodexSessionIds.has(session.id))
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
    return codexSessionDetails[id] || resolveRenamedWorkspace(await codexSessionSource.session(id));
  }

  async function removeCodexSession(id: string) {
    if (!codexSessions.some((session) => session.id === id)) throw new Error('找不到该 Codex 会话');
    hiddenCodexSessionIds.add(id);
    codexSessions = codexSessions.filter((session) => session.id !== id);
    delete codexSessionDetails[id];
    delete conversationTitles[id];
    codexSync = { ...codexSync, total: codexSessions.length, hidden: hiddenCodexSessionIds.size };
    await Promise.all([persistCodexSessions(), persistConversationTitles()]);
    notify();
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
  async function pauseForEdit(runId: string) {
    const run = runs.find(item => item.id === runId);
    if (!run) throw new Error('找不到该 Agent 运行');
    if (isHistoricalCodexThread(run)) throw new Error('该消息属于旧 Codex 线程，不能暂停编辑');
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
    if (waiting.has(run.id)) {
      waiting.delete(run.id);
      run.status = 'cancelled';
    }
    await persist();
    const processes = [...active.entries()].filter(([, process]) => process.queueKey === queueKey);
    for (const [, process] of processes) process.controller.abort();
    await Promise.all(processes.map(([, process]) => process.task));
    if (!run.sessionId) run.sessionId = processes.map(([id]) => runs.find(item => item.id === id)?.sessionId).find(Boolean) || '';
    run.error = '';
    addEvent(run, 'lifecycle', '会话已暂停，等待编辑消息后继续；已有结果和文件改动保留');
    await persist();
    notify(run);
    return run;
  }

  async function revise(runId: string, objective: string, cursorTrustPath?: string) {
    const source = runs.find(run => run.id === runId);
    if (!source?.pausedForEdit || active.has(runId)) throw new Error('请先暂停该消息再编辑');
    if (isHistoricalCodexThread(source)) throw new Error('该消息属于旧 Codex 线程，不能修订');
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
    source.id, source.sessionId, source.originSessionId, '', 'next');
    next.revisesRunId = source.id;
    for (const [id, pending] of waiting) {
      const queued = runs.find(run => run.id === id);
      if (queued && queued.id !== next.id && queued.parentRunId === source.id) {
        queued.parentRunId = next.id;
        pending.resumeSessionId = next.sessionId;
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
    for (const candidate of waiting.values()) {
      if (candidate.queueKey === pending.queueKey) candidate.queuePlacement = 'append';
    }
    pending.queuePlacement = 'next';
    pending.resumeSessionId = activeRun.sessionId;
    run.parentRunId = activeRun.id;
    addEvent(run, 'lifecycle', '已调整方向：停止当前轮后将立即执行此消息');
    addEvent(activeRun, 'lifecycle', '收到调整方向，正在停止当前轮');
    await persist();
    process.controller.abort();
    return run;
  }

  async function dashboard(force = false): Promise<AgentRuntimeDashboard> {
    const runtimes = await Promise.all([...adapters.keys()].map((provider) => runtimeHealth(provider, force)));
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
    return { revision, runtimes, runs: [...recent, ...anchors], codexSessions, conversationTitles, codexSync,
      activeWorkspaceLocks: [...active.entries()].map(([runId, item]) => ({
      workspacePath: item.workspacePath, runId, provider: item.provider,
    })) };
  }

  function subscribe(subscriber: AgentRuntimeSubscriber) {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return { dashboard, start: (input: StartAgentRunInput) => exclusive(() => start(input)),
    migrateConversationIds: (assignments: { runId: string; conversationId: string; codexTurnId?: string }[]) =>
      exclusive(() => migrateConversationIds(assignments)),
    prepareConversationIsolation: (conversationId: string, preparedWorkspacePath = '') =>
      exclusive(() => prepareConversationIsolation(conversationId, preparedWorkspacePath)),
    startRequirementDevelopment: (input: StartAgentRunInput, sourceId: string, title: string) => exclusive(() => start(input, '', '', '', '', 'append',
      { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title, source: 'workflow', sourceId: `requirement:${sourceId}` })),
    findRequirementDevelopment: (sourceId: string) => runs.find(run => run.task?.sourceId === `requirement:${sourceId}`),
    startJiraFix: (input: StartAgentRunInput, sourceId: string, title: string) => exclusive(() => start(input, '', '', '', '', 'append',
      { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title, source: 'workflow', sourceId: `jira-fix:${sourceId}` })),
    findJiraFix: (sourceId: string) => runs.find(run => run.task?.sourceId === `jira-fix:${sourceId}`),
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
    resume: (runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [],
      accessMode?: AgentAccessMode, queuePlacement: AgentQueuePlacement = 'append', serviceTier?: AgentServiceTier) => exclusive(() => resume(runId, objective, model, reasoningEffort,
      attachmentIds, accessMode, queuePlacement, serviceTier)),
    retry: (runId: string, cursorTrustPath?: string) => exclusive(() => retry(runId, cursorTrustPath)),
    resumeCodexSession: (sessionId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [], accessMode: AgentAccessMode = 'workspace', serviceTier?: AgentServiceTier) => exclusive(() => resumeCodexSession(sessionId, objective, model, reasoningEffort, attachmentIds, accessMode, serviceTier)),
    fork: (runId: string, objective: string, model?: string, reasoningEffort?: AgentReasoningEffort | '', attachmentIds: string[] = [], serviceTier?: AgentServiceTier) => exclusive(() => fork(runId, objective, model, reasoningEffort, attachmentIds, serviceTier)),
    addCustomModel: (input: AgentCustomModelInput) => exclusive(() => addCustomModel(input)),
    removeCustomModel: (id: string) => exclusive(() => removeCustomModel(id)),
    workspaceFiles,
    workspaceKnowledge,
    openChangedFile,
    revealChangedFile,
    openChangedFileInBrowser,
    workspaceBranches: listGitBranches,
    updateConversationTitle: (id: string, title: string) => exclusive(() => updateConversationTitle(id, title)),
    removeConversation: (runId: string) => exclusive(() => removeConversation(runId)),
    removeQueuedRun: (runId: string) => exclusive(() => removeQueuedRun(runId)),
    syncCodexSessions: () => exclusive(() => syncCodexSessions()),
    codexSession,
    removeCodexSession: (id: string) => exclusive(() => removeCodexSession(id)),
    stop: (runId: string) => exclusive(() => stop(runId)),
    pauseForEdit: (runId: string) => exclusive(() => pauseForEdit(runId)),
    revise: (runId: string, objective: string, cursorTrustPath?: string) => exclusive(() => revise(runId, objective, cursorTrustPath)),
    steer: (runId: string) => exclusive(() => steer(runId)),
    subscribe,
    revision: () => revision,
    close: async () => { closing = true; subscribers.clear(); waiting.clear(); for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map((item) => item.task)); await Promise.all([writeLock, modelWriteLock, codexSessionWriteLock, conversationTitleWriteLock]); },
  };
}

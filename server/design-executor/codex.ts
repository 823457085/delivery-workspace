/** 通过已登录 CLI 执行受限阶段：固定 argv、只读沙箱、MCP 白名单；不拷贝或暴露凭据。 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { stageResultSchema, type DesignExecution, type ExecutionStage, type ExecutorHealth, type StageResult, type ToolProof } from '../../shared/design-execution.js';
import { allowedTools, stagePrompt } from './policy.js';
import { cliBinary } from '../cli-runtime.js';
import { resolveDesignSupportPaths } from './support.js';

const exec = promisify(execFile);
export function isSessionBusyDiagnostic(diagnostic: string) {
  return /session.*(?:in use|locked|busy|active|in progress)|thread.*(?:in use|locked|busy|active|in progress)|active turn|already running/i.test(diagnostic);
}
class SessionBusyError extends Error {}
export interface PhaseContext {
  stage: ExecutionStage; run: DesignExecution; directory: string; signal: AbortSignal;
  onThread: (id: string) => Promise<void>; onEvent: (message: string) => void;
}
export interface PhaseExecutor {
  health(): Promise<ExecutorHealth>;
  execute(context: PhaseContext): Promise<{ result: StageResult; proof: ToolProof[] }>;
}
type McpInfo = { name: string; enabled: boolean; enabled_tools?: string[] | null; disabled_tools?: string[] | null };
export function phaseArguments(context: Pick<PhaseContext, 'stage' | 'run' | 'directory'>, inventory: McpInfo[], schemaFile: string, resultFile: string) {
  const atlassian = inventory.find((item) => item.name === 'atlassian' && item.enabled);
  if (!atlassian) throw new Error('未配置可用的 Atlassian MCP 连接');
  const allowed = allowedTools(context.stage).filter((tool) => !atlassian.disabled_tools?.includes(tool) &&
    (!atlassian.enabled_tools || atlassian.enabled_tools.includes(tool)));
  const approvalOverrides = context.stage === 'publish' || context.stage === 'jira'
    ? ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']
    : ['-c', 'approval_policy="never"'];
  const overrides = [
    '-c', 'sandbox_mode="read-only"', ...approvalOverrides,
    // Background stages use native tools, without a desktop-only code-mode host dependency.
    '-c', 'features.code_mode=false', '-c', 'features.code_mode_only=false', '-c', 'features.code_mode_host=false',
    '-c', 'mcp_servers.atlassian.required=true', '-c', `mcp_servers.atlassian.enabled_tools=${JSON.stringify(allowed)}`,
    // Plugin-provided servers may not exist in config.toml. Replace the whole entry with an
    // inert, disabled transport so CLI config parsing succeeds without copying plugin credentials.
    ...inventory.filter((item) => item.name !== 'atlassian' && /^[\w-]+$/.test(item.name)).flatMap((item) => ['-c', `mcp_servers.${item.name}={enabled=false,command="false"}`]),
  ];
  return ['exec', ...(context.run.threadId ? ['resume', context.run.threadId] : ['--cd', context.directory]),
    ...overrides, '--thread-source', 'cli', '--skip-git-repo-check', '--json', '--output-schema', schemaFile, '--output-last-message', resultFile, '-'];
}

/** 只提取固定错误类别与合法配置名；原始 CLI 诊断可能含凭据，不落盘、不回传页面。 */
export function codexFailureMessage(code: number | null, diagnostic: string) {
  const prefix = `Codex 执行失败（退出码 ${code ?? '未知'}）`;
  if (/failed to spawn code-mode host|codex-code-mode-host.*(?:No such file|not found)/i.test(diagnostic)) {
    return `${prefix}：Code Mode 辅助程序不可用，请更新执行器后从当前阻塞阶段续跑；不是 Skill 缺失`;
  }
  if (/invalid transport/i.test(diagnostic)) {
    const server = diagnostic.match(/in `mcp_servers\.([\w-]+)`/)?.[1];
    return `${prefix}：MCP${server ? ` ${server}` : ''} 配置缺少有效 transport，尚未开始执行任务`;
  }
  if (/Error loading config\.toml|failed to load bootstrap configuration/i.test(diagnostic)) return `${prefix}：CLI 配置加载失败，请检查配置兼容性`;
  const argument = diagnostic.match(/unexpected argument '(-{1,2}[\w-]+)'/i)?.[1];
  if (argument) return `${prefix}：当前 CLI 不支持启动参数 ${argument}`;
  if (/invalid_json_schema|Invalid schema for response_format/i.test(diagnostic)) return `${prefix}：阶段结果的 JSON Schema 不被当前模型接受`;
  if (/mcp.*(?:startup failed|failed to start|required.*failed)|required mcp servers/i.test(diagnostic)) return `${prefix}：必需的 MCP 连接启动失败，请核对连接可用性`;
  if (isSessionBusyDiagnostic(diagnostic)) return `${prefix}：原会话仍在运行，不能并发续跑`;
  if (/no session found|session.*not found|thread.*not found|cannot find.*(?:session|thread)/i.test(diagnostic)) return `${prefix}：CLI 找不到原会话，已保留原会话标识，未新建替代任务`;
  const categories = [
    ['MCP', /mcp/i], ['会话', /session|thread/i], ['模型', /model/i], ['工具定义', /tool.*(?:schema|invalid|unsupported)/i],
    ['Code Mode', /code.mode/i], ['网络连接', /connection|network|handshake|stream disconnected/i],
    ['超时', /timed? ?out|timeout/i], ['权限', /permission|denied|unauthorized|forbidden/i], ['配置', /config/i],
    ['会话忙', /busy|active|in progress|already/i], ['记录缺失', /not found|no .*found|does not exist|missing/i],
    ['续跑参数', /invalid|argument|resume/i], ['读取记录', /read|load|file|parse/i],
  ] as const;
  const hints = categories.filter(([, pattern]) => pattern.test(diagnostic)).map(([label]) => label);
  if (hints.length) return `${prefix}：启动诊断涉及${hints.join('、')}；原始诊断未展示以保护凭据`;
  return `${prefix}：${diagnostic ? '未识别的 CLI 运行错误，原始诊断未展示以保护凭据' : 'CLI 未返回诊断信息'}`;
}

export function extractToolProof(event: Record<string, unknown>): ToolProof | undefined {
  if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') return;
  const item = event.item as Record<string, unknown>;
  if (item.type === 'command_execution') return { tool: 'command_execution', target: '', succeeded: item.exit_code === 0 };
  if (item.type !== 'mcp_tool_call' || item.server !== 'atlassian' || typeof item.tool !== 'string') return;
  let args = item.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  const fields = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const target = fields.issue_key ?? fields.page_id ?? '';
  const result = item.result as { isError?: boolean } | undefined;
  return { tool: item.tool, target: String(target), succeeded: item.status === 'completed' && !item.error && !result?.isError };
}

export function createCodexExecutor(options: { binary?: string; timeoutMs?: number; sessionRetryMs?: number; sessionWaitMs?: number } = {}): PhaseExecutor {
  const binary = options.binary || cliBinary;
  const { skillRoot, kitRoot } = resolveDesignSupportPaths();
  let cachedHealth: ExecutorHealth | undefined;
  async function inventory(): Promise<McpInfo[]> {
    const result = await exec(binary, ['mcp', 'list', '--json'], { timeout: 15_000, maxBuffer: 1_000_000 });
    const parsed = JSON.parse(result.stdout) as McpInfo[];
    return parsed.map(({ name, enabled, enabled_tools, disabled_tools }) => ({ name, enabled, enabled_tools, disabled_tools }));
  }
  async function health(): Promise<ExecutorHealth> {
    if (cachedHealth && Date.now() - Date.parse(cachedHealth.checkedAt) < 30_000) return cachedHealth;
    const [version, login, mcp, skills] = await Promise.allSettled([
      exec(binary, ['--version'], { timeout: 10_000 }), exec(binary, ['login', 'status'], { timeout: 10_000 }), inventory(),
      Promise.all([
        ...['apex-frontend-tech-design-delivery', 'apex-jira-feature-development', 'delivery-gate-docs', 'confluence-markdown-publish', 'jira-task-compliance'].map((name) => fs.access(path.join(skillRoot, name, 'SKILL.md'))),
        fs.access(path.join(kitRoot, 'prompts/S2a-tech-design.md')), fs.access(path.join(kitRoot, 'artifacts/templates/tech-design.md')),
      ]),
    ]);
    const cli = version.status === 'fulfilled' ? version.value.stdout.trim() : '';
    const authenticated = login.status === 'fulfilled' && /Logged in/i.test(login.value.stdout + login.value.stderr);
    const atlassianConfigured = mcp.status === 'fulfilled' && mcp.value.some((item) => item.name === 'atlassian' && item.enabled);
    const skillsReady = skills.status === 'fulfilled';
    const gaps = [!cli && 'Codex CLI 不可用', !authenticated && 'Codex 未登录', !atlassianConfigured && 'Atlassian 连接未配置', !skillsReady && 'Skill / 规范包缺失'].filter(Boolean);
    cachedHealth = { ready: !gaps.length, cli, authenticated, atlassianConfigured, skillsReady, checkedAt: new Date().toISOString(),
      message: gaps.join('；') || '本机执行环境可用；远端访问和写入权限在任务执行时核实' };
    return cachedHealth;
  }
  async function execute(context: PhaseContext) {
    const status = await health();
    if (!status.ready) throw new Error(status.message);
    if (context.signal.aborted) throw new Error('运行已停止');
    await fs.mkdir(context.directory, { recursive: true, mode: 0o700 });
    const schemaFile = path.join(context.directory, 'stage-schema.json');
    const attempt = context.run.steps.find((step) => step.id === context.stage)!.attempts;
    const resultFile = path.join(context.directory, `${context.stage}-${attempt}.json`);
    await fs.writeFile(schemaFile, JSON.stringify(z.toJSONSchema(stageResultSchema)), { mode: 0o600 });
    const args = phaseArguments(context, await inventory(), schemaFile, resultFile);
    const proof: ToolProof[] = [];
    let threadPersistence = Promise.resolve();
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let waitingReported = false;
    let sessionDeadline = Infinity;
    const executeAttempt = () => new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: context.directory, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
      let executionStarted = false;
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let reason = '';
      let diagnostic = '';
      let eventFailure = '';
      const stderrDecoder = new StringDecoder('utf8');
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (message: string) => {
        if (reason) return;
        reason = message;
        const kill = (signal: NodeJS.Signals) => {
          try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already exited. */ }
        };
        kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 5000);
      };
      const abort = () => terminate('执行已停止；远端请求可能已生效，续跑会先核对已有产物');
      context.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => terminate('本阶段执行超时；请查看已有产物后续跑'), Math.max(1, deadline - Date.now()));
      const finish = (error?: Error) => {
        clearTimeout(timer); clearTimeout(killTimer); context.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      child.on('error', () => finish(new Error('Codex 进程未能启动，请检查本机 CLI')));
      child.stdin.on('error', () => { /* Exit/error handlers report startup failure. */ });
      child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + stderrDecoder.write(chunk)).slice(-16_384); });
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (buffer.length > 2_000_000) { terminate('阶段事件超出大小限制'); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (['thread.started', 'turn.started', 'item.started', 'item.completed'].includes(String(event.type))) executionStarted = true;
            if (event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[0-9a-f-]{36}$/.test(event.thread_id)) {
              const id = event.thread_id;
              threadPersistence = threadPersistence.then(() => context.onThread(id));
              threadPersistence.catch(() => terminate('无法保存会话标识，已停止以避免重复会话'));
            }
            const item = extractToolProof(event);
            if (item) { proof.push(item); context.onEvent(`${item.succeeded ? '已完成' : '未通过'}：${item.tool}${item.target ? ` · ${item.target}` : ''}`); }
            if (event.type === 'turn.failed' || event.type === 'error') {
              const error = event.error as { message?: unknown } | undefined;
              const message = event.message ?? error?.message;
              if (typeof message === 'string') eventFailure = message.slice(0, 4096);
              context.onEvent('Codex 报告运行异常，等待阶段结果确认');
            }
          } catch { /* Ignore non-JSON diagnostics without echoing them. */ }
        }
      });
      child.on('close', (code) => {
        const details = `${diagnostic}${eventFailure}`;
        // Only retry a rejected resume before a turn or any tool execution has started.
        if (!reason && code !== 0 && context.run.threadId && !executionStarted && !proof.length && isSessionBusyDiagnostic(details)) {
          finish(new SessionBusyError('原会话写锁被另一 Codex 进程占用')); return;
        }
        finish(reason ? new Error(reason) : code !== 0 ? new Error(codexFailureMessage(code, details)) : undefined);
      });
      if (context.signal.aborted) abort();
      else child.stdin.end(stagePrompt(context.stage, context.run, skillRoot, kitRoot));
    });
    while (true) {
      if (context.signal.aborted) throw new Error('运行已停止');
      if (Date.now() >= sessionDeadline) throw new Error('原会话写锁持续被另一 Codex 进程占用，已停止等待；仅结束回复不一定释放写锁。请在占用它的 Codex 客户端释放会话后续跑，已通过阶段保留');
      if (Date.now() >= deadline) throw new Error('等待原会话释放或阶段执行超时，请结束占用该会话的操作后续跑');
      try {
        await executeAttempt();
        break;
      } catch (error) {
        if (!(error instanceof SessionBusyError)) throw error;
        if (!waitingReported) {
          sessionDeadline = Math.min(deadline, Date.now() + (options.sessionWaitMs ?? 10_000));
          context.onEvent('原会话写锁被另一 Codex 进程占用，短暂等待释放；持续占用将明确阻塞，不新建会话或执行外部写入');
          waitingReported = true;
        }
        try { await delay(Math.min(options.sessionRetryMs ?? 5000, Math.max(1, Math.min(deadline, sessionDeadline) - Date.now())), undefined, { signal: context.signal }); }
        catch { throw new Error('运行已停止'); }
      }
    }
    await threadPersistence;
    const stat = await fs.stat(resultFile);
    if (stat.size > 2_000_000) throw new Error('阶段结果超过大小限制');
    const result = stageResultSchema.parse(JSON.parse(await fs.readFile(resultFile, 'utf8')));
    return { result, proof };
  }
  return { health, execute };
}

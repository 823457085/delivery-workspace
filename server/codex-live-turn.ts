/**
 * 一个运行独占一条 app-server stdio 连接；通过 turn/steer 向同一轮补充输入。
 * 原会话被空闲桌面端持有时经其协作通道续接；不删除锁或创建替代会话。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { codexChildEnvironment } from './cli-runtime.js';
import { codexSessionErrorText, codexWriterThreadId } from '../shared/codex-session-error.js';
import { runCodexDesktopTurn } from './codex-desktop-turn.js';
import type { AgentRun, AgentRunEvent } from '../shared/agent-runtime.js';

export type LiveInput = { text: string; imagePaths: string[]; id: string };
export type LiveSteer = (input: LiveInput) => Promise<void>;
export interface LiveContext {
  run: AgentRun;
  resumeSessionId?: string;
  forkSessionId?: string;
  forkLastTurnId?: string;
  imagePaths: string[];
  signal: AbortSignal;
  onPid(pid: number): void;
  onSession(id: string): void | Promise<void>;
  onTurn?(id: string): void | Promise<void>;
  onEvent(type: AgentRunEvent['type'], message: string): void;
  onOutput?(text: string): void;
  onSteer?(steer: LiveSteer | undefined): void;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject { return value && typeof value === 'object' ? value as JsonObject : {}; }
function input(text: string, images: string[]) {
  return [{ type: 'text', text, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))];
}
function codexErrorMessage(error: unknown, fallback: string) {
  const message = String(object(error).message || fallback);
  return codexSessionErrorText(message);
}
async function verifyForkResponse(response: JsonObject, workspacePath: string, lastTurnId: string) {
  const returnedCwd = response.cwd;
  if (typeof returnedCwd !== 'string' || await fs.realpath(returnedCwd) !== await fs.realpath(workspacePath)) {
    throw new Error('Codex 分叉返回的工作区与请求不一致');
  }
  const turns = object(response.thread).turns;
  if (!Array.isArray(turns) || !turns.length || object(turns.at(-1)).id !== lastTurnId) {
    throw new Error('Codex 分叉未停在指定的历史轮次');
  }
}

export function runCodexLiveTurn(binary: string, context: LiveContext, prompt: string,
  resumeDesktopTurn = runCodexDesktopTurn): Promise<string> {
  return new Promise((resolve, reject) => {
    const { run } = context;
    const sandbox = run.mode !== 'agent' ? 'read-only' : run.accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
    const serviceTier = run.serviceTier === 'default' || run.serviceTier === 'priority' ? run.serviceTier : undefined;
    const child = spawn(binary, ['app-server', '--stdio', '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"',
      ...(serviceTier ? ['-c', `service_tier="${serviceTier}"`] : []),
      ...(sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])],
    { cwd: run.workspacePath, env: codexChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let sequence = 0;
    let threadId = '';
    let turnId = '';
    let recordedTurnId = '';
    let turnRecording: Promise<void> = Promise.resolve();
    let result = '';
    let messageId = '';
    let settled = false;
    let childClosed = false;
    let desktopRunning = false;
    let completion: { error?: Error } | undefined;
    let settlingCompletion = false;
    const pending = new Map<number, { method: string; resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const lines = createInterface({ input: child.stdout });
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      context.onSteer?.(undefined);
      context.signal.removeEventListener('abort', abort);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error || new Error('当前轮已结束')); }
      pending.clear();
      lines.close();
      const settleRun = () => { if (error) reject(error); else resolve(result); };
      // 等旧进程释放会话锁后，服务层才可以启动队列中的下一轮。
      if (childClosed) { settleRun(); return; }
      child.once('close', settleRun);
      child.stdin.end();
      kill('SIGTERM');
      const forceKill = setTimeout(() => kill('SIGKILL'), 5000);
      forceKill.unref();
      child.once('close', () => clearTimeout(forceKill));
    };
    // 桌面路径须先按本轮 ID 确认中断，不能直接杀掉只读连接后遗留任务。
    const abort = () => { if (!desktopRunning) finish(new Error('Agent 运行已中断')); };
    const finishCompletedTurn = () => {
      if (!completion || settlingCompletion || [...pending.values()].some(item => item.method === 'turn/steer')) return;
      settlingCompletion = true;
      void turnRecording.then(() => finish(completion?.error), error => finish(error instanceof Error ? error : new Error(String(error))));
    };
    // 一轮按完成通知或用户中断结束，不按累计运行时长截断；RPC 回执仍有独立超时。
    const write = (message: JsonObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params: JsonObject) => new Promise<JsonObject>((accept, fail) => {
      if (settled) { fail(new Error('当前轮已结束')); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} 响应超时，请检查运行记录后再操作`)); finishCompletedTurn(); }, 30_000);
      pending.set(id, { method, resolve: accept, reject: fail, timer });
      write({ id, method, params });
    });
    const recordTurn = (id: unknown) => {
      if (typeof id !== 'string' || !id) return turnRecording;
      if (recordedTurnId !== id) {
        recordedTurnId = id;
        turnRecording = Promise.resolve().then(() => context.onTurn?.(id));
      }
      return turnRecording;
    };
    const readyTurn = (id: unknown) => {
      if (typeof id !== 'string' || !id || settled || completion) return;
      turnId = id;
      context.onSteer?.(async supplemental => {
        const expectedTurnId = turnId;
        if (!expectedTurnId || settled) throw new Error('当前轮已结束，补充要求未发送');
        const response = await request('turn/steer', { threadId, expectedTurnId, clientUserMessageId: supplemental.id,
          input: input(supplemental.text, supplemental.imagePaths) });
        if (response.turnId !== expectedTurnId) throw new Error('补充要求未确认送达当前轮');
      });
    };
    lines.on('line', line => {
      let message: JsonObject;
      try { message = object(JSON.parse(line)); } catch { return; }
      if (typeof message.id === 'number' && !message.method) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(codexErrorMessage(message.error, 'Codex 请求失败'), { cause: message.error }));
        else item.resolve(object(message.result));
        finishCompletedTurn();
        return;
      }
      if (message.id !== undefined && message.method) {
        // 当前工作台不提供交互式授权；不能自动批准服务端请求，亦不能使请求悬挂。
        write({ id: message.id, error: { code: -32601, message: 'Delivery does not support this interactive request' } });
        return;
      }
      const params = object(message.params);
      if (!threadId || params.threadId !== threadId) return;
      const turn = object(params.turn);
      if (message.method === 'turn/started') {
        readyTurn(turn.id);
        void recordTurn(turn.id).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
      }
      if (!turnId || (params.turnId && params.turnId !== turnId)) return;
      if (message.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
        if (messageId !== params.itemId) { messageId = params.itemId; result = ''; }
        result += params.delta;
        context.onOutput?.(result);
      }
      if (message.method === 'item/completed' || message.method === 'item/started') {
        const item = object(params.item);
        if (item.type === 'agentMessage' && message.method === 'item/completed' && typeof item.text === 'string') {
          result = item.text;
          messageId = String(item.id || '');
          context.onOutput?.(result);
          context.onEvent('message', item.text);
        } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type))) {
          context.onEvent('tool', `${message.method === 'item/started' ? '正在执行' : '执行完成'}：${String(item.command || item.tool || item.type)}`);
        }
      }
      if (message.method === 'error') context.onEvent('diagnostic', codexErrorMessage(params.error, 'Codex 运行错误'));
      if (message.method === 'turn/completed' && turn.id === turnId) {
        turnId = '';
        context.onSteer?.(undefined);
        completion = turn.status === 'completed' ? {} : { error: new Error(codexErrorMessage(turn.error, `Codex 运行${turn.status}`)) };
        finishCompletedTurn();
      }
    });
    child.stderr.on('data', () => { /* 不向浏览器暴露 app-server 的账户或环境诊断 */ });
    child.stdin.on('error', error => finish(error));
    child.on('error', error => finish(error));
    child.on('close', code => {
      childClosed = true;
      if (completion && ![...pending.values()].some(item => item.method === 'turn/steer')) finishCompletedTurn();
      else finish(new Error(`Codex 连接提前结束（退出码 ${code}）`));
    });
    if (child.pid) context.onPid(child.pid);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) { abort(); return; }
    void (async () => {
      await request('initialize', { clientInfo: { name: 'delivery_workspace', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      write({ method: 'initialized', params: {} });
      const method = context.forkSessionId ? 'thread/fork' : context.resumeSessionId ? 'thread/resume' : 'thread/start';
      const params = { cwd: run.workspacePath, approvalPolicy: 'never', sandbox,
        ...(method !== 'thread/resume' ? { threadSource: 'cli' } : {}),
        ...(run.model ? { model: run.model } : {}),
        ...(context.forkSessionId || context.resumeSessionId ? { threadId: context.forkSessionId || context.resumeSessionId } : {}),
        ...(method === 'thread/fork' && context.forkLastTurnId ? { lastTurnId: context.forkLastTurnId } : {}),
        config: { ...(run.reasoningEffort ? { model_reasoning_effort: run.reasoningEffort } : {}),
          ...(sandbox === 'workspace-write' ? { 'sandbox_workspace_write.network_access': true } : {}) } };
      let response: JsonObject;
      try { response = await request(method, params); }
      catch (error) {
        const writerId = error instanceof Error ? codexWriterThreadId(String(object(error.cause).message || '')) : undefined;
        if (method === 'thread/resume' && writerId && writerId.toLowerCase() === context.resumeSessionId?.toLowerCase()) {
          desktopRunning = true;
          result = await resumeDesktopTurn(context, prompt);
          finish();
          return;
        }
        const diagnostic = error instanceof Error ? error.message : String(error);
        const archivedId = diagnostic.match(/^session ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) is archived\b/i)?.[1];
        if (method !== 'thread/resume' || !archivedId || !context.resumeSessionId
          || archivedId.toLowerCase() !== context.resumeSessionId.toLowerCase()) throw error;
        const restored = await request('thread/unarchive', { threadId: context.resumeSessionId });
        if (String(object(restored.thread).id || '').toLowerCase() !== archivedId.toLowerCase()) {
          throw new Error('Codex 恢复归档会话返回的 ID 不一致');
        }
        response = await request(method, params);
      }
      if (method === 'thread/fork' && context.forkLastTurnId) {
        await verifyForkResponse(response, run.workspacePath, context.forkLastTurnId);
      }
      threadId = String(object(response.thread).id || '');
      if (!threadId) throw new Error('Codex 未返回会话 ID');
      if (method === 'thread/fork' && threadId === context.forkSessionId) throw new Error('Codex 分叉未返回独立会话 ID');
      await context.onSession(threadId);
      const started = await request('turn/start', { threadId, input: input(prompt, context.imagePaths),
        ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}) });
      await recordTurn(object(started.turn).id);
      readyTurn(object(started.turn).id);
    })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Create a historical branch of a Codex thread without adding a user turn. */
export function forkCodexThread(binary: string, source: {
  sessionId: string; lastTurnId: string; workspacePath: string; mode: AgentRun['mode'];
  accessMode: AgentRun['accessMode']; model: string; reasoningEffort: AgentRun['reasoningEffort'];
  serviceTier?: AgentRun['serviceTier'];
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const sandbox = source.mode !== 'agent' ? 'read-only' : source.accessMode === 'full' ? 'danger-full-access' : 'workspace-write';
    const child = spawn(binary, ['app-server', '--stdio', '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"',
      ...(source.serviceTier ? ['-c', `service_tier="${source.serviceTier}"`] : []),
      ...(sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])],
    { cwd: source.workspacePath, env: codexChildEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let sequence = 0;
    let finished = false;
    let closed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const requests = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>();
    const timer = setTimeout(() => complete(new Error('Codex 无消息分叉超时')), 60_000);
    const complete = (error?: Error, threadId?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const pending of requests.values()) pending.reject(error || new Error('Codex 连接已结束'));
      requests.clear();
      lines.close();
      child.stdin.end();
      if (error) { child.kill('SIGTERM'); reject(error); }
      else if (closed) resolve(threadId!);
      else {
        closeTimer = setTimeout(() => child.kill('SIGTERM'), 5000);
        closeTimer.unref();
        child.once('close', () => resolve(threadId!));
      }
    };
    const request = (method: string, params: JsonObject) => new Promise<JsonObject>((accept, fail) => {
      const id = ++sequence;
      requests.set(id, { resolve: accept, reject: fail });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    lines.on('line', line => {
      let message: JsonObject;
      try { message = object(JSON.parse(line)); } catch { return; }
      if (typeof message.id !== 'number' || message.method) return;
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(codexErrorMessage(message.error, 'Codex 无消息分叉失败')));
      else pending.resolve(object(message.result));
    });
    child.stderr.on('data', () => { /* Never expose account or environment diagnostics. */ });
    child.stdin.on('error', error => complete(error));
    child.on('error', error => complete(error));
    child.on('close', code => {
      closed = true;
      if (closeTimer) clearTimeout(closeTimer);
      complete(new Error(`Codex 无消息分叉连接提前结束（退出码 ${code}）`));
    });
    void (async () => {
      await request('initialize', { clientInfo: { name: 'delivery_workspace', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const response = await request('thread/fork', { threadId: source.sessionId, lastTurnId: source.lastTurnId,
        cwd: source.workspacePath, approvalPolicy: 'never', sandbox, threadSource: 'cli',
        ...(source.model ? { model: source.model } : {}),
        config: { ...(source.reasoningEffort ? { model_reasoning_effort: source.reasoningEffort } : {}),
          ...(sandbox === 'workspace-write' ? { 'sandbox_workspace_write.network_access': true } : {}) } });
      await verifyForkResponse(response, source.workspacePath, source.lastTurnId);
      const threadId = String(object(response.thread).id || '');
      if (!threadId || threadId === source.sessionId) throw new Error('Codex 无消息分叉未返回独立会话 ID');
      complete(undefined, threadId);
    })().catch(error => complete(error instanceof Error ? error : new Error(String(error))));
  });
}

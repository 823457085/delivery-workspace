/** 在确认桌面端原会话空闲后，由原 owner 启动；按确切 turn ID 读取结果和中断。 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { codexRunningMessage, codexWriterHeldMessage } from '../shared/codex-session-error.js';
import { connectCodexDesktopThread, desktopObject as object, type DesktopObject } from './codex-desktop-ipc.js';
import type { LiveContext } from './codex-live-turn.js';

type DesktopConnection = Awaited<ReturnType<typeof connectCodexDesktopThread>>;
interface DesktopTurnOptions {
  connect?: (threadId: string) => Promise<DesktopConnection>;
  pollMs?: number;
}

export class CodexDesktopTurnUnconfirmedError extends Error {}

export async function readCodexDesktopSnapshot(threadId: string) {
  const desktop = await connectCodexDesktopThread(threadId);
  try { return await desktop.snapshot(); } finally { desktop.close(); }
}

function desktopTurns(state: DesktopObject) {
  const history = object(state.turnHistory);
  return history.kind === 'canonical'
    ? Object.values(object(object(history.history).entitiesByKey)).map(object)
    : Array.isArray(state.turns) ? state.turns.map(object) : [];
}

function assertIdle(state: DesktopObject, threadId: string) {
  if (state.id !== threadId || state.hostId !== 'local' || state.resumeState !== 'resumed') {
    throw new Error('未能确认 Codex 桌面原会话状态，本次未启动');
  }
  const status = object(state.threadRuntimeStatus).type;
  const turns = desktopTurns(state);
  if (status === 'active'
    || turns.some(turn => turn.status === 'inProgress')
    || (Array.isArray(state.requests) && state.requests.length)
    || (Array.isArray(state.unconfirmedTurnSubmissions) && state.unconfirmedTurnSubmissions.length)) {
    throw new Error(codexRunningMessage);
  }
  // 容量等错误结束后，桌面会保留 systemError；只有原 owner 的轮次均有终态证据时才允许续接。
  if (status === 'systemError' && turns.length && turns.every(turn =>
    typeof (turn.turnId || turn.id) === 'string' && Boolean(turn.turnId || turn.id)
    && ['completed', 'failed', 'interrupted'].includes(String(turn.status)))) return;
  if (status !== 'idle') throw new Error('未能确认 Codex 原会话空闲，本次未启动');
}

// 独立 app-server 的历史重建会把其他进程中的活动轮次标成 interrupted。
// 只能使用原 owner 的实时快照判定本轮是否结束；桌面 canonical history 的 turns 数组为空。
export function desktopTurnFromSnapshot(state: DesktopObject, threadId: string, turnId: string) {
  if (state.id !== threadId || state.hostId !== 'local' || state.resumeState !== 'resumed') {
    throw new Error('Codex 桌面原会话状态无法确认');
  }
  return desktopTurns(state).find(turn => (turn.turnId || turn.id) === turnId);
}

export async function runCodexDesktopTurn(context: LiveContext, prompt: string, options: DesktopTurnOptions = {}) {
  const threadId = context.resumeSessionId!;
  const { run, signal } = context;
  let desktop: DesktopConnection;
  try { desktop = await (options.connect || connectCodexDesktopThread)(threadId); }
  catch (error) {
    const detail = error instanceof Error ? error.message : '';
    // 只展示已知连接原因，不将未审查的桌面响应或请求正文写入运行记录。
    const reason = /no-client-found|未找到 Codex 原会话的持有者/.test(detail)
      ? '未找到可接续此会话的桌面客户端。请在原客户端打开此会话后再续接；若由其他 CLI 持有，请先正常退出该客户端。'
      : /thread-owner-discovery.*超时/.test(detail)
        ? '查询原会话持有者超时。请确认原客户端能够响应后再续接。'
        : /ENOENT|ECONNREFUSED/.test(detail)
          ? '无法连接 Codex 桌面。请启动原客户端并打开此会话后再续接。'
          : /权限不安全|协议版本不兼容/.test(detail)
            ? '桌面连接未通过安全或协议兼容检查。'
            : '桌面接续连接失败，无法确认持有者状态。';
    throw new Error(`${codexWriterHeldMessage}。${reason}本次未发送任务，也未修改会话锁。`);
  }
  let turnId = '';
  let submitted = false;
  let completed = false;
  const ensureNotAborted = () => { if (signal.aborted) throw new Error('Agent 运行已中断'); };
  const readSnapshot = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        ensureNotAborted();
        if (attempt) desktop = await (options.connect || connectCodexDesktopThread)(threadId);
        desktop.assertConnected();
        return await desktop.snapshot();
      } catch (error) {
        ensureNotAborted();
        if (attempt >= 2 || !/超时|连接已关闭|ECONN|EPIPE|ENOENT/.test(String(error))) throw error;
        desktop.close();
        context.onEvent('lifecycle', '桌面状态读取中断，正在重新连接并核对原会话；未重新发送任务');
        await delay(options.pollMs ?? 750, undefined, { signal });
      }
    }
  };
  try {
    ensureNotAborted();
    const requestedDirectory = await fs.realpath(run.workspacePath);
    let waiting = false;
    // 尚未发送的步骤等待 owner 空闲；不能把另一轮的结果当成本轮结果，也不能中断它。
    while (true) {
      const state = await readSnapshot();
      if (await fs.realpath(String(state.cwd || '')) !== requestedDirectory) throw new Error('Codex 桌面原会话目录与本次工作区不一致，本次未启动');
      try {
        assertIdle(state, threadId);
        // 等待期间其他轮次可能写入文件，本步的差异基线必须在它结束后采集。
        await context.onBeforeTurn?.();
        const latest = await readSnapshot();
        if (latest.cwd !== state.cwd) throw new Error('Codex 原会话目录已变化，本次未启动');
        assertIdle(latest, threadId);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== codexRunningMessage) throw error;
        ensureNotAborted();
        if (!waiting) context.onEvent('message', 'Codex 原会话正在处理其他任务，本步骤等待空闲后自动开始');
        waiting = true;
        await delay(options.pollMs ?? 750, undefined, { signal });
      }
    }
    const sandboxPolicy = run.mode !== 'agent' ? { type: 'readOnly' }
      : run.accessMode === 'full' ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [path.resolve(run.workspacePath)], networkAccess: true,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    // 不继承桌面端后来选择的模型/权限；保留本次 Delivery 表单明确指定的运行契约。
    const request = { threadId, clientUserMessageId: randomUUID(), cwd: run.workspacePath,
      input: [{ type: 'text', text: prompt, text_elements: [] }, ...context.imagePaths.map(file => ({ type: 'localImage', path: file }))],
      approvalPolicy: 'never', sandboxPolicy,
      ...(run.model ? { model: run.model } : {}),
      ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}),
      ...(run.serviceTier ? { serviceTier: run.serviceTier } : {}),
    };
    ensureNotAborted();
    desktop.assertConnected();
    if (waiting) context.onEvent('message', 'Codex 原会话已空闲，正在启动本步骤');
    submitted = true;
    const receipt = await desktop.request('thread-follower-start-turn', { conversationId: threadId,
      turnStart: { request, context: { inheritThreadSettings: false, useAppServerPermissionDefault: false } } }, 2);
    const receivedTurnId = String(object(object(receipt.result).turn).id || '');
    if (!receivedTurnId) throw new Error('Codex 桌面未返回本轮 ID，无法确认是否启动；请检查原会话后再操作');
    if (desktop.snapshotVersion === 13) {
      // 并发发送时 Codex 可能把输入并入另一端刚开始的一轮，并返回它的 ID。
      const deadline = Date.now() + 30_000;
      while (true) {
        const turn = desktopTurnFromSnapshot(await readSnapshot(), threadId, receivedTurnId);
        const opening = Array.isArray(turn?.items) ? turn.items.map(object).find(item => item.type === 'userMessage') : undefined;
        if (opening?.clientId === request.clientUserMessageId) break;
        if (opening || Date.now() >= deadline) throw new Error('未能确认返回轮次由工作台发起，请在 Codex 桌面端核对原会话');
        await delay(options.pollMs ?? 750, undefined, { signal });
      }
    }
    turnId = receivedTurnId;
    await context.onSession(threadId);
    await context.onTurn?.(turnId);
    context.onEvent('lifecycle', '原会话由空闲桌面端持有，已通过原会话继续执行');
    let output = '';
    let lastFoundAt = Date.now();
    const events = new Set<string>();
    while (true) {
      ensureNotAborted();
      const turn = desktopTurnFromSnapshot(await readSnapshot(), threadId, turnId);
      if (turn) {
        lastFoundAt = Date.now();
        const items = Array.isArray(turn.items) ? turn.items.map(object) : [];
        const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
        const message = messages.at(-1);
        if (message && message.text !== output) { output = String(message.text); context.onOutput?.(output); }
        for (const item of items) {
          if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type))) continue;
          const status = String(item.status || turn.status);
          const key = `${item.id}:${status}`;
          if (events.has(key)) continue;
          events.add(key);
          context.onEvent('tool', `${status === 'inProgress' ? '正在执行' : '执行完成'}：${String(item.command || item.tool || item.type)}`);
        }
        if (['completed', 'failed', 'interrupted'].includes(String(turn.status))) {
          completed = true;
          if (turn.status !== 'completed') throw new Error(String(object(turn.error).message || `Codex 运行${turn.status}`));
          if (output) context.onEvent('message', output);
          return output;
        }
      } else if (Date.now() - lastFoundAt > 30_000) {
        throw new Error('未能读取 Codex 桌面本轮记录，请检查原会话；未自动重复发送');
      }
      await delay(options.pollMs ?? 750, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted && !submitted) throw new Error('Agent 运行已中断');
    if (signal.aborted && turnId && !completed) {
      try {
        await desktop.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId }, 4);
        // 中断回执只表示请求已收到；原 owner 的确切轮次结束后才能释放写入权。
        for (let attempt = 0; attempt < 4; attempt++) {
          desktop.assertConnected();
          const turn = desktopTurnFromSnapshot(await desktop.snapshot(), threadId, turnId);
          if (turn && ['completed', 'failed', 'interrupted'].includes(String(turn.status))) {
            if (turn.status === 'completed') {
              const message = (Array.isArray(turn.items) ? turn.items.map(object) : [])
                .filter(item => item.type === 'agentMessage' && typeof item.text === 'string').at(-1);
              if (!message?.text) throw new Error('原轮次已结束但最终回复尚不可读');
              const text = String(message.text);
              context.onOutput?.(text); context.onEvent('message', text);
              return text;
            }
            completed = true;
            break;
          }
          if (attempt < 3) await delay(options.pollMs ?? 750);
        }
        if (!completed) throw new Error('原轮次仍未确认结束');
      } catch {
        throw new CodexDesktopTurnUnconfirmedError('本轮中断未获桌面端确认，正在核对原轮次；未中断其他轮次，也未重复派发。');
      }
      throw new Error('Agent 运行已中断');
    }
    if (submitted && !turnId) {
      throw new CodexDesktopTurnUnconfirmedError(`桌面端续接结果尚未确认，请检查原会话后再操作；未自动重复发送。${error instanceof Error ? error.message : ''}`);
    }
    if (turnId && !completed) {
      throw new CodexDesktopTurnUnconfirmedError(`未确认桌面端本轮结束，正在核对原会话；未自动重复发送。${error instanceof Error ? error.message : ''}`);
    }
    throw error;
  } finally { desktop.close(); }
}

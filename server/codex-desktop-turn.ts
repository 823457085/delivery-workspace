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

function assertIdle(state: DesktopObject, threadId: string) {
  if (state.id !== threadId || state.hostId !== 'local' || state.resumeState !== 'resumed') {
    throw new Error('未能确认 Codex 桌面原会话状态，本次未启动');
  }
  const status = object(state.threadRuntimeStatus).type;
  if (status === 'active'
    || (Array.isArray(state.requests) && state.requests.length)
    || (Array.isArray(state.unconfirmedTurnSubmissions) && state.unconfirmedTurnSubmissions.length)) {
    throw new Error(codexRunningMessage);
  }
  if (status !== 'idle') throw new Error('未能确认 Codex 原会话空闲，本次未启动');
}

// 独立 app-server 的历史重建会把其他进程中的活动轮次标成 interrupted。
// 只能使用原 owner 的实时快照判定本轮是否结束；桌面 canonical history 的 turns 数组为空。
export function desktopTurnFromSnapshot(state: DesktopObject, threadId: string, turnId: string) {
  if (state.id !== threadId || state.hostId !== 'local' || state.resumeState !== 'resumed') {
    throw new Error('Codex 桌面原会话状态无法确认');
  }
  const history = object(state.turnHistory);
  const turns = history.kind === 'canonical'
    ? Object.values(object(object(history.history).entitiesByKey)).map(object)
    : Array.isArray(state.turns) ? state.turns.map(object) : [];
  return turns.find(turn => (turn.turnId || turn.id) === turnId);
}

export async function runCodexDesktopTurn(context: LiveContext, prompt: string, options: DesktopTurnOptions = {}) {
  const threadId = context.resumeSessionId!;
  const { run, signal } = context;
  let desktop: DesktopConnection;
  try { desktop = await (options.connect || connectCodexDesktopThread)(threadId); }
  catch { throw new Error(codexWriterHeldMessage); }
  let turnId = '';
  let submitted = false;
  let completed = false;
  const ensureNotAborted = () => { if (signal.aborted) throw new Error('Agent 运行已中断'); };
  try {
    ensureNotAborted();
    const state = await desktop.snapshot();
    assertIdle(state, threadId);
    const [actualDirectory, requestedDirectory] = await Promise.all([
      fs.realpath(String(state.cwd || '')), fs.realpath(run.workspacePath),
    ]);
    if (actualDirectory !== requestedDirectory) throw new Error('Codex 桌面原会话目录与本次工作区不一致，本次未启动');
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
    const latest = await desktop.snapshot();
    assertIdle(latest, threadId);
    if (latest.cwd !== state.cwd) throw new Error('Codex 原会话目录已变化，本次未启动');
    ensureNotAborted();
    desktop.assertConnected();
    submitted = true;
    const receipt = await desktop.request('thread-follower-start-turn', { conversationId: threadId,
      turnStart: { request, context: { inheritThreadSettings: false, useAppServerPermissionDefault: false } } }, 2);
    turnId = String(object(object(receipt.result).turn).id || '');
    if (!turnId) throw new Error('Codex 桌面未返回本轮 ID，无法确认是否启动；请检查原会话后再操作');
    await context.onSession(threadId);
    await context.onTurn?.(turnId);
    context.onEvent('lifecycle', '原会话由空闲桌面端持有，已通过原会话继续执行');
    let output = '';
    let lastFoundAt = Date.now();
    const events = new Set<string>();
    while (true) {
      ensureNotAborted();
      const turn = desktopTurnFromSnapshot(await desktop.snapshot(), threadId, turnId);
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
      desktop.assertConnected();
      await delay(options.pollMs ?? 750, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted && turnId && !completed) {
      try {
        await desktop.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId }, 4);
      } catch {
        throw new Error('本轮中断未获桌面端确认，请检查原会话；未中断其他轮次');
      }
      throw new Error('Agent 运行已中断');
    }
    if (submitted && !turnId) {
      throw new Error(`桌面端续接结果尚未确认，请检查原会话后再操作；未自动重复发送。${error instanceof Error ? error.message : ''}`);
    }
    if (turnId && !completed) {
      throw new Error(`未确认桌面端本轮结束，请检查原会话；未自动重复发送。${error instanceof Error ? error.message : ''}`);
    }
    throw error;
  } finally { desktop.close(); }
}

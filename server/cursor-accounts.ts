import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { AgentProvider } from '../shared/agent-runtime.js';
import { accountProviderLabels, accountProviders, trustedAccountLoginUrl,
  type AccountProvider, type CursorAccountAction, type CursorAccountOperation, type CursorAccountsDashboard } from '../shared/cursor-accounts.js';

interface RuntimeMaintenance {
  withProviderMaintenance<T>(provider: AgentProvider, action: () => Promise<T>): Promise<T>;
}
interface Options {
  provider?: AccountProvider;
  /** 测试可使用隔离的假 bridge；业务请求不能指定命令或路径。 */
  bridgeCommand?: string[];
  cancelWaitMs?: number;
  inspectTimeoutMs?: number;
  operationTimeoutMs?: number;
  openDesktop?: () => Promise<{ status: 'opened' | 'failed' | 'skipped'; message: string }>;
}
const summary = z.object({ name: z.string().max(40), email: z.string().max(320), team: z.string().max(300),
  displayName: z.string().max(500).optional(), identity: z.string().max(2000).optional() });
const snapshotSchema = z.object({ type: z.literal('snapshot'), available: z.boolean(), accounts: z.array(summary).max(1000),
  current: z.object({ email: z.string().max(320), team: z.string().max(300), verified: z.boolean(),
    displayName: z.string().max(500).optional(), identity: z.string().max(2000).optional() }).nullable(),
  pendingRecovery: z.boolean(), activePids: z.array(z.number().int().positive()).max(1000),
  blockedReason: z.string().max(2000), checkedAt: z.string().max(100) });
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const initialSnapshot = (provider: AccountProvider): Omit<CursorAccountsDashboard, 'operation'> => ({ provider, available: false, accounts: [], current: null,
  pendingRecovery: false, activePids: [], blockedReason: '', checkedAt: '' });

export function cursorAccountLoginUrl(value: unknown): string | undefined {
  return trustedAccountLoginUrl('cursor', value) || undefined;
}

export function createCursorAccountsService(runtime: RuntimeMaintenance, options: Options = {}) {
  const provider = options.provider ?? 'cursor';
  if (!accountProviders.includes(provider)) throw new Error('不支持的账号平台');
  const label = accountProviderLabels[provider];
  const command = options.bridgeCommand || ['/usr/bin/python3', '-u', ...(provider === 'cursor'
    ? [fileURLToPath(new URL('../scripts/cursor-accounts/bridge.py', import.meta.url))]
    : [fileURLToPath(new URL('../scripts/ai-accounts/bridge.py', import.meta.url)), provider])];
  const withMaintenance = <T>(action: () => Promise<T>) => runtime.withProviderMaintenance(provider, action);
  let snapshot = initialSnapshot(provider);
  let inspected = false;
  let inspectTask: Promise<void> | undefined;
  let operation: CursorAccountOperation | null = null;
  let active: { child?: ChildProcess; done: Promise<void>; cancelling: boolean } | undefined;
  let desktopOpening: { done: Promise<void> } | undefined;
  let closing = false;

  function interrupt(child?: ChildProcess) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
    try {
      if (process.platform === 'win32') child.kill('SIGINT');
      else process.kill(-child.pid, 'SIGINT');
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  function bridge(args: string[], onEvent: (event: Record<string, unknown>) => void, onStart?: (child: ChildProcess) => void) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(command[0], [...command.slice(1), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: { ...process.env, NO_OPEN_BROWSER: '1' },
      });
      const decoder = new StringDecoder('utf8');
      let buffered = '', size = 0, invalidOutput = false;
      const consume = (text: string) => {
        size += Buffer.byteLength(text);
        if (size > 64_000 || buffered.length + text.length > 32_000) {
          if (!invalidOutput) { invalidOutput = true; buffered = ''; interrupt(child); }
          return;
        }
        buffered += text;
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          try {
            const event: unknown = JSON.parse(line);
            if (event && typeof event === 'object' && !Array.isArray(event)) onEvent(event as Record<string, unknown>);
          } catch { /* 不转发 CLI 原始输出。 */ }
        }
      };
      child.stdout!.on('data', (data: Buffer) => { if (!invalidOutput) consume(decoder.write(data)); });
      child.stderr!.on('data', () => { /* stderr 可能含 CLI 诊断，不进入页面或服务日志。 */ });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        interrupt(child);
      }, args[0] === 'inspect' ? options.inspectTimeoutMs ?? 50_000 : options.operationTimeoutMs ?? 10 * 60_000).unref();
      child.once('error', () => { clearTimeout(timer); reject(new Error('账号管理程序未能启动，请检查本机安装')); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (!invalidOutput) consume(decoder.end() + (buffered ? '\n' : ''));
        if (invalidOutput) reject(new Error('账号管理程序返回内容超出限制，已请求停止'));
        else if (timedOut) reject(new Error('账号操作超时，已请求停止；请检查账号状态'));
        else resolve({ code, signal });
      });
      onStart?.(child);
    });
  }

  async function inspect() {
    if (inspectTask) return inspectTask;
    inspectTask = (async () => {
      let next: ReturnType<typeof snapshotSchema.parse> | undefined;
      let message = '';
      try {
        const result = await bridge(['inspect'], event => {
          const parsed = snapshotSchema.safeParse(event);
          if (parsed.success) next = parsed.data;
          if (event.type === 'error' && typeof event.message === 'string') message = event.message.slice(0, 1000);
        });
        if (result.code !== 0 || !next) throw new Error(message || `暂时无法读取 ${label} 账号状态`);
        const { type: _type, ...value } = next;
        snapshot = { ...value, provider };
      } catch (error) {
        snapshot = { ...snapshot, available: false, current: snapshot.current ? { ...snapshot.current, verified: false } : null,
          blockedReason: error instanceof Error ? error.message : `暂时无法读取 ${label} 账号状态`, checkedAt: new Date().toISOString() };
      }
      inspected = true;
    })().finally(() => { inspectTask = undefined; });
    return inspectTask;
  }

  const state = (): CursorAccountsDashboard => structuredClone({ ...snapshot, operation });
  async function dashboard(refresh = false) {
    if (!active && !desktopOpening && !closing && (refresh || !inspected)) await inspect();
    return state();
  }

  async function withDesktopOpen<T>(action: () => Promise<T>): Promise<T> {
    if (closing) throw new Error('工作台正在退出');
    if (active || desktopOpening) throw new Error('另一个账号管理操作正在运行，请完成后再打开桌面应用');
    const job = { done: Promise.resolve() };
    desktopOpening = job;
    const result = (async () => {
      try {
        await inspectTask;
        if (closing) throw new Error('工作台正在退出');
        try { return await action(); }
        catch { throw new Error('桌面应用未能打开，请稍后重试'); }
      } finally {
        inspected = false;
        if (desktopOpening === job) desktopOpening = undefined;
      }
    })();
    job.done = result.then(() => {}, () => {});
    return result;
  }

  async function start(action: CursorAccountAction, name?: string) {
    if (closing) throw new Error('工作台正在退出');
    if (active || desktopOpening) throw new Error('另一个账号管理操作正在运行');
    if (!['save', 'login', 'use', 'restore', 'delete'].includes(action)) throw new Error('不支持的账号操作');
    if (action !== 'restore' && (!name || !namePattern.test(name))) throw new Error('账号名称请使用 1–40 位英文字母、数字、下划线或短横线');
    if (action === 'restore' && name !== undefined) throw new Error('恢复账号不需要名称');
    operation = { id: randomUUID(), action, ...(name ? { name } : {}), status: 'running', message: `正在处理 ${label} 账号操作`, startedAt: new Date().toISOString() };
    const current = operation;
    const job = { child: undefined as ChildProcess | undefined, cancelling: false, done: Promise.resolve() };
    active = job;
    job.done = (async () => {
      let resultMessage = '', errorMessage = '';
      const activationFailed = (message: string) => {
        current.status = 'partial';
        current.activation = { status: 'failed', message };
        current.message = `${label} 账号已保存，CLI 启用未完成：${message}`;
      };
      const activateSavedAccount = async () => {
        delete current.loginUrl;
        delete current.loginCode;
        const savedName = current.savedAccountName;
        if (!savedName) {
          activationFailed('未能确认已保存账号的名称，请刷新列表后切换使用');
          return;
        }
        if (job.cancelling) { activationFailed('已取消后续启用，当前 CLI 账号未改变'); return; }
        current.message = `${label} 账号已保存，正在启用 CLI 账号`;
        try {
          // Keep browser login isolated from running tasks. Only the credential
          // switch enters maintenance, after the saved slot has been confirmed.
          await withMaintenance(async () => {
            if (job.cancelling) { activationFailed('已取消后续启用，当前 CLI 账号未改变'); return; }
            let activatedMessage = '', activationError = '';
            const result = await bridge(['use', savedName], event => {
              if (event.type === 'result' && typeof event.message === 'string') activatedMessage = event.message.slice(0, 1000);
              if (event.type === 'error' && typeof event.message === 'string') activationError = event.message.slice(0, 1000);
            }, child => { job.child = child; if (job.cancelling) interrupt(child); });
            if (result.code === 0 && activatedMessage && !activationError) {
              current.activation = { status: 'succeeded', message: activatedMessage };
              current.message = `${label}：账号已保存并启用，后续 CLI 任务将使用该账号`;
            } else activationFailed(activationError || activatedMessage || (job.cancelling
              ? '启用已取消，请刷新状态核对当前账号' : '请刷新状态并按需恢复原账号'));
          });
          if (current.activation?.status === 'succeeded') current.status = 'succeeded';
        } catch (error) { activationFailed(error instanceof Error ? error.message : '请刷新状态后重试切换'); }
      };
      const openDesktop = async () => {
        if (provider === 'codex' || !options.openDesktop) return;
        const applied = action === 'login' ? '账号已保存并启用 CLI' : 'CLI 账号已切换';
        if (job.cancelling) {
          current.desktop = { status: 'skipped', message: '已取消打开桌面应用，已启用的 CLI 账号保持不变' };
        } else {
          current.status = 'running';
          current.message = `${label}：${applied}，正在打开桌面应用`;
          try {
            const result = await options.openDesktop();
            current.desktop = { status: result.status, message: result.message.slice(0, 1000) };
          }
          catch (error) { current.desktop = { status: 'failed', message: error instanceof Error ? error.message : '桌面应用未能打开' }; }
        }
        current.status = current.desktop.status === 'opened' ? 'succeeded' : 'partial';
        current.message = `${label}：${applied}；${current.desktop.message}`;
      };
      try {
        const run = async () => {
          await inspectTask;
          if (job.cancelling) { current.status = 'cancelled'; current.message = '已取消账号操作'; return; }
          const result = await bridge([action, ...(name ? [name] : [])], event => {
            if (event.type === 'login') {
              const url = trustedAccountLoginUrl(provider, event.url);
              if (url && action === 'login' && !job.cancelling && !current.savedAccountName) {
                current.loginUrl = url;
                current.message = `请在 ${label} 官方页面完成登录`;
                if (typeof event.code === 'string' && /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(event.code)) current.loginCode = event.code;
                else delete current.loginCode;
              }
            }
            if (event.type === 'result') {
              if (typeof event.message === 'string') resultMessage = event.message.slice(0, 1000);
              if (action === 'login' && typeof event.accountName === 'string' && namePattern.test(event.accountName)) {
                current.savedAccountName = event.accountName;
                delete current.loginUrl;
                delete current.loginCode;
                current.message = `${label} 账号已保存，正在准备启用 CLI 账号`;
              }
            }
            if (event.type === 'error' && typeof event.message === 'string') errorMessage = event.message.slice(0, 1000);
          }, child => { job.child = child; if (job.cancelling) interrupt(child); });
          if (result.code === 0 && resultMessage && !errorMessage) {
            if (action === 'login') await activateSavedAccount();
            else {
              current.status = action === 'use' ? 'running' : 'succeeded'; current.message = resultMessage;
              if (action === 'use') current.activation = { status: 'succeeded', message: resultMessage };
            }
          }
          else if (action === 'login' && current.savedAccountName) activationFailed(errorMessage || (job.cancelling
            ? '已取消后续启用，当前 CLI 账号未改变' : '保存后的登录收尾未完成，请刷新列表后切换使用'));
          else if (job.cancelling && result.code === 130 && !errorMessage) { current.status = 'cancelled'; current.message = resultMessage || '已取消登录'; }
          else {
            current.status = 'failed';
            current.message = errorMessage || (action === 'use' || action === 'restore'
              ? '账号操作未完成，请刷新状态并按需恢复原账号' : '账号操作未完成，请刷新状态后重试');
          }
        };
        if (action === 'use' || action === 'restore') await withMaintenance(run);
        else await run();
        if (action === 'use' && current.activation?.status === 'succeeded') current.status = 'succeeded';
        if (current.status === 'succeeded' && (action === 'login' || action === 'use')) await openDesktop();
      } catch (error) {
        if (action === 'login' && current.savedAccountName) activationFailed(error instanceof Error ? error.message : '账号启用未完成');
        else { current.status = 'failed'; current.message = error instanceof Error ? error.message : '账号操作未完成'; }
      }
      finally {
        delete current.loginUrl;
        delete current.loginCode;
        current.finishedAt = new Date().toISOString();
        inspected = false;
        if (active === job) active = undefined;
      }
    })();
    return state();
  }

  async function cancel(id: string) {
    if (!active || !operation || operation.id !== id) throw new Error('该账号操作已结束');
    const job = active;
    job.cancelling = true;
    operation.message = operation.activation?.status === 'succeeded' ? 'CLI 账号已启用，正在取消后续桌面操作，请稍候'
      : operation.savedAccountName ? '账号已保存，正在取消 CLI 启用，请稍候' : '正在取消登录，请稍候';
    delete operation.loginUrl;
    delete operation.loginCode;
    if (!interrupt(job.child)) throw new Error('取消未能送达，请等待当前操作退出');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, options.cancelWaitMs ?? 3000).unref(); })]);
    if (timer) clearTimeout(timer);
    return dashboard();
  }

  async function close() {
    closing = true;
    if (active) {
      const job = active;
      job.cancelling = true;
      interrupt(job.child);
      await job.done;
    }
    await desktopOpening?.done;
    await inspectTask;
  }
  return { dashboard, start, cancel, close, withDesktopOpen, isIdle: () => !active && !desktopOpening && !inspectTask };
}

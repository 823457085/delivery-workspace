/** Private per-run IPC broker. The stdio process never receives workspace authority or credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentRun } from '../shared/agent-runtime.js';
import { createLocalTools, localToolDefinitions, validateLocalTool } from './agent-local-tools.js';
import { createToolJournal, privateRunFile, writePrivateJson } from './agent-tool-journal.js';

interface BridgeOptions {
  run: AgentRun;
  stateDirectory: string;
  controlDirectory: string;
  signal: AbortSignal;
  onPid(pid: number): void | Promise<void>;
  redact(value: string): string;
}
interface ToolExecutor { execute(name: string, args: unknown): Promise<any>; close(): Promise<void> }
export const workbuddyMcpNames = localToolDefinitions.map(tool => `mcp__delivery__${tool.name}`);

/** The optional backend factory is for protocol fixtures, never model or HTTP input. */
export async function createAgentMcpBridge(options: BridgeOptions,
  backend: typeof createLocalTools = createLocalTools) {
  options.signal.throwIfAborted();
  const run = Object.freeze({ ...options.run, workspacePath: await fs.realpath(options.run.workspacePath) });
  if (run.accessMode !== 'workspace') throw new Error('MCP 桥仅接受工作区权限');
  if (run.status !== 'running') throw new Error('MCP 桥仅接受当前执行中的轮次');
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const tools: ToolExecutor = await backend(run, options.stateDirectory, signal, options.onPid);
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();
  let accepting = true, claimed = false, calls = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const secret = randomBytes(32).toString('hex');
  const connectionId = randomUUID();
  const revoke = () => { accepting = false; controller.abort(); for (const socket of sockets) socket.destroy(); };
  signal.addEventListener('abort', revoke, { once: true });
  let privateDirectory = '';
  try {
    const lease = privateRunFile(path.join(options.stateDirectory, 'workbuddy-bridges'), run.id);
    await fs.mkdir(path.dirname(lease), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(lease, JSON.stringify({ runId: run.id, workspacePath: run.workspacePath,
        mode: run.mode, accessMode: run.accessMode, state: 'prepared' }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('本轮已有桥接记录，禁止重放；请核对回执后新建轮次');
      throw error;
    }
    await fs.mkdir(options.controlDirectory, { recursive: true, mode: 0o700 });
    privateDirectory = await fs.mkdtemp(path.join(options.controlDirectory, 'mcp-'));
    const socketPath = path.join(privateDirectory, 'bridge.sock');
    if (Buffer.byteLength(socketPath) > 100) throw new Error('MCP 控制目录路径过长，请使用更短的宿主私有目录');
    const journal = await createToolJournal(path.join(options.stateDirectory, 'workbuddy-tools'), run.id);
    const clean = (value: unknown) => JSON.parse(options.redact(JSON.stringify(value)));
    const definitions = localToolDefinitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
    server = net.createServer(socket => {
      if (!accepting || claimed) { socket.destroy(); return; }
      claimed = true; sockets.add(socket);
      let buffer = Buffer.alloc(0), backlog = 0;
      const ids = new Set<string>();
      const send = (value: unknown) => {
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > 600_000) { revoke(); return; }
        if (!socket.destroyed) socket.write(`${text}\n`);
      };
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        if (buffer.length > 1_100_000) { revoke(); return; }
        let end: number;
        while ((end = buffer.indexOf(10)) >= 0) {
          if (++backlog > 32) { revoke(); return; }
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          queue = queue.then(async () => {
            if (!accepting || signal.aborted) return;
            let frame: any;
            try { frame = JSON.parse(line.toString('utf8')); } catch { revoke(); return; }
            if (!frame || typeof frame.token !== 'string' || frame.token.length !== secret.length
              || !timingSafeEqual(Buffer.from(frame.token), Buffer.from(secret))) { revoke(); return; }
            if (typeof frame.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(frame.id) || ids.has(frame.id)) { revoke(); return; }
            ids.add(frame.id);
            if (frame.method === 'list') { send({ id: frame.id, result: definitions }); return; }
            if (frame.method !== 'call' || ++calls > 128) { revoke(); return; }
            try {
              const args = validateLocalTool(frame.name, frame.args);
              if (frame.name === 'apply_patch' && run.mode !== 'agent') throw new Error('当前轮次只读');
              // Transport IDs are only connection correlation. Host-generated receipt IDs are never reused after reconnect.
              const receiptId = `${connectionId}-${randomUUID()}`;
              const result = await journal.execute(receiptId, frame.name, args, async () => {
                signal.throwIfAborted();
                const result = clean(await tools.execute(frame.name, args));
                if (Buffer.byteLength(JSON.stringify(result)) > 512_000) throw new Error('工具输出超过上限');
                return result;
              });
              const outcome = result && typeof result === 'object' ? result as Record<string, unknown> : {};
              if (accepting && !signal.aborted) send({ id: frame.id, result, isError: outcome.ok === false
                || typeof outcome.exitCode === 'number' && outcome.exitCode !== 0 });
            } catch {
              if (accepting && !signal.aborted) send({ id: frame.id, error: '宿主工具拒绝或未完成；请核对权限及工具回执，未自动重放', isError: true });
            }
          }).catch(() => revoke()).finally(() => { backlog--; });
        }
      });
      socket.on('error', revoke);
      // Disconnect revokes authority before another connection can retry an uncertain effect.
      socket.once('close', () => { sockets.delete(socket); revoke(); });
    });
    server.on('error', revoke);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => { server!.off('error', reject); resolve(); });
    });
    await fs.chmod(socketPath, 0o600);
    signal.throwIfAborted();
    const configPath = path.join(privateDirectory, 'mcp.json');
    await writePrivateJson(configPath, { mcpServers: { delivery: { type: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./agent-mcp-stdio.mjs', import.meta.url))], defer_loading: false,
      env: { DELIVERY_BRIDGE_SOCKET: socketPath, DELIVERY_BRIDGE_TOKEN: secret } } } });
    return {
      configPath,
      async close() {
        revoke();
        await queue;
        await new Promise<void>(resolve => server!.close(() => resolve()));
        await tools.close();
        await writePrivateJson(lease, { runId: run.id, workspacePath: run.workspacePath,
          mode: run.mode, accessMode: run.accessMode, state: 'drained' });
        signal.removeEventListener('abort', revoke);
        await fs.rm(privateDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    revoke(); await queue;
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await tools.close();
    signal.removeEventListener('abort', revoke);
    if (privateDirectory) await fs.rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
}

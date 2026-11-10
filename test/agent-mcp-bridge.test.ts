/** MCP transport fixtures: no real WorkBuddy, authentication or model inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createAgentMcpBridge } from '../server/agent-mcp-bridge.js';
import { privateRunFile } from '../server/agent-tool-journal.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function fixture(t: any, options: { mode?: string; execute?: (name: string, args: any, signal: AbortSignal) => Promise<any> } = {}) {
  const directory = await fs.mkdtemp(path.join('/tmp', 'dw-mcp-'));
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  const controller = new AbortController();
  const calls: any[] = [];
  let closed = false, captured: AgentRun | undefined;
  const run = { id: randomUUID(), provider: 'workbuddy', status: 'running', workspacePath: root, mode: options.mode || 'agent', accessMode: 'workspace' } as AgentRun;
  const settings = { run, signal: controller.signal, controlDirectory: directory, stateDirectory: path.join(directory, 'state'),
    onPid() {}, redact: (value: string) => value.replaceAll('fixture-secret', '[redacted]') };
  const backend: any = async (snapshot: AgentRun, _state: string, signal: AbortSignal) => {
    captured = snapshot;
    return { async execute(name: string, args: any) {
      calls.push({ name, args });
      return options.execute ? options.execute(name, args, signal) : { ok: true, result: 'fixture-secret L123' };
    }, async close() { closed = true; } };
  };
  const bridge = await createAgentMcpBridge(settings, backend);
  const config = JSON.parse(await fs.readFile(bridge.configPath, 'utf8')).mcpServers.delivery;
  const child = spawn(config.command, config.args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: directory, OPENSSL_CONF: '/dev/null', ...config.env } });
  let buffer = '';
  const pending = new Map<any, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const value = JSON.parse(line); const entry = pending.get(value.id);
      if (entry) { pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value); }
    }
  });
  const exited = new Promise<void>(resolve => child.once('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('stdio closed')); }
    pending.clear(); resolve();
  }));
  let id = 0;
  function request(method: string, params?: any, requestId: number = ++id) {
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('fixture response timeout')); }, 3000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
    return response;
  }
  t.after(async () => {
    controller.abort(); child.kill('SIGTERM'); await exited; await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'delivery-host-tools');
  return { bridge, config, run, settings, backend, controller, request, calls, exited, child, directory,
    captured: () => captured!, closed: () => closed };
}

test('MCP 仅暴露四个严格工具；配置私有，宿主校验、顺序执行并脱敏回执', async t => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.bridge.configPath)).mode & 0o777, 0o600);
  assert.equal(f.config.defer_loading, false);
  const tools = (await f.request('tools/list')).result.tools;
  assert.deepEqual(tools.map((tool: any) => tool.name), ['read_file', 'list_files', 'apply_patch', 'run_command']);
  assert.ok(tools.every((tool: any) => tool.inputSchema.additionalProperties === false));
  f.run.mode = 'ask'; f.run.workspacePath = '/';
  assert.equal(f.captured().mode, 'agent'); assert.notEqual(f.captured().workspacePath, '/');
  const result = await f.request('tools/call', { name: 'read_file', arguments: { path: 'a' } });
  assert.equal(result.result.isError, false);
  assert.equal(result.result.content[0].text.includes('fixture-secret'), false);
  assert.match(result.result.content[0].text, /L123/);
  for (const args of [{ name: 'Bash', arguments: { command: 'ignored' } },
    { name: 'read_file', arguments: { path: 'a', roots: ['/'] } }]) {
    assert.equal((await f.request('tools/call', args)).result.isError, true);
  }
  assert.equal(f.calls.length, 1);
  const journal = JSON.parse(await fs.readFile(privateRunFile(path.join(f.settings.stateDirectory, 'workbuddy-tools'), f.run.id), 'utf8'));
  assert.equal(Object.values(journal).length, 1);
  assert.equal(Object.values(journal).every((receipt: any) => receipt.state === 'completed'), true);
});

test('MCP ask/plan 权限由宿主快照约束；客户端改变轮次不能提权', async t => {
  for (const mode of ['ask', 'plan']) {
    const f = await fixture(t, { mode }); f.run.mode = 'agent';
    const result = await f.request('tools/call', { name: 'apply_patch', arguments: { path: 'a', expected_sha256: '', content: 'bad' } });
    assert.equal(result.result.isError, true);
    assert.equal(f.calls.length, 0);
  }
});

test('MCP 重复请求不重放副作用，跨连接和同轮重启均拒绝自动恢复', async t => {
  const f = await fixture(t);
  const args = { name: 'apply_patch', arguments: { path: 'a', expected_sha256: '', content: 'once' } };
  assert.equal((await f.request('tools/call', args, 99)).result.isError, false);
  assert.equal((await f.request('tools/call', args, 99)).error.code, -32600);
  assert.equal(f.calls.length, 1);
  await assert.rejects(createAgentMcpBridge(f.settings, f.backend), /禁止重放/);
  // A second transport cannot claim the already-bound run, even with a copied capability.
  const second = net.createConnection(f.config.env.DELIVERY_BRIDGE_SOCKET);
  second.on('error', () => {}); await once(second, 'close');
  assert.equal(f.calls.length, 1);
});

test('MCP 断连先撤销执行资格、排空工具后关闭；未知结果落账且不重新执行', async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { execute: async (_name, _args, signal) => {
    started(); await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    }); return { ok: true };
  } });
  const response = f.request('tools/call', { name: 'run_command', arguments: { command: 'fixture-only' } }).catch(() => null);
  await ready; f.child.kill('SIGTERM'); await f.exited; await response; await f.bridge.close();
  assert.equal(f.closed(), true);
  const journal = JSON.parse(await fs.readFile(privateRunFile(path.join(f.settings.stateDirectory, 'workbuddy-tools'), f.run.id), 'utf8'));
  assert.equal(Object.values(journal).every((receipt: any) => receipt.state === 'unknown'), true);
  assert.equal(f.calls.length, 1);
});

test('MCP 同连接并发请求串行执行，两轮工具回执不因请求 ID 相同而串用', async t => {
  const order: string[] = [];
  let committed = false;
  const f = await fixture(t, { execute: async (name) => {
    if (name === 'apply_patch') {
      order.push('write-start');
      await new Promise(resolve => setTimeout(resolve, 20));
      committed = true; order.push('write-end');
      return { ok: true };
    }
    order.push('read'); return { ok: true, committed };
  } });
  const write = f.request('tools/call', { name: 'apply_patch', arguments: { path: 'a', expected_sha256: '', content: 'new' } });
  const read = f.request('tools/call', { name: 'read_file', arguments: { path: 'a' } });
  await write;
  assert.equal(JSON.parse((await read).result.content[0].text).committed, true);
  assert.deepEqual(order, ['write-start', 'write-end', 'read']);
  const other = await fixture(t, { execute: async () => ({ ok: true, committed: false }) });
  const isolated = await other.request('tools/call', { name: 'read_file', arguments: { path: 'a' } });
  assert.equal(JSON.parse(isolated.result.content[0].text).committed, false);
  assert.equal(other.calls.length, 1);
});

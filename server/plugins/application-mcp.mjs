import { spawn } from 'node:child_process';
import path from 'node:path';

/** Minimal tools-only stdio client. No inherited credentials, shell or automatic replay. */
export async function connectStdioMcp({ command, args = [], env = {}, timeoutMs = 30000, signal }) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args) || args.some(v => typeof v !== 'string') || !env || Object.entries(env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) throw new Error('MCP 进程配置无效');
  if (signal?.aborted) throw new Error('插件正在停止');
  timeoutMs = Math.max(100, Math.min(Number(timeoutMs) || 30000, 55000));
  const child = spawn(command, args, { shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let sequence = 0, buffer = '', closed = false, closing;
  function fail(message) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } pending.clear(); }
  function close() {
    if (closing) return closing;
    signal?.removeEventListener('abort', abort);
    closed = true; fail('MCP 连接已关闭；写入结果请先核对，未自动重试');
    closing = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
      child.stdin.end();
      const terminate = setTimeout(() => child.kill('SIGTERM'), 300);
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('exit', () => { clearTimeout(terminate); clearTimeout(force); resolve(); });
    });
    return closing;
  }
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  function request(method, params) {
    if (closed) return Promise.reject(new Error('MCP 已断开，请重新连接'));
    if (pending.size >= 16) return Promise.reject(new Error('MCP 请求过多'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 请求超时；结果未知，请核对后再操作')); void close(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  }
  function receive(message) {
    if (message.method && message.id !== undefined) { send(message.method === 'ping' ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: 'Unsupported client method' } }); return; }
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    // Protocol error details may contain credentials; never forward them.
    if (message.error) item.reject(new Error(`MCP 协议错误（${Number(message.error.code) || -32603}）`)); else item.resolve(message.result);
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 20_000_000) { void close(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      try { const value = JSON.parse(line); if (Array.isArray(value)) value.forEach(receive); else receive(value); } catch { void close(); return; }
    }
  });
  child.stdin.on('error', () => { void close(); });
  child.on('error', () => { fail('MCP 启动失败，请检查可执行文件路径与权限'); void close(); });
  child.on('exit', () => { signal?.removeEventListener('abort', abort); closed = true; fail('MCP 进程退出，请检查地址、账号密码及服务状态；未自动重试'); });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'delivery-workspace', version: '1.0.0' } });
    if (initialized?.protocolVersion !== '2025-03-26' || !initialized?.capabilities?.tools) throw new Error('MCP 不支持约定的工具协议');
    send({ method: 'notifications/initialized' });
    return {
      async listTools() {
        const tools = [], cursors = new Set(); let cursor;
        do {
          const page = await request('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(page?.tools) || tools.length + page.tools.length > 500) throw new Error('MCP 工具清单无效或过大');
          tools.push(...page.tools); cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('MCP 分页游标重复');
          cursors.add(cursor);
        } while (cursor);
        return tools;
      },
      callTool: (name, args = {}) => request('tools/call', { name, arguments: args }), close,
    };
  } catch (error) { await close(); throw error; }
}

/** macOS local tools: every read, write and shell runs under the same Seatbelt boundary. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentRun } from '../shared/agent-runtime.js';

const schemas = {
  read_file: z.object({ path: z.string().min(1).max(1000) }).strict(),
  list_files: z.object({ path: z.string().min(1).max(1000) }).strict(),
  apply_patch: z.object({ path: z.string().min(1).max(1000), expected_sha256: z.string().regex(/^(?:[a-f0-9]{64})?$/), content: z.string().max(256_000) }).strict(),
  run_command: z.object({ command: z.string().min(1).max(16_000) }).strict(),
};
export type LocalToolName = keyof typeof schemas;
export const localToolDefinitions = Object.entries(schemas).map(([name, schema]) => ({ type: 'function', name,
  description: name === 'apply_patch' ? 'Atomically replace a file using the sha256 from read_file; empty expected_sha256 creates a new file. Parent directory must exist.'
    : name === 'run_command' ? 'Run a read-only single-process check in a fresh isolated source snapshot (symlinks, Git and secrets excluded). Use exec for programs. No network, forks, source writes or host credentials. Maximum 30 seconds.'
      : name === 'list_files' ? 'List one directory, up to 500 entries.' : 'Read a UTF-8 file, up to 256KB, and its sha256.',
  parameters: z.toJSONSchema(schema), strict: true }));

export function validateLocalTool(name: string, args: unknown) {
  if (!Object.hasOwn(schemas, name)) throw new Error('不支持的本机工具');
  const parsed = schemas[name as LocalToolName].safeParse(args);
  if (!parsed.success) throw new Error('本机工具参数不符合协议');
  return parsed.data;
}

const literal = (value: string) => JSON.stringify(value);
export function localToolProfile(root: string, temporary: string, writable: boolean, denied: string[]) {
  return `(version 1)
(deny default)
(allow process-exec sysctl-read)
(deny file-link)
(allow file-read-metadata)
(allow file-read* ${['/System', '/usr/lib', '/usr/bin', '/usr/libexec', '/usr/share', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/bin', '/private/var/db/dyld', root, temporary].map(p => `(subpath ${literal(p)})`).join(' ')})
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))
(allow file-write* (literal "/dev/null") (subpath ${literal(temporary)}) ${writable ? `(subpath ${literal(root)})` : ''})
(deny file-read* file-write* ${denied.map(p => root.startsWith(`${p}/`)
    ? `(require-all (subpath ${literal(p)}) (require-not (subpath ${literal(root)})))` : `(subpath ${literal(p)})`).join(' ')} (regex #"/(\\.env[^/]*|\\.ssh|\\.aws|\\.gnupg|api-model-credentials\\.json)(/|$)"))
(deny file-write* (regex #"/\\.git(/|$)"))`;
}

async function confined(options: { profile: string; root: string; temporary: string; command: string; args: string[];
  input?: string; signal: AbortSignal; onPid?: (pid: number) => void | Promise<void> }) {
  options.signal.throwIfAborted();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', options.profile, options.command, ...options.args], {
      cwd: options.root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: options.temporary,
        TMPDIR: options.temporary, OPENSSL_CONF: '/dev/null', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    let stdout = '', stderr = '', failed = '', closed = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } } };
    const stop = () => { failed = '本机工具已停止'; kill(); };
    const timer = setTimeout(() => { failed = '本机工具执行超时；请核对已有结果，未自动重放'; kill(); }, 30_000);
    const consume = (chunk: Buffer, error: boolean) => {
      if (stdout.length + stderr.length + chunk.length > 512_000) { failed = '本机工具输出超过上限；请核对已有结果'; kill(); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => consume(chunk, false));
    child.stderr.on('data', chunk => consume(chunk, true));
    child.stdin.on('error', () => {});
    options.signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { closed = true; clearTimeout(timer); options.signal.removeEventListener('abort', stop); kill(); };
    child.once('error', () => { cleanup(); reject(new Error('本机沙箱无法启动，未回退到普通命令执行')); });
    // Always kill the entire process group, including detached background commands, before resolving.
    child.once('close', code => { cleanup(); failed ? reject(new Error(failed)) : resolve({ code, stdout, stderr }); });
    Promise.resolve().then(async () => {
      if (child.pid) await options.onPid?.(child.pid);
      options.signal.throwIfAborted();
      if (!closed) child.stdin.end(options.input || '');
    }).catch(() => { failed = '本机工具启动记录失败或已停止'; kill(); });
    if (options.signal.aborted) stop();
  });
}

export async function probeLocalTools(): Promise<boolean> {
  if (process.platform !== 'darwin' || typeof process.execve !== 'function') return false;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-sandbox-probe-'));
  try {
    const root = await fs.realpath(temporary);
    const readonly = localToolProfile(root, root, false, [path.join(root, 'denied')]);
    await fs.writeFile(path.join(root, 'denied'), 'probe');
    const result = await confined({ root, temporary: root, profile: readonly, command: '/bin/sh',
      args: ['-c', 'if read x < denied; then exit 1; else echo sandbox-ok; fi'], signal: AbortSignal.timeout(5000) });
    return result.code === 0 && result.stdout.trim() === 'sandbox-ok';
  } catch { return false; }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function createLocalTools(run: AgentRun, stateDirectory: string, signal: AbortSignal,
  onPid: (pid: number) => void | Promise<void>) {
  signal.throwIfAborted();
  if (run.accessMode !== 'workspace') throw new Error('本机工具暂不支持完全访问，请显式选择工作区权限');
  if (!await probeLocalTools()) throw new Error('当前系统无法建立本机工具沙箱，未启动执行');
  const root = await fs.realpath(run.workspacePath);
  if (root === '/' || root === await fs.realpath(os.homedir())) throw new Error('请选择具体项目目录，不能以用户主目录或系统根目录执行');
  const writable = run.mode === 'agent';
  const deniedState = await fs.realpath(stateDirectory).catch(() => path.resolve(stateDirectory));
  if (root === deniedState) throw new Error('不能将工作台状态目录用作开发工作区');
  const worker = await fs.readFile(fileURLToPath(new URL('./agent-local-tool-worker.mjs', import.meta.url)), 'utf8');
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-local-tool-')));
  const deniedPaths = [deniedState, ...['.local', '.data', '.delivery-artifacts'].map(name => path.join(root, name))];
  const profile = localToolProfile(root, temporary, writable, deniedPaths);
  return {
    async execute(name: string, args: unknown) {
      signal.throwIfAborted();
      const parsed = validateLocalTool(name, args);
      if (name === 'apply_patch' && !writable) throw new Error('当前轮次只读');
      let effectiveProfile = profile, effectiveRoot = root;
      if (name === 'run_command') {
        effectiveRoot = path.join(temporary, `snapshot-${randomUUID()}`);
        const captured = await confined({ root, temporary, profile: localToolProfile(root, temporary, false, deniedPaths),
          command: process.execPath, args: ['--input-type=module', '-e', worker], signal, onPid,
          input: JSON.stringify({ root, name: 'snapshot_workspace', snapshot: effectiveRoot, deniedPaths }) });
        let receipt: { ok: boolean; error?: string };
        try { receipt = JSON.parse(captured.stdout); } catch { throw new Error('命令工作区快照失败'); }
        if (!receipt.ok) throw new Error(receipt.error || '命令工作区快照失败');
        effectiveProfile = `${localToolProfile(effectiveRoot, temporary, false, deniedPaths)}\n(deny file-write* (subpath ${literal(effectiveRoot)}))`;
      }
      try {
        const result = await confined({ root: effectiveRoot, temporary, profile: effectiveProfile, command: process.execPath, args: ['--input-type=module', '-e', worker],
          input: JSON.stringify({ root: effectiveRoot, writable, name, args: parsed }), signal, onPid });
        if (name === 'run_command') return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, sourceSnapshot: true };
        try { return JSON.parse(result.stdout); } catch { throw new Error('本机文件工具返回无效结果'); }
      } finally { if (effectiveRoot !== root) await fs.rm(effectiveRoot, { recursive: true, force: true }); }
    },
    async close() { await fs.rm(temporary, { recursive: true, force: true }); },
  };
}

import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify, stripVTControlCharacters } from 'node:util';

const execFileAsync = promisify(execFile);
const secretName = /token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential|(?:^|_)(?:key|auth)(?:_|$)/i;

export function redactProjectOutput(text: string) {
  let result = stripVTControlCharacters(text);
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !secretName.test(name)) continue;
    for (const secret of [value, ...value.split(/\r?\n/)].filter(Boolean).sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join('[redacted]');
    }
  }
  return result
    .replace(/\b((?:set-cookie|cookie|authorization|proxy-authorization)\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:["']?[\w.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/((?:--(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|user|proxy-user|oauth2-bearer)|-[uU])\s+)(?:"[^"]*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{12,}|xai-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{10,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{30,}|xox[baprs]-[a-z0-9-]{10,})\b/gi, '[redacted]');
}

/** Keep incomplete lines private so split credentials never appear in polling responses. */
export function createProjectLogBuffer(maxCharacters = 65_536) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256 || maxCharacters > 1_048_576) throw new Error('项目日志长度限制无效');
  let visible = '', pending = '', droppingLine = false, truncated = false;
  const publish = (text: string) => {
    visible += redactProjectOutput(text);
    if (visible.length > maxCharacters) {
      truncated = true;
      const marker = '[较早输出已省略]\n';
      let start = visible.length - (maxCharacters - marker.length);
      if (/[\uDC00-\uDFFF]/.test(visible[start] || '')) start++;
      visible = marker + visible.slice(start);
    }
  };
  const append = (chunk: string) => {
    let input = pending + chunk;
    pending = '';
    let boundary: number;
    while ((boundary = input.search(/[\r\n]/)) >= 0) {
      const line = input.slice(0, boundary);
      if (droppingLine || line.length > maxCharacters) truncated = true;
      publish(droppingLine || line.length > maxCharacters ? '[过长输出行已省略]\n' : `${line}\n`);
      droppingLine = false;
      input = input.slice(boundary + (input[boundary] === '\r' && input[boundary + 1] === '\n' ? 2 : 1));
    }
    if (input.length > maxCharacters || droppingLine) { droppingLine = true; truncated = true; }
    else pending = input;
    return visible;
  };
  return { append, read: () => visible, truncated: () => truncated, flush: () => {
    if (droppingLine) publish('[过长输出行已省略]\n');
    else if (pending) publish(pending);
    pending = ''; droppingLine = false;
    return visible;
  } };
}

export async function runProjectCommand(input: {
  workspacePath: string; binary: 'npm' | 'pnpm' | 'yarn'; args: string[]; signal: AbortSignal;
  onOutput: (text: string) => void; timeoutMs?: number;
}): Promise<{ exitCode: number | null; cancelled: boolean; timedOut: boolean }> {
  if (!['npm', 'pnpm', 'yarn'].includes(input.binary) || !path.isAbsolute(input.workspacePath)
    || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) throw new Error('项目命令参数无效');
  if (input.signal.aborted) return { exitCode: null, cancelled: true, timedOut: false };
  return new Promise(resolve => {
    const child = spawn(input.binary, input.args, { cwd: input.workspacePath, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', BROWSER: 'none' } });
    const outputStream = () => {
      const decoder = new StringDecoder('utf8');
      let pending = '', dropping = false;
      const accept = (text: string, final = false) => {
        let inputText = pending + text, boundary: number;
        pending = '';
        while ((boundary = inputText.search(/[\r\n]/)) >= 0) {
          const line = inputText.slice(0, boundary);
          input.onOutput(dropping || line.length > 65_536 ? '[过长输出行已省略]\n' : `${line}\n`);
          dropping = false;
          inputText = inputText.slice(boundary + (inputText[boundary] === '\r' && inputText[boundary + 1] === '\n' ? 2 : 1));
        }
        if (inputText.length > 65_536 || dropping) dropping = true;
        else pending = inputText;
        if (final) {
          if (dropping) input.onOutput('[过长输出行已省略]\n');
          else if (pending) input.onOutput(`${pending}\n`);
          pending = ''; dropping = false;
        }
      };
      return { write: (chunk: Buffer) => accept(decoder.write(chunk)), end: () => accept(decoder.end(), true) };
    };
    // Independent line buffers prevent stderr from splitting a credential written to stdout (and vice versa).
    const stdout = outputStream(), stderr = outputStream();
    let exitCode: number | null = null, cancelled = false, timedOut = false, closed = false, cleaned = false, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (!child.pid) return false;
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch { return false; }
    };
    const finish = () => {
      if (!closed || !cleaned || settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(cleanupTimer);
      input.signal.removeEventListener('abort', abort);
      resolve({ exitCode, cancelled, timedOut });
    };
    const cleanup = () => {
      if (cleaned || cleanupTimer) return;
      if (!signalGroup('SIGTERM')) { cleaned = true; finish(); return; }
      // Keep this timer after the parent exits: descendants may still own stdout or ignore TERM.
      cleanupTimer = setTimeout(() => { signalGroup('SIGKILL'); cleaned = true; finish(); }, 500);
    };
    const abort = () => { if (!settled) { cancelled = true; cleanup(); } };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.timeoutMs !== undefined) timeout = setTimeout(() => { timedOut = true; cleanup(); }, input.timeoutMs);
    child.stdout!.on('data', stdout.write);
    child.stderr!.on('data', stderr.write);
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      input.onOutput(`无法启动 ${input.binary} 项目命令（${code === 'ENOENT' ? '未找到可执行程序' : code === 'EACCES' ? '没有执行权限' : '进程启动失败'}）\n`);
    });
    child.on('exit', code => { exitCode = code; cleanup(); });
    child.on('close', () => {
      stdout.end(); stderr.end();
      closed = true;
      cleanup(); finish();
    });
    if (input.signal.aborted) abort();
  });
}

/** Read only the exact managed service's default PM2 log files, never a client-supplied path. */
export async function readManagedLaunchLog(input: { manager: string; workspacePath: string; command: string }): Promise<string> {
  if (!/^delivery-launch-[a-f0-9]{24}$/.test(input.manager) || !path.isAbsolute(input.workspacePath) || !input.command.trim()) throw new Error('启动日志归属参数无效');
  const pm2Home = await fs.realpath(process.env.PM2_HOME || path.join(os.homedir(), '.pm2')).catch(() => '');
  if (!pm2Home) return '';
  let daemonPid = 0;
  const pidFile = await fs.open(path.join(pm2Home, 'pm2.pid'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!pidFile) return '';
  try {
    const info = await pidFile.stat();
    if (!info.isFile() || info.size > 32 || info.nlink !== 1) return '';
    daemonPid = Number(await pidFile.readFile('utf8'));
  } finally { await pidFile.close(); }
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) return '';
  try { process.kill(daemonPid, 0); } catch { return ''; }
  let entries: unknown;
  try {
    const result = await execFileAsync('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8_388_608 });
    entries = JSON.parse(result.stdout);
  } catch { throw new Error('本配置服务日志暂不可读：无法核对 PM2 状态'); }
  if (!Array.isArray(entries)) throw new Error('本配置服务日志暂不可读：PM2 状态格式无效');
  const matches = entries.filter(entry => entry && typeof entry === 'object' && entry.name === input.manager);
  if (!matches.length) return '';
  const entry = matches.length === 1 ? matches[0]?.pm2_env : undefined;
  const workspacePath = await fs.realpath(input.workspacePath);
  if (!entry || entry.pm_exec_path !== '/bin/zsh' || !Array.isArray(entry.args) || entry.args.length !== 2
    || entry.args[0] !== '-lc' || entry.args[1] !== input.command
    || typeof entry.pm_cwd !== 'string' || await fs.realpath(entry.pm_cwd).catch(() => '') !== workspacePath) throw new Error('服务归属与启动配置不匹配，未读取日志');
  const logRoot = path.join(pm2Home, 'logs');
  if (!(await fs.lstat(logRoot)).isDirectory() || await fs.realpath(logRoot) !== logRoot) throw new Error('PM2 日志目录不允许符号链接');
  const readTail = async (filename: unknown, suffix: 'out' | 'error') => {
    if (typeof filename !== 'string' || path.dirname(filename) !== logRoot
      || !new RegExp(`^${input.manager}-${suffix}(?:-\\d+)?\\.log$`).test(path.basename(filename))) throw new Error('本配置日志路径不在允许范围内');
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || await fs.realpath(filename) !== filename) throw new Error('日志来源不是独立普通文件');
      const current = await fs.stat(filename);
      if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('日志来源已变化');
      const start = Math.max(0, info.size - 32_768), buffer = Buffer.alloc(Math.min(info.size, 32_768));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let content = buffer.subarray(0, bytesRead);
      if (start > 0) { const newline = content.indexOf(10); content = newline < 0 ? Buffer.alloc(0) : content.subarray(newline + 1); }
      // A live service can stop mid-credential between polls; publish only complete lines.
      const lastNewline = Math.max(content.lastIndexOf(10), content.lastIndexOf(13));
      content = lastNewline < 0 ? Buffer.alloc(0) : content.subarray(0, lastNewline + 1);
      return redactProjectOutput(content.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw new Error('本配置日志来源无法安全核对，未读取日志');
    } finally { await handle?.close(); }
  };
  const [out, error] = await Promise.all([readTail(entry.pm_out_log_path, 'out'), readTail(entry.pm_err_log_path, 'error')]);
  const logs = createProjectLogBuffer();
  logs.append(`${out ? `标准输出：\n${out}\n` : ''}${error ? `错误输出：\n${error}\n` : ''}`);
  return logs.flush();
}

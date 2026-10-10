/** 与桌面端共用已登录的 CLI 和会话目录；只保存二进制位置，不复制或读取认证凭据。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function executable(filename: string) {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch { return false; }
}

export function isCompleteCodexRuntime(binary: string) {
  if (!executable(binary)) return false;
  // PATH 中的符号链接也必须检查其实际二进制同目录的 host。
  return executable(path.join(path.dirname(fs.realpathSync(binary)), 'codex-code-mode-host'));
}

export function findCliOnPath(command: string, environment: NodeJS.ProcessEnv = process.env) {
  for (const directory of (environment.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, command);
    if (executable(candidate)) return candidate;
    if (process.platform === 'win32' && executable(`${candidate}.exe`)) return `${candidate}.exe`;
  }
  return undefined;
}

export function resolveCliBinaries(environment: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform) {
  const desktopCandidates = platform === 'darwin' ? ['Codex.app', 'ChatGPT.app'].flatMap(app => [
    path.join(home, 'Applications', app), path.join('/Applications', app),
  ].flatMap(appRoot => [
    path.join(appRoot, 'Contents/Resources/codex'),
    path.join(appRoot, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  ])) : [];
  const codexCandidates = [environment.DELIVERY_CODEX_BIN, ...desktopCandidates, findCliOnPath('codex', environment)]
    .filter((candidate): candidate is string => !!candidate);
  // 新版桌面 Codex 依赖同目录 code-mode host；不复制或拼装单个二进制。
  const codex = codexCandidates.find(isCompleteCodexRuntime)
    || codexCandidates.find(executable) || environment.DELIVERY_CODEX_BIN || 'codex';
  const cursor = environment.DELIVERY_CURSOR_BIN || findCliOnPath('cursor-agent', environment)
    || findCliOnPath('agent', environment) || [path.join(home, '.local/bin/cursor-agent'), path.join(home, '.local/bin/agent')].find(executable)
    || 'cursor-agent';
  return { codex, cursor };
}

const binaries = resolveCliBinaries();
export const cliBinary = binaries.codex;
export const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const cursorBinary = binaries.cursor;

export function codexChildEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const environment = { ...source };
  // PM2 可能由 Codex 桌面任务启动；子 Agent 必须创建自己的会话，不能继承父任务或桌面工具管道。
  for (const key of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_PERMISSION_PROFILE']) delete environment[key];
  return environment;
}

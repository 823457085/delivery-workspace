/** 与桌面端共用已登录的 CLI 和会话目录；只保存二进制位置，不复制或读取认证凭据。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isCompleteCodexRuntime(binary: string) {
  return fs.existsSync(binary) && fs.existsSync(path.join(path.dirname(binary), 'codex-code-mode-host'));
}

const configuredCodex = process.env.DELIVERY_CODEX_BIN;
const codexCandidates = [
  configuredCodex,
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'codex')),
].filter((candidate): candidate is string => !!candidate);

// 新版 Codex 的命令工具依赖同目录 code-mode host；孤立复制单个二进制会导致所有读取命令启动失败。
export const cliBinary = codexCandidates.find(isCompleteCodexRuntime)
  || codexCandidates.find((candidate) => fs.existsSync(candidate))
  || path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex');
export const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const cursorBinary = process.env.DELIVERY_CURSOR_BIN || path.join(os.homedir(), '.local/bin/cursor-agent');
export const claudeBinary = process.env.DELIVERY_CLAUDE_BIN || [
  path.join(os.homedir(), '.local/bin/claude'),
  path.join(os.homedir(), '.local/share/delivery-ai-clis/node_modules/.bin/claude'),
].find(candidate => fs.existsSync(candidate)) || 'claude';

export const kiroBinary = process.env.DELIVERY_KIRO_BIN || [
  path.join(os.homedir(), '.local/bin/kiro-cli'),
  '/opt/homebrew/bin/kiro-cli',
  '/usr/local/bin/kiro-cli',
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'kiro-cli')),
].find(candidate => fs.existsSync(candidate)) || 'kiro-cli';

export const antigravityBinary = process.env.DELIVERY_ANTIGRAVITY_BIN || [
  path.join(os.homedir(), '.local/bin/agy'),
  '/opt/homebrew/bin/agy',
  '/usr/local/bin/agy',
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'agy')),
].find(candidate => fs.existsSync(candidate)) || 'agy';

// agy waits for the profile photo request to time out before serving /model or /usage.
export const antigravityMetadataTimeoutMs = 40_000;

export const deepseekBinary = process.env.DELIVERY_DEEPSEEK_BIN || [
  '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh',
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'dsh')),
].find(candidate => fs.existsSync(candidate)) || 'dsh';

import type { AgentProvider } from '../shared/agent-runtime.js';

const SAFE_BASE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TMPDIR', 'TMP', 'TEMP',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  'SSH_AUTH_SOCK', 'DISPLAY', 'SECURITYSESSIONID', 'CF_USER_TEXT_ENCODING', '__CF_USER_TEXT_ENCODING',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_REGISTRY',
  'PNPM_HOME', 'NVM_DIR', 'VOLTA_HOME', 'FNM_DIR', 'ASDF_DIR',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT', 'GOPROXY', 'GONOSUMDB',
  'JAVA_HOME', 'PYENV_ROOT', 'VIRTUAL_ENV',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
]);

const PROVIDER_ALLOWED_PREFIXES: Record<AgentProvider, readonly string[]> = {
  codex: ['CODEX_', 'OPENAI_'],
  claude: ['CLAUDE_', 'ANTHROPIC_', 'VERTEX_'],
  cursor: ['CURSOR_'],
  kiro: ['KIRO_'],
  antigravity: ['ANTIGRAVITY_', 'AGY_', 'GEMINI_'],
  deepseek: ['DEEPSEEK_'],
  grok: ['XAI_', 'GROK_'],
  workbuddy: ['WORKBUDDY_'],
  api: [],
};

const PROVIDER_ALLOWED_EXACT_KEYS: Partial<Record<AgentProvider, readonly string[]>> = {
  claude: ['AWS_REGION', 'AWS_DEFAULT_REGION', 'DISABLE_AUTOUPDATER'],
  kiro: ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE'],
  antigravity: ['GOOGLE_CLOUD_PROJECT', 'CLOUDSDK_CONFIG'],
};

const FORBIDDEN_HOST_SECRET_KEY_RE =
  /^(?:JIRA|CONFLUENCE|WECOM|JENKINS|YUNXIAO|CODEUP|APIFOX|GITLAB|GITHUB|APEX_CATCHUP|DELIVERY_(?:GATEWAY|CREDENTIALS|SOURCE|SECRET|TOKEN))_|_(?:COOKIE|WEBHOOK_URL)$/i;

const CODEX_STRIPPED_DESKTOP_KEYS = new Set([
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_PERMISSION_PROFILE',
]);

/**
 * 为外部 Agent CLI 子进程构造严格白名单环境变量（修复 P0-1）：
 * 仅透传基础系统/代理/工具链变量与当前执行器自身前缀变量，彻底剥离 .env.local 中的 Jira / Confluence / Codeup / Jenkins / 企微等平台凭据。
 */
export function cliChildEnvironment(
  provider: AgentProvider,
  source: NodeJS.ProcessEnv = process.env,
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const prefixes = PROVIDER_ALLOWED_PREFIXES[provider] || [];
  const exactAllowed = new Set(PROVIDER_ALLOWED_EXACT_KEYS[provider] || []);
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (FORBIDDEN_HOST_SECRET_KEY_RE.test(key)) continue;
    if (
      SAFE_BASE_ENV_KEYS.has(key)
      || exactAllowed.has(key)
      || prefixes.some(prefix => key.startsWith(prefix))
    ) {
      environment[key] = value;
    }
  }

  if (provider === 'claude') {
    environment.DISABLE_AUTOUPDATER = '1';
    delete environment.CLAUDECODE;
  } else if (provider === 'codex') {
    // PM2 可能由 Codex 桌面任务启动；子 Agent 必须创建自己的会话，不能继承父任务或桌面工具管道。
    for (const key of CODEX_STRIPPED_DESKTOP_KEYS) delete environment[key];
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }

  return environment;
}

export function claudeChildEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return cliChildEnvironment('claude', source);
}

export function codexChildEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return cliChildEnvironment('codex', source);
}

/** 工作台浏览器配置。已授权的本机 Chrome 可复用登录态，每条会话仍有独立标签绑定。 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function executable(candidates: string[]) {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* 缺少本机浏览器不影响普通代码任务。 */ }
  }
}

async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工作台浏览器目录不是独立目录');
  await fs.chmod(directory, 0o700);
}

export async function prepareAgentBrowserRuntime(input: { rootDirectory: string; scope: string; reuseChrome?: boolean; chromeEndpoint?: string }): Promise<{
  config?: Record<string, unknown>; instructions: string;
} | undefined> {
  if (!input.scope.trim()) throw new Error('工作台浏览器会话范围不能为空');
  const cdp = input.reuseChrome ? input.chromeEndpoint : undefined;
  const [binary, chrome] = await Promise.all([
    executable(process.env.DELIVERY_AGENT_BROWSER_BIN ? [process.env.DELIVERY_AGENT_BROWSER_BIN] : [
      '/opt/homebrew/bin/agent-browser', '/usr/local/bin/agent-browser',
      ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'agent-browser')),
    ]),
    executable(process.env.DELIVERY_AGENT_BROWSER_CHROME_BIN ? [process.env.DELIVERY_AGENT_BROWSER_CHROME_BIN] : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]),
  ]);
  if (input.reuseChrome && (!cdp || !binary)) {
    return { instructions: [
      !binary ? '工作台缺少连接日常 Chrome 的浏览器工具。' : '工作台尚未连接日常 Chrome。',
      '需要打开 Jira 或 Confluence 时，请在用户日常使用的 Chrome 中打开目标链接。不要启动独立 Chrome、临时浏览器配置或要求用户在其中登录。',
      ...(!cdp ? ['需要自动操作页面时，请先在工作台点击“连接 Chrome”，由用户在 Chrome 中选择允许，再开启新一轮。'] : []),
      '可在工作台“连接与额度”或“设置 → 连接与项目”的“日常 Chrome”卡片打开设置、连接和查看实际状态。未连接时保留浏览器未测，脚本接口失败不能作为浏览器登录失败的结论。',
    ].join('\n') };
  }
  if (!binary || (!cdp && !chrome)) return undefined;

  const root = await fs.realpath(input.rootDirectory);
  const installation = hash(root).slice(0, 12), scope = hash(cdp ? `attached-chrome:${cdp}:${input.scope}` : input.scope);
  const base = path.join(root, '.local', 'data', 'agent-browser');
  const configs = path.join(base, 'configs'), profiles = path.join(base, 'profiles');
  const profile = path.join(profiles, scope);
  // agent-browser 会追加 namespaces/<namespace>/run/<session>.sock；Darwin 总路径必须小于 104 字节。
  const socketParent = path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `dwb-${process.getuid?.() ?? 'local'}`);
  const socketDirectory = path.join(socketParent, installation.slice(0, 8));
  for (const directory of [base, configs, socketParent, socketDirectory, ...(cdp ? [] : [profiles, profile])]) await privateDirectory(directory);

  const configPath = path.join(configs, `${scope}.json`);
  // 日常 Chrome 只走工作台已授权的连接，任务不直接连接 Chrome。
  const browserConfig = { session: `dw-${scope}`, namespace: installation.slice(0, 8), idleTimeout: '30m',
    ...(cdp ? { cdp, pinTab: true } : { headed: true, profile, executablePath: chrome }) };
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(browserConfig, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, configPath);
  } finally { await fs.rm(temporary, { force: true }); }

  const browserEnvironment = { AGENT_BROWSER_CONFIG: configPath, AGENT_BROWSER_SOCKET_DIR: socketDirectory };
  const baseEnvironment = Object.fromEntries([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  ].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const cliPrefix = ['env', '-i', ...Object.entries({ ...baseEnvironment, ...browserEnvironment })
    .map(([key, value]) => shellQuote(`${key}=${value}`)), shellQuote(binary)].join(' ');

  return {
    config: {
      'mcp_servers.delivery_browser': {
        command: binary, args: ['mcp', '--tools', 'core,tabs'],
        // Codex 默认环境白名单不含 AGENT_BROWSER_*；只传本次明确拥有的配置。
        env_vars: [], env: browserEnvironment,
      },
    },
    instructions: [
      cdp ? '本次 delivery_browser 使用工作台已连接的日常 Chrome，沿用该浏览器有效的登录态。'
        : '本次已为工作台配置独立浏览器工具 delivery_browser；这表示工具已配置，不代表已经成功连接或登录。',
      '需要打开网页、登录或页面验证时，优先使用 delivery_browser 的工具，先打开任务指定页面并读取快照，确认实际连接状态。不要将桌面 cua 的 host unavailable 当作此浏览器不可用。',
      '若当前桌面会话没有注入 delivery_browser 工具，用 shell 执行下列同一会话的 CLI 前缀，在末尾追加 open <任务页面 URL>、snapshot -i 等命令。沿用此配置，不要删改或改用裸 agent-browser：',
      `\`\`\`sh\n${cliPrefix}\n\`\`\``,
      cdp ? '只操作本任务自动绑定的标签页；标签关闭时用 tab new 重建任务标签页。不要切换到其他标签页，不要导出或读取认证数据。连接失效时说明原因，不要另开浏览器要求重新登录。'
        : '该浏览器使用工作台专有会话和持久化目录，同一会话重试可保留登录。使用默认 session，不指定其他 session、profile、CDP、auto-connect，也不读取或复制用户其他浏览器的认证数据。',
      '页面缺少登录态时先实际打开并判断；已有明确授权且可安全取得测试凭据时完成登录，不重复询问已授权事项。密码不得写入提示词、日志或截图；仅执行本任务授权范围内的操作。',
      '如确实受阻，用用户能理解的话说明：浏览器连接不上、页面尚未登录、还是登录后业务操作失败，并写出已实际尝试的动作和需要解决的一件事。不要把接口未认证响应当作登录后的业务验证。',
    ].join('\n'),
  };
}

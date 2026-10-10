import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cliBinary, cursorBinary, codexChildEnvironment, isCompleteCodexRuntime } from '../server/cli-runtime.ts';
import { minimumNode, supportedNode } from './runtime-requirements.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function report(level, label, detail) {
  console.log(`[${level}] ${label}: ${detail}`);
  if (level === 'FAIL') failures++;
}
async function probe(binary, arguments_) {
  try {
    const result = await exec(binary, arguments_, { timeout: 10_000, maxBuffer: 64_000, env: codexChildEnvironment() });
    return { ok: true, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}`.trim() };
  } catch { return { ok: false, stdout: '', output: '' }; }
}
function versionText(label, output) {
  const prefixes = {
    pnpm: '(?:pnpm\\s+)?', Git: 'git version\\s+', 'SQLite CLI': '',
    Codex: '(?:codex-cli|codex)\\s+', Cursor: '(?:(?:cursor-agent|cursor)(?:\\s+version)?\\s+)?',
  };
  const version = output.trim().match(new RegExp(`^${prefixes[label]}(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)(?=\\s|$)`, 'i'))?.[1];
  const products = { pnpm: 'pnpm', Git: 'git', 'SQLite CLI': 'sqlite3', Codex: 'codex-cli', Cursor: 'cursor-agent' };
  // 仅输出已识别的产品名和版本字段；不展示 stderr 或版本命令的其他文本。
  return version ? `${products[label]} ${version}` : '版本命令可执行（未识别版本格式）';
}

report(supportedNode() ? 'OK' : 'FAIL', 'Node.js', `${process.version}（要求 >=${minimumNode}）`);
for (const [binary, label, instructions] of [
  ['pnpm', 'pnpm', '安装 pnpm 12.3.4'],
  ['git', 'Git', '安装 Git 后可使用工作区、分支与代码交付功能'],
  ['sqlite3', 'SQLite CLI', '安装 sqlite3 后可同步 Codex 本地会话'],
]) {
  const result = await probe(binary, ['--version']);
  report(result.ok ? 'OK' : 'FAIL', label, result.ok ? versionText(label, result.stdout) : instructions);
}

async function provider(label, binary, statusArguments) {
  const [version, login] = await Promise.all([probe(binary, ['--version']), probe(binary, statusArguments)]);
  const authenticated = login.ok && (label === 'Codex'
    ? /logged in/i.test(login.output) && !/not logged in/i.test(login.output)
    : !!login.output && !/not logged in|unauthenticated|unauthorized/i.test(login.output));
  // 认证命令输出只用于判断，绝不输出原文或读取 auth.json。
  report(version.ok && authenticated ? 'OK' : 'WARN', `${label} CLI`, !version.ok
    ? `未找到可用 CLI；配置 DELIVERY_${label.toUpperCase()}_BIN 或加入 PATH`
    : `${versionText(label, version.stdout)} · ${authenticated ? '已登录' : '未登录，请使用本机 CLI 登录'} · ${binary}`);
  return version.ok && authenticated;
}
const ready = await Promise.all([provider('Codex', cliBinary, ['login', 'status']), provider('Cursor', cursorBinary, ['status'])]);
report(ready.some(Boolean) ? 'OK' : 'FAIL', 'Agent 执行', ready.some(Boolean) ? '至少一个已登录的 CLI 可用' : '请安装并登录 Codex CLI 或 Cursor CLI');
report('INFO', 'Codex 运行时', isCompleteCodexRuntime(cliBinary) ? '检测到同目录 codex-code-mode-host，保留完整桌面运行时' : '使用独立 CLI；若配置桌面二进制，请保留同目录完整资源');
report(fs.existsSync(path.join(root, '.env')) ? 'OK' : 'WARN', '本机配置', fs.existsSync(path.join(root, '.env')) ? '.env 已存在（不显示配置内容）' : '先执行 pnpm run setup 创建 .env');
report(fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'OK' : 'WARN', '前端构建', fs.existsSync(path.join(root, 'dist', 'index.html')) ? 'dist/index.html 已存在' : '执行 pnpm build 或 pnpm run setup');
report('INFO', '数据目录', path.resolve(process.env.DELIVERY_DATA_DIR || path.join(root, '.data')));
for (const [label, directory, entry] of [
  ['项目 Skills', process.env.DELIVERY_SKILLS_ROOT || './support/skills', ''],
  ['AI Delivery Kit', process.env.AI_DELIVERY_KIT_ROOT || './support/ai-delivery-kit', 'kit.yaml'],
]) {
  const absolute = path.resolve(root, directory);
  const available = fs.existsSync(path.join(absolute, entry));
  report(available ? 'OK' : 'WARN', label, available ? absolute : `未找到支持包，请确认 ${directory} 已随仓库下载`);
}
report('INFO', 'Jira/Confluence', '外部集成使用接收者自己的 URL、账号和授权；未配置时不影响本地工作台启动');
report('INFO', 'Atlassian MCP', '需要技术方案或 Jira/Confluence 操作时，在接收者的 Codex 中连接自己的 Atlassian MCP；doctor 不读取其凭据');
if (process.platform !== 'darwin') report('INFO', '系统交互', '原生文件夹选择器和 Terminal.app 入口需要 macOS；可在工作台直接填写工作区路径');
process.exitCode = failures ? 1 : 0;

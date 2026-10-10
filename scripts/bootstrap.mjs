import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { requireSupportedNode } from './runtime-requirements.mjs';

requireSupportedNode();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
try {
  const content = await fs.readFile(path.join(root, '.env.example'));
  await fs.writeFile(envFile, content, { flag: 'wx', mode: 0o600 });
  console.log('已创建本机 .env，请按需填入自己的集成配置。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('保留现有 .env。');
}
process.loadEnvFile(envFile);
await fs.mkdir(path.join(root, '.data', 'source'), { recursive: true });

function pnpm(arguments_) {
  // pnpm 既有 Node 脚本发行版，也有独立可执行发行版；不能把原生二进制交给 Node 解释。
  const script = process.env.npm_execpath;
  const pnpmEntry = script && path.basename(script).includes('pnpm') ? script : 'pnpm';
  const nodeScript = /\.[cm]?js$/i.test(pnpmEntry);
  const executable = nodeScript ? process.execPath : pnpmEntry;
  const argumentsList = nodeScript ? [pnpmEntry, ...arguments_] : arguments_;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', () => reject(new Error('未找到 pnpm，请先安装 pnpm 12.3.4，再执行 pnpm run setup。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pnpm ${arguments_[0]} 失败（退出码 ${code}）`)));
  });
}

try {
  await pnpm(['install', '--frozen-lockfile']);
  await pnpm(['build']);
  try { await pnpm(['run', 'doctor']); }
  catch { console.log('安装与构建已完成；请按 doctor 的说明配置本机 CLI 后重新执行 pnpm run doctor。'); }
  console.log(`工作台已准备好，执行 pnpm start 启动（http://localhost:${Number(process.env.PORT ?? 5199)}/agent）。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

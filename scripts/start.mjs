import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { requireSupportedNode } from './runtime-requirements.mjs';

requireSupportedNode();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
if (!development && !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('未找到前端构建，请先执行 pnpm run setup 或 pnpm build。开发模式使用 pnpm dev。');
  process.exit(1);
}
// 必须由 Node 在加载任何配置模块前解析 .env；不在应用启动之后手工补变量。
const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'server/index.ts',
  ...(development ? ['--dev'] : [])], { cwd: root, stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => {
  console.error('启动失败，请执行 pnpm run setup 安装依赖。');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

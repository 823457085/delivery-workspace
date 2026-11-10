import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const locateCursor = `ObjC.import('AppKit');
const app = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier('com.todesktop.230313mzl4w4u92');
ObjC.unwrap(app.path) || '';`;

export class CursorDesktopError extends Error {}

export async function openCursorEditor(args, { executeFile = exec } = {}) {
  if (process.platform !== 'darwin') throw new CursorDesktopError('当前打开 Cursor 功能仅支持 macOS');
  const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 };
  const application = await executeFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', locateCursor], options)
    .then(result => result.stdout.trim(), () => '');
  if (!path.isAbsolute(application)) {
    throw new CursorDesktopError('未找到 Cursor 桌面版，请完成安装并从「应用程序」打开一次 Cursor 后重试');
  }
  // Cursor 自带的编辑器命令不会经过 PATH 中可能已失效的链接或 Agent 转发脚本。
  const env = { ...process.env };
  delete env.VSCODE_IPC_HOOK_CLI; // 从 IDE 终端启动 Delivery 时也始终打开本机编辑器。
  try {
    await executeFile(path.join(application, 'Contents/Resources/app/bin/cursor'), ['--classic', ...args], { ...options, env, timeout: 10_000 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CursorDesktopError('Cursor 正在更新或安装不完整，请在桌面版可用后重试');
    throw new CursorDesktopError('Cursor 编辑器未能打开，请先在本机打开 Cursor，再重试');
  }
}

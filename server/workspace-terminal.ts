/** 仅将已验证目录交给固定本机应用；不提供命令执行接口，不拼接 shell，普通目录无需 Git。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CursorDesktopError, openCursorEditor } from './cursor-desktop.mjs';

const exec = promisify(execFile);
type WorkspaceApp = 'Terminal' | 'Cursor';
export async function openWorkspaceTerminal(directory: string) {
  if (process.platform !== 'darwin') throw new Error('当前打开工作区功能仅支持 macOS');
  await exec('/usr/bin/open', ['-a', 'Terminal', directory], { timeout: 10_000 });
}

export async function prepareCursorWorkspace(directory: string, workspaceDirectory: string) {
  directory = await fs.realpath(directory);
  const targetDirectory = path.join(workspaceDirectory, createHash('sha256').update(directory).digest('hex'));
  await fs.mkdir(targetDirectory, { recursive: true });
  const file = path.join(targetDirectory, `${path.basename(directory) || 'workspace'}.code-workspace`);
  try {
    await fs.writeFile(file, `${JSON.stringify({ folders: [{ path: directory }] }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return file;
}

export async function openWorkspaceCursor(directory: string, workspaceDirectory: string, options?: Parameters<typeof openCursorEditor>[1]) {
  if (process.platform !== 'darwin') throw new Error('当前打开工作区功能仅支持 macOS');
  // 旧 workspace 可能已被 Agents 窗口占用；IDE 使用独立且稳定的身份。
  const file = await prepareCursorWorkspace(directory, path.join(workspaceDirectory, 'ide'));
  await openCursorEditor(['--new-window', file], options);
}

export function createWorkspaceTerminalRoute(open = openWorkspaceTerminal) {
  return createWorkspaceAppRoute('Terminal', open);
}

export function createWorkspaceAppRoute(app: WorkspaceApp, open: (directory: string) => Promise<void>) {
  const label = app === 'Terminal' ? '终端' : ' Cursor';
  let opening = false;
  return async (request: IncomingMessage, response: ServerResponse, port: number) => {
    const send = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message }));
    };
    if (request.method !== 'POST') { send(405, app === 'Terminal' ? '请点击打开终端按钮' : '请点击打开 Cursor 按钮'); return; }
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '');
    if (!local || !hosts.includes(request.headers.host || '') || request.headers.origin !== `http://${request.headers.host}`) {
      send(403, `请在运行 Delivery 的电脑上通过 localhost 打开${label}`); return;
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { send(415, '请发送 JSON'); return; }
    let ownsOpening = false;
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 4096) throw new Error('请求内容过大'); }
      const input = JSON.parse(raw);
      if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.workspacePath !== 'string'
        || !path.isAbsolute(input.workspacePath) || input.workspacePath.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.workspacePath)) {
        throw new Error('请选择有效的工作区目录');
      }
      let directory: string;
      try {
        directory = await fs.realpath(input.workspacePath);
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
      } catch { throw new Error('工作区目录不存在或无法访问'); }
      if (opening) { send(409, `正在打开${label}，请勿重复点击`); return; }
      opening = ownsOpening = true;
      await open(directory);
      send(200, app === 'Terminal' ? '已打开工作区终端' : '已在 Cursor 中打开工作区');
    } catch (error) {
      send(400, ownsOpening ? app === 'Cursor' ? (error instanceof CursorDesktopError ? error.message : 'Cursor 未能打开，请检查工作区是否可访问')
        : '终端未能打开，请检查本机 Terminal 是否可用' : error instanceof Error ? error.message : `打开${label}失败`);
    } finally { if (ownsOpening) opening = false; }
  };
}

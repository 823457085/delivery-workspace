/** 浏览器拿不到目录绝对路径，由本机原生选择器返回；固定脚本、同源校验和单实例防止任意命令与重复弹窗。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceSelection } from '../shared/workspace-selection.js';

const exec = promisify(execFile);
// 让系统脚本宿主管理窗口激活与模态事件，不在后台 osascript 中手动运行 AppKit 面板。
export const folderScript = `const app = Application.currentApplication();
app.includeStandardAdditions = true;
let selected = null;
try {
  selected = app.chooseFolder({
    withPrompt: '请选择 Agent 使用的本地文件夹。无需 Git 仓库；仅回填路径，不上传文件、不启动任务。',
    multipleSelectionsAllowed: false
  }).toString();
} catch (error) {
  if (error.errorNumber !== -128) throw error;
}
JSON.stringify(selected);`;

async function chooseNativeFolder(signal: AbortSignal): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('当前本机文件夹选择器仅支持 macOS');
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', folderScript], { signal, timeout: 120_000, maxBuffer: 16_384 });
    return JSON.parse(stdout);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('文件夹选择器未完成或已超时，请重新选择');
  }
}

export function createWorkspacePickerRoute(chooseFolder = chooseNativeFolder) {
  let selecting = false;
  return async (request: IncomingMessage, response: ServerResponse, port: number) => {
    const send = (status: number, value: WorkspaceSelection | { message: string }) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'POST') { send(405, { message: '请点击选择文件夹按钮' }); return; }
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!hosts.includes(request.headers.host || '') || !hosts.some(host => request.headers.origin === `http://${host}`)) {
      send(403, { message: '文件夹选择仅接受本机面板请求' }); return;
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { send(415, { message: '请发送 JSON' }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    let ownsPicker = false;
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 1000) throw new Error('选择请求过大'); }
      const input = JSON.parse(raw);
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw new Error('文件夹选择不接受路径或脚本参数');
      if (selecting) { send(409, { message: '已有文件夹选择器打开，请先完成或取消选择' }); return; }
      selecting = ownsPicker = true;
      response.once('close', abort);
      const selected = await chooseFolder(controller.signal);
      if (selected === null) { send(200, { cancelled: true }); return; }
      if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('未取得有效的本机文件夹路径');
      const workspacePath = await fs.realpath(selected);
      if (workspacePath.length > 1000 || !(await fs.stat(workspacePath)).isDirectory()) throw new Error('请选择有效的工作区文件夹');
      let branch = '';
      try { branch = (await exec('git', ['-C', workspacePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000, signal: controller.signal })).stdout.trim(); }
      catch { /* 普通目录或 detached HEAD 不虚构分支，执行前仍由 intake 核验。 */ }
      send(200, { cancelled: false, workspacePath, branch, message: branch ? '已选择工作区并读取当前分支' : '已选择普通文件夹' });
    } catch (error) {
      if (!controller.signal.aborted) send(400, { message: error instanceof Error ? error.message : '文件夹选择失败' });
    } finally {
      response.off('close', abort);
      if (ownsPicker) selecting = false;
    }
  };
}

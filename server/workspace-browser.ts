/** 远端选择器只列举当前用户目录并读取分支，不弹本机窗口、不写文件、不启动任务。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceDirectoryListing, WorkspaceSelection } from '../shared/workspace-selection.js';

const exec = promisify(execFile);

export function createWorkspaceBrowser(root = os.homedir()) {
  async function directory(input = '') {
    if (typeof input !== 'string' || input.length > 1000 || /[\u0000-\u001f\u007f]/.test(input) || (input && !path.isAbsolute(input))) throw new Error('请选择有效的目录');
    const realRoot = await fs.realpath(root);
    const current = await fs.realpath(input || realRoot);
    const relative = path.relative(realRoot, current);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('只能选择运行 Delivery 的用户目录内的文件夹');
    if (!(await fs.stat(current)).isDirectory()) throw new Error('请选择文件夹');
    return { current, realRoot };
  }

  async function browse(input = ''): Promise<WorkspaceDirectoryListing> {
    const { current, realRoot } = await directory(input);
    const candidates = (await fs.readdir(current, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: current, parent: current === realRoot ? null : path.dirname(current), truncated: candidates.length > 500,
      entries: candidates.slice(0, 500).map(entry => ({ name: entry.name, path: path.join(current, entry.name), kind: entry.isDirectory() ? 'directory' : 'file' })) };
  }

  async function select(input: string): Promise<WorkspaceSelection> {
    if (!input) throw new Error('请先选择目录');
    const { current } = await directory(input);
    let branch = '';
    try { branch = (await exec('git', ['-C', current, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5000 })).stdout.trim(); }
    catch { /* 普通文件夹同样支持，不虚构 Git 分支。 */ }
    return { cancelled: false, workspacePath: current, branch, message: branch ? '已选择工作区并读取当前分支' : '已选择普通文件夹' };
  }
  return { browse, select };
}

/** 调用方必须先验证可信网络、Host 与同源；此路由仅用于已验证的访问入口。 */
export function createWorkspaceBrowserRoute(browser = createWorkspaceBrowser()) {
  return async (request: IncomingMessage, response: ServerResponse, action: 'browse' | 'select') => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    if (request.method !== 'POST') { send(405, { message: '请通过目录选择器操作' }); return; }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { send(415, { message: '请发送 JSON' }); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 4096) throw new Error('请求内容过大'); }
      const input = JSON.parse(raw);
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => key !== 'path') || (input.path !== undefined && typeof input.path !== 'string')) throw new Error('目录参数不正确');
      send(200, action === 'browse' ? await browser.browse(input.path) : await browser.select(input.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      send(400, { message: code ? '目录不存在或无法访问' : error instanceof Error ? error.message : '目录选择失败' });
    }
  };
}

/**
 * 设计说明：多个联调会话共用原生 Chrome，截图期间需要独占窗口操作，避免抓到其他会话。
 * 锁只覆盖原生点击与取图；接口核对仍并行。不按进程存活自动解锁，因为 CUA 在另一进程继续操作。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// 只诊断锁屏，不解锁或修改权限；桌面已解锁也仍需验证实际截图。
export function nativeCaptureReadiness(state: string) {
  const locked = state.match(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/)?.[1];
  return { desktopUnlocked: locked ? locked === 'No' : null,
    reason: locked === 'Yes' ? 'Mac 已锁屏：等待用户解锁并保持 Chrome 可见；原生截图与群推送暂停，浏览器接口核对可继续'
      : locked === 'No' ? 'Mac 已解锁，需继续验证实际原生截图' : '未能确认桌面锁屏状态，不能视为原生截图已可用' };
}

async function lockOwner(file: string) {
  try { return (JSON.parse(await fs.readFile(file, 'utf8')) as { owner?: string }).owner; }
  catch { return undefined; } // 另一会话刚创建文件、尚未写完时，仍视为锁被占用。
}

export async function captureLock(file: string, owner: string, action: 'acquire' | 'release') {
  if (!/^[a-z0-9-]{1,100}$/.test(owner)) throw new Error('截图锁需使用 taskId-requestId');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (action === 'acquire') {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ owner, acquiredAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      return { acquired: true, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await lockOwner(file);
      return { acquired: current === owner, owner: current || '正在取得锁' };
    }
  }
  if (await lockOwner(file) !== owner) throw new Error('不能释放其他会话的截图锁');
  await fs.unlink(file);
  return { released: true, owner };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , action, owner] = process.argv;
  if (action === 'preflight') {
    const state = process.platform === 'darwin' ? await promisify(execFile)('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1'], { timeout: 5000 }).then(result => result.stdout).catch(() => '') : '';
    console.log(JSON.stringify(nativeCaptureReadiness(state)));
  } else {
    if (action !== 'acquire' && action !== 'release') throw new Error('用法：tsx scripts/integration-capture-lock.ts preflight | acquire|release taskId-requestId');
    console.log(JSON.stringify(await captureLock(path.resolve('.data/integration-native-capture.lock'), owner || '', action)));
  }
}

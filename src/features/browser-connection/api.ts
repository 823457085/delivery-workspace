import type { BrowserConnectionStatus } from '../../../shared/browser-connection';

export type BrowserConnectionAction = 'open-settings' | 'connect' | 'disconnect';

async function request(action: BrowserConnectionAction | undefined, signal: AbortSignal): Promise<BrowserConnectionStatus> {
  const response = await fetch(`/api/browser/connection${action ? `/${action}` : ''}`, action
    ? { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}' }
    : { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '浏览器连接状态读取失败');
  return data as BrowserConnectionStatus;
}

export const readBrowserConnection = (signal: AbortSignal) => request(undefined, signal);
export const changeBrowserConnection = (action: BrowserConnectionAction, signal: AbortSignal) => request(action, signal);

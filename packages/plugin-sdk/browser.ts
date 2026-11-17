import { createThemeChannel, type PluginTheme } from './theme.js';
declare global { interface Window { __deliveryToken: string; __deliveryTheme: Record<string, string>; __deliveryThemeSnapshot?: PluginTheme; __deliveryThemeMode?: 'full' | 'mode' | 'independent' } }
const initial = window.__deliveryThemeSnapshot || { id: 'legacy', mode: 'light' as const, version: 0, instance: window.__deliveryToken, tokens: { background: '', surface: '', text: '', muted: '', border: '', accent: '' } };
const channel = createThemeChannel(initial);
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let closed = false;
function applyTheme(values: Record<string, string>, snapshot?: PluginTheme) {
  const mode = window.__deliveryThemeMode || 'full';
  if (mode === 'independent') return;
  if (snapshot) document.documentElement.style.colorScheme = snapshot.mode;
  if (snapshot && mode === 'full') for (const [key, value] of Object.entries(snapshot.tokens)) document.documentElement.style.setProperty('--ui-' + (key === 'background' ? 'bg' : key), value);
  if (mode === 'full') for (const [name, value] of Object.entries(values || {})) if (/^--(?:ui-|el-|sans$|mono$)/.test(name)) document.documentElement.style.setProperty(name, value);
}
applyTheme(window.__deliveryTheme || {}, initial);
function receive(event: MessageEvent) {
  if (closed || event.source !== window.parent || event.data?.token !== window.__deliveryToken) return;
  if (event.data.type === 'delivery:theme') {
    if (event.data.theme ? channel.accept(event.data.theme) : !window.__deliveryThemeSnapshot) applyTheme(event.data.values, event.data.theme);
    return;
  }
  if (event.data.type !== 'delivery:response') return;
  const item = pending.get(event.data.id); if (!item) return;
  pending.delete(event.data.id); clearTimeout(item.timer);
  event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.result);
}
window.addEventListener('message', receive);
function close() {
  closed = true; channel.close(); window.removeEventListener('message', receive);
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('插件页面已关闭')); } pending.clear();
}
window.addEventListener('pagehide', close, { once: true });
export function hostCall<T = any>(method: string, input?: unknown): Promise<T> {
  if (closed || pending.size >= 12) return Promise.reject(new Error('插件已关闭或正在处理其他操作'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('插件请求超时，结果待核对；请勿自动重放写操作')); }, 120000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'delivery:request', token: window.__deliveryToken, id, method, input }, '*');
  });
}
// Listen before synchronizing, so changes during initialization are never missed.
if (window.__deliveryThemeSnapshot) void hostCall<PluginTheme>('theme.get').then(value => { if (channel.accept(value)) applyTheme({}, value); }).catch(() => {});
export const host = {
  theme: { get: channel.get, subscribe: channel.subscribe },
  configuration: { get: () => hostCall<{ values: Record<string, string>; secrets: Record<string, boolean>; revision: string }>('configuration.get') },
  menu: { get: () => hostCall<{ visible: boolean; icon?: string; group?: string }>('menu.get') },
  storage: {
    list: () => hostCall('storage.list'),
    save: (record: { id?: string; expectedVersion?: string; values: Record<string, unknown> }) => hostCall('storage.save', record),
    remove: (record: { id: string; expectedVersion: string }) => hostCall('storage.remove', record),
  },
  capabilities: { call: (name: string, method: string, input?: unknown, provider?: string) => hostCall('capabilities.call', { name, version: 1, method, input, provider }) },
  request: <T = any>(method: string, input?: unknown) => hostCall<T>('plugin.request', { method, input }),
  compose: (prompt: string, workspacePath?: string) => hostCall('conversation.compose', { prompt, workspacePath }),
  openWorkspace: (app: 'terminal' | 'cursor', workspacePath: string) => hostCall('workspace.open', { app, workspacePath }),
  download: (name: string, text: string) => hostCall('file.download', { name, text }),
  copy: (text: string) => hostCall('clipboard.write', { text }),
};

/** macOS 本机用原生选择器，其他系统与远端用网页选择器。 */
import { getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import type { WorkspaceSelection } from '../../shared/workspace-selection';

export function usesRemoteWorkspaceBrowser(hostname: string) {
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

export function useWorkspacePicker(request = () => fetch('/api/workspace/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  remote = () => typeof window !== 'undefined' && usesRemoteWorkspaceBrowser(window.location.hostname)) {
  const selecting = shallowRef(false);
  const error = shallowRef('');
  const browserOpen = shallowRef(false);
  const browserPath = shallowRef('');
  let disposed = false;
  let resolveBrowser: ((value: WorkspaceSelection | null) => void) | undefined;
  function completeBrowser(value: WorkspaceSelection | null) {
    browserOpen.value = false;
    resolveBrowser?.(value);
    resolveBrowser = undefined;
  }
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; completeBrowser(null); });
  async function choose(initialPath = '') {
    if (selecting.value || disposed) return null;
    selecting.value = true;
    error.value = '';
    try {
      const response = remote() ? undefined : await request();
      if (disposed) return null;
      if (!response || response.status === 501) {
        browserPath.value = initialPath;
        browserOpen.value = true;
        const selection = await new Promise<WorkspaceSelection | null>(resolve => { resolveBrowser = resolve; });
        return !selection || selection.cancelled ? null : selection;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '文件夹选择失败');
      const selection = result as WorkspaceSelection;
      return selection.cancelled ? null : selection;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '文件夹选择失败';
      return null;
    } finally { selecting.value = false; }
  }
  return { selecting, error, choose, browserOpen, browserPath, completeBrowser };
}

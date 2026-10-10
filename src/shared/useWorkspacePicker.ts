/** 本机用原生选择器，远端用网页选择器；只回填路径，取消、失败或卸载均不启动任务。 */
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
  let resolveBrowser: ((value: WorkspaceSelection | null) => void) | undefined;
  function completeBrowser(value: WorkspaceSelection | null) {
    browserOpen.value = false;
    resolveBrowser?.(value);
    resolveBrowser = undefined;
  }
  if (getCurrentScope()) onScopeDispose(() => completeBrowser(null));
  async function choose(initialPath = '') {
    if (selecting.value) return null;
    selecting.value = true;
    error.value = '';
    try {
      if (remote()) {
        browserPath.value = initialPath;
        browserOpen.value = true;
        const selection = await new Promise<WorkspaceSelection | null>(resolve => { resolveBrowser = resolve; });
        return !selection || selection.cancelled ? null : selection;
      }
      const response = await request();
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

import { computed, inject, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { agentWorkspaceContext } from '../agent-workspace-context';

/** 桌面圣杯三栏激活时，业务页面可将上下文副栏投射至右侧固定栏（Zone 4），窄屏自动回退为流内堆叠。 */
export function useHolyGrailAside(embedded?: boolean) {
  const workspace = inject(agentWorkspaceContext, undefined);
  const media = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1080px)') : undefined;
  const desktop = shallowRef(media ? media.matches : false);
  const sync = () => { if (media) desktop.value = media.matches; };
  onMounted(() => { sync(); media?.addEventListener('change', sync); });
  onBeforeUnmount(() => media?.removeEventListener('change', sync));
  return computed(() => (embedded ?? Boolean(workspace)) && desktop.value);
}

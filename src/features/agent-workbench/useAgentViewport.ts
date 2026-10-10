/** 仅管理移动布局和可视高度；不修改桌面栏宽/折叠偏好。使用 visualViewport 让 iOS 键盘不遮挡输入区。 */
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue';

export function useAgentViewport() {
  const media = window.matchMedia('(max-width: 1079px)');
  const mobile = shallowRef(media.matches);
  const height = shallowRef(window.visualViewport?.height || window.innerHeight);
  const top = shallowRef(0);
  const keyboardOpen = shallowRef(false);
  function update() {
    mobile.value = media.matches;
    const viewport = window.visualViewport;
    // 保留双指缩放；不要把用户放大后的可视区当作软键盘重新排版。
    if (viewport && viewport.scale !== 1) return;
    height.value = viewport?.height || window.innerHeight;
    top.value = viewport?.offsetTop || 0;
    keyboardOpen.value = mobile.value && window.innerHeight - height.value > 120;
  }
  onMounted(() => {
    update();
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
  });
  onBeforeUnmount(() => {
    media.removeEventListener('change', update);
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
  });
  const viewportStyle = computed(() => mobile.value ? { height: `${height.value}px`, top: `${top.value}px` } : {});
  return { mobile, keyboardOpen, viewportStyle };
}

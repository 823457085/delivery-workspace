import { onMounted, onUnmounted, ref } from 'vue';

// Iframes on other local ports can't inherit the workbench's CSS variables.
const tokens = [
  '--ui-bg', '--ui-surface', '--ui-raised', '--ui-hover', '--ui-text', '--ui-secondary',
  '--ui-muted', '--ui-border', '--ui-divider', '--ui-accent', '--ui-accent-soft',
  '--ui-primary', '--ui-primary-hover', '--ui-on-primary', '--ui-success', '--ui-success-bg',
  '--ui-warning', '--ui-warning-bg', '--ui-danger', '--ui-danger-bg', '--ui-overlay',
  '--ui-shadow-color', '--ds-radius-lg', '--ds-radius', '--ds-radius-sm', '--ds-control-height',
  '--ds-display', '--ds-code', '--sans',
];

export function useEmbeddedTheme() {
  const frame = ref<HTMLIFrameElement | null>(null);
  const syncTheme = () => {
    const iframe = frame.value;
    if (!iframe?.contentWindow) return;
    const style = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(tokens.map(name => [name, style.getPropertyValue(name).trim()]));
    iframe.contentWindow.postMessage({
      type: 'delivery-workbench:theme',
      colorScheme: style.colorScheme,
      variables,
    }, new URL(iframe.src).origin);
  };
  const observer = new MutationObserver(syncTheme);
  onMounted(() => observer.observe(document.documentElement, { attributeFilter: ['data-theme', 'style'] }));
  onUnmounted(() => observer.disconnect());
  return { frame, syncTheme };
}

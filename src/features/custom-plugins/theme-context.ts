import type { PluginTheme } from '../../../packages/plugin-sdk/theme';
/** One publisher per rendered instance; no global listeners survive its disposal. */
export function createThemePublisher(instance: string, publish: (theme: PluginTheme) => void) {
  let version = 0, serialized = '', current: PluginTheme, closed = false;
  const media = matchMedia('(prefers-color-scheme: dark)');
  function read() {
    const root = document.documentElement, css = getComputedStyle(root);
    const color = (key: string, fallback: string) => css.getPropertyValue(key).trim() || fallback;
    const next = { id: root.dataset.theme || 'default', mode: (css.colorScheme === 'dark' || root.classList.contains('dark') ? 'dark' : 'light') as 'light' | 'dark',
      tokens: { background: color('--ui-bg', color('--ui-background', '#fff')), surface: color('--ui-surface', '#fff'), text: color('--ui-text', '#172033'), muted: color('--ui-muted', '#667085'), border: color('--ui-border', '#d0d5dd'), accent: color('--ui-accent', '#2457df') } };
    const key = JSON.stringify(next);
    if (key !== serialized) { serialized = key; current = { ...next, version: ++version, instance }; }
    return current;
  }
  function changed() { if (!closed) { const previous = version, value = read(); if (version !== previous) publish(value); } }
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true });
  media.addEventListener('change', changed);
  // Theme styles can also finish loading after the first frame.
  window.addEventListener('load', changed);
  read();
  return { get: read, close() { closed = true; observer.disconnect(); media.removeEventListener('change', changed); window.removeEventListener('load', changed); } };
}

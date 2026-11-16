export interface PluginTheme {
  id: string;
  mode: 'light' | 'dark';
  version: number;
  instance: string;
  tokens: { background: string; surface: string; text: string; muted: string; border: string; accent: string };
}
/** Replay closes the get/subscribe gap; immutable snapshots and monotonic versions reject stale events. */
export function createThemeChannel(initial: PluginTheme) {
  let current = freeze(initial), closed = false;
  const subscribers = new Set<(theme: PluginTheme) => void>();
  function freeze(value: PluginTheme): PluginTheme { return Object.freeze({ ...value, tokens: Object.freeze({ ...value.tokens }) }); }
  function deliver(listener: (theme: PluginTheme) => void) { try { listener(current); } catch { /* One plugin listener cannot break other listeners. */ } }
  return {
    get: async () => current,
    subscribe(listener: (theme: PluginTheme) => void) {
      if (closed) return () => {};
      subscribers.add(listener); deliver(listener);
      return () => { subscribers.delete(listener); };
    },
    accept(value: PluginTheme) {
      if (closed || !value || value.instance !== current.instance || !Number.isSafeInteger(value.version) || value.version <= current.version) return false;
      current = freeze(value); for (const listener of subscribers) deliver(listener); return true;
    },
    close() { closed = true; subscribers.clear(); },
  };
}

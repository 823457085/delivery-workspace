/**
 * 命令面板置顶收藏夹（Pinned Commands）与本机监听端口快捷索引（借鉴 Raycast Pinned Commands & Port Manager 扩展）。
 */
import type { PortSnapshot } from '../../../shared/port-monitor';
import type { CommandPaletteItem } from './command-palette';

export const COMMAND_PINS_STORAGE_KEY = 'delivery-workspace.cmd-pins.v1';
export const MAX_PINNED_COMMANDS = 12;

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizePinnedCommandIds(raw: unknown, maxPins = MAX_PINNED_COMMANDS): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 120);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    valid.push(trimmed);
    if (valid.length >= maxPins) break;
  }
  return valid;
}

export function readPinnedCommandIds(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(COMMAND_PINS_STORAGE_KEY);
    return normalizePinnedCommandIds(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
}

export function writePinnedCommandIds(
  ids: readonly string[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(COMMAND_PINS_STORAGE_KEY, JSON.stringify(normalizePinnedCommandIds(ids)));
    return true;
  } catch {
    return false;
  }
}

export function togglePinnedCommandId(
  current: readonly string[],
  targetId: string,
  maxPins = MAX_PINNED_COMMANDS,
): { ids: string[]; pinned: boolean } {
  const id = targetId.trim();
  if (!id) return { ids: [...current], pinned: false };
  if (current.includes(id)) {
    return {
      ids: current.filter((entry) => entry !== id),
      pinned: false,
    };
  }
  return {
    ids: [id, ...current].slice(0, Math.max(1, maxPins)),
    pinned: true,
  };
}

export function buildPortCommandItems(snapshot: PortSnapshot | null | undefined): CommandPaletteItem[] {
  if (!snapshot || !Array.isArray(snapshot.ports)) return [];
  const items: CommandPaletteItem[] = [];
  for (const entry of snapshot.ports) {
    if (entry.status !== 'listening' || !entry.listeners.length || entry.port <= 0) continue;
    const primary = entry.listeners[0]!;
    const label = primary.project?.name || primary.service || primary.process || `本地服务`;
    const isSelf = snapshot.selfPort === entry.port;
    const subtitleParts = [
      `${primary.process || 'proc'} (PID ${primary.pid})`,
      primary.manager || 'standalone',
    ];
    if (primary.project?.branch) subtitleParts.push(primary.project.branch);
    subtitleParts.push('回车打开本地地址 · ⇧回车定位端口检测');

    items.push({
      id: `port:${entry.port}`,
      category: 'port',
      title: `:${entry.port} · ${label}`,
      subtitle: subtitleParts.join(' · '),
      keywords: `port listen :${entry.port} ${entry.port} ${label} ${primary.process} ${primary.service} ${primary.manager} ${primary.project?.branch || ''} 端口 监听 本地服务`,
      badge: isSelf ? '当前工作台' : '监听中',
      active: isSelf,
      portNumber: entry.port,
    });
  }
  return items.sort((a, b) => (Number(!!b.active) - Number(!!a.active)) || ((a.portNumber || 0) - (b.portNumber || 0)));
}

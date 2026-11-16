/**
 * 设计说明：借鉴 GitHub 标杆项目 Zed (`command_palette.use_command_history`) 与 Raycast 的 Frecency（频率 + 最近使用衰减）智能记忆排序：
 * 记录用户在 `⌘K` 命令面板中真实选中的工作区视图、动作、会话或主题，下次打开时将高频常用项自动提权置顶。
 */

export interface CommandUsageEntry {
  id: string;
  count: number;
  lastUsedAt: number;
}

export const COMMAND_PALETTE_USAGE_KEY = 'workspace-command-palette-usage:v1';
const MAX_TRACKED_COMMAND_ITEMS = 60;

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readCommandUsageList(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): CommandUsageEntry[] {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(COMMAND_PALETTE_USAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: CommandUsageEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const count = typeof item.count === 'number' && Number.isFinite(item.count) ? Math.max(1, Math.floor(item.count)) : 0;
      const lastUsedAt = typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : 0;
      if (!id || count <= 0 || lastUsedAt <= 0) continue;
      out.push({ id, count, lastUsedAt });
      if (out.length >= MAX_TRACKED_COMMAND_ITEMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function writeCommandUsageList(
  entries: readonly CommandUsageEntry[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(
      COMMAND_PALETTE_USAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_TRACKED_COMMAND_ITEMS)),
    );
  } catch {
    /* localStorage 受限时仅在内存生效 */
  }
}

export function recordCommandUsageEntry(
  current: readonly CommandUsageEntry[],
  id: string,
  nowMs = Date.now(),
): CommandUsageEntry[] {
  const trimmed = id.trim();
  if (!trimmed) return [...current];
  const existing = current.find(item => item.id === trimmed);
  const updated: CommandUsageEntry = {
    id: trimmed,
    count: (existing?.count || 0) + 1,
    lastUsedAt: nowMs,
  };
  return [
    updated,
    ...current.filter(item => item.id !== trimmed),
  ].slice(0, MAX_TRACKED_COMMAND_ITEMS);
}

export function computeCommandFrecencyBoost(
  entry: CommandUsageEntry | undefined,
  nowMs = Date.now(),
): number {
  if (!entry) return 0;
  const freqScore = Math.min(entry.count, 10) * 5;
  const ageMs = Math.max(0, nowMs - entry.lastUsedAt);
  const hourMs = 60 * 60 * 1000;
  const recencyScore =
    ageMs <= hourMs ? 28
    : ageMs <= 24 * hourMs ? 18
    : ageMs <= 7 * 24 * hourMs ? 10
    : 4;
  return freqScore + recencyScore;
}

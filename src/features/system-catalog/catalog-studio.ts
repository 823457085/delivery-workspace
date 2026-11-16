export type CatalogEnvTier = 'prod' | 'stage' | 'test' | 'dev';

const PROD_ENV_RE = /(生产|正式|线上|\bprod\b|\bproduction\b|\blive\b)/i;
const STAGE_ENV_RE = /(预发|预发布|灰度|准生产|\bpre\b|\bstage\b|\bstaging\b|\buat\b)/i;
const TEST_ENV_RE = /(测试|多语言|联调|集成|\btest\b|\bqa\b|\bsit\b|\bfat\b)/i;

/**
 * Classifies an environment label into semantic tiers (Backstage / Homepage badge style).
 */
export function classifyEnvironmentTier(name: string): CatalogEnvTier {
  const text = (name || '').trim();
  if (PROD_ENV_RE.test(text)) return 'prod';
  if (STAGE_ENV_RE.test(text)) return 'stage';
  if (TEST_ENV_RE.test(text)) return 'test';
  return 'dev';
}

export function environmentTierLabel(tier: CatalogEnvTier): string {
  if (tier === 'prod') return 'PROD';
  if (tier === 'stage') return 'STAGE';
  if (tier === 'test') return 'TEST';
  return 'DEV';
}

/**
 * Extracts a clean hostname (and non-default port) from a URL string without throwing.
 */
export function extractUrlHost(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.host;
  } catch {
    return '';
  }
}

/**
 * Places pinned systems first while preserving stable original ordering within each group.
 */
export function sortSystemsWithPins<T extends { id: string }>(systems: readonly T[], pinnedIds: Iterable<string>): T[] {
  const pinned = new Set(pinnedIds);
  if (!pinned.size) return [...systems];
  const top: T[] = [];
  const rest: T[] = [];
  for (const item of systems) {
    if (pinned.has(item.id)) top.push(item);
    else rest.push(item);
  }
  return [...top, ...rest];
}

/**
 * Summarizes top environment names with frequencies for quick filter pills.
 */
export function countTopEnvironments(environments: readonly { name: string }[], limit = 6): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const env of environments) {
    const name = (env.name || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, Math.max(1, limit));
}

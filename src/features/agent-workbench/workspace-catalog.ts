import type { LocalProject, ProjectsData } from '../../../shared/hub';

export interface AgentWorkspaceOption {
  path: string;
  label: string;
  branch: string;
  folder?: string;
  repository?: string;
  source?: 'project' | 'recent' | 'custom';
}

function isTaskClonePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /\/\.data\//.test(normalized)
    || /-\d{8}(?:-\d{6})?(?:-tasks)?(?:\/|$)/i.test(normalized)
    || /\/outputs\//i.test(normalized);
}

function scorePrimaryCheckout(item: LocalProject): number {
  let score = 0;
  if (!isTaskClonePath(item.path)) score += 100;
  if (['develop', 'master', 'main'].includes(item.branch)) score += 30;
  if (item.clean) score += 10;
  score -= item.path.split('/').filter(Boolean).length;
  return score;
}

export function workspacePathLabel(rawPath: string): string {
  const parts = rawPath.replaceAll('\\', '/').split('/').filter(Boolean);
  const executorIndex = parts.findIndex((part, index) => part === '.data' && parts[index + 1] === 'design-executor');
  const leaf = parts.at(-1) || rawPath;
  if (executorIndex > 0) return `${parts[executorIndex - 1]} / design-executor`;
  if (['admin', 'delivery-admin'].includes(leaf.toLowerCase()) && parts.length >= 2) return `${parts.at(-2)} / ${leaf}`;
  return leaf;
}

export function buildWorkspaceCatalog(input: {
  projectsData?: ProjectsData;
  recent?: { path: string; branch?: string; label?: string }[];
  selectedPaths?: string[];
}): AgentWorkspaceOption[] {
  const map = new Map<string, AgentWorkspaceOption>();
  const projects = input.projectsData?.projects || [];

  const byGroup = new Map<string, LocalProject[]>();
  for (const item of projects) {
    if (!item.path) continue;
    const key = item.projectId || item.path;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(item);
  }

  for (const group of byGroup.values()) {
    const sorted = [...group].sort((a, b) => scorePrimaryCheckout(b) - scorePrimaryCheckout(a) || a.path.localeCompare(b.path));
    const primary = sorted[0];
    if (!primary) continue;
    const label = primary.displayName?.trim() || primary.suggestedDisplayName?.trim() || primary.projectName?.trim() || workspacePathLabel(primary.path);
    const folder = primary.folderName || primary.path.split('/').filter(Boolean).at(-1) || '';
    map.set(primary.path, {
      path: primary.path,
      label,
      branch: primary.branch || '',
      folder: folder !== label ? folder : undefined,
      repository: primary.repository || undefined,
      source: 'project',
    });
    for (const extra of sorted.slice(1)) {
      if (isTaskClonePath(extra.path) && !input.selectedPaths?.includes(extra.path)) continue;
      if (map.has(extra.path)) continue;
      const extraFolder = extra.folderName || extra.path.split('/').filter(Boolean).at(-1) || '';
      map.set(extra.path, {
        path: extra.path,
        label: `${label} · ${extraFolder}`,
        branch: extra.branch || '',
        folder: extraFolder,
        repository: extra.repository || undefined,
        source: 'project',
      });
    }
  }

  for (const item of input.recent || []) {
    const path = item.path?.trim();
    if (!path || map.has(path)) continue;
    const match = projects.find(p => p.path === path);
    const label = match?.displayName?.trim() || item.label?.trim() || workspacePathLabel(path);
    const folder = path.split('/').filter(Boolean).at(-1) || '';
    map.set(path, {
      path,
      label,
      branch: match?.branch || item.branch || '',
      folder: folder !== label ? folder : undefined,
      source: 'recent',
    });
  }

  for (const rawPath of input.selectedPaths || []) {
    const path = rawPath?.trim();
    if (!path || map.has(path)) continue;
    const match = projects.find(p => p.path === path);
    const label = match?.displayName?.trim() || workspacePathLabel(path);
    const folder = path.split('/').filter(Boolean).at(-1) || '';
    map.set(path, {
      path,
      label,
      branch: match?.branch || '',
      folder: folder !== label ? folder : undefined,
      source: 'custom',
    });
  }

  return [...map.values()];
}

import type { GroupRoomSummary } from '../../../shared/agent-group-chat.js';
import type { LocalProject, ProjectsData } from '../../../shared/hub.js';
import { workspacePathLabel } from './workspace-catalog.js';

export const GROUP_SIDEBAR_STORAGE_KEY = 'delivery-workspace.group-sidebar.v1';
export interface GroupSidebarPreferences { pinnedIds: Set<string>; collapsedIds: Set<string> }
export interface GroupRoomSection { id: string; label: string; path: string; pinned: boolean; rooms: GroupRoomSummary[] }

const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim();
const emptyPreferences = (): GroupSidebarPreferences => ({ pinnedIds: new Set(), collapsedIds: new Set() });

export function readGroupSidebarPreferences(storage: Pick<Storage, 'getItem'>): GroupSidebarPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(GROUP_SIDEBAR_STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPreferences();
    const data = value as Record<string, unknown>;
    return { pinnedIds: new Set(Array.isArray(data.pinnedIds) ? data.pinnedIds.filter(validId) : []),
      collapsedIds: new Set(Array.isArray(data.collapsedIds) ? data.collapsedIds.filter(validId) : []) };
  } catch { return emptyPreferences(); }
}

export function saveGroupSidebarPreferences(storage: Pick<Storage, 'setItem'>,
  preferences: { pinnedIds: ReadonlySet<string>; collapsedIds: ReadonlySet<string> }): boolean {
  try {
    storage.setItem(GROUP_SIDEBAR_STORAGE_KEY, JSON.stringify({ pinnedIds: [...preferences.pinnedIds].filter(validId),
      collapsedIds: [...preferences.collapsedIds].filter(validId) }));
    return true;
  } catch { return false; }
}

// Normalize spelling only; do not infer repository roots, worktree parents or symlink targets.
function normalizedPath(value: string): string {
  const path = value.trim().replaceAll('\\', '/');
  if (/^\/+$/u.test(path)) return '/';
  if (/^[A-Za-z]:\/+$/u.test(path)) return path.slice(0, 2) + '/';
  return path.replace(/\/+$/u, '');
}
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function compareRooms(left: GroupRoomSummary, right: GroupRoomSummary): number {
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return time(right.updatedAt) - time(left.updatedAt) || compareText(left.id, right.id);
}
type WorkspaceGroup = Pick<GroupRoomSection, 'id' | 'label' | 'path'>;

export function groupRoomSections(rooms: GroupRoomSummary[], pinnedIds: ReadonlySet<string>, projects?: ProjectsData): GroupRoomSection[] {
  const byPath = new Map<string, LocalProject[]>(), byProject = new Map<string, LocalProject[]>();
  for (const project of projects?.projects || []) {
    const path = normalizedPath(project.path);
    if (!path) continue;
    byPath.set(path, [...(byPath.get(path) || []), project]);
    if (project.projectId) byProject.set(project.projectId, [...(byProject.get(project.projectId) || []), project]);
  }
  const identities = new Map<string, WorkspaceGroup>();
  for (const [id, checkouts] of byProject) {
    const ordered = [...checkouts].sort((a, b) => compareText(normalizedPath(a.path), normalizedPath(b.path)));
    const first = (field: 'displayName' | 'suggestedDisplayName' | 'projectName') => ordered.map(item => item[field]?.trim()).find(Boolean);
    const path = normalizedPath(ordered[0].path);
    identities.set(id, { id: `project:${id}`, label: first('displayName') || first('suggestedDisplayName') || first('projectName') || workspacePathLabel(path), path });
  }
  function workspace(path: string): WorkspaceGroup {
    const projectIds = [...new Set((byPath.get(path) || []).map(item => item.projectId).filter(Boolean))];
    if (projectIds.length === 1) return identities.get(projectIds[0])!;
    return { id: `workspace:${path}`, label: workspacePathLabel(path), path };
  }
  const sections = new Map<string, GroupRoomSection>();
  for (const room of [...rooms].sort(compareRooms)) {
    let group: WorkspaceGroup;
    const pinned = pinnedIds.has(room.id);
    if (pinned) group = { id: 'pinned', label: '置顶', path: '' };
    else {
      const multiple = (room.workspacePaths || []).map(normalizedPath).filter(Boolean);
      const paths = [...new Set(multiple.length ? multiple : [normalizedPath(room.workspacePath)].filter(Boolean))];
      const workspaces = [...new Map(paths.map(path => { const item = workspace(path); return [item.id, item] as const; })).values()]
        .sort((a, b) => compareText(a.id, b.id));
      group = workspaces.length > 1
        ? { id: `projects:${JSON.stringify(workspaces.map(item => item.id))}`, label: workspaces.map(item => item.label).join(' + '), path: workspaces.map(item => item.path).join('\n') }
        : workspaces[0] || { id: 'unassigned', label: '未指定工作区', path: '' };
    }
    let section = sections.get(group.id);
    if (!section) { section = { ...group, pinned, rooms: [] }; sections.set(group.id, section); }
    section.rooms.push(room);
  }
  return [...sections.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || compareRooms(a.rooms[0], b.rooms[0]) || compareText(a.id, b.id));
}

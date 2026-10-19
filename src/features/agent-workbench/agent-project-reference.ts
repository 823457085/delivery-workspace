import type { LocalProject } from '../../../shared/hub';

export function normalizeWorkspacePath(value = '') {
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}

/** 仓库 ID 可被多个 worktree 共用，路径引用才指向用户选中的工作区。 */
export function projectWorkspaceReference(project: Pick<LocalProject, 'projectId' | 'path' | 'branch'>) {
  return `@项目:${project.projectId} @工作区:${encodeURIComponent(normalizeWorkspacePath(project.path))} ${JSON.stringify({ workspacePath: project.path, branch: project.branch })}`;
}

export function workspacePathFromReference(value: string) {
  try { return normalizeWorkspacePath(decodeURIComponent(value)); }
  catch { return undefined; }
}

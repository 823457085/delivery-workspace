export interface WorkspaceBuild {
  id: string;
  builtAt: string;
  backendSourceHash: string;
  development: boolean;
}

export interface WorkspaceVersion {
  frontend: WorkspaceBuild | null;
  backend: { sourceHash: string; startedAt: string };
}

export function isWorkspaceBuild(value: unknown): value is WorkspaceBuild {
  if (!value || typeof value !== 'object') return false;
  const build = value as Record<string, unknown>;
  return typeof build.id === 'string' && /^[a-z0-9-]{8,64}$/.test(build.id)
    && typeof build.builtAt === 'string' && Number.isFinite(Date.parse(build.builtAt))
    && typeof build.backendSourceHash === 'string' && /^[a-f0-9]{64}$/.test(build.backendSourceHash)
    && typeof build.development === 'boolean';
}

export function isWorkspaceVersion(value: unknown): value is WorkspaceVersion {
  if (!value || typeof value !== 'object') return false;
  const version = value as Record<string, unknown>;
  const backend = version.backend as Record<string, unknown> | undefined;
  return (version.frontend === null || isWorkspaceBuild(version.frontend)) && !!backend
    && typeof backend.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(backend.sourceHash)
    && typeof backend.startedAt === 'string' && Number.isFinite(Date.parse(backend.startedAt));
}

export function workspaceVersionState(loaded: WorkspaceBuild, current?: WorkspaceVersion) {
  const refreshRequired = !!current?.frontend && loaded.id !== current.frontend.id && !loaded.development;
  const restartRequired = !!current?.frontend && current.backend.sourceHash !== current.frontend.backendSourceHash && !loaded.development;
  const status = loaded.development ? 'development' : !current?.frontend ? 'unavailable'
    : restartRequired ? 'restart-required' : refreshRequired ? 'refresh-required' : 'current';
  const labels = { development: '开发模式', unavailable: '版本待核验', 'restart-required': '后端待重启',
    'refresh-required': '页面待刷新', current: '版本一致' } as const;
  return { status, label: labels[status], refreshRequired, restartRequired };
}

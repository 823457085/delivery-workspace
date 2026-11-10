export interface WorkspaceBuild {
  id: string;
  builtAt: string;
  backendSourceHash: string;
  buildSourceHash?: string;
  development: boolean;
}

export interface WorkspaceVersion {
  frontend: WorkspaceBuild | null;
  buildError?: string;
  diskBuildSourceHash?: string;
  // diskSourceHash：磁盘当前源码摘要，用于区分“后端未重启”与“后端已更新但页面构建过旧”。
  backend: { sourceHash: string; startedAt: string; diskSourceHash?: string };
}

export function isWorkspaceBuild(value: unknown): value is WorkspaceBuild {
  if (!value || typeof value !== 'object') return false;
  const build = value as Record<string, unknown>;
  return typeof build.id === 'string' && /^[a-z0-9-]{8,64}$/.test(build.id)
    && typeof build.builtAt === 'string' && Number.isFinite(Date.parse(build.builtAt))
    && typeof build.backendSourceHash === 'string' && /^[a-f0-9]{64}$/.test(build.backendSourceHash)
    && (build.buildSourceHash === undefined || typeof build.buildSourceHash === 'string' && /^[a-f0-9]{64}$/.test(build.buildSourceHash))
    && typeof build.development === 'boolean';
}

export function isWorkspaceVersion(value: unknown): value is WorkspaceVersion {
  if (!value || typeof value !== 'object') return false;
  const version = value as Record<string, unknown>;
  const backend = version.backend as Record<string, unknown> | undefined;
  return (version.frontend === null || isWorkspaceBuild(version.frontend)) && !!backend
    && (version.buildError === undefined || typeof version.buildError === 'string')
    && (version.diskBuildSourceHash === undefined || typeof version.diskBuildSourceHash === 'string' && /^[a-f0-9]{64}$/.test(version.diskBuildSourceHash))
    && typeof backend.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(backend.sourceHash)
    && typeof backend.startedAt === 'string' && Number.isFinite(Date.parse(backend.startedAt))
    && (backend.diskSourceHash === undefined || typeof backend.diskSourceHash === 'string' && /^[a-f0-9]{64}$/.test(backend.diskSourceHash));
}

export function workspaceVersionState(loaded: WorkspaceBuild, current?: WorkspaceVersion) {
  const refreshRequired = !!current?.frontend && loaded.id !== current.frontend.id && !loaded.development;
  const mismatch = !!current?.frontend && current.backend.sourceHash !== current.frontend.backendSourceHash && !loaded.development;
  // 启动时自动构建；失败或旧服务留下的构建差异可通过重启重试。
  const staleInputs = !!current?.frontend?.buildSourceHash && !!current.diskBuildSourceHash
    && current.frontend.buildSourceHash !== current.diskBuildSourceHash;
  const buildRequired = !loaded.development && (!!current?.buildError || staleInputs
    || mismatch && current!.backend.diskSourceHash === current!.backend.sourceHash);
  const restartRequired = mismatch && !buildRequired;
  const status = loaded.development ? 'development' : current?.buildError ? 'build-failed' : !current?.frontend ? 'unavailable'
    : restartRequired ? 'restart-required' : buildRequired ? 'build-required' : refreshRequired ? 'refresh-required' : 'current';
  const labels = { development: '开发模式', unavailable: '版本待核验', 'restart-required': '后端待重启',
    'build-required': '页面待更新', 'build-failed': '自动构建失败', 'refresh-required': '页面待刷新', current: '版本一致' } as const;
  return { status, label: labels[status], refreshRequired, restartRequired, buildRequired };
}

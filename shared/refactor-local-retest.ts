/** 本地复测绑定所选引用的提交；源码目录、隔离工作区与实际服务分别记录。 */
export interface RefactorBranchSource {
  workspacePath: string; name: string; moduleIds: string[]; current: string;
  branches: { ref: string; name: string; head: string }[];
  error?: string;
}
export interface RefactorLocalPlan {
  sourceWorkspacePath: string; repositoryPath: string; relativePath: string;
  ref: string; branch: string; head: string;
  packageManager: 'pnpm' | 'npm' | 'yarn'; startScript: string; script: string;
}
export interface RefactorLocalRuntime extends RefactorLocalPlan {
  workspacePath: string; baseUrl: string; pid: number; port: number; startedAt: string;
  state: 'running' | 'stopped';
}

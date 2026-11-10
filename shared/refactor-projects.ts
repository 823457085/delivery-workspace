export type RefactorProjectRole = 'shell' | 'micro-app' | 'legacy' | 'service';
export interface RefactorProject {
  id: string;
  name: string;
  role: RefactorProjectRole;
  workspacePath: string;
  baseUrl: string;
  packageManager: 'pnpm' | 'npm' | 'yarn';
  startScript: string;
  dependencies: string[];
}
export interface RefactorProjectStatus extends RefactorProject {
  branch: string;
  head: string;
  dirty: boolean;
  state: 'running' | 'stopped' | 'conflict' | 'starting' | 'failed';
  message: string;
  ports: number[];
  scripts: string[];
  pids: number[];
}
export interface RefactorProjectDashboard {
  revision: string;
  projects: RefactorProjectStatus[];
  /** 仅为用户可选择的本机发现结果，不会自动保存或启动。 */
  suggestions?: RefactorProject[];
}

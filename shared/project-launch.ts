export const projectEnvironments = ['dev', 'test', 'i18n-test', 'pre', 'prod'] as const;
export type ProjectEnvironment = (typeof projectEnvironments)[number];
export type LaunchConfig = {
  id: string;
  name: string;
  script: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  port: number;
  protocol: 'http' | 'https';
};
export type LaunchStatus = {
  configId: string;
  state: 'stopped' | 'running' | 'conflict' | 'starting' | 'failed';
  message: string;
  url?: string;
  managed?: boolean;
  port?: number;
};
export type LaunchSnapshot = {
  workspacePath: string;
  revision: number;
  packageManager: LaunchConfig['packageManager'];
  scripts: string[];
  configs: LaunchConfig[];
  statuses: LaunchStatus[];
  commands: ProjectCommand[];
  executions: ProjectExecution[];
  discoveryMessage?: string;
  detectedConfigs?: LaunchConfig[];
};

export type ProjectCommandKind = 'install' | 'run' | 'build' | 'test' | 'check';
export type ProjectCommand = {
  id: string;
  kind: ProjectCommandKind;
  name: string;
  command: string;
  fingerprint: string;
  script?: string;
  configId?: string;
  environment?: ProjectEnvironment;
};
export type ProjectExecution = {
  id: string;
  commandId: string;
  kind: ProjectCommandKind;
  name: string;
  command: string;
  configId?: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  message: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  logs: string;
  logTruncated?: boolean;
};

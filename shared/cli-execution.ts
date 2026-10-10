export interface CliExecutionState {
  status: 'paused' | 'running' | 'draining' | 'blocked';
  enabled: boolean; binary: string; version: string; codexHome: string;
  authenticated: boolean; error: string; maxConcurrent: number;
  runs: { jobId: string; threadId: string; workspacePath: string; pid: number; phase: string }[];
}

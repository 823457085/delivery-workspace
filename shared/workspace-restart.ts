export interface WorkspaceRestartState {
  status: 'idle' | 'building' | 'waiting' | 'restarting' | 'failed' | 'unavailable';
  message: string;
  startedAt: string;
}

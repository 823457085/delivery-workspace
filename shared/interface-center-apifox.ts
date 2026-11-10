export interface ApifoxAccount { id: string; name: string }
export interface ApifoxTeam { id: string; name: string }
export interface ApifoxProject { id: string; name: string; description: string; teamId: string }
export interface ApifoxConnection {
  configured: boolean; account?: ApifoxAccount; teams: ApifoxTeam[];
  preferredTeamId?: string; checkedAt?: string;
}
export type ApifoxSyncMode = 'keep' | 'overwrite';
export interface ApifoxSyncPreview {
  id: string; localProjectId: string; localProjectName: string; teamId: string;
  targetProject: ApifoxProject; mode: ApifoxSyncMode; operationCount: number;
  added: number; matched: number; remoteOnly: number; expiresAt: string;
  unusedRequestBodyRefs?: number;
}
export interface ApifoxSyncResult {
  projectId: string; projectUrl: string; syncedAt: string;
  counters: Record<string, number>; verified: boolean; missing: number; message: string;
}

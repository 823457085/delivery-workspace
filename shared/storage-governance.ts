import { z } from 'zod';

export type WorkspaceStorageBucketId =
  | 'artifactBloat'
  | 'verificationWorktrees'
  | 'orphanWorkspaces'
  | 'finishedTeamDependencies'
  | 'browserAndRetestCaches';

export interface WorkspaceStorageBucket {
  id: WorkspaceStorageBucketId;
  label: string;
  description: string;
  totalBytes: number;
  reclaimableBytes: number;
  itemCount: number;
  reclaimableCount: number;
}

export interface WorkspaceLedgerFootprint {
  name: string;
  bytes: number;
}

export interface WorkspaceStorageReport {
  scannedAt: string;
  totalBytes: number;
  reclaimableBytes: number;
  buckets: WorkspaceStorageBucket[];
  ledgers: WorkspaceLedgerFootprint[];
}

export const workspaceStorageReclaimInputSchema = z.object({
  artifactBloat: z.boolean().default(true),
  verificationWorktrees: z.boolean().default(true),
  orphanWorkspaces: z.boolean().default(true),
  finishedTeamDependencies: z.boolean().default(true),
  browserAndRetestCaches: z.boolean().default(true),
  minAgeHours: z.number().int().min(0).max(720).default(24),
}).strict();

export type WorkspaceStorageReclaimInput = z.infer<typeof workspaceStorageReclaimInputSchema>;

export interface WorkspaceStorageReclaimResult {
  reclaimedAt: string;
  reclaimedBytes: number;
  reclaimedItems: number;
  message: string;
  report: WorkspaceStorageReport;
}

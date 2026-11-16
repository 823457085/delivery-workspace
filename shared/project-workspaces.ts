import { z } from 'zod';

const workspacePath = z.string().trim().min(1).max(2000);
export const workspaceRemovalInputSchema = z.object({ path: workspacePath,
  revision: z.string().min(1).max(200), confirmName: z.string().min(1).max(255),
  discardChanges: z.literal(true).optional(), sessionWorktree: z.literal(true).optional() }).strict();
export const workspaceScheduleInputSchema = z.object({ path: workspacePath,
  revision: z.string().max(200), deleteAt: z.string().datetime({ offset: true }).nullable(),
  confirmName: z.string().max(255).optional() }).strict();

export const workspaceRestoreInputSchema = z.object({
  id: z.string().trim().min(1).max(120),
}).strict();

export interface WorkspaceTrashItem {
  id: string;
  originalPath: string;
  name: string;
  linked: boolean;
  deletedAt: string;
  expiresAt: string;
  ignoredFiles: string[];
  restorable: boolean;
}

export interface WorkspaceCleanupRule {
  path: string;
  deleteAt: string;
  status: 'scheduled' | 'blocked' | 'deleted';
  message?: string;
  checkedAt?: string;
}

export interface SessionWorkspaceReference {
  id: string;
  title: string;
  workspacePath: string;
  updatedAt: string;
}

export interface SessionWorkspaceUsage {
  path: string;
  branch: string;
  bytes: number | null;
  sessions: Pick<SessionWorkspaceReference, 'id' | 'title' | 'updatedAt'>[];
  eligible: boolean;
  reason?: string;
}

export interface WorkspaceRemovalPreview {
  path: string;
  revision: string;
  eligible: boolean;
  requiresDiscardChanges?: true;
  canSchedule: boolean;
  reason?: string;
  ignoredFiles?: string[];
  sensitiveIgnoredFiles?: string[];
  rule?: WorkspaceCleanupRule;
}

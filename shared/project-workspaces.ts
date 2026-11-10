import { z } from 'zod';

const workspacePath = z.string().trim().min(1).max(2000);
export const workspaceRemovalInputSchema = z.object({ path: workspacePath,
  revision: z.string().min(1).max(200), confirmName: z.string().min(1).max(255), discardChanges: z.literal(true).optional() }).strict();
export const workspaceScheduleInputSchema = z.object({ path: workspacePath,
  revision: z.string().max(200), deleteAt: z.string().datetime({ offset: true }).nullable(),
  confirmName: z.string().max(255).optional() }).strict();

export interface WorkspaceCleanupRule {
  path: string;
  deleteAt: string;
  status: 'scheduled' | 'blocked' | 'deleted';
  message?: string;
  checkedAt?: string;
}

export interface WorkspaceRemovalPreview {
  path: string;
  revision: string;
  eligible: boolean;
  requiresDiscardChanges?: true;
  canSchedule: boolean;
  reason?: string;
  rule?: WorkspaceCleanupRule;
}

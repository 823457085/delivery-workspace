/** Named conversation groups; projectPaths are source projects, not runtime worktrees. */
export type ConversationWorkspace = { id: string; name: string; projectPaths: string[]; projectBranches?: Record<string, string[]> };
export type ConversationWorkspaceState = { revision: number; workspaces: ConversationWorkspace[]; assignments: Record<string, string>; deletedWorkspaceIds?: string[] };

export interface GitFileItem {
  status: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  originalPath?: string;
}

export interface GitBranchItem {
  ref: string;
  name: string;
  remote: boolean;
  sha: string;
  upstream: string;
  current: boolean;
  localBranch?: string;
  multipleTrackingBranches?: boolean;
  worktreePaths: string[];
  switchBlockedReason: string;
}

export interface GitRemoteItem {
  name: string;
  url: string;
  pushUrl: string;
  pushUrls: string[];
  host: string;
  provider: string;
  webUrl: string;
}

export interface GitCommitItem {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitSnapshot {
  available: boolean;
  isGit: boolean;
  directory: string;
  branch: string;
  head: string;
  upstream: string;
  ahead: number | null;
  behind: number | null;
  checkedAt: string;
  counts: {
    total: number;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
  };
  clean: boolean;
  files: GitFileItem[];
  truncated: boolean;
  branches: GitBranchItem[];
  remotes: GitRemoteItem[];
  mergeInProgress: boolean;
  log: GitCommitItem[];
  revision: string;
}

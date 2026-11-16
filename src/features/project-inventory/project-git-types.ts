import type { DiffHygieneWarning } from '../../../shared/diff-review-hygiene';
export type { WorktreeConflictRadarReport, WorktreeSiblingRadarItem } from '../../../shared/worktree-radar';
export type { DeliveryReadinessScorecard, ReadinessGateItem, ReadinessRiskFactor } from '../../../shared/delivery-readiness-scorecard';

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

export interface GitCommitFileStat {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCommitDetail {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: GitCommitFileStat[];
  filesTruncated: boolean;
  patch: string;
  patchTruncated: boolean;
}

export interface GitStashItem {
  ref: string;
  index: number;
  sha: string;
  branch: string;
  subject: string;
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
  sequencerState?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  stashes?: GitStashItem[];
  log: GitCommitItem[];
  revision: string;
}

export interface GitCommitAssist {
  scope: 'staged' | 'unstaged' | 'clean';
  fileCount: number;
  suggestedSubject: string;
  suggestedBody: string;
  suggestedMessage: string;
  hygieneWarnings: DiffHygieneWarning[];
  triage?: {
    sourceFiles: number;
    testFiles: number;
    generatedFiles: number;
    missingTestsWarning: boolean;
    largeDiffTriggered: boolean;
    risks: {
      category: string;
      label: string;
      severity: 'high' | 'medium';
      file: string;
      line: number | null;
      reason: string;
    }[];
  };
}

export interface JiraIssue {
  key: string; url: string; summary: string; description?: string; status: string; statusCategory: string;
  issueType: string; priority: string; project: string; projectName: string; assignee: string; reporter?: string;
  fixVersions: string[]; created: string; updated: string; dueDate: string | null; startDate: string | null;
  endDate: string | null; resolutionDate: string | null;
  parent: { key: string; summary?: string } | null;
  subtasks: { key: string; summary?: string; status: string; statusCategory: string }[];
}
export interface IssueResponse { source: string; baseUrl: string; jql: string; total: number; issues: JiraIssue[]; warning?: string }
export interface Job {
  parentKey?: string;
  id: string; issueKey: string; issueUrl: string; title: string; category: string; categoryLabel: string;
  model: string; status: string; createdAt: string; updatedAt: string; attempts: number; prompt?: string;
  workspacePath: string; branch: string; threadId: string; clientThreadId?: string;
  result?: string; error?: string; mrUrl?: string; artifactUrl?: string;
  coverage?: string; tests?: string; i18n?: string; i18nXlsxPath?: string; selfTestReportPath?: string;
  selfTestScreenshots?: string[]; workspaceEvidence?: { label: string; state: string; codePresent: boolean; alreadyDone: boolean };
}
export interface PlanItem {
  issue: JiraIssue; jobId: string; category: string; categoryLabel: string; model: string;
  action: string; dispatchable: boolean; dependencyKeys: string[]; childKeys: string[];
  jobStatus: string; localAlreadyDone: boolean; targetBranch: string;
  workspace: { path: string; displayPath: string; branch: string } | null;
  workspaceEvidence?: { label: string; state: string };
}
export interface ScanRun {
  id: string; trigger: string; source: string; localDate: string; startedAt: string; completedAt: string;
  issueCount: number; workspaceCount: number; dispatchableCount?: number; enqueuedCount: number; alreadyDoneCount: number;
  transitionUpdatedCount: number; transitionBlockedCount: number;
  transitionResults?: { issueKey: string; reason: string; message?: string; status?: string }[];
}
export interface AutomationSettings {
  enabled: boolean; dailyTime: string; dailyTimes: string[]; maxDispatchPerRun: number;
  autoCreateCodex: boolean; autoTransitionJira: boolean; autoCreateMergeRequest: boolean;
  startStatus: string; completedStatus: string; targetBranch: string; reviewer: string;
  runtimeEnvironment?: string; runtimeCommand?: string; browser?: string; repositoryUrl?: string;
}
export interface WeeklyReportRun {
  id: string; trigger: string; scheduledSlot: string; status: 'completed' | 'failed'; source: string;
  generatedAt: string; rangeStart: string; rangeEnd: string; completedCount: number; inProgressCount: number;
  blockedCount: number; agentCompletedCount: number; maintenanceUpdatedCount: number; content: string; error: string;
}
export interface WeeklyReportData {
  settings: { enabled: boolean; weekday: number; time: string };
  runs: WeeklyReportRun[]; lastRun: WeeklyReportRun | null; lastScheduledSlot: string;
  nextRun: string | null; running: boolean;
}
export interface AutomationData {
  settings: AutomationSettings; jobs: Job[]; plan: PlanItem[]; runs: ScanRun[];
  lastRun: ScanRun | null; nextRun: string; running: boolean; weeklyReport: WeeklyReportData;
}
export interface CatchupRequirement {
  id: string; title: string; slug: string; goal: string; businessDomain: string; wave: string;
  nextAction: string; deliveryStatus: string; pageStatus: string; demoApiStatus: string; gap: string;
  acceptanceCriteria: { id: string; text: string; [key: string]: unknown }[];
  acceptanceCriteriaCount: number; workPackageCount: number; readinessGaps: string[]; deliveryFollowups: string[];
  execution: { status: string; exclusionReason: string; allowedActions: string[]; updatedAt: string; startedAt: string };
  session: { status: string; jiraKey: string; jiraUrl: string; threadId: string; clientThreadId?: string;
    branch: string; workspacePath: string; result: string; error: string; updatedAt: string };
  architecturePlacement?: Record<string, unknown>;
}
export interface CatchupData {
  source: { updatedAt: string; integrity: string }; counts: Record<string, number>; requirements: CatchupRequirement[];
  domains: string[]; waves: string[]; executionRevision: number; executionStatuses: Record<string, number>;
  dispatcher: { status: string; displayStatus: string; lastHeartbeatAt: string; maxConcurrent?: number };
  executionSemantics: { pause: string; finish: string };
}
export interface Screenshot { filename: string; caption: string; testCaseIds?: string[]; isAuthentication?: boolean }
export interface TestResult { tcId: string; status: string; evidence: string }
export interface AutomatedCheck { name: string; command: string; status: string; evidence: string }
export interface TestCase { id: string; title: string; priority: string; acIds: string[]; type: string; preconditions: string[]; steps: string[]; expected: string[] }
export interface MergeReviewException {
  reason: string; authorizedAt: string; authorizedRevision: number; sourceSha: string;
  sourceBranch: string; targetBranch: string; previousStatus: string; previousError: string;
}
export interface MergeItem {
  requirementId: string; title: string; jiraKey: string; jiraUrl: string; mrUrl: string; mrIid: number;
  order: number | null; status: string; gitStatus: string; merged: boolean; sourceBranch: string; sourceBranchUrl: string;
  sourceLocalSha: string; sourceRemoteSha: string; deliveryWorkspacePath: string; sessionWorkspacePath: string;
  functionSummary: string; testFocus: string; testPages: string[]; conflictArea: string; decisionNote: string; scopeReviewNote?: string;
  acceptanceCriteria: { id: string; text: string; url?: string }[]; executionScreenshots: Screenshot[];
  pipeline: { status: string; phase: string; result: string; error: string; attempts: number; updatedAt: string;
    queuedAt: string; startedAt: string; threadId: string; clientThreadId?: string;
    reviewException?: MergeReviewException | null; reviewExceptionHistory?: MergeReviewException[];
    evidence?: { sourceSha: string; targetSha: string; summary: string; completedAt: string; notes?: string[];
      automatedChecks?: AutomatedCheck[]; testResults?: TestResult[]; screenshots?: Screenshot[] } };
  reviewGate: { passed: boolean; evidenceComplete: boolean; passedTestCaseIds: string[]; skippedTestCaseIds: string[];
    failedTestCaseIds: string[]; missingTestCaseIds: string[]; screenshotCount: number; invalidScreenshotNames: string[] };
  testPlan: { scope: string; basis: string; preconditions: string[]; cases: TestCase[]; coverage: { acTotal: number; acCovered: number; p0Total: number; traceabilityPercent: number } };
  action: { enabled: boolean; action: string; label: string }; reviewRetryAction?: { enabled: boolean; action: string; label: string };
  directMergeAction?: { enabled: boolean; action: string; label: string };
}
export interface MergeData {
  source: { checkedAt: string; targetFresh: boolean; remoteChecked: boolean };
  target: { branch: string; localSha: string; remoteSha: string; url: string };
  summary: Record<string, number>; revision: number; items: MergeItem[]; mergeRules: string[];
  pipeline: { status: string; currentRequirementId: string; result: string; error: string; updatedAt: string };
}
export interface LocalProject {
  projectId: string; projectName: string; displayName: string; suggestedDisplayName: string; repository: string;
  path: string; displayPath: string; relativePath: string; rootPath: string; rootLabel: string; folderName: string;
  branch: string; upstream: string; clean: boolean; changed: number; staged: number; modified: number; untracked: number;
  detached: boolean; ahead: number; behind: number; webUrl: string; remoteUrl: string;
}
export interface ProjectsData { projects: LocalProject[]; roots: { path: string; label: string; exists: boolean }[]; directoryCount: number; durationMs: number; limited: boolean; unreadableCount: number; scannedAt?: string }
export interface MeetingTask { id: string; sourceText: string; dueText: string; [key: string]: unknown }
export interface MeetingData {
  localDate: string; scannedAt: string; schedule: string; sectionTitle: string;
  source: { pageId: string; title: string; url: string; version: number };
  assignee: { name: string }; todayTasks: MeetingTask[]; tomorrowTasks: MeetingTask[]; warnings: string[];
}

export type Scenario = 'standard' | 'missing-evidence' | 'merge-conflict';
export type RunStatus = 'running' | 'suspended' | 'success' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'suspended' | 'success' | 'failed';

export interface Requirement {
  id: string;
  title: string;
  jiraKey: string;
  issueUrl: string;
  sourceBranch: string;
  sourceSha: string;
  targetSha: string;
  sourceStatus: string;
  verificationMode: string;
  conflictArea: string;
  summary: string;
  error: string;
  criteria: { id: string; text: string }[];
  evidence: { passed: number; skipped: number; failed: number; missing: number; screenshots: number; gatePassed: boolean };
}

export interface SourceSnapshot {
  fetchedAt: string;
  revision: number;
  origin: 'live' | 'cache' | 'sample';
  targetBranch: string;
  requirements: Requirement[];
  message: string;
}

export interface WorkflowRunContext {
  conversationId: string;
  agentRunId: string;
  workspacePath: string;
  branch: string;
  provider: 'codex' | 'cursor';
}

export interface RunRecord {
  runId: string;
  requirement: Requirement;
  scenario: Scenario;
  createdAt: string;
  parentRunId?: string;
  context?: WorkflowRunContext;
}

export interface StepView {
  id: string;
  title: string;
  subtitle: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface DemoCheck { name: string; passed: boolean; detail: string }
export interface Gate { kind: 'evidence' | 'review' | 'conflict'; title: string; reason: string }

export interface RunView extends RunRecord {
  status: RunStatus;
  steps: StepView[];
  gate: Gate | null;
  analysis: string;
  analysisMode: 'rules' | 'llm';
  checks: DemoCheck[];
  result: string;
  error: string;
  updatedAt: string;
}

export interface Dashboard {
  revision: number;
  source: SourceSnapshot;
  runs: RunView[];
  engine: { name: string; version: string; storage: string; model: string | null };
}

export const WORKFLOW_STEPS = [
  { id: 'freeze-source', title: '冻结需求', subtitle: '固定本轮来源与基线' },
  { id: 'analyze-scope', title: '范围分析', subtitle: '梳理验收点与阻塞' },
  { id: 'verify-evidence', title: '证据预检', subtitle: '逐项检查与补测' },
  { id: 'human-review', title: '人工审核', subtitle: 'Mastra suspend / resume' },
  { id: 'merge-preview', title: '合入预演', subtitle: '演示顺利交付或冲突' },
  { id: 'delivery-receipt', title: '交付回执', subtitle: '保存本轮演示结果' },
] as const;

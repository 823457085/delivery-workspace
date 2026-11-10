import type { RefactorProjectStatus } from './refactor-projects.js';
import type { RefactorConclusion } from './refactor-control.js';

export type RefactorDocumentState = 'pending_test' | 'pending_retest' | 'passed' | 'blocked' | 'unclassified';
export const refactorDocumentStateLabels: Record<RefactorDocumentState, string> = {
  pending_test: '待测试', pending_retest: '待复测', passed: '历史通过', blocked: '暂缓 / 阻塞', unclassified: '待确认',
};
export interface RefactorDocumentResult {
  status: Exclude<RefactorConclusion, 'partial'>; actual: string; expected?: string; evidence: string[];
  environment: string; version: string; checkedAt: string; jobId: string;
}
export interface RefactorDocumentRow {
  id: string; sheet: number; sheetName: string; row: number; issueId: string; title: string;
  method: string; path: string; request: string; parameters: string; expected: string; actual: string;
  sourceStatus: string; reporter?: string; notes: string; state: RefactorDocumentState; latest?: RefactorDocumentResult;
}
export interface RefactorDocument {
  id: string; name: string; importedAt: string; sha256: string; imageCount: number; projectId: string;
  projectName: string; moduleId: string; rows: RefactorDocumentRow[]; warnings: string[];
  exportError?: string;
}
export interface RefactorWorkspaceDashboard {
  revision: string; documents: RefactorDocument[]; projects: RefactorProjectStatus[];
}

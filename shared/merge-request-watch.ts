export interface MergeRequestWatchStatus {
  provider: 'Codeup' | 'GitLab';
  url: string;
  id: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  headSha?: string;
  checks?: 'passed' | 'failed' | 'running';
  conflict?: boolean;
  review?: 'approved' | 'pending' | 'changes-requested';
}

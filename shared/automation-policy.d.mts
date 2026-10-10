import type { JiraIssue, Job } from './hub';

export function isJiraSubtask(issue?: {
  parent?: { key: string } | null;
  parentKey?: string;
  issueType?: string;
}): boolean;
export function automationSubtaskKeys(plan?: readonly { issue: Pick<JiraIssue, 'key' | 'parent' | 'issueType' | 'subtasks'> }[]): Set<string>;
export function isAutomationSubtaskJob(job: Pick<Job, 'issueKey' | 'parentKey'>, subtaskKeys: ReadonlySet<string>): boolean;

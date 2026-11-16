import type { JiraIssue } from '../../../shared/hub';
import { isDone, safeUrl } from '../../shared/format';

export type IssueStageId = 'todo' | 'active' | 'verify' | 'done';

export interface IssueKanbanColumn {
  id: IssueStageId;
  label: string;
  tone: 'neutral' | 'primary' | 'warning' | 'success';
  issues: JiraIssue[];
}

const VERIFY_RE = /(测试|验收|评审|审核|待测|review|qa|uat|verif|testing|staging)/i;
const ACTIVE_RE = /(进行|开发|处理中|修复中|实现|联调|in[\s_-]*progress|doing|active|coding|implement)/i;
const DONE_RE = /(完成|关闭|解决|已上线|已发布|取消|done|closed|resolved|released)/i;

/**
 * Maps heterogeneous Jira status labels / statusCategory into 4 Plane/Linear triage lanes.
 */
export function classifyIssueStage(issue: Pick<JiraIssue, 'status' | 'statusCategory'>): IssueStageId {
  if (isDone(issue as JiraIssue) || DONE_RE.test(issue.status || '')) return 'done';
  const status = (issue.status || '').trim();
  if (VERIFY_RE.test(status)) return 'verify';
  if (ACTIVE_RE.test(status) || (issue.statusCategory || '').toLowerCase() === 'indeterminate') return 'active';
  return 'todo';
}

export function buildIssueKanbanColumns(issues: JiraIssue[]): IssueKanbanColumn[] {
  const buckets: Record<IssueStageId, JiraIssue[]> = {
    todo: [],
    active: [],
    verify: [],
    done: [],
  };
  for (const item of issues) {
    buckets[classifyIssueStage(item)].push(item);
  }
  return [
    { id: 'todo', label: '待开始', tone: 'neutral', issues: buckets.todo },
    { id: 'active', label: '开发中', tone: 'primary', issues: buckets.active },
    { id: 'verify', label: '测试 / 验收', tone: 'warning', issues: buckets.verify },
    { id: 'done', label: '已完成', tone: 'success', issues: buckets.done },
  ];
}

const BUG_TYPE_RE = /(故障|缺陷|问题|线上问题|bug|defect|hotfix|incident)/i;

/**
 * Generates a clean conventional Git branch name from a Jira issue key & issueType.
 */
export function suggestIssueBranchName(key: string, issueType = ''): string {
  const cleanKey = (key || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleanKey) return '';
  const prefix = BUG_TYPE_RE.test(issueType) ? 'fix' : 'feat';
  return `${prefix}/${cleanKey}`;
}

/**
 * Formats a safe Markdown citation link for pasting into PR descriptions, Slack/WeCom, or docs.
 */
export function formatIssueMarkdownLink(issue: { key: string; summary?: string; url?: string }): string {
  const key = (issue.key || '').trim();
  const summary = (issue.summary || '').replace(/\s+/g, ' ').trim();
  const href = issue.url ? safeUrl(issue.url) : '';
  const head = href ? `[${key}](${href})` : key;
  return summary ? `${head} ${summary}` : head;
}

/**
 * Vim-style j/k focus stepping across visible issue keys with clamping.
 */
export function stepIssueSelection(keys: string[], currentKey: string, delta: 1 | -1): string {
  if (!keys.length) return '';
  const idx = keys.indexOf(currentKey);
  if (idx < 0) return delta > 0 ? keys[0]! : keys[keys.length - 1]!;
  const next = Math.min(keys.length - 1, Math.max(0, idx + delta));
  return keys[next]!;
}

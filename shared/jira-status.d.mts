export interface JiraStatusLike {
  status?: string | { key?: string; name?: string } | null;
  statusCategory?: string | { key?: string; name?: string } | null;
}

export function isJiraIssueDone(issue: JiraStatusLike | null | undefined): boolean;
export function isJiraIssueTodo(issue: JiraStatusLike | null | undefined): boolean;

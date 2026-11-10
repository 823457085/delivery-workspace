type Role = 'parent' | 'design' | 'implementation';
type TitleContext = { businessModule: string; subject: string; multiProject: boolean; repositoryNames: readonly string[] };
type Scope = { text: string; label: string };

export function requirementTitle(sourceIssue: { summary?: string; key?: string; description?: unknown }, details: string,
  businessModule: string, repositoryNames?: readonly string[]): TitleContext;
export function requirementSummary(role: Role, title: Pick<TitleContext, 'businessModule' | 'subject' | 'multiProject'>): string;
export function requirementScopes(details: string, description?: unknown): Scope[];
export function childScopeTitles(item: { role: Exclude<Role, 'parent'>; summary: string }, parts: readonly (readonly string[])[],
  scopes: readonly Scope[], title: TitleContext): { summary: string; scope: string }[];

export interface GitHubSettings { githubKind?: 'market' | 'plugin'; githubPath?: string; githubPolicy?: 'stable' | 'all' | 'pinned'; githubRef?: string; githubToken?: string }
export function githubRepository(value: string): { owner: string; repo: string; url: string };
export function githubOptions(input: GitHubSettings & { baseUrl?: string; location?: string }): { owner: string; repo: string; url: string; directory: string; kind: string; policy: string; ref: string };

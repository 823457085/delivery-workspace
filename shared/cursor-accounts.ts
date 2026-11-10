export const accountProviders = ['cursor', 'codex', 'claude'] as const;
export type AccountProvider = typeof accountProviders[number];
export const accountProviderLabels: Record<AccountProvider, string> = {
  cursor: 'Cursor', codex: 'Codex', claude: 'Claude Code',
};

/** 网页与服务端共用官方登录地址白名单，不接受任意跳转链接。 */
export function trustedAccountLoginUrl(provider: AccountProvider, value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return '';
  const targets: Record<AccountProvider, readonly string[]> = {
    cursor: ['https://cursor.com/loginDeepControl'],
    codex: ['https://auth.openai.com/oauth/authorize', 'https://auth.openai.com/codex/device'],
    claude: ['https://claude.com/cai/oauth/authorize', 'https://platform.claude.com/oauth/authorize',
      'https://claude.ai/oauth/authorize'],
  };
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.hash && targets[provider].includes(`${url.origin}${url.pathname}`)) return url.href;
  } catch { /* 不展示来源不匹配或格式错误的登录地址。 */ }
  return '';
}

export interface CursorAccountSummary {
  name: string;
  email: string;
  team: string;
  displayName?: string;
  identity?: string;
}

export interface CursorAccountCurrent {
  email: string;
  team: string;
  verified: boolean;
  displayName?: string;
  identity?: string;
}

export type CursorAccountAction = 'save' | 'login' | 'use' | 'restore' | 'delete';

export interface CursorAccountOperation {
  id: string;
  action: CursorAccountAction;
  name?: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  savedAccountName?: string;
  activation?: { status: 'succeeded' | 'failed'; message: string };
  desktop?: { status: 'opened' | 'failed' | 'skipped'; message: string };
  message: string;
  loginUrl?: string;
  loginCode?: string;
  startedAt: string;
  finishedAt?: string;
}

export const desktopAccountProviders = ['codex', 'cursor', 'claude', 'kiro', 'antigravity', 'workbuddy', 'grok'] as const;
export type DesktopAccountProvider = typeof desktopAccountProviders[number];
export interface DesktopAccountSnapshot {
  provider: DesktopAccountProvider;
  installed: boolean;
  status: 'recorded' | 'unknown' | 'not_installed' | 'unsupported';
  email?: string;
  identity?: string;
  message: string;
  checkedAt: string;
  canOpen: boolean;
  opened?: boolean;
}

export interface CursorAccountsDashboard {
  provider: AccountProvider;
  available: boolean;
  accounts: CursorAccountSummary[];
  current: CursorAccountCurrent | null;
  pendingRecovery: boolean;
  activePids: number[];
  blockedReason: string;
  operation: CursorAccountOperation | null;
  checkedAt: string;
}

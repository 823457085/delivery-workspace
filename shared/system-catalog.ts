export interface SystemSource {
  id: string;
  title: string;
  url: string;
  version: number;
}

export interface SystemAccountSummary {
  id: string;
  hasUsername: boolean;
  hasPassword: boolean;
  sourceUrl: string;
  origin: 'confluence' | 'local';
}

export interface SystemAccount extends SystemAccountSummary {
  username: string;
  password: string;
}

export interface SystemAccountsRead {
  accounts: SystemAccount[];
  revision: string;
}

export interface SystemAccountsSave {
  environmentId: string;
  accounts: { id?: string; username: string; password: string }[];
  expectedRevision?: string;
}

export interface SystemEnvironment {
  id: string;
  name: string;
  branch: string;
  url: string;
  sourceHref: string;
  pipeline: string;
  notes: string;
  accounts: SystemAccountSummary[];
}

export interface CatalogSystem {
  id: string;
  name: string;
  region: '海外' | '国内' | '其他';
  repository: string;
  source: SystemSource;
  environments: SystemEnvironment[];
}

export interface SystemCatalog {
  syncedAt: string;
  sources: SystemSource[];
  systems: CatalogSystem[];
  localSystems?: CatalogSystem[];
}

export const systemProjectRegions = ['海外', '国内', '其他'] as const;
export const systemProjectColumns = {
  name: '项目名称', region: '区域', environment: '环境', branch: '分支',
  url: '访问地址', repository: 'Git 仓库', notes: '备注',
} as const;
export interface SystemProjectRow {
  name: string;
  region: CatalogSystem['region'];
  environment: string;
  branch: string;
  url: string;
  repository: string;
  notes: string;
}
export interface SystemProjectPreview { rows: SystemProjectRow[]; added: number; skipped: number }
export interface SystemProjectSave { catalog: SystemCatalog; systemId: string; added: number; skipped: number }
export const systemProjectWorkbookLimit = 1024 * 1024;

// 同名仓库不能跨组织绑定；SSH/HTTPS 和 .git 后缀仅影响传输方式。
export function repositoryKey(value: string) {
  const ssh = value.match(/^(?:[^@\s]+@)?([^/:\s]+):([^\s]+)$/);
  try {
    const url = new URL(ssh && !value.includes('://') ? `https://${ssh[1]}/${ssh[2]}` : value);
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return '';
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`;
  } catch { return ''; }
}

export function systemWebUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

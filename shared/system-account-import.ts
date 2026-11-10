import { systemWebUrl, type CatalogSystem, type SystemAccount } from './system-catalog.js';

export interface BrowserAccount { url: string; username: string; password: string }
export interface BrowserAccountGroup {
  environmentId: string; systemName: string; environmentName: string; url: string; accounts: BrowserAccount[];
}
export interface ImportedAccountMerge {
  accounts: { id?: string; username: string; password: string }[];
  added: number; updated: number; skipped: number; conflicts: number;
}

const maxCsvBytes = 2 * 1024 * 1024;
const maxCsvRows = 10_000;
const malformedCsv = () => new Error('CSV 格式不正确，请使用 Chrome 密码管理器导出的 CSV 文件');
const accountLimit = () => new Error('每个环境最多保存 20 个账号，请减少导入数量后重试');

function checkAccountLength(account: { username: string; password: string }) {
  if (account.username.length > 500 || account.password.length > 2000) {
    throw new Error('账号或密码长度超出限制（账号最多 500 字符，密码最多 2000 字符）');
  }
}

/** Parse locally only: preserve credential characters, including quoted newlines and spaces. */
export function parseBrowserAccountCsv(text: string): BrowserAccount[] {
  if (text.length > maxCsvBytes || new TextEncoder().encode(text).byteLength > maxCsvBytes) {
    throw new Error('CSV 文件不能超过 2 MiB');
  }
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closedQuote = false;
  function endField() { row.push(field); field = ''; closedQuote = false; }
  function endRow() {
    const emptyLine = row.length === 0 && field === '' && !closedQuote;
    endField();
    if (!emptyLine) rows.push(row);
    if (rows.length > maxCsvRows + 1) throw new Error('CSV 最多导入 10000 行账号');
    row = [];
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ',') { endField(); continue; }
    if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && input[i + 1] === '\n') i++;
      continue;
    }
    if (closedQuote) throw malformedCsv();
    if (char === '"') {
      if (field) throw malformedCsv();
      quoted = true;
    } else field += char;
  }
  if (quoted) throw malformedCsv();
  if (field || row.length || closedQuote) endRow();
  if (!rows.length) throw malformedCsv();
  const headers = rows[0].map(value => value.trim().toLowerCase());
  const columns = ['url', 'username', 'password'].map(name => {
    if (headers.filter(header => header === name).length !== 1) {
      throw new Error('CSV 必须包含且仅包含一列 url、username、password，可同时包含 name、note 列');
    }
    return headers.indexOf(name);
  });
  const accounts: BrowserAccount[] = [];
  for (const values of rows.slice(1)) {
    if (values.length !== headers.length) throw malformedCsv();
    const [rawUrl, username, password] = columns.map(column => values[column]);
    checkAccountLength({ username, password });
    const url = systemWebUrl(rawUrl.trim());
    if (!url || !username.trim() || !password) continue;
    accounts.push({ url, username, password });
  }
  return accounts;
}

/** A saved login belongs only to one exact origin and one unambiguous overseas environment. */
export function matchBrowserAccounts(accounts: BrowserAccount[], systems: CatalogSystem[]) {
  type Target = { system: CatalogSystem; environment: CatalogSystem['environments'][number] };
  const targets = new Map<string, Target[]>(), environmentIds = new Map<string, number>();
  for (const system of systems.filter(item => item.region === '海外')) {
    for (const environment of system.environments) {
      environmentIds.set(environment.id, (environmentIds.get(environment.id) || 0) + 1);
      const url = systemWebUrl(environment.url);
      if (!url) continue;
      const origin = new URL(url).origin;
      targets.set(origin, [...(targets.get(origin) || []), { system, environment }]);
    }
  }
  const groups = new Map<string, BrowserAccountGroup>(), seen = new Set<string>();
  let unmatchedCount = 0, duplicateCount = 0;
  for (const account of accounts) {
    const url = systemWebUrl(account.url);
    if (!url || !account.username.trim() || !account.password) { unmatchedCount++; continue; }
    const origin = new URL(url).origin;
    const key = JSON.stringify([origin, account.username, account.password]);
    if (seen.has(key)) { duplicateCount++; continue; }
    seen.add(key);
    const matches = targets.get(origin) || [];
    if (matches.length !== 1 || environmentIds.get(matches[0].environment.id) !== 1) { unmatchedCount++; continue; }
    const { system, environment } = matches[0];
    let group = groups.get(environment.id);
    if (!group) {
      group = { environmentId: environment.id, systemName: system.name, environmentName: environment.name,
        url: environment.url, accounts: [] };
      groups.set(environment.id, group);
    }
    group.accounts.push({ url, username: account.username, password: account.password });
  }
  return { groups: [...groups.values()], unmatchedCount, duplicateCount };
}

/** Preserve every existing record. A differing saved password is never replaced by an import. */
export function mergeImportedAccounts(existing: SystemAccount[], incoming: { username: string; password: string }[]): ImportedAccountMerge {
  if (existing.length > 20) throw accountLimit();
  const accounts = existing.map(({ id, username, password }) => ({ id, username, password } as ImportedAccountMerge['accounts'][number]));
  let added = 0, updated = 0, skipped = 0, conflicts = 0;
  for (const account of incoming) {
    checkAccountLength(account);
    if (!account.username.trim() || !account.password) { skipped++; continue; }
    const matching = accounts.filter(item => item.username === account.username);
    if (matching.some(item => item.password === account.password)) { skipped++; continue; }
    if (matching.some(item => item.password !== '')) { conflicts++; continue; }
    if (matching.length) { matching[0].password = account.password; updated++; continue; }
    if (accounts.length === 20) throw accountLimit();
    accounts.push({ username: account.username, password: account.password }); added++;
  }
  return { accounts, added, updated, skipped, conflicts };
}

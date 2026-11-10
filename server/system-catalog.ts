/** 同步 Confluence 项目资料并保存本机项目和账号。列表只返回账号摘要。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { confluenceText } from './confluence-knowledge.js';
import { repositoryKey, systemWebUrl, type CatalogSystem, type SystemAccount, type SystemAccountsRead, type SystemCatalog, type SystemProjectRow, type SystemProjectSave, type SystemSource } from '../shared/system-catalog.js';
import { parseSystemProjectRows, readSystemProjectWorkbook } from './system-project-import.js';

type StoredEnvironment = Omit<CatalogSystem['environments'][number], 'accounts'> & { accounts: SystemAccount[] };
type StoredSystem = Omit<CatalogSystem, 'environments'> & { environments: StoredEnvironment[] };
type State = { scope?: 'overseas-v1'; catalog: Omit<SystemCatalog, 'systems' | 'localSystems'> & { systems: StoredSystem[] }; overrides: Record<string, SystemAccount[]>; localSystems?: StoredSystem[]; removedSyncedSystemIds?: string[] };
const localSource: SystemSource = { id: 'local-system-catalog', title: '本机项目', url: '', version: 0 };
const syncedSystems = (state: State) => state.catalog.systems.filter(system =>
  system.region === '海外' && !state.removedSyncedSystemIds?.includes(system.id));
const catalogSystems = (state: State) => [...syncedSystems(state), ...(state.localSystems ?? [])];
const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const accountRevision = (environmentId: string, accounts: SystemAccount[]) => createHash('sha256')
  .update(JSON.stringify([environmentId, accounts.map(({ id, username, password }) => [id, username, password])])).digest('hex');
class SystemAccountsConflictError extends Error {}

function planLocalProjects(state: State, rows: SystemProjectRow[]) {
  const local = (state.localSystems ?? []).map(system => ({ ...system, environments: [...system.environments] }));
  const nameKey = (name: string) => name.normalize('NFKC').toLowerCase();
  const projectKey = (name: string, region: string) => JSON.stringify([region, nameKey(name)]);
  const synced = new Set(state.catalog.systems.map(system => projectKey(system.name, system.region)));
  const projects = new Map(local.map(system => [projectKey(system.name, system.region), system]));
  let added = 0, skipped = 0, systemId = '';
  for (const row of rows) {
    const key = projectKey(row.name, row.region);
    let system = projects.get(key);
    if (!system) {
      if (synced.has(key)) throw new Error(`「${row.name}」已由 Confluence 同步，请使用不同的本机项目名称`);
      system = { id: idFor(`local:${key}`), name: row.name, region: row.region,
        repository: row.repository, source: localSource, environments: [] };
      local.push(system);
      projects.set(key, system);
    }
    systemId ||= system.id;
    if (row.repository && system.repository && repositoryKey(row.repository) !== repositoryKey(system.repository)) {
      throw new Error(`「${row.name}」的 Git 仓库与已录入的地址不一致`);
    }
    system.repository ||= row.repository;
    const existing = system.environments.find(env => nameKey(env.name) === nameKey(row.environment));
    if (existing) {
      if (existing.url !== row.url || existing.branch !== row.branch || existing.notes !== row.notes) {
        throw new Error(`「${row.name}」的「${row.environment}」环境已存在，且内容不同`);
      }
      skipped++;
      continue;
    }
    system.environments.push({ id: idFor(`${system.id}:${nameKey(row.environment)}`), name: row.environment, branch: row.branch,
      url: row.url, notes: row.notes, sourceHref: '', pipeline: '', accounts: [] });
    added++;
  }
  return { local, systemId, added, skipped };
}
const plain = (value: string) => confluenceText(value.replace(/<(https?:\/\/[^<>\s]+)>/g, '$1')).replace(/\\([_*\[\]()<>\\])/g, '$1').trim();
const markdownText = (value: string) => plain(value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')).replace(/^\*\*|\*\*$/g, '').replace(/^`(.*)`$/, '$1').trim();
function link(value: string) {
  const html = value.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const md = value.match(/\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/);
  const text = html ? plain(html[2]) : md ? plain(md[1]) : markdownText(value);
  const href = html ? plain(html[1]) : md ? plain(md[2]) : '';
  const displayed = systemWebUrl(text);
  return { url: displayed || systemWebUrl(href) || systemWebUrl(text.match(/https?:\/\/[^\s<>]+/)?.[0] || ''),
    sourceHref: systemWebUrl(href) };
}

export function parseProjectSystems(content: string, source: SystemSource, region: CatalogSystem['region']): StoredSystem[] {
  const markdown = content.match(/<ac:structured-macro\b[^>]*ac:name="markdown"[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1];
  let text = markdown ?? content;
  if (!markdown && /<table\b/i.test(text)) {
    text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _level, title) => `\n## ${plain(title)}\n`)
      .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, table: string) => '\n' + [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(row => '| ' + [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cell[1].replace(/\|/g, ' / ')).join(' | ') + ' |').join('\n') + '\n');
  }
  const lines = text.split(/\r?\n/);
  const systems: StoredSystem[] = [];
  let current: StoredSystem | undefined, headers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1]
      || (line && /^={3,}\s*$/.test(lines[i + 1] || '') ? line : '');
    if (heading) {
      const name = markdownText(heading);
      current = { id: idFor(`${source.id}:${name}`), name, region, repository: '', source, environments: [] };
      systems.push(current); headers = []; continue;
    }
    if (!current) continue;
    if (/代码仓库/.test(plain(line))) { current.repository = link(line).url; continue; }
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const values = cells.map(markdownText);
    const columnNames = values.map(value => value === '分支名' ? '分支' : value === '访问地址' ? '项目地址' : value);
    if (columnNames.includes('分支') && (columnNames.includes('环境') || columnNames.includes('对应商家'))) { headers = columnNames; continue; }
    if (!headers.length || values.every(cell => /^[:\-\s]*$/.test(cell))) continue;
    const get = (name: string) => values[headers.indexOf(name)] || '';
    const address = link(cells[headers.indexOf('项目地址')] || '');
    const branch = get('分支');
    const name = get('环境') || get('对应商家') || branch;
    if (!name) continue;
    current.environments.push({ id: idFor(`${current.id}:${name}`), name, branch, ...address,
      pipeline: get('流水线'), notes: [get('版本'), get('备注')].filter(value => value && value !== '-').join(' · '), accounts: [] });
  }
  return systems.filter(system => system.environments.length);
}

export function parseSystemAccounts(content: string, sourceUrl: string) {
  const result: { url: string; accounts: SystemAccount[] }[] = [];
  // 每段是一个登录地址，绝不按“测试/生产”等名称把同一个密码传播到其他域名。
  for (const paragraph of content.split(/<\/p>/i)) {
    const href = [...paragraph.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map(match => systemWebUrl(plain(match[1]))).find(Boolean);
    if (!href) continue;
    const lines = confluenceText(paragraph).split('\n').map(line => line.trim()).filter(Boolean);
    const accounts: SystemAccount[] = [];
    let username = '';
    const add = (name: string, password: string) => accounts.push({ id: idFor(`${href}:${name}:${accounts.length}`), username: name, password,
      hasUsername: !!name, hasPassword: !!password, sourceUrl, origin: 'confluence' });
    for (const line of lines) {
      if (/https?:\/\//.test(line)) continue;
      const user = line.match(/^(?:账号|帐号|用户名)\s*[:：]?\s*(.+)$/);
      const pass = line.match(/^密码\s*[:：]?\s*(.+)$/);
      if (user) { if (username) add(username, ''); username = user[1]; }
      else if (pass && username) { add(username, pass[1]); username = ''; }
      else if (!/测试|商家|商户|后台/.test(line)) {
        const tokens = line.split(/\s+/);
        if (tokens.length === 2) add(tokens[0], tokens[1]);
        else if (tokens.length === 1 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(line)) add(line, '');
      }
    }
    if (username) add(username, '');
    if (accounts.length) result.push({ url: href, accounts });
  }
  return result;
}

export async function createSystemCatalog(directory: string, request: (resource: string) => Promise<Response>,
  site = process.env.CONFLUENCE_BASE_URL || '',
  readProjects?: () => Promise<{ projects: { path: string; remoteUrl: string; webUrl: string }[] }>,
  sourceConfig = {
    projectsPage: process.env.DELIVERY_SYSTEM_CATALOG_PAGE_ID || '',
    accountsPage: process.env.DELIVERY_SYSTEM_ACCOUNTS_PAGE_ID || '',
    repository: process.env.DELIVERY_SYSTEM_CATALOG_REPOSITORY || '',
  }) {
  const sourcePages = ([
    { id: sourceConfig.projectsPage, region: '海外' },
    { id: sourceConfig.accountsPage, region: '其他' },
  ] as const).filter(page => /^[1-9]\d*$/.test(page.id));
  const syncConfigured = !!site && sourcePages[0]?.id === sourceConfig.projectsPage;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'catalog.json');
  let state: State = { catalog: { systems: [], sources: [], syncedAt: '' }, overrides: {} };
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机系统导航数据无法读取'); }
  let writes = Promise.resolve(), syncing: Promise<SystemCatalog> | undefined;
  async function update(transform: (state: State) => State) {
    const task = writes.then(async () => {
      const next = transform(state);
      const temp = `${filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, filename); state = next; }
      finally { await fs.rm(temp, { force: true }); }
    });
    writes = task.catch(() => {}); await task;
  }
  const accountsFor = (env: StoredEnvironment, current = state) => current.overrides[env.id] ?? env.accounts;
  const redact = (system: StoredSystem): CatalogSystem => ({ ...system,
    environments: system.environments.map(env => ({ ...env, accounts: accountsFor(env).map(({ username, password, ...account }) => ({ ...account,
      hasUsername: !!username, hasPassword: !!password })) })) });
  const snapshot = (): SystemCatalog => {
    const systems = syncedSystems(state);
    return { ...state.catalog, systems: systems.map(redact),
      sources: state.catalog.sources.filter(source => !source.id.startsWith('repository:') || systems.some(system => system.source.id === source.id)),
      ...(state.localSystems?.length ? { localSystems: state.localSystems.map(redact) } : {}) };
  };
  function environment(id: string, current = state) {
    const env = catalogSystems(current).flatMap(system => system.environments).find(env => env.id === id);
    if (!env) throw new Error('环境不存在，请刷新系统导航');
    return env;
  }
  async function multilingualSystem() {
    const key = repositoryKey(sourceConfig.repository);
    if (!key) return undefined;
    const projects = (await readProjects?.())?.projects || [];
    for (const project of projects.filter(project => repositoryKey(project.remoteUrl) === key)) {
      let readme: string;
      try { readme = await fs.readFile(path.join(project.path, 'README.md'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const section = readme.split(/^##\s+环境信息\s*$/m)[1]?.split(/^##\s/m)[0];
      if (!section) continue;
      const source: SystemSource = { id: `repository:${key}/README.md`, title: '多语言管理平台 · 本地 README.md',
        url: systemWebUrl(project.webUrl) || `https://${key}`, version: 0 };
      const system = parseProjectSystems(`## 多语言管理平台\n${section}\n**代码仓库**: https://${key}.git`, source, '海外')[0];
      if (system && ['test', 'pre'].every(branch => system.environments.some(env => env.branch === branch))) return system;
    }
    return undefined;
  }
  async function sync() {
    if (!syncConfigured) throw new Error('请先配置 Confluence 站点和项目资料页面');
    if (syncing) return syncing;
    syncing = (async () => {
      const pages = await Promise.all(sourcePages.map(async config => {
        const response = await request(`content/${config.id}?expand=body.storage,version`);
        if (!response.ok) throw new Error(`读取项目资料失败（HTTP ${response.status}），请检查 Confluence 连接`);
        const raw = await response.json();
        if (String(raw.id) !== config.id || typeof raw.title !== 'string' || !raw.body?.storage?.value || !raw.version?.number) throw new Error('项目资料格式不正确，已保留本机数据');
        const source: SystemSource = { id: config.id, title: raw.title, version: raw.version.number,
          url: `${site.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${config.id}` };
        return { config, source, content: raw.body.storage.value as string };
      }));
      const systems = pages.slice(0, 1).flatMap(page => {
        const parsed = parseProjectSystems(page.content, page.source, page.config.region);
        if (!parsed.length) throw new Error('未识别到项目环境，已保留本机数据');
        return parsed;
      });
      const multilingual = await multilingualSystem();
      if (multilingual) systems.push(multilingual);
      for (const credentials of pages[1] ? parseSystemAccounts(pages[1].content, pages[1].source.url) : []) {
        const matches = systems.flatMap(system => system.environments).filter(env => env.url && new URL(env.url).origin === new URL(credentials.url).origin);
        if (matches.length === 1) matches[0].accounts.push(...credentials.accounts);
      }
      await update(current => ({ ...current, scope: 'overseas-v1', catalog: { systems,
        sources: [...pages.map(page => page.source), ...(multilingual ? [multilingual.source] : [])], syncedAt: new Date().toISOString() } }));
      return snapshot();
    })().finally(() => { syncing = undefined; });
    return syncing;
  }
  async function list() { return !syncConfigured || state.localSystems !== undefined || state.scope === 'overseas-v1' && state.catalog.systems.length ? snapshot() : sync(); }
  const inputSchema = z.object({ environmentId: z.string().min(1).max(100), accounts: z.array(z.object({
    id: z.string().max(100).optional(), username: z.string().max(500), password: z.string().max(2000),
  }).strict()).max(20), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
  return { list, sync,
    previewProjects(rows: SystemProjectRow[]) {
      const { added, skipped } = planLocalProjects(state, rows);
      return { rows, added, skipped };
    },
    async saveProjects(input: unknown): Promise<SystemProjectSave> {
      const rows = parseSystemProjectRows(input);
      let result!: ReturnType<typeof planLocalProjects>;
      await update(current => {
        result = planLocalProjects(current, rows);
        return { ...current, localSystems: result.local };
      });
      const { systemId, added, skipped } = result;
      return { catalog: snapshot(), systemId, added, skipped };
    },
    async removeProject(input: unknown): Promise<SystemCatalog> {
      const { systemId } = z.object({ systemId: z.string().min(1).max(100) }).strict().parse(input);
      await update(current => {
        const local = current.localSystems?.find(system => system.id === systemId);
        if (local) {
          const overrides = { ...current.overrides };
          for (const env of local.environments) delete overrides[env.id];
          return { ...current, overrides, localSystems: current.localSystems!.filter(system => system.id !== systemId) };
        }
        if (current.removedSyncedSystemIds?.includes(systemId)) return current;
        if (!syncedSystems(current).some(system => system.id === systemId)) throw new Error('项目不存在，请刷新系统导航');
        return { ...current, removedSyncedSystemIds: [...(current.removedSyncedSystemIds ?? []), systemId] };
      });
      return snapshot();
    },
    reveal(id: string): SystemAccountsRead {
      const accounts = accountsFor(environment(id));
      return { accounts: accounts.map(account => ({ ...account })), revision: accountRevision(id, accounts) };
    },
    async save(input: unknown) {
      const data = inputSchema.parse(input);
      const seen = new Set<string>();
      const accounts: SystemAccount[] = data.accounts.filter(account => account.username || account.password).map(account => {
        const id = account.id || randomUUID();
        if (seen.has(id)) throw new Error('账号标识重复');
        seen.add(id);
        return { ...account, id, hasUsername: !!account.username, hasPassword: !!account.password, origin: 'local', sourceUrl: '' };
      });
      await update(current => {
        const existing = accountsFor(environment(data.environmentId, current), current);
        if (data.expectedRevision && data.expectedRevision !== accountRevision(data.environmentId, existing)) {
          throw new SystemAccountsConflictError('账号已更新，请重新读取后再保存');
        }
        return { ...current, overrides: { ...current.overrides, [data.environmentId]: accounts } };
      });
      return snapshot();
    },
    close: async () => { await syncing?.catch(() => {}); await writes; },
  };
}

export function createSystemCatalogRoutes(service: Awaited<ReturnType<typeof createSystemCatalog>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  const base = '/api/systems';
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      && [`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '');
    if (!local || request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
      io.json(response, 403, { message: '请从本机工作台访问系统导航' }); return true;
    }
    try {
      if (request.method === 'GET' && url.pathname === base) { io.json(response, 200, await service.list()); return true; }
      const action = url.pathname.slice(base.length);
      if (!['/sync', '/accounts/read', '/accounts/save', '/projects/preview', '/projects/save', '/projects/remove'].includes(action)) { io.json(response, 404, { message: '接口不存在' }); return true; }
      if (request.method !== 'POST') { io.json(response, 405, { message: '请求方法不支持' }); return true; }
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
        io.json(response, 403, { message: '请从本机工作台操作系统导航' }); return true;
      }
      const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (action === '/projects/preview') {
        if (contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') { io.json(response, 415, { message: '请选择 XLSX 文件' }); return true; }
        io.json(response, 200, service.previewProjects(await readSystemProjectWorkbook(request))); return true;
      }
      if (contentType !== 'application/json') { io.json(response, 415, { message: '请发送 JSON' }); return true; }
      // 20 个账号的合法字段经 JSON 控制字符转义可超过 300 kB，仅保存路由按契约上界放宽。
      const input = await io.body(request, action === '/accounts/save' ? 384 * 1024 : action === '/projects/save' ? 1024 * 1024 : 60_000);
      if (url.pathname.endsWith('/sync')) { z.object({}).strict().parse(input); io.json(response, 200, await service.sync()); }
      else if (url.pathname.endsWith('/read')) {
        const data = z.object({ environmentId: z.string().min(1).max(100) }).strict().parse(input);
        io.json(response, 200, service.reveal(data.environmentId));
      } else if (action === '/projects/save') io.json(response, 200, await service.saveProjects(input));
      else if (action === '/projects/remove') io.json(response, 200, await service.removeProject(input));
      else io.json(response, 200, await service.save(input));
    } catch (error) {
      io.json(response, error instanceof SystemAccountsConflictError ? 409 : 400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof Error ? error.message : '系统导航操作失败' });
    }
    return true;
  };
}

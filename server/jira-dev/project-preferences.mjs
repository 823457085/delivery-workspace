/** 项目偏好只保存本地默认值；不改变已有任务的分支或已经确认的方案发布目录。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalProjectPath } from './tasks.mjs';
import { validateTaskBranches } from './task-workspace.mjs';
import { writePrivateJson } from './ui-state.mjs';

export function defaultDesignDestination() {
  const { CONFLUENCE_BASE_URL: site, DELIVERY_DESIGN_SPACE_KEY: spaceKey,
    DELIVERY_DESIGN_PARENT_ID: parentId, DELIVERY_DESIGN_PARENT_TITLE: title } = process.env;
  return site && spaceKey && parentId && title ? normalizeDesignDestination({ site, spaceKey, parentId, title }) : null;
}
const execute = promisify(execFile);
const git = async (path, args) => (await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', path, ...args], {
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
})).stdout.trim();

export function normalizeDesignDestination(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['site', 'spaceKey', 'parentId', 'title', 'url'].includes(key))) throw new Error('请填写完整的技术方案目录。');
  let site;
  try { site = new URL(input.site); } catch { throw new Error('Confluence 站点无效。'); }
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password || site.search || site.hash) throw new Error('Confluence 站点须为不含凭据和查询参数的 HTTP 地址。');
  if (typeof input.spaceKey !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.spaceKey) || typeof input.parentId !== 'string' || !/^[1-9]\d{0,31}$/.test(input.parentId) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500 || /[\x00-\x1f\x7f]/.test(input.title)) throw new Error('请填写准确的空间 Key、父页面 ID 和目录名称。');
  const base = site.href.replace(/\/+$/, '');
  return { site: base, spaceKey: input.spaceKey, parentId: input.parentId, title: input.title.trim(), url: `${base}/pages/viewpage.action?pageId=${input.parentId}` };
}

async function projectIdentity(projectPath) {
  const path = await canonicalProjectPath(projectPath);
  try {
    if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path) throw new Error();
    const common = await realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir'])));
    return { projectPath: path, scopeId: createHash('sha256').update(common).digest('hex') };
  } catch { throw new Error('请选择可访问的 Git 检出根目录。'); }
}

export async function readBranchOptions({ projectPath }) {
  const identity = await projectIdentity(projectPath);
  const refs = (await git(identity.projectPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])).split('\n').filter(Boolean);
  const branches = refs.filter(ref => ref !== 'refs/remotes/origin/HEAD').map(ref => ref.slice('refs/remotes/origin/'.length)).sort();
  return { ...identity, branches: branches.slice(0, 500), truncated: branches.length > 500, fetched: false, basis: 'local-origin-tracking-refs' };
}

export function createProjectPreferences({ dataDirectory }) {
  const file = join(dataDirectory, 'project-preferences.json');
  const load = async () => {
    try { const records = JSON.parse(await readFile(file, 'utf8')); if (!records || Array.isArray(records) || typeof records !== 'object') throw new Error(); return records; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('项目偏好无法读取，未覆盖原记录。'); }
  };
  const view = (identity, item) => ({ ...identity, revision: item?.revision || 'new', settings: item?.settings || { baseBranch: '', designMode: 'default' }, designDestination: item?.settings?.designMode === 'local' ? null : item?.settings?.designMode === 'custom' ? item.settings.designDestination : defaultDesignDestination(), updatedAt: item?.updatedAt || '' });
  return {
    async get({ projectPath }) { const identity = await projectIdentity(projectPath); return view(identity, (await load())[identity.scopeId]); },
    async set({ projectPath, scopeId, expectedRevision, settings }) {
      const identity = await projectIdentity(projectPath);
      if (scopeId !== identity.scopeId) throw new Error('项目已变化，请重新读取默认设置。');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.baseBranch !== 'string' || Object.keys(settings).some(key => !['baseBranch', 'designMode', 'designDestination'].includes(key)) || !['default', 'custom', 'local'].includes(settings.designMode)) throw new Error('项目默认设置格式不正确。');
      const baseBranch = settings.baseBranch ? (await validateTaskBranches(settings.baseBranch, 'feature/preferences-validation')).baseBranch : '';
      const next = { baseBranch, designMode: settings.designMode, ...(settings.designMode === 'custom' ? { designDestination: normalizeDesignDestination(settings.designDestination) } : {}) };
      if (settings.designMode === 'custom' && !next.designDestination) throw new Error('自定义归档目录不能为空。');
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const lock = new DatabaseSync(join(dataDirectory, 'project-preferences-lock.sqlite'));
      try {
        try { lock.exec('BEGIN IMMEDIATE'); } catch { throw new Error('另一个面板正在保存项目默认设置，请稍后重新读取。'); }
        const records = await load();
        if ((records[identity.scopeId]?.revision || 'new') !== expectedRevision) throw new Error('项目默认设置已在另一窗口更新，请重新读取后保存。');
        records[identity.scopeId] = { revision: randomUUID(), settings: next, updatedAt: new Date().toISOString() };
        await writePrivateJson(file, records);
        return view(identity, records[identity.scopeId]);
      } finally { lock.close(); }
    },
  };
}

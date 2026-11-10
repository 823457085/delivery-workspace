/**
 * 同一仓库的 clone/worktree 只占一个项目入口，具体目录仍完整保留供选择。
 * 只以 origin 身份或已验证的 common Git 目录合并；名称相似不构成证据。
 * Git 查询仅限本地 origin 元数据，禁用配置 include/全局配置，不联网、不返回 URL 或凭据。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const bounded = (value, maximum) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : maximum;

/** 只返回安全的仓库名与不可逆身份；不将 URL、userinfo 或查询参数传出。 */
export function repositoryIdentity(remote) {
  if (typeof remote !== 'string' || remote.length > 8192) return null;
  const value = remote.trim();
  if (!value || /[\s\0\\]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  let hostname;
  let port = '';
  let repositoryPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const defaults = { 'http:': '80', 'https:': '443', 'ssh:': '22', 'git:': '9418' };
      if (!(url.protocol in defaults)) return null;
      hostname = url.hostname.toLowerCase();
      port = url.port && url.port !== defaults[url.protocol] ? `:${url.port}` : '';
      repositoryPath = url.pathname;
    } catch { return null; }
  } else {
    if (/^[a-z][a-z0-9+.-]*::/i.test(value)) return null;
    const match = /^(?:[^@\s]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/.exec(value);
    if (!match) return null;
    hostname = match[1].toLowerCase();
    repositoryPath = match[2].split(/[?#]/)[0];
  }
  repositoryPath = repositoryPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!hostname || !repositoryPath || repositoryPath.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return {
    repositoryId: `git-${hash(`${hostname}${port}/${repositoryPath}`)}`,
    name: repositoryPath.split('/').at(-1),
  };
}

async function smallFile(file, maximum = 4096) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maximum) return null;
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function gitEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const emptyConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  };
}

async function originIdentity(commonDirectory, deadline, environment) {
  const config = path.join(commonDirectory, 'config');
  let info;
  try { info = await lstat(config); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    return { failed: true };
  }
  if (!info.isFile() || info.size > 262144) return { failed: true };
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return { budgetExceeded: true };
  try {
    const { stdout } = await run('git', [
      'config', '--no-includes', '--file', config, '--null', '--get-all', 'remote.origin.url',
    ], { cwd: commonDirectory, env: environment, timeout: Math.min(500, remaining), maxBuffer: 32768, windowsHide: true });
    const origins = stdout.split('\0').filter(Boolean).map(repositoryIdentity);
    // 多个不同 URL 可能是不同服务器；无法唯一确认时只依赖 common Git 目录。
    if (!origins.length || origins.some(origin => !origin) || new Set(origins.map(origin => origin.repositoryId)).size !== 1) return {};
    return { origin: origins[0] };
  } catch (error) {
    // git config 的退出码 1 表示未配置 origin；其他错误一律不输出 stderr。
    return error.code === 1 ? {} : { failed: true, budgetExceeded: performance.now() >= deadline };
  }
}

async function inspectRepository(project, deadline, environment, origins) {
  if (!project.markers.includes('.git')) return {};
  try {
    const marker = path.join(project.path, '.git');
    const info = await lstat(marker);
    let gitDirectory;
    if (info.isDirectory()) gitDirectory = await realpath(marker);
    else if (info.isFile()) {
      const match = /^gitdir:\s*(.+)$/.exec((await smallFile(marker))?.trim() || '');
      if (match) gitDirectory = await realpath(path.resolve(project.path, match[1]));
    }
    if (!gitDirectory) return {};
    const common = await smallFile(path.join(gitDirectory, 'commondir'));
    const commonDirectory = common?.trim()
      ? await realpath(path.resolve(gitDirectory, common.trim()))
      : gitDirectory;
    // 普通同名文件夹或损坏的 .git 标记不能成为合并依据。
    if (!(await lstat(path.join(gitDirectory, 'HEAD'))).isFile()
      || !(await lstat(path.join(commonDirectory, 'objects'))).isDirectory()) return {};
    if (!origins.has(commonDirectory)) origins.set(commonDirectory, originIdentity(commonDirectory, deadline, environment));
    return {
      commonId: `common-${hash(commonDirectory)}`,
      commonName: path.basename(commonDirectory) === '.git' ? path.basename(path.dirname(commonDirectory)) : undefined,
      linked: commonDirectory !== gitDirectory,
      ...await origins.get(commonDirectory),
    };
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? {} : { failed: true };
  }
}

/** 独立的最多 2 秒元数据阶段；4 路并行，超时或失败时保留无法确认的目录。 */
export async function groupRepositories(projects, { preferredProjectPath, timeBudgetMs } = {}) {
  const deadline = performance.now() + bounded(timeBudgetMs, 2000);
  const environment = gitEnvironment();
  const origins = new Map();
  const records = projects.map((project, index) => ({ project, index, metadata: {} }));
  let next = 0;
  let budgetExceeded = false;
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
    while (next < records.length) {
      const record = records[next++];
      if (!record.project.markers.includes('.git')) continue;
      if (performance.now() >= deadline) { budgetExceeded = true; continue; }
      record.metadata = await inspectRepository(record.project, deadline, environment, origins);
      budgetExceeded ||= Boolean(record.metadata.budgetExceeded);
    }
  }));

  const parents = records.map((_, index) => index);
  const find = index => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const identities = new Map();
  for (const record of records) {
    for (const identity of [record.metadata.commonId, record.metadata.origin?.repositoryId].filter(Boolean)) {
      if (identities.has(identity)) parents[find(record.index)] = find(identities.get(identity));
      else identities.set(identity, record.index);
    }
  }
  const groups = new Map();
  for (const record of records) {
    const identity = find(record.index);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(record);
  }
  const grouped = [...groups.values()].map(group => {
    const origin = group.map(record => record.metadata.origin).filter(Boolean)
      .sort((left, right) => compare(left.repositoryId, right.repositoryId))[0];
    const name = origin?.name || group.map(record => record.metadata.commonName).filter(Boolean).sort(compare)[0];
    const priority = record => record.project.path === preferredProjectPath ? -1
      : !record.metadata.linked && record.project.name === name ? 0 : !record.metadata.linked ? 1 : 2;
    group.sort((left, right) => priority(left) - priority(right)
      || left.project.path.length - right.project.path.length || compare(left.project.path, right.project.path));
    const representative = group[0].project;
    return {
      name: name || representative.name, path: representative.path, markers: [...representative.markers],
      repositoryId: origin?.repositoryId || group.map(record => record.metadata.commonId).filter(Boolean).sort(compare)[0]
        || `directory-${hash(representative.path)}`,
      checkoutCount: group.length,
      checkouts: group.map(({ project }) => ({ name: project.name, path: project.path, markers: [...project.markers] })),
    };
  });
  grouped.sort((left, right) => Number(right.path === preferredProjectPath) - Number(left.path === preferredProjectPath));
  const warnings = [];
  if (budgetExceeded) warnings.push('仓库识别已达到时间上限，未确认的目录已单独保留。');
  if (records.some(record => record.metadata.failed)) warnings.push('部分 Git 仓库信息无法读取，未确认的目录已单独保留。');
  return { projects: grouped, checkoutCount: projects.length, repositoryCount: grouped.length, warnings };
}

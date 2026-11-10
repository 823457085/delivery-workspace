/**
 * 从有限的本地目录发现项目；只读目录项及必要的本地 Git origin/common-dir 元数据。
 * 项目标记命中后停止下钻，再按 Git 证据归组；不读业务文件或凭据、不联网、不做全盘索引。
 */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { groupRepositories } from './repository-groups.mjs';

const MARKERS = new Set([
  '.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
  'CMakeLists.txt', 'Package.swift',
]);
const IGNORED = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor',
  '__pycache__', 'Pods',
]);
const DEFAULT_LIMITS = {
  maxDepth: 4,
  maxDirectories: 3000,
  maxProjects: 150,
  timeBudgetMs: 2000,
};
const SYSTEM_ROOTS = new Set([
  '/', '/Users', '/home', '/Volumes', '/private', '/private/var', '/var', '/tmp', '/private/tmp',
]);
const SYSTEM_TREES = [
  '/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc',
  '/dev', '/proc', '/sys', '/private/etc',
];

const within = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const ignored = (name) => name.startsWith('.') || IGNORED.has(name);

/** limits 仅供定向测试收紧默认预算，不能扩大扫描范围或上限。 */
export async function scanProjects({ roots, preferredProjectPath, limits = {} } = {}) {
  const home = path.resolve(homedir());
  const budget = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, maximum]) => [
    key,
    Number.isFinite(limits[key]) ? Math.max(0, Math.min(maximum, Math.floor(limits[key]))) : maximum,
  ]));
  const result = { projects: [], roots: [], warnings: [], truncated: false, scannedDirectories: 0 };
  const deadline = performance.now() + budget.timeBudgetMs;
  const seen = new Set();
  const warnings = new Set();
  let preferredPath;
  const warn = (message) => warnings.add(message);
  const stop = (message) => {
    result.truncated = true;
    warn(message);
    return true;
  };
  const overBudget = () => {
    if (performance.now() >= deadline) return stop('扫描已达到时间上限，结果可能不完整。');
    if (result.scannedDirectories >= budget.maxDirectories) return stop('扫描已达到目录数量上限，结果可能不完整。');
    if (result.projects.length >= budget.maxProjects) return stop('扫描已达到项目数量上限，结果可能不完整。');
    return false;
  };
  const blocked = (candidate) => candidate === home
    || candidate === path.dirname(home)
    || candidate === path.parse(candidate).root
    || SYSTEM_ROOTS.has(candidate)
    || SYSTEM_TREES.some((systemPath) => within(candidate, systemPath))
    || candidate.split(path.sep).some((part) => part && ignored(part));
  const reportFailure = (candidate, error) => {
    const reason = error.code === 'EACCES' || error.code === 'EPERM'
      ? '无权限访问'
      : error.code === 'ENOENT' ? '目录不存在' : '无法读取目录';
    warn(`${reason}：${candidate}`);
  };
  const normalizeDirectory = async (input) => {
    if (typeof input !== 'string' || !input.trim()) {
      warn('已跳过无效的扫描目录。');
      return null;
    }
    const trimmed = input.trim();
    if (!path.isAbsolute(trimmed)) {
      warn(`扫描目录必须使用绝对路径，已跳过：${trimmed}`);
      return null;
    }
    const absolute = path.resolve(trimmed);
    if (blocked(absolute)) {
      warn(`已跳过范围过大或受保护的目录：${absolute}`);
      return null;
    }
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        warn(`已跳过符号链接目录：${absolute}`);
        return null;
      }
      if (!info.isDirectory()) {
        warn(`不是可扫描的目录：${absolute}`);
        return null;
      }
      const canonical = await realpath(absolute);
      if (blocked(canonical)) {
        warn(`已跳过范围过大或受保护的目录：${absolute}`);
        return null;
      }
      return canonical;
    } catch (error) {
      reportFailure(absolute, error);
      return null;
    }
  };
  const inspect = async (directory, depth, queue) => {
    if (seen.has(directory) || result.projects.some((project) => within(directory, project.path))) return;
    if (overBudget()) return;
    seen.add(directory);
    result.scannedDirectories += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      reportFailure(directory, error);
      return;
    }
    if (performance.now() >= deadline) {
      stop('扫描已达到时间上限，结果可能不完整。');
      return;
    }
    const markers = entries.filter((entry) => (
      entry.name === '.git' && (entry.isDirectory() || entry.isFile())
    ) || (
      entry.isFile() && (MARKERS.has(entry.name) || entry.name.endsWith('.sln'))
    )).map((entry) => entry.name).sort();
    if (markers.length) {
      result.projects = result.projects.filter((project) => (
        project.path === preferredPath || !within(project.path, directory)
      ));
      result.projects.push({ name: path.basename(directory), path: directory, markers });
      return;
    }
    if (!queue) {
      // 未命中项目的首选目录，仍可作为普通扫描根继续查找。
      seen.delete(directory);
      return;
    }
    if (depth >= budget.maxDepth) return;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || ignored(entry.name)) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  };

  if (preferredProjectPath !== undefined) {
    preferredPath = await normalizeDirectory(preferredProjectPath);
    if (preferredPath) await inspect(preferredPath, 0);
  }
  const requestedRoots = roots === undefined ? [path.join(home, 'Desktop'), path.join(home, 'Documents')] : roots;
  if (!Array.isArray(requestedRoots)) {
    warn('扫描目录必须是路径列表。');
  } else {
    for (const requestedRoot of requestedRoots) {
      if (overBudget()) break;
      const normalized = await normalizeDirectory(requestedRoot);
      if (normalized && !result.roots.includes(normalized)) result.roots.push(normalized);
    }
    const queue = result.roots
      .filter((root) => !result.roots.some((other) => other !== root && within(root, other)))
      .map((directory) => ({ directory, depth: 0 }));
    for (let index = 0; index < queue.length; index += 1) {
      if (overBudget()) break;
      const item = queue[index];
      if (seen.has(item.directory)) continue;
      const canonical = await normalizeDirectory(item.directory);
      if (canonical) await inspect(canonical, item.depth, queue);
    }
  }
  result.warnings = [...warnings];
  if (result.projects.some((project) => project.path === preferredPath)) {
    result.preferredProjectPath = preferredPath;
  }
  const grouped = await groupRepositories(result.projects, {
    preferredProjectPath: result.preferredProjectPath,
    timeBudgetMs: limits.metadataTimeBudgetMs,
  });
  result.projects = grouped.projects;
  result.checkoutCount = grouped.checkoutCount;
  result.repositoryCount = grouped.repositoryCount;
  result.warnings.push(...grouped.warnings);
  return result;
}

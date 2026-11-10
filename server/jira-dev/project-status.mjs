/**
 * 只读取成员当前选定的检出，帮助核对分支和本地改动；不把逐仓库 status 混入项目扫描。
 * 使用 Git 的 NUL 分隔状态和本地跟踪引用，禁用可执行监控、可选锁及交互，不 fetch 或改写工作区。
 */
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function environment() {
  const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty,
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  };
}

function parseStatus(output) {
  const records = output.split('\0');
  let branch = null, upstream = null, detached = false, unborn = false, ahead = null, behind = null;
  let staged = 0, modified = 0, untracked = 0, changed = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      branch = record.slice(14); detached = branch === '(detached)'; if (detached) branch = null;
    } else if (record.startsWith('# branch.oid ')) unborn = record.slice(13) === '(initial)';
    else if (record.startsWith('# branch.upstream ')) {
      const value = record.slice(18);
      // 此处只接受 ref 名称，既不读取也不传出 remote URL 或凭据。
      if (value && !/[\s\x00-\x1f\x7f:]|\/\//.test(value)) upstream = value;
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith('? ')) { untracked++; changed++; }
    else if (/^[12u] /.test(record)) {
      const status = record.slice(2, 4);
      if (status[0] !== '.') staged++;
      if (status[1] !== '.') modified++;
      changed++;
      // rename/copy 的第二个 NUL 段是原路径，不能误作另一项改动或分支头。
      if (record.startsWith('2 ')) index++;
    } else if (!record.startsWith('# ') && !record.startsWith('! ')) {
      throw new Error('Git 状态格式无法识别，请重新读取。');
    }
  }
  if (!branch && !detached) throw new Error('Git 分支信息不完整，请重新读取。');
  if (!upstream || detached || unborn) { ahead = null; behind = null; }
  return { branch, detached, unborn, upstream, ahead, behind, staged, modified, untracked, clean: changed === 0 };
}

export async function readProjectStatus({ projectPath } = {}) {
  if (typeof projectPath !== 'string' || projectPath.length > 1000 || !isAbsolute(projectPath)
    || /[\x00-\x1f\x7f]/.test(projectPath)) throw new Error('请选择项目的完整绝对路径。');
  let canonical;
  try {
    canonical = await realpath(projectPath);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
  } catch { throw new Error('项目目录不存在、不是文件夹或无权访问。'); }
  const deadline = performance.now() + 10000, env = environment();
  const git = async args => {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) throw new Error();
    const { stdout } = await execute('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'status.submoduleSummary=false', '-C', canonical, ...args,
    ], { env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout;
  };
  let topLevel;
  try { topLevel = await realpath((await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')); }
  catch { throw new Error('无法读取 Git 项目，请选择可访问的 Git 检出根目录。'); }
  if (topLevel !== canonical) throw new Error('请选择 Git 检出根目录，不能使用仓库内的子目录。');
  try {
    const status = parseStatus(await git(['status', '--porcelain=v2', '--branch', '--ahead-behind', '-z', '--untracked-files=all', '--ignore-submodules=none']));
    return { projectPath: canonical, ...status, comparisonBasis: 'local-tracking-ref', fetched: false };
  } catch { throw new Error('项目状态读取失败或超时，请检查目录权限后重新读取。'); }
}

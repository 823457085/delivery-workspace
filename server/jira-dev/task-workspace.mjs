/**
 * 用户确认任务后，从明确的 origin 基准创建独立工作目录；不在原检出上 pull、切分支或清理改动。
 * 只使用 Git 参数调用和新建目录，不运行项目任务；失败保留现场，不用回滚/删除掩盖问题。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const protectedRoots = new Set(['/Users', '/home', '/Volumes', '/private', '/private/var', '/var', '/tmp', '/private/tmp']);
const protectedTrees = ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/dev', '/proc', '/sys', '/private/etc'];

// 分支语法不依赖插件 cwd（升级后旧目录可能已删除）或仓库环境；完整 heads ref 避免 --branch 读取检出历史。
export async function validateTaskBranches(baseBranch, branchName) {
  const branchValue = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200
      || /[\x00-\x20\x7f]/.test(value) || value.trim().startsWith('-')
      || value.trim().startsWith('refs/') || value === 'HEAD' || value.includes('@{')) {
      throw new Error(`${label}必须是明确的合法分支名，不能是选项、完整 ref 或历史表达式。`);
    }
    return value.trim();
  };
  baseBranch = branchValue(baseBranch, '基准分支').replace(/^origin\//, '');
  baseBranch = branchValue(baseBranch, '基准分支');
  branchName = branchValue(branchName, '新分支');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  for (const [value, label] of [[baseBranch, '基准分支'], [branchName, '新分支']]) {
    try {
      await execute('git', ['check-ref-format', `refs/heads/${value}`], { cwd: parse(process.execPath).root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    } catch (error) {
      if (error.code === 1 && !error.killed && !error.signal) throw new Error(`${label}必须是明确的合法分支名，不能是完整 ref 或历史表达式。`);
      throw Object.assign(new Error('无法运行 Git 分支校验，请检查插件进程是否可以使用 Git；当前运行环境未能完成校验。'), { code: 'TASK_BRANCH_VALIDATION_ENV' });
    }
  }
  return { baseBranch, branchName };
}

/** 仅恢复创建成功后的关联，不 fetch、不创建分支、不改变工作区。 */
export async function inspectTaskWorkspace({ projectPath, sourceProjectPath, branchName, baseSha }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha || '')) throw new Error('请提供创建结果中的准确基准 SHA。');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  const git = async (cwd, args) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })).stdout.trim();
  const paths = [];
  for (const input of [sourceProjectPath, projectPath]) {
    if (typeof input !== 'string' || input.length > 1000 || !isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input)) throw new Error('请选择准确的项目绝对路径。');
    const path = await realpath(input);
    if (path === parse(path).root || path === homedir() || path === dirname(homedir()) || protectedRoots.has(path) || protectedTrees.some(root => path === root || path.startsWith(`${root}${sep}`))) throw new Error('请选择具体任务工作区。');
    if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path) throw new Error('请选择 Git 检出根目录。');
    paths.push(path);
  }
  const [sourcePath, workspacePath] = paths;
  if (sourcePath === workspacePath || workspacePath.startsWith(`${sourcePath}${sep}`)) throw new Error('不能将来源检出当作独立工作区。');
  const common = async path => realpath(resolve(path, await git(path, ['rev-parse', '--git-common-dir'])));
  if (await common(sourcePath) !== await common(workspacePath) || await git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('已有工作区与原任务仓库或分支不一致。');
  try { await git(workspacePath, ['merge-base', '--is-ancestor', baseSha, 'HEAD']); }
  catch { throw new Error('工作区不包含所提供的任务基准 SHA。'); }
  return { sourcePath, workspacePath, baseSha, branchName };
}

export async function createTaskWorkspace({ projectPath, baseBranch, branchName, taskName } = {}) {
  if (typeof projectPath !== 'string' || projectPath.length > 1000
    || !isAbsolute(projectPath.trim()) || /[\x00-\x1f\x7f]/.test(projectPath)) {
    throw new Error('项目目录必须是明确的绝对路径，且不能含控制字符。');
  }
  ({ baseBranch, branchName } = await validateTaskBranches(baseBranch, branchName));
  if (taskName !== undefined && (typeof taskName !== 'string' || taskName.length > 100 || /[\x00-\x1f\x7f]/.test(taskName))) {
    throw new Error('任务目录名称最多 100 字，且不能含控制字符。');
  }

  let sourcePath;
  try {
    sourcePath = await realpath(projectPath.trim());
    if (!(await stat(sourcePath)).isDirectory()) throw new Error();
  } catch {
    throw new Error('项目目录不存在、不是文件夹或无权访问。');
  }
  if (sourcePath === parse(sourcePath).root || sourcePath === homedir() || sourcePath === dirname(homedir())
    || protectedRoots.has(sourcePath)
    || protectedTrees.some(root => sourcePath === root || sourcePath.startsWith(`${root}${sep}`))) {
    throw new Error('请选具体 Git 项目目录，不要选择磁盘、用户主目录或系统目录。');
  }

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  let step = '校验 Git 项目';
  let workspacePath;
  let workspaceRoot;
  let rootCreated = false;
  let temporaryRef;
  let temporarySha;
  let cleanupAttempted = false;
  const git = async (cwd, args) => {
    const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };
  const sourceState = async () => ({
    head: (await git(sourcePath, ['rev-parse', '--verify', 'HEAD'])).trim(),
    ref: (await git(sourcePath, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim(),
    dirty: await git(sourcePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  });
  const removeTemporaryRef = async () => {
    cleanupAttempted = true;
    await git(sourcePath, ['update-ref', '-d', temporaryRef, temporarySha]);
    temporaryRef = undefined;
  };

  try {
    const topLevel = await realpath((await git(sourcePath, ['rev-parse', '--show-toplevel'])).trim());
    if (topLevel !== sourcePath) throw new Error('请选择 Git 仓库的检出根目录。');
    step = '校验 origin 远端';
    const remotes = (await git(sourcePath, ['remote'])).trim().split('\n');
    if (!remotes.includes('origin')) throw new Error();
    step = '校验新分支未存在';
    const existing = (await git(sourcePath, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).trim().split('\n');
    const newRef = `refs/heads/${branchName}`;
    if (existing.some(ref => ref === newRef || ref.startsWith(`${newRef}/`) || newRef.startsWith(`${ref}/`))) throw new Error();
    step = '记录原检出的 HEAD 和未提交状态';
    const before = await sourceState();

    step = '拉取 origin 指定基准';
    temporaryRef = `refs/frontend-team-delivery/${randomUUID()}`;
    await git(sourcePath, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--refmap=', 'origin', `refs/heads/${baseBranch}:${temporaryRef}`]);
    step = '解析本次临时引用提交';
    const baseSha = (await git(sourcePath, ['rev-parse', '--verify', `${temporaryRef}^{commit}`])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) throw new Error();
    temporarySha = baseSha;

    step = '创建隔离工作目录';
    workspaceRoot = join(dirname(sourcePath), `${basename(sourcePath)}-tasks`);
    try {
      await mkdir(workspaceRoot, { mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const rootInfo = await lstat(workspaceRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(workspaceRoot) !== workspaceRoot) throw new Error();
    const slug = (taskName || branchName.split('/').at(-1)).normalize('NFKC').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 48) || 'task';
    workspacePath = await mkdtemp(join(workspaceRoot, `${slug}-`));
    if (workspacePath === sourcePath || workspacePath.startsWith(`${sourcePath}${sep}`)) throw new Error();

    step = '创建新分支和 Git worktree';
    await git(sourcePath, ['worktree', 'add', '-b', branchName, '--', workspacePath, baseSha]);
    step = '核验新工作目录和源检出状态';
    const actualWorkspace = await realpath((await git(workspacePath, ['rev-parse', '--show-toplevel'])).trim());
    const actualHead = (await git(workspacePath, ['rev-parse', '--verify', 'HEAD'])).trim();
    const actualRef = (await git(workspacePath, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim();
    const after = await sourceState();
    if (actualWorkspace !== workspacePath || actualHead !== baseSha || actualRef !== newRef
      || before.head !== after.head || before.ref !== after.ref || before.dirty !== after.dirty) throw new Error();
    step = '清理本次临时引用';
    await removeTemporaryRef();
    return { sourcePath, workspacePath: actualWorkspace, baseRef: `origin/${baseBranch}`, baseSha, branchName };
  } catch {
    if (temporaryRef && temporarySha && !cleanupAttempted) {
      try { await removeTemporaryRef(); } catch { /* 只保留本次引用，不覆盖其他 ref。 */ }
    }
    let retained;
    for (const candidate of [workspacePath, rootCreated ? workspaceRoot : undefined]) {
      if (!candidate) continue;
      try { await lstat(candidate); retained = candidate; break; } catch { /* Git 可能自行撤掉失败的工作目录。 */ }
    }
    const failure = new Error(`${step}失败；请检查该步骤的项目、权限或分支条件。未执行源检出的 pull、checkout、reset、commit 或 push。${retained ? `已保留目录：${retained}；未自动删除或回滚，请检查现场。` : ''}${temporaryRef ? `本次临时引用尚未确认清理：${temporaryRef}；请检查，不要删除其他引用。` : ''}`);
    failure.step = step;
    if (retained) failure.retainedPath = retained;
    if (workspacePath) failure.workspacePath = workspacePath;
    if (temporaryRef) failure.temporaryRef = temporaryRef;
    throw failure;
  }
}

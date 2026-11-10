import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceProjectResolver } from '../server/workspace-project.js';

const exec = promisify(execFile);
const id = 'e7018ed8-17eb-484f-964c-ec2565c02f3f';

async function repository(directory: string, gitDirectory?: string) {
  await fs.mkdir(directory, { recursive: true });
  await exec('git', ['init', '-b', 'main', ...(gitDirectory ? [`--separate-git-dir=${gitDirectory}`] : []), directory]);
  await exec('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
}

test('多个 worktree、子目录和显式源目录归到真实主项目，输入执行身份保持不变', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-project-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'Apex重构', 'admin');
  await repository(main);
  const first = path.join(root, '.data', 'agent-runtimes', 'workspaces', id);
  const second = path.join(root, 'another-worktree');
  await fs.mkdir(path.dirname(first), { recursive: true });
  await exec('git', ['-C', main, 'worktree', 'add', '-b', 'feature/one', first]);
  await exec('git', ['-C', main, 'worktree', 'add', '-b', 'feature/two', second]);
  const nested = path.join(first, 'src', 'nested');
  await fs.mkdir(nested, { recursive: true });
  const resolve = createWorkspaceProjectResolver();
  assert.deepEqual(await Promise.all([main, first, second, nested].map(workspacePath => resolve({ workspacePath }))),
    [main, main, main, main]);
  const other = path.join(root, 'other-project');
  await repository(other);
  const record = { workspacePath: other, sourceWorkspacePath: nested, branch: 'feature/preserved' };
  const original = { ...record };
  assert.equal(await resolve(record), main);
  assert.deepEqual(record, original);
  assert.equal(await resolve({ workspacePath: first, sourceWorkspacePath: '' }), '');
  assert.equal(await resolve({ workspacePath: other, sourceWorkspacePath: path.join(root, 'missing-source') }), path.join(root, 'missing-source'));
});

test('普通与缺失目录安全回退，非 Git 结果不阻碍后续识别，同名项目保持区分', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-project-fallback-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resolve = createWorkspaceProjectResolver();
  const main = path.join(root, 'left', 'admin');
  const nested = path.join(main, 'src');
  await fs.mkdir(nested, { recursive: true });
  assert.equal(await resolve({ workspacePath: nested }), nested);
  const missing = path.join(root, 'missing');
  assert.equal(await resolve({ workspacePath: missing }), missing);
  await repository(main);
  assert.equal(await resolve({ workspacePath: nested }), main);
  const other = path.join(root, 'right', 'admin');
  await repository(other);
  assert.equal(await resolve({ workspacePath: other }), other);
  assert.notEqual(await resolve({ workspacePath: main }), await resolve({ workspacePath: other }));
});

test('内部会话和失效 UUID 工作目录不显示 UUID，正常目录的 UUID 名不被误判', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-project-internal-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resolve = createWorkspaceProjectResolver();
  const session = path.join(root, '.data', 'agent-runtimes', 'sessions', id);
  const worktree = path.join(root, '.data', 'agent-runtimes', 'workspaces', id);
  assert.equal(await resolve({ workspacePath: session }), '');
  assert.equal(await resolve({ workspacePath: worktree }), '');
  await fs.mkdir(worktree, { recursive: true });
  assert.equal(await resolve({ workspacePath: worktree }), '');
  const ordinary = path.join(root, id);
  await fs.mkdir(ordinary);
  assert.equal(await resolve({ workspacePath: ordinary }), ordinary);
  assert.equal(await resolve({ workspacePath: session, sourceWorkspacePath: ordinary }), ordinary);
});

test('独立 git-dir 不作为项目；主目录无法核实时保留当前工作树，特殊字符路径不截断', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-project-gitdir-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'project with\nnewline');
  await repository(main, path.join(root, 'git-storage'));
  const worktree = path.join(root, 'linked');
  await exec('git', ['-C', main, 'worktree', 'add', '-b', 'feature/linked', worktree]);
  const resolve = createWorkspaceProjectResolver();
  assert.equal(await resolve({ workspacePath: main }), main);
  assert.equal(await resolve({ workspacePath: worktree }), worktree);
  await exec('git', ['-C', main, 'config', 'core.worktree', main]);
  assert.equal(await createWorkspaceProjectResolver()({ workspacePath: worktree }), main);
});

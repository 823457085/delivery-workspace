import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceUsageCheck } from '../server/project-workspace-usage.js';

test('工作区占用检查覆盖排队任务、旧路径链接和进程子目录；查询失败时拒绝删除', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-usage-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'workspace'), alias = path.join(parent, 'old');
  await fs.mkdir(directory); await fs.symlink(directory, alias);
  const nested = path.join(directory, 'src'); await fs.mkdir(nested);
  await assert.rejects(createWorkspaceUsageCheck(() => [alias], async () => '')(directory), /运行或排队/);
  await assert.rejects(createWorkspaceUsageCheck(() => [], async () => `p123\nn${nested}\n`)(alias), /进程 123/);
  await createWorkspaceUsageCheck(() => [], async () => `p123\nn${parent}\n`)(directory);
  await assert.rejects(createWorkspaceUsageCheck(() => [], async () => { throw new Error('无法读取进程'); })(directory), /无法读取进程/);
});

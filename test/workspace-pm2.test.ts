import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { matchesPm2Workspace } from '../server/workspace-restart.js';

const root = path.resolve('/tmp/delivery-share');
const entry = {
  pid: 100,
  name: 'delivery-share-5288',
  pm2_env: { autorestart: true, pm_exec_path: path.join(root, 'delivery.mjs'), pm_cwd: root, args: ['start'] },
};

test('分享版只识别同目录、使用正式启动入口并实际拥有当前后端的 PM2 父进程', () => {
  assert.equal(matchesPm2Workspace(root, entry, 101, 100), true);
  assert.equal(matchesPm2Workspace(root, { ...entry, pm2_env: { ...entry.pm2_env, args: 'start' } }, 101, 100), true);
  assert.equal(matchesPm2Workspace(root, entry, 101, 99), false);
  assert.equal(matchesPm2Workspace(root, { ...entry, pid: 0 }, 101, 0), false);
  for (const override of [
    { autorestart: false },
    { pm_cwd: path.join(root, 'other') },
    { pm_exec_path: path.join(root, 'other.mjs') },
    { args: ['dev'] },
    { args: ['start', '--other'] },
    { args: [] },
  ]) assert.equal(matchesPm2Workspace(root, { ...entry, pm2_env: { ...entry.pm2_env, ...override } }, 101, 100), false);
});

test('主版原有 PM2 身份校验保留，不能通过同名的其他进程冒充', () => {
  const main = { pid: 101, name: 'delivery-workspace', pm2_env: {
    autorestart: true, pm_exec_path: path.join(root, 'server/index.ts'), pm_cwd: root,
  } };
  assert.equal(matchesPm2Workspace(root, main, 101, 100), true);
  assert.equal(matchesPm2Workspace(root, { ...main, pid: 102 }, 101, 100), false);
  assert.equal(matchesPm2Workspace(root, { ...main, name: 'other' }, 101, 100), false);
  assert.equal(matchesPm2Workspace(root, { ...entry, pid: 101 }, 101, 100), false);
});

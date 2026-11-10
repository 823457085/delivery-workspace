import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canSchedule, canonicalSchedulerJob, selectScheduledJobs, type SchedulerJob } from '../server/agent-scheduler.js';
const job = (id: string, overrides: Partial<SchedulerJob> = {}): SchedulerJob => ({ id, provider: 'codex', workspacePath: `/work/${id}`, writer: true, manual: false, ...overrides });

test('未配置并发上限时不限制全局或单执行器并发', () => {
  assert.equal(canSchedule(job('five'), [job('a'), job('b', { provider: 'claude' }), job('c', { provider: 'cursor' }), job('d', { provider: 'claude' })]).allowed, true);
  assert.equal(canSchedule(job('third'), [job('a'), job('b')]).allowed, true);
  const selected = selectScheduledJobs([
    job('team'), job('manual', { manual: true }), job('claude', { provider: 'claude' }),
    job('cursor', { provider: 'cursor' }), job('overflow', { provider: 'claude' }),
  ], []);
  assert.deepEqual(selected.map(item => item.id), ['manual', 'team', 'claude', 'cursor', 'overflow']);
});

test('调用方显式配置并发上限时仍按限制调度', () => {
  assert.equal(canSchedule(job('five'), [job('a'), job('b', { provider: 'claude' }), job('c', { provider: 'cursor' }), job('d', { provider: 'claude' })], [], { global: 4 }).reason, 'global_limit');
  assert.equal(canSchedule(job('third'), [job('a'), job('b')], [], { perProvider: 2 }).reason, 'provider_limit');
  assert.equal(canSchedule(job('nested', { workspacePath: '/work/a/src' }), [job('a')]).reason, 'workspace_busy');
  assert.equal(canSchedule(job('read', { workspacePath: '/work/a', writer: false }), [job('a')]).allowed, true);
  assert.equal(canSchedule(job('team'), [], [job('manual', { manual: true })]).reason, 'manual_priority');
  assert.equal(canSchedule(job('team', { provider: 'claude' }), [job('a'), job('b')], [job('manual', { manual: true })], { global: 4, perProvider: 2 }).allowed, true, '无法启动的手动任务不堵住其他执行器');
  const selected = selectScheduledJobs([job('team'), job('manual', { manual: true }), job('claude', { provider: 'claude' }), job('cursor', { provider: 'cursor' }), job('overflow', { provider: 'claude' })], [], { global: 4, perProvider: 2 });
  assert.deepEqual(selected.map(item => item.id), ['manual', 'team', 'claude', 'cursor']);
});

test('realpath 消除别名，防止两个会话写同一实际目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-scheduler-'));
  try {
    await fs.mkdir(path.join(root, 'workspace')); await fs.symlink(path.join(root, 'workspace'), path.join(root, 'alias'));
    const original = await canonicalSchedulerJob(job('one', { workspacePath: path.join(root, 'workspace') }));
    const alias = await canonicalSchedulerJob(job('two', { workspacePath: path.join(root, 'alias') }));
    assert.equal(canSchedule(alias, [original]).reason, 'workspace_busy');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('多项目任务的任一工作区有写入者时串行等待，验证副本不锁住原项目', () => {
  const group = job('group', { workspacePath: '/work/web-task', workspacePaths: ['/work/web-task', '/work/api-task'] });
  assert.equal(canSchedule(group, [job('api', { provider: 'claude', workspacePath: '/work/api-task/src' })]).reason, 'workspace_busy');
  assert.equal(canSchedule(job('api', { provider: 'claude', workspacePath: '/work/api-task' }), [group]).reason, 'workspace_busy');
  assert.equal(canSchedule(job('verification', { workspacePath: '/copy/web', workspacePaths: ['/copy/api'] }), [group]).allowed, true);
});

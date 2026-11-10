import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { acquireStateServiceLease, assertStateOffline, createStateBackupStore, startPeriodicStateBackup, validateStateJson } from '../server/state-backup.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { emptyRequirementProgress } from '../shared/requirement-development.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';

const exec = promisify(execFile);
const relative = 'agent-runtimes/conversation-titles.json';
const base = path.resolve(import.meta.dirname, '..');
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-state-backup-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function listener() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function offline(directory: string) {
  const server = await listener(); await server.close();
  return { port: server.port, applicationRoot: directory };
}
async function backupPath(directory: string, id: string) {
  return path.join(directory, '.state-backups', Buffer.from(relative).toString('base64url'), id);
}

test('只备份显式清单，跳过工作区、凭据和数据库，并记录逐文件一致性边界', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { conversation: 'fixture title' });
  await fs.mkdir(path.join(directory, 'agent-runtimes/workspaces'), { recursive: true });
  await fs.writeFile(path.join(directory, 'agent-runtimes/workspaces/private.json'), '{"credential":"fixture"}');
  await fs.writeFile(path.join(directory, 'auth.json'), '{"access_token":"fixture"}');
  await fs.writeFile(path.join(directory, 'mastra.db'), 'not a database');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.consistency, 'per-file');
  assert.deepEqual(snapshot.entries.filter(entry => entry.status === 'backed-up').map(entry => entry.path), [relative]);
  assert.ok(snapshot.entries.every(entry => !/workspaces|auth\.json|\.db$/.test(entry.path)));
  assert.equal((await store.list(relative)).length, 1);
  const file = await backupPath(directory, (await store.list(relative))[0].id);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
}));

test('写入保留有效历史版本、同内容去重并限制保留数量', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory, { keep: 2 });
  await store.writeJson(relative, { id: 'one' });
  await store.writeJson(relative, { id: 'two' });
  await store.writeJson(relative, { id: 'three' });
  await store.writeJson(relative, { id: 'three' });
  const entries = await store.list(relative);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.valid));
  const contents = await Promise.all(entries.map(async entry => JSON.parse(await fs.readFile(await backupPath(directory, entry.id), 'utf8')).content));
  assert.deepEqual(contents.map(content => JSON.parse(content).id).sort(), ['three', 'two']);
}));

test('两个独立 store 并行快照清理同一旧副本时均成功且副本可校验', async context => fixture(async directory => {
  const stores = await Promise.all([createStateBackupStore(directory), createStateBackupStore(directory)]);
  for (let index = 0; index < 5; index++) await stores[0].writeJson(relative, { id: `seed-${index}` });
  await fs.writeFile(path.join(directory, relative), JSON.stringify({ id: 'current' }));
  const previous = await stores[0].list(relative);
  const oldFile = await backupPath(stores[0].root, previous.at(-1)!.id);
  const folder = path.dirname(oldFile);
  const rename = fs.rename;
  const unlink = fs.unlink;
  let arrivals = 0, release!: () => void;
  let removals = Promise.resolve(), oldRemovals = 0;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const timeout = setTimeout(release, 2000);
  // 两个实例都读取同一历史列表后才允许发布新副本，确定性覆盖同一旧文件被重复清理。
  const gate = context.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (path.dirname(String(to)) === folder) {
      if (++arrivals === 2) release();
      await ready;
    }
    return rename(from, to);
  });
  const deletion = context.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
    if (String(file) !== oldFile) return unlink(file);
    oldRemovals++;
    // 第二次系统调用发生在第一次删除完成后，确保真实返回 ENOENT。
    const removal = removals.then(() => unlink(file));
    removals = removal.catch(() => {});
    return removal;
  });
  try {
    const snapshots = await Promise.all(stores.map(store => store.snapshot()));
    assert.equal(arrivals, 2);
    assert.equal(oldRemovals, 2);
    for (const snapshot of snapshots) {
      const entry = snapshot.entries.find(item => item.path === relative);
      assert.equal(entry?.status, 'backed-up', entry?.error || '并行快照不应失败');
      assert.equal((await stores[0].verify(relative, entry!.backup!.id)).valid, true);
    }
    assert.ok((await stores[0].list(relative)).every(entry => entry.valid));
    assert.deepEqual(await stores[0].readJson(relative), { id: 'current' });
  } finally { clearTimeout(timeout); release(); gate.mock.restore(); deletion.mock.restore(); }
}));

test('清理旧副本时的真实权限和 I/O 故障仍明确报告失败', async context => {
  for (const code of ['EACCES', 'EIO']) await fixture(async directory => {
    const store = await createStateBackupStore(directory, { keep: 1 });
    await store.writeJson(relative, { id: 'previous' });
    const previous = (await store.list(relative))[0];
    const oldFile = await backupPath(store.root, previous.id);
    await fs.writeFile(path.join(directory, relative), JSON.stringify({ id: 'current' }));
    const unlink = fs.unlink;
    const failure = context.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file) === oldFile) throw Object.assign(new Error(`fixture ${code}: old backup deletion failed`), { code });
      return unlink(file);
    });
    try {
      const snapshot = await store.snapshot();
      const entry = snapshot.entries.find(item => item.path === relative);
      assert.equal(entry?.status, 'failed');
      assert.match(entry?.error || '', new RegExp(code));
      assert.equal((await store.verify(relative, previous.id)).valid, true);
      assert.deepEqual(await store.readJson(relative), { id: 'current' });
    } finally { failure.mock.restore(); }
  });
});

test('损坏原件不会被启动读取、快照或下一次写入静默覆盖', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'recoverable' });
  const target = path.join(directory, relative);
  await fs.writeFile(target, '{broken-json');
  await assert.rejects(store.readJson(relative), /原件未覆盖.*可停止服务后恢复备份/);
  await assert.rejects(store.writeJson(relative, { id: 'would overwrite' }), /写入已取消/);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.entries.find(entry => entry.path === relative)?.status, 'failed');
  assert.equal(await fs.readFile(target, 'utf8'), '{broken-json');
  assert.equal((await store.list(relative)).filter(entry => entry.valid).length, 1);
}));

test('JSON 可解析但账本结构错误也拒绝；大小越界不备份', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory, { maxBytes: 40 });
  await assert.rejects(store.writeJson(relative, []), /结构校验失败/);
  await assert.rejects(store.writeJson(relative, { id: 'x'.repeat(60) }), /大小限制/);
  assert.throws(() => validateStateJson('agent-runtimes/agent-runs.json', [{}]), /结构校验失败/);
  assert.throws(() => validateStateJson('agent-runtimes/codex-sessions.json', { sessions: 'broken' }), /结构校验失败/);
  assert.deepEqual(await store.list(relative), []);
}));

test('岗位配置备份兼容旧版 Agent workspace 权限字段', () => {
  const legacy = defaultTeamProfileConfig();
  legacy.profiles = legacy.profiles.map(profile => ({ ...profile,
    accessMode: profile.mode === 'agent' ? 'workspace' : profile.accessMode,
  }));
  assert.doesNotThrow(() => validateStateJson('agent-runtimes/agent-profiles.json', legacy));
});

test('Claude自定义模型可保存并回读备份，未知平台仍拒绝且原件保留', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  const file = 'agent-runtimes/custom-models.json';
  const models = [{ id: randomUUID(), provider: 'claude', modelId: 'sonnet', label: 'Claude 自定义模型' }];
  await store.writeJson(file, models);
  assert.deepEqual(await store.readJson(file), models);
  assert.ok((await store.list(file)).every(entry => entry.valid));
  await assert.rejects(store.writeJson(file, [{ ...models[0], provider: 'unknown' }]), /结构校验失败/);
  assert.deepEqual(await store.readJson(file), models);
}));

test('校验识别被篡改备份，latest 恢复跳过坏副本并完整保留损坏原件', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'previous valid' });
  await store.writeJson(relative, { id: 'latest' });
  const [latest, previous] = await store.list(relative);
  const file = await backupPath(directory, latest.id);
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  envelope.content = '{"id":"tampered"}';
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(store.verify(relative, latest.id), /SHA256/);
  const corrupt = Buffer.from([0, 1, 2, 255, 13, 10]);
  await fs.writeFile(path.join(directory, relative), corrupt);
  const result = await store.restore(relative, 'latest', await offline(directory));
  assert.equal(result.backup, previous.id);
  assert.deepEqual(await store.readJson(relative), { id: 'previous valid' });
  assert.ok(result.original);
  assert.deepEqual(await fs.readFile(path.join(directory, result.original!, 'original')), corrupt);
  assert.ok((await store.list(relative)).some(entry => entry.id === latest.id && !entry.valid));
}));

test('误删的原件仍可列出并离线恢复', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  const record = `jira-fix/${'a'.repeat(36)}.json`;
  const value = { id: 'a'.repeat(36), status: 'uncertain', createdAt: '2026-01-01', input: {} };
  await store.writeJson(record, value);
  await fs.unlink(path.join(directory, record));
  assert.ok((await store.managedFiles()).includes(record));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.entries.find(entry => entry.path === record)?.status, 'failed');
  await assert.rejects(store.readJson(record), /可停止服务后恢复备份/);
  await assert.rejects(store.writeJson(record, value), /已缺失但存在历史备份/);
  const result = await store.restore(record, 'latest', await offline(directory));
  assert.equal(result.original, undefined);
  assert.deepEqual(await store.readJson(record), value);
}));

test('复制原件时 ENOENT 不会被误当成初始缺失，恢复必须停止且原件不变', async context => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'previous' });
  const older = (await store.list(relative))[0].id;
  await store.writeJson(relative, { id: 'current' });
  const before = await fs.readFile(path.join(directory, relative));
  const copy = context.mock.method(fs, 'copyFile', async () => {
    throw Object.assign(new Error('fixture: preservation destination missing'), { code: 'ENOENT' });
  });
  try { await assert.rejects(store.restore(relative, older, await offline(directory)), /preservation destination missing/); }
  finally { copy.mock.restore(); }
  assert.deepEqual(await fs.readFile(path.join(directory, relative)), before);
  const release = await acquireStateServiceLease(directory); await release();
}));

test('主文件丢失且历史副本均损坏时不能静默初始化，CLI 快照非零退出', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'saved' });
  const file = await backupPath(directory, (await store.list(relative))[0].id);
  await fs.writeFile(file, '{broken backup');
  await fs.unlink(path.join(directory, relative));
  await assert.rejects(store.readJson(relative), /没有已校验的备份可用/);
  await assert.rejects(store.writeJson(relative, {}), /已缺失但存在历史备份/);
  await assert.rejects(exec(process.execPath,
    ['--import', 'tsx', 'scripts/state-backup.ts', 'snapshot', '--data-dir', directory], { cwd: base }), error => {
    assert.equal((error as { code: number }).code, 1);
    const manifest = JSON.parse((error as { stdout: string }).stdout);
    assert.equal(manifest.entries.find((entry: { path: string }) => entry.path === relative).status, 'failed');
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken backup');
}));

test('需求进度备份兼容旧记录并拒绝业务服务不能读取的畸形新字段', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  const file = `requirement-development/${'b'.repeat(36)}.json`;
  const legacy = { id: 'b'.repeat(36), status: 'started', createdAt: '2026-10-16T00:00:00Z', input: {} };
  await store.writeJson(file, legacy);
  const valid = { ...legacy, progress: { ...emptyRequirementProgress(), revision: 1,
    updatedAt: '2026-10-16T00:00:00Z', source: 'manual', sourceRunId: 'fixture' } };
  await store.writeJson(file, valid);
  await assert.rejects(store.writeJson(file, { ...legacy, progress: { stages: null } }), /结构校验失败/);
  assert.deepEqual(await store.readJson(file), valid);
  assert.ok((await store.list(file)).every(entry => entry.valid));
}));

test('验收记录复用业务 schema 校验，并验证文件名与 recordId 一致', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  const recordId = 'agent:fixture';
  const file = `delivery-acceptance/${createHash('sha256').update(recordId).digest('hex')}.json`;
  const value = { recordId, source: { runId: 'fixture', updatedAt: '2026-10-16T00:00:00Z' }, checks: emptyDeliveryEvidence(),
    decision: 'pending', summary: '', revision: 1, updatedAt: '2026-10-16T00:00:00Z' };
  await store.writeJson(file, value);
  assert.ok((await store.managedFiles()).includes(file));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.entries.find(entry => entry.path === file)?.status, 'backed-up');
  await assert.rejects(store.writeJson(file, { ...value, decision: 'accepted' }), /结构校验失败/);
  await assert.rejects(store.writeJson(`delivery-acceptance/${'a'.repeat(64)}.json`, value), /结构校验失败/);
}));

test('交接草稿只纳入准确的事项和运行文件名，校验来源结构并可离线恢复', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  const recordId = randomUUID(), runId = randomUUID();
  const file = `jira-fix-handoffs/${recordId}.${runId}.draft.json`;
  const value = { recordId, runId, sourceFingerprint: 'a'.repeat(64), updatedAt: '2026-10-16T00:00:00Z',
    draft: { cause: '根因', impact: '范围', suggestion: '回归建议', conclusion: '定向检查通过，浏览器未验证' } };
  await store.writeJson(file, value);
  await fs.writeFile(path.join(directory, 'jira-fix-handoffs', `${recordId}.draft.json`), '{}');
  await fs.writeFile(path.join(directory, `${file}.tmp`), '{}');
  const managed = await store.managedFiles();
  assert.ok(managed.includes(file));
  assert.equal(managed.some(item => item.endsWith(`${recordId}.draft.json`) || item.endsWith('.tmp')), false);
  assert.equal((await store.snapshot()).entries.find(entry => entry.path === file)?.status, 'backed-up');
  await assert.rejects(store.writeJson(file, { ...value, sourceFingerprint: '' }), /结构校验失败/);
  await assert.rejects(store.writeJson(file, { ...value, runId: randomUUID() }), /结构校验失败/);
  await assert.rejects(store.writeJson(`jira-fix-handoffs/${recordId}.draft.json`, value), /清单/);
  await assert.rejects(store.writeJson(`other/${recordId}.${runId}.draft.json`, value), /清单/);
  await fs.writeFile(path.join(directory, file), '{broken-json');
  await store.restore(file, 'latest', await offline(directory));
  assert.deepEqual(await store.readJson(file), value);
}));

test('路径穿越、未列入清单的文件和符号链接不能被读写或备份', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await assert.rejects(store.writeJson('../auth.json', {}), /清单/);
  await assert.rejects(store.readJson('auth.json'), /清单/);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'conversation-titles.json'), '{"id":"original"}');
  await fs.symlink(outside, path.join(directory, 'agent-runtimes'));
  await assert.rejects(store.writeJson(relative, { id: 'new' }), /符号链接/);
  assert.equal(await fs.readFile(path.join(outside, 'conversation-titles.json'), 'utf8'), '{"id":"original"}');
}));

test('服务 lease 互斥，服务运行时恢复拒绝且原件保持不变', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'saved' });
  const release = await acquireStateServiceLease(directory);
  try {
    await assert.rejects(acquireStateServiceLease(directory), /拒绝并发/);
    await assert.rejects(store.restore(relative, 'latest', await offline(directory)), /仍在运行/);
    assert.deepEqual(await store.readJson(relative), { id: 'saved' });
  } finally { await release(); }
  const again = await acquireStateServiceLease(directory); await again();
}));

test('没有新 lease 的旧服务监听端口时仍拒绝恢复', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'saved' });
  const server = await listener();
  try { await assert.rejects(store.restore(relative, 'latest', { port: server.port, applicationRoot: directory }), /仍有服务监听/); }
  finally { await server.close(); }
}));

test('旧执行器锁和异常锁也阻止离线恢复', async () => fixture(async directory => {
  await fs.mkdir(path.join(directory, 'design-executor'));
  const lock = path.join(directory, 'design-executor/executor.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  const options = await offline(directory);
  await assert.rejects(assertStateOffline(directory, options), /执行器仍在运行/);
  await fs.writeFile(lock, '{}');
  await assert.rejects(assertStateOffline(directory, options), /PID 不合法/);
  assert.equal(await fs.readFile(lock, 'utf8'), '{}');
}));

test('死 PID lease 允许下一次启动并留存旧锁', async () => fixture(async directory => {
  const { stdout } = await exec(process.execPath, ['-e', 'console.log(process.pid)']);
  await fs.writeFile(path.join(directory, '.state-access.json'), JSON.stringify({ pid: Number(stdout.trim()), token: 'old' }));
  const release = await acquireStateServiceLease(directory);
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('.state-access.json.stale-')));
  await release();
}));

test('周期快照不重叠，停止等待在途任务且错误可见', async () => {
  let calls = 0;
  let finish!: () => void;
  const blocker = new Promise<void>(resolve => { finish = resolve; });
  const errors: unknown[] = [];
  const stop = startPeriodicStateBackup({ snapshot: async () => {
    calls++; await blocker;
    return { version: 1, startedAt: '', finishedAt: '', consistency: 'per-file', entries: [{ path: relative, status: 'failed', error: 'fixture corrupt' }] };
  } }, { intervalMs: 5, onError: error => errors.push(error) });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(stopped, false);
  finish(); await stopping;
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /fixture corrupt/);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
});

test('CLI 在隔离目录中列出、校验；坏编号非零退出且不输出内容', async () => fixture(async directory => {
  const store = await createStateBackupStore(directory);
  await store.writeJson(relative, { id: 'private fixture content' });
  const run = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', 'scripts/state-backup.ts', ...args, '--data-dir', directory], { cwd: base });
  const listed = await run('list', relative);
  assert.equal(JSON.parse(listed.stdout).length, 1);
  assert.ok(!listed.stdout.includes('private fixture content'));
  const verified = await run('verify', relative, 'latest');
  assert.equal(JSON.parse(verified.stdout).valid, true);
  await assert.rejects(run('verify', relative, '../../escape'), error => {
    assert.equal((error as { code: number }).code, 1); return true;
  });
}));

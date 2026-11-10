import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCursorAccountsService, cursorAccountLoginUrl } from '../server/cursor-accounts.js';

async function fixture(cancelWaitMs = 200) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-accounts-api-'));
  const script = path.join(directory, 'bridge.mjs');
  const count = path.join(directory, 'inspects');
  await fs.writeFile(script, `
import fs from 'node:fs';
const [command, name] = process.argv.slice(2);
const emit = value => console.log(JSON.stringify(value));
if (command === 'inspect') {
  fs.appendFileSync(${JSON.stringify(count)}, 'i');
  emit({type:'snapshot', available:true, accounts:[{name:'work',email:'work@example.test',team:'Team',
      displayName:'测试账号',identity:'fixture-user|team:1',credentials:{accessToken:'never-forward'},refreshToken:'never-forward'}],
    current:{email:'work@example.test',team:'Team',verified:true,displayName:'测试账号',identity:'fixture-user|team:1',
      token:'never-forward',accessToken:'never-forward'},pendingRecovery:false,activePids:[],blockedReason:'',checkedAt:'2026-10-20'});
} else if (name === 'failure') {
  console.log('raw-secret-diagnostic');
  console.error('stderr-secret');
  emit({type:'error',message:'测试操作失败'}); process.exitCode = 1;
} else if (name === 'overflow') {
  process.on('SIGINT',()=>process.exit(130));
  console.log('x'.repeat(70000)); setInterval(()=>{},1000);
} else if (command === 'login') {
  if(process.env.NO_OPEN_BROWSER !== '1') process.exit(9);
  process.on('SIGINT',()=>{emit({type:'login',url:'https://cursor.com/loginDeepControl?challenge=late'});setTimeout(()=>{emit({type:'result',message:'已取消登录'});process.exit(130)},80)});
  emit({type:'login',url:'https://cursor.com.evil.example/loginDeepControl?challenge=unsafe'});
  emit({type:'login',url:'https://cursor.com/loginDeepControl?challenge=test-only'});
  setInterval(()=>{},1000);
} else emit({type:'result',message:'测试操作完成'});
`);
  let maintenance = 0;
  const runtime = { async withProviderMaintenance<T>(_provider: 'codex' | 'cursor' | 'claude', callback: () => Promise<T>) {
    maintenance++;
    try { return await callback(); } finally { maintenance--; }
  } };
  const service = createCursorAccountsService(runtime, { bridgeCommand: [process.execPath, script], cancelWaitMs });
  return { service, count, maintenance: () => maintenance, cleanup: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('fixture did not settle');
}

test('账号快照仅返回白名单摘要；独立登录轮询不发起 inspect 或维护，取消等待退出并刷新', async () => {
  const f = await fixture();
  try {
    const first = await f.service.dashboard();
    assert.deepEqual(first.accounts, [{ name: 'work', email: 'work@example.test', team: 'Team',
      displayName: '测试账号', identity: 'fixture-user|team:1' }]);
    assert.deepEqual(first.current, { email: 'work@example.test', team: 'Team', verified: true,
      displayName: '测试账号', identity: 'fixture-user|team:1' });
    assert.ok(!JSON.stringify(first).includes('never-forward'));
    const started = await f.service.start('login', 'personal');
    assert.equal(started.operation?.status, 'running');
    await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
    assert.equal((await f.service.dashboard(true)).operation?.loginUrl, 'https://cursor.com/loginDeepControl?challenge=test-only');
    assert.equal(await fs.readFile(f.count, 'utf8'), 'i');
    assert.equal(f.maintenance(), 0);
    await assert.rejects(f.service.start('save', 'another'), /另一个/);
    const cancelled = await f.service.cancel(started.operation!.id);
    assert.equal(cancelled.operation?.status, 'cancelled');
    assert.equal(cancelled.operation?.message, '已取消登录');
    assert.equal(cancelled.operation?.loginUrl, undefined);
    assert.equal(f.maintenance(), 0);
    assert.equal(await fs.readFile(f.count, 'utf8'), 'ii');
  } finally { await f.cleanup(); }
});

test('账号变更失败和输出超限不返回原始 stdout 或 stderr，并释放互斥', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.start('use', '../bad'), /名称/);
    await f.service.start('use', 'failure');
    await until(async () => (await f.service.dashboard()).operation?.status === 'failed');
    const failed = await f.service.dashboard();
    assert.equal(failed.operation?.message, '测试操作失败');
    assert.ok(!JSON.stringify(failed).includes('secret'));
    await f.service.start('use', 'overflow');
    await until(async () => (await f.service.dashboard()).operation?.status === 'failed');
    assert.match((await f.service.dashboard()).operation!.message, /超出限制/);
    assert.equal(f.maintenance(), 0);
    await f.service.start('save', 'work');
    await until(async () => (await f.service.dashboard()).operation?.status === 'succeeded');
  } finally { await f.cleanup(); }
});

test('取消等待超时保留账号互斥，迟到的登录链接不会重新出现', async () => {
  const f = await fixture(1);
  try {
    const started = await f.service.start('login', 'personal');
    await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
    const cancelling = await f.service.cancel(started.operation!.id);
    assert.equal(cancelling.operation?.status, 'running');
    assert.match(cancelling.operation!.message, /正在取消/);
    assert.equal(f.maintenance(), 0);
    await assert.rejects(f.service.start('save', 'another'), /另一个/);
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const during = await f.service.dashboard();
      assert.equal(during.operation?.loginUrl, undefined);
    }
    await until(async () => (await f.service.dashboard()).operation?.status === 'cancelled');
    assert.equal(f.maintenance(), 0);
  } finally { await f.cleanup(); }
});

test('服务关闭只取消自己创建的登录，并等登录退出', async () => {
  const f = await fixture();
  try {
    await f.service.start('login', 'personal');
    await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
    await f.service.close();
    assert.equal((await f.service.dashboard()).operation?.status, 'cancelled');
    assert.equal(f.maintenance(), 0);
    await assert.rejects(f.service.start('save', 'work'), /退出/);
  } finally { await f.cleanup(); }
});

test('保存账号等待已开始的inspect完成，并保持服务互斥且不暂停Agent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'account-inspect-order-'));
  const script = path.join(directory, 'bridge.mjs');
  const trace = path.join(directory, 'trace');
  const release = path.join(directory, 'release');
  await fs.writeFile(script, `
import fs from 'node:fs';
const [action] = process.argv.slice(2);
const trace = value => fs.appendFileSync(${JSON.stringify(trace)}, value+'\\n');
const emit = value => console.log(JSON.stringify(value));
if (action === 'inspect') {
  trace('inspect-start');
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
  trace('inspect-finish');
  emit({type:'snapshot',available:true,accounts:[],current:null,pendingRecovery:false,
    activePids:[9214],blockedReason:'已有任务运行，仅禁止切换',checkedAt:'fixture'});
} else { trace(action); emit({type:'result',message:'已保存账号副本'}); }
`);
  const service = createCursorAccountsService({
    async withProviderMaintenance() { throw new Error('保存不应进入维护'); },
  }, { bridgeCommand: [process.execPath, script] });
  try {
    const inspect = service.dashboard(true);
    await until(async () => (await fs.readFile(trace, 'utf8').catch(() => '')) === 'inspect-start\n');
    await service.start('save', 'work');
    await assert.rejects(service.start('login', 'personal'), /另一个/);
    assert.equal((await service.dashboard(true)).operation?.status, 'running');
    assert.equal(await fs.readFile(trace, 'utf8'), 'inspect-start\n');
    await fs.writeFile(release, '');
    await inspect;
    await until(async () => (await service.dashboard()).operation?.status === 'succeeded');
    assert.match(await fs.readFile(trace, 'utf8'), /^inspect-start\ninspect-finish\nsave\n/);
  } finally {
    await fs.writeFile(release, '');
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('官方登录链接严格限制 scheme、host、路径、用户信息和 fragment', () => {
  for (const value of ['http://cursor.com/loginDeepControl', 'https://cursor.com.evil.test/loginDeepControl',
    'https://cursor.com:444/loginDeepControl', 'https://user@cursor.com/loginDeepControl', 'https://cursor.com/loginDeepControl#secret',
    'https://cursor.com/other', 'javascript:alert(1)', 'https://cursor.com/loginDeepControl/' ]) assert.equal(cursorAccountLoginUrl(value), undefined);
  assert.equal(cursorAccountLoginUrl('https://cursor.com/loginDeepControl?challenge=test'), 'https://cursor.com/loginDeepControl?challenge=test');
});

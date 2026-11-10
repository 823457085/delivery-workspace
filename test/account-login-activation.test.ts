import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCursorAccountsService } from '../server/cursor-accounts.js';
import { accountProviders, type AccountProvider, type CursorAccountOperation } from '../shared/cursor-accounts.js';

type Mode = 'complete' | 'wait-login' | 'wait-saved' | 'wait-use' | 'fail-use' | 'rollback-failed' | 'invalid-slot';
interface FixtureOptions {
  provider?: AccountProvider;
  mode?: Mode;
  maintenanceError?: string;
  maintenanceGate?: Promise<void>;
  maintenanceExitGate?: Promise<void>;
  desktopResult?: NonNullable<CursorAccountOperation['desktop']>;
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'account-login-activation-'));
  const script = path.join(directory, 'bridge.mjs');
  const tracePath = path.join(directory, 'trace');
  const releasePath = path.join(directory, 'release');
  const provider = options.provider || 'codex';
  await fs.writeFile(script, `
import fs from 'node:fs';
const [action, name] = process.argv.slice(2);
const directory = ${JSON.stringify(directory)}, mode = ${JSON.stringify(options.mode || 'complete')};
const statePath = directory + '/state';
const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {saved:false,activated:false,pending:false};
const write = value => fs.writeFileSync(statePath, JSON.stringify(value));
const trace = value => fs.appendFileSync(directory + '/trace', value + '\\n');
const emit = value => console.log(JSON.stringify(value));
const account = {name:'canonical-slot',email:'added@example.test',team:'fixture'};
const wait = async () => { while (!fs.existsSync(directory + '/release')) await new Promise(resolve => setTimeout(resolve, 5)); };
trace(action + ':' + (name || ''));
if (action === 'inspect') {
  const state = read();
  emit({type:'snapshot',available:true,accounts:state.saved ? [account] : [],
    current:{email:state.activated ? account.email : 'original@example.test',team:'fixture',verified:!state.pending},
    pendingRecovery:state.pending,activePids:[],blockedReason:state.pending ? '请先恢复原账号' : '',checkedAt:'fixture'});
} else if (action === 'login') {
  process.on('SIGINT',()=>{emit({type:'result',message:'已取消添加，当前账号未改变'});process.exit(130)});
  const urls = {codex:'https://auth.openai.com/oauth/authorize?state=fixture',cursor:'https://cursor.com/loginDeepControl?challenge=fixture',claude:'https://claude.ai/oauth/authorize?state=fixture'};
  emit({type:'login',url:urls[${JSON.stringify(provider)}]});
  if (mode === 'wait-login') await wait();
  write({...read(),saved:true});
  trace('saved:canonical-slot');
  emit({type:'result',message:'已保存账号，当前账号未改变',accountName:mode === 'invalid-slot' ? '../invalid' : 'canonical-slot',
    accessToken:'fixture-secret-never-forward',credentials:{token:'fixture-secret-never-forward'}});
  if (mode === 'wait-saved') await wait();
} else if (action === 'use') {
  process.on('SIGINT',()=>{write({...read(),activated:false});emit({type:'result',message:'已取消启用并恢复原账号'});process.exit(130)});
  if (name !== 'canonical-slot') {emit({type:'error',message:'使用了错误的账号名称'});process.exit(1)};
  if (mode === 'wait-use') await wait();
  if (mode === 'fail-use' || mode === 'rollback-failed') {
    write({...read(),activated:mode === 'rollback-failed',pending:mode === 'rollback-failed'});
    emit({type:'error',message:mode === 'rollback-failed' ? '切换回滚未完成，请先恢复原账号' : '启用验证失败，已恢复原账号'});
    process.exit(1);
  }
  write({...read(),saved:true,activated:true});
  trace('activated:canonical-slot');
  emit({type:'result',message:'已切换本机登录账号'});
} else emit({type:'result',message:'测试操作完成'});
`);
  let maintenanceDepth = 0;
  const maintenance: string[] = [];
  const desktops: number[] = [];
  const service = createCursorAccountsService({
    async withProviderMaintenance<T>(target: AccountProvider, action: () => Promise<T>) {
      maintenance.push(target);
      if (options.maintenanceError) throw new Error(options.maintenanceError);
      maintenanceDepth++;
      try {
        await options.maintenanceGate;
        return await action();
      } finally {
        await options.maintenanceExitGate;
        maintenanceDepth--;
      }
    },
  }, { provider, bridgeCommand: [process.execPath, script], cancelWaitMs: 10,
    ...(options.desktopResult ? { openDesktop: async () => { desktops.push(maintenanceDepth); return options.desktopResult!; } } : {}) });
  return { service, maintenance, desktops,
    trace: () => fs.readFile(tracePath, 'utf8').catch(() => ''),
    release: () => fs.writeFile(releasePath, ''),
    cleanup: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('fixture did not settle');
}
const settled = (f: Awaited<ReturnType<typeof fixture>>) => until(async () => !!(await f.service.dashboard()).operation?.finishedAt);

test('三个平台完成隔离登录后才进入维护，并使用去重后的真实slot启用CLI', async () => {
  for (const provider of accountProviders) {
    const f = await fixture({ provider, mode: 'wait-login' });
    try {
      await f.service.start('login', 'requested-alias');
      await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
      assert.deepEqual(f.maintenance, []);
      await assert.rejects(f.service.start('save', 'other'), /另一个/);
      await f.release();
      await settled(f);
      const final = await f.service.dashboard();
      assert.equal(final.operation?.status, 'succeeded');
      assert.equal(final.operation?.savedAccountName, 'canonical-slot');
      assert.equal(final.operation?.activation?.status, 'succeeded');
      assert.equal(final.operation?.loginUrl, undefined);
      assert.equal(final.current?.email, 'added@example.test');
      assert.deepEqual(f.maintenance, [provider]);
      assert.match(await f.trace(), /saved:canonical-slot\nuse:canonical-slot\nactivated:canonical-slot/);
      assert.ok(!JSON.stringify(final).includes('fixture-secret'));
    } finally { await f.cleanup(); }
  }
});

test('运行中任务拒绝维护时保留已保存账号并回报部分成功，不启动use或桌面授权', async () => {
  const f = await fixture({ maintenanceError: '仍有 Codex 任务正在运行或排队', desktopResult: { status: 'opened', message: '桌面已打开' } });
  try {
    await f.service.start('login', 'requested-alias');
    await settled(f);
    const final = await f.service.dashboard();
    assert.equal(final.operation?.status, 'partial');
    assert.equal(final.operation?.savedAccountName, 'canonical-slot');
    assert.equal(final.operation?.activation?.status, 'failed');
    assert.match(final.operation!.message, /账号已保存.*任务正在运行/);
    assert.equal(final.accounts[0].name, 'canonical-slot');
    assert.equal(final.current?.email, 'original@example.test');
    assert.ok(!(await f.trace()).includes('use:'));
    assert.deepEqual(f.desktops, []);
  } finally { await f.cleanup(); }
});

test('CLI启用失败保留保存结果，回滚失败的恢复标记可继续回读', async () => {
  for (const mode of ['fail-use', 'rollback-failed'] as const) {
    const f = await fixture({ mode });
    try {
      await f.service.start('login', 'requested-alias');
      await settled(f);
      const final = await f.service.dashboard();
      assert.equal(final.operation?.status, 'partial');
      assert.equal(final.operation?.savedAccountName, 'canonical-slot');
      assert.equal(final.operation?.activation?.status, 'failed');
      assert.equal(final.accounts.length, 1);
      assert.equal(final.pendingRecovery, mode === 'rollback-failed');
      assert.equal(final.current?.email, mode === 'rollback-failed' ? 'added@example.test' : 'original@example.test');
    } finally { await f.cleanup(); }
  }
});

test('收到保存回执后取消不会声称未保存，也不会继续启用CLI', async () => {
  const f = await fixture({ mode: 'wait-saved' });
  try {
    const started = await f.service.start('login', 'requested-alias');
    await until(async () => !!(await f.service.dashboard()).operation?.savedAccountName);
    await f.service.cancel(started.operation!.id);
    await settled(f);
    const final = await f.service.dashboard();
    assert.equal(final.operation?.status, 'partial');
    assert.equal(final.operation?.savedAccountName, 'canonical-slot');
    assert.match(final.operation!.message, /账号已保存.*已取消后续启用/);
    assert.equal(final.accounts.length, 1);
    assert.equal(final.current?.email, 'original@example.test');
    assert.deepEqual(f.maintenance, []);
    assert.ok(!(await f.trace()).includes('use:'));
  } finally { await f.cleanup(); }
});

test('等待维护或启用进行中取消始终保留服务互斥与账号保存结果', async () => {
  let releaseMaintenance!: () => void;
  const gate = new Promise<void>(resolve => { releaseMaintenance = resolve; });
  const f = await fixture({ maintenanceGate: gate });
  try {
    const started = await f.service.start('login', 'requested-alias');
    await until(async () => f.maintenance.length === 1);
    const cancelling = await f.service.cancel(started.operation!.id);
    assert.equal(cancelling.operation?.status, 'running');
    await assert.rejects(f.service.start('save', 'other'), /另一个/);
    releaseMaintenance();
    await settled(f);
    assert.equal((await f.service.dashboard()).operation?.status, 'partial');
    assert.ok(!(await f.trace()).includes('use:'));
  } finally { releaseMaintenance(); await f.cleanup(); }

  const using = await fixture({ mode: 'wait-use' });
  try {
    const started = await using.service.start('login', 'requested-alias');
    await until(async () => (await using.trace()).includes('use:canonical-slot'));
    await using.service.cancel(started.operation!.id);
    await settled(using);
    const final = await using.service.dashboard();
    assert.equal(final.operation?.status, 'partial');
    assert.equal(final.operation?.savedAccountName, 'canonical-slot');
    assert.match(final.operation!.activation!.message, /已取消启用并恢复/);
    assert.equal(final.current?.email, 'original@example.test');
  } finally { await using.cleanup(); }
});

test('保存回执名称不合法时不会猜测请求别名启用账号', async () => {
  const f = await fixture({ mode: 'invalid-slot' });
  try {
    await f.service.start('login', 'requested-alias');
    await settled(f);
    const final = await f.service.dashboard();
    assert.equal(final.operation?.status, 'partial');
    assert.equal(final.operation?.savedAccountName, undefined);
    assert.equal(final.operation?.activation?.status, 'failed');
    assert.ok(!JSON.stringify(final.operation).includes('../invalid'));
    assert.deepEqual(f.maintenance, []);
    assert.ok(!(await f.trace()).includes('use:'));
  } finally { await f.cleanup(); }
});

test('Cursor登录与切换均在CLI启用且维护结束后打开桌面，桌面结果不会伪装为已登录', async () => {
  for (const action of ['login', 'use'] as const) {
    for (const status of ['opened', 'failed', 'skipped'] as const) {
      const desktop = { status, message: status === 'opened' ? '桌面已打开，请在官方应用完成登录' : '桌面未打开' };
      const f = await fixture({ provider: 'cursor', desktopResult: desktop });
      try {
        await f.service.start(action, action === 'login' ? 'requested-alias' : 'canonical-slot');
        await settled(f);
        const final = await f.service.dashboard();
        assert.equal(final.operation?.status, status === 'opened' ? 'succeeded' : 'partial');
        assert.equal(final.operation?.activation?.status, 'succeeded');
        assert.deepEqual(final.operation?.desktop, desktop);
        assert.deepEqual(f.desktops, [0]);
        assert.equal(final.current?.email, 'added@example.test');
        if (status === 'opened') assert.match(final.operation!.message, /完成登录/);
      } finally { await f.cleanup(); }
    }
  }
});

test('Codex登录与切换只启用CLI，即使配置桌面hook也不会调用或影响登录结果', async () => {
  for (const action of ['login', 'use'] as const) {
    const f = await fixture({ desktopResult: { status: 'failed', message: '桌面登录失败不应参与CLI流程' } });
    try {
      await f.service.start(action, action === 'login' ? 'requested-alias' : 'canonical-slot');
      await settled(f);
      const final = await f.service.dashboard();
      assert.equal(final.operation?.status, 'succeeded');
      assert.equal(final.operation?.activation?.status, 'succeeded');
      assert.equal(final.operation?.desktop, undefined);
      assert.deepEqual(f.desktops, []);
      assert.equal(final.current?.email, 'added@example.test');
      let manualCalls = 0;
      await f.service.withDesktopOpen(async () => { manualCalls++; });
      assert.equal(manualCalls, 1);
    } finally { await f.cleanup(); }
  }
});

test('CLI已启用后取消桌面步骤不会回滚或否认已完成的CLI切换', async () => {
  let releaseMaintenance!: () => void;
  const gate = new Promise<void>(resolve => { releaseMaintenance = resolve; });
  const f = await fixture({ provider: 'cursor', maintenanceExitGate: gate, desktopResult: { status: 'opened', message: '桌面已打开' } });
  try {
    const started = await f.service.start('login', 'requested-alias');
    await until(async () => (await f.service.dashboard()).operation?.activation?.status === 'succeeded');
    assert.equal((await f.service.dashboard()).operation?.status, 'running');
    await f.service.cancel(started.operation!.id);
    releaseMaintenance();
    await settled(f);
    const final = await f.service.dashboard();
    assert.equal(final.operation?.status, 'partial');
    assert.equal(final.operation?.activation?.status, 'succeeded');
    assert.equal(final.operation?.desktop?.status, 'skipped');
    assert.equal(final.current?.email, 'added@example.test');
    assert.deepEqual(f.desktops, []);
  } finally { releaseMaintenance(); await f.cleanup(); }
});

test('Cursor CLI登录进行中拒绝其他窗口手动打开桌面，但登录完成后的自动hook仍能执行', async () => {
  const f = await fixture({ provider: 'cursor', mode: 'wait-login', desktopResult: { status: 'opened', message: '已打开桌面，等待授权' } });
  let manualCalls = 0;
  try {
    await f.service.start('login', 'requested-alias');
    await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
    await assert.rejects(f.service.withDesktopOpen(async () => { manualCalls++; }), /另一个账号管理操作/);
    assert.equal(manualCalls, 0);
    assert.equal(f.service.isIdle(), false);
    await f.release();
    await settled(f);
    assert.deepEqual(f.desktops, [0]);
    assert.equal((await f.service.dashboard()).operation?.desktop?.status, 'opened');
    assert.equal(f.service.isIdle(), true);
  } finally { await f.cleanup(); }
});

test('手动桌面操作占据账号互斥，结束后才允许新登录且关闭服务等待它结束', async () => {
  const f = await fixture();
  let releaseDesktop!: () => void;
  const gate = new Promise<void>(resolve => { releaseDesktop = resolve; });
  let opened = false, closed = false;
  try {
    const desktop = f.service.withDesktopOpen(async () => { opened = true; await gate; return 'opened'; });
    await until(async () => opened);
    assert.equal(f.service.isIdle(), false);
    await assert.rejects(f.service.start('login', 'requested-alias'), /另一个账号管理操作/);
    await assert.rejects(f.service.withDesktopOpen(async () => 'second'), /另一个账号管理操作/);
    await f.service.dashboard(true);
    assert.equal(await f.trace(), '');
    const closing = f.service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closed, false);
    await assert.rejects(f.service.withDesktopOpen(async () => 'late'), /工作台正在退出/);
    releaseDesktop();
    assert.equal(await desktop, 'opened');
    await closing;
    assert.equal(closed, true);
    assert.equal(f.service.isIdle(), true);
  } finally { releaseDesktop(); await f.cleanup(); }
});

test('手动桌面操作等待在途账号读取，异常只返回固定提示并释放互斥', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-account-inspect-'));
  const script = path.join(directory, 'bridge.mjs');
  const release = path.join(directory, 'release');
  const trace = path.join(directory, 'trace');
  await fs.writeFile(script, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(trace)}, 'inspecting');
while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
console.log(JSON.stringify({type:'snapshot',available:true,accounts:[],current:null,pendingRecovery:false,
  activePids:[],blockedReason:'',checkedAt:'fixture'}));
`);
  const service = createCursorAccountsService({ async withProviderMaintenance(_provider, action) { return action(); } },
    { bridgeCommand: [process.execPath, script] });
  let opened = false;
  try {
    const reading = service.dashboard(true);
    await until(async () => (await fs.readFile(trace, 'utf8').catch(() => '')) === 'inspecting');
    const desktop = service.withDesktopOpen(async () => { opened = true; return { result: 'opened' }; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(opened, false);
    await assert.rejects(service.start('login', 'requested-alias'), /另一个账号管理操作/);
    await fs.writeFile(release, '');
    await reading;
    assert.deepEqual(await desktop, { result: 'opened' });
    assert.equal(opened, true);
    assert.equal(service.isIdle(), true);
    await assert.rejects(service.withDesktopOpen(async () => { throw new Error('fixture-secret-never-forward'); }),
      { message: '桌面应用未能打开，请稍后重试' });
    assert.equal(service.isIdle(), true);
    assert.equal(await service.withDesktopOpen(async () => 'next'), 'next');
  } finally {
    await fs.writeFile(release, '');
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

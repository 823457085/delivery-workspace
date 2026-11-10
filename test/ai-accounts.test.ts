import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCursorAccountsService } from '../server/cursor-accounts.js';
import { accountProviders, trustedAccountLoginUrl, type AccountProvider } from '../shared/cursor-accounts.js';

const targets = {
  cursor: 'https://cursor.com/loginDeepControl?challenge=fixture',
  codex: 'https://auth.openai.com/codex/device',
  claude: 'https://claude.com/cai/oauth/authorize?state=fixture',
};
async function fixture(provider: AccountProvider, unavailable = false, maintenanceError = '') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-accounts-api-'));
  const script = path.join(directory, 'bridge.mjs');
  await fs.writeFile(script, `
const [provider, action, name] = process.argv.slice(2);
const emit = value => console.log(JSON.stringify(value));
if (action === 'inspect') emit({type:'snapshot',provider:'wrong-provider',available:${!unavailable},
  accounts:[{name:'work',email:provider+'@example.test',team:provider}],current:null,pendingRecovery:false,activePids:[],
  blockedReason:${JSON.stringify(unavailable ? '未找到 Claude Code CLI' : '')},checkedAt:'fixture'});
else if (action === 'login') {
  process.on('SIGINT',()=>{emit({type:'result',message:'已取消 '+provider+' 登录'});process.exit(130)});
  emit({type:'login',url:${JSON.stringify(targets)}[provider],code:'ABCD-EFGH'});
  setInterval(()=>{},1000);
} else emit({type:'result',message:'已完成 '+provider+' '+action+' '+(name||'')});
`);
  const maintenance: string[] = [];
  const runtime = { async withProviderMaintenance<T>(selected: AccountProvider, action: () => Promise<T>) {
    maintenance.push(selected);
    if (maintenanceError) throw new Error(maintenanceError);
    return action();
  } };
  const service = createCursorAccountsService(runtime, { provider, bridgeCommand: [process.execPath, script, provider] });
  return { service, maintenance, cleanup: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('fixture did not settle');
}

test('三个账号平台保存副本不进入维护，切换和恢复均进入Agent维护门禁', async () => {
  for (const provider of accountProviders) {
    const f = await fixture(provider);
    try {
      const dashboard = await f.service.dashboard();
      assert.equal(dashboard.provider, provider);
      assert.equal(dashboard.accounts[0].email, `${provider}@example.test`);
      await f.service.start('save', 'work');
      await until(async () => (await f.service.dashboard()).operation?.status === 'succeeded');
      assert.deepEqual(f.maintenance, []);
      await f.service.start('use', 'work');
      await until(async () => (await f.service.dashboard()).operation?.status === 'succeeded');
      assert.deepEqual(f.maintenance, [provider]);
      await f.service.start('restore');
      await until(async () => (await f.service.dashboard()).operation?.status === 'succeeded');
      assert.deepEqual(f.maintenance, [provider, provider]);
      assert.match((await f.service.dashboard()).operation!.message, new RegExp(provider));
    } finally { await f.cleanup(); }
  }
});

test('Claude运行中的维护门禁拒绝切换与恢复，不执行账号变更', async () => {
  const f = await fixture('claude', false, 'Claude Code 正在运行或排队');
  try {
    for (const action of ['use', 'restore'] as const) {
      await f.service.start(action, action === 'use' ? 'work' : undefined);
      await until(async () => (await f.service.dashboard()).operation?.status === 'failed');
      assert.equal((await f.service.dashboard()).operation?.message, 'Claude Code 正在运行或排队');
    }
    assert.deepEqual(f.maintenance, ['claude', 'claude']);
  } finally { await f.cleanup(); }
});

test('未安装CLI的快照保留平台和明确阻塞原因，不伪装成登录成功', async () => {
  const f = await fixture('claude', true);
  try {
    const dashboard = await f.service.dashboard();
    assert.equal(dashboard.provider, 'claude');
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.current, null);
    assert.equal(dashboard.blockedReason, '未找到 Claude Code CLI');
    assert.deepEqual(f.maintenance, []);
  } finally { await f.cleanup(); }
});

test('Codex设备授权码只随可信官方链接展示，取消后清除', async () => {
  const f = await fixture('codex');
  try {
    const started = await f.service.start('login', 'personal');
    await until(async () => !!(await f.service.dashboard()).operation?.loginUrl);
    const operation = (await f.service.dashboard()).operation;
    assert.equal(operation?.loginUrl, targets.codex);
    assert.equal(operation?.loginCode, 'ABCD-EFGH');
    const cancelled = await f.service.cancel(started.operation!.id);
    assert.equal(cancelled.operation?.status, 'cancelled');
    assert.equal(cancelled.operation?.loginUrl, undefined);
    assert.equal(cancelled.operation?.loginCode, undefined);
    assert.deepEqual(f.maintenance, []);
  } finally { await f.cleanup(); }
});

test('各平台只允许自己的官方登录端点，并拒绝伪域名、userinfo和额外端口', () => {
  for (const provider of accountProviders) {
    if (!targets[provider]) continue;
    assert.equal(trustedAccountLoginUrl(provider, targets[provider]), targets[provider]);
    for (const other of accountProviders.filter(value => value !== provider)) {
      if (targets[other]) assert.equal(trustedAccountLoginUrl(provider, targets[other]), '');
    }
    const url = new URL(targets[provider]);
    for (const bad of [`http://${url.host}${url.pathname}`, `https://${url.host}.evil.test${url.pathname}`,
      `https://user@${url.host}${url.pathname}`, `https://${url.host}:444${url.pathname}`,
      `${url.origin}${url.pathname}/extra`, `${url.origin}${url.pathname}#fragment`]) assert.equal(trustedAccountLoginUrl(provider, bad), '');
  }
  assert.equal(trustedAccountLoginUrl('codex', 'https://auth.openai.com/oauth/authorize?state=fixture'), 'https://auth.openai.com/oauth/authorize?state=fixture');
  assert.equal(trustedAccountLoginUrl('codex', undefined), '');
});


test('Claude仅接受三个核准的官方授权路径，回调与近似路径一律拒绝', () => {
  for (const url of ['https://claude.com/cai/oauth/authorize', 'https://platform.claude.com/oauth/authorize',
    'https://claude.ai/oauth/authorize']) {
    assert.equal(trustedAccountLoginUrl('claude', `${url}?state=fixture`), `${url}?state=fixture`);
  }
  for (const url of ['https://claude.com/cai/oauth/callback', 'https://platform.claude.com/oauth/code/callback',
    'https://claude.ai/oauth/callback', 'https://claude.com/oauth/authorize', 'https://claude.ai/cai/oauth/authorize',
    'https://auth.claude.ai/oauth/authorize', 'https://claude.com.evil.test/cai/oauth/authorize',
    'https://platform.claude.com.evil.test/oauth/authorize', 'https://claude.ai.evil.test/oauth/authorize',
    'https://claude.com/cai/oauth/authorize#fragment', 'https://platform.claude.com/oauth/authorize#fragment',
    'https://claude.ai/oauth/authorize#fragment']) assert.equal(trustedAccountLoginUrl('claude', url), '');
});

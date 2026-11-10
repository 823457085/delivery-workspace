import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareAgentBrowserRuntime } from '../server/agent-browser-runtime.js';

test('浏览器配置隔离并行范围、重试复用持久化目录，不继承外部浏览器状态', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery browser ' $HOME test-"));
  const canonicalRoot = await fs.realpath(root);
  const keys = ['DELIVERY_AGENT_BROWSER_BIN', 'DELIVERY_AGENT_BROWSER_CHROME_BIN', 'AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_CDP'];
  const previous = keys.map(key => process.env[key]);
  process.env.DELIVERY_AGENT_BROWSER_BIN = process.execPath;
  process.env.DELIVERY_AGENT_BROWSER_CHROME_BIN = process.execPath;
  process.env.AGENT_BROWSER_PROFILE = '/do-not-inherit';
  process.env.AGENT_BROWSER_CDP = '9222';
  const socketDirectories = new Set<string>();
  t.after(async () => {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.rm(root, { recursive: true, force: true });
    for (const directory of socketDirectories) await fs.rm(directory, { recursive: true, force: true });
  });
  const first = await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'team/task/verify' });
  const retry = await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'team/task/verify' });
  const parallel = await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'team/task/review' });
  assert.ok(first?.config && retry?.config && parallel?.config);
  const server = first.config['mcp_servers.delivery_browser'] as { command: string; args: string[]; env_vars: string[]; env: Record<string, string> };
  socketDirectories.add(server.env.AGENT_BROWSER_SOCKET_DIR!);
  assert.deepEqual(first.config, retry.config);
  assert.notDeepEqual(first.config, parallel.config);
  assert.deepEqual(server.env_vars, []);
  assert.equal(server.env.AGENT_BROWSER_PROFILE, undefined);
  assert.equal(server.env.AGENT_BROWSER_CDP, undefined);
  const configPath = server.env.AGENT_BROWSER_CONFIG!;
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.headed, true);
  if (process.platform !== 'win32') {
    const socketPath = path.join(server.env.AGENT_BROWSER_SOCKET_DIR!, 'namespaces', config.namespace, 'run', `${config.session}.sock`);
    assert.ok(Buffer.byteLength(socketPath) < 104, `Darwin socket path is too long: ${socketPath}`);
    assert.equal(config.session.length, 27, '会话仍保留 96 位 scope 标识');
  }
  assert.equal(config.profile.startsWith(path.join(canonicalRoot, '.local', 'data', 'agent-browser', 'profiles') + path.sep), true);
  await fs.writeFile(path.join(config.profile, 'preserved-login-marker'), 'owned-state');
  await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'team/task/verify' });
  assert.equal(await fs.readFile(path.join(config.profile, 'preserved-login-marker'), 'utf8'), 'owned-state');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(config.profile)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(server.env.AGENT_BROWSER_SOCKET_DIR!)).mode & 0o777, 0o700);
  }
  assert.match(first.instructions, /不代表已经成功连接或登录/);
  if (process.platform !== 'win32') {
    const fallback = first.instructions.match(/```sh\n([^\n]+)\n```/)?.[1];
    assert.ok(fallback);
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${fallback} -p 'JSON.stringify([process.env.AGENT_BROWSER_CONFIG, process.env.AGENT_BROWSER_SOCKET_DIR, process.env.AGENT_BROWSER_PROFILE, process.env.AGENT_BROWSER_CDP])'`]);
    assert.deepEqual(JSON.parse(stdout), [configPath, server.env.AGENT_BROWSER_SOCKET_DIR, null, null]);
  }
  const chromeDebugPortFile = path.join(root, 'DevToolsActivePort');
  const debugPath = '/devtools/browser/12345678-1234-1234-1234-123456789abc';
  await fs.writeFile(chromeDebugPortFile, `9222\n${debugPath}\n`);
  const attach = async (scope: string) => {
    const result = await prepareAgentBrowserRuntime({ rootDirectory: root, scope, chromeDebugPortFile });
    assert.ok(result?.config);
    const mcp = result.config['mcp_servers.delivery_browser'] as typeof server;
    return { browser: JSON.parse(await fs.readFile(mcp.env.AGENT_BROWSER_CONFIG!, 'utf8')), instructions: result.instructions };
  };
  const attached = await attach('team/task/verify');
  const anotherTab = await attach('conversation/another');
  assert.equal(attached.browser.cdp, `ws://127.0.0.1:9222${debugPath}`);
  assert.equal(anotherTab.browser.cdp, attached.browser.cdp);
  assert.equal(attached.browser.pinTab, true);
  assert.equal(attached.browser.profile, undefined);
  assert.notEqual(attached.browser.session, anotherTab.browser.session);
  assert.notEqual(attached.browser.session, config.session);
  assert.match(attached.instructions, /只操作本任务自动绑定的标签页/);
  assert.ok(!attached.instructions.includes(debugPath), '调试端点只保存在私有配置内');
  assert.equal(await fs.readFile(chromeDebugPortFile, 'utf8'), `9222\n${debugPath}\n`);
  await fs.writeFile(chromeDebugPortFile, '99999\n/devtools/browser/not-a-chrome-endpoint');
  const invalid = await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'conversation/waiting', chromeDebugPortFile });
  assert.equal(invalid?.config, undefined);
  assert.match(invalid?.instructions || '', /chrome:\/\/inspect\/#remote-debugging/);
  await fs.unlink(chromeDebugPortFile);
  const missing = await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'conversation/waiting', chromeDebugPortFile });
  assert.equal(missing?.config, undefined);
  assert.match(missing?.instructions || '', /日常 Chrome 尚未开放远程调试/);
  assert.equal((await fs.readdir(path.dirname(config.profile))).length, 2);
  await assert.rejects(prepareAgentBrowserRuntime({ rootDirectory: root, scope: '' }), /不能为空/);
  process.env.DELIVERY_AGENT_BROWSER_BIN = path.join(root, 'missing-driver');
  assert.equal(await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'missing' }), undefined);
  process.env.DELIVERY_AGENT_BROWSER_BIN = process.execPath;
  process.env.DELIVERY_AGENT_BROWSER_CHROME_BIN = path.join(root, 'missing-chrome');
  assert.equal(await prepareAgentBrowserRuntime({ rootDirectory: root, scope: 'missing' }), undefined);
});

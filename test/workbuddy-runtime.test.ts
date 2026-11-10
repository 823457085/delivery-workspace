import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbuddyAdapter } from '../server/workbuddy-runtime.js';

test('WorkBuddy 只发现产品内置 CLI；安装不能冒充认证或执行验证', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-workbuddy-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli');
  await fs.mkdir(path.join(cli, 'dist'), { recursive: true });
  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@genie/agent-cli', version: '2.165.0' }));
  await fs.writeFile(path.join(cli, 'dist/codebuddy-lite-wb.mjs'), 'throw new Error("must not launch");');
  const adapter = createWorkbuddyAdapter([root]);
  const health = await adapter.health();
  assert.equal(health.version, '2.165.0');
  assert.match(health.binary, /codebuddy-lite-wb\.mjs$/);
  assert.equal(health.authenticated, false);
  assert.equal(health.ready, false);
  assert.equal(health.writable, false);
  assert.match(health.message, /体验版套餐未包含 CLI 访问/);
  await assert.rejects(adapter.execute({} as any), /未启动原生工具/);
  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: 'other-product', version: '99' }));
  assert.equal((await adapter.health()).binary, '');
});

test('WorkBuddy 候选 argv 禁用原生工具，none 隔离配置且只授权精确四个 MCP 工具', async () => {
  const { workbuddyBridgeArguments } = await import('../server/workbuddy-runtime.js');
  const args = workbuddyBridgeArguments('/private/control/mcp.json', '--dangerous objective is data', 'auto');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'none');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__delivery__read_file,mcp__delivery__list_files,mcp__delivery__apply_patch,mcp__delivery__run_command');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-plugin-management'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args.includes('-y'), false);
  assert.deepEqual(args.slice(-2), ['--', '--dangerous objective is data']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalTools, validateLocalTool } from '../server/agent-local-tools.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function fixture(t: any, mode = 'agent', controller = new AbortController()) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-tools-test-')));
  await fs.mkdir(path.join(directory, 'workspace'));
  const root = path.join(directory, 'workspace');
  const state = path.join(root, 'controller-state');
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'private.json'), 'private-state');
  const tools = await createLocalTools({ workspacePath: root, accessMode: 'workspace', mode } as AgentRun,
    state, controller.signal, () => {});
  t.after(async () => { await tools.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, root, tools, state };
}

test('本机文件工具真实读写、版本冲突与命令检查', { skip: process.platform !== 'darwin' }, async t => {
  const { root, tools } = await fixture(t);
  assert.equal((await tools.execute('apply_patch', { path: 'index.js', expected_sha256: '', content: 'console.log(1)\n' })).ok, true);
  const read = await tools.execute('read_file', { path: 'index.js' });
  assert.equal(read.result.content, 'console.log(1)\n');
  assert.equal((await tools.execute('apply_patch', { path: 'index.js', expected_sha256: '', content: 'wrong' })).ok, false);
  assert.equal((await tools.execute('apply_patch', { path: 'index.js', expected_sha256: read.result.sha256, content: 'console.log(2)\n' })).ok, true);
  assert.equal((await tools.execute('run_command', { command: 'exec node --check index.js' })).exitCode, 0);
  assert.notEqual((await tools.execute('run_command', { command: 'echo mutated > index.js' })).exitCode, 0);
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'console.log(2)\n');
  assert.ok((await tools.execute('list_files', { path: '.' })).result.some((item: any) => item.name === 'index.js'));
});

test('Ask/Plan 拒绝文件及 shell 写入，full 不静默降级', { skip: process.platform !== 'darwin' }, async t => {
  for (const mode of ['ask', 'plan']) {
    const { tools, root } = await fixture(t, mode);
    await assert.rejects(tools.execute('apply_patch', { path: 'a', expected_sha256: '', content: 'x' }), /只读/);
    assert.notEqual((await tools.execute('run_command', { command: 'echo blocked > prohibited' })).exitCode, 0);
    assert.equal(await fs.stat(path.join(root, 'prohibited')).then(() => true, () => false), false);
  }
  await assert.rejects(createLocalTools({ accessMode: 'full' } as AgentRun, '', new AbortController().signal, () => {}), /不支持完全访问/);
});

test('越界、符号链接、硬链接、认证文件和工作台状态均受实际约束', { skip: process.platform !== 'darwin' }, async t => {
  const { directory, root, tools } = await fixture(t);
  await fs.writeFile(path.join(directory, 'outside'), 'outside-private');
  await fs.writeFile(path.join(root, '.env.local'), 'fixture-secret');
  await fs.mkdir(path.join(root, '.local'));
  await fs.writeFile(path.join(root, '.local', 'business-state.json'), 'private-state');
  await fs.symlink(path.join(directory, 'outside'), path.join(root, 'symlink'));
  await fs.symlink(directory, path.join(root, 'parent-link'));
  for (const p of ['../outside', path.join(directory, 'outside'), 'symlink', 'parent-link/outside', '.env.local', '.local/business-state.json', 'controller-state/private.json']) {
    assert.equal((await tools.execute('read_file', { path: p })).ok, false, p);
    assert.equal((await tools.execute('apply_patch', { path: p, expected_sha256: '', content: 'bad' })).ok, false, p);
  }
  for (const command of ['exec cat ../outside', 'exec cat symlink', 'exec cat .env.local', 'exec cat .local/business-state.json', 'exec cat controller-state/private.json']) {
    const result = await tools.execute('run_command', { command });
    assert.notEqual(result.exitCode, 0, command);
    assert.equal(/outside-private|fixture-secret|private-state/.test(result.stdout), false);
  }
  await fs.link(path.join(directory, 'outside'), path.join(root, 'hardlink'));
  assert.equal((await tools.execute('read_file', { path: 'hardlink' })).ok, false);
  await assert.rejects(tools.execute('run_command', { command: 'exec cat hardlink' }), /硬链接/);
  assert.equal(await fs.readFile(path.join(directory, 'outside'), 'utf8'), 'outside-private');
  assert.throws(() => validateLocalTool('read_file', { path: 'a', roots: ['/'] }), /参数/);
  assert.throws(() => validateLocalTool('__proto__', {}), /不支持/);
});

test('命令不继承密钥，禁止网络、fork、后台进程及硬链接创建', { skip: process.platform !== 'darwin' }, async t => {
  const { tools } = await fixture(t);
  const previous = process.env.DELIVERY_TOOL_TEST_SECRET;
  process.env.DELIVERY_TOOL_TEST_SECRET = 'must-not-inherit';
  try {
    const env = await tools.execute('run_command', { command: 'exec env' });
    assert.equal(env.exitCode, 0);
    assert.equal(env.stdout.includes('must-not-inherit'), false);
  } finally { if (previous === undefined) delete process.env.DELIVERY_TOOL_TEST_SECRET; else process.env.DELIVERY_TOOL_TEST_SECRET = previous; }
  const fork = await tools.execute('run_command', { command: `exec node -e 'let c=require("child_process").spawn("/bin/sh",["-c","echo escaped"],{detached:true});c.on("error",e=>console.log(e.code))'` });
  assert.ok(fork.exitCode !== 0 || /EPERM|EACCES/.test(fork.stdout + fork.stderr), JSON.stringify(fork));
  assert.equal(fork.stdout.includes('escaped'), false);
  const link = await tools.execute('run_command', { command: `exec node -e 'require("fs").linkSync("controller-state/private.json","alias")'` });
  assert.notEqual(link.exitCode, 0);
  const net = await tools.execute('run_command', { command: `exec node -e 'require("net").connect(5199,"127.0.0.1").on("error",e=>console.log(e.code))'` });
  assert.match(net.stdout, /EPERM|EACCES/);
});

test('停止等待进程退出，停止后无后续写入且不能启动下一工具', { skip: process.platform !== 'darwin' }, async t => {
  const controller = new AbortController();
  const { root, state } = await fixture(t);
  let pid = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const tools = await createLocalTools({ workspacePath: root, mode: 'agent', accessMode: 'workspace' } as AgentRun,
    state, controller.signal, value => { pid = value; started(); });
  const pending = tools.execute('run_command', { command: `exec node -e 'setTimeout(()=>require("fs").writeFileSync(process.env.TMPDIR+"/late","bad"),3000)'` });
  await ready;
  await delay(100);
  controller.abort();
  await assert.rejects(pending, /停止/);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(tools.execute('read_file', { path: '.' }));
  await tools.close();
});

test('权限快照建立后替换工作区根为越界符号链接，不读取或写入新目标', { skip: process.platform !== 'darwin' }, async t => {
  const { directory, root, tools } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'must-not-read');
  await fs.rename(root, `${root}-original`);
  await fs.symlink(outside, root);
  for (const [name, args] of [['read_file', { path: 'secret' }], ['apply_patch', { path: 'created', expected_sha256: '', content: 'must-not-write' }]] as const) {
    try {
      const result = await tools.execute(name, args);
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(result).includes('must-not-read'), false);
    } catch (error) { assert.match((error as Error).message, /无效结果|失败/); }
  }
  assert.equal(await fs.stat(path.join(outside, 'created')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'must-not-read');
});

test('命令快照后替换源文件为越界硬链接，命令仍只读取已捕获的独立内容', { skip: process.platform !== 'darwin' }, async t => {
  const { directory, root, state } = await fixture(t);
  await fs.writeFile(path.join(root, 'source.txt'), 'captured-source');
  const outside = path.join(directory, 'private.txt');
  await fs.writeFile(outside, 'must-not-leak');
  let starts = 0;
  const tools = await createLocalTools({ workspacePath: root, mode: 'agent', accessMode: 'workspace' } as AgentRun,
    state, new AbortController().signal, async () => {
      if (++starts === 2) {
        await fs.unlink(path.join(root, 'source.txt'));
        await fs.link(outside, path.join(root, 'source.txt'));
      }
    });
  try {
    const result = await tools.execute('run_command', { command: 'exec cat source.txt' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'captured-source');
    assert.equal(result.stdout.includes('must-not-leak'), false);
    assert.equal(await fs.readFile(outside, 'utf8'), 'must-not-leak');
  } finally { await tools.close(); }
});

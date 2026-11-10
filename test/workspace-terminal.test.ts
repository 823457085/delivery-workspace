import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceAppRoute, createWorkspaceTerminalRoute, openWorkspaceCursor, prepareCursorWorkspace } from '../server/workspace-terminal.js';

async function fixture(t: TestContext, app: 'Terminal' | 'Cursor', open: (directory: string) => Promise<void>) {
  const handler = app === 'Terminal' ? createWorkspaceTerminalRoute(open) : createWorkspaceAppRoute(app, open);
  const server = http.createServer((req, res) => void handler(req, res, req.socket.localPort!));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(base, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { base, post };
}

test('Cursor 工作区按真实目录稳定生成，重复打开保留用户设置', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '中文 代码');
  const workspaceDirectory = path.join(root, 'cache');
  await fs.mkdir(directory);
  const file = await prepareCursorWorkspace(directory, workspaceDirectory);
  assert.equal(path.basename(file), '中文 代码.code-workspace');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { folders: [{ path: await fs.realpath(directory) }] });
  const modified = { folders: [{ path: await fs.realpath(directory) }], settings: { 'editor.fontSize': 15 } };
  await fs.writeFile(file, JSON.stringify(modified));
  const alias = path.join(root, 'alias');
  await fs.symlink(directory, alias);
  assert.equal(await prepareCursorWorkspace(alias, workspaceDirectory), file);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), modified);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Cursor 从已安装的桌面版打开独立 IDE 工作区，不经过 PATH', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-ide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "中文 代码 ' $(echo unsafe)"), cache = path.join(root, 'cache');
  await fs.mkdir(directory);
  const legacyFile = await prepareCursorWorkspace(directory, cache);
  const app = path.join(root, '安装目录', 'Cursor.app');
  const launches: { executable: string; args: string[] }[] = [];
  await openWorkspaceCursor(directory, cache, { executeFile: async (executable, args, options) => {
    if (executable === '/usr/bin/osascript') return { stdout: `${app}\n` };
    assert.equal(options.env?.VSCODE_IPC_HOOK_CLI, undefined);
    launches.push({ executable, args });
    return { stdout: '' };
  } });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, path.join(app, 'Contents/Resources/app/bin/cursor'));
  const [mode, window, file] = launches[0].args;
  assert.equal(mode, '--classic');
  assert.equal(window, '--new-window');
  assert.notEqual(file, legacyFile);
  assert.equal(file, await prepareCursorWorkspace(directory, path.join(cache, 'ide')));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).folders, [{ path: await fs.realpath(directory) }]);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Cursor 未安装时返回桌面版安装提示，不执行 PATH 中的同名命令', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-uninstalled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { post } = await fixture(t, 'Cursor', directory => openWorkspaceCursor(directory, path.join(root, 'cache'), {
    executeFile: async executable => {
      assert.equal(executable, '/usr/bin/osascript');
      return { stdout: '\n' };
    },
  }));
  const response = await post({ workspacePath: root });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /未找到 Cursor 桌面版/);
});

for (const app of ['Terminal', 'Cursor'] as const) {
  test(`${app} 打开真实普通目录，中文、空格和 shell 字符保持路径数据，不要求 Git`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-route-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspacePath = path.join(root, "中文 空格 ' $(echo unsafe)");
    await fs.mkdir(workspacePath);
    const opened: string[] = [];
    const { post } = await fixture(t, app, async directory => { opened.push(directory); });
    const response = await post({ workspacePath });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, app === 'Terminal' ? '已打开工作区终端' : '已在 Cursor 中打开工作区');
    assert.deepEqual(opened, [await fs.realpath(workspacePath)]);
    assert.deepEqual(await fs.readdir(workspacePath), []);
  });

  test(`${app} 接口拒绝跨站、缺少来源、GET、脚本参数及无效目录`, async t => {
    let calls = 0;
    const { base, post } = await fixture(t, app, async () => { calls++; });
    assert.equal((await fetch(base)).status, 405);
    for (const Origin of ['', 'null', 'https://evil.test']) assert.equal((await post({ workspacePath: os.tmpdir() }, { Origin })).status, 403);
    assert.equal((await post({ workspacePath: os.tmpdir() }, { Host: 'evil.test', Origin: 'http://evil.test' })).status, 403);
    assert.equal((await post({ workspacePath: os.tmpdir() }, { 'Content-Type': 'text/plain' })).status, 415);
    for (const body of [null, [], { workspacePath: '.' }, { workspacePath: '/tmp\n' },
      { workspacePath: '/missing-terminal-test-dir' }, { workspacePath: os.tmpdir(), command: 'echo unsafe' },
      { workspacePath: os.tmpdir(), app: 'OtherApp' },
      { workspacePath: path.join(process.cwd(), 'package.json') }]) assert.equal((await post(body)).status, 400);
    assert.equal(calls, 0);
  });

  test(`${app} 重复打开被拦截，失败释放状态以便重试`, async t => {
    let finish!: () => void, started!: () => void;
    let fail = false, wait = true;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const { post } = await fixture(t, app, async () => {
      if (fail) throw new Error('native failed');
      if (wait) { started(); await new Promise<void>(resolve => { finish = resolve; }); }
    });
    const first = post({ workspacePath: os.tmpdir() });
    await ready;
    assert.equal((await post({ workspacePath: os.tmpdir() })).status, 409);
    finish(); assert.equal((await first).status, 200);
    fail = true;
    const failed = await post({ workspacePath: os.tmpdir() });
    assert.equal(failed.status, 400);
    assert.match((await failed.json()).message, new RegExp(app));
    fail = wait = false;
    assert.equal((await post({ workspacePath: os.tmpdir() })).status, 200);
  });
}

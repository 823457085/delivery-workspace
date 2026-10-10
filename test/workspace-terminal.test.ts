import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceTerminalRoute } from '../server/workspace-terminal.js';

async function fixture(t: TestContext, open: (directory: string) => Promise<void>) {
  const handler = createWorkspaceTerminalRoute(open);
  const server = http.createServer((req, res) => void handler(req, res, req.socket.localPort!));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(base, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { base, post };
}

test('终端打开真实普通目录，中文、空格和 shell 字符保持路径数据，不要求 Git', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "中文 空格 ' $(echo unsafe)");
  await fs.mkdir(workspacePath);
  const opened: string[] = [];
  const { post } = await fixture(t, async directory => { opened.push(directory); });
  assert.equal((await post({ workspacePath })).status, 200);
  assert.deepEqual(opened, [await fs.realpath(workspacePath)]);
  assert.deepEqual(await fs.readdir(workspacePath), []);
});

test('终端接口拒绝跨站、缺少来源、GET、脚本参数及无效目录', async t => {
  let calls = 0;
  const { base, post } = await fixture(t, async () => { calls++; });
  assert.equal((await fetch(base)).status, 405);
  for (const Origin of ['', 'null', 'https://evil.test']) assert.equal((await post({ workspacePath: os.tmpdir() }, { Origin })).status, 403);
  assert.equal((await post({ workspacePath: os.tmpdir() }, { 'Content-Type': 'text/plain' })).status, 415);
  for (const body of [null, [], { workspacePath: '.' }, { workspacePath: '/tmp\n' },
    { workspacePath: '/missing-terminal-test-dir' }, { workspacePath: os.tmpdir(), command: 'echo unsafe' },
    { workspacePath: path.join(process.cwd(), 'package.json') }]) assert.equal((await post(body)).status, 400);
  assert.equal(calls, 0);
});

test('重复打开被拦截，失败释放状态以便重试', async t => {
  let finish!: () => void, started!: () => void;
  let fail = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { post } = await fixture(t, async () => {
    if (fail) throw new Error('native failed');
    started(); await new Promise<void>(resolve => { finish = resolve; });
  });
  const first = post({ workspacePath: os.tmpdir() });
  await ready;
  assert.equal((await post({ workspacePath: os.tmpdir() })).status, 409);
  finish(); assert.equal((await first).status, 200);
  fail = true;
  assert.equal((await post({ workspacePath: os.tmpdir() })).status, 400);
  assert.equal((await post({ workspacePath: os.tmpdir() })).status, 400);
});

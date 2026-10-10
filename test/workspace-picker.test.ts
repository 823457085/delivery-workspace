import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createWorkspacePickerRoute, folderScript } from '../server/workspace-picker.js';
import { useWorkspacePicker } from '../src/features/tech-design-delivery/useWorkspacePicker.js';
import { usesRemoteWorkspaceBrowser } from '../src/shared/useWorkspacePicker.js';
import { effectScope } from 'vue';

test('native script returns the selected path, handles cancellation and propagates native failures', () => {
  const run = (chooseFolder: () => unknown) => runInNewContext(folderScript, {
    Application: { currentApplication: () => ({ chooseFolder }) },
  });
  assert.equal(JSON.parse(run(() => ({ toString: () => '/Users/test/中文 folder' }))), '/Users/test/中文 folder');
  assert.equal(JSON.parse(run(() => { throw { errorNumber: -128 }; })), null);
  const failure = new Error('native picker unavailable');
  assert.throws(() => run(() => { throw failure; }), error => error === failure);
});

test('successive selections return the newly chosen ordinary folder', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-switch-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const folders = [path.join(root, 'first'), path.join(root, '第二个目录')];
  for (const folder of folders) await fs.mkdir(folder);
  let index = 0;
  const { post } = await fixture(t, async () => folders[index++]!);
  for (const folder of folders) {
    const response = await post();
    assert.equal(response.status, 200);
    const selected = await response.json();
    assert.equal(selected.workspacePath, await fs.realpath(folder));
    assert.equal(selected.branch, '');
  }
});

async function fixture(t: TestContext, choose: (signal: AbortSignal) => Promise<string | null>) {
  const handler = createWorkspacePickerRoute(choose);
  const server = http.createServer((request, response) => void handler(request, response, request.socket.localPort!));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (headers: Record<string, string> = {}, body = '{}') => fetch(base, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body });
  return { base, post };
}

test('native selection returns the real folder and branch without changing repository files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-test-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const workspace = path.join(root, '中文 workspace');
  await fs.mkdir(workspace);
  execFileSync('git', ['init', '--initial-branch=feature/picker', workspace]);
  const before = execFileSync('git', ['-C', workspace, 'status', '--porcelain']).toString();
  const { post } = await fixture(t, async () => workspace);
  const response = await post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.cancelled, false);
  assert.equal(result.workspacePath, await fs.realpath(workspace));
  assert.equal(result.branch, 'feature/picker');
  assert.equal(execFileSync('git', ['-C', workspace, 'status', '--porcelain']).toString(), before);
});

test('cancel is a normal result; duplicate native dialogs are rejected and the lock is released', async t => {
  let finish!: (result: null) => void;
  let started!: () => void;
  const opened = new Promise<void>(resolve => { started = resolve; });
  const { post } = await fixture(t, async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const first = post();
  await opened;
  assert.equal((await post()).status, 409);
  finish(null);
  assert.deepEqual(await (await first).json(), { cancelled: true });
  const second = post();
  await new Promise(resolve => setTimeout(resolve, 20));
  finish(null);
  assert.equal((await second).status, 200);
});

test('missing or foreign origins, non-POST and arbitrary bodies never open a folder dialog', async t => {
  let calls = 0;
  const { base, post } = await fixture(t, async () => { calls++; return null; });
  assert.equal((await fetch(base)).status, 405);
  for (const Origin of ['', 'null', 'https://evil.test', 'http://localhost.evil.test:5199']) assert.equal((await post({ Origin })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({}, '{"path":"/tmp","script":"bad"}')).status, 400);
  assert.equal((await post({}, '{bad')).status, 400);
  assert.equal(calls, 0);
});

test('picker errors release the lock and do not return an invented workspace', async t => {
  let fail = true;
  const { post } = await fixture(t, async () => { if (fail) throw new Error('选择器不可用'); return null; });
  const response = await post();
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, '选择器不可用');
  fail = false;
  assert.deepEqual(await (await post()).json(), { cancelled: true });
});

test('form picker ignores double clicks and treats cancellation and failure as no selection', async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  const picker = useWorkspacePicker(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = picker.choose();
  assert.equal(picker.selecting.value, true);
  assert.equal(await picker.choose(), null);
  assert.equal(calls, 1);
  finish(Response.json({ cancelled: true }));
  assert.equal(await first, null);
  assert.equal(picker.error.value, '');
  assert.equal(picker.selecting.value, false);
  const failing = useWorkspacePicker(async () => Response.json({ message: '请先关闭已打开的选择器' }, { status: 409 }));
  assert.equal(await failing.choose(), null);
  assert.equal(failing.error.value, '请先关闭已打开的选择器');
  assert.equal(failing.selecting.value, false);
});

test('remote picker never opens a native window; select, cancel and disposal all settle the pending operation', async () => {
  let nativeCalls = 0;
  const scope = effectScope();
  const picker = scope.run(() => useWorkspacePicker(async () => { nativeCalls++; return Response.json({ cancelled: true }); }, () => true))!;
  const first = picker.choose('/Users/test/repo');
  assert.equal(picker.browserOpen.value, true);
  assert.equal(picker.browserPath.value, '/Users/test/repo');
  assert.equal(await picker.choose(), null);
  const selection = { cancelled: false as const, workspacePath: '/Users/test/repo', branch: 'feature/test', message: 'selected' };
  picker.completeBrowser(selection);
  assert.deepEqual(await first, selection);
  assert.equal(picker.selecting.value, false);
  assert.equal(picker.browserOpen.value, false);
  const cancelled = picker.choose();
  picker.completeBrowser(null);
  assert.equal(await cancelled, null);
  const closed = picker.choose();
  scope.stop();
  assert.equal(await closed, null);
  assert.equal(picker.selecting.value, false);
  assert.equal(nativeCalls, 0);
});

test('only loopback clients use the native folder picker', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(usesRemoteWorkspaceBrowser(host), false);
  for (const host of ['172.20.100.50', '192.168.1.2', 'computer.private.test']) assert.equal(usesRemoteWorkspaceBrowser(host), true);
});

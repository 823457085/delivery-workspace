import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceBrowser, createWorkspaceBrowserRoute } from '../server/workspace-browser.js';

async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-browser-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'user');
  await fs.mkdir(root);
  return { root: await fs.realpath(root), temporary, browser: createWorkspaceBrowser(root) };
}

test('remote browsing lists directories first, skips hidden files and links, and does not read file contents', async t => {
  const { root, browser } = await fixture(t);
  await fs.mkdir(path.join(root, '中文 workspace'));
  await fs.mkdir(path.join(root, '.private'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'not included in the response');
  await fs.writeFile(path.join(root, '.secret'), 'not listed');
  await fs.symlink(path.join(root, '中文 workspace'), path.join(root, 'shortcut'));
  const result = await browser.browse();
  assert.equal(result.path, root);
  assert.equal(result.parent, null);
  assert.deepEqual(result.entries, [
    { name: '中文 workspace', path: path.join(root, '中文 workspace'), kind: 'directory' },
    { name: 'notes.txt', path: path.join(root, 'notes.txt'), kind: 'file' },
  ]);
  assert.equal(result.truncated, false);
  assert.equal((await browser.browse(path.join(root, '中文 workspace'))).parent, root);
});

test('remote selection supports ordinary folders and Git branches without changing the worktree', async t => {
  const { root, browser } = await fixture(t);
  const folder = path.join(root, '普通文件夹');
  await fs.mkdir(folder);
  const normal = await browser.select(folder);
  assert.deepEqual(normal, { cancelled: false, workspacePath: folder, branch: '', message: '已选择普通文件夹' });
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '--initial-branch=feature/remote', repo]);
  const before = execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString();
  const result = await browser.select(repo);
  assert.equal(result.cancelled, false);
  if (result.cancelled) assert.fail();
  assert.equal(result.branch, 'feature/remote');
  assert.equal(result.workspacePath, repo);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString(), before);
});

test('remote selection rejects traversal, prefix lookalikes, outside symlinks, files and invalid paths', async t => {
  const { root, temporary, browser } = await fixture(t);
  const lookalike = path.join(temporary, 'user-other');
  await fs.mkdir(lookalike);
  await fs.symlink(lookalike, path.join(root, 'escape'));
  await fs.writeFile(path.join(root, 'file.txt'), 'test');
  for (const invalid of [root + '/..', lookalike, path.join(root, 'escape'), path.join(root, 'file.txt'), '.', '/tmp\0bad', 'a'.repeat(1001)]) {
    await assert.rejects(browser.browse(invalid));
    await assert.rejects(browser.select(invalid));
  }
  await assert.rejects(browser.select(''));
});

test('directory listings are bounded to 500 entries', async t => {
  const { root, browser } = await fixture(t);
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.mkdir(path.join(root, `folder-${index}`))));
  const result = await browser.browse();
  assert.equal(result.entries.length, 500);
  assert.equal(result.truncated, true);
});

test('directory API validates method, JSON and fields before browsing; select only returns a path', async t => {
  const { root, browser } = await fixture(t);
  const route = createWorkspaceBrowserRoute(browser);
  const server = http.createServer((request, response) => void route(request, response, request.url === '/select' ? 'select' : 'browse'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: string, endpoint = '/browse', contentType = 'application/json') => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  assert.equal((await fetch(base)).status, 405);
  assert.equal((await post('{}', '/browse', 'text/plain')).status, 415);
  for (const body of ['null', '[]', '{bad', '{"path":1}', '{"script":"bad"}', JSON.stringify({ path: 'a'.repeat(4100) })]) {
    assert.equal((await post(body)).status, 400);
  }
  const listing = await post('{}');
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).path, root);
  const selection = await post(JSON.stringify({ path: root }), '/select');
  assert.equal(selection.status, 200);
  assert.equal((await selection.json()).workspacePath, root);
  assert.equal((await post('{}', '/select')).status, 400);
});

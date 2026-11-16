import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { ProjectsData } from '../shared/hub.js';

const exec = promisify(execFile);

test('项目深链接保留隐藏会话工作区的实际分支与改动，且不污染常规扫描', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-project-link-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const scanRoot = path.join(directory, 'projects');
  const main = path.join(scanRoot, 'sample-project');
  const runtimeData = path.join(directory, '.local', 'data');
  const linked = path.join(runtimeData, 'agent-runtimes', 'workspaces', '10000000-0000-4000-8000-000000000001');
  const outside = path.join(directory, 'outside-project');
  const alias = path.join(scanRoot, '.outside-alias');
  await fs.mkdir(main, { recursive: true });
  await fs.mkdir(path.dirname(linked), { recursive: true });
  await exec('git', ['init', '-b', 'main', main]);
  await exec('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
  await exec('git', ['-C', main, 'remote', 'add', 'origin', 'https://example.invalid/shop/sample-project.git']);
  await exec('git', ['-C', main, 'worktree', 'add', '-b', 'feature/session', linked]);
  await exec('git', ['-C', main, 'worktree', 'add', '-b', 'feature/outside', outside]);
  await fs.writeFile(path.join(linked, 'session-change.txt'), 'workspace change');
  await fs.symlink(outside, alias, 'dir');

  const environment = { LOCAL_PROJECT_ROOTS: scanRoot, DELIVERY_DATA_DIR: runtimeData,
    LOCAL_PROJECT_LABELS_FILE: path.join(runtimeData, 'labels.json') };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { handleJiraTaskCalendarRequest } = await import('../server/jira-backend/server.mjs');
  async function readProjects(workspace?: string) {
    const params = new URLSearchParams(workspace ? { workspace } : {});
    let status: number | undefined, result: string | undefined;
    await handleJiraTaskCalendarRequest({ method: 'GET', url: `/api/local-projects?${params}`, headers: {} }, {
      writeHead(code: number) { status = code; },
      end(body: string) { result = body; },
    });
    assert.equal(status, 200, result);
    return (JSON.parse(result!) as ProjectsData).projects;
  }

  const ordinary = await readProjects();
  assert.deepEqual(ordinary.map(project => project.path), [main]);
  const selected = (await readProjects(linked)).find(project => project.path === linked);
  assert.equal(selected?.projectId, ordinary[0]?.projectId);
  assert.equal(selected?.branch, 'feature/session');
  assert.equal(selected?.changed, 1);
  for (const unavailable of [outside, alias, path.join(linked, 'missing')]) {
    assert.deepEqual((await readProjects(unavailable)).map(project => project.path), [main]);
  }
  assert.deepEqual((await readProjects()).map(project => project.path), [main]);
});

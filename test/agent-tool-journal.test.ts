import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createToolJournal, privateRunFile } from '../server/agent-tool-journal.js';

test('账本落盘后回读已完成结果，未知结果、冲突 ID 和跨运行不混用', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let journal = await createToolJournal(directory, 'run-a');
  let executed = 0;
  const execute = async () => ({ count: ++executed });
  assert.deepEqual(await journal.execute('call-a', 'apply_patch', { a: 1 }, execute), { count: 1 });
  journal = await createToolJournal(directory, 'run-a');
  assert.deepEqual(await journal.execute('call-a', 'apply_patch', { a: 1 }, execute), { count: 1 });
  assert.equal(executed, 1);
  await assert.rejects(journal.execute('call-a', 'apply_patch', { a: 2 }, execute), /不同操作/);
  await assert.rejects(journal.execute('unknown', 'run_command', {}, async () => { throw new Error('interrupted'); }));
  journal = await createToolJournal(directory, 'run-a');
  await assert.rejects(journal.execute('unknown', 'run_command', {}, execute), /结果未知/);
  const other = await createToolJournal(directory, 'run-b');
  assert.deepEqual(await other.execute('call-a', 'apply_patch', { a: 1 }, execute), { count: 2 });
  assert.equal((await fs.stat(privateRunFile(directory, 'run-a'))).mode & 0o777, 0o600);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAgentUserContext, removeAgentUserContext } from '../server/agent-user-context.js';

const input = (id: string, user = id, second = 0) => ({ id, user, createdAt: new Date(Date.UTC(2026, 10, 7, 0, 0, second)).toISOString() });
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-user-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('用户原文跨多轮和重载完整保留，早期授权与后续收紧均可核对', async t => {
  const directory = await fixture(t), first = input('first', `原环境账号持续授权：${'长原文'.repeat(5000)}`);
  const file = await saveAgentUserContext(directory, 'conversation', [first]);
  await saveAgentUserContext(directory, 'conversation', Array.from({ length: 20 }, (_, i) => input(`later-${i}`, `后续消息${i}`, i + 1)));
  await saveAgentUserContext(directory, 'conversation', [input('revoke', '收紧：仅核验，不再登录。', 30), first]);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.inputs.length, 22); assert.deepEqual(saved.inputs[0], first);
  assert.equal(saved.inputs.at(-1).user, '收紧：仅核验，不再登录。');
});

test('并发记录不丢原话，文件私有且对话标识无法穿越状态目录', async t => {
  const directory = await fixture(t), conversation = '../../outside/../会话';
  const files = await Promise.all(Array.from({ length: 12 }, (_, i) => saveAgentUserContext(directory, conversation, [input(`input-${i}`, `原话${i}`, i)])));
  assert.equal(new Set(files).size, 1);
  assert.match(path.relative(directory, files[0]!), /^agent-user-context\/[a-f0-9]{64}\.json$/);
  assert.equal(JSON.parse(await fs.readFile(files[0]!, 'utf8')).inputs.length, 12);
  assert.equal((await fs.stat(path.dirname(files[0]!))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(files[0]!)).mode & 0o777, 0o600);
});

test('撤回单向保留，修订关联不改旧原话，相同身份内容冲突拒绝覆盖', async t => {
  const directory = await fixture(t), original = input('queued', '允许登录原测试环境');
  const file = await saveAgentUserContext(directory, 'conversation', [original]);
  await saveAgentUserContext(directory, 'conversation', [{ ...original, withdrawn: true }, { ...input('revision', '撤回前条，改为只读代码', 1), revisesInputId: original.id }]);
  await saveAgentUserContext(directory, 'conversation', [original]);
  const before = await fs.readFile(file, 'utf8'), saved = JSON.parse(before);
  assert.equal(saved.inputs[0].user, original.user); assert.equal(saved.inputs[0].withdrawn, true);
  assert.equal(saved.inputs[1].revisesInputId, original.id);
  await assert.rejects(saveAgentUserContext(directory, 'conversation', [{ ...original, user: '被替换的授权' }]), /原文/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('损坏或符号链接历史不会被当成空白覆盖；删除仅清理对应对话', async t => {
  const directory = await fixture(t);
  const first = await saveAgentUserContext(directory, 'first', [input('first')]);
  const second = await saveAgentUserContext(directory, 'second', [input('second')]);
  await fs.writeFile(first, '{invalid');
  await assert.rejects(saveAgentUserContext(directory, 'first', [input('new')]), /记录/);
  assert.equal(await fs.readFile(first, 'utf8'), '{invalid');
  await fs.rm(first); await fs.symlink(second, first);
  await assert.rejects(saveAgentUserContext(directory, 'first', [input('new')]), /普通文件/);
  await removeAgentUserContext(directory, 'first'); await removeAgentUserContext(directory, 'first');
  assert.equal(JSON.parse(await fs.readFile(second, 'utf8')).inputs[0].user, 'second');
  await assert.rejects(fs.access(first), { code: 'ENOENT' });
});

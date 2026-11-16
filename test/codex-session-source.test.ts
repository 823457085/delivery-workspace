import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCodexSessionSource } from '../server/codex-session-source.js';

const exec = promisify(execFile);

test('Codex 会话源保留原生完成时间，不用最终回复或更新时间推断完成', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-turn-completion-test-'));
  const sessionId = '33333333-3333-3333-3333-333333333333';
  try {
    await exec('sqlite3', [path.join(codexHome, 'state_5.sqlite'), `
      CREATE TABLE threads(id TEXT,title TEXT,preview TEXT,cwd TEXT,git_branch TEXT,git_sha TEXT,model TEXT,reasoning_effort TEXT,archived INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,source TEXT,thread_source TEXT);
      INSERT INTO threads VALUES('${sessionId}','标题','预览','/repo','','','','',0,1789516800000,1789520400000,'vscode','user');
    `]);
    await exec('sqlite3', [path.join(codexHome, 'thread_history_1.sqlite'), `
      CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,started_at INTEGER,completed_at INTEGER,first_user_item_id TEXT,final_agent_item_id TEXT);
      CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_json TEXT);
      INSERT INTO thread_turns VALUES('${sessionId}','completed',1,1789516800,1789516860,'user-1','agent-1');
      INSERT INTO thread_turns VALUES('${sessionId}','unfinished',2,1789516900,NULL,'user-2','agent-2');
      INSERT INTO thread_items VALUES('${sessionId}','user-1','{"content":[{"type":"text","text":"第一问"}]}');
      INSERT INTO thread_items VALUES('${sessionId}','agent-1','{"text":"第一答"}');
      INSERT INTO thread_items VALUES('${sessionId}','user-2','{"content":[{"type":"text","text":"第二问"}]}');
      INSERT INTO thread_items VALUES('${sessionId}','agent-2','{"text":"未完成的回答"}');
    `]);

    const detail = await createCodexSessionSource(codexHome).session(sessionId);
    assert.equal(detail.turns[0].completedAt, '2026-09-16T00:01:00.000Z');
    assert.equal(detail.turns[0].updatedAt, detail.turns[0].completedAt);
    assert.equal(detail.turns[1].agentMessage, '未完成的回答');
    assert.equal(detail.turns[1].completedAt, null);
    assert.equal(detail.turns[1].updatedAt, detail.turns[1].createdAt);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test('旧会话的水位只取所选原生轮次，并拒绝会话目录外的路径', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-test-'));
  const session = '33333333-3333-3333-3333-333333333333';
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';
  try {
    await fs.mkdir(path.join(home, 'sessions'));
    const rollout = path.join(home, 'sessions', 'rollout.jsonl');
    const turn = (id: string, total: number, window: number) => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: window, last_token_usage: { total_tokens: total }, total_token_usage: { total_tokens: 20_000_000 },
      } } },
    ];
    await fs.writeFile(rollout, [...turn(first, 237015, 475000), ...turn(second, 10000, 200000)].map(event => JSON.stringify(event)).join('\n'));
    const database = path.join(home, 'state_5.sqlite');
    await exec('sqlite3', [database, `CREATE TABLE threads(id TEXT, rollout_path TEXT); INSERT INTO threads VALUES('${session}','${rollout}');`]);
    const source = createCodexSessionSource(home);
    assert.deepEqual(await source.contextUsage(session, first), { usedTokens: 237015, windowTokens: 475000 });
    assert.deepEqual(await source.contextUsage(session, second), { usedTokens: 10000, windowTokens: 200000 });
    const outside = path.join(home, 'rollout.jsonl');
    await fs.copyFile(rollout, outside);
    await fs.unlink(rollout);
    await fs.symlink(outside, rollout);
    assert.equal(await source.contextUsage(session, first), undefined);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

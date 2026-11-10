import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService } from '../server/agent-runtime.js';
import { createAgentRuntimeStream } from '../server/agent-runtime-stream.js';
import { createStateBackupStore } from '../server/state-backup.js';
import type { AgentAttachment, AgentConversationDeleteTarget, AgentRun, CodexSessionSummary } from '../shared/agent-runtime.js';

test('批量删除合并状态写入和刷新，重启保留共享附件与关联线程', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-batch-delete-'));
  const data = path.join(directory, 'agent-runtimes');
  const workspacePath = path.join(directory, 'workspace');
  const storePath = (name: string) => `agent-runtimes/${name}.json`;
  const [first, second, retained, missing] = Array.from({ length: 4 }, () => randomUUID());
  const [sharedThread, exclusiveThread, explicitlyHiddenThread] = Array.from({ length: 3 }, () => randomUUID());
  const timestamp = '2026-11-01T00:00:00.000Z';
  const workspace = { workspacePath, branch: 'feature/batch', headSha: 'abc123' };
  const makeAttachment = (name: string): AgentAttachment => ({ id: randomUUID(), name, mimeType: 'image/png', size: 1, url: '' });
  const sharedAttachment = makeAttachment('shared.png'), orphanedAttachment = makeAttachment('orphaned.png');
  const run = (id: string, sessionId: string, attachments: AgentAttachment[]): AgentRun => ({
    id, conversationId: id, queueRootId: id, ...workspace, provider: 'codex', mode: 'ask', accessMode: 'workspace',
    model: 'test-model', reasoningEffort: 'high', objective: id, sessionId, attachments, status: 'completed', pid: null,
    result: '', error: '', events: [], createdAt: timestamp, updatedAt: timestamp,
  });
  const sessions: CodexSessionSummary[] = [sharedThread, exclusiveThread, explicitlyHiddenThread].map(id => ({
    id, title: id, preview: '', ...workspace, model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: timestamp, updatedAt: timestamp,
  }));
  const writes: string[] = [], removedAttachments: string[][] = [], frames: string[] = [];
  const stream = createAgentRuntimeStream(frame => frames.push(frame), true);
  let service: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    await fs.mkdir(workspacePath);
    const stateBackup = await createStateBackupStore(directory);
    await stateBackup.writeJson(storePath('agent-runs'), [run(first, sharedThread, [sharedAttachment]),
      run(second, exclusiveThread, [orphanedAttachment]),
      { ...run(retained, sharedThread, [sharedAttachment]), originSessionId: explicitlyHiddenThread }]);
    await stateBackup.writeJson(storePath('codex-sessions'), { syncedAt: timestamp, sessions,
      details: Object.fromEntries(sessions.map(session => [session.id, { ...session, turns: [] }])) });
    await stateBackup.writeJson(storePath('hidden-codex-sessions'), []);
    await stateBackup.writeJson(storePath('conversation-titles'), { [first]: 'first', [second]: 'second', [retained]: 'retained',
      [sharedThread]: 'shared', [exclusiveThread]: 'exclusive', [explicitlyHiddenThread]: 'hidden' });
    let sourceCalls = 0;
    const open = () => createAgentRuntimeService(data, {
      adapters: [],
      stateBackup: { ...stateBackup, writeJson: (name, value) => { writes.push(name); return stateBackup.writeJson(name, value); } },
      codexSessionSource: { listSessions: async () => { sourceCalls++; return sessions; },
        session: async (id) => { sourceCalls++; return { ...sessions.find(session => session.id === id)!, turns: [] }; } },
      removeAttachments: async (ids) => { removedAttachments.push(ids); },
    });
    service = await open();
    service.subscribe((revision, update) => stream.update(revision, update));
    const targets: AgentConversationDeleteTarget[] = [{ id: first, source: 'workspace' },
      { id: explicitlyHiddenThread, source: 'codex' }, { id: second, source: 'workspace' }, { id: missing, source: 'workspace' }];
    const result = await service.removeConversations(targets);
    assert.deepEqual(result, { removed: targets.slice(0, 3), failures: [{ ...targets[3], message: '找不到该 Agent 会话' }] });
    assert.deepEqual(writes.sort(), ['agent-runs', 'codex-sessions', 'conversation-titles', 'hidden-codex-sessions'].map(storePath));
    assert.equal(frames.length, 1);
    assert.match(frames[0], /\nevent: refresh\n/);
    assert.equal(sourceCalls, 0);
    assert.deepEqual(removedAttachments, [[orphanedAttachment.id]]);

    await service.close();
    service = await open();
    await service.syncCodexSessions();
    const snapshot = service.snapshot();
    assert.deepEqual(snapshot.runs.map(item => item.id), [retained]);
    assert.deepEqual(snapshot.runs[0].attachments?.map(item => item.id), [sharedAttachment.id]);
    assert.deepEqual(snapshot.codexSessions.map(session => session.id), [sharedThread]);
    assert.equal(snapshot.codexSync.hidden, 2);
    assert.deepEqual(snapshot.conversationTitles, { [retained]: 'retained', [sharedThread]: 'shared' });
    assert.deepEqual((await service.codexSession(sharedThread)).turns, []);
    await assert.rejects(service.codexSession(explicitlyHiddenThread), /已从 Delivery Workspace 删除/);
  } finally {
    stream.close();
    await service?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

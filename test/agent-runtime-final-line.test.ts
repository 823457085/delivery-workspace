import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAdapter, createCursorAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('Cursor 和 Claude 保留无尾换行的最后一条原生 JSON 结果', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-final-line-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'peer.mjs');
  await fs.writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"result",subtype:"success",session_id:"fixture-native-session",result:"最终结果：已核对"}));\n', { mode: 0o700 });
  for (const provider of ['cursor', 'claude'] as const) {
    const sessions: string[] = [];
    const adapter = provider === 'cursor' ? createCursorAdapter(binary) : createClaudeAdapter(binary);
    const run: AgentRun = { id: `fixture-${provider}`, provider, mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
      objective: '检查最终结果', workspacePath: directory, branch: '', headSha: '', status: 'running', sessionId: '',
      pid: null, result: '', error: '', events: [], createdAt: '', updatedAt: '' };
    const result = await adapter.execute({ run, imagePaths: [], fileAttachments: [], signal: new AbortController().signal,
      onPid() {}, onSession: id => { sessions.push(id); }, onEvent() {} });
    assert.equal(result, '最终结果：已核对', provider);
    assert.deepEqual(sessions, ['fixture-native-session'], provider);
  }
});

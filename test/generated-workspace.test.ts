import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGeneratedWorkspace, resolveRenamedWorkspace } from '../server/generated-workspace.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createJiraFixService } from '../server/jira-fix.js';
import { createRequirementDevelopmentService } from '../server/requirement-development.js';
import type { AgentRun, CodexSessionSummary } from '../shared/agent-runtime.js';

test('工作目录使用本地日期时间；同秒并发递增编号，已有内容不被覆盖', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'generated-workspace-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const now = new Date(2026, 8, 24, 14, 49, 57);
  const existing = path.join(parent, 'TEST-3936-20260924-144957');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'draft.txt'), '保留已有文件');
  const folders = await Promise.all(Array.from({ length: 3 }, () => createGeneratedWorkspace(parent, 'feature/TEST-3936', undefined, now)));
  assert.deepEqual(new Set(folders.map(folder => path.basename(folder))), new Set([
    'TEST-3936-20260924-144957-2', 'TEST-3936-20260924-144957-3', 'TEST-3936-20260924-144957-4',
  ]));
  assert.equal(await fs.readFile(path.join(existing, 'draft.txt'), 'utf8'), '保留已有文件');
  await assert.rejects(createGeneratedWorkspace(path.join(parent, 'missing'), 'feature/TEST-3936'), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGeneratedWorkspace(parent, 'feature/TEST-3936', controller.signal), { name: 'AbortError' });
});

test('旧路径链接兼容历史文件；仅解析已改名的生成目录', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'renamed-workspace-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const original = path.join(parent, 'TEST-3924-7d75a7b1-6727-4677-8e23-31c27d4cdad8');
  const renamed = path.join(parent, 'TEST-3924-20260924-143909');
  await fs.mkdir(original); await fs.writeFile(path.join(original, 'draft.txt'), '原工作内容');
  await fs.rename(original, renamed); await fs.symlink(path.basename(renamed), original);
  const record = { workspacePath: original, sourceWorkspacePath: original, cursorTrustPath: original, objective: `历史消息 ${original}` };
  assert.deepEqual(await resolveRenamedWorkspace(record), { ...record, workspacePath: renamed, sourceWorkspacePath: renamed, cursorTrustPath: renamed });
  assert.equal(record.workspacePath, original);
  assert.equal(await fs.readFile(path.join(original, 'draft.txt'), 'utf8'), '原工作内容');
  const userAlias = path.join(parent, '用户目录');
  await fs.symlink(renamed, userAlias);
  assert.equal((await resolveRenamedWorkspace({ workspacePath: userAlias })).workspacePath, userAlias);
  const missing = `${original}-missing`;
  assert.equal((await resolveRenamedWorkspace({ workspacePath: missing })).workspacePath, missing);
});

test('旧运行和启动记录重载后使用新目录，再同步历史会话仍保留新路径', { timeout: 10_000 }, async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'renamed-records-')));
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  t.after(async () => { await runtime?.close(); await fs.rm(parent, { recursive: true, force: true }); });
  const id = '7d75a7b1-6727-4677-8e23-31c27d4cdad8';
  const original = path.join(parent, `TEST-3924-${id}`);
  const renamed = path.join(parent, 'TEST-3924-20260924-143909');
  await fs.mkdir(renamed); await fs.symlink(path.basename(renamed), original);
  const createdAt = '2026-09-24T06:39:09.456Z';
  const run: AgentRun = { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '', objective: '历史任务',
    workspacePath: original, branch: '', headSha: '', status: 'completed', sessionId: id, pid: null, result: '', error: '', events: [], createdAt, updatedAt: createdAt };
  const session: CodexSessionSummary = { id, title: '历史任务', preview: '', workspacePath: original, branch: '', headSha: '', model: '',
    reasoningEffort: '', archived: false, createdAt, updatedAt: createdAt };
  const detail = { ...session, turns: [] };
  const directory = path.join(parent, 'runtime'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([run]));
  await fs.writeFile(path.join(directory, 'codex-sessions.json'), JSON.stringify({ sessions: [session], details: { [id]: detail } }));
  let executed!: () => void;
  const execution = new Promise<void>(resolve => { executed = resolve; });
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Test', binary: '', version: 'test',
    ready: true, authenticated: true, message: '', modes: ['ask'], models: [{ id: '', label: '默认' }], defaultModel: '', writable: true, checkedAt: '' }),
  execute: async ({ run: resumed }) => { assert.equal(resumed.workspacePath, renamed); executed(); return '测试续聊'; } };
  runtime = await createAgentRuntimeService(directory, { adapters: [adapter],
    codexSessionSource: { listSessions: async () => [session], session: async () => detail } });
  assert.equal((await runtime.dashboard()).runs[0]?.workspacePath, renamed);
  assert.equal((await runtime.codexSession(id)).workspacePath, renamed);
  await runtime.syncCodexSessions();
  assert.equal((await runtime.dashboard()).codexSessions[0]?.workspacePath, renamed);
  assert.equal((await runtime.codexSession(id)).workspacePath, renamed);
  for (const kind of ['jira', 'requirement']) {
    const records = path.join(parent, kind); await fs.mkdir(records);
    await fs.writeFile(path.join(records, `${id}.json`), JSON.stringify({ id, input: {}, status: 'started', workspacePath: original, runId: id, createdAt }));
    const service = kind === 'jira'
      ? await createJiraFixService(records, { findJiraFix: () => run, startJiraFix: async () => run },
        { readJiraFixIssue: async () => { throw new Error('不应访问 Jira'); }, readLocalProjects: async () => { throw new Error('不应读取项目'); } })
      : await createRequirementDevelopmentService(records, { findRequirementDevelopment: () => run, startRequirementDevelopment: async () => run });
    assert.equal(service.list()[0]?.workspacePath, renamed);
    assert.equal(service.list()[0]?.id, id);
    await service.close();
  }
  const resumed = await runtime.resume(id, '继续');
  assert.equal(resumed.workspacePath, renamed);
  await execution;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJiraFixService } from '../server/jira-fix.js';
import { prepareRequirementWorkspace } from '../server/requirement-development.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { jiraFixInputSchema, jiraFixStartSchema, jiraIssueKey, matchJiraFixProjects, jiraFixPrompt, type JiraFixInput, type JiraFixProject } from '../shared/jira-fix.js';
import type { JiraIssue, LocalProject, ProjectsData } from '../shared/hub.js';

const exec = promisify(execFile);
const issue = { key: 'TEST-123', url: 'https://jira.example.test/browse/TEST-123', project: 'TEST', projectName: '测试', summary: '修复列表', status: 'L_123', parent: null } as JiraIssue;
const input: JiraFixInput = { issueKey: issue.url, repository: 'git@example.test:team/repo.git', parentDirectory: '/tmp', baseBranch: 'main', branch: 'feature/TEST-123', notes: '', rememberProject: true };
const source = { readJiraFixIssue: async (value: string) => ({ ...issue, key: jiraIssueKey(value) }),
  readLocalProjects: async () => ({ projects: [] } as unknown as ProjectsData) };
const request = (value = input, requestId = randomUUID()) => ({ requestId, input: value, authorization: 'clone-and-fix-jira' });
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('等待修复任务超时');
}
test('Jira 输入和执行授权严格校验，不接受任意链接、凭据仓库或主分支修复', () => {
  assert.equal(jiraIssueKey(' https://jira.example.test/browse/test-123?focusedCommentId=1 '), 'TEST-123');
  assert.equal(jiraIssueKey('https://jira.example.test/search?q=TEST-123'), '');
  assert.ok(jiraFixStartSchema.safeParse(request()).success);
  for (const override of [{ issueKey: 'TEST-1 OR 1=1' }, { branch: 'master' }, { baseBranch: '--upload-pack=bad' },
    { repository: 'https://token@example.test/repo' }, { repository: 'file:///private/repo' }, { baseBranch: input.branch }]) {
    assert.equal(jiraFixInputSchema.safeParse({ ...input, ...override }).success, false);
  }
  assert.equal(jiraFixStartSchema.safeParse({ ...request(), authorization: 'create-jira-design-transition-and-develop' }).success, false);
});
test('匹配持久配置及 Jira/父任务目录，按仓库去重，多个仓库保留供选择', () => {
  const binding: JiraFixProject = { projectKey: 'TEST', name: '前端', repository: input.repository, baseBranch: 'main', parentDirectory: '/chosen' };
  const local = (remoteUrl: string, branch: string, folder = 'repo') => ({ remoteUrl, branch, path: `/projects/${folder}`, rootPath: '/projects', projectName: '项目' } as LocalProject);
  const locals = [local('https://example.test/team/repo.git', 'feature/TEST-123'), local('git@example.test:team/api.git', 'feature/TEST-123-fix'), local('git@example.test:team/wrong.git', 'feature/TEST-1234')];
  const matched = matchJiraFixProjects(issue, [binding], locals);
  assert.equal(matched.length, 2); assert.equal(matched[0]?.parentDirectory, '/chosen'); assert.equal(matched[0]?.baseBranch, 'main');
  assert.equal(matchJiraFixProjects({ ...issue, key: 'TEST-9', parent: { key: 'TEST-123' } }, [], locals).length, 2);
  assert.equal(matchJiraFixProjects({ ...issue, key: 'TEST-12' }, [], locals).length, 0);
});
test('失败后新请求可重试，独立克隆指定基准，重复请求不重跑，配置重启后可自动匹配', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-fix-'));
  let executions = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Test', binary: '', version: 'test',
    ready: true, authenticated: true, message: '', modes: ['agent'], models: [{ id: 'gpt-6-astra', label: 'Test', efforts: ['xhigh'] }], defaultModel: 'gpt-6-astra', writable: true, checkedAt: '' }),
  execute: async ({ run }) => { executions++; assert.equal(run.accessMode, 'workspace'); assert.match(run.task?.sourceId || '', /^jira-fix:/); return '测试执行器完成'; } };
  const runtime = await createAgentRuntimeService(path.join(directory, 'runtime'), { adapters: [adapter] });
  let service: Awaited<ReturnType<typeof createJiraFixService>> | undefined;
  try {
    const original = path.join(directory, 'original');
    await exec('git', ['init', '-b', 'main', original]);
    await exec('git', ['-C', original, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'base']);
    const sha = (await exec('git', ['-C', original, 'rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['-C', original, 'switch', '-c', 'feature/existing']);
    await fs.writeFile(path.join(original, 'draft.txt'), 'preserve');
    let preparations = 0;
    service = await createJiraFixService(path.join(directory, 'records'), runtime, source, async (value, id, signal) => {
      preparations++;
      if (preparations === 1) throw new Error('ssh: connect to host example.test port 22: Operation timed out');
      return prepareRequirementWorkspace({ ...value, repository: original }, id, signal);
    });
    const payload = request({ ...input, parentDirectory: directory });
    const failed = service.start(payload);
    await waitFor(() => service!.list()[0]?.status === 'failed');
    assert.equal(executions, 0);
    assert.equal(service.start(payload).status, 'failed');
    assert.equal(preparations, 1);
    payload.requestId = randomUUID();
    const first = service.start(payload);
    assert.notEqual(first.id, failed.id);
    assert.equal(service.start(payload).id, first.id);
    assert.equal(service.start(request(payload.input)).id, first.id);
    assert.throws(() => service!.start(request({ ...payload.input, notes: '重复启动' })), /已有运行中/);
    await waitFor(() => service!.list()[0]?.runStatus === 'completed');
    const record = service.list()[0]!;
    assert.equal(record.headSha, sha); assert.equal(preparations, 2); assert.equal(executions, 1);
    assert.equal(service.list().find(item => item.id === failed.id)?.status, 'failed');
    assert.match(service.list().find(item => item.id === failed.id)?.error || '', /Operation timed out/);
    assert.notEqual(record.workspacePath, original);
    assert.equal((await exec('git', ['-C', record.workspacePath, 'branch', '--show-current'])).stdout.trim(), input.branch);
    assert.equal((await exec('git', ['-C', original, 'branch', '--show-current'])).stdout.trim(), 'feature/existing');
    assert.equal(await fs.readFile(path.join(original, 'draft.txt'), 'utf8'), 'preserve');
    assert.match(jiraFixPrompt(record), /不得.*评论或流转状态/);
    assert.match(jiraFixPrompt(record), /不得.*提交、推送/);
    assert.match(jiraFixPrompt(record), /不要写【待开发填写】、【待开发确认】等占位文字/);
    const reloaded = await createJiraFixService(path.join(directory, 'records'), runtime, source);
    assert.equal(reloaded.start(payload).runId, record.runId);
    const matched = await reloaded.resolve('TEST-124');
    assert.equal(matched.candidates[0]?.repository, input.repository);
    assert.equal(matched.candidates[0]?.baseBranch, 'main');
    assert.equal(matched.issue.status, 'L_123');
    await reloaded.close();
  } finally { await service?.close(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test('拉取失败不启动 Agent；服务中断不重放；本地项目不可读仍允许手工配置', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-fix-failure-'));
  let starts = 0;
  const runtime = { findJiraFix: () => undefined, startJiraFix: async () => { starts++; throw new Error('不可启动'); } };
  const failingSource = { ...source, readLocalProjects: async () => { throw new Error('目录不可读'); } };
  try {
    const service = await createJiraFixService(directory, runtime, failingSource, async () => { throw new Error('clone failed'); });
    const payload = request(); const first = service.start(payload);
    await waitFor(() => service.list()[0]?.status === 'failed');
    await service.close();
    assert.equal(starts, 0); assert.equal(service.list()[0]?.error, 'clone failed');
    assert.equal((await service.resolve('TEST-123')).projectWarning, '本地项目读取失败，可手动配置：目录不可读');
    await fs.writeFile(path.join(directory, `${first.id}.json`), JSON.stringify({ ...first, status: 'starting' }));
    const restored = await createJiraFixService(directory, runtime, source);
    assert.equal(restored.start(payload).status, 'uncertain');
    assert.throws(() => restored.start(request({ ...input, notes: '再次尝试' })), /待核对/);
    assert.equal(starts, 0); await restored.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('退出服务取消准备过程，不在退出后派发修复', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-fix-shutdown-'));
  let starts = 0, entered!: () => void;
  const prepared = new Promise<void>(resolve => { entered = resolve; });
  const runtime = { findJiraFix: () => undefined, startJiraFix: async () => { starts++; throw new Error('不可启动'); } };
  try {
    const service = await createJiraFixService(directory, runtime, source, async (_input, _id, signal) => {
      entered(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { workspacePath: directory, headSha: 'test' };
    });
    service.start(request()); await prepared; await service.close();
    assert.equal(starts, 0); assert.equal(service.list()[0]?.status, 'failed');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRequirementWorkspace, createRequirementDevelopmentService } from '../server/requirement-development.js';
import { requirementDevelopmentInputSchema, requirementDevelopmentPrompt, type RequirementDevelopmentInput } from '../shared/requirement-development.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';

const exec = promisify(execFile);
const input: RequirementDevelopmentInput = { title: '需求开发测试', issueKey: 'APEX-123', prdUrl: '', requirement: '', project: '', fixVersion: '', assignee: '',
  startDate: '2026-09-23', endDate: '2026-09-25', repository: 'git@example.test:team/repo.git', parentDirectory: '/tmp', branch: 'feature/APEX-123', confluenceParentUrl: '' };
const request = (value = input, requestId = randomUUID()) => ({ requestId, input: value, authorization: 'create-jira-design-transition-and-develop' });
async function repository(directory: string, branch = 'master') {
  const repo = path.join(directory, 'source');
  await exec('git', ['init', '-b', branch, repo]);
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'test baseline']);
  return repo;
}

test('需求输入允许 Jira 或 PRD/正文；需要明确项目、日期和安全仓库地址', () => {
  assert.ok(requirementDevelopmentInputSchema.safeParse(input).success);
  assert.ok(requirementDevelopmentInputSchema.safeParse({ ...input, issueKey: '', project: 'APEX', prdUrl: 'https://example.test/prd' }).success);
  for (const override of [{ issueKey: '', prdUrl: '', requirement: '' }, { issueKey: '', requirement: '正文', project: '' },
    { endDate: '2026-09-20' }, { branch: 'master' }, { repository: '--upload-pack=evil' }, { repository: 'https://secret@example.test/repo' },
    { repository: 'ssh://git:secret@example.test/repo' }]) assert.equal(requirementDevelopmentInputSchema.safeParse({ ...input, ...override }).success, false);
  const prompt = requirementDevelopmentPrompt(input, '/isolated', 'abc');
  assert.match(prompt, /先查重/); assert.match(prompt, /transitions/); assert.match(prompt, /不得伪造 G2a/);
  assert.match(prompt, /不要擅自.*提交、推送、合并或部署/);
});

test('独立目录严格从 master 创建 feature 分支，原有脏分支和文件不变', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-workspace-'));
  try {
    const source = await repository(directory);
    const master = (await exec('git', ['-C', source, 'rev-parse', 'master'])).stdout.trim();
    await exec('git', ['-C', source, 'switch', '-c', 'feature/existing']);
    await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'not master']);
    await fs.writeFile(path.join(source, 'user-draft.txt'), 'must remain');
    const id = randomUUID();
    const value = { ...input, repository: source, parentDirectory: directory };
    const result = await prepareRequirementWorkspace(value, id);
    assert.match(path.basename(result.workspacePath), /^APEX-123-\d{8}-\d{6}(?:-\d+)?$/);
    assert.equal(result.headSha, master);
    assert.equal((await exec('git', ['-C', result.workspacePath, 'branch', '--show-current'])).stdout.trim(), input.branch);
    assert.equal((await exec('git', ['-C', result.workspacePath, 'rev-parse', 'HEAD'])).stdout.trim(), master);
    assert.equal((await exec('git', ['-C', source, 'branch', '--show-current'])).stdout.trim(), 'feature/existing');
    assert.equal(await fs.readFile(path.join(source, 'user-draft.txt'), 'utf8'), 'must remain');
    const another = await prepareRequirementWorkspace(value, randomUUID());
    assert.notEqual(another.workspacePath, result.workspacePath);
    assert.equal((await exec('git', ['-C', result.workspacePath, 'rev-parse', 'HEAD'])).stdout.trim(), master);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('缺少 master 不回退其他分支，不覆盖目录，保留失败目录供排查', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-no-master-'));
  try {
    const source = await repository(directory, 'main');
    await assert.rejects(prepareRequirementWorkspace({ ...input, repository: source, parentDirectory: directory }, randomUUID()), error => {
      assert.match((error as Error).message, /读取远端基准分支 master失败/);
      assert.match((error as Error).message, /fatal:/);
      assert.match((error as Error).message, /新目录已保留/);
      return true;
    });
    assert.equal((await fs.readdir(directory)).length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('克隆失败展示 Git 原始错误，不误报为权限或基准分支问题', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-clone-error-'));
  try {
    await assert.rejects(prepareRequirementWorkspace({ ...input, repository: path.join(directory, 'missing-repository'), parentDirectory: directory }, randomUUID()), error => {
      const message = (error as Error).message;
      assert.match(message, /克隆仓库失败/);
      assert.match(message, /fatal:.*does not exist/);
      assert.doesNotMatch(message, /请检查仓库权限/);
      assert.match(message, /新目录已保留/);
      return true;
    });
    assert.equal((await fs.readdir(directory)).length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('确认后创建真实 runtime 会话，固定 GPT-6 超高；并发与重启重试不重复启动', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-runtime-'));
  let executions = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'Test', binary: '', version: 'test',
    ready: true, authenticated: true, message: '', modes: ['agent'], models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['xhigh'] }],
    defaultModel: 'gpt-6-astra', writable: true, checkedAt: '' }),
  execute: async ({ run }) => { executions++; assert.equal(run.model, 'gpt-6-astra'); assert.equal(run.reasoningEffort, 'xhigh');
    assert.equal(run.branch, input.branch); assert.equal(run.task?.source, 'workflow'); return '测试执行器已接收；未访问 Jira'; } };
  const runtime = await createAgentRuntimeService(path.join(directory, 'runtime'), { adapters: [adapter] });
  try {
    const source = await repository(directory);
    const prepare = (value: RequirementDevelopmentInput, id: string) => prepareRequirementWorkspace({ ...value, repository: source }, id);
    const store = path.join(directory, 'records');
    const service = await createRequirementDevelopmentService(store, runtime, prepare);
    const payload = request({ ...input, parentDirectory: directory });
    const [first, duplicate] = await Promise.all([service.start(payload), service.start(payload)]);
    assert.equal(first.status, 'started'); assert.equal(first.runId, duplicate.runId);
    assert.equal((await service.start({ ...payload, requestId: randomUUID() })).runId, first.runId);
    assert.throws(() => service.start({ ...payload, input: { ...payload.input, title: 'changed' } }), /请求已使用/);
    const reloaded = await createRequirementDevelopmentService(store, runtime, prepare);
    assert.equal((await reloaded.start(payload)).runId, first.runId);
    const run = runtime.findRequirementDevelopment(first.id)!;
    assert.equal(run.accessMode, 'full');
    assert.equal(run.workspacePath, first.workspacePath);
    await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 5000; const check = () => {
      if (executions === 1) resolve(); else if (Date.now() > deadline) reject(new Error('测试执行器未收到任务')); else setTimeout(check, 10);
    }; check(); });
    assert.equal(executions, 1);
    assert.throws(() => service.start({ ...payload, authorization: 'publish-confluence-and-create-jira' }));
  } finally { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('克隆失败不创建 Agent；重启后不自动重放不确定的启动', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-failed-'));
  let starts = 0;
  const runtime = { findRequirementDevelopment: () => undefined, startRequirementDevelopment: async () => { starts++; throw new Error('must not start'); } };
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, async () => { throw new Error('clone failed'); });
    const payload = request();
    const result = await service.start(payload);
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'clone failed'); assert.equal(starts, 0);
    await fs.writeFile(path.join(directory, `${result.id}.json`), JSON.stringify({ ...result, status: 'starting', error: '' }));
    const reloaded = await createRequirementDevelopmentService(directory, runtime);
    assert.equal((await reloaded.start(payload)).status, 'uncertain');
    assert.equal(starts, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('同一需求准备期间禁止换标题重复启动；退出服务不会晚启动 Agent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-shutdown-'));
  let starts = 0;
  let prepared!: () => void;
  const entered = new Promise<void>(resolve => { prepared = resolve; });
  const runtime = { findRequirementDevelopment: () => undefined, startRequirementDevelopment: async () => { starts++; throw new Error('must not start'); } };
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, async (_input, _id, signal) => {
      prepared();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { workspacePath: directory, headSha: 'test' };
    });
    const payload = request();
    const starting = service.start(payload);
    await entered;
    assert.throws(() => service.start(request({ ...input, issueKey: 'https://jira.example.test/browse/APEX-123', title: '不同标题' })), /不要重复启动/);
    await service.close();
    assert.equal((await starting).status, 'failed');
    assert.equal(starts, 0);
    assert.throws(() => service.start(request()), /服务正在退出/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequirementDevelopmentService } from '../server/requirement-development';
import { emptyRequirementProgress, readRequirementProgressReport, requirementProgressDataSchema, requirementDevelopmentPrompt,
  type RequirementProgressData, type RequirementDevelopmentInput } from '../shared/requirement-development';
import { forIssue, launchDeliveryRecords } from '../src/features/workbench/domain';
import type { AgentRun } from '../shared/agent-runtime';

const input: RequirementDevelopmentInput = { title: '需求进度测试', issueKey: 'APEX-123', prdUrl: '', requirement: '', project: 'APEX', fixVersion: '', assignee: '',
  startDate: '2026-10-16', endDate: '2026-10-17', repository: 'git@example.test:team/repo.git', parentDirectory: '/tmp', branch: 'feature/APEX-123', confluenceParentUrl: '' };
function progress(): RequirementProgressData {
  const value = emptyRequirementProgress();
  value.issueKeys = ['APEX-123', 'APEX-124', 'APEX-125'];
  value.stages.intake = { status: 'completed', evidence: 'APEX-123 需求已核对' };
  value.stages.tasks = { status: 'completed', evidence: '已回读关联任务 APEX-124 / APEX-125' };
  value.stages.design = { status: 'completed', evidence: 'docs/requirements/design.md' };
  value.stages.development = { status: 'in_progress', evidence: '首批实现' };
  return value;
}
function report(value = progress()) { return `本轮结果\n\n\`\`\`delivery-report\n${JSON.stringify({ version: 1, requirementProgress: value })}\n\`\`\``; }
function runtimeFixture() {
  const runs = new Map<string, AgentRun>();
  let subscriber: ((revision: number, run?: AgentRun, finalized?: boolean) => void) | undefined;
  return { runs, notify: (id: string, finalized = true) => subscriber?.(1, runs.get(id), finalized),
    subscribe: (listener: NonNullable<typeof subscriber>) => { subscriber = listener; return () => { subscriber = undefined; }; },
    findRequirementDevelopment: (id: string) => runs.get(id), startRequirementDevelopment: async (_input: unknown, id: string) => {
    const run: AgentRun = { id: 'run-1', provider: 'codex', mode: 'agent', accessMode: 'full', model: 'test', reasoningEffort: 'xhigh',
      objective: '', workspacePath: '/isolated/progress-test', branch: input.branch, headSha: 'abc', status: 'completed', sessionId: '', pid: null,
      result: report(), error: '', events: [], createdAt: '2026-10-16T01:00:00Z', updatedAt: '2026-10-16T02:00:00Z' };
    run.task = { parentConversationId: '', dependsOnConversationIds: [], role: 'main', title: input.title,
      source: 'workflow', sourceId: `requirement:${id}` };
    runs.set(id, run); return run;
  } };
}
const prepare = async () => ({ workspacePath: '/isolated/progress-test', headSha: 'abc' });
const request = () => ({ requestId: randomUUID(), input, authorization: 'create-jira-design-transition-and-develop' });
const manual = (expectedRevision = 0) => ({ runId: 'run-1', expectedRevision, progress: progress(), authorization: 'record-requirement-progress' });
const importRequest = (expectedRevision = 0) => ({ runId: 'run-1', expectedRevision, authorization: 'import-requirement-progress' });

test('阶段证据完整、Jira Key 规范化去重；不从普通文本或多个报告推测阶段', () => {
  const parsed = requirementProgressDataSchema.parse({ ...progress(), issueKeys: ['apex-123', 'APEX-123', ' TEST-9 '] });
  assert.deepEqual(parsed.issueKeys, ['APEX-123', 'TEST-9']);
  for (const status of ['completed', 'blocked', 'not_applicable'] as const) {
    const value = progress(); value.stages.verification = { status, evidence: '' };
    assert.equal(requirementProgressDataSchema.safeParse(value).success, false);
  }
  assert.throws(() => readRequirementProgressReport('功能已全部完成 APEX-123 APEX-124'), /delivery-report/);
  assert.throws(() => readRequirementProgressReport(`${report()}\n${report()}`), /一个明确/);
  assert.throws(() => readRequirementProgressReport('```delivery-report\n{invalid}\n```'), /有效 JSON/);
  assert.throws(() => readRequirementProgressReport('```delivery-report\n{"version":1,"requirementProgress":{},"acceptance":"accepted"}\n```'));
  assert.deepEqual(readRequirementProgressReport(report()), progress());
  assert.match(requirementDevelopmentPrompt(input, '/isolated', 'abc'), /delivery-report/);
});

test('报告示例、引用和嵌套代码不是顶层交付报告，不能被导入', () => {
  const block = report().slice(report().indexOf('```delivery-report'));
  for (const example of [
    `以下仅是输出格式示例：\n\n\`\`\`\`markdown\n${block}\n\`\`\`\``,
    `格式字符串：${block}`,
    block.split('\n').map(line => `> ${line}`).join('\n'),
    block.split('\n').map(line => `    ${line}`).join('\n'),
    `1. 格式示例：\n${block.split('\n').map(line => `   ${line}`).join('\n')}`,
  ]) assert.throws(() => readRequirementProgressReport(example), /delivery-report/);
  assert.deepEqual(readRequirementProgressReport(report().replaceAll('\n', '\r\n')), progress());
});

test('手动阶段保存到原需求记录，新增 Jira Key 进入工作台双向查找，重启后保留', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-progress-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    assert.equal(initial.progress, undefined);
    const saved = await service.updateProgress(initial.id, manual());
    assert.equal(saved.progress!.revision, 1); assert.equal(saved.progress!.source, 'manual');
    assert.equal(saved.progress!.sourceRunId, 'run-1'); assert.deepEqual(saved.progress!.issueKeys, progress().issueKeys);
    const rows = launchDeliveryRecords(service.list());
    for (const key of ['APEX-123', 'APEX-124', 'APEX-125']) assert.equal(forIssue(rows, key)[0].id, `requirement:${initial.id}`);
    saved.progress!.issueKeys.length = 0;
    assert.equal(service.list()[0].progress!.issueKeys.length, 3);
    const reloaded = await createRequirementDevelopmentService(directory, runtime, prepare);
    assert.deepEqual(reloaded.list()[0].progress, service.list()[0].progress);
    await service.close(); await reloaded.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('导入只读取当前已结束运行的单个结构化报告，无新完成事件不自动推进', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-import-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    const run = runtime.runs.get(initial.id)!;
    assert.equal(service.list()[0].progress, undefined);
    run.status = 'running'; await assert.rejects(service.importProgress(initial.id, importRequest()), /本轮尚未结束/);
    run.status = 'completed'; run.result = '所有阶段完成';
    await assert.rejects(service.importProgress(initial.id, importRequest()), /delivery-report/);
    assert.equal(service.list()[0].progress, undefined);
    run.result = report();
    const saved = await service.importProgress(initial.id, importRequest());
    assert.equal(saved.progress!.source, 'agent-result'); assert.equal(saved.progress!.stages.verification.status, 'pending');
    const repeated = await service.importProgress(initial.id, importRequest(1));
    assert.equal(repeated.progress!.revision, 1);
    run.result = '```delivery-report\n{"bad":true}\n```';
    await assert.rejects(service.importProgress(initial.id, importRequest(1)));
    assert.deepEqual(service.list()[0].progress, saved.progress);
    await service.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('仅新完成通知自动同步报告；瞬时完成、重复通知及关闭收尾不会丢失或重复进度', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-auto-'));
  const runtime = runtimeFixture();
  const originalStart = runtime.startRequirementDevelopment;
  runtime.startRequirementDevelopment = async (value, id) => {
    const run = await originalStart(value, id);
    runtime.notify(id, false);
    runtime.notify(id);
    runtime.notify(id);
    return run;
  };
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    await service.close();
    const saved = service.list()[0].progress!;
    assert.equal(saved.revision, 1);
    assert.equal(saved.source, 'agent-result');
    assert.deepEqual(saved.stages, progress().stages);
    runtime.runs.get(initial.id)!.result = report({ ...progress(), issueKeys: ['APEX-999'] });
    runtime.notify(initial.id);
    assert.deepEqual(service.list()[0].progress, saved);
    const restarted = await createRequirementDevelopmentService(directory, runtime, prepare);
    assert.deepEqual(restarted.list()[0].progress, saved);
    await restarted.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('过程通知不自动导入；坏报告保留已有进度并提示手动核对', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-auto-invalid-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    runtime.notify(initial.id, false);
    assert.equal(service.list()[0].progress, undefined);
    const saved = await service.importProgress(initial.id, importRequest());
    runtime.runs.get(initial.id)!.result = '本轮全部完成';
    runtime.notify(initial.id);
    await service.close();
    assert.deepEqual(service.list()[0].progress, saved.progress);
    assert.match(service.list()[0].progressSyncError!, /未能自动同步/);
    const restarted = await createRequirementDevelopmentService(directory, runtime, prepare);
    runtime.runs.get(initial.id)!.result = report();
    await restarted.importProgress(initial.id, importRequest(1));
    assert.equal(restarted.list()[0].progressSyncError, '');
    await restarted.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('自动同步在写队列中保护人工进度，包括前一轮人工记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-auto-manual-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    const saving = service.updateProgress(initial.id, manual());
    runtime.notify(initial.id);
    const saved = await saving;
    runtime.runs.set(initial.id, { ...runtime.runs.get(initial.id)!, id: 'run-2', result: report({ ...progress(), issueKeys: ['APEX-999'] }) });
    runtime.notify(initial.id);
    await service.close();
    assert.deepEqual(service.list()[0].progress, saved.progress);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('自动同步写入失败不替换已有进度；迟到的旧轮通知不导入新轮', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-auto-write-'));
  const runtime = runtimeFixture(); let failWrite = false;
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare, { writeJson: async (relative, value) => {
      if (failWrite) throw new Error('fixture: storage unavailable');
      await fs.writeFile(path.join(directory, path.basename(relative)), JSON.stringify(value));
    } });
    const initial = await service.start(request());
    const saved = await service.importProgress(initial.id, importRequest());
    runtime.runs.get(initial.id)!.result = report({ ...progress(), issueKeys: ['APEX-999'] });
    failWrite = true;
    runtime.notify(initial.id);
    await service.close();
    assert.deepEqual(service.list()[0].progress, saved.progress);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${initial.id}.json`), 'utf8')).progress, saved.progress);
    const restarted = await createRequirementDevelopmentService(directory, runtime, prepare);
    runtime.notify(initial.id);
    runtime.runs.set(initial.id, { ...runtime.runs.get(initial.id)!, id: 'run-2', status: 'queued' });
    await restarted.close();
    assert.deepEqual(restarted.list()[0].progress, saved.progress);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('错误来源和旧版本被拒绝，并发编辑不能覆盖已保存进度', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-progress-race-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    await assert.rejects(service.updateProgress('missing', manual()), { statusCode: 404 });
    await assert.rejects(service.updateProgress(initial.id, { ...manual(), runId: 'wrong' }), { statusCode: 409 });
    const writes = await Promise.allSettled([service.updateProgress(initial.id, manual()), service.updateProgress(initial.id, manual())]);
    assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(writes.filter(item => item.status === 'rejected').length, 1);
    await assert.rejects(service.updateProgress(initial.id, manual()), { statusCode: 409 });
    runtime.runs.set(initial.id, { ...runtime.runs.get(initial.id)!, id: 'run-2' });
    await assert.rejects(service.importProgress(initial.id, importRequest(1)), { statusCode: 409 });
    assert.equal(service.list()[0].progress!.revision, 1);
    await service.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('进度持久化失败保留之前版本，不假报成功', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-progress-writer-'));
  const runtime = runtimeFixture(); let failProgress = false;
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare, { writeJson: async (relative, value) => {
      assert.match(relative, /^requirement-development\/[a-f0-9-]{36}\.json$/);
      if (failProgress) throw new Error('backup failed');
      await fs.writeFile(path.join(directory, path.basename(relative)), JSON.stringify(value));
    } });
    const initial = await service.start(request());
    const saved = await service.updateProgress(initial.id, manual());
    failProgress = true;
    const changed = manual(1); changed.progress.stages.development = { status: 'completed', evidence: '已完成代码核验' };
    await assert.rejects(service.updateProgress(initial.id, changed), /backup failed/);
    assert.deepEqual(service.list()[0].progress, saved.progress);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${initial.id}.json`), 'utf8')).progress, saved.progress);
    await service.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('旧记录无 progress 兼容读取，畸形新进度启动时拒绝而不覆盖原件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-progress-corrupt-'));
  const runtime = runtimeFixture();
  try {
    const service = await createRequirementDevelopmentService(directory, runtime, prepare);
    const initial = await service.start(request());
    await service.close();
    const file = path.join(directory, `${initial.id}.json`);
    const broken = JSON.stringify({ ...initial, progress: { revision: 1, stages: {} } });
    await fs.writeFile(file, broken);
    await assert.rejects(createRequirementDevelopmentService(directory, runtime, prepare));
    assert.equal(await fs.readFile(file, 'utf8'), broken);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

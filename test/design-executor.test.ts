import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXECUTION_STAGES, emptyArtifacts, executionStartSchema, isCurrentStepResult, type DesignExecution, type StageResult, type ToolProof, type ExecutionStage } from '../shared/design-execution.js';
import { createDesignExecutor } from '../server/design-executor/service.js';
import { desktopHealth } from '../server/design-executor/desktop.js';
import { createCodexExecutor, phaseArguments, codexFailureMessage, extractToolProof, type PhaseExecutor, type PhaseContext } from '../server/design-executor/codex.js';
import { allowedTools, stagePrompt, validateStage } from '../server/design-executor/policy.js';
import { emptyInput, emptyReview, buildDesignCards, cardLane, stageChecks } from '../src/features/tech-design-delivery/domain.js';
import { cliBinary } from '../server/cli-runtime.js';

const health = { ready: true, cli: 'test-double', authenticated: true, atlassianConfigured: true, skillsReady: true, message: 'TEST ONLY', checkedAt: '2026-09-07' };
const input = { ...emptyInput(), issueKey: 'TEST-1', title: '隔离测试', jiraStartDate: '2026-09-09', jiraEndDate: '2026-09-16', workspacePath: os.tmpdir(), confluenceParentUrl: 'https://example.test/pages/viewpage.action?pageId=100' };
const artifacts = { ...emptyArtifacts(), requirementKey: 'TEST-1', project: 'TEST', fixVersion: 'v1', assignee: 'test', parentPageId: '100', spaceKey: 'TEST',
  documentId: '101', documentUrl: 'https://example.test/doc', documentTitle: 'TEST-1 技术方案', documentVersion: 1, devParentKey: 'TEST-2', designTaskKey: 'TEST-3', implementationTaskKey: 'TEST-4' };
function output(stage: ExecutionStage): { result: StageResult; proof: ToolProof[] } {
  return { result: { outcome: 'passed', summary: '测试阶段结果，不调用真实 AI 或外部 API',
    checks: EXECUTION_STAGES.find((s) => s.id === stage)!.checks.map((id) => ({ id, passed: true, detail: '测试证据' })),
    evidence: [{ kind: 'code', ref: '/test/code', detail: '测试证据' }], artifacts: { ...artifacts },
    markdown: stage === 'design' ? '元信息 方案摘要 需求映射 影响范围 详细设计 与 PRD 差异 风险 测试关注点 任务拆分 回滚 覆盖度矩阵 G2a\n' + '测试方案正文。'.repeat(200) : '' },
    proof: ['TEST-1', 'TEST-2', 'TEST-3', 'TEST-4'].map((target) => ({ tool: 'jira_get_issue', target, succeeded: true })).concat([
      { tool: 'confluence_get_page', target: '100', succeeded: true }, { tool: 'confluence_get_page', target: '101', succeeded: true },
      { tool: 'command_execution', target: '', succeeded: true },
    ]),
  };
}
function request(workspacePath: string) { return { input: { ...input, workspacePath }, authorization: 'publish-confluence-and-create-jira' }; }
function emptyRun(): DesignExecution {
  return { id: randomUUID(), input: { ...input }, status: 'queued', createdAt: '', updatedAt: '', authorizedAt: '', revision: 1,
    threadId: '', attemptIds: [], steps: [], events: [], error: '', clarification: '', artifacts: emptyArtifacts() };
}
async function fixture(executor?: PhaseExecutor) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-executor-test-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'design-workspace-test-'));
  const service = await createDesignExecutor(path.join(root, 'executor'), executor);
  return { root, workspace, service };
}

test('desktop uses bundled support without a Codex home and blocks missing explicit support packages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-support-test-'));
  try {
    const environment = { CODEX_HOME: root };
    const available = await desktopHealth(environment);
    assert.equal(available.ready, true);
    assert.equal(available.skillsReady, true);
    for (const setting of ['DELIVERY_SKILLS_ROOT', 'AI_DELIVERY_KIT_ROOT']) {
      const missing = await desktopHealth({ ...environment, [setting]: path.join(root, setting) });
      assert.equal(missing.ready, false);
      assert.equal(missing.skillsReady, false);
      assert.equal(missing.message, 'Skill / 规范包缺失');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('default execution waits for desktop claim; six stages are ordered, bound and idempotent without CLI', async () => {
  const f = await fixture();
  const threadId = randomUUID();
  try {
    const { id } = await f.service.start(request(f.workspace));
    await f.service.idle();
    const dashboard = await f.service.dashboard();
    assert.equal(dashboard.health.mode, 'codex-desktop');
    assert.equal(dashboard.health.cli, '');
    assert.equal(dashboard.health.authenticated, false);
    assert.equal(dashboard.runs[0].status, 'queued');
    assert.equal(dashboard.runs[0].steps[0].attempts, 0);
    for (const stage of EXECUTION_STAGES.map(item => item.id)) {
      const packet = f.service.desktop(id);
      assert.equal(packet.stage, stage);
      const claimed = await f.service.claim(id, { revision: packet.run.revision, threadId });
      assert.equal(claimed.run.status, 'running');
      assert.equal(claimed.run.desktopClaim?.stage, stage);
      await assert.rejects(f.service.claim(id, { revision: claimed.run.revision, threadId: randomUUID() }), /原 Codex 会话/);
      const same = await f.service.claim(id, { revision: packet.run.revision, threadId });
      assert.equal(same.run.desktopClaim?.id, claimed.run.desktopClaim?.id);
      const submission = { claimId: claimed.run.desktopClaim!.id, threadId, stage, ...output(stage) };
      await assert.rejects(f.service.submit(id, { ...submission, stage: stage === 'intake' ? 'research' : 'intake' }), /阶段不匹配/);
      await assert.rejects(f.service.submit(id, { ...submission, proof: [{ tool: 'jira_transition_issue', target: 'TEST-1', succeeded: true }] }), /未授权/);
      const saved = await f.service.submit(id, submission);
      const replay = await f.service.submit(id, submission);
      assert.equal(saved.run.revision, replay.run.revision);
      await assert.rejects(f.service.submit(id, { ...submission, result: { ...submission.result, summary: 'changed' } }), /不同结果覆盖/);
      assert.equal(saved.run.steps.find(item => item.id === stage)?.proofSource, 'codex-desktop');
    }
    assert.equal(f.service.desktop(id).run.status, 'completed');
    assert.match(await fs.readFile(path.join(f.root, 'executor', id, 'tech-design.md'), 'utf8'), /覆盖度矩阵/);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('desktop stop invalidates callbacks and missing readback cannot pass after resume', async () => {
  const f = await fixture();
  const threadId = randomUUID();
  try {
    const { id } = await f.service.start(request(f.workspace));
    let packet = f.service.desktop(id);
    packet = await f.service.claim(id, { revision: packet.run.revision, threadId });
    const old = { claimId: packet.run.desktopClaim!.id, threadId, stage: 'intake', ...output('intake') };
    await f.service.stop(id, packet.run.revision);
    await assert.rejects(f.service.submit(id, old), /领取已失效/);
    packet = f.service.desktop(id);
    await f.service.resume(id, { revision: packet.run.revision, clarification: '已核对', authorization: 'publish-confluence-and-create-jira' });
    packet = f.service.desktop(id);
    packet = await f.service.claim(id, { revision: packet.run.revision, threadId });
    const failed = await f.service.submit(id, { ...old, claimId: packet.run.desktopClaim!.id, proof: [] });
    assert.equal(failed.run.status, 'blocked');
    assert.equal(failed.run.steps[1].attempts, 0);
    assert.match(failed.run.error, /实际读取凭证/);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('desktop restart retains completed stages and blocks an unfinished claim without rerunning', async () => {
  const f = await fixture();
  let service = f.service;
  const threadId = randomUUID();
  try {
    const { id } = await service.start(request(f.workspace));
    let packet = service.desktop(id);
    packet = await service.claim(id, { revision: packet.run.revision, threadId });
    packet = await service.submit(id, { claimId: packet.run.desktopClaim!.id, threadId, stage: 'intake', ...output('intake') });
    await service.claim(id, { revision: packet.run.revision, threadId });
    await service.close();
    service = await createDesignExecutor(path.join(f.root, 'executor'));
    const restored = service.desktop(id).run;
    assert.equal(restored.threadId, threadId);
    assert.equal(restored.steps[0].status, 'passed');
    assert.equal(restored.steps[1].status, 'blocked');
    assert.equal(restored.desktopClaim, undefined);
    assert.equal(restored.status, 'blocked');
    assert.deepEqual(restored.artifacts, artifacts);
  } finally { await service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('real Mastra traverses all six stages with injected executor; duplicate confirmation cannot launch again', async () => {
  const calls: string[] = [];
  const threadId = randomUUID();
  const f = await fixture({ health: async () => health, execute: async (ctx) => { calls.push(ctx.stage); await ctx.onThread(threadId); return output(ctx.stage); } });
  try {
    const started = await f.service.start(request(f.workspace));
    await f.service.idle();
    const run = (await f.service.dashboard()).runs[0];
    assert.equal(run.id, started.id);
    assert.deepEqual(calls, EXECUTION_STAGES.map((step) => step.id));
    assert.equal(run.status, 'completed');
    assert.equal(run.threadId, threadId);
    assert.equal((await f.service.snapshot(run.id))?.status, 'success');
    assert.match(await fs.readFile(path.join(f.root, 'executor', run.id, 'tech-design.md'), 'utf8'), /覆盖度矩阵/);
    await assert.rejects(f.service.start(request(f.workspace)), /已有自动执行记录/);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('blocked publication persists through restart; resume skips passed stages and retains one thread', async () => {
  const calls: string[] = [];
  let block = true;
  const threadId = randomUUID();
  const executor: PhaseExecutor = { health: async () => health, execute: async (ctx) => {
    calls.push(ctx.stage); await ctx.onThread(threadId);
    assert.equal(ctx.run.steps.find(step => step.id === ctx.stage)?.endedAt, undefined);
    if (ctx.stage === 'publish' && block) return { ...output(ctx.stage), result: { ...output(ctx.stage).result, outcome: 'blocked', summary: '目录权限不足' } };
    return output(ctx.stage);
  } };
  const f = await fixture(executor);
  let service = f.service;
  try {
    const { id } = await service.start(request(f.workspace)); await service.idle();
    assert.equal((await service.dashboard()).runs[0].status, 'blocked');
    assert.equal((await service.snapshot(id))?.status, 'suspended');
    await service.close();
    service = await createDesignExecutor(path.join(f.root, 'executor'), executor);
    const before = (await service.dashboard()).runs[0];
    await assert.rejects(service.resume(id, { revision: before.revision - 1, clarification: '', authorization: 'publish-confluence-and-create-jira' }), /已变化/);
    block = false;
    await service.resume(id, { revision: before.revision, clarification: '权限已由管理员补齐', authorization: 'publish-confluence-and-create-jira' });
    await service.idle();
    const after = (await service.dashboard()).runs[0];
    assert.equal(after.status, 'completed');
    assert.equal(after.attemptIds.length, 2);
    assert.deepEqual(calls, ['intake', 'research', 'design', 'publish', 'publish', 'jira', 'verify']);
    assert.equal(after.threadId, threadId);
  } finally { await service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('startup failure preserves prior evidence without presenting it as the current attempt', async () => {
  let failStartup = false;
  const prior = output('intake');
  prior.result.outcome = 'blocked';
  prior.result.summary = '旧的输入检查失败';
  const f = await fixture({ health: async () => health, execute: async () => {
    if (failStartup) throw new Error('会话写锁占用');
    return prior;
  } });
  try {
    const { id } = await f.service.start(request(f.workspace)); await f.service.idle();
    const before = (await f.service.dashboard()).runs[0];
    assert.equal(before.steps[0].resultAttempt, 1);
    assert.equal(isCurrentStepResult(before.steps[0]), true);
    failStartup = true;
    await f.service.resume(id, { revision: before.revision, clarification: '', authorization: 'publish-confluence-and-create-jira' });
    await f.service.idle();
    const step = (await f.service.dashboard()).runs[0].steps[0];
    assert.equal(step.attempts, 2);
    assert.equal(step.resultAttempt, 1);
    assert.equal(step.summary, '会话写锁占用');
    assert.deepEqual(step.result, prior.result);
    assert.deepEqual(step.proof, prior.proof);
    assert.equal(isCurrentStepResult(step), false);
    assert.equal(isCurrentStepResult({ ...step, resultAttempt: undefined }), false);
    assert.equal(isCurrentStepResult({ ...step, resultAttempt: undefined, status: 'passed' }), true);
    assert.equal(isCurrentStepResult({ ...step, resultAttempt: 2 }), true);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('stop aborts the current executor and never publishes later stages', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture({ health: async () => health, execute: async ({ signal }) => {
    entered();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('测试中止');
  } });
  try {
    const { id } = await f.service.start(request(f.workspace)); await started;
    const run = (await f.service.dashboard()).runs[0];
    await f.service.stop(id, run.revision); await f.service.idle();
    const stopped = (await f.service.dashboard()).runs[0];
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.steps[3].attempts, 0);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('missing explicit authorization fails before any executor call; same data directory cannot have two workers', async () => {
  let calls = 0;
  const f = await fixture({ health: async () => health, execute: async (ctx) => { calls++; return output(ctx.stage); } });
  try {
    await assert.rejects(f.service.start({ input: { ...input, workspacePath: f.workspace } }));
    await assert.rejects(createDesignExecutor(path.join(f.root, 'executor')), /已有执行器/);
    assert.equal(calls, 0);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('model declarations cannot replace actual matching readback tool receipts', () => {
  const run = emptyRun();
  assert.ok(validateStage('publish', output('publish').result, [], run).some((gap) => gap.includes('回读凭证')));
  assert.ok(validateStage('jira', output('jira').result, output('jira').proof.filter((p) => p.target !== 'TEST-4'), run).some((gap) => gap.includes('TEST-4')));
  const bad = output('verify'); bad.result.artifacts.documentUrl = 'javascript:alert(1)';
  assert.ok(validateStage('verify', bad.result, bad.proof, run).some((gap) => gap.includes('有效')));
  assert.equal(extractToolProof({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'atlassian', tool: 'jira_get_issue', arguments: { issue_key: 'TEST-2' }, status: 'completed', result: {} } })?.target, 'TEST-2');
  assert.equal(extractToolProof({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'atlassian', tool: 'jira_get_issue', status: 'failed', error: 'denied' } })?.succeeded, false);
});

test('argv never bypasses sandbox, never enables unrelated mutations, and resumes exact persisted thread', () => {
  const ctx: Pick<PhaseContext, 'stage' | 'directory' | 'run'> = { stage: 'publish', directory: '/tmp/test', run: { ...emptyRun(), threadId: randomUUID() } };
  const args = phaseArguments(ctx, [{ name: 'atlassian', enabled: true, disabled_tools: ['confluence_update_page'] }, { name: 'other', enabled: true }], '/tmp/schema', '/tmp/result');
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', ctx.run.threadId]);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.equal(args.some((arg) => arg.includes('danger-full-access') || arg.includes('bypass')), false);
  const whitelist = args.find((arg) => arg.startsWith('mcp_servers.atlassian.enabled_tools='))!;
  assert.ok(whitelist.includes('confluence_create_page'));
  assert.equal(whitelist.includes('jira_create_issue'), false);
  assert.equal(whitelist.includes('confluence_update_page'), false);
  assert.ok(args.includes('mcp_servers.other={enabled=false,command="false"}'));
  assert.equal(allowedTools('verify').some((tool) => /create|update|delete|transition/.test(tool)), false);
  assert.match(stagePrompt('publish', ctx.run, '/skills', '/kit'), /先搜索\/读取恢复已创建页面，禁止盲目重发创建/);
  const intakePrompt = stagePrompt('intake', { ...ctx.run, input: { ...ctx.run.input, assignee: '' } }, '/skills', '/kit');
  assert.match(intakePrompt, /当前用户在目标项目已有任务明确指派/);
  assert.match(intakePrompt, /负责人候选接口返回空数组不能单独作为阻塞理由/);
  assert.match(stagePrompt('jira', ctx.run, '/skills', '/kit'), /创建后仍必须回读实际负责人/);
  assert.match(stagePrompt('jira', ctx.run, '/skills', '/kit'), /customfield_10109.*customfield_10110/);
  assert.match(stagePrompt('verify', ctx.run, '/skills', '/kit'), /目标开始日期.*目标结束日期/);
  const researchPrompt = stagePrompt('research', ctx.run, '/skills', '/kit');
  assert.doesNotMatch(researchPrompt, /评审纪要|review-minutes/);
  assert.match(researchPrompt, /待评审.*开发中/);
  assert.match(researchPrompt, /接口字段名和枚举映射尚未确认时.*提议契约/);
  assert.doesNotMatch(researchPrompt, /PRD AC-09/);
  assert.match(researchPrompt, /若实际 PRD 或用户确认要求沿用分页或明细逻辑/);
  assert.match(researchPrompt, /原文没有编号时标注为本文追踪 ID/);
  assert.match(researchPrompt, /用户最新明确的来源纠正优先于旧输入/);
});

test('a new execution requires ordered Jira target dates', () => {
  const base = { input, authorization: 'publish-confluence-and-create-jira' };
  assert.equal(executionStartSchema.safeParse(base).success, true);
  assert.equal(executionStartSchema.safeParse({ ...base, input: { ...input, jiraStartDate: '' } }).success, false);
  assert.equal(executionStartSchema.safeParse({ ...base, input: { ...input, jiraEndDate: '' } }).success, false);
  assert.equal(executionStartSchema.safeParse({ ...base, input: { ...input, jiraStartDate: '2026-09-17' } }).success, false);
});

test('only authorized write stages use automatic approval review', () => {
  const inventory = [{ name: 'atlassian', enabled: true }];
  const run = emptyRun();
  for (const stage of ['intake', 'research', 'design', 'verify'] as const) {
    const args = phaseArguments({ stage, directory: '/tmp/test', run }, inventory, '/tmp/schema', '/tmp/result');
    assert.ok(args.includes('approval_policy="never"'));
    assert.equal(args.includes('approvals_reviewer="auto_review"'), false);
  }
  for (const stage of ['publish', 'jira'] as const) {
    const args = phaseArguments({ stage, directory: '/tmp/test', run }, inventory, '/tmp/schema', '/tmp/result');
    assert.ok(args.includes('approval_policy="on-request"'));
    assert.ok(args.includes('approvals_reviewer="auto_review"'));
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.equal(args.some((arg) => arg.includes('bypass')), false);
  }
});

test('all stages use native tools even when resuming a thread with desktop Code Mode settings', () => {
  for (const threadId of ['', randomUUID()]) {
    for (const { id: stage } of EXECUTION_STAGES) {
      const args = phaseArguments({ stage, directory: '/tmp/test', run: { ...emptyRun(), threadId } }, [{ name: 'atlassian', enabled: true }], '/tmp/schema', '/tmp/result');
      for (const flag of ['code_mode', 'code_mode_only', 'code_mode_host']) assert.ok(args.includes(`features.${flag}=false`));
      assert.ok(args.includes('sandbox_mode="read-only"'));
      assert.equal(args.includes('resume'), !!threadId);
    }
  }
});

test('design prompt names both main skills and every server-required section without expanding code permissions', () => {
  const run = emptyRun();
  const prompt = stagePrompt('design', run, '/skills', '/kit');
  assert.match(prompt, /apex-frontend-tech-design-delivery\/SKILL.md/);
  assert.match(prompt, /apex-jira-feature-development\/SKILL.md/);
  assert.match(prompt, /不执行其中的建目录、clone\/fetch、切分支或产品实现步骤/);
  assert.match(prompt, /“与现有实现差异”不能替代“与 PRD 差异”/);
  const result = output('design');
  assert.deepEqual(validateStage('design', result.result, result.proof, run), []);
  for (const heading of ['元信息', '方案摘要', '需求映射', '影响范围', '详细设计', '与 PRD 差异', '风险', '测试关注点', '任务拆分', '回滚', '覆盖度矩阵', 'G2a']) {
    assert.ok(prompt.includes(heading));
    const missing = { ...result.result, markdown: result.result.markdown.replace(heading, '') };
    assert.ok(validateStage('design', missing, result.proof, run).includes(`方案未覆盖模板章节：${heading}`));
  }
});

test('CLI failures explain configuration errors without exposing raw diagnostic secrets or guessing login failure', () => {
  const secret = 'private-token-for-test';
  const diagnostic = `Error loading config.toml: invalid transport\nin \`mcp_servers.computer-history\`\nAuthorization: Bearer ${secret}`;
  assert.match(codexFailureMessage(1, diagnostic), /MCP computer-history.*transport/);
  for (const raw of [diagnostic, `Error loading config.toml: ${secret}`, `unexpected argument '--unknown-flag' found ${secret}`, `invalid_json_schema ${secret}`, secret]) {
    const message = codexFailureMessage(1, raw);
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes('登录'), false);
  }
  assert.match(codexFailureMessage(2, "unexpected argument '--unknown-flag' found"), /不支持启动参数 --unknown-flag/);
  assert.match(codexFailureMessage(null, ''), /退出码 未知.*未返回诊断/);
  const hostFailure = codexFailureMessage(1, `failed to spawn code-mode host /private/${secret}/codex-code-mode-host: No such file or directory`);
  assert.match(hostFailure, /Code Mode 辅助程序不可用.*不是 Skill 缺失/);
  assert.equal(hostFailure.includes(secret), false);
});

test('real CLI parses native-tool overrides with an unavailable Code Mode host without starting a model', async (t) => {
  try { await fs.access(cliBinary); } catch { t.skip('Local Codex CLI is not installed'); return; }
  const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-test-'));
  try {
    const args = phaseArguments({ stage: 'design', directory: '/tmp/test', run: { ...emptyRun(), threadId: randomUUID() } }, [{ name: 'atlassian', enabled: true }], '/tmp/schema', '/tmp/result');
    const overrides = args.flatMap((value, index) => args[index - 1] === '-c' ? ['-c', value] : []);
    const result = await promisify(execFile)(cliBinary, ['features', 'list', '-c', 'mcp_servers.atlassian={command="false"}', '-c', 'features.code_mode=true', '-c', 'features.code_mode_only=true', '-c', 'features.code_mode_host=true', ...overrides],
      { timeout: 10_000, env: { ...process.env, CODEX_HOME: isolatedHome } });
    for (const name of ['code_mode', 'code_mode_only', 'code_mode_host']) assert.match(result.stdout, new RegExp(`^${name}\\s+.+\\s+false$`, 'm'));
  } finally { await fs.rm(isolatedHome, { recursive: true, force: true }); }
});

test('busy original session waits before a turn starts, supports stop, and never retries a started turn', async (t) => {
  for (const mode of ['wait', 'abort', 'started', 'timeout'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-wait-'));
    const binary = path.join(root, 'fake-codex');
    const countFile = path.join(root, 'attempt-count');
    const threadId = randomUUID();
    const controller = new AbortController();
    const events: string[] = [], threads: string[] = [];
    try {
      if (mode === 'timeout') t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-test'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[{"name":"atlassian","enabled":true}]'); process.exit(0); }
const countFile = ${JSON.stringify(countFile)};
const attempt = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(attempt));
if (${JSON.stringify(mode)} !== 'wait' || attempt === 1) {
  if (${JSON.stringify(mode)} === 'started') console.log(JSON.stringify({ type: 'turn.started' }));
  console.error('Error: thread already has an active turn'); process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }));
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(output('design').result))});
`, { mode: 0o700 });
      const run = { ...emptyRun(), threadId, steps: [{ id: 'design' as const, status: 'running' as const, attempts: 1, summary: '', proof: [] }] };
      const executor = createCodexExecutor({ binary, timeoutMs: 5000, sessionRetryMs: 1, sessionWaitMs: mode === 'timeout' ? 1 : 2000 });
      const execute = executor.execute({ stage: 'design', run, directory: root, signal: controller.signal,
        onThread: async id => { threads.push(id); },
        onEvent: message => {
          events.push(message);
          if (message.includes('短暂等待释放')) {
            if (mode === 'abort') controller.abort();
            // Advance only the deadline clock; child processes and retry delays keep their real timers.
            if (mode === 'timeout') t.mock.timers.tick(2);
          }
        },
      });
      if (mode === 'wait') {
        const result = await execute;
        assert.equal(result.result.outcome, 'passed');
        assert.deepEqual(threads, [threadId]);
        assert.equal(await fs.readFile(countFile, 'utf8'), '2');
        assert.equal(events.filter(e => e.includes('短暂等待释放')).length, 1);
        assert.equal(result.proof.length, 1);
      } else {
        await assert.rejects(execute, mode === 'abort' ? /运行已停止/ : mode === 'timeout' ? /写锁持续.*仅结束回复不一定释放写锁/ : /不能并发续跑/);
        assert.equal(await fs.readFile(countFile, 'utf8'), '1');
        assert.equal(threads.length, 0);
      }
    } finally {
      controller.abort();
      if (mode === 'timeout') t.mock.timers.reset();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('plugin-only MCP entries can be disabled without creating an invalid transport in real CLI config', async (t) => {
  try { await fs.access(cliBinary); } catch { t.skip('Local Codex CLI is not installed'); return; }
  const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-test-'));
  try {
    const ctx = { stage: 'intake' as const, directory: os.tmpdir(), run: emptyRun() };
    const plugin = `test-plugin-${randomUUID()}`;
    const args = phaseArguments(ctx, [{ name: 'atlassian', enabled: true }, { name: plugin, enabled: true }], '/tmp/schema', '/tmp/result');
    const overrides = args.flatMap((value, index) => args[index - 1] === '-c' ? ['-c', value] : []);
    // Only parses isolated configuration; no MCP process or model is started.
    const result = await promisify(execFile)(cliBinary, ['mcp', 'list', '--json', '-c', 'mcp_servers.atlassian={command="false"}', ...overrides],
      { timeout: 10_000, env: { ...process.env, CODEX_HOME: isolatedHome } });
    const servers = JSON.parse(result.stdout) as { name: string; enabled: boolean }[];
    assert.equal(servers.find((server) => server.name === plugin)?.enabled, false);
    assert.equal(servers.find((server) => server.name === 'atlassian')?.enabled, true);
  } finally { await fs.rm(isolatedHome, { recursive: true, force: true }); }
});

test('publication and Jira identities cannot drift outside the authorized directory, site or frozen project', () => {
  const run = { ...emptyRun(), artifacts: { ...artifacts } };
  const directory = output('intake'); directory.result.artifacts.parentPageId = '999';
  assert.ok(validateStage('intake', directory.result, directory.proof, run).some((gap) => gap.includes('用户指定目录')));
  const site = output('publish'); site.result.artifacts.documentUrl = 'https://another.test/doc';
  assert.ok(validateStage('publish', site.result, site.proof, run).some((gap) => gap.includes('有效')));
  const changed = output('verify'); changed.result.artifacts.documentId = '999'; changed.result.artifacts.implementationTaskKey = 'OTHER-4';
  const gaps = validateStage('verify', changed.result, changed.proof, run);
  assert.ok(gaps.some((gap) => gap.includes('documentId')));
  assert.ok(gaps.some((gap) => gap.includes('implementationTaskKey')));
  assert.ok(gaps.some((gap) => gap.includes('Jira 项目')));
});

test('concurrent confirmations create one job and consume one six-stage execution only', async () => {
  let calls = 0;
  const f = await fixture({ health: async () => health, execute: async (ctx) => { calls++; return output(ctx.stage); } });
  try {
    const results = await Promise.allSettled([f.service.start(request(f.workspace)), f.service.start(request(f.workspace))]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    await f.service.idle();
    assert.equal(calls, 6);
    assert.equal((await f.service.dashboard()).runs.length, 1);
  } finally { await f.service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('interrupted persisted execution blocks on restart without running the executor again', async () => {
  let calls = 0;
  const executor: PhaseExecutor = { health: async () => health, execute: async (ctx) => { calls++; return output(ctx.stage); } };
  const f = await fixture(executor);
  let service = f.service;
  try {
    await service.start(request(f.workspace)); await service.idle();
    const run = (await service.dashboard()).runs[0];
    await service.close();
    run.status = 'running'; run.steps[3].status = 'running';
    await fs.writeFile(path.join(f.root, 'executor/executions.json'), JSON.stringify({ version: 1, runs: [run] }));
    service = await createDesignExecutor(path.join(f.root, 'executor'), executor);
    await service.idle();
    const recovered = (await service.dashboard()).runs[0];
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.steps[3].status, 'blocked');
    assert.match(recovered.error, /外部操作可能已完成/);
    assert.equal(calls, 6);
  } finally { await service.close(); await fs.rm(f.root, { recursive: true }); await fs.rm(f.workspace, { recursive: true }); }
});

test('automatic board state comes only from server stages, never from manual review or browser drafts', () => {
  const run = emptyRun(); run.status = 'blocked'; run.error = '权限不足';
  run.steps = EXECUTION_STAGES.map((step) => ({ id: step.id, status: step.id === 'intake' ? 'passed' : 'pending', attempts: 1, summary: '', proof: [] }));
  const local = { input: { ...input, title: '未授权的新草稿标题' }, review: { ...emptyReview(), checkedAt: 'today', reviewer: '人工', sourceRevision: 'local' }, blockedReason: '', updatedAt: 'today' };
  const [card] = buildDesignCards(undefined, [local], [run]);
  assert.equal(card.input.title, input.title);
  assert.equal(cardLane(card), 'blocked');
  assert.equal(stageChecks(card).filter((step) => step.done).length, 1);
  run.status = 'completed'; run.steps.forEach((step) => { step.status = 'passed'; });
  assert.equal(cardLane(card), 'completed');
  assert.equal(stageChecks(card).filter((step) => step.done).length, 6);
});

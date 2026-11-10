/** V5 的真实运行接线；模型运行仍经过统一 runtime 的权限、全局并发与持久化入口。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { createAgentRuntimeService } from './agent-runtime.js';
import type { createAgentTeamService } from './agent-team-service.js';
import { createAgentEvalService, type AgentEvaluationResult, type AgentEvaluationRunContext, type AgentEvaluationSample } from './agent-eval.js';
import { createAgentDeliveryDraftService, type AgentDeliveryDraftSections, type AgentDeliveryDraftSource } from './agent-delivery-draft.js';
import { evaluateUsageGate, type createAgentUsageStore } from './agent-usage.js';
import { emptyAgentUsage, agentQuotaState, type AgentUsage } from '../shared/agent-usage.js';
import { teamProfile, teamRoleMetadata, teamModelChoiceSchema, teamProfileIds, type TeamProfileId, type TeamModelChoice, type TeamProfileConfig } from '../shared/agent-team.js';
import { readTeamRolePrompt, validateTeamModelChoice } from './agent-profiles.js';
import { evaluateImplementation, evaluateVerification, evaluateReview, readAgentTaskReport } from '../shared/agent-task-result.js';
import { readDeliveryReport } from '../shared/delivery-report.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentAccessMode, AgentRun, AgentProvider, AgentUsageLimits, AgentReasoningEffort } from '../shared/agent-runtime.js';
import { localWorkflowWorkspace } from './agent-workflow.js';
import { processIsAlive } from './agent-recovery.js';

const exec = promisify(execFile);
type Runtime = Pick<Awaited<ReturnType<typeof createAgentRuntimeService>>, 'startTeamNode' | 'getRun' | 'teamRuns' | 'subscribe' | 'health' | 'stop'>;
type Team = Pick<Awaited<ReturnType<typeof createAgentTeamService>>, 'getTask' | 'ledger'> & {
  draftSource: (id: string) => Promise<AgentDeliveryDraftSource | undefined>;
  evaluationSample: (id: string, profileId: TeamProfileId) => Promise<AgentEvaluationSample>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliases: Record<string, { id: string; label: string }> = {
  'claude-sonnet-5-5': { id: 'sonnet', label: 'Sonnet 5.5' }, 'claude-opus-5-5': { id: 'opus', label: 'Opus 5.5' },
  'claude-haiku-5-5': { id: 'haiku', label: 'Haiku 5.5' }, 'claude-fable-5-1': { id: 'fable', label: 'Fable 5.1' },
};
const draftSchema = z.object({ reason: z.string().max(6000), changes: z.array(z.string().max(6000)).max(50),
  unverified: z.array(z.string().max(6000)).max(30), risks: z.array(z.string().max(6000)).max(30) }).strict();

/** 不经过 shell 执行已确认样本中的固定检查，避免把管道/替换或发布命令交给宿主执行。 */
export function evaluationCheckArguments(command: string): { binary: string; args: string[] } {
  if (!command.trim() || /[;&|<>`\n\r]|\$\(/.test(command)) throw new Error('评测检查须为单条测试/构建命令，不能包含 shell 操作');
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (parts.join(' ') !== command.trim().replace(/\s+/g, ' ')) throw new Error('评测检查命令的引号格式无效');
  const argv = parts.map(part => part.replace(/^(['"])(.*)\1$/, '$2'));
  const [binary, ...args] = argv;
  if (args.some(arg => path.isAbsolute(arg) || /(?:^|[=\\/])\.\.(?:[\\/]|$)/.test(arg) || /=\//.test(arg))) throw new Error('评测检查不能引用副本外的绝对或上级路径');
  if (args.some(arg => /^(?:--fix|--write|--updateSnapshot|-u)$/.test(arg))) throw new Error('评测验证不能使用自动修复或更新快照参数');
  let allowed = false;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(binary)) {
    const script = args[0] === 'run' ? args[1] : args[0];
    allowed = /^(?:test|check|build|lint|typecheck)(?:[:.-][\w:.-]+)?$/.test(script || '')
      && !args.some(arg => /^(?:--prefix|--dir|-C|--cwd|--filter)$/.test(arg));
  } else if (binary === 'git') allowed = args[0] === 'diff' && args.includes('--check') && !args.some(arg => arg.startsWith('--output') || arg.startsWith('--ext-diff'));
  else if (binary === 'node') allowed = args.includes('--test');
  else if (['pytest', 'phpunit', 'tsc', 'vue-tsc'].includes(binary)) allowed = true;
  else if (['python', 'python3'].includes(binary)) allowed = args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]);
  else if (binary === 'go' || binary === 'cargo') allowed = args[0] === 'test' || args[0] === 'check';
  else if (binary === 'npx') allowed = ['tsc', 'vue-tsc', 'vitest', 'jest', 'eslint'].includes(args[0]);
  if (!allowed) throw new Error(`评测检查命令不属于支持的测试/构建命令：${binary}`);
  return { binary, args };
}

function combinedUsage(runs: AgentRun[]): AgentUsage {
  const result = emptyAgentUsage(runs[0]?.provider || 'codex');
  result.source = 'evaluation.runs';
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'costUsd'] as const;
  for (const field of fields) result[field] = runs.length && runs.every(run => run.usage?.[field] !== null && run.usage?.[field] !== undefined)
    ? runs.reduce((sum, run) => sum + run.usage![field]!, 0) : null;
  result.costSource = result.costUsd !== null && runs.some(run => run.usage?.costSource === 'claude_code_self_reported') ? 'claude_code_self_reported' : null;
  result.models = runs.flatMap(run => run.usage?.models || []);
  if (!result.models.length) result.models = null;
  return result;
}

export async function createAgentTeamGovernance(directory: string, runtime: Runtime, team: Team, options: {
  usageStore: Awaited<ReturnType<typeof createAgentUsageStore>>;
  writeJson?: (relative: string, value: unknown) => Promise<void>;
  readProviderUsage?: Partial<Record<AgentProvider, () => Promise<AgentUsageLimits>>>;
  timeoutMs?: number;
}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  const artifactRoot = path.join(directory, 'evaluation-artifacts'), verificationRoot = path.join(directory, 'evaluation-verification');
  const active = new Set<string>();
  let closed = false;
  async function available(raw: TeamModelChoice, config: TeamProfileConfig, workflowId: string, accessMode: AgentAccessMode, avoidModel?: string, templateId?: string) {
    let choice = structuredClone(raw), fallback = '';
    const usage = await options.readProviderUsage?.[choice.provider]?.().catch(() => undefined);
    let health = await runtime.health(choice.provider);
    if (choice.provider === 'claude' && (!health.ready || agentQuotaState(usage).state === 'exhausted')) {
      fallback = !health.ready ? `Claude 未就绪：${health.message}，本次改由 Codex 继续` : 'Claude 额度已用尽，本次改由 Codex 继续';
      const preferred = /opus|fable/.test(choice.model) ? 'gpt-6-astra' : 'gpt-6.1-sol';
      choice = { provider: 'codex', model: preferred === avoidModel ? preferred === 'gpt-6-astra' ? 'gpt-6.1-sol' : 'gpt-6-astra' : preferred, reasoningEffort: 'high' };
      health = await runtime.health('codex');
    }
    if (choice.provider === 'claude') choice.catalogAlias ||= aliases[choice.model];
    validateTeamModelChoice(choice, health, 'agent', accessMode);
    const limits = choice.provider === raw.provider ? usage : await options.readProviderUsage?.[choice.provider]?.().catch(() => undefined);
    const gate = evaluateUsageGate({ provider: choice.provider, usageLimits: limits });
    if (!gate.allowed) throw new Error(gate.reason);
    return { choice, fallback, usageState: gate.state };
  }
  function waitRun(id: string): Promise<AgentRun> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inspect = () => {
        const run = runtime.getRun(id);
        if (!run || ['queued', 'running'].includes(run.status) || (run.status === 'completed' && !run.resultReady)) return;
        clearTimeout(timer); unsubscribe(); active.delete(id);
        if (run.status !== 'completed') reject(new Error(run.error || `评测运行${run.status}`)); else resolve(run);
      };
      const unsubscribe = runtime.subscribe(() => inspect());
      if (options.timeoutMs !== undefined) timer = setTimeout(() => { unsubscribe(); active.delete(id); void runtime.stop(id).catch(() => undefined); reject(new Error('评测运行超过时限，已请求停止')); }, options.timeoutMs);
      inspect();
    });
  }
  async function runNode(input: {
    taskId: string; stageKey: string; profileId: TeamProfileId; config: TeamProfileConfig; choice: TeamModelChoice;
    workspacePath: string; context: string; objective: string; parentConversationId: string; accessMode?: AgentAccessMode; artifactDirectories?: string[]; avoidModel?: string; templateId?: string;
  }) {
    if (closed) throw new Error('治理服务已关闭');
    const accessMode = input.accessMode ?? 'full';
    const effective = await available(input.choice, input.config, input.taskId, accessMode, input.avoidModel, input.templateId);
    if (closed) throw new Error('治理服务已关闭');
    const billingTaskId = input.taskId.replace(/^(?:draft|opinion):/, '');
    const budgetLimit = null;
    const intent = await team.ledger.reserveDispatch({ workflowId: billingTaskId, stageKey: input.stageKey, attempt: 1, limit: budgetLimit });
    if (intent.reconciliation === 'needs_reconciliation') throw new Error('此前派发状态未知，需要核对后继续');
    await team.ledger.markStarted(intent.id);
    const run = await runtime.startTeamNode({ provider: effective.choice.provider, model: effective.choice.model,
      reasoningEffort: effective.choice.reasoningEffort as AgentReasoningEffort | '', mode: 'agent', accessMode, objective: input.objective, workspacePath: input.workspacePath },
    { parentConversationId: input.parentConversationId, title: input.objective, role: teamRoleMetadata[input.profileId].taskRole,
      team: { taskId: input.taskId, nodeId: input.stageKey, stageKey: input.stageKey, profileId: input.profileId,
        profileRevision: input.config.revision, artifactDirectories: input.artifactDirectories },
      context: [await readTeamRolePrompt(input.profileId), effective.fallback, `额度状态：${effective.usageState}`,
        '本次为隔离评测/草稿工作，不改变业务任务、岗位默认配置或人工验收。不得提交、推送、部署、修改外部系统或启动子 Agent。', input.context].filter(Boolean).join('\n\n'),
      modelAlias: effective.choice.catalogAlias });
    await team.ledger.linkIntent(intent.id, run.id);
    active.add(run.id);
    if (closed) void runtime.stop(run.id).catch(() => undefined);
    try { return await waitRun(run.id); }
    finally { const current = runtime.getRun(run.id); if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) await team.ledger.settleIntent(intent.id); }
  }
  async function runSample(context: AgentEvaluationRunContext): Promise<AgentEvaluationResult> {
    const original = team.getTask(context.sample.workflowId), config = context.sample.profileConfig || original.profileConfig;
    const profileId = (context.sample.profileId || 'engineer') as TeamProfileId;
    if (!teamProfileIds.includes(profileId)) throw new Error('评测岗位无效');
    const profile = teamProfile(config, profileId), taskId = `eval:${context.evaluationId}`, prefix = `${taskId}:${context.variantId}:attempt-${context.attempt}`;
    const material = path.join(artifactRoot, context.evaluationId, context.variantId, `attempt-${context.attempt}`); await fs.mkdir(material, { recursive: true, mode: 0o700 });
    const runs: AgentRun[] = [], evidence: string[] = [];
    const choice = teamModelChoiceSchema.parse({ ...context.model, reasoningEffort: context.model.reasoningEffort ?? (context.model.provider === 'cursor' ? '' : profile.reasoningEffort) });
    const acceptance = context.sample.acceptanceCriteria.map(item => ({ id: item.id, status: 'not_run' as 'passed' | 'failed' | 'not_run', evidence: '未执行' }));
    const result: AgentEvaluationResult = { passed: false, acceptance, reworkRounds: 0, verificationCommands: context.sample.verificationCommands,
      verificationPassed: false, reviewApproved: false, findings: [], evidence };
    const finishResult = () => {
      result.usage = combinedUsage(runs);
      result.executions = runs.map(run => ({ runId: run.id, profileId: run.team?.profileId || '', provider: run.provider, requestedModel: run.model }));
      const author = runs.find(run => run.team?.profileId === profileId);
      if (author && (author.provider !== context.model.provider || author.model !== context.model.model)) {
        result.comparisonWarnings = ['目标模型不可用而使用备用执行器，本变体不用于目标模型的通过率比较'];
      }
      const review = runs.find(run => run.team?.profileId === 'reviewer');
      if (!reviewOnly && review && author && review.provider === author.provider) result.comparisonWarnings = [...(result.comparisonWarnings || []), '审查使用同家族备用模型，本次结果不用于默认模型建议'];
      return result;
    };
    const baseContext = `目标：${context.sample.objective}\n验收标准：${JSON.stringify(context.sample.acceptanceCriteria)}\n允许路径：${JSON.stringify(context.sample.allowedPaths)}\n固定岗位指令：${context.sample.rolePrompt}`;
    const reviewOnly = profileId === 'reviewer';
    if (!reviewOnly) {
      const implementation = await runNode({ taskId, stageKey: `${prefix}:implement`, profileId, config, choice, workspacePath: context.workspacePath,
        templateId: original.plan?.templateId, accessMode: original.accessMode,
        parentConversationId: original.parentConversationId, objective: '模型评测：隔离实现',
        context: `${baseContext}\n最终输出 delivery-report：${JSON.stringify({ version: 1, taskResult: { role: 'implementer', status: 'succeeded | failed | blocked', summary: '', acceptance, selfTests: [], blockers: [] } })}` });
      runs.push(implementation);
      const outcome = evaluateImplementation(implementation.result, implementation.changedFiles || [], !!implementation.changedFiles?.length, context.sample.allowedPaths);
      await fs.writeFile(path.join(material, 'implementation.json'), JSON.stringify({ report: readAgentTaskReport(implementation.result), changedFiles: implementation.changedFiles }, null, 2));
      evidence.push(path.join(material, 'implementation.json'));
      if (outcome.outcome !== 'passed') return finishResult();
    }
    const candidate = await localWorkflowWorkspace.version(context.workspacePath, []);
    if (reviewOnly) {
      const manifest = path.join(material, 'candidate-manifest.json');
      await fs.writeFile(manifest, JSON.stringify({ candidate, patchHash: context.sample.candidatePatchHash }, null, 2));
      evidence.push(manifest);
    }
    let verificationPassed = reviewOnly;
    if (!reviewOnly) {
      await fs.mkdir(verificationRoot, { recursive: true, mode: 0o700 });
      const copy = path.join(verificationRoot, randomUUID());
      try {
        await localWorkflowWorkspace.createCopy(context.workspacePath, copy, []);
        const copied = await localWorkflowWorkspace.version(copy, []);
        if (candidate.value !== copied.value || candidate.kind !== copied.kind) throw new Error('评测验证副本版本不符');
        const commands: { command: string; exitCode: number | null; log: string }[] = [];
        const checkEnvironment = { ...process.env };
        // 嵌入测试运行器时，继承此标记会令子进程 node --test 跳过全部用例却返回 0。
        delete checkEnvironment.NODE_TEST_CONTEXT;
        for (const [index, command] of context.sample.verificationCommands.entries()) {
          const { binary, args } = evaluationCheckArguments(command);
          let exitCode: number | null = 0, output = '';
          try { const checked = await exec(binary, args, { cwd: copy, env: checkEnvironment, timeout: 10 * 60 * 1000, maxBuffer: 5_000_000 }); output = checked.stdout + checked.stderr; }
          catch (error) { const failure = error as { code?: string | number; stdout?: string; stderr?: string; message?: string }; exitCode = typeof failure.code === 'number' ? failure.code : null; output = (failure.stdout || '') + (failure.stderr || '') + (failure.message || ''); }
          const log = path.join(material, `check-${index + 1}.log`); await fs.writeFile(log, `${command}\nexitCode=${exitCode}\n${output}`);
          commands.push({ command, exitCode, log }); evidence.push(log);
        }
        const verifier = teamProfile(config, 'verifier');
        const verified = await runNode({ taskId, stageKey: `${prefix}:verify`, profileId: 'verifier', config, choice: verifier, workspacePath: copy,
          templateId: original.plan?.templateId, accessMode: original.accessMode,
          parentConversationId: original.parentConversationId, objective: '模型评测：固定检查与验收验证', artifactDirectories: [material],
          context: `${baseContext}\n宿主已在本副本实际执行相同固定检查，原始日志：${JSON.stringify(commands)}。自己读取日志与相关代码逐项核对验收，不修改源码或测试。明确stage=review的验收项记录not_run并交给后续审查，不将等待正式复审视为验证阻塞。\n最终输出 delivery-report：${JSON.stringify({ version: 1, validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded | failed | blocked', acceptance, selfTests: commands.map(item => ({ command: item.command, exitCode: item.exitCode })), blockers: [] } })}` });
        runs.push(verified);
        const report = readAgentTaskReport(verified.result);
        await fs.writeFile(path.join(material, 'verification.json'), JSON.stringify({ validationEvidence: report.validationEvidence, acceptance: report.taskResult.acceptance, commands, snapshot: candidate }, null, 2));
        evidence.push(path.join(material, 'verification.json'));
        result.acceptance = context.sample.acceptanceCriteria.map(item => { const checked = report.taskResult.acceptance.find(checked => checked.id === item.id); return {
          id: item.id, status: checked?.status === 'passed' ? 'passed' : checked?.status === 'failed' ? 'failed' : 'not_run', evidence: checked?.evidence || '未验证' }; });
        const afterChecks = await localWorkflowWorkspace.version(copy, []);
        const changedSource = afterChecks.kind === 'git-tree' && candidate.kind === 'git-tree'
          ? (await exec('git', ['-C', copy, 'diff', '--name-only', '-z', candidate.value, afterChecks.value, '--', '.', ':(exclude).delivery-artifacts', ':(exclude).delivery-artifacts/**'], { timeout: 10_000 })).stdout
          : afterChecks.kind === candidate.kind && afterChecks.value === candidate.value ? '' : 'changed';
        const unchanged = !changedSource;
        if (!unchanged) {
          const log = path.join(material, 'verification-source-changed.log');
          await fs.writeFile(log, `验证检查改变了副本源码/测试，不能以修改后的副本证明原候选通过。\nbefore=${candidate.value}\nafter=${afterChecks.value}\n`); evidence.push(log);
        }
        verificationPassed = unchanged && commands.every(command => command.exitCode === 0) && evaluateVerification(verified.result, context.sample.acceptanceCriteria).outcome === 'passed';
        await localWorkflowWorkspace.collectArtifacts(copy, path.join(material, 'verifier-artifacts'));
      } finally { await localWorkflowWorkspace.removeCopy(copy, context.workspacePath); }
    }
    result.verificationPassed = verificationPassed;
    if (!verificationPassed) return finishResult();
    const diff = await localWorkflowWorkspace.diff(context.workspacePath, context.sample.baseHead);
    await fs.writeFile(path.join(material, 'candidate.diff'), diff);
    let reviewerChoice = choice;
    if (!reviewOnly) {
      const authorProvider = runs[0].provider;
      if (!Object.hasOwn(config.reviewRouting, authorProvider)) throw new Error('该执行器尚未配置代码执行评测的审查路由');
      reviewerChoice = config.reviewRouting[authorProvider as keyof typeof config.reviewRouting];
    }
    const review = await runNode({ taskId, stageKey: `${prefix}:review`, profileId: 'reviewer', config, choice: reviewerChoice, workspacePath: context.workspacePath,
      templateId: original.plan?.templateId, accessMode: original.accessMode,
      parentConversationId: original.parentConversationId, objective: '模型评测：盲审固定候选', artifactDirectories: [material], avoidModel: reviewOnly ? undefined : runs[0].model,
      context: `${JSON.stringify(context.blindReviewMaterials)}\n盲审材料目录：${material}。读取 candidate.diff、verification.json（如存在）与当前工作区的相关代码；不读取 implementation.json，不猜测作者的执行器或模型。可按授权运行必要核验并保存检查产物，根据代码与实际证据给出 findings；候选源码或测试发生变化时不能沿用原候选的通过结论，必须明确报告并重新验证。另须逐项完成stage=review的验收要求并返回acceptance，每项passed须有独立核验的证据，不能只填approved。审查阶段验收：${JSON.stringify(context.sample.acceptanceCriteria.filter(item => item.stage === 'review'))}。\n最终输出 delivery-report：${JSON.stringify({ version: 1, taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved | changes_requested | blocked', summary: '', findings: [], blockers: [] } })}` });
    runs.push(review);
    const reviewedCandidate = await localWorkflowWorkspace.version(context.workspacePath, []);
    if (reviewedCandidate.kind !== candidate.kind || reviewedCandidate.value !== candidate.value) throw new Error('审查期间评测候选版本发生变化');
    const report = readAgentTaskReport(review.result);
    result.reviewApproved = evaluateReview(review.result, context.sample.acceptanceCriteria).outcome === 'passed';
    const reviewIds = new Set(context.sample.acceptanceCriteria.filter(item => item.stage === 'review').map(item => item.id));
    result.acceptance = result.acceptance.map(item => {
      if (!reviewIds.has(item.id)) return item;
      const checked = report.taskResult.acceptance.find(check => check.id === item.id);
      return { id: item.id, status: checked?.status === 'passed' && result.reviewApproved ? 'passed' : checked?.status === 'failed' ? 'failed' : 'not_run',
        evidence: checked?.evidence || '审查未验证' };
    });
    result.findings = report.taskResult.findings.map(finding => ({ id: finding.id, problem: finding.problem, file: finding.file, line: finding.line ?? undefined,
      ...(context.sample.knownFindingIds?.includes(finding.id) ? { knownFindingId: finding.id } : {}) }));
    await fs.writeFile(path.join(material, 'review.json'), JSON.stringify({ taskResult: report.taskResult, snapshot: candidate }, null, 2));
    evidence.push(path.join(material, 'review.json'));
    result.passed = result.verificationPassed && result.reviewApproved && result.acceptance.every(item => item.status === 'passed');
    return finishResult();
  }
  const evaluations = await createAgentEvalService(directory, { runSample, writeJson: options.writeJson,
    reconcileVariant: async (variant, evaluation) => {
      const prefix = `eval:${evaluation.id}:${variant.id}:`;
      const runs = runtime.teamRuns(`eval:${evaluation.id}`).filter(run => run.team?.stageKey.startsWith(prefix));
      const intents = team.ledger.snapshot().intents.filter(intent => intent.workflowId === `eval:${evaluation.id}` && intent.stageKey.startsWith(prefix));
      if (runs.some(run => ['running', 'queued'].includes(run.status) || processIsAlive(run.pid) || processIsAlive(run.recovery?.previousPid || null))) return 'active';
      if (runs.some(run => run.status === 'interrupted' && !(run.recovery?.state === 'needs-review' && run.recovery.previousPid && !processIsAlive(run.recovery.previousPid)))) return 'unknown';
      if (intents.some(intent => !intent.settled && intent.state !== 'abandoned' && !runs.some(run => run.team?.stageKey === intent.stageKey))) return 'unknown';
      return 'safe';
    } });
  const drafts = await createAgentDeliveryDraftService(directory, { currentSource: async id => {
    const ready = await team.draftSource(id);
    if (ready) return ready;
    // 疑难任务也能请求第二意见；此材料故意没有人工验收，requireReady 会阻止它用于交付整理。
    const task = team.getTask(id), implementation = task.nodes.filter(node => node.stage === 'implement').at(-1);
    const workspace = task.workspacePath || task.sourceWorkspacePath;
    const candidate = await localWorkflowWorkspace.version(workspace, task.nodes.flatMap(node => (node.changedFiles || []).map(file => file.path)));
    const verification = task.nodes.filter(node => node.stage === 'verify').at(-1);
    return { taskId: task.id, objective: task.objective, candidate,
      implementation: { runId: implementation?.runId || task.id, summary: `${task.state}: ${task.reason || ''}\n${implementation?.result || ''}`, files: task.nodes.flatMap(node => (node.changedFiles || []).map(file => file.path)) },
      verification: { runId: verification?.runId || '', candidate, passed: false, evidence: emptyDeliveryEvidence(), refs: [] }, reviews: [],
      currentSource: { runId: implementation?.runId || task.id, updatedAt: task.updatedAt } };
  }, writeJson: options.writeJson,
    generate: async (input, context) => {
      const task = team.getTask(input.taskId), config = task.profileConfig;
      const run = await runNode({ taskId: `draft:${task.id}`, stageKey: `draft:${task.id}:${digest(input)}:${context.requestId}`, profileId: 'reporter', config,
        choice: teamProfile(config, 'reporter'), workspacePath: task.workspacePath || task.sourceWorkspacePath, accessMode: task.accessMode,
        parentConversationId: task.parentConversationId, objective: '整理当前已验收版本的交付草稿',
        context: `只使用下面已验收的当前版本证据，不读取旧会话、不生成新的验证结论。\n${JSON.stringify(input)}\n本次输出格式以这里为准：delivery-report 的 deliveryDraft 必须是 ${JSON.stringify({ reason: '', changes: [], unverified: [], risks: [] })}。验证段由宿主根据证据生成，不要在 changes 中新增未经证据支持的验证结论。` });
      return draftSchema.parse((readDeliveryReport(run.result) as Record<string, unknown>).deliveryDraft) as AgentDeliveryDraftSections;
    } });
  async function createEvaluation(input: { taskIds: string[]; profileId: TeamProfileId; models: [TeamModelChoice, TeamModelChoice]; confirmed: true; requestId: string }) {
    if (input.confirmed !== true || !input.taskIds.length || input.taskIds.length > 10 || !['engineer', 'frontend', 'batch', 'reviewer'].includes(input.profileId)) throw new Error('选择1至10个已验收任务并确认实现或审查评测岗位');
    const samples = [];
    for (const id of input.taskIds) {
      const sample = await team.evaluationSample(id, input.profileId);
      if (input.profileId !== 'reviewer' && !sample.verificationCommands.length) throw new Error('实现类评测样本缺少固定检查命令，请先取得验证报告中的命令');
      sample.verificationCommands.forEach(evaluationCheckArguments);
      samples.push({ ...sample, profileId: input.profileId, profileConfig: structuredClone(team.getTask(id).profileConfig) });
    }
    const record = await evaluations.create({ requestId: input.requestId, confirmed: true, models: input.models, samples });
    if (record.status === 'confirmed') void evaluations.run(record.id).catch(() => undefined); return record;
  }
  async function secondOpinion(id: string, requestId: string = randomUUID()) {
    const task = team.getTask(id);
    return drafts.secondOpinion(id, async input => {
      const run = await runNode({ taskId: `opinion:${id}`, stageKey: `opinion:${id}:${requestId}`, profileId: 'second_opinion', config: task.profileConfig,
        choice: teamProfile(task.profileConfig, 'second_opinion'), workspacePath: task.workspacePath || task.sourceWorkspacePath, accessMode: task.accessMode,
        parentConversationId: task.parentConversationId, objective: '当前任务的第二意见',
        context: `以下为当前版本材料。按授权运行必要核验并保存产物，独立核对疑难点，提出有证据的第二意见，不自行改变流程或人工验收；候选版本发生变化须明确报告并重新验证。\n${JSON.stringify(input)}\n输出 delivery-report，secondOpinion 为 {text: "意见与证据"}。` });
      const report = readDeliveryReport(run.result) as Record<string, unknown>;
      return z.object({ text: z.string().trim().min(1).max(50_000) }).parse(report.secondOpinion).text;
    }, requestId);
  }
  return { evaluations, drafts, createEvaluation, secondOpinion, close: async () => {
    closed = true; await Promise.allSettled([...active].map(id => runtime.stop(id))); await evaluations.close(); await drafts.close();
  } };
}

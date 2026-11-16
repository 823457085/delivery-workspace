import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { analyzeRepoBlastRadius, formatBlastRadiusForPrompt } from '../server/repo-blast-radius.js';
import { formatWorktreeRadarForPrompt, scanWorktreeConflicts } from '../server/worktree-conflict-radar.js';
import { executeProjectGitAction } from '../server/project-git.js';
import { buildWorkflowContext, writeReviewMaterials } from '../server/agent-workflow.js';
import {
  detectVerificationStuckLoop,
  distillVerificationOutput,
  formatDistilledVerificationForPrompt,
  stripAnsiCodes,
} from '../shared/verification-log-distiller.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentWorkflowRecord } from '../shared/agent-workflow.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

test('仓库依赖爆炸半径（Aider RepoMap & code-review-graph 借鉴）：识别破坏性导出、未改调用方与 1~2 跳受波及测试', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blast-radius-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blast-outside-'));
  try {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'tsx --test test/*.test.ts' }, devDependencies: { tsx: '^4.0.0' } }),
    );
    await fs.mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await fs.mkdir(path.join(root, 'test'), { recursive: true });

    // 当前（改动后）的 pricing.ts：移除了 legacyRebate，且修改了 calculateTotal 的参数签名
    await fs.writeFile(
      path.join(root, 'src', 'pricing.ts'),
      [
        'export interface PriceBreakdown {',
        '  subtotal: number;',
        '  tax: number;',
        '}',
        '',
        'export function calculateTotal(items: number[], taxRate: number, currency: string): PriceBreakdown {',
        '  const subtotal = items.reduce((a, b) => a + b, 0);',
        '  void currency;',
        '  return { subtotal, tax: Math.round(subtotal * taxRate) };',
        '}',
        '',
      ].join('\n'),
    );

    // barrel 文件重导出 pricing.ts
    await fs.writeFile(
      path.join(root, 'src', 'index.ts'),
      "export * from './pricing.js';\n",
    );

    // 已在本次 Diff 同步更新的调用方 checkout.ts（不应出现在 unchangedDependents 中）
    await fs.writeFile(
      path.join(root, 'src', 'checkout.ts'),
      [
        "import { calculateTotal } from './pricing.js';",
        '',
        'export function runCheckout(prices: number[]) {',
        "  return calculateTotal(prices, 0.1, 'CNY');",
        '}',
        '',
      ].join('\n'),
    );

    // 未在本次 Diff 修改的调用方 1：refund.ts 仍引用已删除的 legacyRebate -> high risk!
    await fs.writeFile(
      path.join(root, 'src', 'refund.ts'),
      [
        "import { legacyRebate } from './pricing.js';",
        '',
        'export function computeRefund(amount: number) {',
        '  return legacyRebate(amount);',
        '}',
        '',
      ].join('\n'),
    );

    // 未在本次 Diff 修改的调用方 2：Vue 组件通过 `@/` 别名导入签名变更的 calculateTotal -> high risk!
    await fs.writeFile(
      path.join(root, 'src', 'components', 'CartSummary.vue'),
      [
        '<script setup lang="ts">',
        "import { calculateTotal } from '@/pricing';",
        'const summary = calculateTotal([100, 200], 0.08);',
        '</script>',
        '<template><div>{{ summary.subtotal }}</div></template>',
        '',
      ].join('\n'),
    );

    // 未在本次 Diff 修改的调用方 3：通过 barrel `src/index.ts` 间接引用 legacyRebate -> high risk!
    await fs.writeFile(
      path.join(root, 'src', 'invoice.ts'),
      [
        "import { legacyRebate } from './index.js';",
        'export const inv = () => legacyRebate(50);',
        '',
      ].join('\n'),
    );

    // 1 跳直连测试文件
    await fs.writeFile(
      path.join(root, 'test', 'pricing.test.ts'),
      "import { calculateTotal } from '../src/pricing.js';\nconsole.log(calculateTotal);\n",
    );

    // 2 跳间接测试文件（test -> checkout -> pricing）
    await fs.writeFile(
      path.join(root, 'test', 'checkout-flow.test.ts'),
      "import { runCheckout } from '../src/checkout.js';\nconsole.log(runCheckout);\n",
    );

    // 越界软链接（安全防护：必须被忽略）
    await fs.writeFile(path.join(outsideDir, 'secret.ts'), "import { calculateTotal } from './pricing.js';\n");
    await fs.symlink(path.join(outsideDir, 'secret.ts'), path.join(root, 'src', 'outside-link.ts'));

    const diffPatch = [
      'diff --git a/src/pricing.ts b/src/pricing.ts',
      'index 1111111..2222222 100644',
      '--- a/src/pricing.ts',
      '+++ b/src/pricing.ts',
      '@@ -5,9 +5,6 @@ export interface PriceBreakdown {',
      '-export function calculateTotal(items: number[], taxRate: number): PriceBreakdown {',
      '-  const subtotal = items.reduce((a, b) => a + b, 0);',
      '-  return { subtotal, tax: subtotal * taxRate };',
      '-}',
      '-export function legacyRebate(amount: number): number {',
      '-  return amount * 0.05;',
      '-}',
      '+export function calculateTotal(items: number[], taxRate: number, currency: string): PriceBreakdown {',
      '+  const subtotal = items.reduce((a, b) => a + b, 0);',
      '+  void currency;',
      '+  return { subtotal, tax: Math.round(subtotal * taxRate) };',
      '+}',
      'diff --git a/src/checkout.ts b/src/checkout.ts',
      'index 3333333..4444444 100644',
      '--- a/src/checkout.ts',
      '+++ b/src/checkout.ts',
      '@@ -1,5 +1,5 @@',
      " import { calculateTotal } from './pricing.js';",
      ' export function runCheckout(prices: number[]) {',
      "-  return calculateTotal(prices, 0.1);",
      "+  return calculateTotal(prices, 0.1, 'CNY');",
      ' }',
    ].join('\n');

    const report = await analyzeRepoBlastRadius(root, diffPatch, {
      changedFiles: ['src/pricing.ts', 'src/checkout.ts'],
    });

    assert.ok(report.touchedExports.some(e => e.name === 'legacyRebate' && e.changeKind === 'removed'));
    assert.ok(report.touchedExports.some(e => e.name === 'calculateTotal' && e.changeKind === 'signature-modified'));

    // 已同步修改的 checkout.ts 不应误报为未改调用方；越界软链接不得索引
    assert.equal(report.unchangedDependents.some(d => d.file === 'src/checkout.ts'), false);
    assert.equal(report.unchangedDependents.some(d => d.file.includes('outside-link')), false);

    // refund.ts、CartSummary.vue 与经由 barrel 的 invoice.ts 均应命中 high 风险波及
    const refundDep = report.unchangedDependents.find(d => d.file === 'src/refund.ts');
    const vueDep = report.unchangedDependents.find(d => d.file === 'src/components/CartSummary.vue');
    const barrelDep = report.unchangedDependents.find(d => d.file === 'src/invoice.ts');
    assert.equal(refundDep?.risk, 'high');
    assert.equal(vueDep?.risk, 'high');
    assert.equal(barrelDep?.risk, 'high');

    // 测试追踪应同时命中 1 跳 pricing.test.ts 与 2 跳 checkout-flow.test.ts
    assert.ok(report.impactedTests.some(t => t.file === 'test/pricing.test.ts' && t.hop === 1 && !t.updatedInDiff));
    assert.ok(report.impactedTests.some(t => t.file === 'test/checkout-flow.test.ts' && t.hop === 1)); // checkout.ts itself is in changedSourceFiles, so 1-hop!
    assert.match(report.suggestedTestCommand || '', /^npx tsx --test /);

    const promptBrief = formatBlastRadiusForPrompt(report, { role: 'reviewer', artifactHint: 'blast-radius.json' });
    assert.match(promptBrief, /legacyRebate/);
    assert.match(promptBrief, /src\/refund\.ts/);
    assert.match(promptBrief, /CartSummary\.vue/);
    assert.match(promptBrief, /npx tsx --test/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('跨 Git Worktree 并行冲突雷达（clash-sh/clash & vibe-kanban 借鉴）：区分干净、同文件重叠、未提交脏行块冲突与三方合并冲突', async () => {
  const workspaceContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-radar-'));
  const mainRepo = path.join(workspaceContainer, 'repo-main');
  const wtAlpha = path.join(workspaceContainer, 'repo-wt-alpha');
  const wtBeta = path.join(workspaceContainer, 'repo-wt-beta');
  const sourceBackend = { readLocalProjects: async () => ({ projects: [] }) } as any;

  try {
    await fs.mkdir(mainRepo, { recursive: true });
    await git(mainRepo, 'init', '-q', '-b', 'main');
    await git(mainRepo, 'config', 'user.name', 'Radar Tester');
    await git(mainRepo, 'config', 'user.email', 'radar@example.com');
    await fs.mkdir(path.join(mainRepo, 'src'), { recursive: true });
    const initialSharedLines = Array.from({ length: 20 }, (_, idx) => `export const line${idx + 1} = ${idx + 1};`).join('\n') + '\n';
    await fs.writeFile(path.join(mainRepo, 'src', 'shared.ts'), initialSharedLines);
    await fs.writeFile(path.join(mainRepo, 'src', 'alpha-only.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(mainRepo, 'src', 'beta-only.ts'), 'export const b = 1;\n');
    await git(mainRepo, 'add', '.');
    await git(mainRepo, 'commit', '-qm', 'init');

    await git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature/alpha', wtAlpha, 'main');
    await git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature/beta', wtBeta, 'main');

    // 阶段 1：各自修改不相关文件 -> clean
    await fs.writeFile(path.join(wtAlpha, 'src', 'alpha-only.ts'), 'export const a = 2;\n');
    await fs.writeFile(path.join(wtBeta, 'src', 'beta-only.ts'), 'export const b = 2;\n');
    const cleanRadar = await scanWorktreeConflicts(wtAlpha);
    assert.equal(cleanRadar.siblingCount, 2);
    assert.equal(cleanRadar.conflictCount, 0);
    assert.equal(cleanRadar.overlapCount, 0);

    // 阶段 2：同时未提交修改 shared.ts 的首尾不同行 -> overlap（同文件重叠但无行级碰撞）
    const topEdit = initialSharedLines.replace('line1 = 1;', 'line1 = 101;');
    const bottomEdit = initialSharedLines.replace('line20 = 20;', 'line20 = 220;');
    await fs.writeFile(path.join(wtAlpha, 'src', 'shared.ts'), topEdit);
    await fs.writeFile(path.join(wtBeta, 'src', 'shared.ts'), bottomEdit);
    const overlapRadar = await scanWorktreeConflicts(wtAlpha);
    assert.equal(overlapRadar.conflictCount, 0);
    assert.equal(overlapRadar.overlapCount, 1);
    const betaOverlap = overlapRadar.siblings.find(s => s.branch === 'feature/beta');
    assert.equal(betaOverlap?.status, 'overlap');
    assert.deepEqual(betaOverlap?.overlappingFiles, ['src/shared.ts']);

    // 阶段 3：同时未提交修改 shared.ts 第 1 行不同内容 -> dirty-hunk 行级冲突！
    await fs.writeFile(path.join(wtBeta, 'src', 'shared.ts'), initialSharedLines.replace('line1 = 1;', 'line1 = 999;'));
    const dirtyConflictRadar = await scanWorktreeConflicts(wtAlpha);
    assert.equal(dirtyConflictRadar.conflictCount, 1);
    const betaDirtyConflict = dirtyConflictRadar.siblings.find(s => s.branch === 'feature/beta');
    assert.equal(betaDirtyConflict?.status, 'conflict');
    assert.deepEqual(betaDirtyConflict?.conflictingFiles, ['src/shared.ts']);
    assert.ok(betaDirtyConflict?.conflictSources.includes('dirty-hunk'));

    // 阶段 4：双方各自提交到分支后，通过 git merge-tree 无损检测三方合并冲突，且不污染工作树
    await git(wtAlpha, 'add', '.');
    await git(wtAlpha, 'commit', '-qm', 'alpha modifies line1');
    await git(wtBeta, 'add', '.');
    await git(wtBeta, 'commit', '-qm', 'beta modifies line1 differently');

    const actionRes = await executeProjectGitAction({ action: 'worktree-radar', path: wtAlpha }, sourceBackend) as any;
    assert.equal(actionRes.ok, true);
    assert.equal(actionRes.radar.conflictCount, 1);
    const betaMergeTree = actionRes.radar.siblings.find((s: any) => s.branch === 'feature/beta');
    assert.equal(betaMergeTree.status, 'conflict');
    assert.ok(betaMergeTree.conflictSources.includes('merge-tree'));
    assert.deepEqual(betaMergeTree.conflictingFiles, ['src/shared.ts']);

    // 确认两个工作区仍然完全干净（零副作用）
    assert.equal(await git(wtAlpha, 'status', '--porcelain'), '');
    assert.equal(await git(wtBeta, 'status', '--porcelain'), '');

    const promptWarn = formatWorktreeRadarForPrompt(actionRes.radar, { artifactHint: 'worktree-radar.json' });
    assert.match(promptWarn, /跨工作区并行冲突雷达预警/);
    assert.match(promptWarn, /feature\/beta/);
    assert.match(promptWarn, /src\/shared\.ts/);
  } finally {
    await fs.rm(workspaceContainer, { recursive: true, force: true });
  }
});

test('验证输出蒸馏器与死循环检测（reviewdog & SWE-agent 借鉴）：ANSI 清洗、Diff 关联分级与跨轮重复失败识别', () => {
  const rawLog = [
    '\u001b[31m✖ calculates regional tax accurately (4.12ms)\u001b[0m',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  110 !== 108',
    '      at Test.runInAsyncScope (node:async_hooks:211:14)',
    '      at TestContext.<anonymous> (/private/tmp/demo-ws/test/pricing.test.ts:24:12)',
    '',
    '\u001b[96msrc/pricing.ts\u001b[0m:\u001b[93m14\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m TS2322: Type "string" is not assignable to type "number".',
    'src/legacy-untouched.ts(88,3): error TS2339: Property "oldFlag" does not exist on type "Config".',
  ].join('\n');

  assert.equal(stripAnsiCodes('\u001b[31mERROR\u001b[0m'), 'ERROR');

  const diffPatch = [
    'diff --git a/src/pricing.ts b/src/pricing.ts',
    '--- a/src/pricing.ts',
    '+++ b/src/pricing.ts',
    '@@ -12,4 +12,6 @@ export function calc() {',
    '+  const broken: number = "oops";',
    '+  return broken;',
  ].join('\n');

  const distilled = distillVerificationOutput(rawLog, {
    diffPatch,
    changedFiles: ['src/pricing.ts'],
    workspacePrefix: '/private/tmp/demo-ws',
    command: 'npm test',
    exitCode: 1,
  });

  assert.equal(distilled.passed, false);
  assert.deepEqual(distilled.failingTests, ['calculates regional tax accurately']);
  assert.equal(distilled.counts.total, 3);
  assert.equal(distilled.counts.inDiffHunk, 1);
  assert.equal(distilled.counts.outsideDiff, 2);
  // 首条诊断必须是本次 Diff 行块内的 TS2322
  assert.equal(distilled.diagnostics[0].file, 'src/pricing.ts');
  assert.equal(distilled.diagnostics[0].code, 'TS2322');
  assert.equal(distilled.diagnostics[0].diffScope, 'in-diff-hunk');
  // node:async_hooks 内部帧被过滤，断言错误精确关联到 test/pricing.test.ts:24
  const testDiag = distilled.diagnostics.find(d => d.code === 'ERR_ASSERTION');
  assert.equal(testDiag?.file, 'test/pricing.test.ts');
  assert.equal(testDiag?.line, 24);

  const formatted = formatDistilledVerificationForPrompt(distilled);
  assert.match(formatted, /本次改动行内 1/);
  assert.match(formatted, /src\/pricing\.ts:14:7 \(TS2322\)/);

  // SWE-agent 风格跨轮次死循环识别：连续两轮命中相同 finding 与相同验收项
  const stuck = detectVerificationStuckLoop([
    {
      round: 0,
      failedCriteria: ['AC-2'],
      findings: [{ file: 'src/pricing.ts', line: 14, problem: '负数金额未拦截导致实付金额小于 0' }],
    },
    {
      round: 1,
      failedCriteria: ['AC-2'],
      findings: [{ file: 'src/pricing.ts', line: 16, problem: '负数金额未拦截导致实付金额小于 0' }],
    },
  ]);
  assert.ok(stuck);
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.consecutiveRounds, 2);
  assert.match(stuck.promptWarning, /反死循环策略告警/);
  assert.match(stuck.promptWarning, /AC-2/);

  // 若第二轮变为完全不同的问题，则不应误报死循环
  const nonStuck = detectVerificationStuckLoop([
    {
      round: 0,
      findings: [{ file: 'src/pricing.ts', line: 14, problem: '负数金额未拦截' }],
    },
    {
      round: 1,
      findings: [{ file: 'src/i18n.ts', line: 5, problem: '缺少英文翻译词条' }],
    },
  ]);
  assert.equal(nonStuck, undefined);
});

test('工作流端到端接线：writeReviewMaterials 产出爆炸半径与冲突雷达，buildWorkflowContext 向验证与返工注入精确指引', async () => {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-round4-'));
  const repoA = path.join(container, 'repo-a');
  const repoB = path.join(container, 'repo-b');
  const reviewMaterials = path.join(container, 'review-materials');

  try {
    await fs.mkdir(path.join(repoA, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoA, 'test'), { recursive: true });
    await git(repoA, 'init', '-q', '-b', 'main');
    await git(repoA, 'config', 'user.name', 'WF Tester');
    await git(repoA, 'config', 'user.email', 'wf@example.com');

    await fs.writeFile(path.join(repoA, 'src', 'auth.ts'), 'export function verifyToken(token: string) { return Boolean(token); }\n');
    await fs.writeFile(path.join(repoA, 'src', 'middleware.ts'), "import { verifyToken } from './auth.js';\nexport const guard = (t: string) => verifyToken(t);\n");
    await fs.writeFile(path.join(repoA, 'test', 'auth.test.ts'), "import { verifyToken } from '../src/auth.js';\nconsole.log(verifyToken);\n");
    await git(repoA, 'add', '.');
    await git(repoA, 'commit', '-qm', 'init');

    // 创建并行兄弟工作区并制造同文件行冲突
    await git(repoA, 'worktree', 'add', '-q', '-b', 'feature/other-agent', repoB, 'main');
    await fs.writeFile(path.join(repoB, 'src', 'auth.ts'), 'export function verifyToken(token: string) { return token.length > 10; }\n');

    // 当前工作区修改导出函数签名，但未改 middleware.ts
    await fs.writeFile(path.join(repoA, 'src', 'auth.ts'), 'export function verifyToken(token: string, strictMode: boolean) { return strictMode ? token.length > 5 : Boolean(token); }\n');
    const diff = await git(repoA, 'diff', 'HEAD');

    const record: AgentWorkflowRecord = {
      id: 'wf-demo-12345678',
      parentConversationId: 'conv-1',
      templateId: 'engineering',
      objective: '升级鉴权校验严格模式',
      acceptanceCriteria: [{ id: 'AC-1', text: '鉴权函数支持严格模式且不破坏中间件调用' }],
      allowedPaths: [],
      attachmentIds: [],
      createdAt: '2026-11-15T00:00:00Z',
      updatedAt: '2026-11-15T00:05:00Z',
    };

    const implReport = '```delivery-report\n{"version":1,"taskResult":{"role":"implementer","status":"succeeded","summary":"ok","acceptance":[{"id":"AC-1","status":"passed","evidence":"ok"}],"selfTests":[{"command":"node --test","exitCode":0}],"blockers":[]}}\n```';
    const verifyReport = '```delivery-report\n{"version":1,"validationEvidence":{"tests":{"status":"passed","evidence":"ok"},"browser":{"status":"not_applicable","evidence":"无"},"remote":{"status":"pending","evidence":"未执行","sha":""},"deployment":{"status":"pending","evidence":"未执行","sha":""}},"taskResult":{"role":"verifier","status":"succeeded","summary":"ok","acceptance":[{"id":"AC-1","status":"passed","evidence":"ok"}],"blockers":[]}}\n```';

    await writeReviewMaterials(reviewMaterials, {
      record,
      diff,
      changedFiles: [{ path: 'src/auth.ts', status: 'modified' }],
      implementationResult: implReport,
      verificationResult: verifyReport,
      verificationArtifacts: [],
      workspacePath: repoA,
    });

    const blastJson = JSON.parse(await fs.readFile(path.join(reviewMaterials, 'blast-radius.json'), 'utf8'));
    assert.ok(blastJson.unchangedDependents.some((d: any) => d.file === 'src/middleware.ts' && d.risk === 'high'));
    assert.ok(blastJson.impactedTests.some((t: any) => t.file === 'test/auth.test.ts'));

    const radarJson = JSON.parse(await fs.readFile(path.join(reviewMaterials, 'worktree-radar.json'), 'utf8'));
    assert.equal(radarJson.conflictCount, 1);

    // 验证独立审查 Prompt 注入了爆炸半径与跨工作区冲突预警，且保留了标准目录文案
    const reviewRun = {
      workspacePath: repoA,
      task: { profileId: 'reviewer', workflow: { id: record.id, templateId: 'engineering', stage: 'review', round: 0, step: 3 } },
    } as unknown as AgentRun;
    const reviewPrompt = buildWorkflowContext({ record, run: reviewRun, reviewMaterials });
    assert.match(reviewPrompt, /审查材料目录：\S+（/);
    assert.match(reviewPrompt, /src\/middleware\.ts/);
    assert.match(reviewPrompt, /feature\/other-agent/);

    // 验证返工实现 Prompt 在连续两轮相同失败时注入反死循环策略告警
    const reworkRun = {
      workspacePath: repoA,
      task: { profileId: 'engineer', workflow: { id: record.id, templateId: 'engineering', stage: 'implement', round: 2, step: 7 } },
    } as unknown as AgentRun;
    const reworkPrompt = buildWorkflowContext({
      record,
      run: reworkRun,
      feedback: {
        outcome: 'failed',
        stage: '独立审查',
        reason: 'middleware 调用仍缺少参数',
        failedCriteria: ['AC-1'],
        findings: [{ id: 'F-1', severity: 'blocker', file: 'src/auth.ts', line: 1, problem: 'middleware 未适配新参数', expectation: '设为可选参数' }],
      },
      feedbackDiffPatch: diff,
      feedbackHistory: [
        { round: 0, failedCriteria: ['AC-1'], findings: [{ file: 'src/auth.ts', line: 1, problem: 'middleware 未适配新参数' }] },
        { round: 1, failedCriteria: ['AC-1'], findings: [{ file: 'src/auth.ts', line: 1, problem: 'middleware 未适配新参数' }] },
      ],
    });
    assert.match(reworkPrompt, /反死循环策略告警/);
    assert.match(reworkPrompt, /轮次 #0 -> #1/);
  } finally {
    await fs.rm(container, { recursive: true, force: true });
  }
});

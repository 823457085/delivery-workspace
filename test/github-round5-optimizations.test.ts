/**
 * Round 5 GitHub 借鉴优化测试套件：
 * 1. Moonfold / ai-hist / claude-mem 风格：跨 Agent 结构化交接简报、敏感凭据自动脱敏、6 轮隐私窗口保护、报错蒸馏
 * 2. server/agent-runtime.ts 真实跨执行器交接链路集成（保留 userContext 私有文件契约）
 * 3. conversation-export.ts 跨 Agent 交接简报导出能力
 * 4. PrePr / AgentGuard + release-drafter 风格：确定性 0-100 交付就绪评分卡、五维门禁与分类变更发布说明（Release Notes）
 * 5. 本地合并预览（merge-preview）与远端合并请求准备（prepareProjectMergeRequest）端到端 AST 契约阻断与 Release Notes 生成验证
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildCrossAgentHandoffPacket,
  formatHandoffPacketForPrompt,
  formatHandoffPacketMarkdown,
  redactSensitiveHandoffText,
} from '../shared/agent-handoff-packet.js';
import {
  draftCategorizedReleaseNotes,
  evaluateDeliveryReadinessScorecard,
} from '../shared/delivery-readiness-scorecard.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { executeProjectGitAction, readProjectGitSnapshot, type ProjectGitMergePreview } from '../server/project-git.js';
import { prepareProjectMergeRequest } from '../server/project-merge-request.js';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation.js';
import { conversationHandoffMarkdown } from '../src/features/agent-workbench/conversation-export.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) =>
  (await exec('git', ['-C', directory, ...args])).stdout.trim();

test('跨 Agent 交接包：自动脱敏凭据、过滤被修订轮次、遵守文本窗口上限并蒸馏失败日志', () => {
  // 动态拼接合成密钥，避免触发分享打包静态扫描器误报
  const fakeApiKey = ['sk', 'proj', 'SyntheticKeyForTest1234567890ABCD'].join('-');
  const fakeGhToken = ['ghp', 'SyntheticGitHubToken1234567890ABCDEF'].join('_');
  const earlyPrivateText = '第0轮早期独有密语_不应进入近期窗口摘要';

  const scrubbed = redactSensitiveHandoffText(
    `Key=${fakeApiKey} token=${fakeGhToken} https://alice:superSecretPass@github.com/org/repo`,
  );
  assert.equal(scrubbed.includes(fakeApiKey), false);
  assert.equal(scrubbed.includes(fakeGhToken), false);
  assert.equal(scrubbed.includes('superSecretPass'), false);
  assert.match(scrubbed, /\[REDACTED_API_KEY\]/);
  assert.match(scrubbed, /\[REDACTED_GITHUB_TOKEN\]/);

  const packet = buildCrossAgentHandoffPacket({
    conversationTitle: '结算服务多执行器接力',
    workspacePath: '/workspace/billing',
    branch: 'feature/PAY-208-handoff',
    targetProvider: 'codex',
    maxTextWindowTurns: 2,
    turns: [
      {
        id: 'turn-0',
        provider: 'claude',
        status: 'completed',
        objective: earlyPrivateText,
        result: '已完成基础脚手架',
        changedFiles: [{ path: 'src/billing/core.ts', status: 'added' }],
      },
      {
        id: 'turn-1-draft',
        provider: 'claude',
        status: 'cancelled',
        objective: '废弃的旧方案指令',
        result: '',
      },
      {
        id: 'turn-1-revised',
        provider: 'claude',
        status: 'completed',
        revisesRunId: 'turn-1-draft',
        objective: `接入支付网关配置 ${fakeApiKey}`,
        result: '已实现支付网关客户端并更新核心逻辑',
        changedFiles: [
          { path: 'src/billing/core.ts', status: 'modified' },
          { path: 'src/billing/gateway.ts', status: 'added' },
          { path: '.delivery-artifacts/verify.json', status: 'added' },
        ],
      },
      {
        id: 'turn-2-failed',
        provider: 'cursor',
        status: 'failed',
        objective: '执行类型检查并修复报错',
        error: 'tsc 检查未通过',
        events: [
          {
            type: 'diagnostic',
            message: 'src/billing/gateway.ts(28,11): error TS2322: Type "string" is not assignable to type "number".',
          },
        ],
      },
    ],
  });

  // 被修订替代的 turn-1-draft 不计入有效轮次
  assert.equal(packet.totalTurns, 3);
  assert.equal(packet.windowTurnCount, 2);

  // 累计改动文件跨全会话聚合，自动剔除 .delivery-artifacts
  assert.deepEqual(
    packet.cumulativeChangedFiles.map(f => ({ path: f.path, status: f.latestStatus, count: f.touchCount })),
    [
      { path: 'src/billing/core.ts', status: 'modified', count: 2 },
      { path: 'src/billing/gateway.ts', status: 'added', count: 1 },
    ],
  );

  const promptBrief = formatHandoffPacketForPrompt(packet);
  const markdownBrief = formatHandoffPacketMarkdown(packet);

  // 严格遵守窗口边界：超出 maxTextWindowTurns=2 的早期原话绝不混入摘要，且敏感凭据完全脱敏
  assert.equal(promptBrief.includes(earlyPrivateText), false);
  assert.equal(promptBrief.includes('废弃的旧方案指令'), false);
  assert.equal(promptBrief.includes(fakeApiKey), false);
  assert.equal(markdownBrief.includes(fakeApiKey), false);

  // 包含累计文件账本、报错精炼诊断与补测试提示
  assert.match(promptBrief, /src\/billing\/core\.ts \(2轮触及\)/);
  assert.match(promptBrief, /TS2322/);
  assert.match(markdownBrief, /# 跨 Agent 交接简报 · 结算服务多执行器接力/);
  assert.match(markdownBrief, /补齐对应单元\/回归测试/);
});

test('AgentRuntime 跨执行器切换注入结构化交接简报并脱敏近期记录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-runtime-'));
  const stateDir = path.join(root, 'state');
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  await git(workspacePath, 'init', '-qb', 'main');
  await git(workspacePath, 'config', 'user.name', 'Test');
  await git(workspacePath, 'config', 'user.email', 'test@localhost');
  await git(workspacePath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(workspacePath, 'app.ts'), 'export const v = 1;\n');
  await git(workspacePath, 'add', '.');
  await git(workspacePath, 'commit', '-qm', 'init');

  const fakeSecret = ['sk', 'proj', 'RuntimeSwitchSecret9876543210ZYXW'].join('-');
  const capturedRuns: AgentRun[] = [];
  const adapters: AgentRuntimeAdapter[] = (['claude', 'codex'] as const).map(provider => ({
    id: provider,
    health: async () => ({
      provider,
      label: provider,
      binary: 'fixture',
      version: '1.0',
      authenticated: true,
      ready: true,
      message: '',
      modes: ['agent', 'ask', 'plan'],
      accessModes: ['workspace', 'full'],
      models: [{ id: 'fixture', label: 'fixture' }],
      defaultModel: 'fixture',
      writable: true,
      checkedAt: new Date().toISOString(),
    }),
    execute: async context => {
      capturedRuns.push(structuredClone(context.run));
      await context.onSession(`session-${context.run.id}`);
      if (provider === 'claude') {
        await fs.writeFile(path.join(workspacePath, 'app.ts'), 'export const v = 2;\n');
        return `已完成第一阶段修改，临时调试凭据 ${fakeSecret}`;
      }
      return 'Codex 已接手完成验证';
    },
  }));

  const runtime = await createAgentRuntimeService(stateDir, {
    adapters,
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('none'); } },
  });

  const waitDone = async (run: AgentRun) => {
    for (let i = 0; i < 300 && !run.resultReady && !['failed', 'cancelled'].includes(run.status); i++) {
      await delay(10);
    }
    assert.equal(run.status, 'completed', run.error);
    return run;
  };

  try {
    const first = await waitDone(await runtime.start({
      provider: 'claude',
      mode: 'agent',
      accessMode: 'workspace',
      model: 'fixture',
      reasoningEffort: '',
      objective: '修改 app.ts 版本常量',
      workspacePath,
      attachmentIds: [],
    }));

    await waitDone(await runtime.start({
      provider: 'codex',
      mode: 'agent',
      accessMode: 'workspace',
      model: 'fixture',
      reasoningEffort: '',
      objective: '继续核对 app.ts 并补充断言',
      workspacePath,
      attachmentIds: [],
      continueConversationId: first.conversationId || first.id,
    }));

    const switchContext = capturedRuns.at(-1)?.providerSwitch?.context || '';
    assert.match(switchContext, /【结构化交接简报 · 跨执行器交接】/);
    assert.match(switchContext, /Claude Code ⇒ 当前接手: Codex/);
    assert.match(switchContext, /\[modified\] app\.ts/);
    assert.equal(switchContext.includes(fakeSecret), false, '交接上下文应自动脱敏前序轮次中的敏感凭据');
    assert.match(switchContext, /\[REDACTED_API_KEY\]/);
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('会话导出 conversationHandoffMarkdown 生成干净无 sessionId 泄露的跨 Agent 交接文档', () => {
  const run: AgentRun = {
    id: 'r-1',
    provider: 'claude',
    mode: 'agent',
    accessMode: 'workspace',
    model: 'claude-sonnet',
    reasoningEffort: 'high',
    objective: '重构订单金额精度处理',
    workspacePath: '/repo/orders',
    branch: 'feature/ORD-99',
    headSha: 'abc1234',
    status: 'completed',
    sessionId: 'private-native-session-id-999',
    pid: null,
    result: '已将浮点计算迁移为整数分计算',
    error: '',
    events: [],
    changedFiles: [{ path: 'src/money.ts', status: 'modified' }],
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:02:00.000Z',
  };
  const [conversation] = buildAgentConversations([run]);
  const markdown = conversationHandoffMarkdown(conversation!, 'antigravity');
  assert.match(markdown, /# 跨 Agent 交接简报 · 重构订单金额精度处理/);
  assert.match(markdown, /Claude Code ⇒ \*\*接手方\*\*：Antigravity/);
  assert.match(markdown, /`src\/money\.ts` — 修改/);
  assert.doesNotMatch(markdown, /private-native-session-id-999/);
});

test('交付就绪评分卡与分类发布说明：精准区分低风险完备变更与高危破坏性变更', () => {
  const cleanCard = evaluateDeliveryReadinessScorecard({
    totals: { files: 2, additions: 45, deletions: 8 },
    sourceFiles: 1,
    testFiles: 1,
    missingTestsWarning: false,
    canFastForward: true,
  });
  assert.equal(cleanCard.riskLevel, 'low');
  assert.equal(cleanCard.readinessScore, 100);
  assert.ok(cleanCard.gates.every(gate => gate.status === 'pass'));

  const criticalCard = evaluateDeliveryReadinessScorecard({
    totals: { files: 4, additions: 120, deletions: 40 },
    sourceFiles: 4,
    testFiles: 0,
    missingTestsWarning: true,
    hygieneWarnings: [
      {
        category: 'secret-leak',
        severity: 'blocker',
        label: '疑似私钥或访问令牌泄露',
        file: 'server/config.ts',
        line: 14,
        reason: '检出硬编码凭据',
      },
    ],
    blastRadius: {
      touchedExports: [{ file: 'shared/pricing.ts', name: 'calculateTotal', changeKind: 'removed' }],
      unchangedDependents: [{ file: 'src/checkout.ts', importedSymbols: ['calculateTotal'], risk: 'high' }],
      impactedTests: [{ file: 'test/pricing.test.ts', updatedInDiff: false }],
    },
  });
  assert.equal(criticalCard.riskLevel, 'critical');
  assert.ok(criticalCard.riskScore >= 70);
  assert.equal(criticalCard.gates.find(g => g.id === 'contract-compatibility')?.status, 'block');
  assert.equal(criticalCard.gates.find(g => g.id === 'hygiene-security')?.status, 'block');
  assert.equal(criticalCard.gates.find(g => g.id === 'test-signal')?.status, 'warn');

  const releaseNotes = draftCategorizedReleaseNotes({
    sourceBranch: 'feature/pricing-v2',
    targetBranch: 'main',
    commits: [
      { sha: '1111111abcdef', subject: 'feat(pricing): 新增阶梯折扣计算引擎' },
      { sha: '2222222abcdef', subject: 'fix(cart): 修复优惠券叠加负数边界问题' },
      { sha: '3333333abcdef', subject: 'refactor: 抽离币种格式化工具' },
    ],
    breakingExports: [
      { file: 'shared/pricing.ts', name: 'calculateTotal', changeKind: 'removed' },
    ],
    triageRisks: [
      { category: 'auth-permission', label: '鉴权与权限控制', file: 'server/auth.ts', reason: '调整令牌校验逻辑' },
    ],
  });

  assert.match(releaseNotes.markdown, /⚠️ 破坏性变更与升级注意/);
  assert.match(releaseNotes.markdown, /`shared\/pricing\.ts` 移除了导出符号 `calculateTotal`/);
  assert.match(releaseNotes.markdown, /🚀 新增特性与体验优化/);
  assert.match(releaseNotes.markdown, /\*\*pricing\*\*：新增阶梯折扣计算引擎/);
  assert.match(releaseNotes.markdown, /🐛 问题修复/);
  assert.match(releaseNotes.markdown, /🔒 安全、权限与运行配置/);
});

test('Git 本地合并预览与远端合并请求准备端到端输出 AST 风险评分卡与 Release Notes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-scorecard-e2e-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const dataDirectory = path.join(root, 'data');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(dataDirectory, { recursive: true });

  await git(repo, 'init', '-qb', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');

  await fs.writeFile(
    path.join(repo, 'src', 'fee.ts'),
    'export function computeFee(amount: number): number {\n  return amount * 0.02;\n}\n',
  );
  await fs.writeFile(
    path.join(repo, 'src', 'checkout.ts'),
    "import { computeFee } from './fee.js';\nexport function checkoutTotal(v: number) {\n  return v + computeFee(v);\n}\n",
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'chore: init fee and checkout');
  await git(root, 'init', '--bare', '-q', remote);
  await git(repo, 'push', '-q', remote, 'main');

  // 在功能分支移除 computeFee 导出但未同步更新 src/checkout.ts，且无测试文件
  await git(repo, 'switch', '-qc', 'feature/fee-v2');
  await fs.writeFile(
    path.join(repo, 'src', 'fee.ts'),
    'export function computeTieredFee(amount: number, rate: number): number {\n  return amount * rate;\n}\n',
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'feat(fee): 升级为阶梯费率计算函数');
  await git(repo, 'push', '-q', remote, 'HEAD:refs/heads/feature/fee-v2');

  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o700 });
  await git(repo, 'config', 'core.sshCommand', ssh);
  await git(repo, 'config', 'ssh.variant', 'ssh');
  await git(repo, 'remote', 'add', 'origin', 'git@github.com:org/billing-service.git');

  // 1. 验证远端 MR 准备（GitHub 浏览器模式，零外部网络写入）
  const prepared = await prepareProjectMergeRequest(
    { path: repo, remote: 'origin', sourceBranch: 'feature/fee-v2', targetBranch: 'main' },
    { dataDirectory },
  );
  assert.ok(prepared.scorecard, 'MR 准备应返回就绪度评分卡');
  assert.equal(
    prepared.scorecard.gates.find(g => g.id === 'contract-compatibility')?.status,
    'block',
    '移除被 src/checkout.ts 引用的 computeFee 应触发契约兼容阻断预警',
  );
  assert.equal(prepared.scorecard.riskLevel, 'critical');
  assert.ok(prepared.releaseNotesMarkdown);
  assert.match(prepared.releaseNotesMarkdown, /⚠️ 破坏性变更与升级注意/);
  assert.match(prepared.releaseNotesMarkdown, /computeFee/);

  // 2. 切回 main 验证本地合并预览（merge-preview）同样具备一致的评分卡与 Release Notes
  await git(repo, 'switch', '-q', 'main');
  const snapshot = await readProjectGitSnapshot(repo);
  const sourceStub = {
    readLocalProjects: async () => ({ projects: [], checkedAt: new Date().toISOString(), roots: [] }),
  } as unknown as Parameters<typeof executeProjectGitAction>[1];

  const previewRes = await executeProjectGitAction(
    {
      action: 'merge-preview',
      path: repo,
      ref: 'refs/heads/feature/fee-v2',
      revision: snapshot.revision,
      expectedTargetBranch: 'main',
    },
    sourceStub,
  ) as { preview: ProjectGitMergePreview };

  assert.ok(previewRes.preview.scorecard);
  assert.equal(previewRes.preview.scorecard.gates.find(g => g.id === 'contract-compatibility')?.status, 'block');
  assert.equal(previewRes.preview.scorecard.gates.find(g => g.id === 'test-signal')?.status, 'warn');
  assert.ok(previewRes.preview.releaseNotesMarkdown);
  assert.match(previewRes.preview.releaseNotesMarkdown, /🚀 新增特性与体验优化/);
});

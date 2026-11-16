import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import type { AgentRun, AgentRunMode } from '../shared/agent-runtime.js';
import { analyzeAgentRunFailure } from '../shared/agent-failure-rca.js';
import {
  formatCompactTokens,
  formatTelemetryDuration,
  formatUsdCost,
  summarizeConversationTelemetry,
  summarizeRunTelemetry,
} from '../shared/agent-session-telemetry.js';
import {
  parseMentionGroundingQuery,
  searchWorkspaceMentionGrounding,
} from '../server/workspace-mention-grounding.js';
import { useAgentMentions } from '../src/features/agent-workbench/useAgentMentions.js';
import { useAgentSlashPrompts } from '../src/features/agent-workbench/useAgentSlashPrompts.js';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-r6-1',
    provider: 'claude',
    mode: 'agent',
    accessMode: 'workspace',
    model: 'claude-sonnet-4-5',
    reasoningEffort: 'high',
    objective: '重构订单结算服务并补齐单测',
    workspacePath: '/tmp/demo-workspace',
    branch: 'feat/settlement',
    headSha: 'abc1234',
    status: 'completed',
    sessionId: 'sess-1',
    pid: null,
    result: '已完成重构并通过验证',
    error: '',
    events: [],
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:01:15.000Z',
    ...overrides,
  };
}

test('analyzeAgentRunFailure 精准分类配额限流、沙箱拦截、编译回归与瞬态超时，并对修复提示词自动脱敏', () => {
  // 1. 正常完成的运行不触发 RCA
  assert.equal(analyzeAgentRunFailure(makeRun()), null);

  // 2. 429 额度/限流：不建议原样盲跑，建议切换备用执行器接力
  const quotaRca = analyzeAgentRunFailure(makeRun({
    status: 'failed',
    error: 'API Error 429: rate_limit_exceeded - Too Many Requests',
  }));
  assert.ok(quotaRca);
  assert.equal(quotaRca.category, 'quota_or_rate_limit');
  assert.equal(quotaRca.blindRetryAdvisable, false);
  assert.equal(quotaRca.suggestSwitchProvider, true);
  assert.equal(quotaRca.smartRetryPrompt, undefined);

  // 3. 只读模式写入被拒：建议切换 Agent 模式
  const sandboxRca = analyzeAgentRunFailure(makeRun({
    mode: 'ask',
    accessMode: 'workspace',
    status: 'failed',
    error: 'Error: EPERM: operation not permitted,只读模式不得修改文件',
  }));
  assert.ok(sandboxRca);
  assert.equal(sandboxRca.category, 'permission_or_sandbox');
  assert.equal(sandboxRca.suggestUpgradeAccess, true);
  assert.ok(sandboxRca.recoverySteps.some(step => step.includes('Agent 模式')));

  // 4. 编译/验证回归：提炼精确 file:line 诊断 + 因果工具动作 + 自动脱敏凭据
  const syntheticToken = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-');
  const compileRca = analyzeAgentRunFailure(makeRun({
    status: 'failed',
    changedFiles: [{ path: 'src/settlement/calc.ts', status: 'modified' }],
    error: `Command failed: npm run build (token=${syntheticToken})\nsrc/settlement/calc.ts(42,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
    events: [
      { id: 'e1', type: 'tool', message: '执行失败: run_command: npm run build', createdAt: '2026-11-15T10:01:10.000Z' },
    ],
  }));
  assert.ok(compileRca);
  assert.equal(compileRca.category, 'verification_or_compile');
  assert.equal(compileRca.blindRetryAdvisable, false);
  assert.ok(compileRca.causalTrigger?.includes('npm run build'));
  assert.equal(compileRca.diagnostics[0]?.file, 'src/settlement/calc.ts');
  assert.equal(compileRca.diagnostics[0]?.line, 42);
  assert.ok(compileRca.smartRetryPrompt?.includes('src/settlement/calc.ts:42'));
  assert.ok(!compileRca.smartRetryPrompt?.includes(syntheticToken), '不得在修复提示词中泄露原始密钥');

  // 5. 网络瞬态超时：允许直接重新执行
  const timeoutRca = analyzeAgentRunFailure(makeRun({
    status: 'interrupted',
    error: 'request failed: connect ETIMEDOUT 10.0.0.8:443',
  }));
  assert.ok(timeoutRca);
  assert.equal(timeoutRca.category, 'network_or_timeout');
  assert.equal(timeoutRca.blindRetryAdvisable, true);
});

test('summarizeRunTelemetry 与 summarizeConversationTelemetry 汇总缓存命中率、跨引擎 Token 与去重工具动作', () => {
  const run1 = makeRun({
    id: 'run-1',
    provider: 'claude',
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:00:45.000Z',
    changedFiles: [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
    ],
    usage: {
      source: 'claude',
      inputTokens: 40_000,
      cachedInputTokens: 30_000,
      outputTokens: 2_500,
      reasoningTokens: 800,
      costUsd: 0.085,
      costSource: 'claude_code_self_reported',
      models: null,
    },
    events: [
      { id: '1', type: 'tool', message: '正在执行: read_file: src/a.ts', createdAt: '2026-11-15T10:00:05.000Z' },
      { id: '2', type: 'tool', message: '执行完成: read_file: src/a.ts', createdAt: '2026-11-15T10:00:06.000Z' },
      { id: '3', type: 'tool', message: '正在执行: apply_patch: src/a.ts', createdAt: '2026-11-15T10:00:15.000Z' },
      { id: '4', type: 'tool', message: '执行完成: apply_patch: src/a.ts', createdAt: '2026-11-15T10:00:18.000Z' },
      { id: '5', type: 'tool', message: '执行失败: run_command: npm test', createdAt: '2026-11-15T10:00:35.000Z' },
    ],
  });

  const t1 = summarizeRunTelemetry(run1);
  assert.equal(t1.durationLabel, '45s');
  assert.equal(t1.totalTokens, 42_500);
  assert.equal(t1.cacheHitPercent, 75);
  assert.equal(t1.cacheGrade, 'high');
  assert.equal(t1.tools.fileReads, 1);
  assert.equal(t1.tools.fileEdits, 1);
  assert.equal(t1.tools.shellCommands, 1);
  assert.equal(t1.tools.failedActions, 1);
  assert.equal(t1.tools.totalActions, 3);

  const run2 = makeRun({
    id: 'run-2',
    provider: 'codex',
    createdAt: '2026-11-15T10:02:00.000Z',
    updatedAt: '2026-11-15T10:03:20.000Z',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }, { path: 'test/a.test.ts', status: 'added' }],
    usage: undefined, // 模拟部分轮次 CLI 未上报 usage
    events: [
      { id: '6', type: 'tool', message: '执行完成: rg: calculateTotal', createdAt: '2026-11-15T10:02:10.000Z' },
    ],
  });

  const session = summarizeConversationTelemetry([run1, run2]);
  assert.equal(session.totalRuns, 2);
  assert.equal(session.usageReportedRuns, 1);
  assert.equal(session.totalDurationLabel, '2m 5s');
  assert.equal(session.totalTokens, 42_500);
  assert.equal(session.cacheHitPercent, 75);
  assert.equal(session.uniqueChangedFiles, 3);
  assert.equal(session.providers.length, 2);
  assert.equal(session.tools.searches, 1);
  assert.equal(formatCompactTokens(42_500), '42.5k');
  assert.equal(formatTelemetryDuration(125_000), '2m 5s');
  assert.equal(formatUsdCost(0.085), 'US$0.09');
});

test('searchWorkspaceMentionGrounding 支持 @目录: 与 @符号: 精确行号检索，并排除敏感文件与越界软链', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r6-mentions-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-r6-outside-'));
  try {
    await fs.mkdir(path.join(tempRoot, 'src/billing'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'src/components'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'src/billing/invoice.ts'),
      [
        '// 账单核算模块',
        'export interface InvoiceLineItem {',
        '  sku: string;',
        '  amountCents: number;',
        '}',
        '',
        'export async function calculateInvoiceTotal(items: InvoiceLineItem[]): Promise<number> {',
        '  return items.reduce((sum, item) => sum + item.amountCents, 0);',
        '}',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempRoot, 'src/components/InvoiceBadge.vue'),
      '<script setup lang="ts">\nexport const badgeVersion = 1;\n</script>\n<template><span>ok</span></template>\n',
      'utf8',
    );
    // 敏感环境文件与外部越界软链绝不可进入候选
    await fs.writeFile(path.join(tempRoot, '.env.local'), 'SECRET_VAL=do_not_expose\n', 'utf8');
    await fs.writeFile(path.join(outsideDir, 'leak.ts'), 'export function leakedOutsideSymbol() {}\n', 'utf8');
    await fs.symlink(path.join(outsideDir, 'leak.ts'), path.join(tempRoot, 'src/billing/leak-link.ts'));

    assert.deepEqual(parseMentionGroundingQuery('目录:billing'), { scope: 'folder', term: 'billing' });
    assert.deepEqual(parseMentionGroundingQuery('符号:calculateInvoice'), { scope: 'symbol', term: 'calculateInvoice' });

    const folderRes = await searchWorkspaceMentionGrounding(tempRoot, '目录:billing');
    assert.equal(folderRes.scope, 'folder');
    assert.equal(folderRes.folders[0]?.path, 'src/billing/');
    assert.equal(folderRes.folders[0]?.fileCount, 1, '越界软链不计入有效工作区文件');
    assert.equal(folderRes.symbols.length, 0);

    const symbolRes = await searchWorkspaceMentionGrounding(tempRoot, '符号:calculateInvoice');
    assert.equal(symbolRes.scope, 'symbol');
    assert.equal(symbolRes.symbols[0]?.name, 'calculateInvoiceTotal');
    assert.equal(symbolRes.symbols[0]?.path, 'src/billing/invoice.ts');
    assert.equal(symbolRes.symbols[0]?.line, 7);

    const leakRes = await searchWorkspaceMentionGrounding(tempRoot, '符号:leakedOutside');
    assert.equal(leakRes.symbols.length, 0, '严禁索引指向工作区外部的软链接文件');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('useAgentMentions 与 useAgentSlashPrompts 支持 @目录: / @符号: 精确引用写入及新增工程快捷指令', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('/api/agent-runtimes/mentions')) {
      return Response.json({
        workspacePath: '/repo',
        files: [],
        skills: [],
        folders: [{ path: 'src/billing/', fileCount: 4 }],
        symbols: [{ name: 'calculateInvoiceTotal', kind: 'function', path: 'src/billing/invoice.ts', line: 7, signature: 'export async function calculateInvoiceTotal(...)' }],
      });
    }
    return Response.json({ notes: [] });
  };

  const scope = effectScope();
  try {
    await scope.run(async () => {
      const draft = shallowRef('请检查 @符号:calculateInvoice');
      const mentions = useAgentMentions(
        draft,
        () => ({ workspacePath: '/repo', provider: 'codex', modes: ['agent', 'plan', 'ask'] }),
        () => false,
        () => {},
        shallowRef([]),
      );
      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(mentions.options.value[0]?.kind, 'symbol');
      assert.equal(mentions.options.value[0]?.value, 'src/billing/invoice.ts:7');
      mentions.select(mentions.options.value[0]!);
      assert.equal(draft.value, '请检查 @src/billing/invoice.ts:7 ');

      // 验证新增的 GitHub 工程流快捷指令与自动模式建议
      const slashDraft = ref('/影响面');
      const switchedModes: AgentRunMode[] = [];
      const slash = useAgentSlashPrompts(
        slashDraft,
        () => ({ modes: ['agent', 'plan', 'ask'], modeLocked: false }),
        () => false,
        mode => switchedModes.push(mode),
        null,
      );
      await nextTick();
      assert.equal(slash.open.value, true);
      assert.equal(slash.options.value[0]?.command, '影响面评估');
      slash.select(slash.options.value[0]!);
      assert.deepEqual(switchedModes, ['plan']);
      assert.ok(slashDraft.value.includes('爆炸半径'));
    });
  } finally {
    scope.stop();
    globalThis.fetch = originalFetch;
  }
});

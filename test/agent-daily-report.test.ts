import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { createDailyReportInput, dailyReportDate, isDailyReportDate } from '../src/features/agent-workbench/daily-report.js';

const now = new Date(2026, 8, 22, 0, 5);
const runtime: AgentRuntimeHealth = {
  provider: 'codex', label: 'Codex', binary: '/codex', version: '', authenticated: true, ready: true,
  message: '', modes: ['ask', 'agent'], models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['medium', 'max', 'ultra'], defaultEffort: 'medium' }],
  defaultModel: 'configured-model', configuredServiceTier: 'priority', writable: true, checkedAt: '',
};

test('日报使用本地日历日期，拒绝未来、无效日期和注入内容', () => {
  assert.equal(dailyReportDate(now), '2026-09-22');
  for (const invalid of ['', '2026-09-23', '2026-02-30', '2026-13-01', '2026-9-2', '2026-09-22\n发布日报']) {
    assert.equal(isDailyReportDate(invalid, now), false, invalid);
    assert.equal(createDailyReportInput(invalid, '/repo', runtime, now), undefined);
  }
  assert.equal(isDailyReportDate('2024-02-29', now), true);
  assert.equal(isDailyReportDate('2026-09-22', now), true);
});

test('日报创建独立只读任务，不复用开发会话、不切分支、不提升权限', () => {
  const input = createDailyReportInput('2026-09-22', '/ordinary-folder', runtime, now)!;
  assert.equal(input.mode, 'ask');
  assert.equal(input.accessMode, 'workspace');
  assert.equal(input.provider, 'codex');
  assert.equal(input.model, 'gpt-6.1-sol');
  assert.equal(input.reasoningEffort, 'ultra');
  assert.equal(input.serviceTier, 'default', '不继承 CLI 配置中的倍速');
  assert.equal(input.workspacePath, '/ordinary-folder');
  for (const key of ['branch', 'isolateWorkspace', 'resumeSessionId', 'parentRunId', 'attachmentIds']) assert.equal(key in input, false);
  for (const required of ['computer_history_status', '6h', '10min', '未受信任', '不发布', '不自动恢复采集', '待确认', '覆盖范围', '密码', '本机时区 2026-09-22']) {
    assert.ok(input.objective.includes(required), required);
  }
});

test('日报无需选择项目，仍需要可用的 Codex 和有效模型', () => {
  for (const unavailable of [undefined, { ...runtime, ready: false }, { ...runtime, provider: 'cursor' as const },
    { ...runtime, modes: ['agent'] as AgentRuntimeHealth['modes'] }, { ...runtime, models: [] },
    { ...runtime, models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low'] as AgentRuntimeHealth['models'][number]['efforts'] }] }]) {
    assert.equal(createDailyReportInput('2026-09-22', '/repo', unavailable, now), undefined);
  }
  assert.equal(createDailyReportInput('2026-09-22', ' ', runtime, now)?.workspacePath, '');
});

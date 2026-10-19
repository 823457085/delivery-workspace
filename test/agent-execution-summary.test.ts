import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, AgentRunEvent } from '../shared/agent-runtime';
import { groupRunExecutionEvents, summarizeRunExecution } from '../src/features/agent-workbench/execution-summary';

function event(message: string, type: AgentRunEvent['type'] = 'lifecycle'): AgentRunEvent {
  return { id: message, type, message, createdAt: '2026-09-17T09:00:00.000Z' };
}

function run(events: AgentRunEvent[]): AgentRun {
  return { id: 'run-1', provider: 'codex', mode: 'agent', accessMode: 'workspace', model: '', reasoningEffort: '', objective: '任务',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', status: 'running', sessionId: 'session-1', pid: 1,
    result: '', error: '', events, createdAt: '2026-09-17T09:00:00.000Z', updatedAt: '2026-09-17T09:01:00.000Z' };
}

test('执行摘要合并重复命令，只保留统计和最后一条异常', () => {
  const summaries = summarizeRunExecution(run([
    event('Codex 正在执行工作区命令'), event('工作区命令已完成'),
    event('Codex 正在执行工作区命令'), event('工作区命令未通过'),
    event('旧的异常', 'diagnostic'), event('最新异常', 'diagnostic'),
  ]));
  assert.deepEqual(summaries.map((item) => item.title), ['正在处理', '工具调用', '需要关注']);
  assert.equal(summaries[1].detail, '4 条记录已收起，1 条提示未通过');
  assert.equal(summaries[2].detail, '最新异常');
});

test('原始运行记录折叠重复命令节点，保留有信息量的说明', () => {
  const events = [
    event('Codex 开始分析'),
    event('Codex 正在执行工作区命令'),
    event('工作区命令已完成'),
    event('Codex 正在执行工作区命令'),
    event('工作区命令未通过'),
    event('初步结论已经明确'),
  ];

  const grouped = groupRunExecutionEvents(events);
  assert.deepEqual(grouped.visible.map((item) => item.message), ['Codex 开始分析', '初步结论已经明确']);
  assert.equal(grouped.routine.length, 4);
  assert.equal(grouped.routineSummary, '已保存 4 条工具记录');
});

test('实时工具流水收起，中文进度、状态和英文异常保留，完整信息不丢原文', () => {
  const events = [
    event('正在续接原会话'),
    event('正在执行：js', 'tool'),
    event('执行完成：js', 'tool'),
    event('正在执行：/bin/zsh -lc "python3 - <<\'PY\'\nimport json\nprint(1)\nPY"', 'tool'),
    event('已复测 6 条问题：3 条通过，广告返回 HTTP 404，email 为空。', 'message'),
    event('Reconnecting... waiting for network', 'diagnostic'),
    event('工具返回的其他原始记录', 'tool'),
    event('Agent 本轮运行完成'),
  ];
  const original = structuredClone(events);
  const grouped = groupRunExecutionEvents(events);
  assert.deepEqual(grouped.visible, [events[0], events[4], events[5], events[7]]);
  assert.deepEqual(grouped.routine, [events[1], events[2], events[3], events[6]]);
  assert.equal(grouped.routineSummary, '已保存 4 条工具记录');
  assert.equal(grouped.visible.length + grouped.routine.length, events.length);
  assert.deepEqual(events, original);
});

test('归类依据事件类型，不把同文案的进度说明或诊断当作工具流水', () => {
  const events = [event('工作区命令未通过', 'diagnostic'), event('Codex 正在执行工作区命令', 'message')];
  assert.deepEqual(groupRunExecutionEvents(events).visible, events);
  assert.equal(summarizeRunExecution(run(events)).at(-1)?.detail, '工作区命令未通过');
});

test('只有截断后的完成记录时，不推断调用总量、执行中或成功', () => {
  const events = [event('执行完成：js', 'tool'), event('执行完成：/bin/zsh -lc "exit 1"', 'tool')];
  const grouped = groupRunExecutionEvents(events);
  assert.deepEqual(grouped.visible, []);
  assert.equal(grouped.routine.length, 2);
  const summary = summarizeRunExecution(run(events)).find((item) => item.key === 'commands');
  assert.equal(summary?.detail, '2 条记录已收起，可在完整信息中查看');
  assert.equal(summary?.tone, 'muted');
});

test('没有事件时仅保留运行状态', () => {
  assert.deepEqual(groupRunExecutionEvents([]).visible, []);
  assert.deepEqual(summarizeRunExecution(run([])).map((item) => item.key), ['status']);
});

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
  assert.deepEqual(summaries.map((item) => item.title), ['正在处理', '工作区操作', '需要关注']);
  assert.equal(summaries[1].detail, '已执行 2 个操作，1 个需要调整');
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
  assert.equal(grouped.routineSummary, '2 次执行 · 1 次完成 · 1 次未通过');
});

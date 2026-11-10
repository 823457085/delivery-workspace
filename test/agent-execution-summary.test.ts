import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, AgentRunEvent } from '../shared/agent-runtime';
import { agentResultSummary, agentRunActivity, agentRunPublicMessages, conversationExecutionRuns, groupRunExecutionEvents, previewRunExecution, summarizeRunExecution } from '../src/features/agent-workbench/execution-summary';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation';
import type { TeamRoom } from '../src/features/agent-workbench/team-api';

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
  ]), Date.parse('2026-09-17T09:01:00.000Z'));
  assert.deepEqual(summaries.map((item) => item.title), ['正在处理', '工具调用', '需要关注']);
  assert.equal(summaries[1].detail, '4 条记录已收起，1 条提示未通过');
  assert.equal(summaries[2].detail, '最新异常');
});

test('重启续跑显示本次活动，长时间没有回报提示等待，旧停止记录仍在日志中', () => {
  const resumedAt = '2026-09-17T09:02:00.000Z';
  const activityAt = '2026-09-17T09:04:00.000Z';
  const stopped = event('运行已停止', 'diagnostic');
  const value = { ...run([stopped, { ...event('view_file', 'tool'), createdAt: activityAt }]),
    workspaceRestartResumedAt: resumedAt };

  const active = summarizeRunExecution(value, Date.parse('2026-09-17T09:05:00.000Z'));
  assert.equal(active[0]?.title, '正在处理');
  assert.deepEqual(active[0]?.activity, { text: '读取文件', at: activityAt });
  assert.equal(active.some(item => item.key === 'diagnostic'), false);
  const waiting = summarizeRunExecution(value, Date.parse('2026-09-17T09:10:00.000Z'))[0];
  assert.equal(waiting?.title, '等待新进展');
  assert.match(waiting?.detail || '', /6 分钟未收到新事件.*运行中/);
  assert.equal(value.events[0], stopped);
  const interrupted = summarizeRunExecution({ ...value, status: 'interrupted', error: 'Agent 进程已退出' });
  assert.equal(interrupted[0]?.detail, 'Agent 进程已退出');
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

test('直接展示已保存的报告摘要与最近动作，不显示内部 JSON 或改写原记录', () => {
  const report = '```delivery-report\n{"version":1,"taskResult":{"summary":"已核验，版本一致"}}\n```';
  const value = { ...run([event('正在核对版本', 'message'), event('正在执行：git rev-parse HEAD', 'tool'),
    event('执行完成：git rev-parse HEAD', 'tool'), event(report, 'message')]), result: report };
  const original = structuredClone(value);
  const preview = previewRunExecution(value);
  assert.equal(preview.summary, '已核验，版本一致');
  assert.equal(preview.progress, '已核验，版本一致');
  assert.equal(preview.toolCount, 2); assert.equal(preview.tools.length, 2);
  assert.equal(preview.events.some(event => event.message.includes('delivery-report')), false);
  assert.equal(agentResultSummary('正在整理\n```delivery-report\n{"taskResult":'), '正在整理');
  assert.equal(agentResultSummary('```delivery-report\n{"taskResult":'), '');
  assert.equal(agentResultSummary('```json\n{"version":1,"taskResult":{"role":"implementer","status":"succeeded","summary":"已修复映射；页面未核验"}}\n```'), '已修复映射；页面未核验');
  assert.equal(agentResultSummary('```json\n{"api":"example"}\n```'), '```json\n{"api":"example"}\n```');
  assert.deepEqual(value, original);
});

test('执行区包含当前会话的真实岗位运行，切换会话拒绝旧房间数据并按 runId 去重', () => {
  const main = { ...run([]), id: 'main', conversationId: 'conversation', status: 'completed' as const };
  const worker = { ...run([]), id: 'worker', createdAt: '2026-09-17T09:02:00Z' };
  const conversation = buildAgentConversations([main])[0];
  const room = { task: { parentConversationId: conversation.id }, runs: [main, worker] } as TeamRoom;
  assert.deepEqual(conversationExecutionRuns(conversation, room).map(run => run.id), ['main', 'worker']);
  assert.deepEqual(conversationExecutionRuns({ ...conversation, id: 'another' }, room).map(run => run.id), ['main']);
  assert.deepEqual(conversationExecutionRuns(undefined, room), []);
});

test('运行动态去除重复结果和生命周期提示，仍保留原始日志与不同进展', () => {
  const value = run([event('正在续接原会话'), event('检查依赖', 'message'), event('检查依赖', 'message'),
    event('正在执行：pnpm test', 'tool'), event('验证通过', 'message'), event('Agent 本轮运行完成')]);
  const original = structuredClone(value);
  const live = previewRunExecution(value);
  assert.equal(live.progress, '验证通过');
  assert.deepEqual(live.updates.map(item => item.message), ['检查依赖']);
  const completed = previewRunExecution({ ...value, result: '验证通过', status: 'completed' });
  assert.deepEqual(completed.updates.map(item => item.message), ['检查依赖']);
  assert.equal(completed.tools.at(-1)?.message, '正在执行：pnpm test');
  assert.deepEqual(value, original);
});

test('会话展示公开中间回复和当前工具，保留正文原文并兼容历史工具名', () => {
  const text = '### 检查进展\n\n已检查 **服务配置**，接口返回 L1001。';
  const value = run([event('开始执行'), event(text, 'message'), event(text, 'message'), event('run_command', 'tool')]);
  const original = structuredClone(value);
  assert.deepEqual(agentRunPublicMessages(value).map(item => item.message), [text]);
  assert.equal(agentRunActivity(value), '执行命令');
  assert.equal(previewRunExecution(value).tools.at(-1)?.message, '执行命令');
  assert.deepEqual(value, original);
});

test('流式正文包含中间回复时不重复，独立的进展和最终正文仍各自保留', () => {
  const progress = '已定位原因。';
  const value = { ...run([event(progress, 'message'), event('开始：执行命令：npm test', 'tool')]), result: `${progress}\n\n正在验证` };
  assert.deepEqual(agentRunPublicMessages(value), []);
  assert.deepEqual(previewRunExecution(value).updates, []);
  assert.equal(agentRunActivity(value), '开始：执行命令：npm test');
  assert.deepEqual(agentRunPublicMessages({ ...value, result: '验证通过。' }).map(item => item.message), [progress]);
});

test('最新事件是公开回复时不再次当作活动显示，完成后也不保留旧工具状态', () => {
  const value = run([event('view_file', 'tool'), event('已读取配置。', 'message')]);
  assert.equal(agentRunActivity(value), '');
  assert.equal(agentRunPublicMessages(value).length, 1);
  assert.equal(agentRunActivity({ ...value, status: 'completed', events: [event('run_command', 'tool')] }), '');
  assert.equal(agentRunActivity(run([])), '等待执行器返回状态');
});

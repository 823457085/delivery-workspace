import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';
import type { AgentTaskPlan } from '../shared/agent-task-plan.js';

const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: 'fixture', version: 'fixture',
  ready: true, authenticated: true, message: 'ready', modes: ['agent', 'ask', 'plan'], writable: true, defaultModel: '', checkedAt: new Date().toISOString(),
  models: provider === 'codex' ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
    : provider === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer 2.5' }]
      : ['sonnet', 'opus'].map(id => ({ id, label: id === 'sonnet' ? 'Sonnet 5.5' : 'Opus 5.5', efforts: ['high'] })) });
async function waitFor<T>(read: () => T, done: (value: T) => boolean) {
  for (let index = 0; index < 1000; index++) {
    const value = read(); if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`等待状态超时：${JSON.stringify(read())}`);
}

test('内部岗位答复后恢复等待用户，历史运行状态重开不重派，答齐后仅续接一次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-waiting-status-')), data = path.join(root, 'data'), source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/value.js'), 'export const value = 1;\n');
  const plan: AgentTaskPlan = { templateId: 'engineering', reason: '按原始值修改', risk: 'medium',
    acceptanceCriteria: [{ id: 'AC-1', text: 'value为2', source: '用户原话' }], allowedPaths: ['src/**'], needsAnalyst: false, needsArchitect: false,
    questions: [], risks: [], ownership: [], shared: [] };
  const calls: { run: AgentRun; resume?: string }[] = [];
  let implementations = 0;
  const adapters: AgentRuntimeAdapter[] = (['codex', 'claude', 'cursor'] as const).map(provider => ({
    id: provider, health: async () => health(provider), execute: async context => {
      await context.onSession(context.resumeSessionId || `${provider}:${context.run.id}`);
      calls.push({ run: structuredClone(context.run), resume: context.resumeSessionId });
      switch (context.run.team?.profileId) {
        case 'leader': return report({ taskPlan: plan });
        case 'engineer':
          if (++implementations === 1) return report({ questions: [
            { to: 'user', text: '是否使用原始值？', blocking: true },
            { to: 'architect', text: '请核对原始字段契约', blocking: true },
          ] });
          assert.match(context.run.teamContext || '', /使用原始值 L0001/);
          assert.match(context.run.teamContext || '', /原始字段契约已核对/);
          await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
          return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已修改value' } });
        case 'architect': return report({ answer: '原始字段契约已核对' });
        case 'verifier':
          assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
          return report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded',
            acceptance: [{ id: 'AC-1', status: 'passed', evidence: '实际读取value为2' }] } });
        case 'reviewer': return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [] } });
        default: throw new Error(`未配置夹具岗位：${context.run.team?.profileId}`);
      }
    },
  }));
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let team: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    runtime = await createAgentRuntimeService(data, { adapters });
    team = await createAgentTeamService(data, runtime);
    const started = await team.chat({ objective: '将value改为2并验证', attachmentIds: [], requestId: 'start', workspacePath: source });
    const waiting = await waitFor(() => team!.getTask(started.task.id), task => team!.isIdle()
      && task.nodes.some(node => node.purpose === 'answer' && node.status === 'completed'));
    assert.equal(waiting.state, 'waiting_input', waiting.reason || '');
    assert.equal(waiting.nodes.find(node => node.stage === 'implement')?.status, 'waiting_input');
    assert.equal(waiting.nodes.find(node => node.stage === 'verify')?.status, 'pending');
    assert.equal(calls.some(call => call.run.team?.profileId === 'verifier'), false, '等待实现节点的验证不可提前派发');
    const room = await team.room(waiting.id);
    const question = room.messages.find(message => message.type === 'ask' && message.to.kind === 'user')!;
    assert.ok(question); assert.equal(question.processing, 'pending');
    assert.equal(room.messages.find(message => message.type === 'ask' && message.to.kind === 'profile')?.processing, 'answered');
    const callsBeforeRestart = calls.length;
    await team.close(); team = undefined; await runtime.close(); runtime = undefined;

    // 旧版本将内部答复后的等待错误持久化为 running；重开只归并事实，不重新调用模型。
    const taskFile = path.join(data, 'team-tasks.json'), stored = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const stale = stored.tasks.find((task: { id: string }) => task.id === waiting.id);
    stale.state = 'running'; stale.reason = '正在派发架构';
    await fs.writeFile(taskFile, JSON.stringify(stored));
    runtime = await createAgentRuntimeService(data, { adapters });
    team = await createAgentTeamService(data, runtime);
    assert.equal(team.getTask(waiting.id).state, 'waiting_input');
    assert.equal(calls.length, callsBeforeRestart, '恢复等待状态不应新增模型执行');
    assert.equal(team.getTask(waiting.id).nodes.find(node => node.stage === 'verify')?.status, 'pending');

    const answer = { correlationId: question.id, text: '使用原始值 L0001', requestId: 'answer-user' };
    await team.answer(waiting.id, answer);
    const done = await waitFor(() => team!.getTask(waiting.id), task => ['completed', 'blocked', 'needs_decision'].includes(task.state));
    assert.equal(done.state, 'completed', done.reason || '');
    await team.answer(waiting.id, answer);
    assert.equal(implementations, 2);
    const writes = calls.filter(call => call.run.team?.profileId === 'engineer');
    assert.equal(writes[1].resume, writes[0].run.sessionId);
    assert.equal(calls.filter(call => call.run.team?.profileId === 'architect').length, 1);
    assert.equal(calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
    assert.equal(calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
  } finally {
    await team?.close(); await runtime?.close(); await fs.rm(root, { recursive: true, force: true });
  }
});

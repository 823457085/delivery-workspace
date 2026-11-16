import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGroupPreset, defaultGroupConfig, groupPresetIds, groupTeamMembers } from '../shared/agent-group-chat.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { groupContext } from '../server/agent-group-chat.js';
import { readTeamRolePrompt } from '../server/agent-profiles.js';
import { skillDisplayDescription } from '../server/codex-skills.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('内置团队预设支持一键切换且保留成员已有模型与备用模型绑定', () => {
  const profiles = defaultTeamProfileConfig();
  const base = defaultGroupConfig(profiles);
  const customFrontendBinding = { provider: 'cursor' as const, model: 'composer-2.5', reasoningEffort: '' as const };
  const customFallback = { provider: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'high' as const };
  base.revision = 7;
  base.members = base.members.map(member => member.id === 'frontend'
    ? { ...member, binding: customFrontendBinding, fallbackBinding: customFallback }
    : member);

  for (const presetId of groupPresetIds) {
    const next = applyGroupPreset(base, presetId, profiles);
    assert.equal(next.revision, 7);
    assert.ok(next.members.every(member => member.enabled && !!member.binding));
    const mapped = groupTeamMembers(next);
    assert.ok(mapped.leader, `${presetId} 应保留自动协作所需的负责人映射`);
    assert.ok(mapped.verifier, `${presetId} 应保留验证岗位映射`);
    assert.ok(mapped.reviewer, `${presetId} 应保留审查岗位映射`);
  }

  const fullstack = applyGroupPreset(base, 'fullstack-delivery');
  assert.deepEqual(fullstack.members.find(member => member.id === 'frontend')?.binding, customFrontendBinding);
  assert.deepEqual(fullstack.members.find(member => member.id === 'frontend')?.fallbackBinding, customFallback);
  assert.deepEqual(fullstack.members.find(member => member.id === 'engineer')?.binding, customFrontendBinding, '无同名成员时复用同分工已配模型');

  const improveTeam = applyGroupPreset(base, 'codebase-improve', profiles);
  assert.equal(improveTeam.name, '代码体检与重构团队');
  assert.deepEqual(improveTeam.members.map(member => member.id), ['analyst', 'leader', 'engineer', 'verifier', 'reviewer', 'reporter']);
  assert.match(improveTeam.members.find(member => member.id === 'leader')!.instructions, /Vet|杠杆率/);
  assert.match(improveTeam.members.find(member => member.id === 'engineer')!.instructions, /STOP/);
});

test('群聊上下文按前后游岗位注入自包含交接、STOP 熔断、备用漂移检查与反形式化审查规则', () => {
  const profiles = defaultTeamProfileConfig();
  const config = applyGroupPreset(defaultGroupConfig(profiles), 'codebase-improve', profiles);
  const turns = config.members.map((member, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    member,
    attempt: 1,
    runId: `10000000-0000-4000-8000-00000000000${index + 1}`,
    status: 'pending' as const,
    result: '',
    error: '',
    updatedAt: '2026-11-13T12:00:00.000Z',
  }));
  turns[2] = {
    ...turns[2]!,
    fallbacks: [{
      from: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      to: { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' },
      reason: 'insufficient_quota',
      runId: '',
      at: '2026-11-13T12:01:00.000Z',
    }],
  };
  const round = {
    id: '20000000-0000-4000-8000-000000000001',
    requestId: 'req-improve-1',
    requestHash: 'hash-1',
    text: '排查并重构核心模块',
    attachmentIds: [],
    accessMode: 'full' as const,
    state: 'running' as const,
    turns,
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-13T12:00:00.000Z',
  };
  const room = {
    id: '30000000-0000-4000-8000-000000000001',
    title: '代码体检测试',
    workspacePath: '/work/demo',
    executionPath: '/work/demo',
    paused: false,
    cursorTrustPaths: [],
    rounds: [round],
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-13T12:00:00.000Z',
  };

  const leaderCtx = groupContext(room, round, turns[1]!, () => undefined);
  assert.match(leaderCtx, /交接准备（面向后续实现与备用模型）/);
  assert.match(leaderCtx, /严禁在回复或产物中输出任何真实密钥/);

  const engineerCtx = groupContext(room, round, turns[2]!, () => undefined);
  assert.match(engineerCtx, /实现交接与 STOP 熔断约定/);
  assert.match(engineerCtx, /基线漂移检查/);

  const reviewerCtx = groupContext(room, round, turns[4]!, () => undefined);
  assert.match(reviewerCtx, /独立审查反形式化约定/);
  assert.match(reviewerCtx, /by-design/);

  const reporterCtx = groupContext(room, round, turns[5]!, () => undefined);
  assert.doesNotMatch(reporterCtx, /交接准备（面向后续实现与备用模型）/, '末尾整理岗位无下游写成员时不注入写前交接提示');
});

test('自动协作岗位提示词与随包 codebase-improve Skill 均已就绪', async () => {
  const [leaderPrompt, engineerPrompt, reviewerPrompt] = await Promise.all([
    readTeamRolePrompt('leader'),
    readTeamRolePrompt('engineer'),
    readTeamRolePrompt('reviewer'),
  ]);
  assert.match(leaderPrompt, /面向零上下文执行者与备用模型把计划写自包含/);
  assert.match(engineerPrompt, /STOP 熔断规则/);
  assert.match(reviewerPrompt, /Gaming Criteria/);
  assert.match(reviewerPrompt, /真实密钥/);

  for (const relative of [
    'support/skills/codebase-improve/SKILL.md',
    'support/skills/codebase-improve/references/audit-playbook.md',
    'support/skills/codebase-improve/references/plan-template.md',
    'support/ai-delivery-kit/skills/codebase-improve/SKILL.md',
  ]) {
    const content = await fs.readFile(path.join(repoRoot, relative), 'utf8');
    assert.ok(content.length > 100, `${relative} 不应为空`);
  }
  assert.match(skillDisplayDescription('codebase-improve', 'fallback'), /全景体检.*STOP 熔断/);
});

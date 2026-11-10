import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentProfileStore, readTeamRolePrompt, validateTeamModelChoice } from '../server/agent-profiles.js';
import { defaultTeamProfileConfig, normalizeTeamAccessModes, profileConfigSchema } from '../shared/agent-team.js';
import type { AgentProvider, AgentRuntimeHealth } from '../shared/agent-runtime.js';
const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: '/fixture', version: 'test',
  authenticated: true, ready: true, message: 'fixture ready', modes: ['agent', 'ask', 'plan'], accessModes: ['workspace', 'full'],
  defaultModel: '', writable: true, checkedAt: new Date().toISOString(), models: provider === 'codex'
    ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high', 'xhigh'] }))
    : provider === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer 2.5' }]
      : [['sonnet', 'Sonnet 5.5'], ['opus', 'Opus 5.5'], ['fable', 'Fable 5.1']].map(([id, label]) => ({ id, label, efforts: ['low', 'medium', 'high'] })) });

test('岗位保存校验运行器能力、版本递增、快照隔离和陈旧版本，失败不污染已保存配置', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-profiles-'));
  const calls: string[] = [];
  try {
    const store = await createAgentProfileStore(directory, { readRuntime: async provider => { calls.push(provider); return health(provider); } });
    const frozen = store.freeze();
    const input = store.read(); input.profiles.find(item => item.id === 'engineer')!.model = 'gpt-6-astra';
    assert.equal(store.read().profiles.find(item => item.id === 'engineer')?.model, 'gpt-6.1-sol');
    const saved = await store.save({ ...input, expectedRevision: 1 });
    assert.equal(saved.revision, 2);
    assert.deepEqual(calls.sort(), ['claude', 'codex', 'cursor']);
    assert.equal(frozen.revision, 1);
    assert.equal(frozen.profiles.find(item => item.id === 'engineer')?.model, 'gpt-6.1-sol');
    await assert.rejects(store.save({ ...input, expectedRevision: 1 }), /已更新/);
    const unavailable = store.read(); unavailable.profiles.find(item => item.id === 'engineer')!.model = 'not-in-catalog';
    await assert.rejects(store.save({ ...unavailable, expectedRevision: 2 }), /模型目录/);
    assert.equal(store.read().revision, 2);
    const reopened = await createAgentProfileStore(directory, { readRuntime: async provider => health(provider) });
    assert.equal(reopened.read().revision, 2);
    assert.equal(reopened.read().profiles.find(item => item.id === 'engineer')?.model, 'gpt-6-astra');
    const reset = await store.reset(2);
    assert.equal(reset.revision, 3);
    assert.equal(reset.profiles.find(item => item.id === 'engineer')?.model, 'gpt-6.1-sol');
    assert.equal(profileConfigSchema.safeParse(JSON.parse(await fs.readFile(path.join(directory, 'agent-profiles.json'), 'utf8'))).success, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('岗位支持目录声明的 max 和 ultra，保存重载原样保留，目录不支持的强度仍拒绝', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-profile-efforts-'));
  const readRuntime = async (provider: AgentProvider): Promise<AgentRuntimeHealth> => {
    const value = health(provider);
    return provider === 'codex' ? { ...value, models: value.models.map(model => ({ ...model, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] })) } : value;
  };
  try {
    const store = await createAgentProfileStore(directory, { readRuntime });
    const input = store.read();
    input.profiles.find(profile => profile.id === 'leader')!.reasoningEffort = 'ultra';
    input.profiles.find(profile => profile.id === 'engineer')!.escalation!.reasoningEffort = 'max';
    const saved = await store.save({ ...input, expectedRevision: input.revision });
    const reopened = await createAgentProfileStore(directory, { readRuntime });
    assert.deepEqual(reopened.read(), saved);
    assert.equal(reopened.read().profiles.find(profile => profile.id === 'leader')!.reasoningEffort, 'ultra');
    assert.equal(reopened.read().profiles.find(profile => profile.id === 'engineer')!.escalation!.reasoningEffort, 'max');
    for (const reasoningEffort of ['max', 'ultra'] as const) {
      assert.throws(() => validateTeamModelChoice({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort }, health('codex'), 'agent'), /不支持推理强度/);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('完整 Claude ID 只能使用已确认对应别名；强度、权限和角色指令保持真实边界', async () => {
  const sonnet = defaultTeamProfileConfig().profiles.find(item => item.id === 'analyst')!;
  assert.doesNotThrow(() => validateTeamModelChoice(sonnet, health('claude'), 'ask'));
  const changedAlias = health('claude'); changedAlias.models[0].label = 'Sonnet other-version';
  assert.throws(() => validateTeamModelChoice(sonnet, changedAlias, 'ask'), /模型目录/);
  assert.throws(() => validateTeamModelChoice({ ...sonnet, model: 'invented' }, health('claude'), 'ask'), /模型目录/);
  assert.throws(() => validateTeamModelChoice({ ...sonnet, reasoningEffort: 'xhigh' }, health('claude'), 'ask'), /推理强度/);
  assert.throws(() => validateTeamModelChoice({ ...sonnet, reasoningEffort: '' }, health('claude'), 'ask'), /明确选择/);
  const withoutEfforts = health('claude'); withoutEfforts.models[0].efforts = undefined;
  assert.doesNotThrow(() => validateTeamModelChoice({ ...sonnet, reasoningEffort: '' }, withoutEfforts, 'ask'));
  assert.throws(() => validateTeamModelChoice({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: '' }, health('codex'), 'ask'), /不能继承/);
  assert.throws(() => validateTeamModelChoice(sonnet, { ...health('claude'), ready: false }, 'ask'), /未就绪/);
  for (const profile of defaultTeamProfileConfig().profiles) {
    const prompt = await readTeamRolePrompt(profile.id);
    assert.match(prompt, /推送、部署、发送消息、修改 Jira、Confluence 或其他外部系统必须有真实用户对操作、目标和范围的明确授权/);
    assert.match(prompt, /已有授权在原范围内持续有效，不重复索要/);
    assert.ok(prompt.includes(profile.id === 'second_opinion' ? '第二意见' : profile.label));
  }
  await assert.rejects(readTeamRolePrompt('../secret' as 'leader'), /未知/);
});

test('受管状态写入失败保留当前版本，损坏配置不会静默改用默认值', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-profiles-failure-'));
  try {
    let stored: unknown;
    const store = await createAgentProfileStore(directory, { readRuntime: async provider => health(provider),
      readJson: async () => { if (stored) return stored; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeJson: async () => { throw new Error('disk full'); } });
    await assert.rejects(store.save({ ...store.read(), expectedRevision: 1 }), /disk full/);
    assert.equal(store.read().revision, 1);
    stored = { revision: 2, profiles: [] };
    await assert.rejects(createAgentProfileStore(directory, { readRuntime: async provider => health(provider), readJson: async () => stored }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('全部岗位默认完整执行，旧只读配置迁移保留模型路由且不改写历史文件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-profiles-access-'));
  try {
    const current = defaultTeamProfileConfig();
    assert.ok(current.profiles.every(profile => profile.mode === 'agent' && profile.accessMode === 'full'));
    const old = structuredClone(current);
    old.profiles.find(profile => profile.id === 'analyst')!.model = 'claude-opus-5-5';
    old.profiles.find(profile => profile.id === 'analyst')!.catalogAlias = { id: 'opus', label: 'Opus 5.5' };
    for (const profile of old.profiles) if (['leader', 'analyst', 'architect', 'reviewer', 'reporter', 'second_opinion'].includes(profile.id)) {
      profile.mode = 'ask'; profile.accessMode = 'workspace';
    }
    old.profiles.find(profile => profile.id === 'reviewer')!.description = '独立只读审查需求覆盖、代码和验证证据。';
    old.profiles.find(profile => profile.id === 'reporter')!.description = '只依据已验收证据整理草稿；不发布外部系统。';
    old.profiles.find(profile => profile.id === 'second_opinion')!.description = '按用户触发提供只读第二意见，不改变流程结论。';
    const file = path.join(directory, 'agent-profiles.json'), original = JSON.stringify(old);
    await fs.writeFile(file, original);
    const store = await createAgentProfileStore(directory, { readRuntime: async provider => health(provider) });
    const migrated = store.read();
    assert.ok(migrated.profiles.every(profile => profile.mode === 'agent' && profile.accessMode === 'full'));
    assert.deepEqual(migrated.reviewRouting, old.reviewRouting);
    assert.deepEqual(migrated.profiles.map(({ provider, model, reasoningEffort, catalogAlias, escalation }) => ({ provider, model, reasoningEffort, catalogAlias, escalation })),
      old.profiles.map(({ provider, model, reasoningEffort, catalogAlias, escalation }) => ({ provider, model, reasoningEffort, catalogAlias, escalation })));
    assert.deepEqual(normalizeTeamAccessModes(migrated), migrated);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const limited = { ...health('codex'), accessModes: ['workspace'] as const };
    const choice = migrated.profiles.find(profile => profile.id === 'leader')!;
    assert.doesNotThrow(() => validateTeamModelChoice(choice, { ...limited, accessModes: [...limited.accessModes] }, 'agent', 'workspace'));
    assert.throws(() => validateTeamModelChoice(choice, { ...limited, accessModes: [...limited.accessModes] }, 'agent', 'full'), /完全访问/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

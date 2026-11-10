import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef } from 'vue';
import { QueryClient, useQuery } from '@tanstack/vue-query';
import type { GroupChatDashboard, GroupConfig, GroupMember } from '../shared/agent-group-chat.js';
import { agentProviderLabels, type AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { useAgentModelSelection } from '../src/features/agent-workbench/model-selection.js';
import { antigravityModelQuota } from '../src/features/agent-workbench/usage-quota.js';

test('群聊主模型与备用模型切换强度后保存真实ID，清理旧档位别名', () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentGroupChat.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'clearEffortAlias')!;
  const code = ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime = { provider: 'antigravity', defaultModel: 'gemini-4-argon-low', models: [
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  ] } as AgentRuntimeHealth;
  const roleDraft = ref<GroupMember>({ id: 'dev', name: '开发', instructions: '实现', capability: 'write', enabled: true,
    binding: { provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: '', catalogAlias: { id: 'old', label: '旧档位' } },
    fallbackBinding: { provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: '', catalogAlias: { id: 'old-backup', label: '旧备用档位' } } });
  const picker = (fallback: boolean) => useAgentModelSelection(() => runtime,
    computed({ get: () => (fallback ? roleDraft.value.fallbackBinding : roleDraft.value.binding)!.model,
      set: value => { (fallback ? roleDraft.value.fallbackBinding : roleDraft.value.binding)!.model = value; } }),
    computed({ get: () => (fallback ? roleDraft.value.fallbackBinding : roleDraft.value.binding)!.reasoningEffort,
      set: value => { (fallback ? roleDraft.value.fallbackBinding : roleDraft.value.binding)!.reasoningEffort = value; } }),
    { allowDefaultEffort: true });
  const modelPicker = picker(false), fallbackPicker = picker(true);
  const clear = new Function('roleDraft', 'modelPicker', 'fallbackPicker', `${code}\nreturn clearEffortAlias;`)(roleDraft, modelPicker, fallbackPicker);
  modelPicker.effort.value = 'low'; clear();
  fallbackPicker.effort.value = 'low'; clear(true);
  for (const binding of [roleDraft.value.binding!, roleDraft.value.fallbackBinding!]) {
    assert.equal(binding.model, 'gemini-4-argon-low');
    assert.equal(binding.reasoningEffort, '');
    assert.equal(binding.catalogAlias, undefined);
  }
});

/** 执行实际 SFC 展示与保存函数；查询回读保持未完成，以验证保存回执立即生效。 */
function rosterFixture(automatic = false) {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentGroupChat.ts', source, ts.ScriptTarget.Latest, true);
  const variables = ['dashboard', 'config', 'members', 'quotaProviders'];
  const functions = ['memberTurn', 'memberBinding', 'backupModel', 'memberUsage', 'refresh', 'persistConfig', 'modelText'];
  const pieces = tree.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
      .filter(declaration => variables.includes(declaration.name.getText(tree)))
      .map(declaration => `const ${declaration.getText(tree)};`);
    if (ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text || '')) return [statement.getText(tree)];
    return [];
  });
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const member: GroupMember = { id: 'frontend', name: '前端开发', instructions: '实现界面', capability: 'write', enabled: true,
    binding: { provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: '' },
    fallbackBinding: { provider: 'cursor', model: 'grok-4.7-xhigh', reasoningEffort: '' } };
  const historicalMember = { ...structuredClone(member), fallbackBinding: { provider: 'cursor', model: 'claude-opus-5-5-high', reasoningEffort: '' } };
  const room = ref({ orchestration: automatic ? 'automatic' : 'sequential', rounds: [{ id: 'old-round', state: 'completed', turns: [{
    id: 'old-turn', member: historicalMember, status: 'completed', runId: 'old-run', executionBinding: historicalMember.fallbackBinding,
  }] }] });
  const originalHistory = JSON.parse(JSON.stringify(room.value));
  const scope = ['agent-group-chat'];
  const initial: GroupChatDashboard = { config: { revision: 3, name: '研发团队', members: [member] }, rooms: [],
    fallbackChoices: { frontend: [{ provider: 'codex', model: 'system-fallback', reasoningEffort: 'high' }] } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(scope, initial);
  const props = reactive({ quotas: { cursor: { available: true, checkedAt: 'now', primary: { remainingPercent: 11 } } },
    antigravityUsage: { available: true, checkedAt: 'now', groups: [{ name: 'Gemini Models', buckets: [
      { id: 'gemini-week', name: 'week', window: 'weekly', remainingPercent: 64, resetsAt: null },
    ] }] } });
  const saved: GroupConfig[] = [], errors: string[] = [];
  const reads: { resolve: (value: GroupChatDashboard) => void; signal?: AbortSignal }[] = [];
  const globalChanging = shallowRef('');
  const bindings = { computed, room, props, client, scope, globalChanging, active: shallowRef(true), restarting: shallowRef(false),
    agentProviderLabels, antigravityModelQuota,
    useQuery: (options: Parameters<typeof useQuery>[0]) => useQuery(options, client),
    readGroupDashboard: (signal?: AbortSignal) => new Promise<GroupChatDashboard>(resolve => reads.push({ resolve, signal })),
    saveGroupConfig: async (value: GroupConfig) => { saved.push(structuredClone(value)); return { ...structuredClone(value), revision: value.revision + 1 }; },
    runFor: () => ({ provider: 'cursor', model: 'claude-opus-5-5-high' }),
    ElMessage: { error: (message: string) => errors.push(message) } };
  const lifetime = effectScope();
  const state = lifetime.run(() => new Function(...Object.keys(bindings), `${code}\nreturn { dashboard, members, quotaProviders, memberBinding, memberUsage, backupModel, persistConfig, modelText };`)
    (...Object.values(bindings)))!;
  return { state, member, room, originalHistory, props, client, scope, globalChanging, saved, reads, errors,
    close() { lifetime.stop(); client.clear(); } };
}

test('成员卡片与编辑配置同源，历史执行及系统兜底不覆盖主模型、备用或额度', () => {
  for (const automatic of [false, true]) {
    const f = rosterFixture(automatic);
    try {
      const member = f.state.members.value[0];
      assert.deepEqual(f.state.memberBinding(member), f.member.binding);
      assert.equal(f.state.backupModel(member), 'grok-4.7-xhigh');
      assert.equal(f.state.memberUsage(member).primary.remainingPercent, 64);
      assert.deepEqual(f.state.quotaProviders.value, ['antigravity']);
      assert.equal(f.state.modelText(f.room.value.rounds[0].turns[0]), `${agentProviderLabels.cursor} · claude-opus-5-5-high`);
      assert.deepEqual(JSON.parse(JSON.stringify(f.room.value)), f.originalHistory, '配置展示不能改写历史实际运行');
    } finally { f.close(); }
  }
});

test('配置保存回执立即更新主备模型与额度来源，不等待轮询且保留历史记录', async () => {
  const f = rosterFixture(true);
  try {
    const next: GroupConfig = { revision: 3, name: '研发团队', members: [{ ...structuredClone(f.member),
      binding: { provider: 'cursor', model: 'grok-4.7-xhigh', reasoningEffort: '' },
      fallbackBinding: { provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: '' } }] };
    assert.equal(await f.state.persistConfig(next), true);
    await nextTick();
    assert.equal(f.reads.length, 1, '保存后触发回读，但本测试尚未返回查询结果');
    assert.equal(f.client.getQueryData<GroupChatDashboard>(f.scope)!.config.revision, 4);
    const member = f.state.members.value[0];
    assert.deepEqual(f.state.memberBinding(member), next.members[0].binding);
    assert.equal(f.state.backupModel(member), 'gemini-4-argon-high');
    assert.deepEqual(f.state.quotaProviders.value, ['cursor']);
    assert.equal(f.state.memberUsage(member).primary.remainingPercent, 11);
    f.props.quotas.cursor.primary.remainingPercent = 73;
    assert.equal(f.state.memberUsage(member).primary.remainingPercent, 73, '额度响应更新使用当前配置的提供方');
    assert.deepEqual(f.saved, [next]); assert.equal(f.globalChanging.value, ''); assert.deepEqual(f.errors, []);
    assert.deepEqual(JSON.parse(JSON.stringify(f.room.value)), f.originalHistory);
  } finally { f.close(); }
});

test('未配置或关闭备用时不展示历史备用和系统候选，当前主模型也可清空', async () => {
  const f = rosterFixture(true);
  try {
    for (const fallbackBinding of [null, undefined]) {
      const next = { ...f.client.getQueryData<GroupChatDashboard>(f.scope)!, config: {
        revision: 4, name: '研发团队', members: [{ ...structuredClone(f.member), fallbackBinding }],
      } };
      f.client.setQueryData(f.scope, next); await nextTick();
      assert.equal(f.state.backupModel(f.state.members.value[0]), undefined);
      f.room.value.orchestration = 'sequential';
      assert.equal(f.state.backupModel(f.state.members.value[0]), undefined, '顺序群聊也不把系统兜底冒充已配置备用');
      f.room.value.orchestration = 'automatic';
    }
    const cleared: GroupMember = { ...f.member, binding: undefined, fallbackBinding: null };
    assert.equal(f.state.memberBinding(cleared), undefined);
    assert.equal(f.state.memberUsage(cleared), undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(f.room.value)), f.originalHistory);
  } finally { f.close(); }
});

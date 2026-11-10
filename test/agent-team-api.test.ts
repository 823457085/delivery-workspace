import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamTask, createTeamTaskAtWorkspace, createTeamDraft, readTeamArtifact, readTeamDraft, readTeamProfiles, readTeamRoom, readTeamTasks, requestSecondOpinion, resumeTeamEvaluation,
  saveTeamProfiles, decideTeamTask, teamRoomAcceptanceRecord, type TeamRoom } from '../src/features/agent-workbench/team-api.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { teamRoleLabels } from '../src/features/agent-workbench/team-chat.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, readonly, ref, shallowRef, toRaw, watch } from 'vue';
import { profileConfigSchema, teamModelChoiceSchema, teamProfile, type TeamProfileConfig } from '../shared/agent-team.js';

test('高级团队客户端保留独立接口、请求幂等键、取消信号和接口原文错误，不自动重发写操作', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  const controller = new AbortController();
  let value: unknown = { tasks: [] }, status = 200;
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); };
  try {
    assert.deepEqual(await readTeamTasks(controller.signal), []);
    assert.equal(requests[0].url, '/api/agent-runtimes/team-tasks');
    assert.equal(requests[0].init?.signal, controller.signal);
    assert.equal(requests[0].init?.method, 'GET');
    value = { kind: 'tests', hash: 'hash-1', content: 'L987654\n原文日志', truncated: true };
    assert.deepEqual(await readTeamArtifact('task/1', 'log?1', controller.signal), value);
    assert.equal(requests.at(-1)?.url, '/api/agent-runtimes/team-tasks/task%2F1/artifacts/log%3F1');
    assert.equal(requests.at(-1)?.init?.method, 'GET');
    assert.equal(requests.at(-1)?.init?.body, undefined);
    assert.equal(requests.at(-1)?.init?.signal, controller.signal);
    value = { task: { id: 'task-1' } };
    assert.equal((await createTeamTask('run/1', { objective: '修改计算', attachmentIds: ['file-1'], requestId: 'request-1' })).id, 'task-1');
    const sent = requests.at(-1)!;
    assert.equal(sent.url, '/api/agent-runtimes/runs/run%2F1/team-task');
    assert.equal((sent.init?.headers as Record<string, string>)['X-Delivery-Confirmed'], 'yes');
    assert.deepEqual(JSON.parse(sent.init!.body as string), { objective: '修改计算', attachmentIds: ['file-1'], requestId: 'request-1' });
    value = defaultTeamProfileConfig();
    assert.equal((await readTeamProfiles()).config.revision, 1);
    await saveTeamProfiles(value as ReturnType<typeof defaultTeamProfileConfig>);
    assert.equal(JSON.parse(requests.at(-1)!.init!.body as string).expectedRevision, 1);
    await decideTeamTask('task-1', { action: 'retry_review_codex', nodeId: 'review-1', requestId: 'codex-review-1' });
    assert.equal(requests.at(-1)?.url, '/api/agent-runtimes/team-tasks/task-1/decision');
    assert.deepEqual(JSON.parse(requests.at(-1)!.init!.body as string), { action: 'retry_review_codex', nodeId: 'review-1', requestId: 'codex-review-1' });
    value = { message: 'L987654' }; status = 409;
    const count = requests.length;
    await assert.rejects(readTeamRoom('task-1'), error => (error as Error).message === 'L987654');
    assert.equal(requests.length, count + 1);
  } finally { globalThis.fetch = original; }
});

test('新会话从项目创建计划、空草稿与现有交接链接、人工评测恢复的客户端契约', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  let value: unknown = { id: 'created-from-workspace' };
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return new Response(JSON.stringify(value), { status: 200 }); };
  try {
    const input = { objective: '直接规划', workspacePath: '/project', attachmentIds: ['file-1'], requestId: 'request-2' };
    assert.equal((await createTeamTaskAtWorkspace(input)).id, 'created-from-workspace');
    assert.equal(requests.at(-1)?.url, '/api/agent-runtimes/team-tasks');
    assert.deepEqual(JSON.parse(requests.at(-1)!.init!.body as string), input);
    value = { revision: 0, text: '' };
    assert.equal(await readTeamDraft('task-1'), null);
    value = { revision: 2, text: '草稿', jiraHandoff: { path: '/agent?view=jira-fix', recordId: 'fix-1', requiresConfirmation: true } };
    assert.equal((await readTeamDraft('task-1'))?.jiraHandoffUrl, '/agent?view=jira-fix');
    await createTeamDraft('task-1', 'draft-request');
    assert.deepEqual(JSON.parse(requests.at(-1)!.init!.body as string), { requestId: 'draft-request' });
    value = { id: 'opinion-1', taskId: 'task-1', text: 'L765432', createdAt: '2026-10-26T10:00:00Z', readOnly: true };
    assert.equal((await requestSecondOpinion('task-1', 'opinion-request')).text, 'L765432');
    assert.deepEqual(JSON.parse(requests.at(-1)!.init!.body as string), { requestId: 'opinion-request' });
    value = { id: 'evaluation-1', status: 'running' };
    await resumeTeamEvaluation('evaluation-1');
    assert.equal(requests.at(-1)?.url, '/api/agent-runtimes/agent-evaluations/evaluation-1/resume');
    assert.deepEqual(JSON.parse(requests.at(-1)!.init!.body as string), { confirmedResume: true });
  } finally { globalThis.fetch = original; }
});

test('团队验收来源兼容诊断与方案，缺少验证岗位时不会自动预填通过', () => {
  const timestamp = '2026-10-26T10:00:00.000Z';
  const task: TeamRoom['task'] = { id: 'task-1', parentConversationId: 'parent-1', sourceWorkspacePath: '/project', objective: '诊断', attachmentIds: [],
    profileConfig: defaultTeamProfileConfig(), planRevision: 1, nodes: [], state: 'awaiting_acceptance', round: 0, maxRounds: 2,
    createdAt: timestamp, updatedAt: '2026-10-26T11:00:00.000Z', candidateEvidenceAt: timestamp,
    budgetLimit: 10, reverifyCount: 0, requestIds: {}, upgradedProfiles: [] };
  const evidence = { ...emptyDeliveryEvidence(), tests: { status: 'passed' as const, evidence: '不应当用于无验证岗位的预填', sha: '' } };
  const room: TeamRoom = { task, messages: [], events: [], runs: [], stale: false, evidence };
  for (const stage of ['analyst', 'architect', 'diagnose', 'implement'] as const) {
    task.nodes.push({ id: `node-${stage}`, stage, profileId: stage === 'diagnose' || stage === 'implement' ? 'engineer' : stage,
      status: 'completed', dependencies: [], attempt: 1, round: 0, runId: `run-${stage}`, createdAt: timestamp, updatedAt: timestamp });
    const record = teamRoomAcceptanceRecord(room)!;
    assert.equal(record.runId, `run-${stage}`);
    assert.equal(record.updatedAt, timestamp, '来源必须使用候选证据时间');
    assert.equal(record.reportedEvidence, undefined, '无验证岗位时不采信模型自报证据');
    assert.equal(record.workflowActive, false);
  }
  task.nodes.push({ id: 'node-verify', stage: 'verify', profileId: 'verifier', status: 'completed', dependencies: [], attempt: 1,
    round: 0, runId: 'run-verify', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(teamRoomAcceptanceRecord(room)?.reportedEvidence, evidence);
  const report = (taskResult: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, taskResult })}\n\`\`\``;
  task.nodes.find(node => node.stage === 'implement')!.result = report({ role: 'implementer', status: 'succeeded', summary: 'L123456 原始交付摘要' });
  task.nodes.at(-1)!.result = report({ role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '核验日志退出 0' }] });
  task.nodes.push({ id: 'node-review', stage: 'review', profileId: 'reviewer', status: 'completed', dependencies: [], attempt: 1,
    round: 0, runId: 'run-review', createdAt: timestamp, updatedAt: timestamp,
    result: report({ role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '仅固定候选通过，业务部署未验证' }) });
  assert.equal(teamRoomAcceptanceRecord(room)?.acceptanceOverview?.summary, 'L123456 原始交付摘要');
  assert.deepEqual(teamRoomAcceptanceRecord(room)?.acceptanceOverview?.reviews, ['仅固定候选通过，业务部署未验证']);
  task.plan = { templateId: 'engineering', reason: '复审', risk: 'low', acceptanceCriteria: [
    { id: 'AC-3', text: '正式复审', source: '用户', stage: 'review' },
  ], allowedPaths: [], needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] };
  assert.equal(teamRoomAcceptanceRecord(room)?.acceptanceOverview?.criteria[0].status, 'not_run');
  task.nodes.at(-1)!.result = report({ role: 'reviewer', status: 'succeeded', verdict: 'approved', acceptance: [
    { id: 'AC-3', status: 'passed', evidence: 'L123456 独立复审核验日志' },
  ] });
  assert.deepEqual(teamRoomAcceptanceRecord(room)?.acceptanceOverview?.criteria[0], {
    id: 'AC-3', text: '正式复审', status: 'passed', evidence: 'L123456 独立复审核验日志',
  });
  task.round = 1;
  assert.equal(teamRoomAcceptanceRecord(room)?.reportedEvidence, undefined, '旧轮验证不能带入新轮');
  assert.deepEqual(teamRoomAcceptanceRecord(room)?.acceptanceOverview?.reviews, []);
  task.round = 0;
  task.legacy = true; task.legacyAcceptanceRecordId = 'agent:original-conversation';
  assert.equal(teamRoomAcceptanceRecord(room)?.id, 'agent:original-conversation', 'V1 沿用已有人工验收，不生成第二条记录');
  room.stale = true;
  assert.equal(teamRoomAcceptanceRecord(room)?.workflowActive, true);
  assert.equal(teamRoomAcceptanceRecord(room)?.reportedEvidence, undefined);
  assert.equal(teamRoomAcceptanceRecord(room)?.acceptanceOverview, undefined);
  task.candidateEvidenceAt = undefined;
  assert.equal(teamRoomAcceptanceRecord(room), undefined);
});

// 执行 SFC 中真实的 watcher 与异步回调，复现跨任务草稿和产物竞态，不复制一份实现。
const teamCenterSource = readFileSync(new URL('../src/features/agent-workbench/AgentTeamCenter.vue', import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
const teamCenterTree = ts.createSourceFile('AgentTeamCenter.ts', teamCenterSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const testedFunctions = new Set(['choiceOf', 'run', 'saveDraft', 'saveProfiles', 'closeArtifact', 'previewArtifact']);
const teamCenterCode = ts.transpileModule(teamCenterTree.statements.filter(node =>
  ts.isFunctionDeclaration(node) && testedFunctions.has(node.name?.text || '')
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['artifactRequest', 'artifactVisible', 'plannedRoles'].includes(item.name.getText(teamCenterTree)))
  || ts.isExpressionStatement(node) && ['watch(selectedId,', 'watch(draftQuery.data,', 'watch(profilesQuery.data,'].some(prefix => node.getText(teamCenterTree).startsWith(prefix))
).map(node => node.getText(teamCenterTree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function teamCenterFixture() {
  const selectedId = ref('a'), task = shallowRef({ id: 'a', profileConfig: defaultTeamProfileConfig(), legacy: false });
  const currentPlan = shallowRef({ templateId: 'engineering', needsAnalyst: false, needsArchitect: false });
  const draftText = ref(''), draftRevision = ref(0), draftDirty = ref(false), data = shallowRef<unknown>(null);
  const saving: { id: string; revision: number; text: string; resolve: () => void }[] = [];
  const artifacts: { id: string; artifactId: string; signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  const errors: unknown[] = [], scope = effectScope();
  const profilesData = ref<{ config: TeamProfileConfig; instructions: object }>(), profileDraft = ref(defaultTeamProfileConfig()), profileDirty = ref(false),
    routingText = ref(''), savedProfiles: TeamProfileConfig[] = [];
  const dependencies = { ref, shallowRef, computed, watch, toRaw, AbortController, profileConfigSchema, teamModelChoiceSchema, teamProfile, teamRoleLabels, selectedId, task, currentPlan,
    draftText, draftRevision, draftDirty, draftQuery: { data }, planDirty: ref(false), planAnswers: ref({}), messageAnswers: ref({}), planText: ref(''),
    profilesQuery: { data: readonly(profilesData) }, profileDraft, profileDirty, routingText,
    changing: ref(''), ids: new Map(), client: { invalidateQueries: async () => {
      const saved = savedProfiles.at(-1);
      if (saved) profilesData.value = { config: { ...saved, revision: saved.revision + 1 }, instructions: {} };
    } }, scope: [], ElMessage: { error: (error: unknown) => errors.push(error), success: () => {} },
    saveTeamProfiles: async (config: TeamProfileConfig) => { savedProfiles.push(profileConfigSchema.parse(config)); },
    saveTeamDraft: (id: string, revision: number, text: string) => new Promise<void>(resolve => saving.push({ id, revision, text, resolve })),
    readTeamArtifact: (id: string, artifactId: string, signal: AbortSignal) => new Promise(resolve => artifacts.push({ id, artifactId, signal, resolve })) };
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${teamCenterCode}\nreturn { saveDraft, saveProfiles, plannedRoles, previewArtifact, artifactVisible, artifactContent, artifactLoading };`)(...Object.values(dependencies))) as {
    saveProfiles: () => Promise<void>;
    saveDraft: () => Promise<void>; plannedRoles: { value: { stage: string; profileId: string; choice: { model: string; reasoningEffort: string } }[] };
    previewArtifact: (id: string) => Promise<void>; artifactVisible: { value: boolean }; artifactContent: { value: unknown }; artifactLoading: { value: boolean };
  };
  return { state, selectedId, task, currentPlan, draftText, draftRevision, draftDirty, data, saving, artifacts, errors,
    profilesData, profileDraft, profileDirty, routingText, savedProfiles, close: () => scope.stop() };
}

test('真实团队组件读取只读查询代理和保存可写代理配置，保留路由并回读新revision', async () => {
  for (const wrap of [reactive, <T extends object>(value: T) => readonly(reactive(value))]) {
    const f = teamCenterFixture();
    try {
      const config = { ...defaultTeamProfileConfig(), revision: 9 };
      f.profilesData.value = wrap({ config, instructions: {} }) as typeof f.profilesData.value;
      await nextTick();
      assert.deepEqual(JSON.parse(f.routingText.value), config.reviewRouting);
      assert.equal(f.profileDraft.value.revision, 9);
      f.profileDraft.value.profiles.find(item => item.id === 'engineer')!.model = 'gpt-6-astra';
      f.profileDirty.value = true;
      await f.state.saveProfiles(); await nextTick();
      assert.deepEqual(f.errors, [], 'Vue readonly/reactive代理不能触发DataCloneError');
      assert.equal(f.savedProfiles.length, 1);
      assert.equal(f.savedProfiles[0].revision, 9);
      assert.equal(f.savedProfiles[0].profiles.find(item => item.id === 'engineer')?.model, 'gpt-6-astra');
      assert.equal(config.profiles.find(item => item.id === 'engineer')?.model, 'gpt-6.1-sol', '编辑副本不修改只读查询快照');
      assert.equal(f.profileDraft.value.revision, 10);
      assert.equal(f.profileDirty.value, false);
    } finally { f.close(); }
  }
});

test('真实团队组件切换到空草稿时清除上个任务内容，旧保存回执不清除新任务编辑', async () => {
  const f = teamCenterFixture();
  try {
    f.data.value = { text: 'A 的草稿', revision: 3 }; await nextTick();
    assert.equal(f.draftText.value, 'A 的草稿');
    f.draftDirty.value = true;
    const saving = f.state.saveDraft();
    assert.deepEqual({ id: f.saving[0].id, revision: f.saving[0].revision, text: f.saving[0].text }, { id: 'a', revision: 3, text: 'A 的草稿' });
    f.selectedId.value = 'b'; f.task.value = { ...f.task.value, id: 'b' };
    assert.equal(f.draftText.value, '', '切换当下立即清除旧内容');
    assert.equal(f.draftRevision.value, 0);
    f.data.value = null; await nextTick();
    assert.equal(f.draftText.value, '');
    f.data.value = { text: 'B 的草稿', revision: 7 }; await nextTick();
    f.draftText.value = 'B 的未保存编辑'; f.draftDirty.value = true;
    f.saving[0].resolve(); await saving;
    assert.equal(f.draftDirty.value, true);
    f.data.value = { text: 'B 的后台版本', revision: 7 }; await nextTick();
    assert.equal(f.draftText.value, 'B 的未保存编辑', '旧任务保存后的重读不能覆盖新任务草稿');
    f.draftDirty.value = false; f.data.value = null; await nextTick();
    assert.equal(f.draftText.value, ''); assert.equal(f.draftRevision.value, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('真实团队组件产物切换取消旧请求，晚到结果不能覆盖新任务预览', async () => {
  const f = teamCenterFixture();
  try {
    const first = f.state.previewArtifact('artifact-a');
    f.selectedId.value = 'b'; f.task.value = { ...f.task.value, id: 'b' };
    assert.equal(f.artifacts[0].signal.aborted, true);
    assert.equal(f.state.artifactVisible.value, false);
    const second = f.state.previewArtifact('artifact-b');
    const content = { kind: 'verify', hash: 'hash-b', content: 'B 的原文', truncated: false };
    f.artifacts[1].resolve(content); await second;
    f.artifacts[0].resolve({ ...content, content: 'A 的晚到内容' }); await first;
    assert.deepEqual(f.state.artifactContent.value, content);
    assert.equal(f.state.artifactVisible.value, true);
    assert.equal(f.state.artifactLoading.value, false);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('计划确认前展示任务冻结模型与按作者的审查路由，后续全局设置不会混入', () => {
  const f = teamCenterFixture();
  try {
    f.task.value.profileConfig.profiles.find(item => item.id === 'engineer')!.model = 'frozen-engineer-model';
    assert.deepEqual(f.state.plannedRoles.value.map(item => item.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.equal(f.state.plannedRoles.value.find(item => item.profileId === 'engineer')?.choice.model, 'frozen-engineer-model');
    assert.equal(f.state.plannedRoles.value.at(-1)?.choice.model, f.task.value.profileConfig.reviewRouting.codex.model);
    f.currentPlan.value = { templateId: 'complex_delivery_parallel', needsAnalyst: false, needsArchitect: false };
    assert.deepEqual(f.state.plannedRoles.value.filter(item => item.profileId === 'reviewer').map(item => item.choice.model),
      [f.task.value.profileConfig.reviewRouting.codex.model, f.task.value.profileConfig.reviewRouting.claude.model]);
    f.currentPlan.value = { templateId: 'diagnosis', needsAnalyst: false, needsArchitect: false };
    assert.deepEqual(f.state.plannedRoles.value.map(item => item.profileId), ['leader', 'engineer']);
    f.task.value = { ...f.task.value, legacy: true };
    assert.deepEqual(f.state.plannedRoles.value, [], '不把新配置推导成 V1 历史模型');
  } finally { f.close(); }
});

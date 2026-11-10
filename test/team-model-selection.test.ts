import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import { allowedEffortsForModel, buildModelChoice, teamModelPresentation, teamProviderLabels } from '../src/features/agent-workbench/team-role-settings.js';
import { modelSelectionChoices, selectModelChoice, selectModelEffort } from '../src/features/agent-workbench/model-selection.js';

const runtimes = [
  { provider: 'antigravity', ready: true, defaultModel: 'gemini-4-argon-medium', models: [
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
    { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ] },
  { provider: 'cursor', ready: true, defaultModel: 'grok-high', models: [
    { id: 'grok-low', label: 'grok-low' }, { id: 'grok-high', label: 'grok-high' },
    { id: 'grok-low-fast', label: 'grok-low-fast' }, { id: 'grok-high-fast', label: 'grok-high-fast' },
  ] },
  { provider: 'codex', ready: true, defaultModel: 'gpt-6.1-sol', models: [
    { id: 'gpt-6.1-sol', label: 'Sol', efforts: ['low', 'high', 'xhigh', 'max', 'ultra'] },
  ] },
  { provider: 'claude', ready: true, defaultModel: 'sonnet', models: [
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'haiku', label: 'Haiku 5.5' },
  ] },
] as AgentRuntimeHealth[];

const source = readFileSync(new URL('../src/features/agent-workbench/AgentTeamCenter.vue', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AgentTeamCenter.ts', source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['efforts', 'roleModelKey', 'roleModelGroups', 'changeRoleModel', 'changeRoleEffort'];
const code = ts.transpileModule(tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''))
  .map(node => node.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('岗位真实选择动作将模型分组与强度映射回原始ID，并保留用户Medium与Claude选择', () => {
  let saves = 0;
  const bindings = { props: { runtimes }, teamModelPresentation, modelSelectionChoices, selectModelChoice, selectModelEffort,
    buildModelChoice, teamProviderLabels, syncReviewer: () => {}, scheduleAutoSave: () => { saves += 1; } };
  const state = new Function(...Object.keys(bindings), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(bindings));
  const profile = { ...defaultTeamProfileConfig().profiles[0], provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: '' };
  assert.equal(state.roleModelKey(profile), 'antigravity:gemini-4-argon-medium');
  assert.deepEqual(state.roleModelGroups(profile).find((group: { provider: string }) => group.provider === 'antigravity').options.map((item: { label: string }) => item.label),
    ['Gemini 4 Argon', 'Claude Opus 5.5']);
  state.changeRoleEffort(profile, 'medium');
  assert.equal(profile.model, 'gemini-4-argon-medium'); assert.equal(profile.reasoningEffort, '');
  state.changeRoleModel(profile, 'antigravity:claude-opus-5-5-low');
  assert.equal(profile.model, 'claude-opus-5-5-medium');
  state.changeRoleEffort(profile, 'high');
  assert.equal(profile.model, 'claude-opus-5-5-high'); assert.equal(profile.reasoningEffort, '');
  state.changeRoleModel(profile, 'cursor:grok-low-fast');
  state.changeRoleEffort(profile, 'low');
  assert.equal(profile.model, 'grok-low-fast'); assert.equal(profile.reasoningEffort, '');
  state.changeRoleModel(profile, 'codex:gpt-6.1-sol');
  assert.equal(profile.reasoningEffort, 'high');
  state.changeRoleEffort(profile, 'xhigh');
  assert.equal(profile.reasoningEffort, 'xhigh');
  state.changeRoleEffort(profile, 'ultra');
  assert.equal(profile.reasoningEffort, 'ultra');
  state.changeRoleModel(profile, 'codex:gpt-6.1-sol');
  assert.equal(profile.reasoningEffort, 'ultra', '重选同执行器支持的模型保留用户最高强度');
  state.changeRoleEffort(profile, 'max');
  assert.equal(profile.reasoningEffort, 'max');
  state.changeRoleModel(profile, 'codex:gpt-6.1-sol');
  assert.equal(profile.reasoningEffort, 'max');
  assert.equal(saves, 11);
  assert.doesNotMatch(source, /autoMigratedRevision|void restoreProfiles\(true\)/);
});

test('岗位模型回读保持alias与真实目录能力，名单展示包含嵌入强度', () => {
  const profile = defaultTeamProfileConfig().profiles.find(item => item.id === 'frontend')!;
  const before = structuredClone(profile);
  const presentation = teamModelPresentation(runtimes, profile);
  assert.equal(presentation.id, 'sonnet'); assert.equal(presentation.label, 'Sonnet 5.5'); assert.equal(presentation.effort, 'high');
  assert.deepEqual(profile, before);
  assert.deepEqual(allowedEffortsForModel(runtimes, 'claude', 'haiku'), []);
  assert.deepEqual(allowedEffortsForModel(runtimes, 'codex', 'gpt-6.1-sol'), ['low', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(allowedEffortsForModel(runtimes, 'claude', 'claude-sonnet-5-5'), ['low', 'medium', 'high', 'max']);
  assert.equal(teamModelPresentation(runtimes, { provider: 'antigravity', model: 'gemini-4-argon-low', reasoningEffort: '' }).effort, 'low');
});

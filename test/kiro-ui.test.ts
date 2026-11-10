import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTeamProfileConfig, profileConfigSchema, teamModelChoiceSchema } from '../shared/agent-team.js';
import { reviewChoiceFor } from '../shared/agent-roles.js';
import { jiraDevRuntimeSchema } from '../shared/jira-dev.js';
import { workbenchRuntime, type AgentRun, type AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { executionEntries } from '../src/features/auto-delivery/execution-entries.js';

test('旧团队配置补齐 Kiro 审查路由，保留原岗位和已有路由', () => {
  const original = defaultTeamProfileConfig();
  const { kiro: _kiro, ...legacyRouting } = original.reviewRouting;
  const restored = profileConfigSchema.parse({ ...original, reviewRouting: legacyRouting });
  assert.deepEqual(restored.profiles, original.profiles);
  assert.deepEqual(restored.reviewRouting, { ...legacyRouting, kiro: reviewChoiceFor('kiro') });
  assert.equal(restored.reviewRouting.kiro.provider, 'codex');
  const selfReview = { ...restored, reviewRouting: { ...restored.reviewRouting, kiro: { provider: 'kiro', model: 'auto', reasoningEffort: '' } } };
  assert.equal(profileConfigSchema.safeParse(selfReview).success, false);
});

test('Kiro 选择保持运行器实际模型和权限，不继承 Codex 默认能力', () => {
  const runtime: AgentRuntimeHealth = { provider: 'kiro', label: 'Kiro CLI', binary: '/fixture/kiro-cli',
    version: 'fixture', authenticated: true, ready: true, message: 'fixture', modes: ['ask'],
    accessModes: ['workspace'], models: [{ id: 'auto', label: 'Auto' }], defaultModel: 'auto',
    writable: false, checkedAt: new Date().toISOString() };
  assert.equal(workbenchRuntime(runtime), runtime);
  assert.deepEqual(jiraDevRuntimeSchema.parse({ provider: 'kiro', model: 'auto', accessMode: 'workspace' }),
    { provider: 'kiro', model: 'auto', accessMode: 'workspace', reasoningEffort: '' });
  assert.equal(teamModelChoiceSchema.safeParse({ provider: 'kiro', model: 'auto', reasoningEffort: '' }).success, true);
});

test('自动交付执行列表识别 Kiro 的历史与当前运行', () => {
  const run = { id: 'kiro-run', provider: 'kiro', objective: '检查接入', status: 'completed', workspacePath: '/fixture',
    branch: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:01:00Z', result: '完成', error: '' } as AgentRun;
  assert.equal(executionEntries([run], [])[0]?.source, 'Kiro CLI');
});

import { effectScope, shallowRef } from 'vue';
import { setTimeout as delay } from 'node:timers/promises';
import { ElMessage } from 'element-plus';
import { useAgentAttachments } from '../src/features/agent-workbench/useAgentAttachments.js';
import type { AgentAttachment } from '../shared/agent-runtime.js';

test('图片选择、粘贴、拖入和普通文件使用相同附件上传链路，不按 Kiro 禁用图片', async t => {
  const scope = effectScope();
  t.after(() => scope.stop());
  const originalReader = globalThis.FileReader;
  globalThis.FileReader = class {
    result = 'data:image/png;base64,dGV4dA==';
    onload?: () => void;
    readAsDataURL() { queueMicrotask(() => this.onload?.()); }
  } as unknown as typeof FileReader;
  t.after(() => { globalThis.FileReader = originalReader; });
  const attachments = shallowRef<AgentAttachment[]>([]);
  let uploads = 0;
  const requests = t.mock.method(globalThis, 'fetch', async (_path: string, options?: RequestInit) => {
    const value = JSON.parse(String(options?.body));
    uploads++;
    return { ok: true, json: async () => ({ id: `attachment-${uploads}`, name: value.name,
      mimeType: value.mimeType, size: 4, url: `/attachment/${uploads}` }) } as Response;
  });
  const warning = t.mock.method(ElMessage, 'warning', () => ({ close() {} }));
  const editor = scope.run(() => useAgentAttachments(attachments, () => false))!;
  const image = { name: '截图.png', type: 'image/png', size: 4 } as File;
  assert.equal(editor.canAdd.value, true);
  await editor.addFiles([image]);
  for (let i = 0; i < 2; i++) {
    const transfer = { prevented: false, preventDefault() { this.prevented = true; } };
    editor.fromTransfer({ files: [image] } as unknown as DataTransfer, transfer as unknown as Event);
    for (let j = 0; j < 50 && editor.pending.value; j++) await delay(1);
    assert.equal(transfer.prevented, true);
    assert.equal(editor.pending.value, false);
  }
  await editor.addFiles([{ name: '说明.txt', type: 'text/plain', size: 4 } as File]);
  assert.equal(requests.mock.calls.length, 4);
  assert.equal(warning.mock.calls.length, 0);
  assert.deepEqual(attachments.value.map(item => item.mimeType), ['image/png', 'image/png', 'image/png', 'text/plain']);
});

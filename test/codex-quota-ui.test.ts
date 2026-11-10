import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { AgentUsageLimits } from '../shared/agent-runtime.js';

test('Codex 额度详情区分历史额度、实时额度和查询失败', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'error' });
  try {
    const { default: Quota } = await server.ssrLoadModule('/src/features/agent-workbench/AgentUsageQuota.vue');
    const usage: AgentUsageLimits = { available: true, stale: true, checkedAt: '2026-11-08T15:45:00Z',
      lastSuccessAt: '2026-11-08T15:44:00Z', errorKind: 'timeout', message: 'Codex 额度读取超时',
      primary: { remainingPercent: 0, usedPercent: 100, windowDurationMins: 10080, resetsAt: 1794379397 },
      credits: { hasCredits: true, balance: 1234 } };
    const render = (value: AgentUsageLimits) => renderToString(createSSRApp({ render: () => h(Quota, { usage: value, label: 'Codex CLI' }) }));
    const stale = await render(usage);
    assert.match(stale, /上次剩余 0%/);
    assert.match(stale, /上次额度 1,234/);
    assert.match(stale, /Codex 额度读取超时；上次成功读取：/);
    assert.match(stale, /上次记录的重置时间/);
    assert.doesNotMatch(stale, /额度已用尽|可用额度|用量来源：额度/);
    const fresh = await render({ ...usage, stale: false, errorKind: undefined, message: undefined, credits: undefined });
    assert.match(fresh, /额度已用尽/);
    assert.doesNotMatch(fresh, /上次|读取超时/);
    const missing = await render({ available: false, checkedAt: usage.checkedAt, errorKind: 'timeout', message: 'Codex 额度读取超时' });
    assert.match(missing, /读取超时/);
    assert.doesNotMatch(missing, /usage-track|剩余 0%/);
  } finally { await server.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { AntigravityUsageLimits } from '../shared/agent-runtime.js';

test('额度详情将缓存值明确标为上次，并展示读取失败原因和成功时间', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'error' });
  try {
    const { default: Quota } = await server.ssrLoadModule('/src/features/agent-workbench/AgentAntigravityQuota.vue');
    const usage: AntigravityUsageLimits = { available: true, stale: true, checkedAt: '2026-11-06T03:00:00Z',
      lastSuccessAt: '2026-11-06T03:00:00Z', errorKind: 'timeout', message: 'Antigravity 额度读取超时，正在重试。', groups: [
        { name: 'Gemini Models', buckets: [{ id: 'weekly', name: 'L_WEEKLY', description: 'L_ORIGINAL_DESCRIPTION', window: 'weekly', remainingPercent: 0, resetsAt: 1794000000 }] },
      ] };
    const render = (value: AntigravityUsageLimits) => renderToString(createSSRApp({ render: () => h(Quota, { usage: value }) }));
    const stale = await render(usage);
    assert.match(stale, /上次剩余 0%/);
    assert.match(stale, /Antigravity 额度读取超时，正在重试。；上次成功读取：/);
    assert.match(stale, /上次记录的重置时间/);
    assert.match(stale, /L_WEEKLY/);
    assert.match(stale, /L_ORIGINAL_DESCRIPTION/);
    assert.doesNotMatch(stale, /额度已用尽/);
    const fresh = await render({ ...usage, stale: false, errorKind: undefined, message: undefined });
    assert.match(fresh, /额度已用尽，下次重置/);
    assert.doesNotMatch(fresh, /上次剩余|读取超时|上次成功读取/);
    const unavailable = await render({ available: false, checkedAt: usage.checkedAt, groups: [], errorKind: 'authentication', message: 'Antigravity 登录状态待确认' });
    assert.match(unavailable, /Antigravity 登录状态待确认/);
    assert.doesNotMatch(unavailable, /progressbar|剩余 0%/);
  } finally { await server.close(); }
});

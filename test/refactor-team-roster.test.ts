import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { GroupConfig } from '../shared/agent-group-chat';

test('重构团队展示群聊名称和全部自定义成员，不再截取旧岗位或打开旧角色设置', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { default: Roster } = await server.ssrLoadModule('/src/features/refactor-control/RefactorTeamRoster.vue');
    const config: GroupConfig = { revision: 12, name: 'APEX 联调团队', members: Array.from({ length: 8 }, (_, index) => ({
      id: `custom-${index}`, name: `自定义职责 ${index}`, instructions: '用户已配置职责', enabled: index !== 7, capability: 'read' as const,
      binding: { provider: 'codex' as const, model: `model-${index}`, reasoningEffort: 'high' as const },
      fallbackBinding: { provider: 'cursor' as const, model: 'saved-fallback', reasoningEffort: '' as const },
    })) };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
    await router.push('/agent?view=integration-execution');
    const app = createSSRApp({ render: () => h(Roster, { config, runtimes: [] }) }); app.use(router);
    const html = await renderToString(app);
    assert.match(html, /APEX 联调团队/); assert.match(html, /配置 v12 · 7 名成员/);
    assert.equal([...html.matchAll(/data-member="custom-\d"/g)].length, 8);
    assert.match(html, /自定义职责 7/); assert.match(html, /已停用/); assert.match(html, /备用 saved-fallback/);
    assert.match(html, /进入团队群聊/); assert.doesNotMatch(html, /总协调|全部 10 个岗位/);
  } finally { await server.close(); }
});

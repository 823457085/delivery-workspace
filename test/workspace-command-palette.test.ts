import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationCatalog } from '../shared/integration-plugins.js';
import type { ApiOperationDetail, ApiProject } from '../shared/interface-center.js';
import {
  buildOperationAgentPrompt,
  buildOperationCurlSnippet,
  buildOperationMarkdownDoc,
  httpStatusTone,
} from '../src/features/interface-center/curl-snippet.js';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation.js';
import { buildCommandPaletteItems, filterCommandPaletteItems } from '../src/pages/agent/command-palette.js';

test('命令面板聚合快捷动作、实时会话群聊、全部工作区与主题预设，并支持 > / @ / # / 前缀筛选', () => {
  const sections = registeredWorkspaceSections(integrationCatalog.map(plugin => plugin.id));
  const items = buildCommandPaletteItems({
    sections,
    currentViewId: 'ports',
    isChatActive: false,
    chatMode: 'session',
    railCollapsed: false,
    currentThemeId: 'cursor',
    threads: [
      {
        id: 'room-alpha',
        kind: 'group',
        title: '订单结算多角色重构群',
        subtitle: '团队协作群 · order-service · 18:20',
        keywords: 'order-service master',
        active: false,
      },
      {
        id: 'conv-beta',
        kind: 'session',
        title: '排查 5288 端口健康检查',
        subtitle: 'GPT / Codex · delivery-admin · 18:35',
        keywords: 'codex feat/health',
        active: true,
      },
    ],
  });

  assert.ok(items.some(item => item.actionId === 'new-chat'));
  assert.ok(items.some(item => item.actionId === 'new-group'));
  assert.ok(items.some(item => item.groupRoomId === 'room-alpha'));
  assert.ok(items.some(item => item.sessionId === 'conv-beta' && item.active === true));
  assert.ok(items.some(item => item.viewId === 'ports' && item.active === true));
  assert.ok(items.some(item => item.themeId === 'cursor' && item.active === true));

  // 默认空查询展示快捷动作 + 最近会话 + 全部工作区 + 精选主题
  const defaultList = filterCommandPaletteItems(items, '');
  assert.ok(defaultList.some(item => item.category === 'action'));
  assert.ok(defaultList.some(item => item.category === 'thread'));
  assert.ok(defaultList.some(item => item.viewId === 'interfaces'));
  assert.ok(defaultList.some(item => item.themeId === 'linear'));

  // > 前缀仅筛选动作，@ 前缀仅筛选实时会话与群聊，# 前缀仅筛选全部主题
  const actionsOnly = filterCommandPaletteItems(items, '> 群聊');
  assert.ok(actionsOnly.length >= 1);
  assert.ok(actionsOnly.every(item => item.category === 'action'));
  assert.equal(actionsOnly[0].actionId, 'new-group');

  const threadsOnly = filterCommandPaletteItems(items, '@ 订单结算');
  assert.equal(threadsOnly.length, 1);
  assert.equal(threadsOnly[0].groupRoomId, 'room-alpha');

  const themesOnly = filterCommandPaletteItems(items, '# 墨笺');
  assert.equal(themesOnly.length, 1);
  assert.equal(themesOnly[0].themeId, 'ink');

  // 中英文别名搜索精准命中工作区
  const portSearch = filterCommandPaletteItems(items, 'port listen');
  assert.equal(portSearch[0]?.viewId, 'ports');

  const apiSearch = filterCommandPaletteItems(items, 'openapi 联调');
  assert.equal(apiSearch[0]?.viewId, 'interfaces');
});

test('Scalar 风格接口契约工具可一键生成可执行 cURL、结构化 Markdown 与 AI 联调提示词', () => {
  const project: ApiProject = {
    id: 'proj-1',
    name: '商家订单网关',
    description: '订单域 BFF',
    version: '1.2.0',
    openapi: '3.0.3',
    operationCount: 12,
    groups: [{ name: '订单管理', count: 4 }],
    source: { kind: 'repository', label: 'Git 仓库' },
    updatedAt: '2026-11-15T10:00:00Z',
  };
  const detail: ApiOperationDetail = {
    key: 'POST /api/v1/orders/{orderId}/confirm',
    method: 'POST',
    path: '/api/v1/orders/{orderId}/confirm',
    summary: '确认商家订单',
    description: '核验库存并确认指定订单。',
    tags: ['订单管理'],
    deprecated: false,
    parameters: [
      { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'ORD-9001' }, description: '订单号' },
      { name: 'dryRun', in: 'query', required: true, schema: { type: 'boolean', default: false }, description: '演练模式' },
    ],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              operator: { type: 'string', example: 'lzr' },
              force: { type: 'boolean', default: false },
            },
          },
        },
      },
    },
    responses: {
      '200': { description: '确认成功' },
      '409': { description: '库存冲突' },
      '500': { description: '服务异常' },
    },
    security: [{ bearerAuth: [] }],
    servers: [{ url: 'https://api-dev.internal.net' }],
    raw: {},
  };

  const curl = buildOperationCurlSnippet(detail, project);
  assert.match(curl, /curl --request POST/);
  assert.match(curl, /https:\/\/api-dev\.internal\.net\/api\/v1\/orders\/ORD-9001\/confirm\?dryRun=false/);
  assert.match(curl, /Authorization: Bearer <YOUR_TOKEN>/);
  assert.match(curl, /"operator": "lzr"/);

  const md = buildOperationMarkdownDoc(detail, project);
  assert.match(md, /## POST `\/api\/v1\/orders\/\{orderId\}\/confirm` — 确认商家订单/);
  assert.match(md, /\| `orderId` \| path \| `string` \| 是 \| 订单号 \|/);
  assert.match(md, /\*\*`200`\*\*：确认成功/);

  const prompt = buildOperationAgentPrompt(detail, project);
  assert.match(prompt, /请基于以下接口契约协助我完成联调/);

  assert.equal(httpStatusTone('200'), 'success');
  assert.equal(httpStatusTone('409'), 'warning');
  assert.equal(httpStatusTone('500'), 'danger');
  assert.equal(httpStatusTone('default'), 'neutral');
});

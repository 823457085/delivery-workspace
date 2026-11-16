import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOperationAgentPrompt,
  buildOperationCurlSnippet,
  buildOperationMarkdownDoc,
  httpStatusTone,
} from '../src/features/interface-center/curl-snippet.js';
import type { ApiOperationDetail, ApiProject } from '../shared/interface-center.js';

const sampleProject: ApiProject = {
  id: 'proj-1',
  name: '商家工作台 BFF',
  description: '核心订单与库存聚合接口',
  operationCount: 12,
  updatedAt: '2026-11-15T10:00:00Z',
};

const sampleDetail: ApiOperationDetail = {
  key: 'POST /orders/{orderId}/confirm',
  method: 'POST',
  path: '/orders/{orderId}/confirm',
  summary: '确认商家订单',
  description: '校验库存并锁定履约单状态',
  tags: ['订单管理', '履约'],
  deprecated: false,
  parameters: [
    { name: 'orderId', in: 'path', required: true, example: 'ORD-9001', schema: { type: 'string' } },
    { name: 'dryRun', in: 'query', required: true, schema: { type: 'boolean', default: false } },
    { name: 'X-Tenant-Id', in: 'header', required: true, example: 'tenant-hz', schema: { type: 'string' } },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            operator: { type: 'string', example: 'ops-bot' },
            warehouseCount: { type: 'integer' },
          },
        },
      },
    },
  },
  responses: {
    '200': { description: '确认成功' },
    '409': { description: '订单状态冲突' },
  },
  security: [{ bearerAuth: [] }],
  servers: [{ url: 'https://api.merchant.example.com/v1/' }],
  schemas: {},
};

test('Scalar cURL 生成器包含解析后的 Server、Path 参数、必填 Query/Header、Bearer 占位与 JSON Body', () => {
  const curl = buildOperationCurlSnippet(sampleDetail, sampleProject);
  assert.match(curl, /^curl --request POST \\/);
  assert.match(curl, /https:\/\/api\.merchant\.example\.com\/v1\/orders\/ORD-9001\/confirm\?dryRun=false/);
  assert.match(curl, /Authorization: Bearer <YOUR_TOKEN>/);
  assert.match(curl, /X-Tenant-Id: tenant-hz/);
  assert.match(curl, /Content-Type: application\/json/);
  assert.match(curl, /"operator": "ops-bot"/);
  assert.match(curl, /"warehouseCount": 0/);
});

test('Markdown 接口文档与 AI 联调提示词完整输出结构化契约摘要', () => {
  const md = buildOperationMarkdownDoc(sampleDetail, sampleProject);
  assert.match(md, /## POST `\/orders\/\{orderId\}\/confirm` — 确认商家订单/);
  assert.match(md, /项目：商家工作台 BFF · 分类：订单管理 \/ 履约/);
  assert.match(md, /\| `orderId` \| path \| `string` \| 是 \| — \|/);
  assert.match(md, /### 响应状态/);
  assert.match(md, /- \*\*`409`\*\*：订单状态冲突/);

  const prompt = buildOperationAgentPrompt(sampleDetail, sampleProject);
  assert.match(prompt, /请基于以下接口契约协助我完成联调或生成类型安全的调用代码：/);
  assert.match(prompt, /```bash\ncurl --request POST/);
});

test('HTTP 响应状态码语义映射覆盖 2xx / 3xx / 4xx / 5xx', () => {
  assert.equal(httpStatusTone('200'), 'success');
  assert.equal(httpStatusTone('204'), 'success');
  assert.equal(httpStatusTone('302'), 'warning');
  assert.equal(httpStatusTone('404'), 'warning');
  assert.equal(httpStatusTone('502'), 'danger');
  assert.equal(httpStatusTone('default'), 'neutral');
});

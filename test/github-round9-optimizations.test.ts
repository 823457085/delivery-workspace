import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executeProjectGitAction,
  readProjectCommitDetail,
  readProjectGitSnapshot,
} from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';
import {
  apiDebugCurl,
  prepareApiDebugRequest,
} from '../shared/interface-center-debug.js';
import type { ApiOperationDetail, ApiProject } from '../shared/interface-center.js';
import {
  buildDebugDiscrepancyAgentPrompt,
  compareApiDebugResponses,
  parseCurlCommandToDebugDraft,
  tokenizeShellCommand,
  validateResponseAgainstOpenApi,
} from '../shared/api-debug-intelligence.js';
import {
  buildPlanStepExecutionPrompt,
  extractMarkdownPlanChecklist,
  formatPlanChecklistTaskMarkdown,
} from '../shared/agent-plan-checklist.js';

const exec = promisify(execFile);

function buildSampleOperationDetail(): ApiOperationDetail {
  return {
    key: 'order-center:POST:/v1/tenants/{tenantId}/orders/{orderId}',
    projectId: 'order-center',
    method: 'post',
    path: '/v1/tenants/{tenantId}/orders/{orderId}',
    summary: '提交并校验租户订单',
    description: '用于创建或幂等更新指定订单',
    operationId: 'upsertTenantOrder',
    tags: ['订单中心'],
    deprecated: false,
    security: [{ bearerAuth: [] }],
    parameters: [
      { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['sku', 'quantity'],
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'integer' },
              note: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description: '处理成功',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['orderId', 'status', 'quantity', 'items'],
              properties: {
                orderId: { type: 'string' },
                status: { type: 'string', enum: ['CREATED', 'PAID', 'CANCELLED'] },
                quantity: { type: 'integer' },
                discountNote: { type: 'string', nullable: false },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['sku', 'price'],
                    properties: {
                      sku: { type: 'string' },
                      price: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '400': {
        description: '参数错误',
        content: {
          'application/problem+json': {
            schema: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

test('Round 9 · API Debug Intelligence：cURL 反向导入（往返闭环 + DevTools ANSI-C 引号 + 伪首部过滤 + 路径参数反解）', () => {
  const detail = buildSampleOperationDetail();

  // 1. 工作台自身生成的 apiDebugCurl（含单引号转义 '\''、空值请求头 X-Empty;、重复 Query 参数与网关前缀）100% 无损往返解析
  const originalPrepared = prepareApiDebugRequest(detail, {
    operationKey: detail.key,
    baseUrl: 'https://api.staging.internal/gateway',
    pathParameters: [
      { name: 'tenantId', value: 't-beijing', enabled: true },
      { name: 'orderId', value: 'ORD-2026-99', enabled: true },
    ],
    queryParameters: [
      { name: 'dryRun', value: 'true', enabled: true },
      { name: 'tag', value: 'vip', enabled: true },
      { name: 'tag', value: 'urgent', enabled: true },
    ],
    headers: [
      { name: 'X-Trace-Note', value: "it's ok", enabled: true },
      { name: 'X-Empty', value: '', enabled: true },
    ],
    auth: { kind: 'bearer', token: 'tok_round9_demo_alpha' },
    body: {
      kind: 'json',
      text: JSON.stringify({ sku: 'SKU-PRO', quantity: 2, note: "quote'test" }),
    },
    timeoutMs: 15_000,
  });

  const exportedCurl = apiDebugCurl(originalPrepared);
  const reimported = parseCurlCommandToDebugDraft(exportedCurl, detail);

  assert.equal(reimported.method, 'POST');
  assert.equal(reimported.baseUrl, 'https://api.staging.internal/gateway');
  assert.equal(reimported.methodMismatchWarning, undefined);
  assert.deepEqual(reimported.pathParameters, [
    { name: 'tenantId', value: 't-beijing', enabled: true },
    { name: 'orderId', value: 'ORD-2026-99', enabled: true },
  ]);
  assert.deepEqual(reimported.queryParameters, [
    { name: 'dryRun', value: 'true', enabled: true },
    { name: 'tag', value: 'vip', enabled: true },
    { name: 'tag', value: 'urgent', enabled: true },
  ]);
  assert.deepEqual(reimported.auth, { kind: 'bearer', token: 'tok_round9_demo_alpha' });
  assert.deepEqual(reimported.headers, [
    { name: 'X-Trace-Note', value: "it's ok", enabled: true },
    { name: 'X-Empty', value: '', enabled: true },
  ]);
  assert.equal(reimported.body.kind, 'json');

  // 重新喂给服务端同源 prepareApiDebugRequest 校验器，零报错且 URL / Header / Body 等价
  const reprepared = prepareApiDebugRequest(detail, {
    operationKey: detail.key,
    baseUrl: reimported.baseUrl,
    pathParameters: reimported.pathParameters,
    queryParameters: reimported.queryParameters,
    headers: reimported.headers,
    auth: reimported.auth,
    body: reimported.body,
    timeoutMs: 15_000,
  });
  assert.equal(reprepared.url, originalPrepared.url);
  assert.deepEqual(JSON.parse(reprepared.body!), JSON.parse(originalPrepared.body!));

  // 2. Chrome DevTools "Copy as cURL" 风格（含 :authority 伪头、accept-encoding 受管头、ANSI-C $'...' 转义、-b Cookie 与 Basic 鉴权）
  const basicEncoded = Buffer.from('ops-user:sec-pass-9').toString('base64');
  const devToolsCurl = [
    "curl 'https://gw.dev.internal/v1/tenants/acme%20corp/orders/ORD-777?dryRun=false' \\",
    "  -H ':authority: gw.dev.internal' \\",
    "  -H 'accept-encoding: gzip, deflate, br' \\",
    `  -H 'authorization: Basic ${basicEncoded}' \\`,
    "  -H 'content-type: application/json' \\",
    "  -b 'sid=abc123; locale=zh-CN' \\",
    "  --data-raw $'{\\n  \"sku\":\"A1\\\\nB2\",\\n  \"quantity\":5,\\n  \"note\":\"line1\\\\nline2\\u0021\"\\n}'",
  ].join('\n');

  const parsedDevTools = parseCurlCommandToDebugDraft(devToolsCurl, detail);
  assert.equal(parsedDevTools.baseUrl, 'https://gw.dev.internal');
  assert.deepEqual(parsedDevTools.pathParameters, [
    { name: 'tenantId', value: 'acme corp', enabled: true },
    { name: 'orderId', value: 'ORD-777', enabled: true },
  ]);
  assert.deepEqual(parsedDevTools.auth, {
    kind: 'basic',
    username: 'ops-user',
    password: 'sec-pass-9',
  });
  assert.deepEqual(parsedDevTools.headers, [
    { name: 'Cookie', value: 'sid=abc123; locale=zh-CN', enabled: true },
  ]);
  assert.equal(parsedDevTools.body.kind, 'json');
  if (parsedDevTools.body.kind === 'json') {
    const bodyObj = JSON.parse(parsedDevTools.body.text) as Record<string, unknown>;
    assert.equal(bodyObj.sku, 'A1\nB2');
    assert.equal(bodyObj.note, 'line1\nline2!');
  }

  // 3. Tokenizer 边界测试
  const tokens = tokenizeShellCommand(`curl -X PATCH "https://a.local/p?x=1" -d $'a\\tb'`);
  assert.deepEqual(tokens, ['curl', '-X', 'PATCH', 'https://a.local/p?x=1', '-d', 'a\tb']);
});

test('Round 9 · API Debug Intelligence：实时 OpenAPI 响应契约断言 + 基准响应 JSON 语义对比 + AI 排障 Prompt 生成', () => {
  const detail = buildSampleOperationDetail();
  const project: ApiProject = {
    id: 'order-center',
    name: '订单中心服务',
    description: '',
    defaultBaseUrl: 'https://api.staging.internal',
    sourceLabel: 'openapi.json',
    operationCount: 1,
    updatedAt: '2026-11-16T00:00:00.000Z',
  };

  // 1. 合法的 200 响应完全通过契约核验
  const validResponse = {
    method: 'POST',
    url: 'https://api.staging.internal/v1/tenants/t1/orders/ORD-1',
    status: 200,
    statusText: 'OK',
    durationMs: 42,
    sizeBytes: 128,
    bodyEncoding: 'utf8' as const,
    headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
    body: JSON.stringify({
      orderId: 'ORD-1',
      status: 'PAID',
      quantity: 3,
      items: [{ sku: 'BOOK-1', price: 39.9 }],
    }),
  };
  const okReport = validateResponseAgainstOpenApi(detail, validResponse);
  assert.equal(okReport.passed, true);
  assert.equal(okReport.issues.length, 0);
  assert.equal(okReport.matchedStatusKey, '200');

  // 2. 破坏契约的 200 响应：缺少必填字段 items、status 枚举越界、quantity 返回字符串、不可空字段返回 null
  const driftedResponse = {
    ...validResponse,
    durationMs: 165,
    sizeBytes: 156,
    body: JSON.stringify({
      orderId: 'ORD-1',
      status: 'REFUNDING_UNKNOWN',
      quantity: '3',
      discountNote: null,
      extraDebugFlag: true,
    }),
  };
  const badReport = validateResponseAgainstOpenApi(detail, driftedResponse);
  assert.equal(badReport.passed, false);
  const issuePaths = badReport.issues.map(item => item.jsonPath);
  assert.ok(issuePaths.includes('$.items'), '应捕获缺失的必填字段 $.items');
  assert.ok(issuePaths.includes('$.status'), '应捕获枚举越界 $.status');
  assert.ok(issuePaths.includes('$.quantity'), '应捕获类型漂移 $.quantity (integer -> string)');
  assert.ok(issuePaths.includes('$.discountNote'), '应捕获非 nullable 字段返回 null');

  // 3. 未声明的 502 状态码断言
  const undeclared502 = validateResponseAgainstOpenApi(detail, {
    ...validResponse,
    status: 502,
    headers: [{ name: 'content-type', value: 'text/html' }],
    body: '<html>Bad Gateway</html>',
  });
  assert.equal(undeclared502.passed, false);
  assert.ok(undeclared502.issues.some(i => i.jsonPath === '$status'));

  // 4. 基准响应 (Baseline) 与漂移响应之间的 JSON 语义级 Diff
  const diff = compareApiDebugResponses(validResponse, driftedResponse);
  assert.equal(diff.identical, false);
  assert.equal(diff.isJsonDiff, true);
  assert.equal(diff.durationDeltaMs, 123);
  assert.equal(diff.sizeDeltaBytes, 28);

  const byPath = new Map(diff.changes.map(c => [c.path, c]));
  assert.equal(byPath.get('$.status')?.kind, 'value_changed');
  assert.equal(byPath.get('$.quantity')?.kind, 'type_changed');
  assert.equal(byPath.get('$.items')?.kind, 'removed');
  assert.equal(byPath.get('$.extraDebugFlag')?.kind, 'added');

  // 5. 生成 AI 排障 Prompt 包含契约偏差与基准对比摘要
  const aiPrompt = buildDebugDiscrepancyAgentPrompt(detail, project, driftedResponse, badReport, diff);
  assert.match(aiPrompt, /POST \/v1\/tenants\/\{tenantId\}\/orders\/\{orderId\}/);
  assert.match(aiPrompt, /\$\.items/);
  assert.match(aiPrompt, /\$\.quantity/);
  assert.match(aiPrompt, /与对比基准的变化/);
});

test('Round 9 · 真实本地 Git 仓库：提交详情审查（含根提交）、Cherry-Pick 跨分支摘取、安全 Revert 回滚与冲突自动中止回退', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round9-git-'));
  const repo = path.join(tempRoot, 'repo');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;

  try {
    await fs.mkdir(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Round9 Tester');
    await git('config', 'user.email', 'round9@localhost');

    // 1. 根提交创建与 readProjectCommitDetail 根提交审查（验证 --root 参数不报错）
    await fs.writeFile(path.join(repo, 'service.ts'), 'export const port = 8080;\nexport const mode = "prod";\n', 'utf8');
    await git('add', '.');
    await git('commit', '-qm', 'feat: bootstrap service');
    const rootSha = (await git('rev-parse', 'HEAD')).trim();

    const rootDetail = await readProjectCommitDetail(repo, rootSha);
    assert.equal(rootDetail.sha, rootSha);
    assert.equal(rootDetail.parents.length, 0);
    assert.equal(rootDetail.subject, 'feat: bootstrap service');
    assert.equal(rootDetail.files.length, 1);
    assert.equal(rootDetail.files[0]?.path, 'service.ts');
    assert.equal(rootDetail.files[0]?.status, 'A');
    assert.match(rootDetail.patch, /\+export const port = 8080;/);

    // 2. 在侧翼分支 feat/hotfix 创建独立提交 + 冲突提交
    await git('checkout', '-qb', 'feat/hotfix');
    await fs.writeFile(path.join(repo, 'healthcheck.ts'), 'export const healthPath = "/healthz";\n', 'utf8');
    await git('add', 'healthcheck.ts');
    await git('commit', '-qm', 'feat: add healthcheck endpoint\n\nSupports readiness probes.');
    const hotfixSha = (await git('rev-parse', 'HEAD')).trim();

    const hotfixDetail = await readProjectCommitDetail(repo, hotfixSha.slice(0, 8));
    assert.equal(hotfixDetail.sha, hotfixSha);
    assert.equal(hotfixDetail.parents.length, 1);
    assert.equal(hotfixDetail.body, 'Supports readiness probes.');
    assert.equal(hotfixDetail.files[0]?.path, 'healthcheck.ts');

    // 在 feat/hotfix 上再做一个修改 service.ts 的提交，稍后制造冲突
    await fs.writeFile(path.join(repo, 'service.ts'), 'export const port = 9090;\nexport const mode = "hotfix";\n', 'utf8');
    await git('add', 'service.ts');
    await git('commit', '-qm', 'feat: change port to 9090 on hotfix');
    const conflictingSha = (await git('rev-parse', 'HEAD')).trim();

    // 3. 切回 main，修改 service.ts 为不同端口，然后测试 Cherry-Pick 无冲突提交 hotfixSha
    await git('checkout', '-q', 'main');
    await fs.writeFile(path.join(repo, 'service.ts'), 'export const port = 7070;\nexport const mode = "main-v2";\n', 'utf8');
    await git('add', 'service.ts');
    await git('commit', '-qm', 'feat: update main port to 7070');

    const pickRes = await executeProjectGitAction(
      { path: repo, action: 'cherry-pick', sha: hotfixSha.slice(0, 10) },
      source,
    );
    assert.equal(pickRes.ok, true);
    assert.equal(pickRes.snapshot.clean, true);
    assert.equal(pickRes.snapshot.log[0]?.subject, 'feat: add healthcheck endpoint');
    const pickedHealth = await fs.readFile(path.join(repo, 'healthcheck.ts'), 'utf8');
    assert.match(pickedHealth, /\/healthz/);

    // 4. 安全 Revert 回滚：未传 confirmed 必须拦截；传 confirmed: true 生成干净的 Revert 提交
    const pickedHead = pickRes.snapshot.head;
    await assert.rejects(
      () => executeProjectGitAction({ path: repo, action: 'revert-commit', sha: pickedHead }, source),
      /确认要回滚的提交/,
    );

    const revertRes = await executeProjectGitAction(
      { path: repo, action: 'revert-commit', sha: pickedHead, confirmed: true },
      source,
    );
    assert.equal(revertRes.ok, true);
    assert.equal(revertRes.snapshot.clean, true);
    assert.match(revertRes.snapshot.log[0]?.subject || '', /^Revert "feat: add healthcheck endpoint"/);
    await assert.rejects(() => fs.access(path.join(repo, 'healthcheck.ts')));

    // 5. 冲突自动中止保护：摘取 conflictingSha 与 main 上的 service.ts 冲突时，自动执行 cherry-pick --abort 恢复干净工作区
    await assert.rejects(
      () => executeProjectGitAction({ path: repo, action: 'cherry-pick', sha: conflictingSha }, source),
      /产生代码冲突.*service\.ts.*已自动中止并恢复干净工作区/,
    );

    // 校验无残留 .git/CHERRY_PICK_HEAD，且工作区保持 100% 干净
    await assert.rejects(() => fs.access(path.join(repo, '.git', 'CHERRY_PICK_HEAD')));
    const afterConflictSnap = await readProjectGitSnapshot(repo);
    assert.equal(afterConflictSnap.clean, true);
    assert.equal(afterConflictSnap.files.length, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Round 9 · Agent Plan-to-Build 交互式清单引擎：代码围栏隔离、Plan/Agent 双模式识别、受控分步推进 Prompt 与 taskmd 导出', () => {
  const samplePlanReply = [
    '下面是本次改造的分阶段实施方案：',
    '',
    '```markdown',
    '- [ ] 这是一个代码块里的示例清单，绝不能被误提取 `fake/ignored.ts`',
    '1. 代码块内的编号项也必须忽略',
    '```',
    '',
    '### 阶段一：共享协议层',
    '- [x] 在 `shared/order-schema.ts` 中新增幂等键校验模型',
    '- [ ] 在 `server/order-handler.ts:42-88` 接入幂等锁与重试响应头',
    '',
    '### 阶段二：前端联调与回归验证',
    '- [ ] 更新 `src/features/orders/OrderForm.vue` 表单防重按钮状态',
    '- [ ] 补充 `test/order-idempotency.test.ts` 覆盖并发重复提交场景',
  ].join('\n');

  // 1. 提取复选框清单，严格跳过 ```markdown 围栏内部内容
  const extracted = extractMarkdownPlanChecklist(samplePlanReply, { mode: 'agent' });
  assert.equal(extracted.actionable, true);
  assert.equal(extracted.sourceKind, 'checkbox');
  assert.equal(extracted.items.length, 4);
  assert.equal(extracted.items[0]?.checkedByModel, true);
  assert.equal(extracted.items[0]?.phase, '阶段一：共享协议层');
  assert.deepEqual(extracted.items[0]?.fileRefs, ['shared/order-schema.ts']);
  assert.deepEqual(extracted.items[1]?.fileRefs, ['server/order-handler.ts:42-88']);

  // 2. Plan 模式下纯编号列表可被识别，而普通 Agent 回复中的编号列表不会误触发卡片
  const numberedOnly = [
    '## 架构迁移计划',
    '1. 抽离 `server/cache-adapter.ts` 统一缓存读写接口',
    '2. 将会话存储迁移到新的缓存适配器并保留回退开关',
    '3. 运行全量集成测试核对吞吐延迟',
  ].join('\n');
  assert.equal(extractMarkdownPlanChecklist(numberedOnly, { mode: 'agent' }).actionable, false);
  const planNumbered = extractMarkdownPlanChecklist(numberedOnly, { mode: 'plan' });
  assert.equal(planNumbered.actionable, true);
  assert.equal(planNumbered.sourceKind, 'numbered_plan');
  assert.equal(planNumbered.items.length, 3);

  // 3. 受控分步执行 Prompt：自动区分已完成步骤、本轮目标步骤与暂缓步骤
  const stepPrompt = buildPlanStepExecutionPrompt({
    items: extracted.items,
    completedIds: ['step-1'],
    targetIds: ['step-2'],
    originalObjective: '为订单创建接口增加端到端幂等保护',
  });
  assert.match(stepPrompt, /已完成步骤[\s\S]*步骤 1/);
  assert.match(stepPrompt, /本轮需实施的目标步骤（共 1 步）[\s\S]*步骤 2[\s\S]*server\/order-handler\.ts:42-88/);
  assert.match(stepPrompt, /暂缓步骤[\s\S]*暂缓步骤 3[\s\S]*暂缓步骤 4/);

  // 4. 导出兼容 taskmd 规范的 YAML Frontmatter Markdown
  const taskMd = formatPlanChecklistTaskMarkdown({
    title: '订单幂等改造计划',
    runId: 'run-99887766-abcd',
    items: extracted.items,
    completedIds: ['step-1', 'step-2'],
  });
  assert.match(taskMd, /^---\ntask_id: "run-9988"\ntitle: "订单幂等改造计划"\nstatus: "in_progress"\nprogress: "2\/4"\n---/);
  assert.match(taskMd, /### 阶段一：共享协议层\n- \[x\] 在 `shared\/order-schema\.ts`/);
  assert.match(taskMd, /- \[x\] 在 `server\/order-handler\.ts:42-88`/);
  assert.match(taskMd, /- \[ \] 更新 `src\/features\/orders\/OrderForm\.vue`/);
});

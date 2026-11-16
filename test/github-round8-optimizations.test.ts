import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executeProjectGitAction,
  readProjectGitSnapshot,
  readProjectStashDiff,
} from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';
import {
  estimateConversationContextMeter,
  estimateTextTokens,
  redactPromptSecrets,
  scanPromptPreflight,
} from '../shared/agent-composer-preflight.js';
import {
  buildOperationContractTestSnippet,
  buildOperationGoClientSnippet,
  buildOperationTypeScriptSdk,
  deriveOperationSymbolName,
} from '../shared/openapi-client-codegen.js';
import {
  buildOperationAgentPrompt,
  buildOperationCodegenSnippet,
} from '../src/features/interface-center/curl-snippet.js';
import type { ApiOperationDetail, ApiProject } from '../shared/interface-center.js';

const exec = promisify(execFile);

test('Round 8 · 真实本地 Git 仓库：Stash 贮藏栈全生命周期（含未跟踪文件 Diff 预览、切分支解锁、仅已暂存贮藏、指纹并发防呆与冲突优雅降级）', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round8-stash-'));
  const repo = path.join(tempRoot, 'repo');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;

  try {
    await fs.mkdir(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Round8 Tester');
    await git('config', 'user.email', 'round8@localhost');

    await fs.writeFile(path.join(repo, 'app.ts'), 'export const version = 1;\n', 'utf8');
    await git('add', '.');
    await git('commit', '-qm', 'feat: initial commit');
    await git('branch', 'feat/hotfix');

    // 1. 制造脏工作区（已跟踪修改 + 未跟踪新文件）
    await fs.writeFile(path.join(repo, 'app.ts'), 'export const version = 2;\n', 'utf8');
    await fs.writeFile(path.join(repo, 'draft-notes.md'), '# WIP Stash Notes\n', 'utf8');

    const dirtySnap = await readProjectGitSnapshot(repo);
    assert.equal(dirtySnap.clean, false);
    assert.equal(dirtySnap.stashes.length, 0);

    // 脏工作区下直接切换分支会被拦截
    await assert.rejects(
      executeProjectGitAction(
        {
          path: repo,
          revision: dirtySnap.revision,
          action: 'switch',
          ref: 'refs/heads/feat/hotfix',
        },
        source,
      ),
      /请先提交当前改动/,
    );

    // 2. 执行 stash-push（默认 all，包含未跟踪文件）
    const pushed = await executeProjectGitAction(
      {
        path: repo,
        revision: dirtySnap.revision,
        action: 'stash-push',
        mode: 'all',
        message: '切换分支前临时保存 WIP',
      },
      source,
    );
    assert.equal(pushed.snapshot.clean, true, '贮藏后工作区应恢复干净');
    assert.equal(pushed.snapshot.stashes.length, 1);
    const firstStash = pushed.snapshot.stashes[0]!;
    assert.equal(firstStash.ref, 'stash@{0}');
    assert.equal(firstStash.branch, 'main');
    assert.match(firstStash.subject, /切换分支前临时保存 WIP/);
    assert.match(firstStash.sha, /^[0-9a-f]{40}$/);

    // 3. 预览 Stash Diff（需同时包含已跟踪修改与未跟踪新文件）
    const stashDiff = await readProjectStashDiff(repo, 'stash@{0}');
    assert.equal(stashDiff.ref, 'stash@{0}');
    assert.equal(stashDiff.sha, firstStash.sha);
    assert.match(stashDiff.patch, /export const version = 2;/);
    assert.match(stashDiff.patch, /WIP Stash Notes/);

    // 4. 工作区干净后可无缝切换到 feat/hotfix 再切回 main
    const switched = await executeProjectGitAction(
      {
        path: repo,
        revision: pushed.snapshot.revision,
        action: 'switch',
        ref: 'refs/heads/feat/hotfix',
      },
      source,
    );
    assert.equal(switched.snapshot.branch, 'feat/hotfix');

    const switchedBack = await executeProjectGitAction(
      {
        path: repo,
        revision: switched.snapshot.revision,
        action: 'switch',
        ref: 'refs/heads/main',
      },
      source,
    );
    assert.equal(switchedBack.snapshot.branch, 'main');

    // 5. stash-apply 恢复改动且保留栈内记录
    const applied = await executeProjectGitAction(
      {
        path: repo,
        revision: switchedBack.snapshot.revision,
        action: 'stash-apply',
        stashRef: 'stash@{0}',
        stashSha: firstStash.sha,
      },
      source,
    );
    assert.equal(applied.snapshot.clean, false);
    assert.equal(applied.snapshot.stashes.length, 1, 'stash-apply 不应移除栈内条目');
    assert.equal(await fs.readFile(path.join(repo, 'draft-notes.md'), 'utf8'), '# WIP Stash Notes\n');

    // 6. 安全防呆：未传 confirmed 或传错 stashSha 时拒绝删除
    await assert.rejects(
      executeProjectGitAction(
        {
          path: repo,
          revision: applied.snapshot.revision,
          action: 'stash-drop',
          stashRef: 'stash@{0}',
          stashSha: firstStash.sha,
        },
        source,
      ),
      /确认要删除/,
    );

    await assert.rejects(
      executeProjectGitAction(
        {
          path: repo,
          revision: applied.snapshot.revision,
          action: 'stash-drop',
          stashRef: 'stash@{0}',
          stashSha: '0000000000000000000000000000000000000000',
          confirmed: true,
        },
        source,
      ),
      /贮藏栈顺序已变化/,
    );

    // 7. 确认删除该条贮藏
    const dropped = await executeProjectGitAction(
      {
        path: repo,
        revision: applied.snapshot.revision,
        action: 'stash-drop',
        stashRef: 'stash@{0}',
        stashSha: firstStash.sha,
        confirmed: true,
      },
      source,
    );
    assert.equal(dropped.snapshot.stashes.length, 0);

    // 8. 验证 mode: 'staged' 仅贮藏已暂存改动，保留未暂存文件在工作区
    await git('add', 'app.ts');
    const stagedSnap = await readProjectGitSnapshot(repo);
    const stagedStashRes = await executeProjectGitAction(
      {
        path: repo,
        revision: stagedSnap.revision,
        action: 'stash-push',
        mode: 'staged',
        message: '仅贮藏 app.ts 已暂存版本',
      },
      source,
    );
    assert.equal(stagedStashRes.snapshot.stashes.length, 1);
    assert.equal(
      await fs.readFile(path.join(repo, 'app.ts'), 'utf8'),
      'export const version = 1;\n',
      '已暂存的 app.ts 改动应被收入贮藏栈',
    );
    assert.equal(
      await fs.readFile(path.join(repo, 'draft-notes.md'), 'utf8'),
      '# WIP Stash Notes\n',
      '未暂存的未跟踪文件应保留在工作区',
    );

    // 9. stash-pop 弹出并清空栈
    const popped = await executeProjectGitAction(
      {
        path: repo,
        revision: stagedStashRes.snapshot.revision,
        action: 'stash-pop',
        stashRef: 'stash@{0}',
        stashSha: stagedStashRes.snapshot.stashes[0]!.sha,
      },
      source,
    );
    assert.equal(popped.snapshot.stashes.length, 0);
    assert.equal(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), 'export const version = 2;\n');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Round 8 · Composer 发送前护栏：识别多类明文密钥与高爆炸半径指令、支持原地脱敏，并区分只读模式', () => {
  // 动态拼装测试凭据，确保源码本身不触发打包扫描正则
  const fakeApiKey = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-');
  const fakeGitToken = `${'ghp'}_${'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4'}`;
  const fakePem = [
    ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
    ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
  ].join('\n');
  const fakeJwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiJ1c2VyXzQyIiwicm9sZSI6ImFkbWluIn0',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ].join('.');
  const fakeDbUrl = 'postgres://admin_user:SuperSecretPass99@db.internal.local:5432/orders';

  const rawPrompt = [
    '请帮我排查线上连接失败，配置如下：',
    `OPENAI_API_KEY=${fakeApiKey}`,
    `GITHUB_TOKEN=${fakeGitToken}`,
    `DB_URL=${fakeDbUrl}`,
    `AUTH_JWT=${fakeJwt}`,
    fakePem,
    '如果修复不了就执行 rm -rf ./dist && git push --force origin main 或 DROP TABLE temp_orders;',
  ].join('\n');

  const agentReport = scanPromptPreflight(rawPrompt, { mode: 'agent', accessMode: 'full' });
  assert.equal(agentReport.hasSecrets, true);
  assert.equal(agentReport.hasDestructiveCommands, true);
  const codes = new Set(agentReport.issues.map(i => i.code));
  assert.ok(codes.has('openai-or-vendor-sk'));
  assert.ok(codes.has('github-gitlab-token'));
  assert.ok(codes.has('credential-url'));
  assert.ok(codes.has('jwt-token'));
  assert.ok(codes.has('pem-private-key'));
  assert.ok(codes.has('rm-rf'));
  assert.ok(codes.has('git-destructive'));
  assert.ok(codes.has('sql-drop-truncate'));

  // 只读 plan / ask 模式下，仅告警明文密钥，不误报破坏性终端命令
  const planReport = scanPromptPreflight(rawPrompt, { mode: 'plan', accessMode: 'workspace' });
  assert.equal(planReport.hasSecrets, true);
  assert.equal(planReport.hasDestructiveCommands, false);
  assert.ok(planReport.issues.every(item => item.kind === 'secret_leak'));

  // git push --force-with-lease 属于安全强推，不应误报
  const safeLease = scanPromptPreflight('请使用 git push --force-with-lease 推送分支', { mode: 'agent' });
  assert.equal(safeLease.hasDestructiveCommands, false);

  // 一键原地脱敏：彻底清除全部明文密钥，同时保留变量名、数据库主机与指令上下文
  const redacted = redactPromptSecrets(rawPrompt);
  assert.ok(!redacted.includes(fakeApiKey));
  assert.ok(!redacted.includes(fakeGitToken));
  assert.ok(!redacted.includes('SuperSecretPass99'));
  assert.ok(!redacted.includes('MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu'));
  assert.match(redacted, /OPENAI_API_KEY=\[REDACTED_API_KEY\]/);
  assert.match(redacted, /GITHUB_TOKEN=\[REDACTED_GIT_TOKEN\]/);
  assert.match(redacted, /postgres:\/\/admin_user:\[REDACTED_PASSWORD\]@db\.internal\.local:5432\/orders/);
  assert.match(redacted, /AUTH_JWT=\[REDACTED_JWT\]/);
  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);

  const afterRedactScan = scanPromptPreflight(redacted, { mode: 'plan' });
  assert.equal(afterRedactScan.hasSecrets, false);
});

test('Round 8 · 上下文预算水位计：过滤被修订旧轮、融合原生 CLI Telemetry 并精准分级预警', () => {
  assert.ok(estimateTextTokens('你好世界') >= 2);
  assert.ok(estimateTextTokens('function add(a: number, b: number) { return a + b; }') >= 10);

  const freshMeter = estimateConversationContextMeter(
    [
      { id: 'r1', status: 'completed', objective: '旧版本提问', result: 'x'.repeat(20_000) },
      { id: 'r2', status: 'completed', revisesRunId: 'r1', objective: '修订后简短提问', result: '简短回答' },
    ],
    '继续补充一个细节',
    100_000,
  );
  assert.equal(freshMeter.turnCount, 1, '被 revisesRunId 替代的旧轮不应重复计入有效上下文');
  assert.equal(freshMeter.level, 'fresh');

  const heavyMeter = estimateConversationContextMeter(
    [
      {
        id: 'r-heavy',
        provider: 'codex',
        status: 'completed',
        objective: '分析大型模块',
        usage: { inputTokens: 86_000, outputTokens: 4_000 },
        events: [],
      },
    ],
    '',
    100_000,
  );
  assert.equal(heavyMeter.usedNativeTelemetry, true);
  assert.equal(heavyMeter.estimatedTokens, 90_000);
  assert.equal(heavyMeter.level, 'heavy');

  const compactNeededMeter = estimateConversationContextMeter(
    [
      {
        id: 'r-over',
        provider: 'claude',
        status: 'completed',
        objective: '超长重构历史',
        usage: { inputTokens: 125_000, outputTokens: 8_000 },
        events: [],
      },
    ],
    '',
    120_000,
  );
  assert.equal(compactNeededMeter.level, 'compaction_needed');
  assert.ok(compactNeededMeter.usagePercent >= 110);
});

test('Round 8 · OpenAPI 多语言客户端与契约测试工坊：生成强类型 TS SDK、Go net/http 与 Node 契约断言测试', () => {
  const names = deriveOperationSymbolName('POST', '/api/v2/orders/{orderId}/items');
  assert.deepEqual(names, {
    camelName: 'postOrdersByOrderIdItems',
    pascalName: 'PostOrdersByOrderIdItems',
  });

  const sampleProject: ApiProject = {
    id: 'order-center',
    name: '订单中心服务',
    version: '2.1.0',
    openapi: '3.1.0',
    operationCount: 1,
    tags: [{ name: '订单', count: 1 }],
    updatedAt: '2026-11-15T12:00:00Z',
    source: { kind: 'url', label: 'Apifox OpenAPI' },
  };

  const sampleOperation: ApiOperationDetail = {
    key: 'POST:/api/v2/orders/{orderId}/items',
    method: 'POST',
    path: '/api/v2/orders/{orderId}/items',
    summary: '新增订单明细行',
    tags: ['订单'],
    deprecated: false,
    servers: [{ url: 'https://api.shop.internal/{env}', variables: { env: { default: 'staging' } } }],
    security: [{ bearerAuth: [] }],
    parameters: [
      { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['skuCode', 'quantity'],
            properties: {
              skuCode: { type: 'string' },
              quantity: { type: 'integer' },
              channel: { type: 'string', enum: ['WEB', 'APP', 'POS'] },
            },
          },
        },
      },
    },
    responses: {
      '201': {
        description: '创建成功',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['itemId', 'orderId', 'lineTotal'],
              properties: {
                itemId: { type: 'string' },
                orderId: { type: 'string' },
                lineTotal: { type: 'number' },
              },
            },
          },
        },
      },
    },
    raw: {},
  };

  const tsSdk = buildOperationTypeScriptSdk(sampleOperation, sampleProject);
  assert.match(tsSdk, /export interface PostOrdersByOrderIdItemsParams \{\s+orderId: string;\s+dryRun\?: boolean;\s+\}/);
  assert.match(tsSdk, /export interface PostOrdersByOrderIdItemsBody \{/);
  assert.match(tsSdk, /skuCode: string;/);
  assert.match(tsSdk, /quantity: number;/);
  assert.match(tsSdk, /channel\?: "WEB" \| "APP" \| "POS";/);
  assert.match(tsSdk, /export interface PostOrdersByOrderIdItemsResponse \{/);
  assert.match(tsSdk, /export async function postOrdersByOrderIdItems\(/);
  assert.match(tsSdk, /https:\/\/api\.shop\.internal\/staging/);
  assert.match(tsSdk, /encodeURIComponent\(String\(params\.orderId\)\)/);
  assert.match(tsSdk, /Authorization: `Bearer \$\{options\.token\}`/);

  const goSnippet = buildOperationGoClientSnippet(sampleOperation, sampleProject);
  assert.match(goSnippet, /type PostOrdersByOrderIdItemsRequest struct \{/);
  assert.match(goSnippet, /SkuCode string `json:"skuCode"`/);
  assert.match(goSnippet, /Channel string `json:"channel,omitempty"`/);
  assert.match(goSnippet, /type PostOrdersByOrderIdItemsResponse struct \{/);
  assert.match(goSnippet, /ItemID string `json:"itemId"`/);
  assert.match(goSnippet, /func PostOrdersByOrderIdItems\(ctx context\.Context, httpClient \*http\.Client, payload PostOrdersByOrderIdItemsRequest, bearerToken string\)/);

  const contractTest = buildOperationContractTestSnippet(sampleOperation, sampleProject);
  assert.match(contractTest, /import test from 'node:test';/);
  assert.match(contractTest, /assert\.equal\(response\.status, 201/);
  assert.match(contractTest, /assert\.ok\("itemId" in payload/);
  assert.match(contractTest, /assert\.ok\("lineTotal" in payload/);

  assert.equal(buildOperationCodegenSnippet('typescript', sampleOperation, sampleProject), tsSdk);
  const aiPrompt = buildOperationAgentPrompt(sampleOperation, sampleProject, 'typescript');
  assert.match(aiPrompt, /参考 TypeScript SDK 调用骨架/);
  assert.match(aiPrompt, /postOrdersByOrderIdItems/);
});

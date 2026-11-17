import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createApiModelAdapter, parseRetryAfterMs } from '../server/api-model-runtime.js';
// @ts-expect-error ESM module without full TS signature
import { createAutomationSchedulerTick } from '../server/jira-backend/automation-scheduler.mjs';
// @ts-expect-error ESM module without full TS signature
import {
  clearAutomationScanFailureState,
  computeAutomationScheduleBackoffMs,
  getNextAutomationRun,
  recordAutomationScanFailureState,
  shouldDeferScheduledScan,
} from '../server/jira-backend/automation-core.mjs';
import { createWecomIntegration, splitWecomMessageParts } from '../server/wecom-integration.js';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';
import { createJiraFixService } from '../server/jira-fix.js';
import { createRequirementDevelopmentService } from '../server/requirement-development.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { createJiraDevSync } from '../server/jira-dev-sync.js';
import type { AgentRun, AgentRuntimeHealth, AgentProvider } from '../shared/agent-runtime.js';
import type { AgentTaskPlan } from '../shared/agent-task-plan.js';
import type { JiraIssue, ProjectsData } from '../shared/hub.js';
import type { RequirementDevelopmentInput } from '../shared/requirement-development.js';

const exec = promisify(execFile);

async function httpEndpoint(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    },
  };
}

function makeApiRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'round12-api-run',
    provider: 'api',
    mode: 'ask',
    accessMode: 'workspace',
    model: 'deepseek-r12',
    reasoningEffort: '',
    objective: '分析这段状态机',
    workspacePath: '',
    branch: '',
    headSha: '',
    status: 'running',
    sessionId: '',
    pid: null,
    result: '',
    error: '',
    events: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

test('Round 12 [Fourth-6]: API 执行器支持 429/502/503/504 退避重试（含 Retry-After）且对 401 立即失败', async () => {
  assert.equal(parseRetryAfterMs('2', 500, 15_000), 2000);
  assert.equal(parseRetryAfterMs('99', 500, 5_000), 5000);
  assert.equal(parseRetryAfterMs(null, 600, 15_000), 600);

  let attempts = 0;
  const lifecycleEvents: string[] = [];
  const service = await httpEndpoint((req, res) => {
    attempts += 1;
    if (req.url?.includes('/auth-fail')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('unauthorized');
      return;
    }
    if (attempts === 1) {
      res.writeHead(429, { 'Retry-After': '0.02' });
      res.end('rate limited');
      return;
    }
    if (attempts === 2) {
      res.writeHead(503);
      res.end('service busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"重试后成功"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });

  try {
    const adapter = createApiModelAdapter({
      models: () => [
        { id: 'm1', modelId: 'deepseek-r12', label: 'DeepSeek', api: { baseUrl: service.url } },
        { id: 'm2', modelId: 'unauth-model', label: 'Unauth', api: { baseUrl: `${service.url}/auth-fail` } },
      ],
      apiKey: async () => 'fixture-token',
      history: () => [],
      maxRetries: 2,
      retryBaseDelayMs: 15,
    });

    const text = await adapter.execute({
      run: makeApiRun(),
      imagePaths: [],
      fileAttachments: [],
      signal: new AbortController().signal,
      onPid() {},
      onSession() {},
      onEvent(_kind, detail) { lifecycleEvents.push(detail); },
    });

    assert.equal(text, '重试后成功');
    assert.equal(attempts, 3);
    assert.equal(lifecycleEvents.filter(item => item.includes('重试')).length, 2);

    const beforeAuthFail = attempts;
    await assert.rejects(
      adapter.execute({
        run: makeApiRun({ model: 'unauth-model' }),
        imagePaths: [],
        fileAttachments: [],
        signal: new AbortController().signal,
        onPid() {},
        onSession() {},
        onEvent() {},
      }),
      /HTTP 401/,
    );
    // 401 不可重试，只请求 1 次
    assert.equal(attempts, beforeAuthFail + 1);
  } finally {
    await service.close();
  }
});

test('Round 12 [Fourth-6]: API 执行器按分片空闲超时（持续流式超过单窗口总时长仍成功，卡死流及时中断）', async () => {
  const service = await httpEndpoint(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url?.includes('/stalled')) {
      res.write('data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n');
      return;
    }
    for (const part of ['第一段、', '第二段、', '第三段、', '第四段']) {
      await new Promise(resolve => setTimeout(resolve, 30));
      res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(part)}}}]}\n\n`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    res.end();
  });

  try {
    const adapter = createApiModelAdapter({
      models: () => [
        { id: 's1', modelId: 'deepseek-r12', label: 'Active Stream', api: { baseUrl: service.url } },
        { id: 's2', modelId: 'stalled-model', label: 'Stalled Stream', api: { baseUrl: `${service.url}/stalled` } },
      ],
      apiKey: async () => '',
      history: () => [],
      idleTimeoutMs: 85, // 总流时长 ~145ms > 85ms，但相邻分片间隔 <= 30ms < 85ms
    });

    const completed = await adapter.execute({
      run: makeApiRun(),
      imagePaths: [],
      fileAttachments: [],
      signal: new AbortController().signal,
      onPid() {},
      onSession() {},
      onEvent() {},
    });
    assert.equal(completed, '第一段、第二段、第三段、第四段');

    await assert.rejects(
      adapter.execute({
        run: makeApiRun({ model: 'stalled-model' }),
        imagePaths: [],
        fileAttachments: [],
        signal: new AbortController().signal,
        onPid() {},
        onSession() {},
        onEvent() {},
      }),
      /模型 API 请求超时/,
    );
  } finally {
    await service.close();
  }
});

test('Round 12 [P1-3 & Fourth-16]: 定时巡检失败写入运行记录，支持指数退避、连续失败熔断及节假日下一次运行计算', async () => {
  assert.equal(computeAutomationScheduleBackoffMs(1, 120_000), 120_000);
  assert.equal(computeAutomationScheduleBackoffMs(2, 120_000), 240_000);
  assert.equal(computeAutomationScheduleBackoffMs(3, 120_000), 480_000);

  // 2026-01-01 至 2026-01-03 为元旦放假，2026-01-04（周日）为官方调休补班日，getNextAutomationRun 应精准落到 1 月 4 日
  const nextRunIso = getNextAutomationRun(
    { enabled: true, dailyTime: '09:00', dailyTimes: ['09:00'] },
    new Date('2026-01-01T08:00:00+08:00'),
  );
  assert.ok(nextRunIso);
  assert.equal(new Date(nextRunIso).getDate(), 4);

  const state: Record<string, unknown> = {
    settings: { enabled: true, dailyTimes: ['09:00'] },
    lastScheduledSlot: '',
    runs: [],
    weeklyReport: { settings: { enabled: false, weekday: 5, time: '17:30' }, lastScheduledSlot: '' },
  };
  let currentNow = new Date(2026, 8, 18, 9, 5, 0);
  let scanAttempts = 0;
  const errors: string[] = [];

  const tick = createAutomationSchedulerTick({
    readState: async () => state,
    runScan: async (trigger: string, slot: string) => {
      scanAttempts += 1;
      recordAutomationScanFailureState(state, {
        trigger,
        scheduledSlot: slot,
        errorMessage: `Jira 网关异常 #${scanAttempts}`,
        now: currentNow,
        maxFailures: 3,
        baseDelayMs: 120_000,
      });
      throw new Error(`Jira 网关异常 #${scanAttempts}`);
    },
    runWeeklyReport: async () => {},
    reconcile: async () => {},
    onError: (name: string) => { errors.push(name); },
    now: () => currentNow,
  });

  // 第一次失败：写入失败记录，设 2 分钟退避
  await tick();
  assert.equal(scanAttempts, 1);
  assert.equal((state.runs as { status: string }[]).length, 1);
  assert.equal((state.lastRun as { status: string; consecutiveFailures: number }).status, 'failed');
  assert.equal((state.lastRun as { consecutiveFailures: number }).consecutiveFailures, 1);
  assert.equal(shouldDeferScheduledScan(state, '2026-09-18 09:00', new Date(currentNow.getTime() + 60_000)), true);

  // 1 分钟后 tick：处于退避窗口，不重复轰炸 Jira
  currentNow = new Date(currentNow.getTime() + 60_000);
  await tick();
  assert.equal(scanAttempts, 1);

  // 再过 2 分钟（超过 120s 退避）：触发第 2 次重试
  currentNow = new Date(currentNow.getTime() + 120_000);
  await tick();
  assert.equal(scanAttempts, 2);
  assert.equal((state.lastRun as { consecutiveFailures: number }).consecutiveFailures, 2);

  // 跨过 240s 退避后触发第 3 次失败：达到 maxFailures=3 熔断该 slot，停止无限重试
  currentNow = new Date(currentNow.getTime() + 300_000);
  await tick();
  assert.equal(scanAttempts, 3);
  assert.equal((state.lastRun as { exhausted?: boolean }).exhausted, true);
  assert.equal(state.lastScheduledSlot, '2026-09-18 09:00');

  // 后续每分钟 tick 不再重试已熔断的同一 slot
  currentNow = new Date(currentNow.getTime() + 600_000);
  await tick();
  assert.equal(scanAttempts, 3);
  assert.equal(errors.length, 3);

  clearAutomationScanFailureState(state);
  assert.equal(state.scheduleFailureCount, 0);
});

test('Round 12 [P1-2 & Fourth-17]: 企业微信 4xx 判为 failed、unknown 人工核对解除及超长 Markdown 安全分段发送', async t => {
  const chunks = splitWecomMessageParts(
    `# 发布说明\n\n\`\`\`json\n${Array.from({ length: 160 }, (_, i) => `  "field_${i}": "中文说明值_${i}"`).join(',\n')}\n\`\`\`\n\n收尾确认。`,
    'markdown_v2',
  );
  assert.ok(chunks.length >= 2);
  for (const part of chunks) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 4096);
    // 每段代码块围栏成对闭合，不在群里破坏 Markdown 渲染
    assert.equal((part.match(/```/g) || []).length % 2, 0);
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'round12-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'wecom.json');
  let mode: 'http400' | 'http502' | 'ok' = 'http400';
  let calls = 0;

  const service = await createWecomIntegration(directory, {
    configFile,
    fetch: async () => {
      calls += 1;
      if (mode === 'http400') return new Response('bad payload', { status: 400 });
      if (mode === 'http502') return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    },
  });
  await service.configure({
    groupName: '测试群',
    webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=round12-fixture-key',
  });

  // 1) HTTP 400 明确判为 failed，修正后可直接重发同一预览
  const single = service.messagePreview({ title: '单条通知', msgtype: 'text', content: '联调结果同步' });
  const r400 = await service.sendMessage({ input: single.input, previewId: single.previewId, hash: single.hash });
  assert.equal(r400.record.status, 'failed');
  assert.match(r400.message, /HTTP 400/);

  // 2) HTTP 502 记为 unknown；人工核对“未送达”后解除重复锁定并允许重发
  mode = 'http502';
  const r502 = await service.sendMessage({ input: single.input, previewId: single.previewId, hash: single.hash });
  assert.equal(r502.record.status, 'unknown');
  const blockedResend = await service.sendMessage({ input: single.input, previewId: single.previewId, hash: single.hash });
  assert.equal(blockedResend.record.id, r502.record.id);
  assert.equal(calls, 2);

  const reconciled = await service.reconcileUnknown({
    kind: 'message',
    id: r502.record.id,
    outcome: 'not_delivered',
    note: '已查看企业微信群确认无此消息',
  });
  assert.equal(reconciled.record.status, 'failed');
  assert.ok(reconciled.record.reconciledAt);

  mode = 'ok';
  const resent = await service.sendMessage({ input: single.input, previewId: single.previewId, hash: single.hash });
  assert.equal(resent.record.status, 'sent');
  assert.equal(calls, 3);

  // 3) 联调反馈 report 的 unknown 同样支持确认“已送达”并留痕
  const catalogItem = buildReviewCatalog().find(item => item.path === '/admin/v1/merchants/detail')!;
  const fbPreview = service.preview({
    interfaceId: catalogItem.id,
    summary: '分页参数异常',
    environment: 'DEV',
    parameters: '{"page":1}',
    actual: '500',
    expected: '200',
    contractReference: 'v1',
    traceId: 'tr-1',
  });
  mode = 'http502';
  const fbUnknown = await service.send({ input: fbPreview.input, hash: fbPreview.hash });
  assert.equal(fbUnknown.record.status, 'unknown');
  const fbDelivered = await service.reconcileUnknown({
    kind: 'report',
    id: fbUnknown.record.id,
    outcome: 'delivered',
    note: '群内已收到该反馈',
  });
  assert.equal(fbDelivered.record.status, 'sent');

  // 4) 超长消息分段预览与顺序发送
  mode = 'ok';
  const longText = Array.from({ length: 90 }, (_, idx) => `第 ${idx + 1} 项检查结论：接口字段契约一致，已核对响应结构`).join('\n');
  const partsPreview = service.messagePartsPreview({ title: '长篇巡检汇总', msgtype: 'text', content: longText });
  assert.ok(partsPreview.partCount >= 2);
  const partsResult = await service.sendMessageParts({
    input: { title: '长篇巡检汇总', msgtype: 'text', content: longText },
    batchId: partsPreview.batchId,
    partIds: partsPreview.parts.map(p => p.previewId),
    hash: partsPreview.hash,
  });
  assert.equal(partsResult.records.length, partsPreview.partCount);
  assert.ok(partsResult.records.every(item => item.status === 'sent'));
});

test('Round 12 [P1-2]: Jira 修复与需求开发的 uncertain 记录支持只读核对后人工解除（未启动解锁重试 / 已启动绑定会话）', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'round12-uncertain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const existingRun = {
    id: 'verified-run-id',
    status: 'completed',
    error: '',
  } as AgentRun;

  // --- A. Jira Fix uncertain 核对与解除 ---
  const fixDir = path.join(root, 'jira-fix');
  await fs.mkdir(fixDir, { recursive: true });
  const fixRecordId = randomUUID();
  const fixInput = {
    issueKey: 'APEX-801',
    repository: 'git@example.test:team/repo.git',
    parentDirectory: root,
    baseBranch: 'main',
    branch: 'feature/APEX-801',
    notes: '',
    rememberProject: false,
  };
  await fs.writeFile(
    path.join(fixDir, `${fixRecordId}.json`),
    JSON.stringify({
      id: fixRecordId,
      input: fixInput,
      status: 'starting',
      workspacePath: path.join(root, 'ws'),
      headSha: 'abc1234',
      runId: '',
      error: '',
      createdAt: '2026-11-16T01:00:00.000Z',
    }),
  );

  let startedFixCount = 0;
  const fixService = await createJiraFixService(
    fixDir,
    {
      findJiraFix: () => undefined,
      getRun: id => (id === existingRun.id ? existingRun : undefined),
      startJiraFix: async () => {
        startedFixCount += 1;
        return { ...existingRun, id: `new-fix-run-${startedFixCount}` };
      },
    },
    {
      readJiraFixIssue: async key => ({ key, url: `https://jira.example.test/browse/${key}`, project: 'APEX', projectName: 'APEX', summary: '测试问题', status: '待办', parent: null } as JiraIssue),
      readLocalProjects: async () => ({ projects: [] } as unknown as ProjectsData),
    },
    async () => ({ workspacePath: path.join(root, 'ws-new'), headSha: 'def5678' }),
  );

  try {
    assert.equal(fixService.list()[0]?.status, 'uncertain');
    assert.throws(
      () => fixService.start({ requestId: randomUUID(), input: { ...fixInput, notes: '重试启动' }, authorization: 'clone-and-fix-jira' }),
      /待核对/,
    );
    // 虚假声明 started 但无真实会话应被拒绝
    await assert.rejects(
      fixService.reconcileUncertain(fixRecordId, { outcome: 'started', runId: 'missing-run', note: '', authorization: 'reconcile-uncertain-jira-fix' }),
      /未核实到/,
    );
    // 确认未启动 -> 解除锁定并留痕，随后同一 Jira 可重新发起修复
    const unlockedFix = await fixService.reconcileUncertain(fixRecordId, {
      outcome: 'not_started',
      note: '重启前尚未创建会话',
      authorization: 'reconcile-uncertain-jira-fix',
    });
    assert.equal(unlockedFix.status, 'failed');
    assert.match(unlockedFix.error, /人工核对确认未启动/);
    assert.ok(unlockedFix.reconciledAt);

    const restartedFix = fixService.start({
      requestId: randomUUID(),
      input: { ...fixInput, notes: '解锁后重新启动' },
      authorization: 'clone-and-fix-jira',
    });
    assert.notEqual(restartedFix.id, fixRecordId);
  } finally {
    await fixService.close();
  }

  // --- B. Requirement Development uncertain 核对与绑定既有会话 ---
  const reqDir = path.join(root, 'req-dev');
  await fs.mkdir(reqDir, { recursive: true });
  const reqId1 = randomUUID();
  const reqId2 = randomUUID();
  const reqInput: RequirementDevelopmentInput = {
    title: '支持跨境结算导出',
    issueKey: 'APEX-902',
    prdUrl: '',
    requirement: '',
    project: '',
    fixVersion: '',
    assignee: '',
    startDate: '2026-11-16',
    endDate: '2026-11-18',
    repository: 'git@example.test:team/repo.git',
    parentDirectory: root,
    branch: 'feature/APEX-902',
    confluenceParentUrl: '',
  };
  for (const [id, key] of [[reqId1, 'APEX-902'], [reqId2, 'APEX-903']] as const) {
    await fs.writeFile(
      path.join(reqDir, `${id}.json`),
      JSON.stringify({
        id,
        input: { ...reqInput, issueKey: key, branch: `feature/${key}` },
        status: 'starting',
        workspacePath: path.join(root, key),
        headSha: 'abc',
        runId: '',
        error: '',
        createdAt: '2026-11-16T01:00:00.000Z',
      }),
    );
  }

  const reqService = await createRequirementDevelopmentService(
    reqDir,
    {
      findRequirementDevelopment: () => undefined,
      getRun: id => (id === existingRun.id ? existingRun : undefined),
      startRequirementDevelopment: async () => ({ ...existingRun, id: 'fresh-req-run' }),
    },
    async () => ({ workspacePath: path.join(root, 'fresh'), headSha: '999' }),
  );

  try {
    // reqId1 绑定已核实存在的会话
    const linked = await reqService.reconcileUncertain(reqId1, {
      outcome: 'started',
      runId: existingRun.id,
      note: '已核对运行列表存在原会话',
      authorization: 'reconcile-uncertain-requirement',
    });
    assert.equal(linked.status, 'started');
    assert.equal(linked.runId, existingRun.id);

    // reqId2 确认未启动后解锁，允许新请求重新发起
    const unlockedReq = await reqService.reconcileUncertain(reqId2, {
      outcome: 'not_started',
      note: '工作区为空且无会话',
      authorization: 'reconcile-uncertain-requirement',
    });
    assert.equal(unlockedReq.status, 'failed');
    const retriedReq = await reqService.start({
      requestId: randomUUID(),
      input: { ...reqInput, issueKey: 'APEX-903', branch: 'feature/APEX-903', title: '解锁后重跑' },
      authorization: 'create-jira-design-transition-and-develop',
    });
    assert.equal(retriedReq.status, 'started');
  } finally {
    await reqService.close();
  }
});

test('Round 12 [P1-9 & P1-6 & P1-27]: 团队复验死循环熔断、研发助手同步默认关闭与可配置公钥、侧栏/群聊二次确认契约', async t => {
  // 1) P1-6: 默认分享包不传 fetchImpl/manifestUrl 时关闭外部云同步，不向个人站点发请求；自定义源+自定义公钥可校验
  const syncRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'round12-sync-'));
  t.after(() => fs.rm(syncRoot, { recursive: true, force: true }));
  const disabledSync = createJiraDevSync({
    jiraDevDirectory: path.join(syncRoot, 'jira-dev'),
    dataDirectory: path.join(syncRoot, 'data'),
  });
  const disabledStatus = await disabledSync.status();
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.updateAvailable, false);
  await assert.rejects(
    disabledSync.sync({ expectedVersion: '2.0.0', expectedSha256: 'a'.repeat(64) }),
    /默认关闭/,
  );

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = Buffer.from(JSON.stringify({
    plugin: 'jira-dev-workbench',
    version: '2.1.0',
    publishedAt: '2026-11-16T00:00:00Z',
    notes: ['支持自定义签名公钥与更新源'],
    download: { url: 'https://updates.internal.example/release.zip', sha256: 'b'.repeat(64), size: 128 },
    installation: { releaseRoot: 'rel', pluginDirectory: 'pkg' },
  }));
  const signedEnvelope = JSON.stringify({
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  });
  const customSync = createJiraDevSync({
    jiraDevDirectory: path.join(syncRoot, 'jira-dev'),
    dataDirectory: path.join(syncRoot, 'data'),
    manifestUrl: 'https://updates.internal.example/latest.json',
    publicKeyPem,
    fetchImpl: async url => {
      assert.equal(String(url), 'https://updates.internal.example/latest.json');
      return new Response(signedEnvelope, { status: 200 });
    },
  });
  const customStatus = await customSync.status();
  assert.equal(customStatus.enabled, true);
  assert.equal(customStatus.updateAvailable, true);
  assert.equal(customStatus.latest.version, '2.1.0');

  // 2) P1-9: 团队审查期间持续改写工作区时，超过 maxReverifyCount 自动熔断转为 needs_decision
  const teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'round12-team-'));
  t.after(() => fs.rm(teamRoot, { recursive: true, force: true }));
  const source = path.join(teamRoot, 'repo');
  const data = path.join(teamRoot, 'data');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/value.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(source, '.gitignore'), '.delivery-artifacts/\n');
  await exec('git', ['-C', source, 'init', '-q', '-b', 'main']);
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'init']);

  const report = (value: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...(value as object) })}\n\`\`\``;
  const taskPlan: AgentTaskPlan = {
    templateId: 'engineering',
    reason: '验证复验熔断',
    risk: 'low',
    acceptanceCriteria: [{ id: 'AC-1', text: '保持一致', source: '测试' }],
    allowedPaths: ['src/**'],
    needsAnalyst: false,
    needsArchitect: false,
    questions: [],
    risks: [],
    ownership: [],
    shared: [],
  };
  const providerHealth = (provider: AgentProvider): AgentRuntimeHealth => ({
    provider,
    label: provider,
    binary: `/mock/${provider}`,
    version: '1.0',
    authenticated: true,
    ready: true,
    message: 'ready',
    modes: ['agent', 'ask', 'plan'],
    models: provider === 'codex'
      ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
      : provider === 'claude'
        ? ['sonnet', 'opus', 'fable'].map(id => ({ id, label: id === 'sonnet' ? 'Sonnet 5.5' : id === 'opus' ? 'Opus 5.5' : 'Fable 5.1', efforts: ['low', 'medium', 'high'] }))
        : [{ id: 'composer-2.5', label: 'Composer 2.5' }],
    defaultModel: '',
    writable: true,
    checkedAt: new Date().toISOString(),
  });

  let reviewEdits = 0;
  const adapters: AgentRuntimeAdapter[] = (['codex', 'claude', 'cursor'] as const).map(provider => ({
    id: provider,
    health: async () => providerHealth(provider),
    execute: async ctx => {
      await ctx.onSession(`${provider}-${ctx.run.id}`);
      const role = ctx.run.team?.profileId;
      if (!role) return 'ok';
      if (role === 'leader') return report({ taskPlan });
      if (role === 'engineer') {
        await fs.writeFile(path.join(ctx.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
        return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已完成最小修改' } });
      }
      if (role === 'verifier') {
        return report({
          validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'node --test 退出码0', sha: '' } },
          taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '真实夹具内容核验' }] },
        });
      }
      if (role === 'reviewer') {
        reviewEdits += 1;
        // 模拟审查岗位每轮都篡改候选文件，触发无限复验风险
        await fs.writeFile(path.join(ctx.run.workspacePath, 'src/value.js'), `export const value = ${100 + reviewEdits};\n`);
        return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [] } });
      }
      return 'ok';
    },
  }));

  const runtime = await createAgentRuntimeService(data, { adapters });
  const team = await createAgentTeamService(data, runtime, { maxReverifyCount: 2 });
  try {
    const main = await runtime.start({ provider: 'codex', model: 'gpt-6.1-sol', mode: 'ask', objective: 'init', workspacePath: source });
    for (let i = 0; i < 200 && !runtime.getRun(main.id)?.resultReady; i++) await new Promise(r => setTimeout(r, 10));
    const created = await team.create(main.id, { objective: '验证无限复验熔断', attachmentIds: [], requestId: 'r12-create' });
    for (let i = 0; i < 200 && team.getTask(created.id).state !== 'awaiting_plan'; i++) await new Promise(r => setTimeout(r, 10));
    await team.plan(created.id, { expectedRevision: team.getTask(created.id).planRevision, action: 'confirm', requestId: 'r12-confirm' });
    for (let i = 0; i < 400 && !['needs_decision', 'blocked', 'awaiting_acceptance'].includes(team.getTask(created.id).state); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    const settled = team.getTask(created.id);
    assert.equal(settled.state, 'needs_decision', settled.reason || '');
    assert.equal(settled.reverifyCount, 3);
    assert.match(settled.reason || '', /超过自动复验上限 2 次/);
  } finally {
    await team.close();
    await runtime.close();
  }

  // 3) P1-27: 核验侧栏“上下文 / 知识”入口按钮及群聊“移除此角色”二次确认组件存在
  const sidePanelVue = await fs.readFile(new URL('../src/features/agent-workbench/AgentSidePanel.vue', import.meta.url), 'utf8');
  assert.match(sidePanelVue, /selectTab\('context'\)/);
  assert.match(sidePanelVue, /selectTab\('knowledge'\)/);
  const groupChatVue = await fs.readFile(new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8');
  assert.match(groupChatVue, /<el-popconfirm[^>]*@confirm="removeRole"/);
});

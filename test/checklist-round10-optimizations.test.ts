import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  claudeChildEnvironment,
  cliChildEnvironment,
  codexChildEnvironment,
} from '../server/cli-runtime.js';
import {
  applySecurityResponseHeaders,
  isAllowedLocalHostHeader,
  isExactJsonContentType,
  readUtf8JsonBody,
  resolveWorkspaceServicePort,
} from '../server/http-security.js';
import { createLanGateway } from '../server/lan-gateway.js';
import {
  executeProjectGitAction,
  readProjectGitSnapshot,
  sanitizeEnvLineValue,
} from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';
import { isJiraIssueDone, isJiraIssueTodo } from '../shared/jira-status.mjs';
import {
  chinaWorkingDates,
  getChinaWorkCalendarCoverage,
  registerChinaWorkCalendar,
  resetCustomChinaWorkCalendars,
} from '../shared/china-work-calendar.mjs';
import { isDone } from '../src/shared/format.js';
import { deliveryRecords, plannedToday } from '../src/features/workbench/domain.js';
import { workspaceLocation } from '../src/pages/agent/workspace-navigation.js';
import type { CatchupData, JiraIssue, MergeData } from '../shared/hub.js';

// @ts-expect-error 原系统 ESM 模块无全量 TS 声明
const automationCore = await import('../server/jira-backend/automation-core.mjs');
// @ts-expect-error 原系统 ESM 模块无全量 TS 声明
const { createAutomationStateStore } = await import('../server/jira-backend/automation-state-store.mjs');
// @ts-expect-error 原系统 ESM 模块无全量 TS 声明
const { createWeeklyReportRun } = await import('../server/jira-backend/weekly-report.mjs');

const exec = promisify(execFile);

test('Round 10 · P0-1：Agent CLI 子进程环境白名单彻底剥离 Jira/Confluence/Codeup/Jenkins/企微等外部平台凭据并隔离跨执行器密钥', () => {
  const pollutedHostEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/tester',
    LANG: 'zh_CN.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    NODE_OPTIONS: '--inspect=9229',
    // 宿主 .env.local 注入的高敏外部系统凭据
    JIRA_API_TOKEN: 'jira-secret-token',
    JIRA_COOKIE: 'JSESSIONID=secret-cookie',
    CONFLUENCE_API_TOKEN: 'confluence-secret',
    WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret',
    JENKINS_API_TOKEN: 'jenkins-secret',
    YUNXIAO_TOKEN: 'yunxiao-secret',
    CODEUP_TOKEN: 'codeup-secret',
    APIFOX_ACCESS_TOKEN: 'apifox-secret',
    GITHUB_TOKEN: 'github-secret',
    GITLAB_TOKEN: 'gitlab-secret',
    DELIVERY_GATEWAY_WRITE_TOKEN: 'gateway-secret',
    // 各 CLI 专属变量与父会话干扰变量
    OPENAI_API_KEY: 'openai-key-for-codex',
    CODEX_CI: '1',
    CODEX_SESSION_ID: 'desktop-parent-session',
    ANTHROPIC_API_KEY: 'anthropic-key-for-claude',
    CLAUDE_CONFIG_DIR: '/Users/tester/.claude',
    CLAUDECODE: 'nested-claude',
    CURSOR_CUSTOM_FLAG: 'cursor-only',
    KIRO_PROFILE: 'kiro-only',
    AGY_ACCOUNT: 'agy-work',
  };

  const forbiddenKeys = [
    'JIRA_API_TOKEN', 'JIRA_COOKIE', 'CONFLUENCE_API_TOKEN', 'WECOM_WEBHOOK_URL',
    'JENKINS_API_TOKEN', 'YUNXIAO_TOKEN', 'CODEUP_TOKEN', 'APIFOX_ACCESS_TOKEN',
    'GITHUB_TOKEN', 'GITLAB_TOKEN', 'DELIVERY_GATEWAY_WRITE_TOKEN', 'NODE_OPTIONS',
  ];

  for (const provider of ['codex', 'claude', 'cursor', 'kiro', 'antigravity', 'deepseek', 'grok', 'workbuddy'] as const) {
    const env = cliChildEnvironment(provider, pollutedHostEnv);
    for (const secretKey of forbiddenKeys) {
      assert.equal(env[secretKey], undefined, `${provider} 子进程严禁继承宿主敏感变量 ${secretKey}`);
    }
    assert.equal(env.PATH, pollutedHostEnv.PATH);
    assert.equal(env.HOME, pollutedHostEnv.HOME);
    assert.equal(env.HTTPS_PROXY, pollutedHostEnv.HTTPS_PROXY);
  }

  // Codex 仅保留 OPENAI_/CODEX_（且剥离桌面父会话 ID），不继承 ANTHROPIC_API_KEY
  const codexEnv = codexChildEnvironment(pollutedHostEnv);
  assert.equal(codexEnv.OPENAI_API_KEY, 'openai-key-for-codex');
  assert.equal(codexEnv.CODEX_CI, '1');
  assert.equal(codexEnv.CODEX_SESSION_ID, undefined);
  assert.equal(codexEnv.ANTHROPIC_API_KEY, undefined);

  // Claude 仅保留 CLAUDE_/ANTHROPIC_，剥离 CLAUDECODE 与 OPENAI_API_KEY
  const claudeEnv = claudeChildEnvironment(pollutedHostEnv);
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, 'anthropic-key-for-claude');
  assert.equal(claudeEnv.CLAUDE_CONFIG_DIR, '/Users/tester/.claude');
  assert.equal(claudeEnv.DISABLE_AUTOUPDATER, '1');
  assert.equal(claudeEnv.CLAUDECODE, undefined);
  assert.equal(claudeEnv.OPENAI_API_KEY, undefined);

  // Kiro 支持 extra 参数注入受控隔离目录
  const kiroEnv = cliChildEnvironment('kiro', pollutedHostEnv, { KIRO_AGENT_CONFIG_DIR: '/tmp/kiro-isolated' });
  assert.equal(kiroEnv.KIRO_PROFILE, 'kiro-only');
  assert.equal(kiroEnv.KIRO_AGENT_CONFIG_DIR, '/tmp/kiro-isolated');
  assert.equal(kiroEnv.OPENAI_API_KEY, undefined);
});

test('Round 10 · P0-4：统一 Jira 状态判定引擎彻底消除「未完成 / 待完成 / 开发完成 / 待验收」误判并统一各模块口径', () => {
  const mustNotBeDone = [
    { status: '未完成', statusCategory: '处理中' },
    { status: '待完成', statusCategory: '待办' },
    { status: '未关闭', statusCategory: '' },
    { status: '开发完成', statusCategory: 'In Progress' },
    { status: '编码完成', statusCategory: '处理中' },
    { status: '联调完成', statusCategory: '处理中' },
    { status: '测试完成', statusCategory: '处理中' },
    { status: '待提测', statusCategory: '处理中' },
    { status: '待验收', statusCategory: '' },
    { status: '重新打开', statusCategory: 'To Do' },
    { status: 'Reopened', statusCategory: 'To Do' },
  ];

  for (const item of mustNotBeDone) {
    assert.equal(isJiraIssueDone(item), false, `不应将 "${item.status}" 误判为已完成`);
    assert.equal(automationCore.isIssueDone(item), false);
    assert.equal(isDone(item), false);
  }

  const mustBeDone = [
    { status: '已完成', statusCategory: '完成' },
    { status: '完成', statusCategory: '' },
    { status: '已关闭', statusCategory: 'Done' },
    { status: '关闭', statusCategory: '' },
    { status: '已解决', statusCategory: 'Done' },
    { status: '已上线', statusCategory: '' },
    { status: 'Done', statusCategory: 'done' },
    { status: 'Closed', statusCategory: '' },
    { status: { name: '已完成' }, statusCategory: { key: 'done', name: '完成' } },
  ];

  for (const item of mustBeDone) {
    assert.equal(isJiraIssueDone(item), true);
    assert.equal(automationCore.isIssueDone(item), true);
  }

  assert.equal(isJiraIssueTodo({ status: '待完成', statusCategory: '待办' }), true);
  assert.equal(isJiraIssueTodo({ status: '开发中', statusCategory: '处理中' }), false);

  // 今日计划与周报不再漏计「未完成 / 开发完成」的进行中事项
  const unfinishedIssue = {
    key: 'APEX-801',
    summary: '【订单中心】接口重构',
    status: '未完成',
    statusCategory: 'In Progress',
    startDate: '2026-09-14',
    endDate: '2026-09-18',
    updated: '2026-09-18T10:00:00+08:00',
  } as JiraIssue;
  assert.equal(plannedToday(unfinishedIssue, '2026-09-16'), true);

  const weekly = createWeeklyReportRun({
    now: new Date(2026, 8, 18, 18, 0),
    source: 'jira',
    issues: [unfinishedIssue],
    jobs: [],
    automationRuns: [],
  });
  assert.equal(weekly.completedCount, 0);
  assert.equal(weekly.inProgressCount, 1);
});

test('Round 10 · P0-3 & P1-7：自动拆分绝不劫持人工子任务 + 自动化状态文件损坏隔离恢复与防覆盖保护', async () => {
  // 1. P0-3：即使人工子任务日期完全重合，没有切片标记也绝不被认领或篡改
  const humanSubtask = {
    key: 'GBP-101',
    summary: '后端数据库索引评估（张三手工建单）',
    labels: ['backend'],
    description: '人工创建的子任务，不能被前端排期拆分器改写',
    startDate: '2026-11-16',
    endDate: '2026-11-18',
  };
  const managedSubtask = {
    key: 'GBP-102',
    summary: '【3天进度切片 2/2】完成登录页改造',
    labels: ['delivery-3-day-split', 'delivery-segment-2-of-2'],
    description: 'delivery-3-day-split/delivery-segment-2-of-2',
    startDate: '2026-11-19',
    endDate: '2026-11-20',
  };

  const matchedSeg1 = automationCore.findMatchingManagedSegmentSubtask(
    [humanSubtask, managedSubtask],
    new Set(),
    { marker: 'delivery-segment-1-of-2', expectedSummary: '【3天进度切片 1/2】完成登录页改造' },
  );
  assert.equal(matchedSeg1, undefined, '严禁兜底认领无标记的人工子任务');

  const matchedSeg2 = automationCore.findMatchingManagedSegmentSubtask(
    [humanSubtask, managedSubtask],
    new Set(),
    { marker: 'delivery-segment-2-of-2', expectedSummary: '【3天进度切片 2/2】完成登录页改造' },
  );
  assert.equal(matchedSeg2?.key, 'GBP-102');

  // 2. P1-7 & 第七节 #10：状态文件 0600 写入、.bak 备份自愈、无备份损坏时拒绝写覆盖
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round10-state-'));
  try {
    const stateFile = path.join(tempDir, 'automation-state.json');
    const store = createAutomationStateStore(stateFile, {
      makeDefaultState: () => ({ version: 1, jobs: [], runs: [] }),
      normalizeLoadedState: (raw: Record<string, unknown>) => ({
        version: 1,
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
        runs: Array.isArray(raw.runs) ? raw.runs : [],
      }),
    });

    // 首次 ENOENT 返回默认空状态
    const initial = await store.readState({ forWrite: true });
    assert.deepEqual(initial, { version: 1, jobs: [], runs: [] });

    // 第一次写入 + 第二次写入自动生成 0600 .bak
    await store.writeState({ version: 1, jobs: [{ id: 'job-1' }], runs: [] });
    const stat = await fs.stat(stateFile);
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600);
    }
    await store.writeState({ version: 1, jobs: [{ id: 'job-1' }, { id: 'job-2' }], runs: ['r1'] });

    // 模拟主文件被截断写坏 -> 自动从 .bak 恢复并隔离 .corrupt 文件
    await fs.writeFile(stateFile, '{"version":1, "jobs": [BROKEN_JSON', 'utf8');
    const recovered = await store.readState({ forWrite: true });
    assert.equal(recovered.jobs.length, 1);
    assert.equal(recovered.jobs[0].id, 'job-1');
    const filesInDir = await fs.readdir(tempDir);
    assert.ok(filesInDir.some(name => name.includes('.corrupt-')), '应保留损坏现场副本供排查');

    // 若主文件与 .bak 同时损坏或无 .bak：写路径必须抛错阻止覆盖原文件！
    await fs.unlink(store.backupFilePath);
    await fs.writeFile(stateFile, '{CORRUPT_WITHOUT_BAK', 'utf8');
    await assert.rejects(
      () => store.readState({ forWrite: true }),
      /拒绝覆盖原文件/,
    );
    const readOnlyDegraded = await store.readState({ forWrite: false });
    assert.match(readOnlyDegraded.stateReadError, /内存降级只读视图/);
    // 磁盘上的原损坏文件未被清空覆盖
    assert.equal(await fs.readFile(stateFile, 'utf8'), '{CORRUPT_WITHOUT_BAK');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Round 10 · 第七节 #1/#2/#6/#8 & P0-2：跨 TCP 分片多字节中文无损解析、DNS Rebinding 防护、防嵌入头与网关配对写令牌', async (t: TestContext) => {
  // 1. 将包含中文（3字节 UTF-8）与 Emoji（4字节 UTF-8）的 JSON 故意在多字节字符中间拆成单字节流
  const originalObj = {
    file: 'src/中文组件.vue',
    content: 'export const title = "跨分片保存绝不产生乱码 🚀 交付稳健";',
  };
  const fullBytes = Buffer.from(JSON.stringify(originalObj), 'utf8');
  const fragmentedChunks: Buffer[] = [];
  for (let i = 0; i < fullBytes.length; i += 2) {
    fragmentedChunks.push(fullBytes.subarray(i, Math.min(i + 2, fullBytes.length)));
  }
  const parsed = await readUtf8JsonBody(Readable.from(fragmentedChunks), fullBytes.byteLength + 10);
  assert.deepEqual(parsed, originalObj);

  // 严格按字节数限流拦截
  await assert.rejects(
    () => readUtf8JsonBody(Readable.from([fullBytes]), fullBytes.byteLength - 1),
    /请求内容过大/,
  );

  // 2. Host 白名单、精确 Content-Type 与防嵌入安全头
  assert.equal(isAllowedLocalHostHeader('localhost:5288', 5288), true);
  assert.equal(isAllowedLocalHostHeader('127.0.0.1:5288', 5288), true);
  assert.equal(isAllowedLocalHostHeader('evil-dns-rebind.com:5288', 5288), false);
  assert.equal(isAllowedLocalHostHeader('localhost:9999', 5288), false);

  assert.equal(isExactJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isExactJsonContentType('text/plain; x=application/json'), false);
  assert.equal(resolveWorkspaceServicePort({ DELIVERY_PORT: '5288' }, 5199), 5288);

  const headerMap = new Map<string, string>();
  applySecurityResponseHeaders({
    hasHeader: (name: string) => headerMap.has(name.toLowerCase()),
    setHeader: (name: string, value: number | string | readonly string[]) => {
      headerMap.set(name.toLowerCase(), String(value));
      return undefined as unknown as http.ServerResponse;
    },
  });
  assert.equal(headerMap.get('x-frame-options'), 'DENY');
  assert.equal(headerMap.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(headerMap.get('x-content-type-options'), 'nosniff');

  // 3. 真实 HTTP 网关只读保护模式与配对写令牌（P0-2）
  const upstreamReceived: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((req, res) => {
    upstreamReceived.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const tokenGateway = createLanGateway(
    { address: '127.0.0.1', netmask: '255.0.0.0' },
    upstreamPort,
    ['127.0.0.1'],
    { writeToken: 'pair-token-round10' },
  );
  await new Promise<void>(resolve => tokenGateway.listen(0, '127.0.0.1', resolve));
  const gwPort = (tokenGateway.address() as { port: number }).port;

  const readOnlyGateway = createLanGateway(
    { address: '127.0.0.1', netmask: '255.0.0.0' },
    upstreamPort,
    ['127.0.0.1'],
    { readOnly: true },
  );
  await new Promise<void>(resolve => readOnlyGateway.listen(0, '127.0.0.1', resolve));
  const roPort = (readOnlyGateway.address() as { port: number }).port;

  t.after(async () => {
    for (const srv of [tokenGateway, readOnlyGateway, upstream]) {
      srv.closeAllConnections();
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  // 只读网关允许 GET，但拒绝伪造 Origin+Confirmed 的 POST
  const roGet = await fetch(`http://127.0.0.1:${roPort}/api/health`);
  assert.equal(roGet.status, 200);
  assert.equal(roGet.headers.get('x-frame-options'), 'DENY');
  const roPost = await fetch(`http://127.0.0.1:${roPort}/api/write`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${roPort}`,
      'Content-Type': 'application/json',
      'X-Delivery-Confirmed': 'yes',
    },
    body: '{}',
  });
  assert.equal(roPost.status, 403);

  // 配对令牌网关：未带令牌或带错令牌均 403，带正确令牌返回 200 且剥离令牌头不透传给上游
  const noTok = await fetch(`http://127.0.0.1:${gwPort}/api/write`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${gwPort}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(noTok.status, 403);

  const okTok = await fetch(`http://127.0.0.1:${gwPort}/api/write`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${gwPort}`,
      'Content-Type': 'application/json',
      'X-Delivery-Gateway-Token': 'pair-token-round10',
    },
    body: '{}',
  });
  assert.equal(okTok.status, 200);
  assert.equal(upstreamReceived.at(-1)?.['x-delivery-gateway-token'], undefined);
});

test('Round 10 · P1-1 & 第四节 #16：工作日历到期预警、动态导入 2027 日历及自动化巡检识别法定假日与调休补班', () => {
  try {
    const coverage = getChinaWorkCalendarCoverage('2026-11-16');
    assert.equal(coverage.latestYear, 2026);
    assert.equal(coverage.expiringSoon, true);
    assert.match(coverage.warning, /2026/);

    // 自动化巡检：2026-10-01（周四，国庆节法定休假）必须跳过；2026-10-10（周六，官方调休补班日）必须正常触发
    const settings = { enabled: true, dailyTimes: ['09:00', '19:00'] };
    assert.equal(automationCore.getDueAutomationSlot(settings, '', new Date(2026, 9, 1, 10, 0)), '');
    assert.equal(automationCore.getDueAutomationSlot(settings, '', new Date(2026, 9, 10, 10, 0)), '2026-10-10 09:00');

    // 动态导入 2027 自定义日历后可正常排期
    registerChinaWorkCalendar(2027, {
      notice: '2027 测试导入日历',
      holidays: [['01-01', '01-03']],
      workdays: ['01-09'],
    });
    assert.deepEqual(chinaWorkingDates('2027-01-01', '2027-01-05'), ['2027-01-04', '2027-01-05']);
    assert.equal(getChinaWorkCalendarCoverage('2026-11-16').expiringSoon, false);
  } finally {
    resetCustomChinaWorkCalendars();
  }
});

test('Round 10 · P1-19 & P1-20 & P1-22：真实本地 Git 删改/二进制冲突整文件采纳、Sequencer 状态识别、.env 换行注入拦截与前端断链修复', async () => {
  // 1. .env.local 换行注入拦截
  assert.throws(() => sanitizeEnvLineValue('JIRA_USERNAME', 'alice\nJIRA_API_TOKEN=injected'), /换行符/);
  assert.equal(sanitizeEnvLineValue('JIRA_USERNAME', 'alice'), 'alice');

  // 2. 前端旧路径与追平断链保参重定向
  assert.deepEqual(workspaceLocation('/delivery/handoff', { taskId: 'T-1' }), {
    path: '/agent',
    query: { taskId: 'T-1', view: 'queue' },
  });
  assert.deepEqual(workspaceLocation('/catchup/execution', { requirement: 'REQ-9' }), {
    path: '/agent',
    query: { requirement: 'REQ-9', view: 'queue' },
  });
  const catchupRecords = deliveryRecords(
    undefined,
    undefined,
    {
      requirements: [{
        id: 'REQ-9',
        title: '追平项',
        session: { status: 'running', jiraKey: 'APEX-9', threadId: '', workspacePath: '/tmp', branch: 'main', result: 'ok', error: '', updatedAt: '2026-11-16T00:00:00Z' },
      }],
    } as unknown as CatchupData,
    {
      items: [{
        requirementId: 'REQ-10',
        jiraKey: 'APEX-10',
        title: '合入项',
        status: 'review',
        sourceBranch: 'feat/x',
        pipeline: { threadId: '', result: 'ready', error: '', updatedAt: '2026-11-16T00:00:00Z' },
      }],
    } as unknown as MergeData,
  );
  assert.ok(catchupRecords.every(r => r.detailPath.startsWith('/delivery/queue?requirement=')));

  // 3. 真实本地 Git 仓库：制造二进制冲突 + 删改冲突（modify/delete），验证 sequencerState 与 resolve-conflict
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round10-git-'));
  const repo = path.join(tempRoot, 'repo');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;

  try {
    await fs.mkdir(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Round10 Tester');
    await git('config', 'user.email', 'round10@localhost');

    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await fs.writeFile(path.join(repo, 'obsolete.ts'), 'export const legacy = 1;\n', 'utf8');
    await git('add', '-f', 'logo.png', 'obsolete.ts');
    await git('commit', '-qm', 'feat: initial assets');

    // 分支 feat/redesign：更新二进制文件并删除 obsolete.ts
    await git('checkout', '-qb', 'feat/redesign');
    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0xff]));
    await git('add', '-f', 'logo.png');
    await git('rm', '-q', 'obsolete.ts');
    await git('commit', '-qm', 'feat: new binary logo and remove obsolete');

    // 切回 main：同时修改二进制文件与 obsolete.ts，制造 二进制冲突 + modify/delete 删改冲突
    await git('checkout', '-q', 'main');
    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x11, 0x22]));
    await fs.writeFile(path.join(repo, 'obsolete.ts'), 'export const legacy = 2;\n', 'utf8');
    await git('add', '-f', 'logo.png', 'obsolete.ts');
    await git('commit', '-qm', 'feat: main updates logo and obsolete');

    const mergeRes = await executeProjectGitAction(
      { path: repo, action: 'merge', ref: 'refs/heads/feat/redesign', strategy: 'no-ff' },
      source,
    );
    assert.equal(mergeRes.outcome, 'merge-conflicts');
    assert.equal(mergeRes.snapshot.sequencerState, 'merge');
    assert.equal(mergeRes.snapshot.counts.conflicts, 2);

    // 对二进制冲突采用传入分支 (theirs)
    const afterBin = await executeProjectGitAction(
      { path: repo, action: 'resolve-conflict', file: 'logo.png', strategy: 'theirs', confirmed: true },
      source,
    );
    assert.equal(afterBin.snapshot.counts.conflicts, 1);
    assert.deepEqual(await fs.readFile(path.join(repo, 'logo.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0xff]));

    // 对 modify/delete 删改冲突采用传入分支 (theirs -> 传入分支已删除该文件，自动执行 git rm 解决！)
    const afterDeleteSide = await executeProjectGitAction(
      { path: repo, action: 'resolve-conflict', file: 'obsolete.ts', strategy: 'theirs', confirmed: true },
      source,
    );
    assert.equal(afterDeleteSide.snapshot.counts.conflicts, 0);
    await assert.rejects(() => fs.access(path.join(repo, 'obsolete.ts')));

    // 冲突全部解决后可直接完成合并提交
    const commitRes = await executeProjectGitAction(
      { path: repo, action: 'commit', message: 'chore: complete merge after conflict resolution' },
      source,
    );
    assert.equal(commitRes.snapshot.clean, true);
    assert.equal(commitRes.snapshot.sequencerState, null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

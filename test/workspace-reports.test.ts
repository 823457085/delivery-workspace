import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWecomIntegration } from '../server/wecom-integration.js';
import { createWorkspaceReports, renderPersonalTaskReport, renderWorkspaceReport, splitReportMarkdown } from '../server/workspace-reports.js';
import { createWorkspaceReportRoutes } from '../server/workspace-report-routes.js';
import { defaultReportPolicy, reportPolicySchema, type ReportPolicy, type ReportSnapshot, type ReportTask } from '../shared/workspace-reports.js';

function task(id: string, category: ReportTask['category'] = 'todo', extra: Partial<ReportTask> = {}): ReportTask {
  return { id, title: `任务 ${id}`, source: 'manual', category, status: '来源原文 L001', detail: '已核实的任务说明', nextAction: '核对明确未完成项', updatedAt: '2026-11-04T09:00:00.000Z', ...extra };
}
function snapshot(tasks: ReportTask[] = []): ReportSnapshot {
  return { generatedAt: '2026-11-04T10:00:00.000Z', tasks, coverage: [{ source: 'manual', label: '个人待办', available: true }] };
}

test('完整报告保留最后一项及长详情，Jira 编号可点击且不会生成不安全链接', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(`jira-${index}`, 'doing', {
    title: `APEX-${index + 1} 原始业务标题 L009`, url: `https://jira.example.test/browse/APEX-${index + 1}`,
    detail: `完整说明 ${index + 1} ` + '不裁剪原文'.repeat(100),
  }));
  const result = renderWorkspaceReport(snapshot(tasks), { ...defaultReportPolicy(), maxItems: 1 });
  assert.equal(result.counts.doing, 12);
  assert.match(result.content, /\[APEX-12\]\(https:\/\/jira.example.test\/browse\/APEX-12\)/);
  assert.ok(result.content.includes(tasks[11].detail));
  assert.doesNotMatch(result.content, /其余.*未展开|完整明细保存在工作台/);
  const unsafe = renderWorkspaceReport(snapshot([task('unsafe', 'doing', { title: 'APEX-1 原文', url: 'javascript:alert(1)' })]), defaultReportPolicy());
  assert.doesNotMatch(unsafe.content, /javascript:|\]\(javascript/);
});

test('UTF-8 分段逐字保留全文、emoji 和完整 Jira 链接', () => {
  const link = '[APEX-123](https://jira.example.test/browse/APEX-123)';
  const full = '完整原文🙂'.repeat(600) + link + '\n' + '后续明细'.repeat(1000);
  const parts = splitReportMarkdown(full);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), full);
  assert.ok(parts.every(part => Buffer.byteLength(part, 'utf8') <= 3968 && !part.includes('\uFFFD')));
  assert.equal(parts.filter(part => part.includes(link)).length, 1);
  const entries = Array.from({ length: 6 }, (_, index) => `- **APEX-${index} 任务标题**\n  当前状态：开发中\n  说明：${'完整任务说明'.repeat(60)}\n\n`);
  const grouped = splitReportMarkdown(entries.join(''));
  assert.equal(grouped.join(''), entries.join(''));
  assert.ok(entries.every(entry => grouped.some(part => part.includes(entry))), '能放入一条消息的任务段落不跨消息拆开');
});

test('个人任务汇报将 Jira 按到期优先级分组且去重，隐藏会话标题与检查范围', () => {
  const jira = (key: string, status: string, dueDate: string) => task(key, 'doing', {
    id: `jira:${key}`, title: `${key} 业务标题 L1234`, source: 'jira', status, dueDate, url: `https://jira.example.test/browse/${key}`,
  });
  const past = jira('APEX-1', '开发中', '2026-11-02');
  const data = { ...snapshot([
    { ...past, source: 'delivery', title: '工作台的交付会话', status: 'running' },
    task('hidden', 'doing', { source: 'agent', title: '工作台会话标题' }),
    task('personal', 'todo', { title: '整理本周待办' }),
  ]), jiraTasks: [past, jira('APEX-2', '待开始', '2026-11-05'), jira('APEX-3', '开发中', '2026-11-08'),
    jira('APEX-4', '测试中', ''), jira('APEX-5', '已取消', '2026-11-02')],
    coverage: [{ source: 'jira', label: '当前用户 Jira 任务', available: true }, ...snapshot().coverage] } as ReportSnapshot;
  const report = renderPersonalTaskReport(data, defaultReportPolicy()).content;
  const headings = ['### 已超期', '### 今天或明天到期', '### 开发中', '### 其他未完成', '## 个人待办'];
  for (let index = 1; index < headings.length; index++) assert.ok(report.indexOf(headings[index - 1]) < report.indexOf(headings[index]));
  assert.equal(report.split('[APEX-1]').length, 2);
  assert.match(report, /APEX-1\) 业务标题 L1234 · 开发中 · 超期 2 天/);
  assert.match(report, /APEX-2\) 业务标题 L1234 · 待开始 · 明天到期/);
  assert.match(report, /整理本周待办/);
  assert.doesNotMatch(report, /APEX-5|工作台.*会话|本次检查范围|执行工具/);
});

test('提醒先列待办和待确认，下一步随任务显示，空栏目不占位置，日期按策略时区说明', () => {
  const data = snapshot([
    task('doing', 'doing', { status: '开发中 L001', dueDate: '2026-11-05' }),
    task('todo', 'todo', { title: 'APEX-1 原始任务 L009', url: 'https://jira.example.test/browse/APEX-1', nextAction: '计划 2026-11-05 开始', dueDate: '2026-11-05' }),
    task('review', 'review', { status: 'completed', nextAction: undefined, dueDate: '2026-11-04' }),
    task('blocked', 'blocked', { detail: '缺少已确认接口', nextAction: '补充接口字段', dueDate: '2026-11-03' }),
    task('done', 'completed', { nextAction: undefined, dueDate: '2026-11-01' }),
  ]);
  const policy = { ...defaultReportPolicy(), sources: ['manual'] as ReportPolicy['sources'] };
  const report = renderWorkspaceReport(data, policy).content;
  const headings = ['卡住了，需要处理', '接下来要做', '需要你确认', '正在进行', '今天已完成', '本次检查范围'];
  for (let index = 1; index < headings.length; index++) assert.ok(report.indexOf(`## ${headings[index - 1]}`) < report.indexOf(`## ${headings[index]}`));
  assert.match(report, /1 项已超期，1 项今天截止，2 项明天截止/);
  assert.match(report, /截止：2026-11-05（明天）/); assert.match(report, /当前状态：开发中 L001/);
  assert.match(report, /当前状态：completed/); assert.match(report, /还需要你确认是否通过/);
  assert.equal(report.split('计划 2026-11-05 开始').length - 1, 1);
  assert.match(report, /下一步：补充接口字段/); assert.doesNotMatch(report, /## 下一步怎么做/);
  assert.match(report, /\[APEX-1\]\(https:\/\/jira.example.test\/browse\/APEX-1\) 原始任务 L009/);
  assert.ok(report.includes('缺少已确认接口'));
  const empty = renderWorkspaceReport(snapshot([]), policy).content;
  assert.match(empty, /本次没有查到符合条件的任务/); assert.doesNotMatch(empty, /## 接下来要做|## 正在进行|没有符合条件的记录/);
  const utc = renderWorkspaceReport({ ...data, generatedAt: '2026-11-04T17:00:00Z' }, { ...policy, timeZone: 'Asia/Singapore' }).content;
  assert.match(utc, /2026-11-05 01:00/); assert.match(utc, /截止：2026-11-05（今天）/);
});

test('未展开类别的下一步和自定义模板仍保留，错误日期不生成超期提醒', () => {
  const data = snapshot([task('visible', 'doing', { dueDate: '2026-02-30' }), task('hidden-todo', 'todo', { nextAction: '不可遗漏的下一步' })]);
  const policy = { ...defaultReportPolicy(), sources: ['manual'] as ReportPolicy['sources'], sections: ['doing', 'next'] as ReportPolicy['sections'] };
  const report = renderWorkspaceReport(data, policy).content;
  assert.match(report, /## 下一步怎么做/); assert.match(report, /任务 hidden-todo：不可遗漏的下一步/);
  assert.doesNotMatch(report, /已超期|截止提醒/);
  const custom = renderWorkspaceReport(data, { ...policy, template: '我的顺序\n{next}\n{doing}' }).content;
  assert.match(custom, /我的顺序\n- 任务 visible：/); assert.match(custom, /不可遗漏的下一步/);
  assert.match(custom, /当前状态：来源原文 L001/);
});

test('普通任务的外部链接保留，机器人密钥先脱敏再分段', async t => {
  const f = await fixture(t); await f.configureBot(); await f.configure();
  f.data(snapshot([task('external', 'doing', { url: 'https://example.test/task', detail: '完整详情'.repeat(330) + 'dedicated-test-key' + '结尾明细'.repeat(330) })]));
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.match(preview.fullContent, /\[查看任务\]\(https:\/\/example.test\/task\)/);
  assert.doesNotMatch(preview.fullContent, /dedicated-test-key/);
  assert.match(preview.fullContent, /密钥已隐藏/);
  assert.ok(preview.parts.every(part => !part.content.includes('dedicated-test-key') && part.bytes <= 4096));
});
async function fixture(t: TestContext, response: () => Promise<Response> = async () => new Response('{"errcode":0}')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-reports-'));
  let current = new Date('2026-11-04T09:00:00.000Z');
  let data = snapshot([task('a')]);
  const calls: { url: string; content: string }[] = [];
  const fetchMock: typeof fetch = async (url, init) => { calls.push({ url: String(url), content: String(init?.body) }); return response(); };
  const integration = await createWecomIntegration(path.join(directory, 'integration'), { configFile: path.join(directory, 'integration.json'), fetch: fetchMock });
  const dedicated = await createWecomIntegration(path.join(directory, 'dedicated'), { configFile: path.join(directory, 'dedicated.json'), fetch: fetchMock });
  const bots = { integration, dedicated };
  let service = await createWorkspaceReports(path.join(directory, 'reports'), { bots, readSnapshot: () => ({ ...data, generatedAt: current.toISOString() }), now: () => current });
  t.after(async () => { await service.close(); await integration.close(); await dedicated.close(); await fs.rm(directory, { recursive: true }); });
  return { directory, calls, bots, get service() { return service; },
    now: (value: string) => { current = new Date(value); }, data: (value: ReportSnapshot) => { data = value; },
    configureBot: () => service.configureBot({ groupName: '个人日报测试群', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dedicated-test-key' }),
    configure: (policies: ReportPolicy[] = [defaultReportPolicy()], extra: object = {}) => service.configure({ policies, botTarget: 'dedicated', confirmedGroupName: '个人日报测试群', ...extra }),
    reopen: async () => { await service.close(); service = await createWorkspaceReports(path.join(directory, 'reports'), { bots, readSnapshot: () => ({ ...data, generatedAt: current.toISOString() }), now: () => current }); },
  };
}

test('默认策略关闭且使用独立未配置机器人；预览不发送、未确认群名不能启用', async t => {
  const f = await fixture(t);
  assert.equal(f.service.dashboard().settings.policies[0].enabled, false);
  assert.equal(f.service.dashboard().settings.botTarget, 'dedicated');
  assert.equal(f.service.dashboard().bots.dedicated.hasWebhook, false);
  assert.equal(f.service.dashboard().scheduler.online, false);
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.equal(preview.canSend, false); assert.equal(f.calls.length, 0);
  await assert.rejects(f.configure([{ ...defaultReportPolicy(), enabled: true }]), /配置机器人并确认/);
  await f.configureBot();
  await assert.rejects(f.configure([{ ...defaultReportPolicy(), enabled: true }], { confirmedGroupName: '其他群' }), /确认/);
  assert.equal(f.calls.length, 0);
});

test('确定性报告保留来源状态、明确下一步和缺口；完成只统计策略时区当天', () => {
  const policy = { ...defaultReportPolicy(), sources: ['manual', 'jira'] as ReportPolicy['sources'], template: '{date}\n{doing}\n{next}' };
  const data = snapshot([
    task('doing', 'doing', { nextAction: '读取用户指定的验证日志', status: 'L009' }),
    task('blocked', 'blocked', { nextAction: undefined, detail: '缺少正式接口字段' }),
    task('old-done', 'completed', { updatedAt: '2026-11-04T10:00:00Z', completedAt: '2026-11-02T08:00:00Z' }),
    task('today-done', 'completed', { completedAt: '2026-11-03T17:00:00Z' }),
  ]);
  const rendered = renderWorkspaceReport(data, policy);
  assert.equal(rendered.counts.completed, 1);
  assert.match(rendered.fullContent, /任务 today-done/); assert.doesNotMatch(rendered.fullContent, /old-done/);
  assert.match(rendered.fullContent, /L009/); assert.match(rendered.fullContent, /读取用户指定的验证日志/);
  assert.match(rendered.fullContent, /卡住了，需要处理/); assert.match(rendered.fullContent, /缺少正式接口字段/);
  assert.match(rendered.fullContent, /Jira 任务：未能读取/);
  assert.doesNotMatch(rendered.fullContent, /\d+%/);
});

test('来源、项目与逾期筛选不改任务；超长报告保留各分类统计和完整本机报告', async t => {
  const f = await fixture(t);
  const tasks = Array.from({ length: 100 }, (_, index) => task(String(index), ['doing', 'todo', 'blocked', 'review', 'completed'][index % 5] as ReportTask['category'], { title: '很长的真实任务标题'.repeat(40), detail: '来源进度'.repeat(90), dueDate: '2026-11-03', project: index % 2 ? 'Apex' : 'Other' }));
  f.data(snapshot(tasks));
  const policy = { ...defaultReportPolicy(), kind: 'overdue' as const, projectFilter: 'apex', template: '自定义模板'.repeat(1000) + '\n{doing}' };
  const result = await f.service.preview({ policy });
  assert.ok(result.parts.length > 1); assert.ok(result.parts.every(part => part.bytes <= 4096)); assert.equal(result.truncated, false);
  assert.equal(result.counts.completed, 0); assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), 40);
  assert.match(result.content, /待办/); assert.match(result.content, /卡住/); assert.match(result.content, /等你确认/); assert.doesNotMatch(result.content, /未展开|已压缩|分类摘要/); assert.match(result.content, /本次检查范围/);
  assert.equal(result.fullContent, result.content);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'reports/reports', `${result.id}.json`), 'utf8')).value.fullContent, result.fullContent);
  assert.equal((await fs.stat(path.join(f.directory, 'reports/reports', `${result.id}.json`))).mode & 0o777, 0o600);
  assert.equal(f.calls.length, 0);
});

test('非法时区、重复策略与未知模板占位拒绝；客户端不能伪造启用时间补发', async t => {
  const f = await fixture(t); await f.configureBot();
  assert.throws(() => reportPolicySchema.parse({ ...defaultReportPolicy(), timeZone: 'invalid-zone' }));
  assert.throws(() => reportPolicySchema.parse({ ...defaultReportPolicy(), template: '{madeUpTasks}' }));
  await assert.rejects(f.configure([defaultReportPolicy(), defaultReportPolicy()]), /策略标识不能重复/);
  const policy = { ...defaultReportPolicy(), enabled: true, times: ['16:00'], enabledAt: '2020-01-01T00:00:00.000Z' };
  await f.configure([policy]);
  assert.equal(f.service.dashboard().settings.policies[0].enabledAt, '2026-11-04T09:00:00.000Z');
  await f.service.tick(); assert.equal(f.calls.length, 0);
});

test('按时区和星期调度，持久化同一slot且并发、重启均不重复；只补当天最近时段', async t => {
  const f = await fixture(t); await f.configureBot();
  f.now('2026-11-04T00:00:00.000Z');
  await f.configure([{ ...defaultReportPolicy(), enabled: true, times: ['08:30', '18:00'], weekdays: [3] }]);
  f.now('2026-11-04T10:01:00.000Z');
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 1); assert.equal(f.service.dashboard().history[0].slot, 'daily-summary|Asia/Singapore|2026-11-04|18:00');
  assert.equal(f.service.dashboard().history[0].status, 'sent');
  await f.reopen(); await f.service.tick(); assert.equal(f.calls.length, 1);
  f.now('2026-11-05T10:01:00.000Z'); await f.service.tick(); assert.equal(f.calls.length, 1, '周四不执行仅周三策略');
  const state = JSON.parse(await fs.readFile(path.join(f.directory, 'reports/workspace-reports.json'), 'utf8'));
  assert.equal(Object.keys(state.slots).length, 1); assert.equal(state.previews.length, 1);
});

test('手动发送绑定保存策略、目标群和预览，重复点击只发送一次', async t => {
  const f = await fixture(t); await f.configureBot(); await f.configure();
  const preview = await f.service.preview({ policyId: 'daily-summary' }); assert.equal(preview.canSend, true);
  const [first, second] = await Promise.all([f.service.send({ previewId: preview.id }), f.service.send({ previewId: preview.id })]);
  assert.equal(first.record.id, second.record.id); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.includes('dedicated-test-key'));
  const pending = await f.service.preview({ policyId: 'daily-summary' });
  await f.configure([{ ...defaultReportPolicy(), name: '更改后的策略' }]);
  await assert.rejects(f.service.send({ previewId: pending.id }), /策略已变化/);
  const draft = await f.service.preview({ policy: { ...defaultReportPolicy('new-draft'), name: '未保存草稿' } });
  assert.equal(draft.canSend, false);
  await assert.rejects(f.service.send({ previewId: draft.id }), /先保存/);
  assert.equal(f.calls.length, 1);
});

test('完整 Markdown 分段全部发送，逐段回执持久化，重复提交和重启不重发', async t => {
  const f = await fixture(t); await f.configureBot(); await f.configure();
  f.data(snapshot(Array.from({ length: 16 }, (_, index) => task(`part-${index}`, 'doing', {
    title: `APEX-${index + 1} 全量任务`, url: `https://jira.example.test/browse/APEX-${index + 1}`, detail: '完整任务说明'.repeat(90),
  }))));
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.ok(preview.parts.length > 1);
  const result = await f.service.send({ previewId: preview.id });
  assert.equal(result.record.status, 'sent');
  assert.equal(result.record.sentParts, preview.parts.length);
  assert.equal(result.record.parts?.length, preview.parts.length);
  assert.equal(f.calls.length, preview.parts.length);
  for (const call of f.calls) {
    const body = JSON.parse(call.content);
    assert.equal(body.msgtype, 'markdown_v2');
    assert.ok(Buffer.byteLength(body.markdown_v2.content, 'utf8') <= 4096);
  }
  assert.ok(f.calls.some(call => call.content.includes('APEX-16')));
  await f.service.send({ previewId: preview.id });
  await f.reopen(); await f.service.send({ previewId: preview.id });
  assert.equal(f.calls.length, preview.parts.length);
  assert.equal(f.service.dashboard().history[0].sentParts, preview.parts.length);
});

test('个人任务群完整推送开发中 11 条和其他未完成 8 条，超长按顺序分段', async t => {
  const f = await fixture(t);
  await f.service.configureBot({ groupName: '个人任务', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dedicated-test-key' });
  await f.configure([defaultReportPolicy()], { confirmedGroupName: '个人任务' });
  const keys = Array.from({ length: 19 }, (_, index) => `APEX-${100 + index}`);
  f.data({ ...snapshot([]), jiraTasks: keys.map((key, index) => task(key, index < 11 ? 'doing' : 'todo', {
    source: 'jira', title: `${key} ${'原始任务标题'.repeat(30)}🙂`, url: `https://jira.example.test/browse/${key}`,
    status: index < 11 ? '开发中' : '待开始', dueDate: '2026-11-09',
  })), coverage: [{ source: 'jira', label: 'Jira 任务', available: true }, ...snapshot().coverage] });

  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.match(preview.fullContent, /### 开发中（11）/);
  assert.match(preview.fullContent, /### 其他未完成（8）/);
  assert.doesNotMatch(preview.fullContent, /另有 \d+ 项/);
  assert.ok(preview.parts.length > 1);
  const { record } = await f.service.send({ previewId: preview.id });
  assert.equal(record.status, 'sent');
  const delivered = f.calls.map((call, index) => {
    const body = JSON.parse(call.content);
    const prefix = `**完整汇报 · ${index + 1}/${preview.parts.length}**\n\n`;
    assert.equal(body.msgtype, 'markdown_v2');
    assert.ok(body.markdown_v2.content.startsWith(prefix));
    assert.ok(Buffer.byteLength(body.markdown_v2.content, 'utf8') <= 4096);
    return body.markdown_v2.content.slice(prefix.length) as string;
  });
  assert.equal(delivered.join(''), preview.fullContent);
  assert.deepEqual(delivered.flatMap(part => Array.from(part.matchAll(/\[(APEX-\d+)\]\(https:\/\/jira\.example\.test\/browse\/\1\)/g), match => match[1])), keys);
});

test('分段明确失败或送达未知即停止，已发送段不会因再次提交被重发', async t => {
  for (const uncertain of [false, true]) {
    let count = 0;
    const f = await fixture(t, async () => {
      if (++count === 2) {
        if (uncertain) throw new Error('timeout');
        return new Response('{"errcode":93000,"errmsg":"fixture stopped"}');
      }
      return new Response('{"errcode":0}');
    });
    await f.configureBot(); await f.configure();
    f.data(snapshot(Array.from({ length: 10 }, (_, index) => task(String(index), 'doing', { detail: '详情'.repeat(350) }))));
    const preview = await f.service.preview({ policyId: 'daily-summary' });
    assert.ok(preview.parts.length > 2);
    const result = await f.service.send({ previewId: preview.id });
    assert.equal(result.record.status, uncertain ? 'unknown' : 'failed');
    assert.equal(result.record.sentParts, 1);
    assert.equal(f.calls.length, 2);
    await f.reopen(); await f.service.send({ previewId: preview.id });
    assert.equal(f.calls.length, 2);
  }
});

test('只等待尚未外发的本机限流，旧的摘要预览必须重新生成', async t => {
  const f = await fixture(t); await f.configureBot(); await f.configure();
  const original = f.bots.dedicated.sendMessage.bind(f.bots.dedicated);
  let limited = false;
  f.bots.dedicated.sendMessage = async input => {
    if (!limited) { limited = true; throw Object.assign(new Error('fixture preflight limit'), { code: 'WECOM_LOCAL_RATE_LIMIT', retryAfterMs: 1 }); }
    return original(input);
  };
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.equal((await f.service.send({ previewId: preview.id })).record.status, 'sent');
  assert.equal(f.calls.length, 1);
  const pending = await f.service.preview({ policyId: 'daily-summary' });
  await f.service.close();
  const file = path.join(f.directory, 'reports/workspace-reports.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  delete state.previews.find((entry: { value: { id: string } }) => entry.value.id === pending.id).messages;
  await fs.writeFile(file, JSON.stringify(state)); await f.reopen();
  await assert.rejects(f.service.send({ previewId: pending.id }), /重新生成完整 Markdown/);
  assert.equal(f.calls.length, 1);
});

test('目标群变化必须重新确认；更新专用机器人使策略暂停且不复用联调凭据', async t => {
  const f = await fixture(t); await f.configureBot();
  await f.bots.integration.configure({ groupName: '联调群', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=integration-test-key' });
  await f.configure([{ ...defaultReportPolicy(), enabled: true }]);
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  await f.bots.dedicated.configure({ groupName: '另一接收群' });
  await assert.rejects(f.service.send({ previewId: preview.id }), /目标或群名确认已变化/);
  f.now('2026-11-04T10:01:00Z'); await f.service.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.service.dashboard().history[0].status, 'failed');
  await f.service.configureBot({ groupName: '最终群' });
  assert.equal(f.service.dashboard().settings.confirmedGroupName, '');
  assert.equal(f.service.dashboard().settings.policies[0].enabled, false);
  assert.equal(f.service.dashboard().bots.integration.groupName, '联调群');
});

test('超时和重启中断标记unknown且不自动重试；明确失败也不按每分钟刷群', async t => {
  const f = await fixture(t, async () => { throw new Error('timeout'); }); await f.configureBot();
  await f.configure([{ ...defaultReportPolicy(), enabled: true }]);
  f.now('2026-11-04T10:01:00Z'); await f.service.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.service.dashboard().history[0].status, 'unknown');
  await f.reopen(); await f.service.tick(); assert.equal(f.calls.length, 1);
  const file = path.join(f.directory, 'reports/workspace-reports.json');
  await f.service.close();
  const state = JSON.parse(await fs.readFile(file, 'utf8')); state.history[0].status = 'sending';
  await fs.writeFile(file, JSON.stringify(state)); await f.reopen();
  assert.equal(f.service.dashboard().history[0].status, 'unknown'); await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('读取失败写入失败回执，其他策略仍可执行；没有覆盖数据不能宣称无任务', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-report-source-failure-'));
  const bot = await createWecomIntegration(path.join(directory, 'bot'), { configFile: path.join(directory, 'bot.json'), fetch: async () => new Response('{"errcode":0}') });
  await bot.configure({ groupName: 'fixture', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=isolated-report-test-key' });
  let time = new Date('2026-11-04T09:00:00Z'), reads = 0;
  const service = await createWorkspaceReports(path.join(directory, 'report'), { bots: { integration: bot, dedicated: bot }, now: () => time, readSnapshot: () => { if (++reads === 1) throw new Error('任务来源不可读取'); return { generatedAt: time.toISOString(), tasks: [], coverage: [] }; } });
  t.after(async () => { await service.close(); await bot.close(); await fs.rm(directory, { recursive: true }); });
  await service.configure({ botTarget: 'dedicated', confirmedGroupName: 'fixture', policies: [{ ...defaultReportPolicy('one'), enabled: true }, { ...defaultReportPolicy('two'), enabled: true }] });
  time = new Date('2026-11-04T10:00:00Z'); await service.tick();
  assert.deepEqual(service.dashboard().history.map(run => run.status), ['sent', 'failed']);
  const preview = await service.preview({ policyId: 'two' });
  assert.match(preview.content, /读取失败|未能读取/);
});

test('报告正文复用服务端脱敏；路由强制本机host、同源JSON和明确确认', async t => {
  const f = await fixture(t); f.data(snapshot([task('private', 'doing', { detail: 'token=fixture-body-token\nhttps://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=hidden-key' })]));
  const preview = await f.service.preview({ policyId: 'daily-summary' });
  assert.doesNotMatch(preview.fullContent, /fixture-body-token|hidden-key/);
  let result: { status: number; value: unknown } | undefined, bodies = 0;
  const route = createWorkspaceReportRoutes(f.service, { port: 5288,
    json(_response, status, value) { result = { status, value }; },
    body: async () => { bodies++; return { policyId: 'daily-summary' }; } });
  const response = {} as ServerResponse;
  for (const headers of [{ host: 'evil.test' }, { host: 'localhost:5288', origin: 'https://evil.test' }, { host: 'localhost:5288', origin: 'http://localhost:5288', 'content-type': 'application/json' }]) {
    await route({ method: 'POST', headers } as unknown as IncomingMessage, response, new URL('http://localhost:5288/api/workspace-reports/preview'));
    assert.equal(result!.status, 403);
  }
  assert.equal(bodies, 0);
  await route({ method: 'POST', headers: { host: 'localhost:5288', origin: 'http://localhost:5288', 'content-type': 'application/json', 'x-delivery-confirmed': 'yes' } } as unknown as IncomingMessage, response, new URL('http://localhost:5288/api/workspace-reports/preview'));
  assert.equal(result!.status, 200); assert.equal(bodies, 1);
  assert.equal(await route({ method: 'GET', headers: { host: 'localhost:5288' } } as unknown as IncomingMessage, response, new URL('http://localhost:5288/api/workspace-reports-other')), false);
  await assert.rejects(f.service.send({ previewId: randomUUID() }), /预览不存在/);
});

test('同类多份来源覆盖逐条保留，单个来源失败不会被首个成功覆盖', () => {
  const data = snapshot([task('delivery', 'doing', { source: 'delivery' })]);
  data.coverage = [
    { source: 'delivery', label: '研发交付', available: true },
    { source: 'delivery', label: '方案任务', available: false, detail: '设计读取失败' },
    { source: 'delivery', label: '合入队列', available: true, detail: '仅最近100条快照' },
  ];
  const policy = { ...defaultReportPolicy(), sources: ['delivery'] as ReportPolicy['sources'] };
  const rendered = renderWorkspaceReport(data, policy);
  assert.equal(rendered.coverage.length, 3);
  for (const label of ['研发交付', '方案任务', '合入队列']) assert.ok(rendered.content.includes(label));
  assert.match(rendered.content, /设计读取失败/); assert.match(rendered.fullContent, /仅最近100条快照/);
});

test('发送端抛错可能已发出，报告保守记录unknown；明确errcode失败保留failed且不自动重发', async t => {
  const f = await fixture(t); await f.configureBot();
  const original = f.bots.dedicated.sendMessage.bind(f.bots.dedicated);
  f.bots.dedicated.sendMessage = async input => { await original(input); throw new Error('发送后回执落盘失败'); };
  await f.configure([{ ...defaultReportPolicy(), enabled: true }]);
  f.now('2026-11-04T10:01:00Z'); await f.service.tick();
  assert.equal(f.service.dashboard().history[0].status, 'unknown'); assert.equal(f.calls.length, 1);
  await f.reopen(); await f.service.tick(); assert.equal(f.calls.length, 1);
  const failed = await fixture(t, async () => new Response('{"errcode":93000,"errmsg":"群机器人被停用"}'));
  await failed.configureBot(); await failed.configure([{ ...defaultReportPolicy(), enabled: true }]);
  failed.now('2026-11-04T10:01:00Z'); await failed.service.tick(); await failed.service.tick();
  assert.equal(failed.service.dashboard().history[0].status, 'failed'); assert.equal(failed.calls.length, 1);
});

test('归并任务可按任一关联来源筛选且不重复计数，读取缺口在统计标题明确说明', () => {
  const data = snapshot([
    task('jira-delivery', 'doing', { source: 'delivery', relatedSources: ['jira', 'delivery', 'agent'] }),
    task('delivery-only', 'todo', { source: 'delivery' }),
  ]);
  data.coverage = [
    { source: 'jira', label: 'Jira 任务', available: false, detail: '本次 Jira 读取失败，仅有已关联交付记录' },
    { source: 'delivery', label: '研发交付', available: true },
  ];
  const policy = { ...defaultReportPolicy(), sources: ['jira'] as ReportPolicy['sources'] };
  const jiraOnly = renderWorkspaceReport(data, policy);
  assert.equal(jiraOnly.counts.doing, 1); assert.equal(jiraOnly.counts.todo, 0);
  assert.match(jiraOnly.fullContent, /jira-delivery/); assert.doesNotMatch(jiraOnly.fullContent, /delivery-only/);
  assert.match(jiraOnly.content, /统计仅含已读取来源，缺失来源不计为零/);
  const combined = renderWorkspaceReport(data, { ...policy, sources: ['jira', 'delivery', 'agent'] });
  assert.equal(combined.counts.doing, 1); assert.equal(combined.counts.todo, 1);
});

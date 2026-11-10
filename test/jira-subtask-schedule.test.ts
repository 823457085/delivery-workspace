import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequirementStore } from '../server/jira-dev/index.mjs';
import { jiraDevStartBlocker } from '../shared/jira-dev.js';

const source = { key: 'APEX-562', url: 'https://jira.example.test/browse/APEX-562', summary: '【商家账户】升级账户管理', description: '需求原文 L123',
  project: { id: '1', key: 'APEX' }, startDate: '2026-11-02', endDate: '2026-11-13', fixVersions: [], links: [] as any[] };
const meta = Object.fromEntries(['project', 'issuetype', 'summary', 'description', 'parent', 'labels', 'assignee', 'start', 'end'].map(id =>
  [id, { required: false, operations: ['set'], ...(id === 'start' || id === 'end' ? { schema: { type: 'date' } } : {}) }]));
async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jira-subtask-schedule-'));
  const issue = { ...structuredClone(source), ...overrides }, issues: any[] = [], writes: any[] = [];
  const jira = {
    readRequirementScheduleContext: async (url: string) => ({ issue: issues.find(item => item.url === url), startField: 'start', endField: 'end', fields: meta }),
    readRequirementContext: async () => ({ issue, assignee: { name: 'tester' }, startField: 'start', endField: 'end',
      issueTypes: [{ id: '10', name: '任务', subtask: false, fields: meta }, { id: '11', name: '子任务', subtask: true, fields: meta }],
      linkTypes: [{ id: '20', name: 'relates to' }] }),
    findRequirementIssues: async () => ({ sourceIssue: issue, issues: structuredClone(issues), truncated: false }),
    createRequirementIssue: async ({ fields, marker }: any) => {
      writes.push(structuredClone(fields));
      const key = `APEX-${600 + writes.length}`;
      const saved = { key, url: `https://jira.example.test/browse/${key}`, summary: fields.summary, description: fields.description,
        labels: [marker], issueType: { id: fields.issuetype.id, subtask: !!fields.parent }, project: issue.project,
        ...(fields.parent ? { parent: fields.parent } : {}), startDate: fields.start, endDate: fields.end, verified: true };
      issues.push(saved); return saved;
    },
    linkRequirementIssues: async ({ toKey }: any) => { issue.links.push({ key: toKey, type: { id: '20' } }); return { verified: true }; },
  };
  const store = createRequirementStore({ jira, dataDirectory: directory });
  const prepare = (schedules = {}, taskId = 'preview', extra: Record<string, unknown> = {}) => store.prepare({ taskId, sourceKind: 'product', sourceIssue: issue, repositoryId: 'repo', schedules, designDestination: null, ...extra });
  return { directory, store, prepare, issue, issues, writes, jira, close: () => rm(directory, { recursive: true, force: true }) };
}
const ranges = (plan: any): string[][] => plan.items.map((item: any) => [item.role, item.schedule.startDate, item.schedule.endDate]);

test('复用产品 Jira 或开发主任务时，只读识别同一组已有方案和实现子任务', async () => {
  const f = await fixture({ issueType: { name: '新功能', subtask: false } });
  const main = { ...source, key: 'APEX-563', url: 'https://jira.example.test/browse/APEX-563', summary: '【APP】开发 商家账户',
    issueType: { name: '任务', subtask: false }, subtasks: [{ key: 'APEX-564' }, { key: 'APEX-565' }, { key: 'APEX-566' }] };
  const child = (key: string, summary: string) => ({ ...source, key, url: `https://jira.example.test/browse/${key}`,
    summary, issueType: { name: '子任务', subtask: true }, parent: { key: main.key } });
  try {
    f.issue.links = [{ key: main.key }];
    f.issues.push(main, child('APEX-564', '编写账户技术方案'), child('APEX-565', '实现开户'), child('APEX-566', '实现账户明细'));
    const plan = await f.prepare({}, 'linked', { sourceKind: 'frontend' });
    assert.equal(plan.status, 'ready', plan.warning);
    assert.equal(plan.developmentIssue?.key, main.key);
    assert.deepEqual(plan.items.map(item => [item.role, item.key, item.action]), [
      ['parent', 'APEX-563', 'reuse'], ['design', 'APEX-564', 'reuse'],
      ['implementation', 'APEX-565', 'reuse'], ['implementation', 'APEX-566', 'reuse'],
    ]);
    assert.equal((await f.store.apply({ taskId: 'linked', confirmed: true })).developmentIssue?.key, main.key);
    Object.assign(f.issue, main);
    assert.deepEqual((await f.prepare({}, 'main', { sourceKind: 'frontend' })).items.map(item => item.key), plan.items.map(item => item.key));
    const schedule = await f.prepare({ implementation: { startDate: '2026-11-09' } }, 'ambiguous-dates', { sourceKind: 'frontend' });
    assert.equal(schedule.status, 'local');
    assert.match(schedule.warning || '', /匹配 2 张/);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Jira 修复查找关联的开发主任务下的修复子任务，有歧义时不新建', async () => {
  const f = await fixture({ issueType: { name: 'Bug', subtask: false } });
  const main = { ...source, key: 'APEX-573', url: 'https://jira.example.test/browse/APEX-573', summary: '【APP】开发 商家账户',
    issueType: { name: '任务', subtask: false } };
  const child = (key: string) => ({ ...source, key, url: `https://jira.example.test/browse/${key}`, summary: '前端修复 账户异常',
    issueType: { name: '子任务', subtask: true }, parent: { key: main.key } });
  try {
    f.issue.links = [{ key: main.key }];
    f.issues.push(main, child('APEX-574'));
    const plan = await f.prepare({}, 'repair', { sourceKind: 'defect', repairMode: 'reuse' });
    assert.equal(plan.status, 'ready', plan.warning);
    assert.deepEqual(plan.items.map(item => [item.key, item.action]), [['APEX-574', 'reuse']]);
    assert.equal((await f.store.apply({ taskId: 'repair', confirmed: true })).developmentIssue?.key, 'APEX-574');
    assert.deepEqual(f.issue.links, [{ key: main.key }]);
    f.issues.push(child('APEX-575'));
    const ambiguous = await f.prepare({}, 'ambiguous-repair', { sourceKind: 'defect', repairMode: 'reuse' });
    assert.equal(ambiguous.status, 'local');
    assert.match(ambiguous.warning || '', /APEX-574、APEX-575/);
    assert.deepEqual(ambiguous.items, []);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('多项目新任务标题表达跨项目范围，去掉来源标题开头的 Apex；来源和原文保留', async () => {
  const summary = 'apex商家收款账户管理升级';
  const f = await fixture({ summary });
  try {
    const plan = await f.prepare({}, 'multi', { businessModule: 'Adyen商家账户', repositoryNames: ['thor-admin2.0', 'merchant-front', 'thor-merchant'] });
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.equal(plan.sourceIssue?.summary, summary);
    assert.ok(plan.items.every(item => /跨项目/.test(item.summary) && !/apex/i.test(item.summary)));
    for (const item of plan.items) {
      for (const name of ['thor-admin2.0', 'merchant-front', 'thor-merchant']) assert.ok(String(item.description).includes(name));
      assert.ok(String(item.description).includes(`需求标题原文：${summary}`));
    }
    const applied = await f.store.apply({ taskId: 'multi', confirmed: true });
    assert.equal(applied.status, 'applied', applied.warning || '');
    assert.deepEqual(f.writes.map(fields => fields.summary), plan.items.map(item => item.summary));
  } finally { await f.close(); }
});

test('单项目保持来源标题；跨项目不删除业务词中的 ApexPay', async () => {
  const single = await fixture({ summary: 'apex商家收款账户管理升级' });
  const multi = await fixture({ summary: 'ApexPay账户管理' });
  try {
    assert.match((await single.prepare()).items[0]!.summary, /开发 apex商家收款账户管理升级/);
    const plan = await multi.prepare({}, 'multi', { repositoryNames: ['web', 'app'] });
    assert.match(plan.items[0]!.summary, /跨项目.*ApexPay账户管理/);
  } finally { await single.close(); await multi.close(); }
});

test('已有 Jira 标题按接口原样复用；旧版未执行标题需要重新预览', async () => {
  const f = await fixture({ summary: 'apex商家收款账户管理升级' });
  try {
    const options = { businessModule: 'Adyen商家账户', repositoryNames: ['web', 'app'] };
    await f.prepare({}, 'multi', options); await f.store.apply({ taskId: 'multi', confirmed: true });
    f.issues[0].summary = '已有 Jira 返回的原标题 L123 Apex';
    const reused = await f.prepare({}, 'reuse', options);
    assert.equal(reused.items[0]!.summary, '已有 Jira 返回的原标题 L123 Apex');
    assert.ok(reused.items.every(item => item.action === 'reuse'));
    const other = await fixture();
    try {
      await other.prepare();
      const filename = path.join(other.directory, 'requirement-plans.json');
      const records = JSON.parse(await readFile(filename, 'utf8')); records[0].titleRuleVersion = 1;
      await writeFile(filename, JSON.stringify(records));
      const stale = await other.store.get({ taskId: 'preview' });
      assert.equal(stale.needsTitleReview, true);
      await assert.rejects(other.store.apply({ taskId: 'preview', confirmed: true }), /项目范围.*重新生成预览/);
      assert.equal(other.writes.length, 0);
    } finally { await other.close(); }
  } finally { await f.close(); }
});

test('国庆放假跳过，10月10日补班计入，子任务不跨休息日，主任务日期保留', async () => {
  const f = await fixture({ startDate: '2026-09-30', endDate: '2026-10-12' });
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.deepEqual(ranges(plan), [['parent', '2026-09-30', '2026-10-12'], ['design', '2026-09-30', '2026-09-30'],
      ['implementation', '2026-10-08', '2026-10-10'], ['implementation', '2026-10-12', '2026-10-12']]);
    assert.deepEqual(plan.items.slice(1).map(item => item.workdays), [1, 3, 1]);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('春节假期断开子任务，2月14日和28日补班可以排期', async () => {
  const f = await fixture({ startDate: '2026-02-12', endDate: '2026-02-28' });
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.deepEqual(ranges(plan).slice(1), [['design', '2026-02-12', '2026-02-12'], ['implementation', '2026-02-13', '2026-02-14'],
      ['implementation', '2026-02-24', '2026-02-26'], ['implementation', '2026-02-27', '2026-02-28']]);
  } finally { await f.close(); }
});

test('所选日期全为法定休假时不创建 Jira', async () => {
  const f = await fixture({ startDate: '2026-05-01', endDate: '2026-05-05' });
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'local'); assert.match(plan.warning || '', /没有工作日/);
    await f.store.apply({ taskId: 'preview', confirmed: true }); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('缺少已核验日历的年份不能静默按周末推测建单', async () => {
  const f = await fixture({ startDate: '2027-01-01', endDate: '2027-01-08' });
  try {
    const plan = await f.prepare(); assert.equal(plan.status, 'local'); assert.match(plan.warning || '', /2027.*日历/);
    await f.store.apply({ taskId: 'preview', confirmed: true }); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('主任务十个工作日：一天方案，其余拆成四个最多三天的连续实现子任务，预览零写入', async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.deepEqual(ranges(plan), [['parent', '2026-11-02', '2026-11-13'], ['design', '2026-11-02', '2026-11-02'],
      ['implementation', '2026-11-03', '2026-11-05'], ['implementation', '2026-11-06', '2026-11-06'], ['implementation', '2026-11-09', '2026-11-11'], ['implementation', '2026-11-12', '2026-11-13']]);
    assert.equal(new Set(plan.items.map((item: any) => item.id)).size, plan.items.length);
    assert.equal(f.writes.length, 0);
    assert.ok(plan.items.every(item => String(item.description).includes('需求原文 L123')));
  } finally { await f.close(); }
});

test('显式主任务日期覆盖来源；周末不计工作量，尾段保留不足三天', async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare({ parent: { startDate: '2026-11-06', endDate: '2026-11-12' } });
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.deepEqual(ranges(plan), [['parent', '2026-11-06', '2026-11-12'], ['design', '2026-11-06', '2026-11-06'],
      ['implementation', '2026-11-09', '2026-11-11'], ['implementation', '2026-11-12', '2026-11-12']]);
  } finally { await f.close(); }
});

test('单独排期的方案与实现同样拆分，不超出主任务', async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare({ design: { startDate: '2026-11-02', endDate: '2026-11-06' }, implementation: { startDate: '2026-11-09', endDate: '2026-11-13' } });
    assert.equal(plan.status, 'ready', plan.warning || '');
    assert.deepEqual(ranges(plan).slice(1), [['design', '2026-11-02', '2026-11-04'], ['design', '2026-11-05', '2026-11-06'],
      ['implementation', '2026-11-09', '2026-11-11'], ['implementation', '2026-11-12', '2026-11-13']]);
  } finally { await f.close(); }
});

test('一天主任务仍保留方案和实现，每张均为一天', async () => {
  const f = await fixture({ startDate: '2026-11-02', endDate: '2026-11-02' });
  try { const p = await f.prepare(); assert.equal(p.status, 'ready', p.warning || ''); assert.deepEqual(ranges(p).map(row => row.slice(1)), Array(3).fill(['2026-11-02', '2026-11-02'])); }
  finally { await f.close(); }
});

for (const [name, overrides, schedules, message] of [
  ['缺少日期', { startDate: '', endDate: '' }, {}, /主任务.*开始.*结束/],
  ['只有结束日期', { startDate: '' }, {}, /主任务.*开始.*结束/],
  ['只有周末', { startDate: '2026-11-07', endDate: '2026-11-08' }, {}, /工作日/],
  ['子任务越界', {}, { implementation: { startDate: '2026-11-02', endDate: '2026-11-16' } }, /主任务.*范围/],
] as const) test(`${name}保留草稿且不写 Jira`, async () => {
  const f = await fixture(overrides);
  try { const p = await f.prepare(schedules); assert.equal(p.status, 'local'); assert.match(p.warning || '', message); await f.store.apply({ taskId: 'preview', confirmed: true }); assert.equal(f.writes.length, 0); }
  finally { await f.close(); }
});

test('确认后按预览创建每张子任务；重复确认、重开预览不重复写入，交接绑定前端父任务', async () => {
  const f = await fixture();
  try {
    const preview = await f.prepare();
    assert.equal(preview.items.length, 6);
    const applied = await f.store.apply({ taskId: 'preview', confirmed: true });
    assert.equal(applied.status, 'applied', applied.warning || '');
    assert.equal(f.writes.length, 6);
    assert.equal(applied.developmentIssue?.key, applied.items[0]!.key);
    assert.ok(f.writes.slice(1).every(fields => fields.parent.key === applied.items[0]!.key));
    assert.deepEqual(f.writes.map(fields => [fields.start, fields.end]), ranges(preview).map(row => row.slice(1)));
    await f.store.apply({ taskId: 'preview', confirmed: true });
    const again = await f.prepare({}, 'another-preview');
    assert.ok(again.items.every(item => item.action === 'reuse'));
    assert.equal(again.items.length, 6);
    assert.equal(f.writes.length, 6);
  } finally { await f.close(); }
});

test('旧版未执行预览必须重新拆分，不能用旧三张计划写入', async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const filename = path.join(f.directory, 'requirement-plans.json');
    const records = JSON.parse(await readFile(filename, 'utf8'));
    delete records[0].scheduleRuleVersion;
    await writeFile(filename, JSON.stringify(records));
    const restored = await f.store.get({ taskId: 'preview' });
    assert.equal(restored.needsScheduleReview, true);
    assert.match(jiraDevStartBlocker({ workflow: 'requirement', plan: restored } as any), /重新生成/);
    await assert.rejects(f.store.apply({ taskId: 'preview', confirmed: true }), /重新生成/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

for (const uncertain of [false, true]) test(`分段创建中断，${uncertain ? '结果待核对先只读恢复' : '明确失败仅重试缺项'}，不重复已有子任务`, async () => {
  const f = await fixture();
  try {
    const create = f.jira.createRequirementIssue;
    let interrupted = false;
    f.jira.createRequirementIssue = async input => {
      if (!interrupted && f.writes.length === 2) {
        interrupted = true;
        if (uncertain) await create(input);
        throw Object.assign(new Error('模拟网络中断'), { uncertain });
      }
      return create(input);
    };
    await f.prepare();
    const interruptedPlan = await f.store.apply({ taskId: 'preview', confirmed: true });
    assert.equal(interruptedPlan.status, uncertain ? 'unknown' : 'error');
    if (uncertain) {
      const reconciled = await f.store.get({ taskId: 'preview' });
      assert.equal(reconciled.status, 'ready', reconciled.warning || '');
      assert.equal(f.writes.length, 3);
    }
    const done = await f.store.apply({ taskId: 'preview', confirmed: true });
    assert.equal(done.status, 'applied', done.warning || '');
    assert.equal(f.writes.length, 6);
    assert.equal(new Set(done.items.map(item => item.key)).size, 6);
    assert.equal(done.developmentIssue?.key, done.items[0]!.key);
  } finally { await f.close(); }
});

test('已有拆分任务改变日期后不额外创建重叠子任务', async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.store.apply({ taskId: 'preview', confirmed: true });
    const changed = await f.prepare({ parent: { startDate: '2026-11-02', endDate: '2026-11-12' } }, 'changed');
    assert.equal(changed.status, 'local');
    assert.match(changed.warning || '', /已有子任务.*拆分日期不一致/);
    await f.store.apply({ taskId: 'changed', confirmed: true });
    assert.equal(f.writes.length, 6);
  } finally { await f.close(); }
});

test('真实 Jira 客户端接受带日期的子任务标记，保持一次创建与 GET 回读', async () => {
  const modulePath = '../server/jira-dev/jira-client.mjs';
  const { createJiraClient } = await import(modulePath);
  const marker = `jira-dev-requirement-${'a'.repeat(24)}-implementation-2026-11-06-2026-11-10`;
  const fields = { summary: '实现账户管理（第 2/3 段）', description: `JIRA_DEV_REQUIREMENT_MARKER: ${marker}`, project: { id: '1', key: 'APEX' },
    issuetype: { id: '11', subtask: true }, parent: { key: 'APEX-600' }, customfield_10109: '2026-11-06', customfield_10110: '2026-11-10' };
  const calls: string[] = [];
  const client = createJiraClient({ env: { JIRA_BASE_URL: 'https://jira.example.test', JIRA_API_TOKEN: 'test-only', JIRA_USERNAME: 'test@example.test' },
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push(init.method || 'GET');
      return new Response(JSON.stringify(init.method === 'POST' ? { key: 'APEX-601' } : { key: 'APEX-601', fields }));
    } });
  const saved = await client.createRequirementIssue({ source: source.url, fields, marker, confirmed: true });
  assert.equal(saved.verified, true);
  assert.equal(saved.startDate, fields.customfield_10109);
  assert.deepEqual(calls, ['POST', 'GET']);
});

const scopeDescription = `h2. 背景 / 问题
现有表单尚未区分服务商与收单行。
h2. 需求范围
 * 新增 {*}POS 服务商{*}选择，支持百富、Nayax、CA；收单行分别联动 UP/SHIFT4、Nayax、Adyen。
 * 模式支持{*}大商户、平台账户、独立账户{*}。平台账户和独立账户须填写进件商家名称、商户号；大商户无需填写。
 * 新增{*}是否展示{*}：独立账户固定为“否”；其他两种模式默认“是”，可修改。
 * 相同模式且所有字段一致时，禁止重复创建。创建成功后，列表展示 POS 服务商、收单行、模式、进件信息和是否展示，并保留原有列。
 * 本次范围为新建表单与列表展示，不调整现有支付、计费和结算规则。
h2. 验收标准
 # 必填信息缺失或配置完全重复时，无法创建。`;

test('OPAY-778 行内目标提取实际前端范围，按日期拆分且不把后台扣款算法作为子任务', async () => {
  const description = '*背景：* Nayax POS 机在部分国家不支持增量预授权，订单金额超过预授权金额时整笔扣款会失败，商家一分钱都收不到。\r\n\r\n*目标：* 在国家基础配置中新增「Nayax增量预授权」开关。对配置为不支持的国家，订单超额时按预授权金额扣款，确保至少收回预授权金额，并在活动详情中记录说明，方便排查。\r\n\r\n*范围：* 只涉及 POS 机供应商为 Nayax 的设备，百富、CA 不受影响；配置为「支持」的国家，扣款逻辑与现状完全一致。\r\n\r\n{*}文档{*}：https://example.test/prd';
  const f = await fixture({ summary: 'Nayax基于国家维护增量预授权扣款规则', description, startDate: '2026-11-04', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare({}, 'nayax', { businessModule: '预授权', details: '' });
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.deepEqual(children.map(item => item.summary), ['【预授权】实现 国家基础配置「Nayax增量预授权」开关', '【预授权】实现 活动详情记录说明']);
    assert.deepEqual(ranges(plan).slice(2), [['implementation', '2026-11-05', '2026-11-06'], ['implementation', '2026-11-09', '2026-11-11']]);
    assert.deepEqual(children.map(item => item.workdays), [2, 3]);
    assert.ok(children.every(item => item.marker?.includes(item.schedule!.startDate) && item.marker?.includes(item.schedule!.endDate)));
    const scopes = children.map(item => String(item.description).split('本子任务需求范围：')[1]?.split('计划范围：')[0]);
    assert.ok(scopes[0]?.includes('Nayax增量预授权'));
    assert.ok(scopes[1]?.includes('活动详情'));
    assert.ok(scopes.every(scope => !/订单超额|按预授权金额扣款|百富、CA/u.test(scope || '')));
    assert.equal(plan.sourceIssue?.description, description);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('行内范围和叙述段落优先于目标，单星双星Markdown与ADF均可拆出实际功能', async () => {
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const descriptions = [
    '*目标：* 新增不应优先取作标题的页面。\n*前端范围：* 商户列表查询，支持筛选。账户详情展示。\n*验收标准：* 不应取作标题的验收。',
    '**需求范围：** 商户列表查询，支持筛选。账户详情展示。\n**排除范围：** 后端账单计算。',
    '*前端范围*商户列表查询，支持筛选。账户详情展示。',
    '## 范围\n商户列表查询，支持筛选。账户详情展示。\n## 相关文档\nhttps://example.test/prd',
    { type: 'doc', content: [paragraph('前端范围：商户列表查询，支持筛选。账户详情展示。'), paragraph('验收标准：不应取作标题的验收。')] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '前端范围', marks: [{ type: 'strong' }] }, { type: 'text', text: '商户列表查询，支持筛选。账户详情展示。' }] }, paragraph('验收标准：不应取作标题的验收。')] },
  ];
  for (const description of descriptions) {
    const f = await fixture({ description, startDate: '2026-11-03', endDate: '2026-11-11' });
    try {
      const plan = await f.prepare();
      assert.deepEqual(plan.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 商户列表查询', '【商家账户】实现 账户详情展示']);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('后台管理页面是前端范围，后端运算和数据库变更不能混入', async () => {
  const f = await fixture({ description: '*前端范围：* 后台管理页面国家配置开关。活动详情展示扣款说明。后台调整扣款算法。后端提供页面展示所需扣款金额。数据库新增字段，页面读取该字段。', startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.deepEqual(children.map(item => item.summary), ['【商家账户】实现 后台管理页面国家配置开关', '【商家账户】实现 活动详情展示扣款说明']);
    assert.ok(children.every(item => !/后台调整|后端提供|数据库新增/u.test(String(item.description).split('本子任务需求范围：')[1]?.split('计划范围：')[0] || '')));
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('否定新增或修改的目标不分配开发范围，不支持条件和禁止重复创建仍可作为实际功能', async () => {
  const f = await fixture({ description: '*目标：* 不新增国家配置开关。在国家配置中不修改开关。在国家配置中无需修改字段。对不支持增量预授权的国家新增页面提示。在活动详情中记录说明。', startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    assert.deepEqual(plan.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 对不支持增量预授权的国家新增页面提示', '【商家账户】实现 活动详情记录说明']);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('后台计算句中的配置名词不算UI动作，列表展示扣款金额仍是前端功能', async () => {
  for (const goal of ['依据国家配置开关计算订单扣款金额', '按国家配置开关执行扣款']) {
    const f = await fixture({ description: `*目标：* ${goal}。`, startDate: '2026-11-03', endDate: '2026-11-11' });
    try {
      const plan = await f.prepare();
      for (const item of plan.items.filter(item => item.role === 'implementation')) assert.equal(item.summary, `【商家账户】实现 升级账户管理（${item.schedule!.startDate} 至 ${item.schedule!.endDate}）`);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture({ description: '*目标：* 依据国家配置开关计算订单扣款金额。在订单列表中展示扣款金额。活动详情显示扣款结果。', startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    assert.deepEqual(plan.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 订单列表展示扣款金额', '【商家账户】实现 活动详情显示扣款结果']);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('用户补充的明确范围优先于Jira前端范围，两处明确范围都优先于目标', async () => {
  const f = await fixture({ description: '*前端范围：* 原需求列表查询。原需求账户详情。', startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare({}, 'details-scope', { details: '*需求范围：* 用户指定商户筛选。用户指定账户表单校验。' });
    assert.deepEqual(plan.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 用户指定商户筛选', '【商家账户】实现 用户指定账户表单校验']);
    const onlyGoal = await f.prepare({}, 'details-goal', { details: '*目标：* 新增补充目标页面。新增另一个目标页面。' });
    assert.deepEqual(onlyGoal.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 原需求列表查询', '【商家账户】实现 原需求账户详情']);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('截图需求按真实功能命名，标题没有时间分段序号；每张子任务正文对应分配的范围', async () => {
  const f = await fixture({ description: scopeDescription, startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'ready', plan.warning || '');
    const items = plan.items.filter(item => item.role === 'implementation');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.summary), [
      '【商家账户】实现 POS 服务商选择、模式支持大商户、平台账户、独立账户',
      '【商家账户】实现 是否展示、禁止重复创建与列表展示',
    ]);
    assert.match(String(items[0].description), /本子任务需求范围：[\s\S]*POS 服务商[\s\S]*模式支持/);
    assert.match(String(items[1].description), /本子任务需求范围：[\s\S]*是否展示[\s\S]*禁止重复创建/);
    assert.equal(plan.sourceIssue?.description, scopeDescription);
    assert.equal(f.writes.length, 0);
    const applied = await f.store.apply({ taskId: 'preview', confirmed: true });
    assert.equal(applied.status, 'applied', applied.warning || '');
    assert.deepEqual(f.writes.map(fields => fields.summary), plan.items.map(item => item.summary));
    f.issues[2].summary = '已有 Jira 原始标题（第 1/2 段）L123';
    const again = await f.prepare({}, 'second-preview');
    assert.equal(again.items[2]!.summary, f.issues[2].summary);
    assert.equal(again.items[2]!.id, items[0].id);
    assert.equal(f.writes.length, 4);
  } finally { await f.close(); }
});

test('Markdown 与 ADF 的明确功能范围可用于标题，背景与排除范围不能混入', async () => {
  const markdown = await fixture({ description: '## 背景\n- 不应取作功能的背景\n## 前端范围\n- 商户列表查询，支持筛选\n- 账户详情展示\n- 不涉及结算规则\n## 验收标准\n- 不应取作标题的验收原文', startDate: '2026-11-03', endDate: '2026-11-11' });
  const heading = (text: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
  const bullet = (text: string) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const adf = await fixture({ description: { type: 'doc', content: [heading('需求范围'), { type: 'bulletList', content: [bullet('商户列表查询'), bullet('账户详情展示')] }, heading('验收标准'), { type: 'paragraph', content: [{ type: 'text', text: '不要作为功能标题' }] }] }, startDate: '2026-11-03', endDate: '2026-11-11' });
  try {
    for (const f of [markdown, adf]) {
      const plan = await f.prepare();
      assert.equal(plan.status, 'ready', plan.warning || '');
      assert.deepEqual(plan.items.filter(item => item.role === 'implementation').map(item => item.summary), ['【商家账户】实现 商户列表查询', '【商家账户】实现 账户详情展示']);
      assert.equal(f.writes.length, 0);
    }
  } finally { await markdown.close(); await adf.close(); }
});

test('没有功能范围证据时按真实日期区分，不编造功能阶段或子任务编号', async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare();
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.equal(new Set(children.map(item => item.summary)).size, children.length);
    for (const item of children) {
      assert.equal(item.summary, `【商家账户】实现 升级账户管理（${item.schedule!.startDate} 至 ${item.schedule!.endDate}）`);
      assert.doesNotMatch(item.summary, /子任务\s*\d+\s*\/\s*\d+/u);
      assert.doesNotMatch(item.summary, /第\s*[一二三四五六七八九十\d]+(?:\s*\/\s*\d+)?\s*(?:阶段|段|项功能)/u);
      assert.ok(item.summary.length <= 250);
      assert.ok(String(item.description).includes('需求原文 L123'));
    }
  } finally { await f.close(); }
});

test('条目少于日期段时保留已有具体范围，其余任务用日期区分而不凭空补功能', async () => {
  const f = await fixture({ description: '*前端范围：* 商户列表查询' });
  try {
    const plan = await f.prepare();
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.equal(children.length, 4);
    assert.equal(children[0].summary, '【商家账户】实现 商户列表查询');
    assert.ok(String(children[0].description).includes('本子任务需求范围：\n- 商户列表查询'));
    for (const item of children.slice(1)) {
      assert.equal(item.summary, `【商家账户】实现 升级账户管理（${item.schedule!.startDate} 至 ${item.schedule!.endDate}）`);
      assert.ok(!String(item.description).includes('本子任务需求范围：'));
    }
    assert.equal(new Set(children.map(item => item.summary)).size, children.length);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('Jira 单星标题与有序列表按功能命名，排除范围、验收和关联文档不混入标题', async () => {
  const description = `*背景* 同一商家需要区分多个资金账户。\r\n\r\n*需求范围*\r\n # 分账户展示：分别展示余额、流水、报表与提现记录；\r\n # 灰度联动：未开启灰度时保留旧版页面；\r\n # App 财务首页：按账户展示余额与入口；\r\n # App 提现：申请、记录及详情增加账户标识；\r\n # App 资金流水：列表和详情按账户区分；\r\n # App/PC 资金报表：按账户及账期展示分类明细；\r\n # 本期不调整既有计费、结算规则；Adyen 退款改造另行立项。\r\n\r\n*验收标准*\r\n # 不应取作功能标题的验收内容\r\n\r\n*关联文档*\r\n * PRD：https://example.test/prd`;
  const f = await fixture({ summary: '【APP】Adyen商家账户拆分', description, startDate: '2026-10-28', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    assert.equal(plan.status, 'ready', plan.warning || '');
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.deepEqual(children.map(item => item.summary), [
      '【APP】实现 分账户展示',
      '【APP】实现 灰度联动、App 财务首页',
      '【APP】实现 App 提现',
      '【APP】实现 App 资金流水、App/PC 资金报表',
    ]);
    assert.deepEqual(ranges(plan).slice(2), [
      ['implementation', '2026-10-29', '2026-10-30'], ['implementation', '2026-11-02', '2026-11-04'],
      ['implementation', '2026-11-05', '2026-11-06'], ['implementation', '2026-11-09', '2026-11-11'],
    ]);
    assert.ok(children.every(item => item.marker?.includes(item.schedule!.startDate) && item.workdays! <= 3));
    assert.match(String(children[3]!.description), /本子任务需求范围：[\s\S]*App 资金流水[\s\S]*App\/PC 资金报表/);
    assert.equal(plan.sourceIssue?.description, description);
    assert.equal(f.writes.length, 0);
    const applied = await f.store.apply({ taskId: 'preview', confirmed: true });
    assert.equal(applied.status, 'applied', applied.warning || '');
    assert.deepEqual(f.writes.map(fields => fields.summary), plan.items.map(item => item.summary));
  } finally { await f.close(); }
});

test('功能标题截断发生冲突时以真实日期区分，技术方案与实现标题均不超长', async () => {
  const description = `## 需求范围\n${Array.from({ length: 6 }, (_, index) => `- ${'功能范围'.repeat(20)}${index}`).join('\n')}`;
  const f = await fixture({ description, startDate: '2026-11-02', endDate: '2026-11-13' });
  try {
    const plan = await f.prepare({ design: { startDate: '2026-11-02', endDate: '2026-11-06' }, implementation: { startDate: '2026-11-09', endDate: '2026-11-13' } }, 'long', { businessModule: '账户模块'.repeat(25) });
    assert.equal(plan.status, 'ready', plan.warning || '');
    for (const role of ['design', 'implementation']) {
      const children = plan.items.filter(item => item.role === role);
      assert.equal(children.length, 2);
      assert.equal(new Set(children.map(item => item.summary)).size, children.length);
      assert.ok(children.every(item => item.summary.length <= 250 && item.summary.endsWith(`（${item.schedule!.startDate} 至 ${item.schedule!.endDate}）`)));
      assert.ok(children.every(item => !/子任务\s*\d+\s*\/\s*\d+/u.test(item.summary)));
    }
  } finally { await f.close(); }
});

test('需求功能名自带旧子任务编号时，用日期保持唯一且不继承编号', async () => {
  const f = await fixture({ description: '*需求范围*\n # 账户创建：表单校验\n # 账户创建：提交接口\n # 账户创建（子任务 1/3）', startDate: '2026-11-02', endDate: '2026-11-11' });
  try {
    const plan = await f.prepare();
    const children = plan.items.filter(item => item.role === 'implementation');
    assert.equal(children.length, 3);
    assert.equal(new Set(children.map(item => item.summary)).size, children.length);
    assert.ok(children.every(item => item.summary.endsWith(`（${item.schedule!.startDate} 至 ${item.schedule!.endDate}）`) && !/子任务\s*\d+\s*\/\s*\d+/u.test(item.summary)));
  } finally { await f.close(); }
});

test('标题规则更新拦住未执行旧预览，已经尝试创建的计划按原确认内容恢复', async () => {
  for (const attempted of [false, true]) {
    const f = await fixture();
    try {
      await f.prepare();
      const filename = path.join(f.directory, 'requirement-plans.json');
      const records = JSON.parse(await readFile(filename, 'utf8'));
      records[0].titleRuleVersion = 4;
      if (attempted) records[0].items[0].attemptedAt = '2026-11-03T01:00:00Z';
      await writeFile(filename, JSON.stringify(records));
      const restored = await f.store.get({ taskId: 'preview' });
      if (!attempted) {
        assert.equal(restored.needsTitleReview, true);
        await assert.rejects(f.store.apply({ taskId: 'preview', confirmed: true }), /重新生成预览/);
        assert.equal(f.writes.length, 0);
      } else {
        assert.notEqual(restored.needsTitleReview, true);
        const applied = await f.store.apply({ taskId: 'preview', confirmed: true });
        assert.equal(applied.status, 'applied', applied.warning || '');
        assert.equal(f.writes.length, records[0].items.length);
      }
    } finally { await f.close(); }
  }
});

test('旧版已应用或结果未知的计划保留原确认内容，不因标题升级重建或改Jira', async () => {
  for (const status of ['applied', 'unknown']) {
    const f = await fixture();
    try {
      await f.prepare();
      if (status === 'applied') await f.store.apply({ taskId: 'preview', confirmed: true });
      const filename = path.join(f.directory, 'requirement-plans.json');
      const records = JSON.parse(await readFile(filename, 'utf8'));
      records[0].titleRuleVersion = 4;
      records[0].items[2].summary = '旧版真实任务标题（子任务 1/4）';
      if (status === 'unknown') { records[0].items[0].state = 'unknown'; records[0].items[0].attemptedAt = '2026-11-04T01:00:00Z'; }
      await writeFile(filename, JSON.stringify(records));
      const writes = f.writes.length;
      const select = (items: any[]) => items.map(item => ({ summary: item.summary, marker: item.marker, schedule: item.schedule }));
      const restored = await f.prepare({}, 'preview', { details: '*前端范围：* 新列表查询。新表单校验。' });
      assert.equal(restored.status, status);
      assert.notEqual(restored.needsTitleReview, true);
      assert.deepEqual(select(restored.items), select(records[0].items));
      assert.equal(f.writes.length, writes);
    } finally { await f.close(); }
  }
});

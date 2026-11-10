import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJiraDevPrompt } from '../server/jira-dev-prompt.js';
import type { JiraDevTaskRecord } from '../server/jira-dev/index.mjs';

const body = '需求原文：支持 POS 服务商、收单行和账户模式联动；接口文案 L123 原样显示。'.repeat(30) + '需求验收边界结束。';
const details = '用户补充：只修改本次表单和列表，不变更支付、计费、结算规则，不处理历史文案；保留独立账户的展示约束和重复创建校验。';
const workspace = { workspacePath: '/projects/web-tasks/APEX-602', baseSha: 'a'.repeat(40) };
function fixture(description: unknown = body) {
  const source = { key: 'APEX-562', url: 'https://jira.example.test/browse/APEX-562', summary: '【商家账户】收款账户升级', description,
    project: { id: '1', key: 'APEX', name: '商家管理' }, fixVersions: [{ id: '2', name: 'v3.0.2.0' }],
    rawFields: { repeatedMetadata: '不应发送的 Jira 元数据'.repeat(500) } };
  const items = (['parent', 'design', 'implementation'] as const).map((role, index) => {
    const key = `APEX-${602 + index}`;
    const text = typeof description === 'string' ? `需求正文原文：${description}\n用户补充原文：${details}\n${role} 独有验收：L${200 + index}。` : description;
    const issue = { ...source, key, url: `https://jira.example.test/browse/${key}`, summary: `${role} 原始 Jira 标题 L${200 + index}`, description: text };
    return { role, key, url: issue.url, action: 'create' as const, state: 'created', summary: issue.summary, description: text, issue,
      schedule: { startDate: '2026-11-04', endDate: '2026-11-06', changed: false }, fields: { description: text, summary: issue.summary, rawFields: source.rawFields } };
  });
  const task: JiraDevTaskRecord = { taskId: 'compact-prompt-test', workflow: 'requirement', key: source.key, issueUrl: source.url, sourceIssue: source,
    source: source.url, details, sourceProjectPath: '/projects/web', projectPath: workspace.workspacePath, baseSha: workspace.baseSha,
    branchName: 'feature/APEX-562', baseBranch: 'master', useI18n: false,
    requirementPlan: { taskId: 'compact-prompt-test', status: 'applied', sourceKind: 'product', sourceIssue: source, developmentIssue: items[0]!.issue, items,
      designDestination: { site: 'https://confluence.example.test', spaceKey: 'TEAM', parentId: '123', title: '技术方案', url: 'https://confluence.example.test/pages/viewpage.action?pageId=123' },
      designPublicationAuthorized: true } };
  return task;
}
const occurrences = (text: string, fragment: string) => text.split(fragment).length - 1;

test('多语言导入表按已绑定前端任务命名，各协作模式保持一致', () => {
  const task = { ...fixture(), useI18n: true };
  for (const mode of ['manual', 'automatic', 'group'] as const) {
    const { prompt } = buildJiraDevPrompt(task, workspace, mode);
    assert.ok(prompt.includes('tempdocs/APEX-602-多语言.xlsx'), mode);
    assert.ok(!prompt.includes('tempdocs/APEX-562-多语言.xlsx'), '不能用原始产品需求代替绑定任务编号');
    assert.ok(!prompt.includes('tempdocs/i18n-import.xlsx'));
  }
});

test('启动提示词仅保留一份需求和用户补充，去掉写入副本与元数据，保留各任务独有条件和执行边界', () => {
  const task = fixture(), original = structuredClone(task);
  const { prompt, title } = buildJiraDevPrompt(task, workspace);
  assert.equal(occurrences(prompt, body), 1);
  assert.equal(occurrences(prompt, details), 1);
  assert.doesNotMatch(prompt, /repeatedMetadata|rawFields/);
  assert.match(prompt, /descriptionRef/);
  for (const item of task.requirementPlan!.items) {
    assert.ok(prompt.includes(item.key!));
    assert.ok(prompt.includes(item.summary));
    assert.ok(prompt.includes(`${item.role} 独有验收：`));
  }
  for (const value of [task.taskId, task.branchName, workspace.workspacePath, workspace.baseSha, '2026-11-04', '2026-11-06', 'v3.0.2.0', '商家管理', 'useI18n=false', '"requirementProgress"', '不改 Jira 状态或指派', '不推送', '不重复', '接口返回展示文案原样显示', '父页面 ID：123']) assert.ok(prompt.includes(value), value);
  assert.match(title, /APEX-602/);
  assert.deepEqual(task, original);
});

test('ADF 需求保留结构和完整原文，相同正文只引用，不因长度截断独有信息', () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body, marks: [{ type: 'strong' }] }] }] };
  const task = fixture(adf), { prompt } = buildJiraDevPrompt(task, workspace);
  assert.equal(occurrences(prompt, JSON.stringify(adf)), 1);
  assert.ok(prompt.includes('需求验收边界结束。'));
  assert.deepEqual(task.sourceIssue!.description, adf);
});

test('仅提供正文的本地需求不重复拼接用户原文，不伪造 Jira 已登记', () => {
  const task = fixture();
  task.key = ''; task.issueUrl = ''; task.source = ''; task.details = body;
  task.sourceIssue = { key: '', url: '', summary: '本地需求', description: body };
  task.requirementPlan = { taskId: task.taskId, sourceKind: 'product', status: 'local', sourceIssue: task.sourceIssue,
    items: [{ role: 'implementation', action: 'create', summary: '本地功能', description: body, state: 'pending' }] };
  const { prompt } = buildJiraDevPrompt(task, workspace);
  assert.equal(occurrences(prompt, body), 1);
  assert.match(prompt, /未写入 Jira/);
  assert.match(prompt, /不猜新事项编号/);
});

test('前端修复仅去重原缺陷资料，保留开发 Jira、独有修复范围与四段交接协议', () => {
  const task = fixture();
  task.workflow = 'jira';
  task.repairPlan = { ...task.requirementPlan!, sourceKind: 'defect' };
  delete task.requirementPlan;
  const { prompt } = buildJiraDevPrompt(task, workspace);
  assert.equal(occurrences(prompt, body), 1);
  assert.equal(occurrences(prompt, details), 1);
  assert.match(prompt, /本次开发、分支和交接绑定前端任务 APEX-602/);
  assert.match(prompt, /parent 独有验收：L200/);
  assert.match(prompt, /问题原因、影响范围、测试建议、自测结论/);
  assert.match(prompt, /"jiraHandoff"/);
  assert.match(prompt, /不自动关闭、转派或回填原缺陷/);
});

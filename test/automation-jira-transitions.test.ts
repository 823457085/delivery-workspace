import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 原 Jira 后端为 ESM JavaScript。
import { executeAutomationTransitions, transitionJiraIssue } from '../server/jira-backend/server.mjs';
// @ts-expect-error 原 Jira 后端为 ESM JavaScript。
import { buildAutomationPlan, DEFAULT_AUTOMATION_SETTINGS } from '../server/jira-backend/automation-core.mjs';

test('到期子任务按 Jira 可用流转经过预发布，所有交付子任务完成后才推进到期父任务', async () => {
 const today = '2026-11-12';
 const settings = { ...DEFAULT_AUTOMATION_SETTINGS, autoTransitionJira:true, autoCloseDueSplitTasks:true };
 const issue = (key: string, status: string, extra = {}) => ({
  key, status, statusCategory:status === '已完成' ? 'Done' : 'In Progress',
  summary:'实现功能', endDate:'2026-11-11', issueType:'任务', ...extra,
 });
 const issues = [
  issue('DEMO-1','开发中'),
  issue('DEMO-2','测试中',{parent:{key:'DEMO-1'},issueType:'子任务',description:'schedule-group: demo\nschedule-slice: 1'}),
  issue('DEMO-3','开发中',{parent:{key:'DEMO-1'},issueType:'子任务',endDate:'2026-11-13'}),
  issue('DEMO-4','预发布',{issueType:'子任务',labels:['delivery-3-day-split']}),
  issue('DEMO-5','测试中',{issueType:'子任务',summary:'【3天进度切片 1/2】实现功能'}),
 ];
 // Explicit date markers use the current system date; make them unambiguously overdue.
 issues[1]!.endDate = '2000-01-01';
 const statuses = new Map(issues.map(item => [item.key,item.status]));
 const writes: string[] = [];
 const workflow: Record<string, string[]> = {'开发中':['测试中'], '测试中':['预发布'], '预发布':['已完成']};
 const request = async (url: string, init: RequestInit) => {
  const key = url.split('/').at(-2)!;
  const current = statuses.get(key)!;
  const next = key === 'DEMO-5' && current === '测试中' ? ['已完成','预发布'] : workflow[current] || [];
  if (init.method !== 'POST') return Response.json({transitions:next.map(value => ({id:value,name:'流转操作',to:{name:value}}))});
  const target = JSON.parse(String(init.body)).transition.id;
  assert.ok(next.includes(target));
  statuses.set(key,target); writes.push(`${key}:${target}`);
  return new Response(null,{status:204});
 };
 const transition = (item: ReturnType<typeof issue>, target: string, options: object) =>
  transitionJiraIssue(item,target,{...options,request,authHeaders:{Authorization:'Bearer test'}});
 const alignEndDate = async (item: ReturnType<typeof issue>, targetEndDate: string) => {
  item.endDate = targetEndDate;
  return {issueKey:item.key,targetEndDate,status:'updated'};
 };
 const scan = (date = today) => executeAutomationTransitions(
  buildAutomationPlan(issues,[],[],settings), settings, date, {transition,alignEndDate}
 );
 const first = await scan();
 assert.deepEqual(first.find((result: {issueKey:string}) => result.issueKey === 'DEMO-2')?.transitionPath, ['预发布','已完成']);
 assert.deepEqual(writes.filter(value => value.startsWith('DEMO-4:')), ['DEMO-4:已完成'], '前次已进入预发布时从当前状态继续');
 assert.deepEqual(writes.filter(value => value.startsWith('DEMO-5:')), ['DEMO-5:已完成'], '有直接流转时不进入预发布');
 assert.ok(!writes.some(value => value.startsWith('DEMO-1:')), '尚有交付子任务未完成');
 Object.assign(issues[2]!, {status:'已完成',statusCategory:'Done'});
 statuses.set('DEMO-3','已完成');
 Object.assign(issues[0]!, {fixVersionDetails:[{releaseDate:'2026-11-13'}]});
 const second = await scan();
 assert.equal(second.find((result: {issueKey:string}) => result.issueKey === 'DEMO-1')?.targetEndDate, '2026-11-13');
 assert.ok(!writes.some(value => value.startsWith('DEMO-1:')), '版本未到期时只顺延结束日期');
 const third = await scan('2026-11-13');
 assert.deepEqual(third.find((result: {issueKey:string}) => result.issueKey === 'DEMO-1')?.transitionPath, ['测试中','预发布','已完成']);
 assert.equal(statuses.get('DEMO-1'), '已完成');
});

test('缺少已知前置流转时报告阻塞，不按操作名称误选不同目标状态', async () => {
 const issue = {key:'DEMO-6',status:'测试中'};
 let writes = 0;
 await assert.rejects(transitionJiraIssue(issue,'已完成',{
  followCompletionPath:true,authHeaders:{Authorization:'Bearer test'},
  request:async (_url: string, init: RequestInit) => {
   if (init.method === 'POST') writes++;
   return Response.json({transitions:[{id:'51',name:'已完成',to:{name:'待开始'}}]});
  },
 }), /无法从“测试中”推进到“已完成”/);
 assert.equal(writes, 0);
 assert.equal(issue.status, '测试中');
});

/** 本次商家联调的执行台账：只发布脱敏事实到已有静态目录，不覆盖人工审核。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';
import type { ExecutionProgress, RetestResult } from '../src/features/integration-execution/execution-plan.js';
import { assertIssueNotCleared } from './integration-cleared-issues.js';

const file = 'public/integration-runs/merchant-20261009.json';
const published = 'dist/integration-runs/merchant-20261009.json';
const action = process.argv[2];
let run: Omit<ExecutionProgress, 'automation' | 'retests'> & {
  automation?: ExecutionProgress['automation']; retests?: (RetestResult & { startedAt: string })[];
};
if (action === 'init') {
  const now = new Date().toISOString();
  const items = buildReviewCatalog().filter(item => item.ui.module === '运营管理' && /MerchantList|MerchantAdd|MerchantDetail/.test(item.ui.route));
  run = { status: '待配置', current: '请先配置本次商家联调环境与工作区', startedAt: '', updatedAt: now, environment: '',
    interfaces: items.map(item => ({ id: item.id, operationId: item.plan?.operationId || '', page: item.ui.page, request: `${item.method || '方法待确认'} ${item.path}`, status: !item.method ? '待契约确认' : item.method === 'GET' ? '待执行' : '需测试数据', result: !item.method ? '清单未定义可执行方法，先核对最新 BFF 和 demo 调用。' : item.method === 'GET' ? '' : '等待指定可用于写入的测试商家；未执行写操作。' })),
    pages: ['商家列表及筛选', '基础信息', '运营信息', '功能配置', '收款账户', '账户信息', '账单详情', '收费规则', '分期方案', '延保服务', 'API对接', '人员管理', '点位管理', '会员组管理'].map(name => ({ name, status: '待执行', result: '' })), issues: [],
  };
} else {
  run = JSON.parse(await fs.readFile(file, 'utf8'));
  const update = JSON.parse(process.argv[3]);
  if (action === 'issue' || action === 'retest') {
    const issueId = action === 'issue' ? update.id : update.issueId;
    await assertIssueNotCleared(process.cwd(), issueId, update.report ?? run.issues.find((issue: { id: string; report?: string }) => issue.id === issueId)?.report);
  }
  if (action === 'step') Object.assign(run, update);
  else if (action === 'interface' || action === 'page') {
    const item = action === 'interface' ? run.interfaces.find(item => item.id === update.id) : run.pages.find(item => item.name === update.name);
    if (!item) throw new Error('接口或页面不属于本批次');
    Object.assign(item, update, { checkedAt: new Date().toISOString() });
  }
  else if (action === 'issue') { const existing = run.issues.find((item: { id: string }) => item.id === update.id); if (existing) Object.assign(existing, update); else run.issues.push(update); }
  else if (action === 'retest') {
    if (!/^[a-f0-9-]{36}$/.test(update.requestId || '') || !update.environment?.trim() || !update.version?.trim() || !update.status?.trim() || !update.result?.trim()) throw new Error('回测记录需要请求编号、环境、版本、状态和结论');
    const issue = run.issues.find((item: { id: string }) => item.id === update.issueId);
    if (!issue?.retest) throw new Error('回测问题或原请求基线不存在');
    run.retests ??= [];
    const existing = run.retests.find((item: { requestId: string }) => item.requestId === update.requestId);
    if (update.status === '回测通过，待人工验收') {
      const startedAt = existing?.startedAt;
      const passed = (item?: { status: string; checkedAt?: string }) => item && ['已通过', '已修复'].includes(item.status) && item.checkedAt && startedAt && item.checkedAt >= startedAt;
      if (!existing?.startedAt || !issue.retest.interfaceIds.length || !issue.retest.pages.length
        || issue.retest.interfaceIds.some((id: string) => !passed(run.interfaces.find((item: { id: string }) => item.id === id)))
        || issue.retest.pages.some((name: string) => !passed(run.pages.find((item: { name: string }) => item.name === name)))
        || !/^\/integration-runs\/[a-zA-Z0-9._/-]+\.html$/.test(update.report || '') || update.report.includes('..')) throw new Error('原接口、对应页面和现场报告均在本次回测验证后才能记录通过');
      await fs.access(path.join('public', update.report));
    }
    update.updatedAt = new Date().toISOString();
    update.startedAt = existing?.startedAt || update.updatedAt;
    if (existing) Object.assign(existing, update); else run.retests.push(update);
  }
  else throw new Error('未知台账操作');
}
run.updatedAt = new Date().toISOString();
for (const target of [file, published]) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, JSON.stringify(run, null, 2) + '\n');
  await fs.rename(`${target}.tmp`, target);
}
await fs.copyFile('public/integration-runs/merchant-20261009.html', 'dist/integration-runs/merchant-20261009.html');
console.log(JSON.stringify({ status: run.status, current: run.current, updatedAt: run.updatedAt }));

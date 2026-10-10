/**
 * 设计说明：各菜单批次独立台账，沿用静态发布目录；同批次用文件锁保护读改写。
 * 不合并为一个全局可变文件，避免并行会话相互覆盖；商家旧台账仍由现有执行器维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { reviewLabel, type ApexBffReviewState } from '../shared/apex-bff-review.js';
import type { ExecutionProgress, RetestBaseline } from '../src/features/integration-execution/execution-plan.js';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';
import { loadIntegrationCatalog } from '../server/integration-catalog.js';
import { assertIssueNotCleared } from './integration-cleared-issues.js';

const dataRoot = (root: string) => path.resolve(root, process.env.DELIVERY_DATA_DIR || '.data');
const taskIds = ['merchant', 'equipment', 'finance', 'operations', 'configuration', 'monitoring'] as const;
type Action = 'step' | 'interface' | 'page' | 'issue' | 'retest';
type Ledger = Omit<ExecutionProgress, 'interfaces' | 'pages' | 'retests'> & {
  interfaces: (ExecutionProgress['interfaces'][number] & { checkedAt?: string })[];
  pages: (ExecutionProgress['pages'][number] & { checkedAt?: string })[];
  retests?: (NonNullable<ExecutionProgress['retests']>[number] & { startedAt: string })[];
};
type Update = Record<string, unknown>;
const contextHeaders = new Set(['x-region', 'x-language', 'x-timezone', 'x-request-id', 'x-platform', 'x-app-version']);
const fields: Record<Action, string[]> = {
  step: ['status', 'current'],
  interface: ['id', 'status', 'result'],
  page: ['name', 'status', 'result'],
  issue: ['id', 'summary', 'kind', 'status', 'description', 'notification', 'screenshot', 'report', 'retest', 'interfaceIds', 'pages'],
  retest: ['requestId', 'issueId', 'environment', 'version', 'status', 'result', 'report'],
};

function validateTask(taskId: string) {
  if (!taskIds.includes(taskId as typeof taskIds[number])) throw new Error('未知执行批次');
}
function object(value: unknown): Update {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('台账更新必须是 JSON 对象');
  return value as Update;
}
function textField(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}
function safeEvidence(value: unknown, extension = '(?:html|png|jpg|jpeg)') {
  if (typeof value !== 'string' || !new RegExp(`^/integration-runs/[a-zA-Z0-9._/-]+\\.${extension}$`).test(value) || value.includes('..')) throw new Error('证据必须是 integration-runs 内的相对文件 URL');
  return value;
}
function assertSanitized(value: unknown) {
  if (typeof value === 'string' && /\b(?:Bearer\s+\S+|(?:Authorization|Cookie|Set-Cookie)\s*[:=])|(?:[?&]|\b)(?:token|password|secret|access_token)=/i.test(value)) throw new Error('不得保存鉴权头、密码或 Token');
  if (Array.isArray(value)) value.forEach(assertSanitized);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (/(?:authorization|cookie|password|passwd|token|secret)/i.test(key)) throw new Error('不得保存鉴权头、密码或 Token');
    if (key === 'headers') for (const header of Object.keys(object(entry))) {
      if (!contextHeaders.has(header.toLowerCase())) throw new Error('回测只能保存非敏感上下文头');
    }
    assertSanitized(entry);
  }
}
function references(run: Ledger, value: Update) {
  const ids = value.interfaceIds, pages = value.pages;
  if (!Array.isArray(ids) || !Array.isArray(pages) || !ids.length && !pages.length
    || ids.some(id => typeof id !== 'string' || !run.interfaces.some(item => item.id === id))
    || pages.some(name => typeof name !== 'string' || !run.pages.some(item => item.name === name))) throw new Error('问题引用的接口和页面必须属于本批次');
}
function baseline(run: Ledger, value: unknown): RetestBaseline {
  const input = object(value);
  if (Object.keys(input).some(key => !['interfaceIds', 'pages', 'request', 'headers', 'requiredFields'].includes(key))) throw new Error('未知回测基线字段');
  references(run, input);
  if (typeof input.request !== 'string' || !/^GET \/[^\s]+$/.test(input.request)
    || !Array.isArray(input.requiredFields) || input.requiredFields.some(field => typeof field !== 'string')) throw new Error('回测基线需要原 GET 请求及字段约束');
  const headers = object(input.headers);
  if (Object.values(headers).some(value => typeof value !== 'string')) throw new Error('上下文头必须为字符串');
  return input as unknown as RetestBaseline;
}
async function locked<T>(root: string, taskId: string, callback: () => Promise<T>) {
  const lock = path.join(dataRoot(root), 'integration-execution-locks', `${taskId}.lock`);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 20_000;
  while (true) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`执行批次 ${taskId} 的台账锁等待超时；请检查写入进程`);
      await delay(20);
    }
  }
  // ponytail: 不抢占崩溃进程留下的锁，确认进程结束后手动移除，避免误删仍在使用的锁。
  try { return await callback(); }
  finally { await fs.rmdir(lock); }
}
async function publish(root: string, name: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  for (const directory of ['public', 'dist']) {
    const target = path.join(root, directory, 'integration-runs', `${name}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, content); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}

/** 更新本批次既有接口/页面或归属明确的问题，不接受调用者伪造检查时间。 */
export async function updateExecutionProgress(root: string, taskId: string, action: Action, input: unknown): Promise<Ledger> {
  validateTask(taskId);
  const update = object(input);
  if (!Object.hasOwn(fields, action)) throw new Error('未知台账操作');
  if (!Object.keys(update).length || Object.keys(update).some(key => !fields[action].includes(key))) throw new Error('未知或不可写的台账字段');
  assertSanitized(update);
  for (const key of ['description', 'screenshot', 'report']) if (update[key] !== undefined) safeEvidence(update[key]);
  return locked(root, taskId, async () => {
    const run: Ledger = JSON.parse(await fs.readFile(path.join(root, 'public/integration-runs', `${taskId}.json`), 'utf8'));
    if (action === 'issue' || action === 'retest') {
      const issueId = action === 'issue' ? update.id : update.issueId;
      await assertIssueNotCleared(root, issueId, update.report ?? run.issues.find(issue => issue.id === issueId)?.report);
    }
    const now = new Date().toISOString();
    if (action === 'step') {
      for (const value of Object.values(update)) textField(value, '执行步骤');
      Object.assign(run, update);
    } else if (action === 'interface' || action === 'page') {
      textField(update.status, '检查状态');
      if (typeof update.result !== 'string') throw new Error('检查结论必须是字符串');
      const item = action === 'interface' ? run.interfaces.find(item => item.id === update.id) : run.pages.find(item => item.name === update.name);
      if (!item) throw new Error('接口或页面不属于本批次');
      Object.assign(item, update, { checkedAt: now });
    } else if (action === 'issue') {
      const existing = run.issues.find(item => item.id === update.id);
      const issue: Update = { ...existing, ...update };
      for (const key of ['id', 'summary', 'kind', 'status']) textField(issue[key], '问题字段');
      if (issue.retest) baseline(run, issue.retest);
      if (issue.interfaceIds || issue.pages) references(run, issue);
      if (!issue.retest && !issue.interfaceIds && !issue.pages) throw new Error('问题必须关联本批次接口或页面');
      if (existing) Object.assign(existing, update); else run.issues.push(issue as unknown as Ledger['issues'][number]);
    } else {
      for (const key of ['issueId', 'environment', 'version', 'status', 'result']) textField(update[key], '回测字段');
      if (typeof update.requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(update.requestId)) throw new Error('回测请求编号无效');
      if (update.environment !== run.automation.environment || (update.version as string).length > 200) throw new Error('回测环境或版本无效');
      const issue = run.issues.find(item => item.id === update.issueId);
      if (!issue?.retest) throw new Error('回测问题或原请求基线不存在');
      const original = baseline(run, issue.retest);
      run.retests ??= [];
      const existing = run.retests.find(item => item.requestId === update.requestId);
      if (existing && ['issueId', 'environment', 'version'].some(key => existing[key as 'issueId' | 'environment' | 'version'] !== update[key])) throw new Error('同一回测请求不能更换问题、环境或版本');
      if (update.status === '回测通过，待人工验收') {
        const startedAt = Date.parse(existing?.startedAt || '');
        const passed = (item?: { status: string; checkedAt?: string }) => item && ['已通过', '已修复'].includes(item.status) && Date.parse(item.checkedAt || '') >= startedAt;
        if (!Number.isFinite(startedAt) || !original.interfaceIds.length || !original.pages.length
          || original.interfaceIds.some(id => !passed(run.interfaces.find(item => item.id === id)))
          || original.pages.some(name => !passed(run.pages.find(item => item.name === name)))) throw new Error('原接口和对应页面必须在本次回测开始后重新验证通过');
        const report = safeEvidence(update.report, 'html');
        const publicDirectory = await fs.realpath(path.join(root, 'public/integration-runs'));
        const evidence = await fs.realpath(path.join(root, 'public', report));
        if (!evidence.startsWith(`${publicDirectory}${path.sep}`) || !(await fs.stat(evidence)).isFile()) throw new Error('本次回测 HTML 证据不存在或越界');
      }
      const record = { ...update, startedAt: existing?.startedAt || now, updatedAt: now } as NonNullable<Ledger['retests']>[number];
      if (existing) Object.assign(existing, record); else run.retests.push(record);
    }
    run.updatedAt = now;
    await publish(root, taskId, run);
    return run;
  });
}

/** 初始化缺失的批次并补齐新增接口，已有实测结论和正在写入的商家台账保持原值。 */
export async function initializeExecutionProgress(root: string) {
  const { buildExecutionTasks } = await import('../src/features/integration-execution/execution-plan.js');
  let records: ApexBffReviewState = {};
  try { records = JSON.parse(await fs.readFile(path.join(dataRoot(root), 'apex-bff-review.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const configFile = process.env.DELIVERY_INTEGRATION_CONFIG_FILE || path.join(dataRoot(root), 'integration-execution-config.json');
  let automation: ExecutionProgress['automation'] = { workspacePath: '', deliveryRoot: root, baseUrl: '', environment: '', assignee: '' };
  try { automation = { ...automation, ...JSON.parse(await fs.readFile(configFile, 'utf8')) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const field of ['workspacePath', 'deliveryRoot', 'baseUrl', 'environment', 'assignee'] as const) {
    if (typeof automation[field] !== 'string') throw new Error(`联调配置 ${field} 必须为字符串`);
  }
  if (automation.baseUrl) {
    const url = new URL(automation.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('联调地址必须为无凭证的 http(s) 地址');
  }
  const tasks = buildExecutionTasks(buildReviewCatalog(await loadIntegrationCatalog()), records, automation.assignee);
  assertSanitized(automation);
  for (const task of tasks) {
    validateTask(task.id);
    await locked(root, task.id, async () => {
      const file = path.join(root, 'public/integration-runs', `${task.id}.json`);
      let run: Ledger;
      try { run = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        run = { status: task.deferred ? '延期执行' : '待执行', current: task.deferred ? '数据监控暂不自动执行' : '等待独立会话执行', startedAt: '', updatedAt: new Date().toISOString(), environment: automation.environment, automation, interfaces: [], pages: [], issues: [], retests: [] };
      }
      for (const item of task.items) {
        if (!run.interfaces.some(entry => entry.id === item.id)) run.interfaces.push({ id: item.id, operationId: item.plan?.operationId || '', page: item.ui.page, request: `${item.method || '方法待确认'} ${item.path}`, status: reviewLabel(records[item.id]) === '已联调' ? '人工已确认' : !item.method ? '待契约确认' : item.method === 'GET' ? '待执行' : '需测试数据', result: reviewLabel(records[item.id]) === '已联调' ? '沿用人工审核记录；自动实测证据独立记录。' : item.method && item.method !== 'GET' ? '等待可用于写入的测试数据；未自动执行写操作。' : '' });
        if (!run.pages.some(entry => entry.name === item.ui.page)) run.pages.push({ name: item.ui.page, status: '待执行', result: '' });
      }
      await publish(root, task.id, run);
    });
  }
  const plan = { automation, tasks: tasks.map(({ id, title, module, deferred, progressUrl }) => ({ id, title, module, deferred, progressUrl })) };
  await locked(root, 'execution-plan', () => publish(root, 'execution-plan', plan));
  return plan;
}

async function main() {
  if (process.argv[2] === 'init') {
    const plan = await initializeExecutionProgress(process.cwd());
    console.log(JSON.stringify({ tasks: plan.tasks.map(task => task.id) }));
  } else {
    let input: unknown;
    try { input = JSON.parse(process.argv[4]); } catch { throw new Error('台账更新 JSON 格式无效'); }
    const run = await updateExecutionProgress(process.cwd(), process.argv[2], process.argv[3] as Action, input);
    console.log(JSON.stringify({ status: run.status, current: run.current, updatedAt: run.updatedAt }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : '台账更新失败'); process.exitCode = 1; });
}

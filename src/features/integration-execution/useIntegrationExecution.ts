/** 每个模块独立会话及台账；页面只观察，不依赖页面常开来维持后台执行。 */
import { computed, inject, shallowRef } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { AgentRun, AgentRuntimeDashboard } from '../../../shared/agent-runtime';
import type { ApexBffReviewState } from '../../../shared/apex-bff-review';
import { integrationDeferral, integrationScopeCategory } from '../../../shared/apex-integration-scope';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { buildReviewCatalog } from '../api-integration/review-catalog';
import { readIntegrationCatalog, useIntegrationCatalog } from '../api-integration/useIntegrationCatalog';
import { activeExecution, buildExecutionTasks, createExecutionInput, executionIssueDeferral, executionRequest, progressUrl, taskInterfaces,
  type ExecutionPlan, type ExecutionProgress, type ExecutionRequest } from './execution-plan';

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`读取联调记录失败 (${response.status})`);
  return response.json();
}
async function readProgress(signal?: AbortSignal) {
  const plan = await read<ExecutionPlan>(progressUrl, signal);
  const ledgers: Record<string, ExecutionProgress> = Object.fromEntries(await Promise.all(plan.tasks.map(async task => {
    if (!/^\/integration-runs\/[a-z0-9-]+\.json$/.test(task.progressUrl)) throw new Error('联调台账路径无效');
    return [task.id, await read<ExecutionProgress>(task.progressUrl, signal)] as const;
  })));
  return { plan, ledgers };
}
async function post(url: string, input: unknown): Promise<AgentRun> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '执行请求未成功');
  return data;
}
const checkedStates = ['已通过', '后端阻塞', '前端问题', '已修复'];
const checked = (item: { checkedAt?: string; status: string }) => !!item.checkedAt || checkedStates.includes(item.status);
export function useIntegrationExecution() {
  const client = useQueryClient();
  const workspace = inject(agentWorkspaceContext, undefined);
  const { query: catalogQuery, catalog } = useIntegrationCatalog();
  const snapshot = useQuery({ queryKey: ['integration-execution-progress'], queryFn: ({ signal }) => readProgress(signal), refetchInterval: 5000, retry: false });
  const reviews = useQuery({ queryKey: ['apex-bff-review'], queryFn: ({ signal }) => read<ApexBffReviewState>('/api/apex-bff-review', signal), refetchInterval: 5000, retry: false });
  const runtime = useAgentRuntimeSnapshot();
  const sending = shallowRef(false);
  const runs = computed(() => runtime.data.value?.runs.filter(run => executionRequest(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []);
  const active = computed(() => runs.value.filter(run => ['queued', 'running'].includes(run.status)));
  const tasks = computed(() => buildExecutionTasks(catalog.value, reviews.data.value ?? {}, snapshot.data.value?.plan.automation.assignee).map(task => {
    const ledger = snapshot.data.value?.ledgers[task.id];
    const items = taskInterfaces(task, ledger, reviews.data.value ?? {});
    const executable = items.filter(item => item.category !== '暂不联调');
    const run = activeExecution(runs.value, task.id) || runs.value.find(entry => executionRequest(entry)?.taskId === task.id);
    const event = run?.events.filter(entry => ['message', 'diagnostic', 'lifecycle'].includes(entry.type)).at(-1)?.message;
    const current = run && (ledger?.updatedAt || '') < run.createdAt ? event || '已入队，等待更新现场进度' : ledger?.current || '尚未开始';
    return { ...task, progress: ledger, run, current, total: items.length, executable: executable.length, deferredCount: items.length - executable.length,
      pending: executable.filter(item => item.status === '待执行' && item.request.startsWith('GET ')).length,
      checked: executable.filter(checked).length,
      passed: executable.filter(item => ['已通过', '已修复'].includes(item.status)).length,
    };
  }));
  const interfaces = computed(() => tasks.value.flatMap(task => taskInterfaces(task, task.progress, reviews.data.value ?? {})));
  const executableInterfaces = computed(() => interfaces.value.filter(item => item.category !== '暂不联调'));
  const aggregate = computed<ExecutionProgress | undefined>(() => {
    if (!snapshot.data.value) return;
    const ledgers = tasks.value.map(task => task.progress).filter((value): value is ExecutionProgress => !!value);
    return { automation: snapshot.data.value.plan.automation, environment: snapshot.data.value.plan.automation.environment,
      status: active.value.length ? '并行执行中' : '等待执行', current: `${active.value.length} 个模块会话正在执行`,
      startedAt: ledgers.map(ledger => ledger.startedAt).filter(Boolean).sort()[0] || '',
      updatedAt: ledgers.map(ledger => ledger.updatedAt).sort().at(-1) || '', interfaces: interfaces.value,
      pages: tasks.value.flatMap(task => task.progress?.pages.map(page => {
        const item = { path: '', ui: { module: task.module, page: page.name } };
        return { ...page, name: `${task.title} / ${page.name}`, category: integrationScopeCategory(item), deferredReason: integrationDeferral(item) };
      }) ?? []),
      issues: tasks.value.flatMap(task => task.progress?.issues.map(issue => ({ ...issue, taskId: task.id, deferredReason: executionIssueDeferral(issue, task.items) })) ?? []),
      retests: tasks.value.flatMap(task => task.progress?.retests ?? []),
    };
  });
  const progress = { ...snapshot, data: aggregate };
  const metrics = computed(() => [
    { label: '分配给我的接口', value: interfaces.value.length, note: `全部模块 · ${snapshot.data.value?.plan.automation.assignee || '未配置负责人'}` },
    { label: '暂不联调', value: interfaces.value.length - executableInterfaces.value.length, note: '保留历史结果 · 本轮跳过' },
    { label: '本轮范围已检查', value: executableInterfaces.value.filter(checked).length, note: '包含阻塞与缺测试数据项' },
    { label: '自动检查通过', value: executableInterfaces.value.filter(item => ['已通过', '已修复'].includes(item.status)).length, note: '人工审核仍单独确认' },
    { label: '并行会话', value: active.value.length, note: '每个模块独立执行及回测' },
  ]);
  async function refresh() { await Promise.all([snapshot.refetch(), reviews.refetch(), runtime.refetch(), catalogQuery.refetch()]); }
  function observe(run: AgentRun) {
    client.setQueryData<AgentRuntimeDashboard>(['agent-runtimes'], current => current ? { ...current, runs: [run, ...current.runs.filter(item => item.id !== run.id)] } : current);
    void client.invalidateQueries({ queryKey: ['agent-runtimes'] });
  }
  async function dispatch(requests: Omit<ExecutionRequest, 'requestId'>[]) {
    if (sending.value) return;
    sending.value = true;
    let started = 0;
    try {
      const [dashboard, data, records, source] = await Promise.all([
        read<AgentRuntimeDashboard>('/api/agent-runtimes'), readProgress(), read<ApexBffReviewState>('/api/apex-bff-review'), readIntegrationCatalog(),
      ]);
      const codex = dashboard.runtimes.find(item => item.provider === 'codex');
      if (!codex) throw new Error('Codex 执行器不可用');
      const scope = buildExecutionTasks(buildReviewCatalog(source), records, data.plan.automation.assignee);
      // 同模块去重；不同模块独立原生队列，先派发的任务不会阻塞后续模块。
      for (const request of requests) {
        const taskId = request.taskId || 'merchant';
        const task = scope.find(item => item.id === taskId);
        if (!task || task.deferred) continue;
        const occupied = activeExecution(dashboard.runs, taskId);
        if (occupied) { observe(occupied); continue; }
        const ledger = data.ledgers[taskId];
        if (!ledger) throw new Error(`${task.title}台账尚未初始化`);
        const reconciled = { ...ledger, interfaces: taskInterfaces(task, ledger, records) };
        if (request.kind === 'integration' && !reconciled.interfaces.some(item => item.category !== '暂不联调' && item.status === '待执行' && item.request.startsWith('GET '))) continue;
        const input = createExecutionInput(reconciled, task.items, records, codex, { ...request, taskId, requestId: crypto.randomUUID() });
        const run = await post('/api/agent-runtimes/runs', input);
        dashboard.runs.unshift(run);
        observe(run);
        started++;
        try {
          await post(`/api/agent-runtimes/conversations/${run.conversationId || run.id}/title`, { title: request.kind === 'retest' ? `${task.title}回测 · ${request.issueId}` : `${task.title}联调 · ${data.plan.automation.assignee}` });
        } catch (error) { ElMessage.error((error as Error).message); }
      }
      ElMessage.success(started ? `已启动 ${started} 个独立会话，关闭页面后继续执行` : '已显示当前执行进度；没有新增可执行的查询任务');
    } catch (error) { ElMessage.error((error as Error).message); }
    finally { sending.value = false; }
  }
  function start(request: Omit<ExecutionRequest, 'requestId'>) { return dispatch([request]); }
  function startAll() { return dispatch(tasks.value.filter(task => !task.deferred && task.pending).map(task => ({ kind: 'integration', taskId: task.id }))); }
  async function stop(run: AgentRun) {
    if (sending.value || !executionRequest(run) || !['queued', 'running'].includes(run.status)) return;
    sending.value = true;
    try { observe(await post(`/api/agent-runtimes/runs/${run.id}/stop`, {})); }
    catch (error) { ElMessage.error((error as Error).message); }
    finally { sending.value = false; }
  }
  return { catalogQuery, progress, reviews, runtime, interfaces, tasks, runs, active, metrics, sending, refresh, start, startAll, stop, openRun: workspace?.openRun };
}

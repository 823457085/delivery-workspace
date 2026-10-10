/** Vue Query 持有服务端事实；本地只保留选择、筛选与当前展示页。 */
import { computed, shallowRef, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Dashboard, RunView, Scenario } from '../../../shared/types';

async function api<T>(url: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `请求失败 (${response.status})`);
  return data as T;
}

export function useDelivery() {
  const client = useQueryClient();
  const selectedId = shallowRef('');
  const selectedRunId = shallowRef('');
  const search = shallowRef('');
  const scenario = shallowRef<Scenario>('standard');
  const page = shallowRef<'workflow' | 'history' | 'source'>('workflow');
  const notice = shallowRef('');
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/api/dashboard'), refetchInterval: 1800 });
  watch(query.data, (data) => {
    if (data && !selectedId.value) selectedId.value = data.runs[0]?.requirement.id ?? data.source.requirements.find((item) => item.sourceStatus === 'AWAITING_REVIEW')?.id ?? data.source.requirements[0]?.id ?? '';
  }, { immediate: true });
  const selected = computed(() => query.data.value?.source.requirements.find((item) => item.id === selectedId.value));
  const currentRun = computed(() => query.data.value?.runs.find((item) => selectedRunId.value ? item.runId === selectedRunId.value : item.requirement.id === selectedId.value));
  const visibleRequirements = computed(() => {
    const term = search.value.trim().toLowerCase();
    const priority: Record<string, number> = { AWAITING_REVIEW: 0, BLOCKED: 1, RUNNING: 2, APPROVED: 3, HOLD: 4 };
    return (query.data.value?.source.requirements ?? [])
      .filter((item) => `${item.title} ${item.id} ${item.jiraKey}`.toLowerCase().includes(term))
      .sort((a, b) => (priority[a.sourceStatus] ?? 9) - (priority[b.sourceStatus] ?? 9));
  });
  const mutation = useMutation({
    mutationFn: (input: { url: string; data: unknown }) => api<{ runId?: string }>(input.url, input.data),
    onSuccess: async (result) => { if (result.runId) selectedRunId.value = result.runId; await client.invalidateQueries({ queryKey: ['dashboard'] }); },
    onError: (error) => { notice.value = error.message; },
  });
  async function act(url: string, data: unknown) { notice.value = ''; await mutation.mutateAsync({ url, data }).catch(() => {}); }
  function selectRequirement(id: string) { selectedId.value = id; selectedRunId.value = ''; }
  function selectRun(run: RunView) { selectedId.value = run.requirement.id; selectedRunId.value = run.runId; page.value = 'workflow'; }
  return { query, selected, currentRun, visibleRequirements, search, scenario, page, notice,
    busy: mutation.isPending, selectRequirement, selectRun,
    start: () => act('/api/runs', { requirementId: selectedId.value, scenario: scenario.value }),
    refresh: () => act('/api/source/refresh', {}),
    resume: (action: 'approve' | 'retest') => currentRun.value && act(`/api/runs/${currentRun.value.runId}/resume`, { action }),
    rework: () => currentRun.value && act(`/api/runs/${currentRun.value.runId}/rework`, {}),
  };
}

export function sourceStatusLabel(status: string) {
  return ({ APPROVED: '已通过', AWAITING_REVIEW: '待审核', BLOCKED: '阻塞', HOLD: '暂缓', RUNNING: '运行中' } as Record<string, string>)[status] ?? status;
}
export function runStatusLabel(run: RunView) {
  if (run.status === 'suspended') return run.gate?.kind === 'review' ? '等待审核' : run.gate?.kind === 'conflict' ? '合入冲突 · 演示' : '等待补测';
  return ({ running: '运行中', success: '演示完成', failed: '运行失败', cancelled: '已退回' } as const)[run.status];
}
export function formatTime(value: string | number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

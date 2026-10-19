import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import type { RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import { createRequestId } from './request-id';

/** 重试只使用已失败记录的原输入；新尝试与页面草稿互不覆盖。 */
export function useRequirementDevelopmentRetry(options: {
  records: MaybeRefOrGetter<RequirementDevelopmentRecord[]>;
  blocked: () => boolean;
  refresh: () => Promise<{ data?: RequirementDevelopmentRecord[]; isError?: boolean }>;
  openRun: (id: string) => void;
}) {
  type Attempt = { sourceId: string; requestId: string; phase: 'posting' | 'pending' | 'checking' | 'retryable' };
  const attempts = shallowRef<Record<string, Attempt>>({});
  const openedRuns = new Set<string>();
  const active = computed(() => Object.values(attempts.value).find(item => item.phase !== 'retryable'));
  const retryingId = computed(() => active.value?.sourceId || '');
  const busy = computed(() => !!active.value);

  function save(attempt: Attempt) { attempts.value = { ...attempts.value, [attempt.sourceId]: attempt }; }
  function settle(attempt: Attempt, record: RequirementDevelopmentRecord) {
    if (!record.runId && record.status !== 'failed') {
      save({ ...attempt, requestId: record.id, phase: 'pending' });
      return;
    }
    const next = { ...attempts.value };
    delete next[attempt.sourceId];
    attempts.value = next;
    if (record.runId) {
      if (!openedRuns.has(record.runId)) { openedRuns.add(record.runId); options.openRun(record.runId); }
    }
    else ElMessage.error(record.error || '启动结果需核对，请查看启动记录');
  }

  function reconcile(records: RequirementDevelopmentRecord[], allowMissing: boolean) {
    for (const attempt of Object.values(attempts.value)) {
      const record = records.find(item => item.id === attempt.requestId);
      if (record) settle(attempt, record);
      // 完整回读未发现记录时允许用户再次点击，但继续使用原 ID，防止迟到请求被重复受理。
      else if (allowMissing && attempt.phase === 'checking') save({ ...attempt, phase: 'retryable' });
    }
  }
  watch([() => toValue(options.records), options.blocked], ([records, blocked], [, wasBlocked]) => {
    // 查询错误解除也要核对，成功结果可能与上次列表相同而复用数组引用。
    reconcile(records, !blocked && wasBlocked);
  });

  async function retry(record: RequirementDevelopmentRecord) {
    const records = toValue(options.records);
    const source = records.find(item => item.id === record.id) || record;
    if (busy.value || options.blocked() || source.status !== 'failed' || source.runId) return;
    const previous = attempts.value[source.id];
    const known = previous && records.find(item => item.id === previous.requestId);
    if (known) {
      settle(previous, known);
      if (known.runId || known.status !== 'failed') return;
    }
    const requestId = attempts.value[source.id]?.requestId || createRequestId();
    save({ sourceId: source.id, requestId, phase: 'posting' });
    try {
      const response = await fetch('/api/agent-runtimes/requirement-development', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
        body: JSON.stringify({ requestId, input: source.input, authorization: 'create-jira-design-transition-and-develop' }),
      });
      const result = await response.json() as RequirementDevelopmentRecord & { message?: string };
      if (attempts.value[source.id]?.requestId !== requestId) return;
      if (!response.ok) throw new Error(result.message || '重试失败，请核对启动记录');
      settle({ sourceId: source.id, requestId: result.id, phase: 'pending' }, result);
      if (result.status === 'uncertain' && !result.runId) ElMessage.error(result.error || '启动结果需核对，请查看启动记录');
    } catch (error) {
      const attempt = attempts.value[source.id];
      if (attempt?.requestId !== requestId) return;
      if (attempt.phase === 'posting') save({ ...attempt, phase: 'checking' });
      ElMessage.error(error instanceof Error ? error.message : '重试请求中断，请先核对启动记录');
    } finally {
      try {
        const result = await options.refresh();
        if (!result.isError && result.data) reconcile(result.data, true);
      } catch { /* 回读失败仍保留请求 ID，现有刷新入口可继续核对。 */ }
    }
  }

  return { retry, retryingId, busy };
}

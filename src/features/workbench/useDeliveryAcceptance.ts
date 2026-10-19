import { computed, nextTick, ref, shallowRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { deliveryAcceptanceInputSchema, deliveryEvidenceSchema, emptyDeliveryEvidence, readDeliveryEvidenceReport, sameDeliverySource,
  type DeliveryAcceptanceInput, type DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import { deliveryAcceptanceQueryKey, saveDeliveryAcceptance } from './acceptance-api';
import type { DeliveryRecord } from './domain';

/** 打开或重读时按当前来源组装验收草稿；人工记录优先，报告只预填证据，避免实时更新覆盖编辑内容。 */
export function useDeliveryAcceptance(record: () => DeliveryRecord) {
  const client = useQueryClient();
  const open = shallowRef(false), saving = shallowRef(false), reloading = shallowRef(false), error = shallowRef('');
  const draft = ref<DeliveryAcceptanceInput>({ recordId: '', expectedRevision: 0, source: { runId: '', updatedAt: '' },
    checks: emptyDeliveryEvidence(), decision: 'pending', summary: '', authorization: 'record-delivery-acceptance' });
  const source = () => ({ runId: record().runId || '', updatedAt: record().updatedAt });
  const sourceChanged = computed(() => open.value && !sameDeliverySource(draft.value.source, source()));
  function fill() {
    const current = record(), currentSource = { runId: current.runId || '', updatedAt: current.updatedAt }, saved = current.acceptance;
    const manual = saved && sameDeliverySource(saved.source, currentSource) ? saved : undefined;
    const run = current.agentRuns?.find(item => item.id === current.runId);
    const active = ['preparing', 'starting'].includes(current.status)
      || current.agentRuns?.some(item => item.pausedForEdit || (item.status === 'interrupted' && item.recovery?.state === 'active'));
    const reported = !manual && !active && current.sourceKnown !== false && current.agentStateKnown !== false
      && run?.status === 'completed' && run.resultReady === true && !run.pausedForEdit ? readDeliveryEvidenceReport(run.result) : undefined;
    draft.value = { recordId: current.id, expectedRevision: saved?.revision || 0, source: currentSource,
      checks: manual ? deliveryEvidenceSchema.parse(manual.checks) : reported || emptyDeliveryEvidence(),
      decision: manual?.decision || 'pending', summary: manual?.summary || '',
      authorization: 'record-delivery-acceptance' };
    error.value = '';
  }
  function show() { fill(); open.value = true; }
  async function reload() {
    if (saving.value || reloading.value) return;
    reloading.value = true;
    try {
      await client.invalidateQueries({ predicate: query => ['source', 'design-executor', 'agent-runtimes', 'requirement-development', 'jira-fix', 'delivery-acceptance'].includes(String(query.queryKey[0])) }, { throwOnError: true });
      await nextTick(); fill();
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '重新读取失败，原草稿已保留'; ElMessage.error(error.value); }
    finally { reloading.value = false; }
  }
  async function save() {
    if (saving.value || reloading.value) return;
    const parsed = deliveryAcceptanceInputSchema.safeParse(draft.value);
    if (!parsed.success) { error.value = parsed.error.issues[0]?.message || '请核对验收记录'; ElMessage.error(error.value); return; }
    saving.value = true; error.value = '';
    try {
      const saved = await saveDeliveryAcceptance(parsed.data);
      await client.cancelQueries({ queryKey: deliveryAcceptanceQueryKey }, { revert: false });
      client.setQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey, records => {
        if (records?.some(item => item.recordId === saved.recordId && item.revision >= saved.revision)) return records;
        return [...(records || []).filter(item => item.recordId !== saved.recordId), saved];
      });
      ElMessage.success('验收记录已保存'); open.value = false;
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存结果待核对，请重新读取，原草稿已保留'; ElMessage.error(error.value); }
    finally { saving.value = false; }
  }
  return { open, saving, reloading, error, draft, sourceChanged, show, reload, save };
}

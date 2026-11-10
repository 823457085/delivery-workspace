import { computed, nextTick, ref, shallowRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { deliveryAcceptanceInputSchema, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceSchema, emptyDeliveryEvidence, readDeliveryEvidenceReport, sameDeliverySource,
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
  const active = computed(() => !!record().workflowActive || [record().agentStatus, record().status]
    .some(status => ['running', 'queued', 'preparing', 'starting', 'dispatching', 'dispatched', 'in_progress', 'active'].includes((status || '').toLowerCase()))
    || !!record().agentRuns?.some(run => run.pausedForEdit || (run.status === 'interrupted' && run.recovery?.state === 'active')));
  const approvalBlocker = computed(() => {
    if (sourceChanged.value) return '任务已有更新，请重新读取后核对。';
    if (active.value) return '任务仍在执行，完成后再验收。';
    if (record().sourceKnown === false || record().agentStateKnown === false || record().acceptanceKnown === false) return '验收信息尚未就绪，请重新读取。';
    const unchecked = deliveryEvidenceKinds.filter(kind => !['passed', 'not_applicable'].includes(draft.value.checks[kind].status));
    if (unchecked.length) return `${unchecked.map(kind => deliveryEvidenceLabels[kind]).join('、')}仍需核对，可补充证据或稍后验收。`;
    const valid = deliveryEvidenceSchema.safeParse(draft.value.checks);
    return valid.success ? '' : valid.error.issues[0]?.message || '请核对验证证据。';
  });
  function fill() {
    const current = record(), currentSource = { runId: current.runId || '', updatedAt: current.updatedAt }, saved = current.acceptance;
    const manual = saved && sameDeliverySource(saved.source, currentSource) ? saved : undefined;
    const run = current.agentRuns?.find(item => item.id === current.runId);
    const reported = !manual && !active.value && current.sourceKnown !== false && current.agentStateKnown !== false
      && run?.status === 'completed' && run.resultReady === true && !run.pausedForEdit
      ? (run.task?.workflow || run.team) ? current.reportedEvidence : readDeliveryEvidenceReport(run.result) : undefined;
    draft.value = { recordId: current.id, expectedRevision: saved?.revision || 0, source: currentSource,
      checks: manual ? deliveryEvidenceSchema.parse(manual.checks) : reported ? deliveryEvidenceSchema.parse(reported) : emptyDeliveryEvidence(),
      decision: manual?.decision || 'pending', summary: manual?.summary || '',
      authorization: 'record-delivery-acceptance' };
    error.value = '';
  }
  function show() { fill(); open.value = true; }
  async function reload() {
    if (saving.value || reloading.value) return;
    reloading.value = true;
    try {
      await client.invalidateQueries({ predicate: query => ['source', 'design-executor', 'agent-runtimes', 'requirement-development', 'jira-fix', 'delivery-acceptance', 'agent-team', 'agent-team-chat'].includes(String(query.queryKey[0])) }, { throwOnError: true });
      await nextTick(); fill();
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '重新读取失败，原草稿已保留'; ElMessage.error(error.value); }
    finally { reloading.value = false; }
  }
  async function save(decision?: DeliveryAcceptanceInput['decision']) {
    if (saving.value || reloading.value) return;
    if (sourceChanged.value || ((decision || draft.value.decision) === 'accepted' && approvalBlocker.value)) {
      error.value = sourceChanged.value ? '任务已有更新，请重新读取后核对。' : approvalBlocker.value;
      ElMessage.error(error.value); return;
    }
    const input = { ...draft.value, decision: decision || draft.value.decision };
    if (decision === 'accepted' && !input.summary.trim()) input.summary = '已核对本次交付结果及验证证据，验收通过。';
    if (decision === 'rejected' && !input.summary.trim()) { error.value = '请说明需要修改的地方'; ElMessage.error(error.value); return; }
    const parsed = deliveryAcceptanceInputSchema.safeParse(input);
    if (!parsed.success) { error.value = parsed.error.issues[0]?.message || '请核对验收记录'; ElMessage.error(error.value); return; }
    saving.value = true; error.value = '';
    try {
      const saved = await saveDeliveryAcceptance(parsed.data);
      await client.cancelQueries({ queryKey: deliveryAcceptanceQueryKey }, { revert: false });
      client.setQueryData<DeliveryAcceptanceRecord[]>(deliveryAcceptanceQueryKey, records => {
        if (records?.some(item => item.recordId === saved.recordId && item.revision >= saved.revision)) return records;
        return [...(records || []).filter(item => item.recordId !== saved.recordId), saved];
      });
      // 同时刷新团队状态，避免记录已保存但聊天仍显示“待验收”。
      void client.invalidateQueries({ predicate: query => ['agent-team', 'agent-team-chat'].includes(String(query.queryKey[0])) });
      ElMessage.success(parsed.data.decision === 'accepted' ? '验收已通过' : parsed.data.decision === 'rejected' ? '已记录修改意见' : '验收记录已保存'); open.value = false;
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存结果待核对，请重新读取，原草稿已保留'; ElMessage.error(error.value); }
    finally { saving.value = false; }
  }
  return { open, saving, reloading, error, draft, sourceChanged, active, approvalBlocker, show, reload, save };
}

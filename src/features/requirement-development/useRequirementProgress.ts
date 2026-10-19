import { computed, nextTick, ref, shallowRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { emptyRequirementProgress, requirementProgressDataSchema, requirementProgressInputSchema, requirementProgressImportSchema,
  type RequirementDevelopmentRecord, type RequirementProgressData } from '../../../shared/requirement-development';
import type { AgentRunStatus } from '../../../shared/agent-runtime';

export type RequirementRecordView = RequirementDevelopmentRecord & { runStatus?: AgentRunStatus; runError?: string };
const queryKey = ['requirement-development'];
export function useRequirementProgress(record: () => RequirementRecordView) {
  const client = useQueryClient();
  const open = shallowRef(false), saving = shallowRef(false), reloading = shallowRef(false), error = shallowRef('');
  const draft = ref<RequirementProgressData>(emptyRequirementProgress());
  const issueKeys = shallowRef(''), runId = shallowRef(''), revision = shallowRef(0);
  const sourceChanged = computed(() => open.value && record().runId !== runId.value);
  function fill() {
    const current = record();
    draft.value = current.progress
      ? requirementProgressDataSchema.parse({ issueKeys: current.progress.issueKeys, stages: current.progress.stages })
      : emptyRequirementProgress();
    issueKeys.value = draft.value.issueKeys.join(', ');
    runId.value = current.runId; revision.value = current.progress?.revision || 0; error.value = '';
  }
  function show() { fill(); open.value = true; }
  async function reload() {
    if (saving.value || reloading.value) return;
    reloading.value = true;
    try { await client.invalidateQueries({ queryKey }, { throwOnError: true }); await nextTick(); fill(); }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '重新读取失败，原草稿已保留'; ElMessage.error(error.value); }
    finally { reloading.value = false; }
  }
  async function save(importReport = false) {
    if (saving.value || reloading.value || sourceChanged.value) return;
    const base = { runId: runId.value, expectedRevision: revision.value };
    const parsed = importReport ? requirementProgressImportSchema.safeParse({ ...base, authorization: 'import-requirement-progress' })
      : requirementProgressInputSchema.safeParse({ ...base, authorization: 'record-requirement-progress',
        progress: { ...draft.value, issueKeys: issueKeys.value.split(/[,，\s]+/).filter(Boolean) } });
    if (!parsed.success) { error.value = parsed.error.issues[0]?.message || '请核对需求进度'; ElMessage.error(error.value); return; }
    saving.value = true; error.value = '';
    try {
      const response = await fetch(`/api/agent-runtimes/requirement-development/${encodeURIComponent(record().id)}/progress${importReport ? '/import' : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(parsed.data),
      });
      const saved = await response.json() as RequirementDevelopmentRecord & { message?: string };
      if (!response.ok) throw new Error(saved.message || '需求进度保存失败，请重新读取核对');
      if (saved.id !== record().id || !saved.progress) throw new Error('保存响应不完整，请重新读取核对');
      await client.cancelQueries({ queryKey }, { revert: false });
      client.setQueryData<RequirementRecordView[]>(queryKey, records => (records || []).map(item => {
        if (item.id !== saved.id || (item.progress?.revision || 0) >= saved.progress!.revision) return item;
        return { ...item, progress: saved.progress, progressSyncError: saved.progressSyncError };
      }));
      void client.invalidateQueries({ queryKey });
      ElMessage.success(importReport ? '本轮报告已导入，验收仍需人工确认' : '需求进度已保存'); open.value = false;
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存结果待核对，请重新读取，原草稿已保留'; ElMessage.error(error.value); }
    finally { saving.value = false; }
  }
  return { open, saving, reloading, error, draft, issueKeys, sourceChanged, show, reload, save };
}

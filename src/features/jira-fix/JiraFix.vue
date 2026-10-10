<script setup lang="ts">
import { useJiraFix } from './useJiraFix';
import JiraFixForm from './JiraFixForm.vue';
import JiraFixRecords from './JiraFixRecords.vue';
import JiraFixHandoffDialog from './JiraFixHandoffDialog.vue';
import { useJiraFixHandoff } from './useJiraFixHandoff';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
const emit = defineEmits<{ openRun: [id: string] }>();
const { form, context, resolving, busy, valid, records, query, picker, selectedRepository, selectProject, resolveIssue, chooseDirectory, start, retry, retryingId } = useJiraFix(id => emit('openRun', id));
const handoff = useJiraFixHandoff(() => query.refetch());
</script>

<template>
  <section class="jira-fix">
    <header class="fix-heading"><h2>Jira 修复</h2><p>读取问题、匹配项目，在独立分支中完成修复与验证。</p></header>
    <JiraFixForm v-model="form" :context="context" :resolving="resolving" :busy="busy" :valid="valid && !query.error.value && !query.isPending.value" :selecting="picker.selecting.value" :selected-repository="selectedRepository" @resolve="resolveIssue" @start="start" @choose-directory="chooseDirectory" @select-project="selectProject" />
    <JiraFixRecords :records="records" :loading="query.isPending.value" :refreshing="query.isFetching.value" :error="query.error.value?.message || ''" :busy="busy" :retrying-id="retryingId" @refresh="query.refetch()" @open-run="emit('openRun', $event)" @handoff="handoff.show" @retry="retry" />
  </section>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
  <JiraFixHandoffDialog v-model="handoff.form.value" v-model:feedback="handoff.feedback.value" v-model:transition-fields="handoff.transitionFields.value" :date-fields="handoff.dateFields.value" :open="handoff.open.value" :loading="handoff.loading.value" :submitting="handoff.submitting.value" :generating="handoff.generating.value" :applying-status="handoff.applyingStatus.value" :can-apply-status="handoff.canApplyStatus.value" :error="handoff.error.value" :context="handoff.context.value" :locked="handoff.locked.value" :can-submit="handoff.canSubmit.value" @close="handoff.close" @submit="handoff.submit" @generate="handoff.generate" @apply-status="handoff.applyStatus" />
</template>

<style scoped>
.jira-fix{max-width:1200px;margin:0 auto;color:var(--ui-text)}.fix-heading h2{margin:0;font-size:22px}.fix-heading p{font-size:13px;color:var(--ui-secondary);margin-bottom:22px}
</style>

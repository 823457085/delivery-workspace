<script setup lang="ts">
import { shallowRef } from 'vue';
import { useJiraFix } from './useJiraFix';
import JiraFixRecords from './JiraFixRecords.vue';
import JiraFixHandoffDialog from './JiraFixHandoffDialog.vue';
import { useJiraFixHandoff } from './useJiraFixHandoff';
import JiraDevTask from '../jira-dev/JiraDevTask.vue';
const emit = defineEmits<{ openRun: [id: string] }>();
// 新任务由 Jira 研发助手表单发起；这里保留原记录、交接与失败重试。
const { busy, records, query, retry, retryingId } = useJiraFix(id => emit('openRun', id));
function openRun(id: string) { void query.refetch(); emit('openRun', id); }
const activeTab = shallowRef('form');
const handoff = useJiraFixHandoff(() => query.refetch());
</script>

<template>
  <section class="jira-fix">
    <header class="fix-heading"><h2>Jira 修复</h2><p>读取缺陷、选择本地项目，在独立 worktree 中按所选执行器与模型完成修复与验证。</p></header>
    <el-tabs v-model="activeTab" class="workspace-section-tabs">
      <el-tab-pane label="修复任务" name="form">
        <JiraDevTask workflow="jira" @open-run="openRun" />
      </el-tab-pane>
      <el-tab-pane label="修复记录" name="records">
        <JiraFixRecords :records="records" :loading="query.isPending.value" :refreshing="query.isFetching.value" :error="query.error.value?.message || ''" :busy="busy" :retrying-id="retryingId" @refresh="query.refetch()" @open-run="emit('openRun', $event)" @handoff="handoff.show" @retry="retry" />
      </el-tab-pane>
    </el-tabs>
  </section>
  <JiraFixHandoffDialog v-model="handoff.form.value" v-model:feedback="handoff.feedback.value" v-model:transition-fields="handoff.transitionFields.value" :date-fields="handoff.dateFields.value" :open="handoff.open.value" :loading="handoff.loading.value" :submitting="handoff.submitting.value" :generating="handoff.generating.value" :applying-status="handoff.applyingStatus.value" :can-apply-status="handoff.canApplyStatus.value" :error="handoff.error.value" :context="handoff.context.value" :locked="handoff.locked.value" :can-submit="handoff.canSubmit.value" @close="handoff.close" @submit="handoff.submit" @generate="handoff.generate" @apply-status="handoff.applyStatus" />
</template>

<style scoped>
.jira-fix{max-width:1320px;margin:0 auto;color:var(--ui-text)}.fix-heading h2{margin:0;font-size:22px}.fix-heading p{font-size:13px;color:var(--ui-secondary);margin-bottom:22px}
</style>

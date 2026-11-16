<script setup lang="ts">
import { defineAsyncComponent, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useJiraFix } from './useJiraFix';
import { useJiraFixHandoff } from './useJiraFixHandoff';
const JiraFixRecords = defineAsyncComponent(() => import('./JiraFixRecords.vue'));
const JiraFixHandoffDialog = defineAsyncComponent(() => import('./JiraFixHandoffDialog.vue'));
const JiraDevTask = defineAsyncComponent(() => import('../jira-dev/JiraDevTask.vue'));
const emit = defineEmits<{ openRun: [id: string] }>();
const route = useRoute();
// 新任务由 Jira 研发助手表单发起；这里保留原记录、交接与失败重试。
const { busy, records, query, retry, retryingId } = useJiraFix(id => emit('openRun', id));
function openRun(id: string) { void query.refetch(); emit('openRun', id); }
const activeTab = shallowRef(route.query.tab === 'records' || route.query.taskId ? 'records' : 'form');
watch(() => [route.query.tab, route.query.taskId] as const, ([tab, taskId]) => {
  if (tab === 'records' || taskId) activeTab.value = 'records';
  else if (tab === 'form') activeTab.value = 'form';
});
const handoff = useJiraFixHandoff(() => query.refetch());
</script>

<template>
  <section class="jira-fix">
    <header class="fix-heading">
      <h2>Jira 修复</h2>
      <p>从缺陷读取到验证交接一站完成：在独立代码副本中定位原因、最小改动修复、自动验证并回填 Jira。</p>
    </header>
    <ol class="workflow-pipeline" aria-label="Jira 修复全流程">
      <li><span>01</span><div><strong>读取缺陷与查重</strong><small>拉取缺陷上下文并关联开发单</small></div></li>
      <li><span>02</span><div><strong>确认修复排期</strong><small>对齐目标项目、版本与计划日期</small></div></li>
      <li><span>03</span><div><strong>独立分支定位修复</strong><small>隔离副本内接力排查与修复</small></div></li>
      <li><span>04</span><div><strong>验证与 Jira 交接</strong><small>实测通过后一键写回修复说明</small></div></li>
    </ol>
    <el-tabs v-model="activeTab" class="workspace-section-tabs">
      <el-tab-pane label="修复任务" name="form" lazy>
        <JiraDevTask workflow="jira" @open-run="openRun" />
      </el-tab-pane>
      <el-tab-pane label="修复记录" name="records" lazy>
        <JiraFixRecords :records="records" :loading="query.isPending.value" :refreshing="query.isFetching.value" :error="query.error.value?.message || ''" :busy="busy" :retrying-id="retryingId" @refresh="query.refetch()" @open-run="emit('openRun', $event)" @handoff="handoff.show" @retry="retry" />
      </el-tab-pane>
    </el-tabs>
  </section>
  <JiraFixHandoffDialog v-if="handoff.open.value" v-model="handoff.form.value" v-model:feedback="handoff.feedback.value" v-model:transition-fields="handoff.transitionFields.value" :date-fields="handoff.dateFields.value" :open="handoff.open.value" :loading="handoff.loading.value" :submitting="handoff.submitting.value" :generating="handoff.generating.value" :applying-status="handoff.applyingStatus.value" :can-apply-status="handoff.canApplyStatus.value" :status-uncertain="handoff.statusUncertain.value" :error="handoff.error.value" :context="handoff.context.value" :locked="handoff.locked.value" :can-submit="handoff.canSubmit.value" @close="handoff.close" @submit="handoff.submit" @generate="handoff.generate" @apply-status="handoff.applyStatus" @reconcile="handoff.reconcile" />
</template>

<style scoped>
.jira-fix{display:grid;gap:12px;width:100%;max-width:none;margin:0;color:var(--ui-text)}
.fix-heading h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-0.015em}
.fix-heading p{margin:3px 0 0;font-size:12.5px;color:var(--ui-secondary)}
.workflow-pipeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.workflow-pipeline li{display:flex;align-items:flex-start;gap:9px;padding:9px 12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius,8px);background:var(--ui-surface)}
.workflow-pipeline li>span{display:inline-grid;place-items:center;width:22px;height:22px;flex-shrink:0;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised);color:var(--ui-secondary);font:600 10.5px/1 var(--mono)}
.workflow-pipeline li>div{display:grid;gap:1px;min-width:0}
.workflow-pipeline strong{font-size:12.5px;font-weight:600;color:var(--ui-text)}
.workflow-pipeline small{font-size:11px;line-height:15px;color:var(--ui-muted)}
@media(max-width:960px){.workflow-pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.workflow-pipeline{grid-template-columns:minmax(0,1fr)}}
</style>

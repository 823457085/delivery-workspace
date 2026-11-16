<script setup lang="ts">
/** 新需求由 Jira 研发助手表单发起并在工作台启动会话；此处保留原启动记录、阶段进度与失败重试。 */
import { shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useIntegrationPlugins } from '../../plugins/runtime';
const integrations = useIntegrationPlugins();
import RequirementExecutionRecords from './RequirementExecutionRecords.vue';

const emit = defineEmits<{ openRun: [id: string] }>();
const route = useRoute();
const activeTab = shallowRef(route.query.tab === 'records' || route.query.taskId ? 'records' : 'form');
watch(() => [route.query.tab, route.query.taskId] as const, ([tab, taskId]) => {
  if (tab === 'records' || taskId) activeTab.value = 'records';
  else if (tab === 'form') activeTab.value = 'form';
});
</script>

<template>
  <section class="requirement-development">
    <header class="development-heading">
      <div>
        <h2>需求开发</h2>
        <p>从需求到交付全链路闭环：确认前端任务与技术方案后，在独立 worktree 中由单模型或团队群聊接力推进。</p>
      </div>
      <component v-for="item in integrations.slots('requirement-toolbar')" :key="item.pluginId" :is="item.component" />
    </header>
    <ol class="workflow-pipeline" aria-label="需求开发全流程">
      <li><span>01</span><div><strong>需求与排期</strong><small>读取 Jira / PRD 并自动拆分工作日</small></div></li>
      <li><span>02</span><div><strong>评审与技术方案</strong><small>生成前置评审与架构方案文档</small></div></li>
      <li><span>03</span><div><strong>独立分支协作开发</strong><small>隔离 worktree 内群聊接力实现</small></div></li>
      <li><span>04</span><div><strong>验证与交付汇总</strong><small>实测核对、多语言与 MR 汇总</small></div></li>
    </ol>
    <el-tabs v-model="activeTab" class="workspace-section-tabs">
      <el-tab-pane label="开发任务" name="form">
        <el-empty v-if="!integrations.slots('requirement-form').length" description="开发任务提供者未接入，请在插件管理中恢复。已有开发记录仍可查看。" /><component v-for="item in integrations.slots('requirement-form')" :key="item.pluginId" :is="item.component" workflow="requirement" @open-run="emit('openRun', $event)" />
      </el-tab-pane>
      <el-tab-pane label="开发启动记录" name="records">
        <RequirementExecutionRecords @open-run="emit('openRun', $event)" />
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.requirement-development{display:grid;gap:12px;width:100%;max-width:none;margin:0;color:var(--ui-text)}
.development-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}
.development-heading h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-0.015em}
.development-heading p{margin:3px 0 0;font-size:12.5px;color:var(--ui-secondary)}
.workflow-pipeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.workflow-pipeline li{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius,8px);background:var(--ui-surface)}
.workflow-pipeline li>span{display:inline-grid;place-items:center;width:22px;height:22px;flex-shrink:0;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised);color:var(--ui-secondary);font:600 10.5px/1 var(--mono)}
.workflow-pipeline li>div{display:grid;gap:2px;min-width:0}
.workflow-pipeline strong{font-size:13px;font-weight:600;color:var(--ui-text)}
.workflow-pipeline small{font-size:11px;line-height:16px;color:var(--ui-muted)}
@media(max-width:960px){.workflow-pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:800px){.development-heading{align-items:flex-start;flex-direction:column}}
@media(max-width:520px){.workflow-pipeline{grid-template-columns:minmax(0,1fr)}}
</style>

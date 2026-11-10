<script setup lang="ts">
/** 新需求由 Jira 研发助手表单发起并在工作台启动会话；此处保留原启动记录、阶段进度与失败重试。 */
import { shallowRef } from 'vue';
import JiraDevTask from '../jira-dev/JiraDevTask.vue';
import JiraDevSyncButton from './JiraDevSyncButton.vue';
import RequirementExecutionRecords from './RequirementExecutionRecords.vue';

const emit = defineEmits<{ openRun: [id: string] }>();
const activeTab = shallowRef('form');
</script>

<template>
  <section class="requirement-development">
    <header class="development-heading"><div><h2>需求开发</h2><p>从需求到代码：确认前端任务与技术方案目录后，在独立 worktree 中按所选执行器与模型连续推进。</p></div><JiraDevSyncButton /></header>
    <el-tabs v-model="activeTab" class="workspace-section-tabs">
      <el-tab-pane label="开发任务" name="form">
        <JiraDevTask workflow="requirement" @open-run="emit('openRun', $event)" />
      </el-tab-pane>
      <el-tab-pane label="开发启动记录" name="records">
        <RequirementExecutionRecords @open-run="emit('openRun', $event)" />
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.requirement-development{max-width:1320px;margin:0 auto;color:var(--ui-text)}
.development-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.development-heading h2{margin:0;font-size:22px}.development-heading p{font-size:13px;color:var(--ui-secondary)}
@media(max-width:800px){.development-heading{align-items:flex-start;flex-direction:column}}
</style>

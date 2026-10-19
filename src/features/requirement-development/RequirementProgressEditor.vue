<script setup lang="ts">
import { requirementStages, requirementStageLabels, requirementStageStatuses, requirementStageStatusLabels } from '../../../shared/requirement-development';
import { useRequirementProgress, type RequirementRecordView } from './useRequirementProgress';
const props = defineProps<{ record: RequirementRecordView }>();
const { open, saving, reloading, draft, issueKeys, sourceChanged, show, reload, save } = useRequirementProgress(() => props.record);
</script>
<template>
  <el-button :disabled="!record.runId" @click="show">记录阶段 / Jira</el-button>
  <el-dialog v-model="open" title="需求阶段与关联 Jira" width="min(760px, 94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <p class="progress-note">记录实际进展和证据；阶段完成与会话结束不代表人工验收通过。</p>
    <p v-if="sourceChanged || (record.progress && record.progress.sourceRunId !== record.runId)" class="progress-note">{{ sourceChanged ? '关联运行已变化，请重新读取后核对进度。' : '现有进度来自之前的运行，请按本轮结果核对。' }}</p>
    <el-form label-position="top" :disabled="saving || reloading" @submit.prevent="save(false)">
      <el-form-item label="实际创建或复用的 Jira Key"><el-input v-model="issueKeys" type="textarea" :rows="2" placeholder="用逗号或换行分隔，填写已回读确认的 Key" /></el-form-item>
      <div v-for="stage in requirementStages" :key="stage" class="progress-stage">
        <el-form-item :label="requirementStageLabels[stage]"><el-select v-model="draft.stages[stage].status" :aria-label="`${requirementStageLabels[stage]}状态`"><el-option v-for="value in requirementStageStatuses" :key="value" :value="value" :label="requirementStageStatusLabels[value]" /></el-select></el-form-item>
        <el-form-item label="证据 / 阻塞理由"><el-input v-model="draft.stages[stage].evidence" type="textarea" :rows="2" maxlength="6000" :aria-label="`${requirementStageLabels[stage]}证据`" placeholder="填写方案路径、验证记录、Jira 回读结果或阻塞 / 不适用理由" /></el-form-item>
      </div>
    </el-form>
    <template #footer><div class="progress-actions"><el-button :disabled="saving || reloading || sourceChanged || record.runStatus !== 'completed'" @click="save(true)">导入并保存本轮报告</el-button><span /><el-button :disabled="saving" :loading="reloading" @click="reload">重新读取</el-button><el-button :disabled="saving || reloading" @click="open = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="reloading || sourceChanged" @click="save(false)">保存进度</el-button></div></template>
  </el-dialog>
</template>
<style scoped>
.progress-note{font-size:12px;color:var(--ui-secondary);line-height:1.7}.progress-stage{display:grid;grid-template-columns:140px minmax(0,1fr);gap:0 16px}.progress-actions{display:flex;gap:8px;flex-wrap:wrap}.progress-actions>span{flex:1}.progress-actions .el-button+.el-button{margin-left:0}@media(max-width:600px){.progress-stage{grid-template-columns:1fr}.progress-actions>span{display:none}}
</style>

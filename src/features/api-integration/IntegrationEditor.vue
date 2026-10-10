<script setup lang="ts">
/** 抽屉只编辑一个批次或接口的人工记录，使用草稿隔离未保存输入；保存和持久化由父级处理。 */
import { reactive } from 'vue';
import { bffIntegrationStatuses, integrationStatuses, type IntegrationUpdate } from '../../../shared/api-integration';
const props = defineProps<{ value: IntegrationUpdate; title: string; saving: boolean; error?: string }>();
const emit = defineEmits<{ save: [value: IntegrationUpdate]; close: [] }>();
const draft = reactive(structuredClone(props.value));
</script>
<template>
  <el-drawer :model-value="true" :title="title" size="min(620px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <el-form label-position="top" :disabled="saving" @submit.prevent="emit('save', draft)">
      <template v-if="draft.kind === 'stage'">
        <el-form-item label="负责人"><el-input v-model="draft.record.owner" aria-label="负责人" /></el-form-item>
        <el-form-item label="计划开始日期"><el-date-picker :model-value="draft.record.startDate" type="date" value-format="YYYY-MM-DD" aria-label="计划开始日期" @update:model-value="draft.record.startDate = $event || ''" /></el-form-item>
        <el-form-item label="计划结束日期"><el-date-picker :model-value="draft.record.endDate" type="date" value-format="YYYY-MM-DD" aria-label="计划结束日期" @update:model-value="draft.record.endDate = $event || ''" /></el-form-item>
      </template>
      <template v-else>
        <el-form-item label="BFF 接入"><el-select v-model="draft.record.bffStatus" aria-label="BFF 接入"><el-option v-for="status in bffIntegrationStatuses" :key="status" :label="status" :value="status" /></el-select></el-form-item>
        <el-form-item label="真实环境联调"><el-select v-model="draft.record.status" aria-label="真实环境联调"><el-option v-for="status in integrationStatuses" :key="status" :label="status" :value="status" /></el-select></el-form-item>
        <el-form-item label="验证证据"><el-input v-model="draft.record.evidence" type="textarea" :rows="5" aria-label="验证证据" /></el-form-item>
      </template>
      <el-form-item label="问题与备注"><el-input v-model="draft.record.notes" type="textarea" :rows="5" aria-label="问题与备注" /></el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
    </el-form>
    <template #footer><el-button :disabled="saving" @click="emit('close')">取消</el-button><el-button type="primary" :loading="saving" @click="emit('save', draft)">保存</el-button></template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { deliveryAcceptanceLabels, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatuses, deliveryEvidenceStatusLabels } from '../../../shared/delivery-acceptance';
import { useDeliveryAcceptance } from './useDeliveryAcceptance';
import type { DeliveryRecord } from './domain';
const props = defineProps<{ record: DeliveryRecord }>();
const { open, saving, reloading, draft, sourceChanged, show, reload, save } = useDeliveryAcceptance(() => props.record);
const label = computed(() => props.record.acceptanceKnown === false ? '验收记录未就绪' : deliveryAcceptanceLabels[props.record.acceptanceStatus || 'pending']);
const active = computed(() => [props.record.agentStatus, props.record.status].some(status => ['running', 'queued', 'preparing', 'starting', 'dispatching', 'dispatched', 'in_progress', 'active'].includes((status || '').toLowerCase()))
  || !!props.record.agentRuns?.some(run => run.pausedForEdit || (run.status === 'interrupted' && run.recovery?.state === 'active')));
</script>
<template>
  <div class="acceptance-heading"><strong>交付验收：{{ label }}</strong><el-button link type="primary" :disabled="record.acceptanceKnown === false" @click="show">记录验收</el-button></div>
  <p v-if="record.acceptance?.summary" class="row-secondary">{{ record.acceptance.summary }}</p>
  <el-dialog v-model="open" title="交付验收" width="min(760px, 94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <p class="acceptance-note">按本次交付范围记录证据；报告预填内容需人工核对，不适用项填写理由。Jira 完成、会话结束均不代表人工验收通过。</p>
    <p v-if="active || sourceChanged" class="acceptance-note">{{ sourceChanged ? '记录已有新运行或更新，请重新读取后核对证据。' : '任务仍在执行或排队，可先保存验证记录。' }}</p>
    <el-form label-position="top" :disabled="saving || reloading" @submit.prevent="save">
      <div v-for="kind in deliveryEvidenceKinds" :key="kind" class="acceptance-check">
        <el-form-item :label="deliveryEvidenceLabels[kind]"><el-select v-model="draft.checks[kind].status" :aria-label="`${deliveryEvidenceLabels[kind]}状态`"><el-option v-for="value in deliveryEvidenceStatuses" :key="value" :value="value" :label="deliveryEvidenceStatusLabels[value]" /></el-select></el-form-item>
        <el-form-item label="证据 / 不适用理由"><el-input v-model="draft.checks[kind].evidence" type="textarea" :rows="2" maxlength="6000" :aria-label="`${deliveryEvidenceLabels[kind]}证据`" placeholder="填写验证结果及命令、报告、截图或发布记录；不适用则说明理由" /></el-form-item>
        <el-form-item v-if="kind === 'remote' && draft.checks.remote.status === 'passed'" label="远端回读 SHA" class="acceptance-sha"><el-input v-model="draft.checks.remote.sha" maxlength="64" placeholder="完整的 40 或 64 位提交 SHA" /></el-form-item>
      </div>
      <el-form-item label="人工验收结论"><el-select v-model="draft.decision"><el-option value="pending" label="暂不验收，仅保存证据" /><el-option value="accepted" label="人工验收通过" :disabled="active || sourceChanged" /><el-option value="rejected" label="人工验收未通过" /></el-select></el-form-item>
      <el-form-item label="结论说明"><el-input v-model="draft.summary" type="textarea" :rows="2" maxlength="6000" placeholder="说明本次验收范围和结论" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="saving" :loading="reloading" @click="reload">重新读取</el-button><el-button :disabled="saving || reloading" @click="open = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="reloading || sourceChanged" @click="save">保存记录</el-button></template>
  </el-dialog>
</template>
<style scoped>
.acceptance-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px;font-size:13px}.acceptance-note{font-size:12px;color:var(--ui-secondary);line-height:1.7}.acceptance-check{display:grid;grid-template-columns:130px minmax(0,1fr);gap:0 16px}.acceptance-sha{grid-column:1/-1}@media(max-width:600px){.acceptance-check{grid-template-columns:1fr}}
</style>

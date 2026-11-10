<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { InputInstance } from 'element-plus';
import { deliveryAcceptanceLabels, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatuses, deliveryEvidenceStatusLabels } from '../../../shared/delivery-acceptance';
import { useDeliveryAcceptance } from './useDeliveryAcceptance';
import type { DeliveryRecord } from './domain';
const props = defineProps<{ record: DeliveryRecord; reportMode?: boolean; inline?: boolean }>();
const emit = defineEmits<{ followup: [] }>();
const formalAcceptance = ref(false);
const { open, saving, reloading, draft, sourceChanged, approvalBlocker, show, reload, save } = useDeliveryAcceptance(() => props.record);
const editingEvidence = ref(false), addingNote = ref(false), requestingChanges = ref(false);
const noteInput = ref<InputInstance>();
const label = computed(() => props.record.acceptanceKnown === false ? '验收记录未就绪' : deliveryAcceptanceLabels[props.record.acceptanceStatus || 'pending']);
const overview = computed(() => props.record.acceptanceOverview);
const criteriaLabels: Record<string, string> = { passed: '通过', failed: '未通过', blocked: '受阻', not_run: '未验证', not_applicable: '不适用' };
watch(open, value => {
  if (value) { editingEvidence.value = false; addingNote.value = false; requestingChanges.value = false; formalAcceptance.value = !props.reportMode; }
});
async function requestChanges() {
  requestingChanges.value = true;
  if (draft.value.decision !== 'rejected') draft.value.summary = '';
  await nextTick(); noteInput.value?.focus();
}
async function addNote() {
  addingNote.value = true;
  await nextTick(); noteInput.value?.focus();
}
</script>
<template>
  <div v-if="inline" class="acceptance-inline"><el-button link type="primary" :disabled="!reportMode && record.acceptanceKnown === false" @click="show">{{ record.acceptanceStatus === 'accepted' ? '查看验收' : '查看结果并验收' }}</el-button></div>
  <template v-else>
    <div class="acceptance-heading"><strong>{{ reportMode ? '结果' : `交付验收：${label}` }}</strong><el-button link type="primary" :disabled="!reportMode && record.acceptanceKnown === false" @click="show">{{ reportMode ? '查看详情' : record.acceptanceStatus === 'accepted' ? '查看验收' : '查看结果并验收' }}</el-button></div>
    <p v-if="reportMode && overview?.summary" class="row-secondary">{{ overview.summary }}</p>
    <p v-else-if="record.acceptance?.summary" class="row-secondary">{{ record.acceptance.summary }}</p>
  </template>
  <el-dialog v-model="open" :title="formalAcceptance ? '正式验收' : '结果详情'" width="min(820px, 94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <div class="acceptance-content">
      <section class="delivery-result">
        <h3>{{ record.title }}</h3>
        <p v-if="overview?.summary" class="result-summary">{{ overview.summary }}</p>
        <template v-if="overview?.reviews.length">
          <h4>代码评审</h4>
          <p v-for="(review, index) in overview.reviews" :key="index" class="review-summary">{{ review }}</p>
        </template>
      </section>
      <section aria-label="验证情况" class="evidence-section">
        <div class="section-heading"><h4>检查与证据</h4><el-button v-if="formalAcceptance" link :disabled="saving || reloading" @click="editingEvidence = !editingEvidence">{{ editingEvidence ? '完成编辑' : '补充或修正证据' }}</el-button></div>
        <el-form v-if="editingEvidence" label-position="top" :disabled="saving || reloading" @submit.prevent="save('pending')">
      <div v-for="kind in deliveryEvidenceKinds" :key="kind" class="acceptance-check">
        <el-form-item :label="deliveryEvidenceLabels[kind]"><el-select v-model="draft.checks[kind].status" :aria-label="`${deliveryEvidenceLabels[kind]}状态`"><el-option v-for="value in deliveryEvidenceStatuses" :key="value" :value="value" :label="deliveryEvidenceStatusLabels[value]" /></el-select></el-form-item>
        <el-form-item label="证据 / 不适用理由"><el-input v-model="draft.checks[kind].evidence" type="textarea" :rows="2" maxlength="6000" :aria-label="`${deliveryEvidenceLabels[kind]}证据`" placeholder="填写验证结果及命令、报告、截图或发布记录；不适用则说明理由" /></el-form-item>
        <el-form-item v-if="kind === 'remote' && draft.checks.remote.status === 'passed'" label="远端回读 SHA" class="acceptance-sha"><el-input v-model="draft.checks.remote.sha" maxlength="64" placeholder="完整的 40 或 64 位提交 SHA" /></el-form-item>
      </div>
        </el-form>
        <dl v-else class="evidence-list">
          <div v-for="kind in deliveryEvidenceKinds" :key="kind" class="evidence-row">
            <dt>{{ deliveryEvidenceLabels[kind] }}</dt>
            <dd><span class="evidence-status" :data-status="draft.checks[kind].status">{{ deliveryEvidenceStatusLabels[draft.checks[kind].status] }}</span>
              <p>{{ draft.checks[kind].evidence || '暂无验证记录' }}</p>
              <code v-if="kind === 'remote' && draft.checks.remote.sha">{{ draft.checks.remote.sha }}</code>
            </dd>
          </div>
        </dl>
      </section>
      <details v-if="overview?.criteria.length" class="criteria-details">
        <summary>任务标准与逐项证据（{{ overview.criteria.length }} 项）</summary>
        <ol><li v-for="criterion in overview.criteria" :key="criterion.id">
          <div><strong>{{ criterion.id }}</strong><span>{{ criteriaLabels[criterion.status] || criterion.status }}</span></div>
          <p>{{ criterion.text }}</p><p v-if="criterion.evidence" class="criterion-evidence">{{ criterion.evidence }}</p>
        </li></ol>
      </details>
      <el-form v-if="formalAcceptance && (requestingChanges || addingNote || draft.summary)" label-position="top" :disabled="saving || reloading" class="decision-note" @submit.prevent>
        <el-form-item :label="requestingChanges ? '需要修改的地方' : '验收备注（选填）'">
          <el-input ref="noteInput" v-model="draft.summary" type="textarea" :rows="3" maxlength="6000" :aria-label="requestingChanges ? '需要修改的地方' : '验收备注'" :placeholder="requestingChanges ? '说明哪里不符合预期，以及希望如何修改' : '补充需要保留的说明'" />
        </el-form-item>
        <p v-if="requestingChanges" class="acceptance-note">保存后标记为需修改；可回到对话继续处理。</p>
      </el-form>
      <el-button v-else-if="formalAcceptance" link :disabled="saving || reloading" class="add-note" @click="addNote">添加验收备注</el-button>
      <p v-if="formalAcceptance && approvalBlocker" class="acceptance-note" role="status">{{ approvalBlocker }}</p>
    </div>
    <template #footer>
      <div class="acceptance-footer">
        <div class="secondary-actions">
          <el-button link :disabled="saving" :loading="reloading" @click="reload">重新读取</el-button>
          <el-button v-if="reportMode" link :disabled="saving || reloading || record.acceptanceKnown === false" @click="formalAcceptance = !formalAcceptance; editingEvidence = false; requestingChanges = false">{{ formalAcceptance ? '返回汇报' : '记录正式验收' }}</el-button>
          <el-button v-if="editingEvidence" link :disabled="reloading || sourceChanged" :loading="saving" @click="save('pending')">保存证据</el-button>
        </div>
        <div class="decision-actions" v-if="!formalAcceptance">
          <el-button @click="open = false; emit('followup')">继续追问或补充</el-button>
          <el-button type="primary" @click="open = false">关闭</el-button>
        </div>
        <div class="decision-actions" v-else-if="requestingChanges">
          <el-button :disabled="saving || reloading" @click="requestingChanges = false">返回</el-button>
          <el-button type="primary" :loading="saving" :disabled="reloading || sourceChanged || !draft.summary.trim()" @click="save('rejected')">确认需要修改</el-button>
        </div>
        <div class="decision-actions" v-else>
          <el-button :disabled="saving || reloading" @click="open = false">稍后验收</el-button>
          <el-button :disabled="saving || reloading || sourceChanged" @click="requestChanges">需要修改</el-button>
          <el-button type="primary" :loading="saving" :disabled="reloading || !!approvalBlocker" @click="save('accepted')">验收通过</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
<style scoped>
.acceptance-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px;font-size:13px}.acceptance-inline{display:flex;align-items:center}
.acceptance-content{max-height:62vh;overflow-y:auto;padding-right:8px;color:var(--ui-text);font-size:13px;line-height:1.65}
.delivery-result h3{font-size:16px;line-height:1.5;margin:0 0 12px}.delivery-result h4{margin:16px 0 4px;font-size:12px;color:var(--ui-secondary);font-weight:500}
.result-summary,.review-summary{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.review-summary+.review-summary{margin-top:6px}
.evidence-section{margin-top:20px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-heading h4{font-size:13px;margin:0}
.evidence-list{margin:4px 0 0}.evidence-row{display:grid;grid-template-columns:100px minmax(0,1fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--el-border-color-lighter)}
.evidence-row dt{color:var(--ui-secondary);padding-top:1px}.evidence-row dd{margin:0;min-width:0}.evidence-row p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.evidence-row code{display:block;margin-top:4px;font-size:11px;overflow-wrap:anywhere;color:var(--ui-secondary)}
.evidence-status{font-size:12px;font-weight:600}.evidence-status[data-status="passed"]{color:var(--el-color-success)}.evidence-status[data-status="failed"]{color:var(--el-color-danger)}.evidence-status[data-status="not_applicable"],.evidence-status[data-status="pending"]{color:var(--ui-secondary)}
.criteria-details{margin:16px 0;font-size:12px}.criteria-details summary{cursor:pointer;color:var(--ui-secondary)}.criteria-details ol{list-style:none;margin:12px 0;padding:0}.criteria-details li+li{margin-top:16px}.criteria-details li>div{display:flex;gap:12px}.criteria-details p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.criterion-evidence{color:var(--ui-secondary)}
.decision-note{margin-top:16px}.decision-note :deep(.el-form-item){margin-bottom:8px}.add-note{margin-top:4px}.acceptance-note{font-size:12px;color:var(--ui-secondary);line-height:1.7;margin:10px 0 0}
.acceptance-check{display:grid;grid-template-columns:130px minmax(0,1fr);gap:0 16px;margin-top:12px}.acceptance-sha{grid-column:1/-1}
.acceptance-footer,.secondary-actions,.decision-actions{display:flex;align-items:center;gap:8px}.acceptance-footer{justify-content:space-between;flex-wrap:wrap}.acceptance-footer :deep(.el-button+.el-button){margin-left:0}
@media(max-width:600px){.acceptance-check{grid-template-columns:1fr}.evidence-row{grid-template-columns:82px minmax(0,1fr);gap:10px}.acceptance-footer{gap:14px}.decision-actions{flex-wrap:wrap;justify-content:flex-end;width:100%}}
</style>

<script setup lang="ts">
/** 审核抽屉只展示接口线索并发起人工确认；旧联调记录不自动成为确认结果。 */
import type { OperationRecord } from '../../../shared/api-integration';
import { reviewLabel, type ApexBffReviewRecord } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';

defineProps<{ item?: ReviewCatalogItem; record?: ApexBffReviewRecord; history?: OperationRecord; saving: boolean; available: boolean }>();
const emit = defineEmits<{ close: []; confirm: []; reopen: [] }>();
</script>

<template>
  <el-drawer :model-value="!!item" :title="item ? `接口联调审核 · ${item.name}` : '接口联调审核'" size="min(660px, 96vw)" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <template v-if="item">
      <div class="drawer-context">
        <code>{{ item.method || '方法待确认' }} {{ item.path }}</code>
        <p>{{ item.ui.module }} / {{ item.ui.page }}<span v-if="item.ui.route"> · {{ item.ui.route }}</span></p>
        <p>清单来源：{{ item.source === 'workbook' ? `开发计划第 ${item.workbook?.sourceRow} 行` : '旧契约清单补充' }}<span v-if="item.plan"> · {{ item.plan.stageTitle }}</span></p>
        <p>当前结果：<strong>{{ available ? reviewLabel(record) : '状态未加载' }}</strong><span v-if="available && record?.confirmedAt"> · {{ record.confirmedAt }}</span></p>
      </div>
      <div v-if="history" class="history-note">
        <strong>旧联调记录（仅作线索）</strong>
        <p>BFF {{ history.bffStatus }} · 原状态 {{ history.status }}</p>
        <p v-if="history.evidence">原验证备注：{{ history.evidence }}</p>
        <p v-if="history.notes">原问题备注：{{ history.notes }}</p>
      </div>
      <div v-if="record?.evidence || record?.blocker" class="history-note">
        <strong>已有人工记录</strong>
        <p v-if="record.evidence">验证记录：{{ record.evidence }}</p>
        <p v-if="record.blocker">原阻塞备注：{{ record.blocker }}</p>
      </div>
    </template>
    <template #footer>
      <el-button v-if="available && record?.confirmedAt" :loading="saving" @click="emit('reopen')">撤回联调确认</el-button>
      <el-button v-else type="success" :loading="saving" :disabled="!item || !available" @click="emit('confirm')">确认联调通过</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.drawer-context{padding:14px 16px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-raised)}
.drawer-context code{display:block;overflow-wrap:anywhere;font-size:12px}.drawer-context p{margin:8px 0 0;font-size:12px;line-height:1.6;color:var(--ui-muted);overflow-wrap:anywhere}
.drawer-context strong{color:var(--ui-text)}.history-note{margin-top:16px;padding:14px 16px;border-left:3px solid var(--ui-border);background:var(--ui-raised)}
.history-note strong{font-size:12px}.history-note p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--ui-muted);white-space:pre-wrap;overflow-wrap:anywhere}
</style>

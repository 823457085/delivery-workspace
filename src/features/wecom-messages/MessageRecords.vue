<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
/** 本机消息库与发送回执分开呈现；明确失败可重新预览，结果不明不提供重试入口。 */
import { computed, shallowRef } from 'vue';
import { feedbackStatusLabels } from '../../../shared/wecom-integration';
import type { WecomMessageInput, WecomMessageRecord, WecomMessageSaved } from '../../../shared/wecom-messages';
const props = defineProps<{ saved: WecomMessageSaved[]; history: WecomMessageRecord[]; loading: boolean; busy: boolean }>();
const emit = defineEmits<{ useSaved: [saved: WecomMessageSaved]; copy: [input: WecomMessageInput]; remove: [saved: WecomMessageSaved]; retry: [record: WecomMessageRecord]; refresh: [] }>();
const tab = shallowRef('draft');
const search = shallowRef('');
const details = shallowRef<WecomMessageRecord>();
const draftCount = computed(() => props.saved.filter(item => item.kind === 'draft').length);
const templateCount = computed(() => props.saved.filter(item => item.kind === 'template').length);
const selected = computed(() => props.saved.filter(item => item.kind === tab.value && `${item.title}\n${item.content}`.toLowerCase().includes(search.value.toLowerCase())));
const records = computed(() => props.history.filter(item => `${item.preview.input.title}\n${item.preview.content}\n${item.preview.groupName}`.toLowerCase().includes(search.value.toLowerCase())));
function time(value: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function statusType(status: WecomMessageRecord['status']) { return status === 'sent' ? 'success' : status === 'failed' ? 'danger' : status === 'unknown' ? 'warning' : 'info'; }
</script>

<template>
  <section class="surface message-records">
    <div class="surface-header"><div><h2>消息管理</h2><p>草稿、模板和推送历史保存在本机 Delivery 工作台</p></div><el-button :disabled="loading" @click="emit('refresh')">刷新</el-button></div>
    <div class="records-toolbar"><el-radio-group v-model="tab" aria-label="消息管理分类"><el-radio-button value="draft">草稿 {{ draftCount }}</el-radio-button><el-radio-button value="template">模板 {{ templateCount }}</el-radio-button><el-radio-button value="history">推送历史 {{ history.length }}</el-radio-button></el-radio-group><el-input v-model="search" clearable placeholder="搜索标题、正文或群名" aria-label="搜索消息" /></div>
    <div v-loading="loading">
      <el-table v-if="tab !== 'history'" :data="selected" empty-text="暂无保存的消息，可在编辑区保存草稿或模板">
        <el-table-column label="消息" min-width="260"><template #default="{ row }"><strong class="record-title">{{ row.title }}</strong><AgentMarkdown v-if="row.msgtype !== 'text'" class="record-excerpt" :source="row.content" /><span v-else class="record-excerpt">{{ row.content }}</span></template></el-table-column>
        <el-table-column label="格式" width="110"><template #default="{ row }">{{ row.msgtype === 'text' ? '纯文本' : 'Markdown' }}</template></el-table-column>
        <el-table-column label="更新时间" width="185"><template #default="{ row }"><span class="record-time">{{ time(row.updatedAt) }}</span></template></el-table-column>
        <el-table-column label="操作" width="155" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="emit('useSaved', row)">使用 / 编辑</el-button><el-button link type="danger" :disabled="busy" @click="emit('remove', row)">删除</el-button></template></el-table-column>
      </el-table>
      <el-table v-else :data="records" empty-text="暂无推送历史；预览和保存草稿不会发送消息">
        <el-table-column label="消息 / 目标群" min-width="230"><template #default="{ row }"><strong class="record-title">{{ row.preview.input.title || '未命名消息' }}</strong><span class="record-excerpt">{{ row.preview.groupName }}</span><AgentMarkdown v-if="row.preview.input.msgtype !== 'text'" class="record-excerpt" :source="row.preview.content" /><span v-else class="record-excerpt">{{ row.preview.content }}</span></template></el-table-column>
        <el-table-column label="发送状态" width="160"><template #default="{ row }"><el-tag :type="statusType(row.status)" size="small">{{ feedbackStatusLabels[row.status as WecomMessageRecord['status']] }}</el-tag></template></el-table-column>
        <el-table-column label="发送时间" width="185"><template #default="{ row }"><span class="record-time">{{ time(row.attemptedAt) }}</span></template></el-table-column>
        <el-table-column label="操作" width="215" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="details = row">详情</el-button><el-button link :disabled="busy" @click="emit('copy', row.preview.input)">复制编辑</el-button><el-button v-if="row.status === 'failed'" link type="primary" :disabled="busy" @click="emit('retry', row)">重新预览</el-button></template></el-table-column>
      </el-table>
    </div>
    <el-dialog :model-value="!!details" title="推送详情" width="min(720px, 95vw)" @update:model-value="details = undefined">
      <template v-if="details"><p class="record-detail-meta">{{ details.preview.groupName }} · {{ time(details.attemptedAt) }} · {{ feedbackStatusLabels[details.status] }}</p><p class="record-receipt">{{ details.message }}</p><p v-if="details.status === 'unknown'" class="record-detail-meta">请先在目标群核实是否收到消息，避免重复推送。</p><AgentMarkdown v-if="details.preview.input.msgtype !== 'text'" class="record-body" :source="details.preview.content" /><pre v-else class="record-body">{{ details.preview.content }}</pre></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.records-toolbar{display:flex;gap:15px;justify-content:space-between;flex-wrap:wrap;padding:18px 20px}.records-toolbar>.el-input{width:270px}.record-title{display:block;font-size:13px;font-weight:500;color:var(--ui-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.record-excerpt{display:block;color:var(--ui-muted);font-size:12px;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.record-time{font:11px var(--mono);color:var(--ui-muted)}.record-body{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 var(--mono);color:var(--ui-text);padding:15px 0}.record-detail-meta{color:var(--ui-muted);font-size:12px;line-height:1.8}.record-receipt{font-size:13px;line-height:1.8}.message-records :deep(.el-table__empty-block){min-height:110px}
.record-body.agent-markdown{white-space:normal;font-family:var(--sans)}.record-excerpt.agent-markdown{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal}
</style>

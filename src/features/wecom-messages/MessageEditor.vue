<script setup lang="ts">
/** 编辑器只收集消息原文；预览、保存和推送由业务编排处理，管理标题不拼入群消息。 */
import { FilePenLine } from '@lucide/vue';
import type { WecomMessageInput, WecomMessageSaved } from '../../../shared/wecom-messages';
const model = defineModel<WecomMessageInput>({ required: true });
defineProps<{ busy: boolean; bytes: number; limit: number; valid: boolean; dirty: boolean; editing?: WecomMessageSaved }>();
const emit = defineEmits<{ preview: []; save: [kind: WecomMessageSaved['kind']]; clear: [] }>();
function update(field: keyof WecomMessageInput, value: string) { model.value = { ...model.value, [field]: value }; }
</script>

<template>
  <section class="surface message-editor">
    <div class="surface-header"><div><h2><FilePenLine :size="16" /> 编辑消息</h2><p>{{ editing ? `正在编辑${editing.kind === 'draft' ? '草稿' : '模板'} · ${editing.title}` : '自定义正文，预览确认后推送到已连接的企业微信群' }}</p></div><el-button link :disabled="busy" @click="emit('clear')">新建消息</el-button></div>
    <el-form class="surface-body" label-position="top" :disabled="busy" @submit.prevent="emit('preview')">
      <el-form-item label="管理标题" required><el-input :model-value="model.title" maxlength="80" placeholder="如：周会提醒（仅用于管理，不会发送）" @update:model-value="update('title', $event)" /></el-form-item>
      <el-form-item label="消息格式"><el-radio-group :model-value="model.msgtype" aria-label="消息格式" @update:model-value="update('msgtype', String($event))"><el-radio-button value="text">纯文本</el-radio-button><el-radio-button value="markdown_v2">Markdown</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="消息正文" required><el-input :model-value="model.content" type="textarea" :rows="12" resize="vertical" :placeholder="model.msgtype === 'text' ? '输入要发送到群里的消息…' : '## 消息标题\n输入正文，支持 **加粗**、列表和链接…'" @update:model-value="update('content', $event)" /></el-form-item>
      <div class="editor-meta"><span>{{ dirty ? '编辑内容尚未保存' : '本机保存内容' }}</span><span :class="{ 'is-over-limit': bytes > limit }">{{ bytes }} / {{ limit }} 字节</span></div>
      <p class="editor-note">群消息按 UTF-8 字节限制；预览展示服务端脱敏后的实际发送正文。</p>
      <div class="editor-actions"><div><el-button :disabled="!valid || busy" @click="emit('save', 'draft')">保存草稿</el-button><el-button :disabled="!valid || busy" @click="emit('save', 'template')">存为模板</el-button></div><el-button type="primary" :disabled="!valid || busy" @click="emit('preview')">生成发送预览</el-button></div>
    </el-form>
  </section>
</template>

<style scoped>
.message-editor{min-width:0}.surface-header h2{display:flex;align-items:center;gap:8px}.editor-meta{display:flex;justify-content:space-between;gap:10px;margin-top:-8px;font:11px var(--mono);color:var(--ui-muted)}.editor-meta .is-over-limit{color:var(--ui-danger)}.editor-note{font-size:12px;line-height:1.7;color:var(--ui-muted);margin:13px 0 20px}.editor-actions{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.editor-actions>div{display:flex;gap:8px}.editor-actions :deep(.el-button+.el-button){margin-left:0}.message-editor :deep(.el-textarea__inner){font:13px/1.75 var(--mono)}
</style>

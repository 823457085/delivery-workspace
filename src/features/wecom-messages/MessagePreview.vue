<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
/** 预览展示服务端返回的脱敏原文，不渲染用户 HTML；只有本轮预览有效时才开放确认发送。 */
import { Eye, Send, MessageSquareText } from '@lucide/vue';
import type { WecomMessagePreview } from '../../../shared/wecom-messages';
defineProps<{ preview?: WecomMessagePreview; loading: boolean; sending: boolean; canSend: boolean; configured: boolean; groupName: string }>();
const emit = defineEmits<{ send: []; configure: [] }>();
</script>

<template>
  <section class="surface preview-panel" v-loading="loading">
    <div class="surface-header"><div><h2><Eye :size="16" /> 发送预览</h2><p>发送前核对目标群与实际正文</p></div><el-tag v-if="preview" size="small" effect="plain">{{ preview.input.msgtype === 'text' ? '纯文本' : 'Markdown' }}</el-tag></div>
    <div class="preview-destination"><MessageSquareText :size="17" /><div><span>接收群</span><strong>{{ preview?.groupName || groupName || '尚未配置' }}</strong></div><el-button link type="primary" :disabled="sending" @click="emit('configure')">配置</el-button></div>
    <template v-if="preview">
      <div class="preview-content"><AgentMarkdown v-if="preview.input.msgtype !== 'text'"  :source="preview.content" /><pre v-else >{{ preview.content }}</pre></div>
      <div class="preview-footer"><p>{{ preview.bytes }} / {{ preview.limit }} 字节 · 编辑正文或配置后需重新预览</p><el-button type="primary" :disabled="!canSend" :loading="sending" @click="emit('send')"><Send :size="14" /> 确认并推送</el-button><p>点击后将再次确认；机器人接收回执不代表群成员已读。</p></div>
    </template>
    <div v-else class="preview-empty"><el-empty :image-size="78" :description="configured ? '编辑消息后，生成发送预览' : '先配置机器人，再预览消息'" /><p>此处展示消息预览，Markdown 按格式呈现。</p></div>
  </section>
</template>

<style scoped>
.preview-panel{min-width:0;display:flex;flex-direction:column}.surface-header h2{display:flex;align-items:center;gap:8px}.preview-destination{display:flex;align-items:center;gap:11px;padding:17px 20px;border-bottom:1px solid var(--ui-border);color:var(--ui-muted)}.preview-destination>div{min-width:0;flex:1}.preview-destination span,.preview-destination strong{display:block}.preview-destination span{font-size:11px;margin-bottom:5px}.preview-destination strong{font-size:13px;color:var(--ui-text);font-weight:500;overflow-wrap:anywhere}.preview-content{flex:1;padding:20px;min-height:270px}.preview-content pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 var(--mono);color:var(--ui-text)}.preview-footer{padding:0 20px 20px}.preview-footer p,.preview-empty>p{font-size:11px;color:var(--ui-muted);line-height:1.7}.preview-footer .el-button{width:100%;gap:7px;margin:7px 0}.preview-empty{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:350px;padding:20px;text-align:center}.preview-empty>p{max-width:270px;margin:0}.preview-empty :deep(.el-empty__description p){font-size:13px}
</style>

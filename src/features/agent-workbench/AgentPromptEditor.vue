<script setup lang="ts">
/**
 * 设计说明：该编辑器统一承载 Agent 消息、@ 能力选择和 Markdown 预览。
 * 它不启动 Agent；模式选择通过事件上报，Skill 与文件以可识别引用写入消息。
 */
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue';
import { AtSign, BookOpen, Bot, BriefcaseBusiness, Eye, File, ImagePlus, Pencil, Sparkles, X } from '@lucide/vue';
import { isAgentImageAttachment, type AgentAttachment, type AgentProvider, type AgentRunMode } from '../../../shared/agent-runtime';
import AgentMarkdown from './AgentMarkdown.vue';
import { useAgentMentions, type AgentMentionKind } from './useAgentMentions';
import { useAgentAttachments } from './useAgentAttachments';
import type { AgentBusinessMention } from './agent-business-context';
import AgentNotePreview from './AgentNotePreview.vue';

const props = withDefaults(defineProps<{ workspacePath: string; provider?: AgentProvider; modes?: AgentRunMode[]; selectedMode?: AgentRunMode;
  modeLocked?: boolean; businessOptions?: AgentBusinessMention[]; disabled?: boolean; placeholder?: string; minRows?: number; maxRows?: number; submitOnEnter?: boolean }>(), {
  provider: 'codex', modes: () => [], businessOptions: () => [], modeLocked: false, disabled: false, placeholder: '', minRows: 2, maxRows: 6, submitOnEnter: false,
});
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const emit = defineEmits<{ submit: []; selectMode: [mode: AgentRunMode] }>();
const input = useTemplateRef('input');
const imageInput = useTemplateRef<HTMLInputElement>('imageInput');
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const preview = shallowRef(false);
const noteReference = shallowRef('');
const attachedFiles = useAgentAttachments(attachments, () => props.disabled);
const mentions = useAgentMentions(draft, () => ({ workspacePath: props.workspacePath, provider: props.provider,
  modes: props.modes, selectedMode: props.selectedMode, modeLocked: props.modeLocked, businessOptions: props.businessOptions }),
() => props.disabled || preview.value, (mode) => emit('selectMode', mode));
const mentionGroups = computed(() => {
  const labels: Record<AgentMentionKind, string> = { business: '业务上下文', mode: '模式', skill: 'Skills', file: '文件', note: 'Obsidian 笔记' };
  const order: AgentMentionKind[] = mentions.prioritizeSkills.value
    ? ['skill', 'note', 'business', 'mode', 'file']
    : ['business', 'mode', 'skill', 'note', 'file'];
  return order.map(kind => ({ kind, label: labels[kind], options: mentions.options.value.filter(option => option.kind === kind) }))
    .filter(group => group.options.length);
});

function mentionIcon(kind: AgentMentionKind) {
  return kind === 'note' ? BookOpen : kind === 'business' ? BriefcaseBusiness : kind === 'mode' ? Bot : kind === 'skill' ? Sparkles : File;
}

function citeNote(reference: string) {
  mentions.select({ id: reference, kind: 'note', label: '', detail: '', value: reference });
}

async function insertMention() {
  preview.value = false;
  mentions.insertTrigger();
  await nextTick();
  input.value?.focus();
}

async function focusInput() {
  preview.value = false;
  await nextTick();
  input.value?.focus();
}

defineExpose({ focusInput });

function onKeydown(event: KeyboardEvent) {
  if (mentions.handleKeydown(event)) return;
  if (!props.submitOnEnter || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  emit('submit');
}

function chooseImages() {
  if (attachedFiles.canAdd.value) imageInput.value?.click();
}

function chooseFiles() {
  if (attachedFiles.canAdd.value) fileInput.value?.click();
}

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  void attachedFiles.addFiles([...(target.files || [])]);
  target.value = '';
}

function onPaste(event: ClipboardEvent) { attachedFiles.fromTransfer(event.clipboardData, event); }
function onDrop(event: DragEvent) { attachedFiles.fromTransfer(event.dataTransfer, event); }
</script>

<template>
  <div class="prompt-editor">
    <div class="prompt-tools">
      <el-button text size="small" :disabled="disabled" @click="insertMention"><AtSign :size="13" /> 选择</el-button>
      <el-button text size="small" :disabled="!attachedFiles.canAdd.value" :loading="attachedFiles.uploading.value"
        title="添加图片，也可以直接粘贴或拖入" @click="chooseImages">
        <ImagePlus :size="13" /> 图片
      </el-button>
      <el-button text size="small" :disabled="!attachedFiles.canAdd.value" :loading="attachedFiles.uploading.value"
        title="添加本机文件，也可以直接拖入" @click="chooseFiles">
        <File :size="13" /> 文件
      </el-button>
      <input ref="imageInput" class="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="onFileChange" />
      <input ref="fileInput" class="image-input" type="file" multiple @change="onFileChange" />
      <span class="tool-divider"></span>
      <el-button text size="small" :class="{ active: !preview }" @click="preview = false"><Pencil :size="13" /> 编辑</el-button>
      <el-button text size="small" :class="{ active: preview }" :disabled="!draft.trim()" @click="preview = true"><Eye :size="13" /> 预览</el-button>
    </div>
    <div class="editor-body" @paste="onPaste" @dragover.prevent @drop="onDrop">
      <div v-if="attachments.length" class="image-list" aria-label="已添加附件">
        <figure v-for="attachment in attachments" :key="attachment.id">
          <img v-if="isAgentImageAttachment(attachment)" :src="attachment.url" :alt="attachment.name" />
          <div v-else class="file-preview"><File :size="27" /></div>
          <figcaption :title="attachment.name">{{ attachment.name }}</figcaption>
          <button type="button" :disabled="disabled" :aria-label="`移除附件 ${attachment.name}`" @click="attachedFiles.remove(attachment)"><X :size="12" /></button>
        </figure>
      </div>
      <el-input v-show="!preview" ref="input" v-model="draft" type="textarea" resize="none" :autosize="{ minRows, maxRows }"
        :disabled="disabled" :placeholder="placeholder" @keydown="onKeydown" />
      <div v-if="preview" class="markdown-preview"><AgentMarkdown :source="draft" /></div>
      <div v-if="mentions.open.value" class="mention-picker" role="listbox" aria-label="选择业务上下文、模式、Skill 或文件">
        <section v-for="group in mentionGroups" :key="group.kind" class="mention-group">
          <header>{{ group.label }}</header>
          <div v-for="option in group.options" :key="option.id" class="mention-option">
          <button type="button" :class="{ active: option.id === mentions.activeOption.value?.id }"
            @mousedown.prevent="mentions.select(option)">
            <component :is="mentionIcon(option.kind)" :size="13" />
            <span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
          </button>
          <button v-if="option.kind === 'note'" type="button" class="note-preview-button" :aria-label="`预览笔记 ${option.label}`" @mousedown.prevent="noteReference = option.value"><Eye :size="14" /></button>
          </div>
        </section>
        <span v-if="mentions.loading.value" class="mention-state">正在读取 Skills 与文件…</span>
        <span v-else-if="!mentions.options.value.length" class="mention-state">未找到匹配内容</span>
      </div>
    </div>
    <AgentNotePreview v-model="noteReference" @cite="citeNote" />
  </div>
</template>

<style scoped>
.file-preview{display:grid;place-items:center;width:68px;height:54px;border-radius:5px;background:#252c39;color:#b9b4ff}
.mention-option{display:flex;align-items:center}.mention-option>button:first-child{min-width:0;flex:1}.mention-option>.note-preview-button{width:32px;flex-shrink:0;justify-content:center;padding:8px}
.prompt-editor{min-width:0}.prompt-tools{display:flex;align-items:center;gap:3px;margin:0 0 7px}.prompt-tools:deep(.el-button){height:25px;padding:3px 8px;border-radius:6px;color:#8f9aad;font-size:9px}.prompt-tools:deep(.el-button:hover){background:#252c39;color:#d6d9e2}.prompt-tools:deep(.el-button.active){color:#d0ccff;background:#302d50}.image-input{display:none}.tool-divider{width:1px;height:14px;margin:0 3px;background:#3c4557}.editor-body{position:relative}.image-list{display:flex;gap:8px;margin:0 0 8px;overflow-x:auto}.image-list figure{position:relative;width:78px;min-width:78px;margin:0;padding:4px;border:1px solid #414a5d;border-radius:8px;background:#11161f}.image-list img{display:block;width:68px;height:54px;border-radius:5px;object-fit:cover}.image-list figcaption{margin-top:4px;overflow:hidden;color:#9da7b9;font-size:8px;text-overflow:ellipsis;white-space:nowrap}.image-list button{position:absolute;top:1px;right:1px;display:grid;place-items:center;width:20px;height:20px;padding:0;border:1px solid #596278;border-radius:50%;background:#111722dc;color:#fff;cursor:pointer}.image-list button:disabled{cursor:not-allowed;opacity:.5}.prompt-editor:deep(.el-textarea){display:block}.prompt-editor:deep(.el-textarea__inner){min-height:70px!important;padding:12px 14px;border:1px solid #414a5d;border-radius:9px;background:#11161f;color:#f3f5f8;box-shadow:0 0 0 1px #ffffff03 inset;font-size:12px;line-height:1.65;transition:.18s ease}.prompt-editor:deep(.el-textarea__inner:hover){border-color:#526077}.prompt-editor:deep(.el-textarea__inner:focus){border-color:#776cf5;box-shadow:0 0 0 3px #6158e626}.prompt-editor:deep(.el-textarea__inner::placeholder){color:#687387}.markdown-preview{min-height:70px;max-height:260px;padding:12px 14px;overflow:auto;border:1px solid #414a5d;border-radius:9px;background:#11161f;color:#eceef4}.mention-picker{position:absolute;z-index:8;left:0;right:0;bottom:calc(100% + 7px);max-height:360px;padding:6px;overflow-y:auto;border:1px solid #48536a;border-radius:10px;background:#1a202c;box-shadow:0 18px 44px #000b}.mention-group+ .mention-group{margin-top:4px;padding-top:4px;border-top:1px solid #30394a}.mention-group header{padding:6px 10px 4px;color:#7f8a9d;font-size:9px;font-weight:650;text-transform:uppercase}.mention-picker button{display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:#d0d5df;text-align:left;cursor:pointer}.mention-picker button.active,.mention-picker button:hover{background:#343153;color:#fff}.mention-picker button>span{display:grid;min-width:0}.mention-picker strong,.mention-picker small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mention-picker strong{font:10px var(--mono)}.mention-picker small{margin-top:2px;color:#8f99aa;font-size:9px}.mention-picker button.active small,.mention-picker button:hover small{color:#bcc3cf}.mention-state{display:block;padding:10px;color:#8c97aa;font-size:10px}
</style>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { ElMessage, useFormDisabled, type InputInstance } from 'element-plus';
import { Bold, Italic, Heading2, List, ListOrdered, Link2, Code, Maximize2, Minimize2, Pencil, Eye } from '@lucide/vue';
import JiraDescription from './JiraDescription.vue';
import { formatJiraSelection, type JiraTextFormat } from './jira-description-edit';

const value = defineModel<string>({ default: '' });
const expanded = defineModel<boolean>('expanded', { default: false });
const input = ref<InputInstance>();
const preview = ref(false);
const disabled = useFormDisabled();
const tools = [
  { format: 'heading', label: '二级标题', icon: Heading2 },
  { format: 'bold', label: '加粗', icon: Bold },
  { format: 'italic', label: '斜体', icon: Italic },
  { format: 'bullet', label: '无序列表', icon: List },
  { format: 'numbered', label: '有序列表', icon: ListOrdered },
  { format: 'link', label: '插入链接', icon: Link2 },
  { format: 'code', label: '代码块', icon: Code },
] as const;

async function format(kind: JiraTextFormat) {
  const field = input.value?.textarea;
  if (!field || disabled.value || preview.value) return;
  const edit = formatJiraSelection(value.value, field.selectionStart, field.selectionEnd, kind);
  if (edit.value.length > 50000) { ElMessage.warning('描述最多可输入 50000 个字符'); return; }
  const scroll = field.scrollTop;
  value.value = edit.value;
  await nextTick();
  field.focus();
  field.setSelectionRange(edit.start, edit.end);
  field.scrollTop = scroll;
}
async function showEditor() {
  preview.value = false;
  await nextTick();
  input.value?.focus();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && expanded.value && !event.isComposing) {
    event.preventDefault(); event.stopPropagation(); expanded.value = false;
  }
}
</script>

<template>
  <div class="jira-description-editor" @keydown="onKeydown">
    <div class="description-toolbar" role="toolbar" aria-label="描述格式与视图">
      <div class="description-format-tools">
        <el-button v-for="tool in tools" :key="tool.format" text :title="tool.label" :aria-label="tool.label"
          :disabled="disabled || preview" @mousedown.prevent @click="format(tool.format)"><component :is="tool.icon" :size="15" /></el-button>
      </div>
      <div class="description-view-tools">
        <el-button text :aria-pressed="!preview" :class="{active: !preview}" @click="showEditor"><Pencil :size="13" />编辑</el-button>
        <el-button text :aria-pressed="preview" :class="{active: preview}" @click="preview = true"><Eye :size="13" />预览</el-button>
        <el-button text :aria-pressed="expanded" :aria-label="expanded ? '收起编辑' : '放大编辑'" @click="expanded = !expanded">
          <component :is="expanded ? Minimize2 : Maximize2" :size="14" /><span>{{ expanded ? '收起' : '放大' }}</span>
        </el-button>
      </div>
    </div>
    <div class="description-editor-content">
      <el-input v-show="!preview" ref="input" v-model="value" type="textarea" :rows="12" resize="none"
        maxlength="50000" aria-label="描述原文" spellcheck="false" />
      <div v-if="preview" class="description-preview" role="region" aria-label="描述预览" tabindex="0"><JiraDescription :text="value" /></div>
    </div>
  </div>
</template>

<style scoped>
.jira-description-editor{display:flex;flex-direction:column;width:100%;min-width:0;overflow:hidden;border:1px solid var(--ui-border);border-radius:var(--ds-radius-sm,8px);background:var(--ui-surface)}
.jira-description-editor:focus-within{border-color:var(--ui-accent)}
.description-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--ui-divider);background:var(--ui-raised)}
.description-format-tools,.description-view-tools{display:flex;align-items:center;gap:2px}.description-view-tools{margin-left:auto}
.description-toolbar :deep(.el-button){height:30px;padding:5px 8px;margin:0;border:0;border-radius:5px;color:var(--ui-secondary);font-size:12px;gap:5px}
.description-toolbar :deep(.el-button:hover:not(.is-disabled)),.description-toolbar :deep(.el-button.active){background:var(--ui-accent-soft);color:var(--ui-accent)}
.description-toolbar :deep(.el-button.is-disabled){opacity:.4}
.description-editor-content{display:flex;flex-direction:column;height:clamp(280px,36dvh,400px);min-height:0;overflow:hidden}
.description-editor-content :deep(.el-textarea){display:block;height:100%}
.description-editor-content :deep(.el-textarea__inner){height:100%!important;min-height:100%!important;max-height:none;padding:14px 16px;border-radius:0;box-shadow:none!important;font:13px/1.9 var(--sans,sans-serif);tab-size:2}
.description-preview{flex:1;min-height:0;height:100%;padding:14px 18px;overflow:auto;outline-offset:-2px}
.description-preview :deep(.jira-description>:first-child>:first-child){margin-top:0}
@media(max-width:640px){.description-toolbar{padding:5px 6px;gap:4px}.description-view-tools{width:100%;justify-content:flex-end;padding-top:4px;border-top:1px solid var(--ui-divider)}.description-editor-content{height:300px}.description-editor-content :deep(.el-textarea__inner){padding:12px}}
</style>

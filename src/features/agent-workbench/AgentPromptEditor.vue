<script setup lang="ts">
/**
 * 设计说明：该编辑器统一承载 Agent 消息、@ 能力选择和 Markdown 预览。
 * 它不启动 Agent；模式选择通过事件上报，Skill 与文件以可识别引用写入消息。
 */
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { AtSign, BookmarkPlus, BookOpen, Bot, BriefcaseBusiness, Code2, Eye, File, Folder, History, ImagePlus, Pencil, RotateCcw, Sparkles, Trash2, WandSparkles, X, Zap } from '@lucide/vue';
import { isAgentImageAttachment, type AgentAttachment, type AgentProvider, type AgentRunMode } from '../../../shared/agent-runtime';
import AgentMarkdown from './AgentMarkdown.vue';
import { useAgentMentions, type AgentMentionKind } from './useAgentMentions';
import { useAgentSlashPrompts, type PendingSlashVariableContext } from './useAgentSlashPrompts';
import { analyzeSmartPaste, applySmartPasteAction, extractPromptVariables, fillPromptVariables, type SmartPasteHint } from './prompt-variables-and-paste';
import { estimatePromptTokens } from './prompt-studio-metrics';
import { canEnhancePromptDraft, enhancePromptDraft } from './prompt-enhancer';
import { useAgentInputHistory } from './useAgentInputHistory';
import { useAgentAttachments, type AgentAttachmentDraft } from './useAgentAttachments';
import type { AgentBusinessMention } from './agent-business-context';
import AgentNotePreview from './AgentNotePreview.vue';
import PluginContextPicker from '../custom-plugins/PluginContextPicker.vue';

const props = withDefaults(defineProps<{ workspacePath: string; provider?: AgentProvider; modes?: AgentRunMode[]; selectedMode?: AgentRunMode;
  modeLocked?: boolean; businessOptions?: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft; disabled?: boolean; inputLabel?: string; placeholder?: string; minRows?: number; maxRows?: number; submitOnEnter?: boolean }>(), {
  provider: 'codex', modes: () => [], businessOptions: () => [], modeLocked: false, disabled: false, placeholder: '', minRows: 1, maxRows: 6, submitOnEnter: false,
});
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const emit = defineEmits<{ submit: []; selectMode: [mode: AgentRunMode] }>();
const input = useTemplateRef('input');
const imageInput = useTemplateRef<HTMLInputElement>('imageInput');
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const preview = shallowRef(false);
const noteReference = shallowRef('');
const customSlashName = shallowRef('');
const pendingVarPrompt = shallowRef<PendingSlashVariableContext>();
const variableValues = ref<Record<string, string>>({});
const smartPasteHint = shallowRef<SmartPasteHint>();
const firstVarInput = useTemplateRef<HTMLInputElement[]>('firstVarInput');
const attachedFiles = useAgentAttachments(attachments, () => props.disabled, () => props.attachmentDraft);
const mentions = useAgentMentions(draft, () => ({ workspacePath: props.workspacePath, provider: props.provider,
  modes: props.modes, selectedMode: props.selectedMode, modeLocked: props.modeLocked, businessOptions: props.businessOptions }),
() => props.disabled || preview.value, (mode) => emit('selectMode', mode));
const slashPrompts = useAgentSlashPrompts(
  draft,
  () => ({ modes: props.modes, modeLocked: props.modeLocked }),
  () => props.disabled || preview.value,
  mode => emit('selectMode', mode),
  undefined,
  ctx => {
    const specs = extractPromptVariables(ctx.option.template);
    const initial: Record<string, string> = {};
    for (const item of specs) initial[item.key] = item.defaultValue;
    variableValues.value = initial;
    pendingVarPrompt.value = ctx;
    void nextTick(() => firstVarInput.value?.[0]?.focus());
  },
);
const pendingVarSpecs = computed(() =>
  pendingVarPrompt.value ? extractPromptVariables(pendingVarPrompt.value.option.template) : [],
);
const promptMetrics = computed(() => estimatePromptTokens(draft.value));
const preEnhancedDraft = shallowRef('');
const showEnhanceBtn = computed(() => !props.disabled && !preview.value && canEnhancePromptDraft(draft.value));
async function clearDraft() {
  draft.value = '';
  preEnhancedDraft.value = '';
  smartPasteHint.value = undefined;
  preview.value = false;
  await nextTick();
  input.value?.focus();
}
async function applyPromptEnhance() {
  if (!canEnhancePromptDraft(draft.value)) return;
  const original = draft.value;
  const { enhanced, intentLabel } = enhancePromptDraft(original, props.selectedMode || 'agent');
  if (enhanced === original) return;
  preEnhancedDraft.value = original;
  draft.value = enhanced;
  ElMessage.success(`已按「${intentLabel}」自动补齐排查与验证要求，不满意可点「撤回原话」`);
  await nextTick();
  input.value?.focus();
}
async function revertPromptEnhance() {
  if (!preEnhancedDraft.value) return;
  draft.value = preEnhancedDraft.value;
  preEnhancedDraft.value = '';
  await nextTick();
  input.value?.focus();
}
const inputHistory = useAgentInputHistory(draft, () => props.disabled || preview.value);
watch(draft, val => {
  if (!val.trim()) {
    smartPasteHint.value = undefined;
    preEnhancedDraft.value = '';
  }
});
const slashGroups = computed(() => {
  const custom = slashPrompts.options.value.filter(option => option.custom);
  const builtin = slashPrompts.options.value.filter(option => !option.custom);
  return [
    ...(custom.length ? [{ key: 'custom', label: '我的常用指令', options: custom }] : []),
    ...(builtin.length ? [{ key: 'builtin', label: '内置快捷指令（行首输 / 可呼出）', options: builtin }] : []),
  ];
});
const slashModeLabels: Record<AgentRunMode, string> = { agent: '直接改', plan: '先出方案', ask: '只读分析' };
watch(mentions.documentError, error => { if (error) ElMessage.error(error); });
const mentionGroups = computed(() => {
  const labels: Record<AgentMentionKind, string> = { business: '业务上下文', mode: '模式', skill: 'Skills', note: 'Obsidian 笔记', folder: '目录模块（@目录:）', symbol: '代码符号（@符号:）', file: '文件', ...mentions.labels.value };
  const order: AgentMentionKind[] = mentions.prioritizeSkills.value
    ? [...Object.keys(mentions.labels.value), 'skill', 'note', 'business', 'mode', 'symbol', 'folder', 'file']
    : [...Object.keys(mentions.labels.value), 'business', 'mode', 'skill', 'note', 'folder', 'symbol', 'file'];
  return order.map(kind => ({ kind, label: labels[kind], options: mentions.options.value.filter(option => option.kind === kind) }))
    .filter(group => group.options.length);
});

function mentionIcon(kind: AgentMentionKind) {
  return kind === 'note' || !!mentions.labels.value[kind] ? BookOpen : kind === 'business' ? BriefcaseBusiness : kind === 'mode' ? Bot : kind === 'skill' ? Sparkles : kind === 'folder' ? Folder : kind === 'symbol' ? Code2 : File;
}

function citeNote(reference: string) {
  mentions.select({ id: reference, kind: 'note', label: '', detail: '', value: reference });
}

async function insertMention() {
  preview.value = false;
  slashPrompts.close();
  inputHistory.closePanel();
  mentions.insertTrigger();
  await nextTick();
  input.value?.focus();
}

async function toggleSlashPrompts() {
  preview.value = false;
  inputHistory.closePanel();
  slashPrompts.togglePanel();
  await nextTick();
  input.value?.focus();
}

async function toggleInputHistory() {
  preview.value = false;
  slashPrompts.close();
  inputHistory.togglePanel();
  await nextTick();
  input.value?.focus();
}

async function pickInputHistory(text: string) {
  inputHistory.selectHistoryItem(text);
  await nextTick();
  input.value?.focus();
}

function saveCustomSlash() {
  const saved = slashPrompts.saveCurrentAsCustom(customSlashName.value);
  if (!saved) return;
  customSlashName.value = '';
  ElMessage.success(`已存为常用指令 ${saved.label}`);
}

async function confirmSlashVariables() {
  const ctx = pendingVarPrompt.value;
  if (!ctx) return;
  const filled = fillPromptVariables(ctx.option.template, variableValues.value);
  const base = draft.value;
  draft.value = base ? `${base}${base.endsWith('\n') ? '' : '\n'}${filled}` : filled;
  pendingVarPrompt.value = undefined;
  await nextTick();
  input.value?.focus();
}

async function skipSlashVariables() {
  const ctx = pendingVarPrompt.value;
  if (!ctx) return;
  const rawBody = ctx.option.template.replace(/\{\{\s*(?:光标|cursor)\s*\}\}/gi, '');
  const base = draft.value;
  draft.value = base ? `${base}${base.endsWith('\n') ? '' : '\n'}${rawBody}` : rawBody;
  pendingVarPrompt.value = undefined;
  await nextTick();
  input.value?.focus();
}

async function cancelSlashVariables() {
  pendingVarPrompt.value = undefined;
  await nextTick();
  input.value?.focus();
}

async function applySmartPaste(action: 'wrap-fence' | 'ask-fix-error') {
  const hint = smartPasteHint.value;
  if (!hint) return;
  draft.value = applySmartPasteAction(draft.value, hint, action);
  smartPasteHint.value = undefined;
  if (action === 'ask-fix-error' && !props.modeLocked && props.modes.includes('agent')) {
    emit('selectMode', 'agent');
  }
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
  if (event.isComposing || event.keyCode === 229) return;
  if (typeof slashPrompts !== 'undefined' && slashPrompts.handleKeydown(event)) return;
  if (mentions.handleKeydown(event)) return;
  if (typeof inputHistory !== 'undefined' && inputHistory.handleKeydown(event)) return;
  if (!props.submitOnEnter || event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!props.disabled && !attachedFiles.pending.value) {
    if (typeof preEnhancedDraft !== 'undefined') preEnhancedDraft.value = '';
    if (typeof inputHistory !== 'undefined') inputHistory.recordSubmitted();
    emit('submit');
  }
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

function onPaste(event: ClipboardEvent) {
  attachedFiles.fromTransfer(event.clipboardData, event, (companionText) => {
    if (props.disabled) return;
    const el = input.value;
    const current = draft.value || '';
    if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      draft.value = `${current.slice(0, start)}${companionText}${current.slice(end)}`;
    } else {
      draft.value = current ? `${current}\n${companionText}` : companionText;
    }
  });
  if (event.defaultPrevented || props.disabled) return;
  const pastedText = event.clipboardData?.getData('text/plain') || '';
  const hint = analyzeSmartPaste(pastedText, draft.value);
  if (hint) smartPasteHint.value = hint;
}
function onDrop(event: DragEvent) { attachedFiles.fromTransfer(event.dataTransfer, event); }
</script>

<template>
  <div class="prompt-editor">
    <div class="prompt-tools">
      <el-button text size="small" :disabled="disabled" title="引用项目文件、任务、模式或笔记（输入 @）" @click="insertMention"><AtSign :size="13" /> 选择</el-button>
      <el-button text size="small" :class="{ active: slashPrompts.open.value }" :disabled="disabled"
        title="快捷指令与常用话术（行首输 / 可呼出，也能把当前草稿存为常用）" @click="toggleSlashPrompts">
        <Zap :size="13" /> 快捷指令
      </el-button>
      <el-button v-if="inputHistory.entries.value.length" text size="small" :class="{ active: inputHistory.panelOpen.value }" :disabled="disabled"
        title="查看最近发送过的历史提问（输入框为空时按 ↑ 键也可直接翻出上一条）" @click="toggleInputHistory">
        <History :size="13" /> 历史
      </el-button>
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
      <PluginContextPicker v-model="draft" :disabled="disabled" />
      <el-button v-if="showEnhanceBtn" text size="small" class="prompt-enhance-btn" title="把随手写的一句短话自动补齐定位原因、防改坏旧逻辑与测试验证要求（保留已选 @ 引用）" @click="applyPromptEnhance">
        <WandSparkles :size="13" /> 完善提问
      </el-button>
      <el-button v-else-if="preEnhancedDraft && !disabled" text size="small" class="prompt-revert-btn" title="撤回刚才自动补齐的内容，恢复你原本写的那句话" @click="revertPromptEnhance">
        <RotateCcw :size="13" /> 撤回原话
      </el-button>
      <div v-if="draft.length" class="prompt-telemetry-bar" aria-label="提示词字数与预估 Token">
        <span class="prompt-char-meta" :title="`共 ${promptMetrics.lines} 行 · ${promptMetrics.chars} 字 · 预估约 ${promptMetrics.estimatedTokens} Tokens`">
          <template v-if="promptMetrics.lines > 1">{{ promptMetrics.lines }} 行 · </template>{{ promptMetrics.chars }} 字 · ~{{ promptMetrics.estimatedTokens }} tok
        </span>
        <button v-if="!disabled" type="button" class="prompt-clear-chip" title="清空当前输入框内容" @click="clearDraft">清空</button>
      </div>
    </div>
    <div class="editor-body" @paste="onPaste" @dragover.prevent @drop="onDrop">
      <div v-if="attachments.length" class="image-list" aria-label="已添加附件">
        <figure v-for="attachment in attachments" :key="attachment.id">
          <el-image v-if="isAgentImageAttachment(attachment)" class="attachment-image-preview" :src="attachment.url" :alt="attachment.name"
            fit="cover" :preview-src-list="[attachment.url]" preview-teleported />
          <div v-else class="file-preview"><File :size="27" /></div>
          <figcaption :title="attachment.name">{{ attachment.name }}</figcaption>
          <button type="button" :disabled="disabled || attachedFiles.pending.value" :aria-label="`移除附件 ${attachment.name}`" @click="attachedFiles.remove(attachment)"><X :size="12" /></button>
        </figure>
      </div>
      <div v-if="pendingVarPrompt && pendingVarSpecs.length" class="slash-var-card" role="region" :aria-label="`填写 ${pendingVarPrompt.option.label} 的关键信息`">
        <div class="slash-var-head">
          <strong>填写 {{ pendingVarPrompt.option.label }} 的关键信息</strong>
          <small>回车直接填入输入框 · Esc 取消</small>
          <button type="button" class="slash-var-close" aria-label="取消指令填空" @click="cancelSlashVariables"><X :size="12" /></button>
        </div>
        <div class="slash-var-grid">
          <label v-for="spec in pendingVarSpecs" :key="spec.key" class="slash-var-field">
            <span>{{ spec.key }}</span>
            <input
              ref="firstVarInput"
              v-model="variableValues[spec.key]"
              type="text"
              :placeholder="spec.defaultValue || `请输入${spec.key}`"
              @keydown.enter.stop.prevent="confirmSlashVariables"
              @keydown.esc.stop.prevent="cancelSlashVariables"
            />
          </label>
        </div>
        <div class="slash-var-actions">
          <button type="button" class="slash-var-submit" @click="confirmSlashVariables">填入输入框</button>
          <button type="button" class="slash-var-skip" @click="skipSlashVariables">原样填入</button>
        </div>
      </div>
      <div v-if="smartPasteHint && !preview && !disabled" class="smart-paste-bar" role="region" aria-label="粘贴内容快捷整理">
        <WandSparkles :size="13" class="smart-paste-icon" />
        <span class="smart-paste-text">{{ smartPasteHint.summaryLabel }}，需要顺手整理格式吗？</span>
        <button v-if="smartPasteHint.kind === 'error-log'" type="button" class="smart-paste-primary" @click="applySmartPaste('ask-fix-error')">整理并让 AI 修报错</button>
        <button type="button" class="smart-paste-secondary" @click="applySmartPaste('wrap-fence')">包成整洁代码块</button>
        <button type="button" class="smart-paste-dismiss" aria-label="关闭粘贴整理提示" @click="smartPasteHint = undefined"><X :size="12" /></button>
      </div>
      <el-input v-show="!preview" ref="input" v-model="draft" type="textarea" resize="none" :autosize="{ minRows, maxRows }"
        :disabled="disabled" :aria-label="inputLabel" :placeholder="placeholder" @keydown="onKeydown" />
      <div v-if="preview" class="markdown-preview"><AgentMarkdown :source="draft" /></div>
      <div v-if="inputHistory.panelOpen.value && !slashPrompts.open.value && !mentions.open.value" class="mention-picker history-picker" role="listbox" aria-label="最近发送过的历史提问">
        <section class="mention-group">
          <header class="history-picker-head">
            <span>最近发送过的提问（空框按 ↑ 键也可翻阅）</span>
            <button type="button" class="history-clear-btn" @mousedown.prevent="inputHistory.clearAllHistory()">清空</button>
          </header>
          <div v-for="(item, idx) in inputHistory.entries.value.slice(0, 15)" :key="idx" class="mention-option">
            <button type="button" @mousedown.prevent="pickInputHistory(item)">
              <History :size="13" />
              <span>
                <strong>{{ item.length > 76 ? `${item.slice(0, 76)}…` : item }}</strong>
                <small v-if="item.includes('\n')">共 {{ item.split('\n').length }} 行 · {{ item.length }} 字</small>
              </span>
            </button>
            <button type="button" class="note-preview-button slash-delete-btn" title="删除此条历史提问" aria-label="删除此条历史提问" @mousedown.prevent="inputHistory.removeHistoryItem(item)"><Trash2 :size="13" /></button>
          </div>
        </section>
        <footer class="mention-picker-foot" aria-hidden="true">
          <span><kbd>点击</kbd> 填入输入框</span>
          <span><kbd>↑↓</kbd> 空框翻阅</span>
          <span><kbd>ESC</kbd> 关闭</span>
        </footer>
      </div>
      <div v-if="slashPrompts.open.value && !mentions.open.value" class="mention-picker slash-picker" role="listbox" aria-label="选择快捷指令">
        <div v-if="slashPrompts.canSaveDraft.value" class="slash-save-bar">
          <input v-model="customSlashName" type="text" maxlength="24" placeholder="起个简称（草稿写 {{变量}} 下次可填空）" aria-label="常用指令简称" @keydown.enter.stop.prevent="saveCustomSlash" />
          <button type="button" class="slash-save-btn" @mousedown.prevent="saveCustomSlash"><BookmarkPlus :size="13" /> 存为常用</button>
        </div>
        <section v-for="group in slashGroups" :key="group.key" class="mention-group">
          <header>{{ group.label }}</header>
          <div v-for="option in group.options" :key="option.id" class="mention-option">
            <button type="button" :class="{ active: option.id === slashPrompts.activeOption.value?.id }"
              @mousedown.prevent="slashPrompts.select(option)">
              <Zap :size="13" />
              <span>
                <strong>{{ option.label }}<em v-if="option.mode && !modeLocked" class="slash-mode-tag">{{ slashModeLabels[option.mode] }}</em><em v-if="extractPromptVariables(option.template).length" class="slash-mode-tag is-var-tag">填空</em></strong>
                <small>{{ option.detail }}</small>
              </span>
            </button>
            <button v-if="option.custom" type="button" class="note-preview-button slash-delete-btn" :title="`删除常用指令 ${option.label}`" :aria-label="`删除常用指令 ${option.label}`" @mousedown.prevent="slashPrompts.removeCustomPrompt(option.id)"><Trash2 :size="13" /></button>
          </div>
        </section>
        <span v-if="!slashPrompts.options.value.length" class="mention-state">没有匹配的快捷指令</span>
        <footer class="mention-picker-foot" aria-hidden="true">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 填入指令</span>
          <span><kbd>ESC</kbd> 关闭</span>
        </footer>
      </div>
      <div v-if="mentions.open.value" class="mention-picker" role="listbox" aria-label="选择业务上下文、模式、Skill、文件或文档">
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
        <span v-if="mentions.loading.value" class="mention-state">正在读取候选内容…</span>
        <span v-else-if="!mentions.options.value.length" class="mention-state">未找到匹配内容</span>
        <footer class="mention-picker-foot" aria-hidden="true">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 插入引用</span>
          <span><kbd>ESC</kbd> 关闭</span>
        </footer>
      </div>
    </div>
    <AgentNotePreview v-model="noteReference" @cite="citeNote" />
  </div>
</template>

<style scoped>
.file-preview{display:grid;place-items:center;width:68px;height:54px;border-radius:6px;background:var(--ui-raised);color:var(--ui-accent)}
.mention-option{display:flex;align-items:center}.mention-option>button:first-child{min-width:0;flex:1}.mention-option>.note-preview-button{width:32px;flex-shrink:0;justify-content:center;padding:8px}
.slash-save-bar{display:flex;align-items:center;gap:6px;padding:6px 8px 8px;border-bottom:1px solid var(--ui-divider)}.slash-save-bar input{flex:1;min-width:0;height:28px;padding:0 9px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-raised);color:var(--ui-text);font:400 12px/16px var(--sans);outline:none}.slash-save-bar input:focus{border-color:var(--ui-accent);background:var(--ui-surface)}.slash-save-bar .slash-save-btn{display:inline-flex;align-items:center;gap:5px;width:auto;flex-shrink:0;height:28px;padding:0 10px;border:1px solid color-mix(in srgb,var(--ui-accent) 36%,var(--ui-border));border-radius:7px;background:var(--ui-accent-soft);color:var(--ui-accent);font:600 11.5px/16px var(--sans)}.slash-save-bar .slash-save-btn:hover{background:color-mix(in srgb,var(--ui-accent) 20%,var(--ui-surface))}
.slash-mode-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;background:var(--ui-raised);border:1px solid var(--ui-border);color:var(--ui-muted);font:500 10.5px/15px var(--sans);font-style:normal;vertical-align:middle}
.slash-mode-tag.is-var-tag{border-color:color-mix(in srgb,var(--ui-accent) 34%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent)}
.slash-var-card{margin:0 0 6px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--ui-accent) 36%,var(--ui-border));border-radius:10px;background:color-mix(in srgb,var(--ui-accent-soft) 45%,var(--ui-surface))}
.slash-var-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px}
.slash-var-head strong{color:var(--ui-text);font-weight:600}
.slash-var-head small{color:var(--ui-muted);font-size:11px}
.slash-var-close{margin-left:auto;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--ui-muted);cursor:pointer}
.slash-var-close:hover{background:var(--ui-hover);color:var(--ui-text)}
.slash-var-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px 8px}
.slash-var-field{display:grid;gap:3px}
.slash-var-field span{color:var(--ui-secondary);font:500 11px/1.2 var(--sans)}
.slash-var-field input{height:27px;padding:0 8px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface);color:var(--ui-text);font:400 12px/1 var(--sans);outline:none}
.slash-var-field input:focus{border-color:var(--ui-accent);box-shadow:0 0 0 2px var(--ui-focus-ring)}
.slash-var-actions{display:flex;align-items:center;gap:6px;margin-top:7px}
.slash-var-submit{height:24px;padding:0 10px;border:0;border-radius:6px;background:var(--ui-accent);color:var(--ui-on-primary,#fff);font:600 11.5px/1 var(--sans);cursor:pointer}
.slash-var-skip{height:24px;padding:0 9px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface);color:var(--ui-secondary);font:500 11.5px/1 var(--sans);cursor:pointer}
.slash-var-skip:hover{color:var(--ui-text);background:var(--ui-raised)}
.smart-paste-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0 0 6px;padding:5px 9px;border:1px solid color-mix(in srgb,var(--ui-accent) 32%,var(--ui-border));border-radius:8px;background:color-mix(in srgb,var(--ui-accent-soft) 48%,var(--ui-surface));font-size:11.5px}
.smart-paste-icon{flex-shrink:0;color:var(--ui-accent)}
.smart-paste-text{flex:1;min-width:140px;color:var(--ui-text)}
.smart-paste-primary{height:22px;padding:0 9px;border:0;border-radius:5px;background:var(--ui-accent);color:var(--ui-on-primary,#fff);font:600 11px/1 var(--sans);cursor:pointer}
.smart-paste-secondary{height:22px;padding:0 8px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-surface);color:var(--ui-secondary);font:500 11px/1 var(--sans);cursor:pointer}
.smart-paste-secondary:hover{color:var(--ui-text);background:var(--ui-raised)}
.smart-paste-dismiss{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--ui-muted);cursor:pointer}
.smart-paste-dismiss:hover{background:var(--ui-hover);color:var(--ui-text)}
.slash-delete-btn:hover{color:var(--ui-danger,#dc2626)!important;background:var(--ui-danger-bg,rgb(220 38 38 / .1))!important}
.history-picker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;text-transform:none!important}
.history-picker .history-clear-btn{width:auto!important;height:22px;padding:0 8px!important;border:1px solid var(--ui-border)!important;border-radius:5px!important;background:var(--ui-surface)!important;color:var(--ui-muted)!important;font:500 11px/1 var(--sans)!important}
.history-picker .history-clear-btn:hover{color:var(--ui-danger,#dc2626)!important;border-color:color-mix(in srgb,var(--ui-danger,#dc2626) 40%,var(--ui-border))!important;background:var(--ui-raised)!important}
.prompt-editor{min-width:0}.prompt-tools{display:flex;align-items:center;gap:3px;margin:0 0 4px}.prompt-tools:deep(.el-button){height:24px;padding:2px 7px;border:1px solid transparent;border-radius:6px;color:var(--ui-muted);font:500 11.5px/15px var(--sans)}.prompt-tools:deep(.el-button:hover){background:var(--ui-raised);color:var(--ui-text);border-color:transparent}.prompt-tools:deep(.el-button.active){color:var(--ui-text);background:var(--ui-raised);border-color:transparent;font-weight:600}.image-input{display:none}.tool-divider{width:1px;height:12px;margin:0 3px;background:var(--ui-border)}.editor-body{position:relative}.image-list{display:flex;gap:6px;margin:0 0 6px;overflow-x:auto}.image-list figure{position:relative;width:72px;min-width:72px;margin:0;padding:3px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-raised)}.attachment-image-preview{display:block;width:64px;height:48px;overflow:hidden;border-radius:5px;cursor:zoom-in}.attachment-image-preview:deep(.el-image__inner){display:block;width:100%;height:100%;border-radius:5px}.image-list figcaption{margin-top:3px;overflow:hidden;color:var(--ui-muted);font-size:11px;line-height:14px;text-overflow:ellipsis;white-space:nowrap}.image-list button{position:absolute;top:2px;right:2px;display:grid;place-items:center;width:18px;height:18px;padding:0;border:1px solid var(--ui-border);border-radius:9999px;background:var(--ui-surface);color:var(--ui-text);cursor:pointer;box-shadow:0 1px 3px var(--ui-shadow-color)}.image-list button:disabled{cursor:not-allowed;opacity:.5}.prompt-editor:deep(.el-textarea){display:block}.prompt-editor:deep(.el-textarea__inner){min-height:34px;padding:6px 10px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised);color:var(--ui-text);box-shadow:none;font:400 13px/20px var(--sans);transition:border-color 220ms cubic-bezier(0.22,1,0.36,1),background 220ms cubic-bezier(0.22,1,0.36,1),box-shadow 220ms cubic-bezier(0.22,1,0.36,1)}.prompt-editor:deep(.el-textarea__inner:hover){border-color:color-mix(in srgb,var(--ui-text) 28%,var(--ui-border))}.prompt-editor:deep(.el-textarea__inner:focus){background:var(--ui-surface);border-color:var(--ui-accent);box-shadow:0 0 0 3px var(--ui-focus-ring)}.prompt-editor:deep(.el-textarea__inner::placeholder){color:var(--ui-muted)}.markdown-preview{min-height:34px;max-height:220px;padding:6px 10px;overflow:auto;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised);color:var(--ui-text)}.mention-picker{position:absolute;z-index:8;left:0;right:0;bottom:calc(100% + 8px);max-height:360px;padding:6px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-surface);box-shadow:var(--ui-shadow)}.mention-group+ .mention-group{margin-top:4px;padding-top:4px;border-top:1px solid var(--ui-divider)}.mention-group header{padding:6px 10px 4px;color:var(--ui-muted);font:600 12px/16px var(--mono);text-transform:uppercase}.mention-picker button{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.mention-picker button.active,.mention-picker button:hover{background:var(--ui-accent-soft);color:var(--ui-accent)}.mention-picker button>span{display:grid;min-width:0}.mention-picker strong,.mention-picker small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mention-picker strong{font:500 12px/16px var(--mono)}.mention-picker small{margin-top:2px;color:var(--ui-muted);font-size:12px;line-height:16px}.mention-picker button.active small,.mention-picker button:hover small{color:var(--ui-secondary)}.mention-state{display:block;padding:12px;color:var(--ui-muted);font-size:12px;line-height:16px}.prompt-telemetry-bar{margin-left:auto;display:inline-flex;align-items:center;gap:6px}.prompt-enhance-btn{color:var(--ui-accent)!important;background:color-mix(in srgb,var(--ui-accent-soft) 72%,transparent)!important;border-color:color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border))!important}.prompt-enhance-btn:hover{background:color-mix(in srgb,var(--ui-accent) 18%,var(--ui-surface))!important;color:var(--ui-accent)!important}.prompt-revert-btn{color:var(--ui-secondary)!important;border-color:var(--ui-border)!important}.prompt-char-meta{padding:1px 6px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary);font:500 10.5px/15px var(--mono);font-variant-numeric:tabular-nums}.prompt-clear-chip{height:19px;padding:0 6px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-surface);color:var(--ui-muted);font:500 10.5px/1 var(--sans);cursor:pointer}.prompt-clear-chip:hover{color:var(--ui-danger,#dc2626);border-color:color-mix(in srgb,var(--ui-danger,#dc2626) 40%,var(--ui-border))}:global(:root[data-theme='acid']) .prompt-char-meta,:global(:root[data-theme='acid']) .prompt-clear-chip{border-radius:0!important}.mention-picker-foot{position:sticky;bottom:-6px;display:flex;align-items:center;gap:12px;margin:4px -6px -6px;padding:6px 12px;border-top:1px solid var(--ui-divider);background:var(--ui-raised);color:var(--ui-muted);font:450 10.5px/1 var(--sans)}.mention-picker-foot span{display:inline-flex;align-items:center;gap:4px}.mention-picker-foot kbd{padding:1px 4px;border:1px solid var(--ui-border);border-radius:3px;background:var(--ui-surface);color:var(--ui-secondary);font:600 9.5px/1.1 var(--mono)}
</style>

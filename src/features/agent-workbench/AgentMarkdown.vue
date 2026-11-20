<script setup lang="ts">
/**
 * 设计说明：统一呈现 Agent 结果与输入预览；只消费结构化 Markdown 块。
 * 不使用 v-html，所以模型输出中的 HTML 和脚本始终作为普通文本。
 * 借鉴 Cline / LobeChat 代码块顶栏：支持行数统计、自动换行切换、长代码折叠与安全 Diff 着色。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef } from 'vue';
import { Check, ChevronsUpDown, Code2, Copy, Download, Eye, Quote, Table2, WrapText } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import AgentMarkdownInline from './AgentMarkdownInline.vue';
import { parseAgentMarkdown, type MarkdownInline } from './markdown';
import { detectPreviewableCodeArtifact, markdownTableToCsv, markdownTableToTsv } from './markdown-artifact-preview';
import { canRenderMermaidLite } from './mermaid-lite-svg';
import { inferCodeBlockFilename, inspectJsonCodeBlock } from './code-block-tools';

const AgentDeliveryReport = defineAsyncComponent(() => import('./AgentDeliveryReport.vue'));
const AgentPluginRecordCard = defineAsyncComponent(() => import('../custom-plugins/AgentPluginRecordCard.vue'));
const AgentCodeArtifactPreview = defineAsyncComponent(() => import('./AgentCodeArtifactPreview.vue'));
const AgentMermaidPreview = defineAsyncComponent(() => import('./AgentMermaidPreview.vue'));

const props = withDefaults(defineProps<{ source: string; canAskCode?: boolean; renderBusinessCards?: boolean }>(), { renderBusinessCards: true });
const emit = defineEmits<{ askCode: [payload: { language: string | undefined; code: string }] }>();
const blocks = computed(() => parseAgentMarkdown(props.source));
const copiedIndex = shallowRef<number | null>(null);
const copiedTableIndex = shallowRef<number | null>(null);
const wrappedBlocks = ref<Record<number, boolean>>({});
const expandedBlocks = ref<Record<number, boolean>>({});
const previewBlocks = ref<Record<number, boolean>>({});
const mermaidSourceBlocks = ref<Record<number, boolean>>({});
const jsonModes = ref<Record<number, 'pretty' | 'minified' | undefined>>({});
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let tableCopyTimer: ReturnType<typeof setTimeout> | undefined;

const COLLAPSE_THRESHOLD = 28;

function splitCodeLines(text: string): string[] {
  if (!text) return [''];
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function codeLineCount(text: string): number {
  return splitCodeLines(text).length;
}

function isDiffBlock(language: string | undefined, text: string): boolean {
  const lang = (language || '').trim().toLowerCase();
  if (lang === 'diff' || lang === 'patch' || lang === 'git') return true;
  if (lang && lang !== 'text') return false;
  return text.includes('\n@@ ') && (text.startsWith('diff --git ') || text.startsWith('--- ') || text.includes('\n--- '));
}

function diffLineKind(line: string): 'meta' | 'hunk' | 'add' | 'del' | 'ctx' {
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function toggleWrap(index: number) {
  wrappedBlocks.value = { ...wrappedBlocks.value, [index]: !wrappedBlocks.value[index] };
}

function toggleExpand(index: number) {
  expandedBlocks.value = { ...expandedBlocks.value, [index]: !expandedBlocks.value[index] };
}

function toggleArtifactPreview(index: number) {
  previewBlocks.value = { ...previewBlocks.value, [index]: !previewBlocks.value[index] };
}

function toggleMermaidSource(index: number) {
  mermaidSourceBlocks.value = { ...mermaidSourceBlocks.value, [index]: !mermaidSourceBlocks.value[index] };
}

function isVisualPreviewActive(index: number, language: string | undefined, text: string): boolean {
  if (canRenderMermaidLite(language, text)) return !mermaidSourceBlocks.value[index];
  return Boolean(previewBlocks.value[index] && detectPreviewableCodeArtifact(language, text));
}

function jsonSummary(language: string | undefined, text: string): string {
  const info = inspectJsonCodeBlock(language, text);
  return info.valid ? info.summary : '';
}

function effectiveCodeText(index: number, language: string | undefined, text: string): string {
  const mode = jsonModes.value[index];
  if (!mode) return text;
  const info = inspectJsonCodeBlock(language, text);
  if (!info.valid) return text;
  return mode === 'pretty' ? info.pretty : info.minified;
}

function toggleJsonFormat(index: number, language: string | undefined, text: string) {
  const info = inspectJsonCodeBlock(language, text);
  if (!info.valid) return;
  const current = jsonModes.value[index];
  if (!current) {
    jsonModes.value = { ...jsonModes.value, [index]: info.isMultiLine ? 'minified' : 'pretty' };
  } else if (current === 'pretty') {
    jsonModes.value = { ...jsonModes.value, [index]: 'minified' };
  } else {
    const next = { ...jsonModes.value };
    delete next[index];
    jsonModes.value = next;
  }
}

function jsonButtonLabel(index: number, language: string | undefined, text: string): string {
  const mode = jsonModes.value[index];
  if (!mode) {
    const info = inspectJsonCodeBlock(language, text);
    return info.valid && info.isMultiLine ? '压缩' : '美化';
  }
  return mode === 'pretty' ? '压缩' : '还原';
}

function downloadCodeFile(index: number, language: string | undefined, text: string) {
  const content = effectiveCodeText(index, language, text);
  const { filename, mimeType } = inferCodeBlockFilename(language, text, index);
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyCodeBlock(index: number, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedIndex.value = index;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedIndex.value = null; }, 1500);
  } catch {
    ElMessage.error('复制代码失败');
  }
}

async function copyTableTsv(
  index: number,
  headers: readonly (readonly MarkdownInline[])[],
  rows: readonly (readonly (readonly MarkdownInline[])[])[],
) {
  try {
    await navigator.clipboard.writeText(markdownTableToTsv(headers, rows));
    copiedTableIndex.value = index;
    if (tableCopyTimer) clearTimeout(tableCopyTimer);
    tableCopyTimer = setTimeout(() => { copiedTableIndex.value = null; }, 1800);
  } catch {
    ElMessage.error('复制表格失败');
  }
}

function downloadTableCsv(
  headers: readonly (readonly MarkdownInline[])[],
  rows: readonly (readonly (readonly MarkdownInline[])[])[],
) {
  const csv = markdownTableToCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-table-${Date.now().toString(36)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
  if (tableCopyTimer) clearTimeout(tableCopyTimer);
});
</script>

<template>
  <div class="agent-markdown">
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="`h${block.level}`" v-if="block.type === 'heading'" class="markdown-heading"><AgentMarkdownInline :nodes="block.content" /></component>
      <p v-else-if="block.type === 'paragraph'" class="markdown-paragraph"><AgentMarkdownInline :nodes="block.content" /></p>
      <blockquote v-else-if="block.type === 'quote'" class="markdown-quote"><AgentMarkdownInline :nodes="block.content" /></blockquote>
      <AgentDeliveryReport v-else-if="renderBusinessCards && block.type === 'code' && block.language === 'delivery-report'" :source="block.text" />
      <AgentPluginRecordCard v-else-if="renderBusinessCards && block.type === 'code' && (block.language === 'plugin-record' || block.language === 'custom-plugin-record')" :source="block.text" />
      <div v-else-if="block.type === 'code'" class="markdown-code-wrap">
        <div class="markdown-code-bar">
          <div class="code-bar-meta">
            <span class="code-language">{{ block.language || (isDiffBlock(block.language, block.text) ? 'diff' : 'text') }}</span>
            <span v-if="jsonSummary(block.language, block.text)" class="code-json-meta">{{ jsonSummary(block.language, block.text) }}</span>
            <span v-if="codeLineCount(effectiveCodeText(index, block.language, block.text)) > 1" class="code-line-count">{{ codeLineCount(effectiveCodeText(index, block.language, block.text)) }} 行</span>
          </div>
          <div class="code-bar-actions">
            <button
              v-if="canRenderMermaidLite(block.language, block.text)"
              type="button"
              class="code-tool-btn is-preview-toggle"
              :class="{ active: !mermaidSourceBlocks[index] }"
              :aria-pressed="!mermaidSourceBlocks[index]"
              :title="mermaidSourceBlocks[index] ? '切换为可视化流程图/时序图' : '查看原始 Mermaid 代码'"
              @click="toggleMermaidSource(index)"
            >
              <Eye v-if="mermaidSourceBlocks[index]" :size="11" /><Code2 v-else :size="11" />
              <span>{{ mermaidSourceBlocks[index] ? '看图表' : '看代码' }}</span>
            </button>
            <button
              v-else-if="detectPreviewableCodeArtifact(block.language, block.text)"
              type="button"
              class="code-tool-btn is-preview-toggle"
              :class="{ active: previewBlocks[index] }"
              :aria-pressed="Boolean(previewBlocks[index])"
              :title="previewBlocks[index] ? '切换回源码视图' : '在安全沙盒中实时预览画面效果'"
              @click="toggleArtifactPreview(index)"
            >
              <Code2 v-if="previewBlocks[index]" :size="11" /><Eye v-else :size="11" />
              <span>{{ previewBlocks[index] ? '看代码' : '预览效果' }}</span>
            </button>
            <button
              v-if="!isVisualPreviewActive(index, block.language, block.text) && jsonSummary(block.language, block.text)"
              type="button"
              class="code-tool-btn"
              :class="{ active: Boolean(jsonModes[index]) }"
              title="一键切换 JSON 缩进美化 / 单行压缩 / 原始格式"
              @click="toggleJsonFormat(index, block.language, block.text)"
            >
              <Code2 :size="11" />
              <span>{{ jsonButtonLabel(index, block.language, block.text) }}</span>
            </button>
            <button
              v-if="!isVisualPreviewActive(index, block.language, block.text)"
              type="button"
              class="code-tool-btn"
              :class="{ active: wrappedBlocks[index] }"
              :aria-pressed="Boolean(wrappedBlocks[index])"
              title="切换代码自动换行"
              @click="toggleWrap(index)"
            >
              <WrapText :size="11" />
              <span>换行</span>
            </button>
            <button
              v-if="!isVisualPreviewActive(index, block.language, block.text) && codeLineCount(effectiveCodeText(index, block.language, block.text)) > COLLAPSE_THRESHOLD"
              type="button"
              class="code-tool-btn"
              :aria-expanded="Boolean(expandedBlocks[index])"
              @click="toggleExpand(index)"
            >
              <ChevronsUpDown :size="11" />
              <span>{{ expandedBlocks[index] ? '收起' : '展开' }}</span>
            </button>
            <button
              v-if="canAskCode && block.text.trim()"
              type="button"
              class="code-tool-btn is-ask-code"
              title="把这段代码自动带入下方输入框，方便针对这段代码继续追问或让 AI 微调"
              @click="emit('askCode', { language: block.language, code: effectiveCodeText(index, block.language, block.text) })"
            >
              <Quote :size="11" />
              <span>追问</span>
            </button>
            <button
              v-if="block.text.trim()"
              type="button"
              class="code-tool-btn"
              :title="`保存为文件 ${inferCodeBlockFilename(block.language, block.text, index).filename}`"
              @click="downloadCodeFile(index, block.language, block.text)"
            >
              <Download :size="11" />
              <span>存文件</span>
            </button>
            <button
              type="button"
              class="code-copy-btn"
              :class="{ 'is-copied': copiedIndex === index }"
              :aria-label="copiedIndex === index ? '代码已复制' : '复制代码'"
              @click="copyCodeBlock(index, effectiveCodeText(index, block.language, block.text))"
            >
              <Check v-if="copiedIndex === index" :size="12" /><Copy v-else :size="12" />
              <span>{{ copiedIndex === index ? '已复制' : '复制' }}</span>
            </button>
          </div>
        </div>
        <AgentMermaidPreview
          v-if="canRenderMermaidLite(block.language, block.text) && !mermaidSourceBlocks[index]"
          :source="block.text"
        />
        <AgentCodeArtifactPreview
          v-else-if="previewBlocks[index] && detectPreviewableCodeArtifact(block.language, block.text)"
          :kind="detectPreviewableCodeArtifact(block.language, block.text)!"
          :source="block.text"
        />
        <div
          v-else-if="isDiffBlock(block.language, block.text)"
          class="markdown-code markdown-diff-code"
          :class="{
            'is-wrapped': wrappedBlocks[index],
            'is-collapsed': codeLineCount(block.text) > COLLAPSE_THRESHOLD && !expandedBlocks[index],
          }"
        >
          <div
            v-for="(line, lineIdx) in splitCodeLines(block.text)"
            :key="lineIdx"
            class="md-diff-line"
            :class="`is-${diffLineKind(line)}`"
          >
            <code>{{ line || ' ' }}</code>
          </div>
        </div>
        <pre
          v-else
          class="markdown-code"
          :class="{
            'is-wrapped': wrappedBlocks[index],
            'is-collapsed': codeLineCount(effectiveCodeText(index, block.language, block.text)) > COLLAPSE_THRESHOLD && !expandedBlocks[index],
          }"
        ><code>{{ effectiveCodeText(index, block.language, block.text) }}</code></pre>
        <button
          v-if="!isVisualPreviewActive(index, block.language, block.text) && codeLineCount(effectiveCodeText(index, block.language, block.text)) > COLLAPSE_THRESHOLD && !expandedBlocks[index]"
          type="button"
          class="code-expand-bar"
          @click="toggleExpand(index)"
        >
          展开全部 {{ codeLineCount(effectiveCodeText(index, block.language, block.text)) }} 行代码
        </button>
      </div>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" :start="block.ordered ? block.start : undefined" class="markdown-list"><li v-for="(item, itemIndex) in block.items" :key="itemIndex"><AgentMarkdownInline :nodes="item" /></li></component>
      <div v-else-if="block.type === 'table'" class="markdown-table-wrap">
        <div class="markdown-table-bar">
          <span class="table-bar-meta"><Table2 :size="12" /><span>表格 · {{ block.rows.length }} 行 × {{ block.headers.length }} 列</span></span>
          <div class="table-bar-actions">
            <button
              type="button"
              class="code-tool-btn"
              :class="{ 'is-copied': copiedTableIndex === index }"
              title="按分列格式复制，可直接粘贴到 Excel、飞书或腾讯文档"
              @click="copyTableTsv(index, block.headers, block.rows)"
            >
              <Check v-if="copiedTableIndex === index" :size="11" /><Copy v-else :size="11" />
              <span>{{ copiedTableIndex === index ? '已复制（可贴 Excel）' : '复制表格' }}</span>
            </button>
            <button
              type="button"
              class="code-tool-btn"
              title="导出 UTF-8 CSV 表格文件（Excel 打开中文不乱码）"
              @click="downloadTableCsv(block.headers, block.rows)"
            >
              <Download :size="11" />
              <span>导出 CSV</span>
            </button>
          </div>
        </div>
        <div class="markdown-table-scroll">
          <table class="markdown-table"><thead><tr><th v-for="(cell, cellIndex) in block.headers" :key="cellIndex"><AgentMarkdownInline :nodes="cell" /></th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><AgentMarkdownInline :nodes="cell" /></td></tr></tbody></table>
        </div>
      </div>
      <hr v-else class="markdown-rule" />
    </template>
  </div>
</template>

<style scoped>
.agent-markdown{min-width:0;color:inherit;white-space:normal;font-family:var(--sans);font-size:13px;line-height:1.58;letter-spacing:-0.004em;overflow-wrap:anywhere}
.markdown-heading{margin:11px 0 4px;color:var(--ui-text);font-weight:600;line-height:1.36;letter-spacing:-0.01em}
.markdown-heading:first-child{margin-top:0}
.agent-markdown h1{font-size:15.5px}
.agent-markdown h2{font-size:14.5px}
.agent-markdown h3{font-size:13.5px}
.agent-markdown h4,.agent-markdown h5,.agent-markdown h6{font-size:13px}
.markdown-paragraph{margin:0 0 8px;white-space:pre-wrap}
.markdown-paragraph:last-child{margin-bottom:0}
.markdown-quote{white-space:pre-wrap;margin:6px 0;padding:6px 10px;border-left:2px solid var(--ui-accent);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--ui-raised) 72%,transparent);color:var(--ui-secondary);font-size:12.5px;line-height:1.55}
.markdown-code-wrap{margin:7px 0;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-raised);overflow:hidden}
.markdown-code-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px;border-bottom:1px solid color-mix(in srgb,var(--ui-border) 72%,transparent);background:color-mix(in srgb,var(--ui-surface) 56%,var(--ui-raised))}
.code-bar-meta{display:inline-flex;align-items:center;gap:7px;min-width:0}
.code-language{color:var(--ui-secondary);font:600 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.04em}
.code-json-meta{padding:1px 5px;border:1px solid color-mix(in srgb,var(--ui-accent) 28%,var(--ui-border));border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);font:500 10px/1.2 var(--sans)}
.code-line-count{color:var(--ui-muted);font:500 10.5px/1 var(--mono);font-variant-numeric:tabular-nums}
.code-bar-actions{display:inline-flex;align-items:center;gap:3px}
.code-tool-btn,.code-copy-btn{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--ui-muted);font:500 11px/1 var(--sans);cursor:pointer;transition:background 140ms ease,color 140ms ease,border-color 140ms ease}
.code-tool-btn:hover,.code-copy-btn:hover{border-color:var(--ui-border);background:var(--ui-surface);color:var(--ui-text)}
.code-tool-btn.active{border-color:var(--ui-border);background:var(--ui-surface);color:var(--ui-text);font-weight:600}
.code-tool-btn.is-preview-toggle{border-color:color-mix(in srgb,var(--ui-accent) 32%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent)}
.code-tool-btn.is-preview-toggle:hover,.code-tool-btn.is-preview-toggle.active{border-color:var(--ui-accent);background:var(--ui-accent);color:var(--ui-on-primary,#fff)}
.code-tool-btn.is-ask-code{color:var(--ui-accent)}
.code-tool-btn.is-ask-code:hover{border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent)}
.code-copy-btn.is-copied,.code-tool-btn.is-copied{color:var(--ui-success,#16a34a)}
.markdown-code{position:relative;margin:0;padding:8px 11px;overflow:auto;border:0;background:transparent;color:var(--ui-text);font:12px/1.54 var(--mono);white-space:pre}
.markdown-code.is-wrapped{white-space:pre-wrap;overflow-wrap:anywhere}
.markdown-code.is-collapsed{max-height:360px;overflow-y:hidden;mask-image:linear-gradient(180deg,#000 78%,transparent)}
.markdown-diff-code{padding:4px 0}
.md-diff-line{padding:0 11px;min-height:19px}
.md-diff-line code{padding:0!important;border:0!important;background:transparent!important;color:inherit;font:inherit}
.md-diff-line.is-meta{color:var(--ui-muted);font-size:11.5px}
.md-diff-line.is-hunk{margin:2px 0;padding-block:1px;background:color-mix(in srgb,var(--ui-surface) 75%,var(--ui-raised));color:var(--ui-secondary)}
.md-diff-line.is-add{background:color-mix(in srgb,var(--ui-success,#16a34a) 12%,transparent);color:var(--ui-text)}
.md-diff-line.is-del{background:color-mix(in srgb,var(--ui-danger,#dc2626) 11%,transparent);color:var(--ui-text)}
.code-expand-bar{display:block;width:100%;height:26px;padding:0 10px;border:0;border-top:1px solid color-mix(in srgb,var(--ui-border) 72%,transparent);background:color-mix(in srgb,var(--ui-surface) 60%,var(--ui-raised));color:var(--ui-secondary);font:500 11.5px/1 var(--sans);cursor:pointer;transition:background-color 140ms ease,color 140ms ease}
.code-expand-bar:hover{background:var(--ui-surface);color:var(--ui-text)}
.markdown-list{margin:4px 0 8px;padding-left:18px}
.markdown-list:last-child{margin-bottom:0}
.markdown-list li{margin:2px 0;line-height:1.56}
.markdown-table-wrap{max-width:100%;margin:7px 0;border:1px solid var(--ui-border);border-radius:7px;overflow:hidden;background:var(--ui-surface)}
.markdown-table-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px;border-bottom:1px solid var(--ui-border);background:color-mix(in srgb,var(--ui-surface) 56%,var(--ui-raised))}
.table-bar-meta{display:inline-flex;align-items:center;gap:5px;color:var(--ui-muted);font:500 11px/1 var(--sans)}
.table-bar-actions{display:inline-flex;align-items:center;gap:4px}
.markdown-table-scroll{max-width:100%;overflow-x:auto}
.markdown-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.48}
.markdown-table th,.markdown-table td{padding:5px 8px;border-right:1px solid var(--ui-border);border-bottom:1px solid var(--ui-border);text-align:left}
.markdown-table th:last-child,.markdown-table td:last-child{border-right:0}
.markdown-table tr:last-child td{border-bottom:0}
.markdown-table th{background:var(--ui-raised);color:var(--ui-text);font-weight:600}
.markdown-rule{height:1px;margin:10px 0;border:0;background:var(--ui-border)}
.agent-markdown:deep(a){color:var(--ui-accent);text-underline-offset:3px}
.agent-markdown:deep(code){padding:1px 5px;border:1px solid color-mix(in srgb,var(--ui-border) 82%,transparent);border-radius:5px;background:color-mix(in srgb,var(--ui-text) 6%,var(--ui-raised));color:var(--ui-text);font:500 12px/1.4 var(--mono)}
.markdown-code code{padding:0;border:0;background:transparent;color:inherit}
</style>

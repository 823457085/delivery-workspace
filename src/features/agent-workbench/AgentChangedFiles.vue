<script setup lang="ts">
/**
 * 设计说明：该组件呈现单轮 Agent 的结构化文件变更与本地产物，
 * 支持会话内直接预览 Git Diff / 文件内容，或按需交给 Cursor、浏览器与 Finder。
 */
import { computed, shallowRef } from 'vue';
import { Check, ChevronLeft, ChevronRight, Copy, Download, Eye, FileDiff, FolderOpen, Globe2, MessageSquarePlus, Send, SquareArrowOutUpRight, Trash2, X } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentChangedFile } from '../../../shared/agent-runtime';
import {
  DIFF_REVIEW_SEVERITY_LABELS,
  buildDiffReviewCommentKey,
  formatDiffReviewBasketPrompt,
  removeDiffReviewComment,
  upsertDiffReviewComment,
  type DiffReviewCommentItem,
  type DiffReviewSeverity,
} from '../../../shared/diff-review-basket';
import { presentGitDiff, splitGitDiff } from '../project-inventory/git-diff';

interface ChangedFilePreview {
  path: string;
  status: AgentChangedFile['status'];
  patch: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

const props = defineProps<{ files: AgentChangedFile[]; runId: string; canAsk?: boolean }>();
const emit = defineEmits<{
  askFile: [file: AgentChangedFile, line?: number];
  applyReviewPrompt: [prompt: string];
}>();

const labels: Record<AgentChangedFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  generated: '生成',
};

const previewOpen = shallowRef(false);
const activeFile = shallowRef<AgentChangedFile | null>(null);
const previewLoading = shallowRef(false);
const previewError = shallowRef('');
const previewData = shallowRef<ChangedFilePreview | null>(null);
const viewMode = shallowRef<'unified' | 'split' | 'content'>('unified');
const copied = shallowRef(false);
const reviewBasket = shallowRef<DiffReviewCommentItem[]>([]);
const showBasketList = shallowRef(false);
const activeLineDraft = shallowRef<{ file: string; line: number; side: 'new' | 'old'; codeSnippet: string } | null>(null);
const lineCommentInput = shallowRef('');
const lineCommentSeverity = shallowRef<DiffReviewSeverity>('must_fix');
const basketCopied = shallowRef(false);
let previewSeq = 0;

const basketKeySet = computed(() => new Set(reviewBasket.value.map(item => item.id)));
const severityOptions: Array<{ value: DiffReviewSeverity; label: string }> = [
  { value: 'must_fix', label: DIFF_REVIEW_SEVERITY_LABELS.must_fix },
  { value: 'nit', label: DIFF_REVIEW_SEVERITY_LABELS.nit },
  { value: 'question', label: DIFF_REVIEW_SEVERITY_LABELS.question },
];

const activeIndex = computed(() => (
  activeFile.value
    ? props.files.findIndex(item => item.path === activeFile.value!.path && item.status === activeFile.value!.status)
    : -1
));
const diffPresentation = computed(() => presentGitDiff(previewData.value?.patch || ''));
const splitRows = computed(() => (viewMode.value === 'split' ? splitGitDiff(diffPresentation.value.lines) : []));
const hasPatch = computed(() => Boolean(previewData.value?.patch?.trim()));
const hasContent = computed(() => Boolean(previewData.value?.content?.length));
const effectiveMode = computed<'unified' | 'split' | 'content'>(() => {
  if (viewMode.value === 'content' && hasContent.value) return 'content';
  if (!hasPatch.value && hasContent.value) return 'content';
  return viewMode.value === 'split' ? 'split' : 'unified';
});
const contentLines = computed(() => {
  const raw = previewData.value?.content || '';
  if (!raw) return [];
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
});

const canOpenInBrowser = (file: AgentChangedFile) => file.status !== 'deleted' && /\.(?:html?|svg)$/i.test(file.path);

function splitFilePath(rawPath: string) {
  const normalized = rawPath.replaceAll('\\', '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0
    ? { base: normalized.slice(idx + 1), dir: normalized.slice(0, idx) }
    : { base: normalized, dir: '' };
}

const statusCounts = computed(() => {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const f of props.files) {
    if (f.status === 'added' || f.status === 'generated') added++;
    else if (f.status === 'deleted') deleted++;
    else modified++;
  }
  return { added, modified, deleted };
});

async function previewFile(file: AgentChangedFile) {
  const seq = ++previewSeq;
  activeFile.value = file;
  previewOpen.value = true;
  previewLoading.value = true;
  previewError.value = '';
  previewData.value = null;
  copied.value = false;
  try {
    const response = await fetch(`/api/agent-runtimes/runs/${encodeURIComponent(props.runId)}/preview-file?path=${encodeURIComponent(file.path)}`);
    const result = await response.json() as ChangedFilePreview & { message?: string };
    if (seq !== previewSeq) return;
    if (!response.ok) throw new Error(result.message || '读取文件预览失败');
    previewData.value = result;
    if (!result.patch?.trim() && result.content) viewMode.value = 'content';
    else if (viewMode.value === 'content' && !result.content && result.patch?.trim()) viewMode.value = 'unified';
  } catch (error) {
    if (seq !== previewSeq) return;
    previewError.value = error instanceof Error ? error.message : '读取文件预览失败';
  } finally {
    if (seq === previewSeq) previewLoading.value = false;
  }
}

function stepPreview(delta: -1 | 1) {
  const next = props.files[activeIndex.value + delta];
  if (next) void previewFile(next);
}

async function copyPreviewText() {
  const text = effectiveMode.value === 'content'
    ? (previewData.value?.content || '')
    : (previewData.value?.patch || previewData.value?.content || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    ElMessage.error('复制失败，请检查剪贴板权限');
  }
}

async function requestFileAction(file: AgentChangedFile, action: 'open-file' | 'reveal-file' | 'open-browser') {
  if (file.status === 'deleted') return;
  try {
    const response = await fetch(`/api/agent-runtimes/runs/${props.runId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ path: file.path }),
    });
    const result = await response.json() as { message?: string };
    if (action === 'open-browser' && response.status === 404 && result.message === 'Agent 执行接口不存在') {
      throw new Error('浏览器预览接口尚未生效，请在 Agent 任务结束后重启 Delivery Workspace');
    }
    if (!response.ok) throw new Error(result.message || '打开文件失败');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打开文件失败'); }
}

const openInCursor = (file: AgentChangedFile) => requestFileAction(file, 'open-file');
const revealInFolder = (file: AgentChangedFile) => requestFileAction(file, 'reveal-file');
const openInBrowser = (file: AgentChangedFile) => requestFileAction(file, 'open-browser');

function parseDiffLineNumber(raw: string | number | null | undefined): number | undefined {
  const num = typeof raw === 'number' ? raw : Number.parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function askAboutFile(file: AgentChangedFile, line?: number) {
  activeLineDraft.value = null;
  previewOpen.value = false;
  emit('askFile', file, line);
}

function isLineCommented(side: 'new' | 'old', rawLine: string | number | null | undefined): boolean {
  const line = parseDiffLineNumber(rawLine);
  if (!activeFile.value || !line) return false;
  return basketKeySet.value.has(buildDiffReviewCommentKey(activeFile.value.path, side, line));
}

function selectDiffLineForReview(
  rawLine: string | number | null | undefined,
  side: 'new' | 'old' = 'new',
  codeSnippet = '',
) {
  const line = parseDiffLineNumber(rawLine);
  if (!props.canAsk || !activeFile.value || !line) return;
  const key = buildDiffReviewCommentKey(activeFile.value.path, side, line);
  const existing = reviewBasket.value.find(item => item.id === key);
  lineCommentInput.value = existing?.comment || '';
  lineCommentSeverity.value = existing?.severity || 'must_fix';
  activeLineDraft.value = {
    file: activeFile.value.path,
    line,
    side,
    codeSnippet: codeSnippet.trim().slice(0, 140),
  };
}

function saveInlineLineComment() {
  const draft = activeLineDraft.value;
  if (!draft) return;
  if (!lineCommentInput.value.trim()) {
    ElMessage.warning('请填写对该行代码的具体审查意见，或点击「直接定位追问」');
    return;
  }
  reviewBasket.value = upsertDiffReviewComment(reviewBasket.value, {
    file: draft.file,
    line: draft.line,
    side: draft.side,
    codeSnippet: draft.codeSnippet,
    comment: lineCommentInput.value,
    severity: lineCommentSeverity.value,
  });
  activeLineDraft.value = null;
  lineCommentInput.value = '';
}

function quickAskDraftLine() {
  const draft = activeLineDraft.value;
  if (!draft || !activeFile.value) return;
  if (lineCommentInput.value.trim()) {
    const prompt = formatDiffReviewBasketPrompt(
      upsertDiffReviewComment([], {
        file: draft.file,
        line: draft.line,
        side: draft.side,
        codeSnippet: draft.codeSnippet,
        comment: lineCommentInput.value,
        severity: lineCommentSeverity.value,
      }),
    );
    activeLineDraft.value = null;
    lineCommentInput.value = '';
    previewOpen.value = false;
    emit('applyReviewPrompt', prompt);
    return;
  }
  askAboutFile(activeFile.value, draft.line);
}

function deleteBasketComment(id: string) {
  reviewBasket.value = removeDiffReviewComment(reviewBasket.value, id);
}

async function copyReviewBasket() {
  const text = formatDiffReviewBasketPrompt(reviewBasket.value);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    basketCopied.value = true;
    setTimeout(() => { basketCopied.value = false; }, 1600);
  } catch {
    ElMessage.error('复制失败，请检查剪贴板权限');
  }
}

function submitReviewBasket() {
  const prompt = formatDiffReviewBasketPrompt(reviewBasket.value);
  if (!prompt) return;
  reviewBasket.value = [];
  activeLineDraft.value = null;
  showBasketList.value = false;
  previewOpen.value = false;
  emit('applyReviewPrompt', prompt);
}
</script>

<template>
  <section class="changed-files" aria-label="本轮改动文件">
    <header>
      <FileDiff :size="13" />
      <strong>本轮改动 / 生成文件</strong>
      <div v-if="files.length" class="changed-header-stats">
        <button
          v-if="canAsk && reviewBasket.length"
          type="button"
          class="changed-basket-pill"
          :title="`已收集 ${reviewBasket.length} 条行级批注，点击一键汇总填入会话输入框`"
          @click="submitReviewBasket"
        >
          <Send :size="11" /> 批注篮 ({{ reviewBasket.length }})
        </button>
        <em v-if="statusCounts.added" class="is-add" title="新增 / 生成文件">+{{ statusCounts.added }}</em>
        <em v-if="statusCounts.modified" class="is-mod" title="修改 / 重命名文件">~{{ statusCounts.modified }}</em>
        <em v-if="statusCounts.deleted" class="is-del" title="删除文件">-{{ statusCounts.deleted }}</em>
        <span>{{ files.length }}</span>
      </div>
    </header>
    <div v-if="files.length" class="changed-file-list">
      <div v-for="file in files" :key="`${file.status}:${file.path}`" class="changed-file-row">
        <button type="button" class="changed-file-open"
          :title="`预览改动与代码：${file.path}`" @click="previewFile(file)">
          <span :class="file.status">{{ labels[file.status] }}</span>
          <span class="changed-file-path">
            <strong class="changed-file-base">{{ splitFilePath(file.path).base }}</strong>
            <small v-if="splitFilePath(file.path).dir" class="changed-file-dir">{{ splitFilePath(file.path).dir }}</small>
          </span>
          <Eye :size="11" />
        </button>
        <div class="changed-file-actions">
          <button v-if="canAsk" type="button" class="changed-file-action is-ask"
            :title="`针对 ${file.path} 继续追问或让 AI 修改`" :aria-label="`针对 ${file.path} 让 AI 修改`" @click="askAboutFile(file)">
            <MessageSquarePlus :size="12" />
          </button>
          <button v-if="file.status !== 'deleted'" type="button" class="changed-file-action"
            :title="`在 Cursor 中打开 ${file.path}`" :aria-label="`在 Cursor 中打开 ${file.path}`" @click="openInCursor(file)">
            <SquareArrowOutUpRight :size="12" />
          </button>
          <a v-if="file.status !== 'deleted'" class="changed-file-action" :href="`/api/agent-runtimes/runs/${encodeURIComponent(runId)}/download-file?path=${encodeURIComponent(file.path)}`" download
            :title="`下载 ${file.path}`" :aria-label="`下载 ${file.path}`"><Download :size="12" /></a>
          <button v-if="canOpenInBrowser(file)" type="button" class="changed-file-action" :title="`在浏览器中打开 ${file.path}`"
            :aria-label="`在浏览器中打开 ${file.path}`" @click="openInBrowser(file)"><Globe2 :size="12" /></button>
          <button type="button" class="changed-file-action" :disabled="file.status === 'deleted'" :title="`在文件夹中显示 ${file.path}`"
            :aria-label="`在文件夹中显示 ${file.path}`" @click="revealInFolder(file)"><FolderOpen :size="12" /></button>
        </div>
      </div>
    </div>
    <small v-else>未检测到工作区改动或本地文件产物</small>

    <el-drawer
      v-model="previewOpen"
      append-to-body
      destroy-on-close
      size="min(960px, 94vw)"
      class="hub-drawer changed-file-drawer"
      :title="activeFile?.path || '改动预览'"
    >
      <template #header="{ titleId, titleClass }">
        <div class="changed-drawer-header">
          <div class="changed-drawer-title">
            <span v-if="activeFile" class="changed-drawer-badge" :class="activeFile.status">{{ labels[activeFile.status] }}</span>
            <h3 :id="titleId" :class="titleClass">{{ activeFile?.path || '改动预览' }}</h3>
            <span v-if="!previewLoading && diffPresentation.added" class="changed-stat-add">+{{ diffPresentation.added }}</span>
            <span v-if="!previewLoading && diffPresentation.removed" class="changed-stat-del">-{{ diffPresentation.removed }}</span>
          </div>
          <div class="changed-drawer-controls">
            <div v-if="files.length > 1" class="changed-drawer-nav" aria-label="切换改动文件">
              <el-button size="small" :disabled="activeIndex <= 0" title="上一个文件" @click="stepPreview(-1)"><ChevronLeft :size="13" /></el-button>
              <span>{{ activeIndex + 1 }} / {{ files.length }}</span>
              <el-button size="small" :disabled="activeIndex < 0 || activeIndex >= files.length - 1" title="下一个文件" @click="stepPreview(1)"><ChevronRight :size="13" /></el-button>
            </div>
            <el-radio-group v-if="previewData && !previewData.binary" v-model="viewMode" size="small" aria-label="预览视图切换">
              <el-radio-button value="unified" :disabled="!hasPatch">统一差异</el-radio-button>
              <el-radio-button value="split" :disabled="!hasPatch">左右对比</el-radio-button>
              <el-radio-button value="content" :disabled="!hasContent">文件内容</el-radio-button>
            </el-radio-group>
            <el-button v-if="previewData && !previewData.binary && (hasPatch || hasContent)" size="small" @click="copyPreviewText">
              <Check v-if="copied" :size="13" /><Copy v-else :size="13" />
              <span style="margin-left: 4px">{{ copied ? '已复制' : effectiveMode === 'content' ? '复制代码' : '复制 Diff' }}</span>
            </el-button>
            <el-button v-if="canAsk && activeFile" size="small" type="primary" @click="askAboutFile(activeFile)">
              <MessageSquarePlus :size="13" /><span style="margin-left: 4px">让 AI 改此文件</span>
            </el-button>
            <el-button v-if="activeFile && activeFile.status !== 'deleted'" size="small" type="primary" plain @click="openInCursor(activeFile)">
              Cursor 打开
            </el-button>
          </div>
        </div>
      </template>

      <div class="changed-drawer-body">
        <p v-if="previewData?.truncated" class="changed-drawer-notice">文件体积较大，当前仅展示前 512 KB 预览内容。</p>
        <p v-if="canAsk && activeFile && previewData && !previewData.binary && (hasPatch || hasContent)" class="changed-line-ask-tip">
          提示：点击任意行号可添加<strong>行级审查批注</strong>（支持跨多个文件累积到批注篮后汇总发送给 AI），也可一键带入 <code>@{{ activeFile.path }}:行号</code>。
        </p>

        <div v-if="canAsk && reviewBasket.length" class="changed-review-basket" role="region" aria-label="行级审查批注篮">
          <div class="changed-basket-bar">
            <span class="changed-basket-summary">
              <strong>行级审查批注篮</strong>
              <small>已收集 {{ reviewBasket.length }} 处批注（可继续切文件添加）</small>
            </span>
            <div class="changed-basket-actions">
              <el-button link size="small" type="primary" @click="showBasketList = !showBasketList">
                {{ showBasketList ? '收起明细' : '查看明细' }}
              </el-button>
              <el-button link size="small" @click="copyReviewBasket">
                {{ basketCopied ? '已复制' : '复制 Markdown' }}
              </el-button>
              <el-button link size="small" type="danger" @click="reviewBasket = []">清空</el-button>
              <el-button size="small" type="primary" @click="submitReviewBasket">
                <Send :size="12" /><span style="margin-left: 4px">汇总发送给 AI ({{ reviewBasket.length }})</span>
              </el-button>
            </div>
          </div>
          <ul v-if="showBasketList" class="changed-basket-list">
            <li v-for="item in reviewBasket" :key="item.id">
              <span class="changed-basket-sev" :class="`is-${item.severity}`">{{ DIFF_REVIEW_SEVERITY_LABELS[item.severity] }}</span>
              <code>@{{ item.file }}:{{ item.line }}</code>
              <span class="changed-basket-text">{{ item.comment }}</span>
              <button type="button" class="changed-basket-del" title="移除此条批注" @click="deleteBasketComment(item.id)">
                <Trash2 :size="12" />
              </button>
            </li>
          </ul>
        </div>

        <div
          v-if="canAsk && activeLineDraft && activeLineDraft.file === activeFile?.path"
          class="changed-inline-composer"
          role="region"
          aria-label="添加行级代码批注"
        >
          <div class="changed-inline-head">
            <div class="changed-inline-target">
              <strong>行级批注</strong>
              <code>@{{ activeLineDraft.file }}:{{ activeLineDraft.line }}</code>
              <small v-if="activeLineDraft.side === 'old'">(变更前代码)</small>
              <code v-if="activeLineDraft.codeSnippet" class="changed-inline-snippet">{{ activeLineDraft.codeSnippet }}</code>
            </div>
            <button type="button" class="changed-inline-close" aria-label="关闭行级批注框" @click="activeLineDraft = null">
              <X :size="13" />
            </button>
          </div>
          <div class="changed-inline-controls">
            <div class="changed-sev-group" role="group" aria-label="批注严重度">
              <button
                v-for="opt in severityOptions"
                :key="opt.value"
                type="button"
                class="changed-sev-chip"
                :class="{ active: lineCommentSeverity === opt.value }"
                @click="lineCommentSeverity = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
            <el-input
              v-model="lineCommentInput"
              size="small"
              placeholder="输入对该行的修改要求（按 Enter 加入批注篮，可继续审阅其他行与文件）…"
              @keydown.enter.exact.prevent="saveInlineLineComment"
              @keydown.esc="activeLineDraft = null"
            />
            <el-button size="small" type="primary" @click="saveInlineLineComment">加入批注篮</el-button>
            <el-button size="small" plain @click="quickAskDraftLine">直接定位追问</el-button>
          </div>
        </div>

        <div v-if="previewLoading" class="changed-drawer-empty">正在读取文件改动…</div>
        <el-alert v-else-if="previewError" :title="previewError" type="error" :closable="false" show-icon />
        <div v-else-if="previewData?.binary" class="changed-drawer-empty">
          二进制文件不支持文本差异预览，可点击右上角在 Cursor 中打开或直接下载。
        </div>
        <div v-else-if="effectiveMode === 'split' && hasPatch" class="changed-diff-view" tabindex="0">
          <div class="changed-diff-pair changed-diff-headings"><span>变更前</span><span>变更后</span></div>
          <template v-for="(row, index) in splitRows" :key="index">
            <div v-if="'info' in row" class="changed-diff-line" :class="`is-${row.info.kind}`"><code>{{ row.info.content }}</code></div>
            <div v-else class="changed-diff-pair">
              <div v-for="(cell, side) in [row.old, row.next]" :key="side" class="changed-diff-line changed-diff-cell" :class="cell ? `is-${cell.line.kind}` : 'is-blank'">
                <template v-if="cell">
                  <span
                    class="changed-line-num"
                    :class="{
                      'is-askable': canAsk && !!activeFile && !!parseDiffLineNumber(side === 0 ? cell.line.oldLine : cell.line.newLine),
                      'is-commented': isLineCommented(side === 0 ? 'old' : 'new', side === 0 ? cell.line.oldLine : cell.line.newLine),
                    }"
                    :title="canAsk && activeFile && parseDiffLineNumber(side === 0 ? cell.line.oldLine : cell.line.newLine) ? `点击添加第 ${parseDiffLineNumber(side === 0 ? cell.line.oldLine : cell.line.newLine)} 行审查批注` : undefined"
                    @click="selectDiffLineForReview(side === 0 ? cell.line.oldLine : cell.line.newLine, side === 0 ? 'old' : 'new', cell.line.content)"
                  >{{ side === 0 ? cell.line.oldLine : cell.line.newLine }}</span>
                  <span class="changed-line-mark" aria-hidden="true">{{ cell.line.marker }}</span>
                  <code>{{ cell.line.content || ' ' }}<small v-if="cell.note" class="changed-diff-note">{{ cell.note }}</small></code>
                </template>
              </div>
            </div>
          </template>
        </div>
        <div v-else-if="effectiveMode === 'unified' && hasPatch" class="changed-diff-view" tabindex="0">
          <div v-for="(line, index) in diffPresentation.lines" :key="index" class="changed-diff-line" :class="`is-${line.kind}`">
            <span
              class="changed-line-num"
              :class="{
                'is-askable': canAsk && !!activeFile && !!parseDiffLineNumber(line.oldLine || line.newLine),
                'is-commented': isLineCommented(line.newLine ? 'new' : 'old', line.newLine || line.oldLine),
              }"
              :title="canAsk && activeFile && parseDiffLineNumber(line.oldLine || line.newLine) ? `点击添加第 ${parseDiffLineNumber(line.newLine || line.oldLine)} 行审查批注` : undefined"
              @click="selectDiffLineForReview(line.newLine || line.oldLine, line.newLine ? 'new' : 'old', line.content)"
            >{{ line.oldLine }}</span>
            <span
              class="changed-line-num"
              :class="{
                'is-askable': canAsk && !!activeFile && !!parseDiffLineNumber(line.newLine || line.oldLine),
                'is-commented': isLineCommented(line.newLine ? 'new' : 'old', line.newLine || line.oldLine),
              }"
              :title="canAsk && activeFile && parseDiffLineNumber(line.newLine || line.oldLine) ? `点击添加第 ${parseDiffLineNumber(line.newLine || line.oldLine)} 行审查批注` : undefined"
              @click="selectDiffLineForReview(line.newLine || line.oldLine, line.newLine ? 'new' : 'old', line.content)"
            >{{ line.newLine }}</span>
            <span class="changed-line-mark" aria-hidden="true">{{ line.marker }}</span>
            <code>{{ line.content || ' ' }}</code>
          </div>
        </div>
        <div v-else-if="hasContent" class="changed-diff-view" tabindex="0">
          <div v-for="(line, index) in contentLines" :key="index" class="changed-diff-line is-content">
            <span
              class="changed-line-num"
              :class="{
                'is-askable': canAsk && !!activeFile,
                'is-commented': isLineCommented('new', index + 1),
              }"
              :title="canAsk && activeFile ? `点击添加第 ${index + 1} 行审查批注` : undefined"
              @click="selectDiffLineForReview(index + 1, 'new', line)"
            >{{ index + 1 }}</span>
            <code>{{ line || ' ' }}</code>
          </div>
        </div>
        <div v-else class="changed-drawer-empty">暂无可展示的差异或文本内容（文件可能为空或工作区已清理）。</div>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.changed-files{margin-top:8px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--ui-border,var(--agent-border)) 82%,transparent);border-radius:var(--ds-radius-sm,8px);background:color-mix(in srgb,var(--ui-raised,var(--agent-bg)) 54%,transparent)}
.changed-files header{display:flex;align-items:center;gap:6px;color:var(--ui-secondary,var(--agent-secondary))}.changed-files header strong{font-size:11.5px;line-height:16px;font-weight:600;color:var(--ui-secondary,var(--agent-secondary))}.changed-header-stats{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font:600 10.5px/15px var(--mono);font-variant-numeric:tabular-nums}.changed-header-stats em{font-style:normal}.changed-header-stats em.is-add{color:var(--ui-success,#16a34a)}.changed-header-stats em.is-mod{color:var(--ui-warning,#d97706)}.changed-header-stats em.is-del{color:var(--ui-danger,#dc2626)}.changed-header-stats span{padding:0 6px;border-radius:999px;background:var(--ui-surface,transparent);border:1px solid var(--ui-border,var(--agent-border));color:var(--ui-muted,var(--agent-muted))}
.changed-file-list{display:grid;gap:2px;max-height:184px;margin-top:6px;overflow:auto;padding-right:2px}.changed-file-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px;padding:1px 3px;border-radius:var(--ds-radius-xs,6px);transition:background-color 140ms ease}.changed-file-row:hover{background:var(--ui-hover,color-mix(in srgb,var(--agent-accent) 10%,transparent))}.changed-file-open{display:grid;grid-template-columns:auto minmax(0,1fr) 12px;align-items:center;gap:6px;min-height:24px;padding:2px 4px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.changed-file-open:disabled,.changed-file-action:disabled{cursor:default;opacity:.55}.changed-file-open>span:first-child{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:0 5px;border-radius:var(--ds-radius-xs,4px);font:600 10.5px/15px var(--sans);background:var(--ui-surface);border:1px solid var(--ui-border)}.changed-file-open>span.added{color:var(--ui-success,#16a34a);background:var(--ui-success-bg,rgb(22 163 74 / .1));border-color:color-mix(in srgb,var(--ui-success,#16a34a) 26%,transparent)}.changed-file-open>span.modified,.changed-file-open>span.renamed{color:var(--ui-warning,#d97706);background:var(--ui-warning-bg,rgb(217 119 6 / .1));border-color:color-mix(in srgb,var(--ui-warning,#d97706) 26%,transparent)}.changed-file-open>span.deleted{color:var(--ui-danger,#dc2626);background:var(--ui-danger-bg,rgb(220 38 38 / .1));border-color:color-mix(in srgb,var(--ui-danger,#dc2626) 26%,transparent)}.changed-file-open>span.generated{color:var(--ui-accent,#2563eb);background:var(--ui-accent-soft,rgb(37 99 235 / .1));border-color:color-mix(in srgb,var(--ui-accent,#2563eb) 26%,transparent)}
.changed-file-path{display:inline-flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden}.changed-file-base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text,var(--agent-text));font:550 11.5px/1.4 var(--mono)}.changed-file-dir{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-muted,var(--agent-muted));font:400 10.5px/1.4 var(--mono)}.changed-file-open svg,.changed-file-action{color:var(--ui-muted,var(--agent-muted))}.changed-file-open:hover svg{color:var(--ui-accent,var(--agent-accent))}.changed-file-actions{display:flex;align-items:center;gap:2px}.changed-file-action{display:grid;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:var(--ds-radius-xs,5px);background:transparent;cursor:pointer;place-items:center;transition:background-color 140ms ease,color 140ms ease,border-color 140ms ease}.changed-file-action:hover:not(:disabled){color:var(--ui-text,var(--agent-text));border-color:var(--ui-border);background:var(--ui-surface,color-mix(in srgb,var(--agent-accent) 14%,transparent))}.changed-files>small{display:block;margin-top:4px;color:var(--ui-muted,var(--agent-muted));font-size:11.5px;line-height:16px}
.changed-file-action.is-ask:hover:not(:disabled){color:var(--ui-accent,var(--agent-accent));border-color:color-mix(in srgb,var(--ui-accent,var(--agent-accent)) 36%,var(--ui-border));background:var(--ui-accent-soft,color-mix(in srgb,var(--agent-accent) 14%,transparent))}
.changed-drawer-header{display:flex;flex-direction:column;gap:12px;min-width:0;padding-right:8px}
.changed-drawer-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.changed-drawer-title h3{margin:0;font:600 14px/1.5 var(--mono,monospace);color:var(--ui-text);overflow-wrap:anywhere}
.changed-drawer-badge{padding:2px 8px;border-radius:6px;font-size:11.5px;font-weight:600;background:var(--ui-raised);border:1px solid var(--ui-border);color:var(--ui-secondary)}
.changed-drawer-badge.added{color:var(--ui-success,#16a34a);background:var(--ui-success-bg)}.changed-drawer-badge.modified,.changed-drawer-badge.renamed{color:var(--ui-warning,#d97706);background:var(--ui-warning-bg)}.changed-drawer-badge.deleted{color:var(--ui-danger,#dc2626);background:var(--ui-danger-bg)}.changed-drawer-badge.generated{color:var(--ui-accent,#2563eb);background:var(--ui-accent-soft)}
.changed-stat-add{color:var(--ui-success,#16a34a);font:600 12px/1 var(--mono,monospace)}
.changed-stat-del{color:var(--ui-danger,#dc2626);font:600 12px/1 var(--mono,monospace)}
.changed-drawer-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.changed-drawer-controls :deep(.el-button){margin:0}
.changed-drawer-nav{display:inline-flex;align-items:center;gap:6px;font:12px/1 var(--mono,monospace);color:var(--ui-muted)}
.changed-drawer-body{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0}
.changed-drawer-notice{margin:0;padding:8px 12px;border-radius:8px;border:1px solid var(--ui-border);background:var(--ui-raised);color:var(--ui-muted);font-size:12.5px}
.changed-line-ask-tip{margin:0;padding:6px 11px;border-radius:8px;border:1px solid color-mix(in srgb,var(--ui-accent) 26%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-secondary);font-size:12px}
.changed-line-ask-tip code{font-family:var(--mono);color:var(--ui-accent)}
.changed-drawer-empty{display:grid;place-items:center;min-height:220px;padding:24px;border:1px solid var(--ui-border);border-radius:12px;color:var(--ui-muted);font-size:13.5px;text-align:center}
.changed-diff-view{flex:1;min-height:0;overflow:auto;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-surface);padding:6px 0}
.changed-diff-line{display:grid;grid-template-columns:48px 48px 24px minmax(0,1fr);padding-right:14px;min-height:25px;color:var(--ui-text);font:12.5px/1.75 var(--mono,ui-monospace,monospace)}
.changed-diff-line.is-content{grid-template-columns:54px minmax(0,1fr);gap:12px}
.changed-diff-line code{min-width:0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.changed-line-num{color:var(--ui-muted);font-size:11px;text-align:right;padding-right:8px;border-right:1px solid color-mix(in srgb,var(--ui-border) 55%,transparent);font-variant-numeric:tabular-nums;user-select:none}
.changed-line-num.is-askable{cursor:pointer;transition:background-color 140ms ease,color 140ms ease}
.changed-line-num.is-askable:hover{background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:700}
.changed-line-num.is-commented{background:color-mix(in srgb,var(--ui-accent,#2563eb) 18%,var(--ui-surface));color:var(--ui-accent,#2563eb);font-weight:700}
.changed-basket-pill{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border:1px solid color-mix(in srgb,var(--ui-accent,#2563eb) 42%,var(--ui-border));border-radius:999px;background:var(--ui-accent-soft,rgb(37 99 235 / .12));color:var(--ui-accent,#2563eb);font:600 10.5px/1 var(--sans);cursor:pointer}
.changed-basket-pill:hover{background:color-mix(in srgb,var(--ui-accent,#2563eb) 20%,var(--ui-surface))}
.changed-review-basket{padding:9px 12px;border:1px solid color-mix(in srgb,var(--ui-accent,#2563eb) 36%,var(--ui-border));border-radius:10px;background:color-mix(in srgb,var(--ui-accent-soft,transparent) 50%,var(--ui-raised))}
.changed-basket-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.changed-basket-summary{display:inline-flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12.5px}
.changed-basket-summary small{color:var(--ui-muted);font-size:11.5px}
.changed-basket-actions{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.changed-basket-actions :deep(.el-button){margin:0}
.changed-basket-list{list-style:none;margin:8px 0 0;padding:8px 0 0;border-top:1px solid var(--ui-border);display:flex;flex-direction:column;gap:6px;max-height:148px;overflow:auto}
.changed-basket-list li{display:flex;align-items:center;gap:7px;font-size:12px;min-width:0}
.changed-basket-list code{font:600 11.5px/1.3 var(--mono);color:var(--ui-accent);flex-shrink:0}
.changed-basket-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text)}
.changed-basket-sev{padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;flex-shrink:0}
.changed-basket-sev.is-must_fix{color:var(--ui-danger,#dc2626);background:color-mix(in srgb,var(--ui-danger,#dc2626) 12%,var(--ui-surface))}
.changed-basket-sev.is-nit{color:var(--ui-warning,#d97706);background:color-mix(in srgb,var(--ui-warning,#d97706) 13%,var(--ui-surface))}
.changed-basket-sev.is-question{color:var(--ui-accent,#2563eb);background:color-mix(in srgb,var(--ui-accent,#2563eb) 12%,var(--ui-surface))}
.changed-basket-del{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--ui-muted);cursor:pointer;flex-shrink:0}
.changed-basket-del:hover{color:var(--ui-danger,#dc2626);background:var(--ui-surface)}
.changed-inline-composer{padding:10px 12px;border:1px solid var(--ui-accent,#2563eb);border-radius:10px;background:var(--ui-surface);display:flex;flex-direction:column;gap:8px}
.changed-inline-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.changed-inline-target{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0;font-size:12px}
.changed-inline-target code{font:600 11.5px/1.35 var(--mono);color:var(--ui-accent)}
.changed-inline-target .changed-inline-snippet{padding:1px 6px;border-radius:4px;background:var(--ui-raised);color:var(--ui-secondary);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.changed-inline-close{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--ui-muted);cursor:pointer}
.changed-inline-close:hover{color:var(--ui-text);background:var(--ui-raised)}
.changed-inline-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.changed-inline-controls :deep(.el-input){flex:1;min-width:220px}
.changed-inline-controls :deep(.el-button){margin:0}
.changed-sev-group{display:inline-flex;align-items:center;gap:4px}
.changed-sev-chip{height:24px;padding:0 8px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary);font-size:11px;font-weight:600;cursor:pointer}
.changed-sev-chip.active{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent)}
.changed-line-mark{text-align:center;user-select:none}
.changed-diff-line.is-add{background:color-mix(in srgb,var(--ui-success,#16a34a) 11%,var(--ui-surface))}
.changed-diff-line.is-remove{background:color-mix(in srgb,var(--ui-danger,#dc2626) 11%,var(--ui-surface))}
.is-add .changed-line-mark{color:var(--ui-success,#16a34a)}
.is-remove .changed-line-mark{color:var(--ui-danger,#dc2626)}
.changed-diff-line.is-meta{color:var(--ui-muted);font-size:11.5px}
.changed-diff-line.is-hunk{color:var(--ui-accent);background:var(--ui-raised);margin-block:4px;font-size:12px}
.changed-diff-line:is(.is-meta,.is-hunk){grid-template-columns:minmax(0,1fr);padding-inline:14px}
.changed-diff-line:is(.is-meta,.is-hunk) :is(.changed-line-num,.changed-line-mark){display:none}
.changed-diff-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
.changed-diff-pair>:first-child{border-right:1px solid var(--ui-border)}
.changed-diff-headings{position:sticky;top:0;z-index:1;background:var(--ui-raised);color:var(--ui-secondary);font-size:12px;font-weight:600;border-bottom:1px solid var(--ui-border)}
.changed-diff-headings span{padding:7px 14px}
.changed-diff-line.changed-diff-cell{grid-template-columns:42px 18px minmax(0,1fr);font-size:12px;padding-right:8px}
.changed-diff-cell.is-blank{background:var(--ui-raised)}
.changed-diff-note{display:block;color:var(--ui-muted);font-size:11px}
</style>

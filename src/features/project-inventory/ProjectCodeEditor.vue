<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { editor as EditorTypes, IDisposable } from 'monaco-editor';
import { hasConflictMarkers, parseConflictBlocks, type ConflictBlock } from '../../../shared/project-code';

const props = defineProps<{ directory: string; file: string; initialLine?: number }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const loading = shallowRef(true);
const saving = shallowRef(false);
const ready = shallowRef(false);
const content = shallowRef('');
const original = shallowRef('');
const revision = shallowRef('');
const conflict = shallowRef(false);
const editable = shallowRef(false);
const editorHost = ref<HTMLElement>();
const fullscreen = shallowRef(false);
const wordWrap = shallowRef(false);
const cursor = shallowRef({ lineNumber: 1, column: 1 });
const lineCount = shallowRef(1);
const language = shallowRef('plaintext');
const lineEnding = shallowRef('LF');
const indentation = shallowRef('空格: 2');
const diagnostics = shallowRef({ errors: 0, warnings: 0 });
const activeConflict = shallowRef(0);
const conflictList = ref<HTMLElement>();
const conflictLocations = shallowRef<{ startLine: number; endLine: number }[]>([]);
let monaco: typeof import('./project-editor-monaco');
let editor: EditorTypes.IStandaloneCodeEditor | undefined;
let model: EditorTypes.ITextModel | undefined;
let conflictDecorations: EditorTypes.IEditorDecorationsCollection | undefined;
let changeDecorations: EditorTypes.IEditorDecorationsCollection | undefined;
let themeObserver: MutationObserver | undefined;
let disposed = false;
const subscriptions: IDisposable[] = [];
const dirty = computed(() => content.value !== original.value);
const markersRemain = computed(() => hasConflictMarkers(content.value));
const blocks = computed(() => markersRemain.value ? parseConflictBlocks(content.value) : []);

function blockRange(block: ConflictBlock) {
  if (!model) return;
  const endsWithNewline = content.value[block.end - 1] === '\n';
  const endLine = block.endLine + (endsWithNewline ? 1 : 0);
  return new monaco.Range(block.startLine, 1, endLine, endsWithNewline ? 1 : model.getLineMaxColumn(endLine));
}

function updateConflicts() {
  if (!model || !conflictDecorations) return;
  const locations: { startLine: number; endLine: number }[] = [];
  conflictDecorations.set(blocks.value.map((block, index) => {
    const range = blockRange(block)!;
    const endLine = range.endColumn === 1 ? Math.max(range.startLineNumber, range.endLineNumber - 1) : range.endLineNumber;
    locations.push({ startLine: range.startLineNumber, endLine });
    return {
      range: new monaco.Range(range.startLineNumber, 1, endLine, model!.getLineMaxColumn(endLine)),
      options: {
        isWholeLine: true,
        className: 'project-conflict-highlight', linesDecorationsClassName: 'project-conflict-gutter',
        overviewRuler: { color: '#d89614', position: monaco.editor.OverviewRulerLane.Full },
        hoverMessage: { value: `冲突 ${index + 1}，第 ${range.startLineNumber}–${endLine} 行` },
      },
    };
  }));
  conflictLocations.value = locations;
  activeConflict.value = locations.length ? Math.min(Math.max(activeConflict.value, 1), locations.length) : 0;
}

function jumpToConflict(index: number) {
  const block = blocks.value[index];
  if (!editor || !block) return;
  const range = blockRange(block)!;
  activeConflict.value = index + 1;
  editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
  editor.focus();
  conflictList.value?.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function jumpToChange() {
  if (!editor || !model || !props.initialLine) return;
  const line = changeDecorations?.getRange(0)?.startLineNumber ?? Math.min(Math.max(1, props.initialLine), model.getLineCount());
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
  editor.focus();
}

async function load() {
  try {
    const params = new URLSearchParams({ path: props.directory, file: props.file });
    const [response, api] = await Promise.all([
      fetch(`/api/projects/git/code?${params}`), import('./project-editor-monaco'),
    ]);
    const data = await response.json();
    if (disposed) return;
    if (!response.ok) throw new Error(data.message || '读取文件失败');
    monaco = api;
    content.value = original.value = data.content;
    revision.value = data.revision;
    conflict.value = data.conflict;
    editable.value = data.editable;
    ready.value = true;
    await nextTick();
    createEditor();
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : '读取文件失败');
  } finally {
    loading.value = false;
  }
}

function updateStatus() {
  if (!model) return;
  language.value = model.getLanguageId();
  lineCount.value = model.getLineCount();
  lineEnding.value = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  const options = model.getOptions();
  indentation.value = `${options.insertSpaces ? '空格' : 'Tab'}: ${options.tabSize}`;
  const markers = monaco.editor.getModelMarkers({ resource: model.uri });
  diagnostics.value = {
    errors: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Error).length,
    warnings: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Warning).length,
  };
}

function createEditor() {
  if (!editorHost.value || disposed || editor) return;
  const uri = monaco.Uri.from({ scheme: 'inmemory', path: `${props.directory}/${props.file}` });
  const extension = props.file.split('.').pop()?.toLowerCase();
  const languageOverride = extension === 'vue' ? 'html' : undefined;
  model = monaco.editor.createModel(content.value, languageOverride, uri);
  model.detectIndentation(true, 2);
  editor = monaco.editor.create(editorHost.value, {
    model, automaticLayout: true, readOnly: !editable.value || saving.value,
    ariaLabel: `${props.file} 代码编辑器`,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 14, lineHeight: 23, lineNumbers: 'on', lineNumbersMinChars: 4,
    minimap: { enabled: false }, padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false, wordWrap: wordWrap.value ? 'on' : 'off',
    folding: true, showFoldingControls: 'always', bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true }, renderWhitespace: 'selection',
    autoIndent: 'full',
    fixedOverflowWidgets: true, stickyScroll: { enabled: false },
  });
  subscriptions.push(
    editor.onDidChangeModelContent(() => {
      content.value = model!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
      updateConflicts();
      updateStatus();
    }),
    editor.onDidChangeCursorPosition(event => {
      cursor.value = event.position;
      const index = conflictLocations.value.findIndex(location => event.position.lineNumber >= location.startLine && event.position.lineNumber <= location.endLine);
      if (index >= 0) activeConflict.value = index + 1;
    }),
    monaco.editor.onDidChangeMarkers(resources => {
      if (model && resources.some(resource => resource.toString() === model!.uri.toString())) updateStatus();
    }),
    editor.addAction({ id: 'project.save', label: '保存文件', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => save() }),
  );
  themeObserver = new MutationObserver(() => {
    monaco.editor.setTheme(document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs');
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  conflictDecorations = editor.createDecorationsCollection();
  updateConflicts();
  if (props.initialLine && !blocks.value.length) {
    const line = Math.min(Math.max(1, props.initialLine), model.getLineCount());
    changeDecorations = editor.createDecorationsCollection([{
      range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
      options: { isWholeLine: true, className: 'project-change-highlight', linesDecorationsClassName: 'project-change-gutter' },
    }]);
  }
  updateStatus();
  if (blocks.value.length) jumpToConflict(0);
  else if (props.initialLine) jumpToChange();
  else editor.focus();
}

function choose(block: ConflictBlock, choice: 'ours' | 'theirs' | 'both') {
  if (!editor || !model) return;
  const index = blocks.value.indexOf(block);
  const range = blockRange(block)!;
  const text = choice === 'both' ? block.ours + block.theirs : block[choice];
  editor.pushUndoStop();
  editor.executeEdits('resolve-conflict', [{ range, text }]);
  editor.pushUndoStop();
  if (blocks.value.length) jumpToConflict(Math.min(index, blocks.value.length - 1));
  else editor.revealLineInCenter(Math.min(range.startLineNumber, model.getLineCount()));
  editor.focus();
}

function editorAction(id: string) {
  editor?.focus();
  editor?.trigger('toolbar', id, undefined);
}

async function formatDocument() {
  const action = editor?.getAction('editor.action.formatDocument');
  if (!action?.isSupported()) { ElMessage.info('当前文件语言暂不支持格式化'); return; }
  try { await action.run(); editor?.focus(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '格式化未完成'); }
}

async function save(resolve = false) {
  if (!ready.value || !editable.value || saving.value) return;
  saving.value = true;
  try {
    const response = await fetch('/api/projects/git/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: props.directory, file: props.file, content: content.value, revision: revision.value, resolve }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '保存文件失败');
    original.value = content.value = data.code.content;
    if (model && model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) !== data.code.content) model.setValue(data.code.content);
    revision.value = data.code.revision;
    conflict.value = data.code.conflict;
    emit('saved');
    if (data.resolutionError) ElMessage.error(data.resolutionError);
    else ElMessage.success(resolve ? '已保存并暂存该文件，冲突已标记为解决' : '文件已保存');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存文件失败');
  } finally {
    saving.value = false;
  }
}

async function beforeClose(done: () => void) {
  if (saving.value) return;
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('编辑内容尚未保存，确认放弃本次编辑？', '未保存的修改', {
        confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning',
      });
    } catch { return; }
  }
  done();
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = ''; }
}
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); void load(); });
watch([saving, editable], () => editor?.updateOptions({ readOnly: saving.value || !editable.value }));
watch(wordWrap, value => editor?.updateOptions({ wordWrap: value ? 'on' : 'off' }));
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('beforeunload', beforeUnload);
  themeObserver?.disconnect();
  subscriptions.forEach(subscription => subscription.dispose());
  editor?.dispose();
  model?.dispose();
});
</script>

<template>
  <el-dialog
    :model-value="true" :title="`${conflict || blocks.length ? '解决冲突' : '编辑文件'}：${file}`"
    class="project-code-dialog" width="min(1600px, 96vw)" top="3vh" :fullscreen="fullscreen" append-to-body destroy-on-close
    :close-on-click-modal="false" :close-on-press-escape="false" :before-close="beforeClose" @closed="emit('close')"
  >
    <div v-loading="loading" class="code-editor-body">
      <div class="code-editor-context"><span>{{ directory }}</span><el-tag v-if="dirty" size="small" type="warning">未保存</el-tag></div>
      <template v-if="ready">
        <div class="code-editor-toolbar" role="toolbar" aria-label="代码编辑工具">
          <div class="conflict-actions">
            <el-button size="small" @click="editorAction('actions.find')">查找</el-button>
            <el-button size="small" :disabled="saving || !editable" @click="editorAction('editor.action.startFindReplaceAction')">替换</el-button>
            <el-button size="small" :disabled="saving || !editable" @click="formatDocument">格式化</el-button>
            <el-button size="small" :aria-pressed="wordWrap" @click="wordWrap = !wordWrap">自动换行{{ wordWrap ? '：开' : '：关' }}</el-button>
          </div>
          <el-button size="small" :aria-pressed="fullscreen" @click="fullscreen = !fullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
        </div>
        <div v-if="blocks.length" class="conflict-navigation" aria-label="冲突导航">
          <el-button size="small" :disabled="activeConflict <= 1" @click="jumpToConflict(activeConflict - 2)">上一个冲突</el-button>
          <span>冲突 {{ activeConflict }} / {{ blocks.length }}<template v-if="conflictLocations[activeConflict - 1]"> · 第 {{ conflictLocations[activeConflict - 1].startLine }}–{{ conflictLocations[activeConflict - 1].endLine }} 行</template></span>
          <el-button size="small" :disabled="activeConflict >= blocks.length" @click="jumpToConflict(activeConflict)">下一个冲突</el-button>
        </div>
        <div v-else-if="initialLine" class="conflict-navigation">
          <el-button size="small" @click="jumpToChange">定位改动</el-button>
        </div>
        <div v-if="blocks.length" ref="conflictList" class="conflict-blocks" aria-label="待处理冲突块">
          <section v-for="(block, index) in blocks" :key="block.start" class="conflict-block" :class="{ 'is-active': activeConflict === index + 1 }">
            <div class="conflict-heading">
              <el-button link class="conflict-location" @click="jumpToConflict(index)">冲突 {{ index + 1 }} / {{ blocks.length }}<template v-if="conflictLocations[index]"> · L{{ conflictLocations[index].startLine }}–L{{ conflictLocations[index].endLine }}</template></el-button>
              <div class="conflict-actions">
                <el-button size="small" :disabled="saving || !editable" @click="choose(block, 'ours')">保留当前</el-button>
                <el-button size="small" :disabled="saving || !editable" @click="choose(block, 'theirs')">保留传入</el-button>
                <el-button size="small" :disabled="saving || !editable" @click="choose(block, 'both')">保留双方</el-button>
              </div>
            </div>
            <div class="conflict-sides">
              <div><span>当前内容</span><pre>{{ block.ours || '（空）' }}</pre></div>
              <div><span>传入内容</span><pre>{{ block.theirs || '（空）' }}</pre></div>
            </div>
          </section>
        </div>
        <div v-if="conflict" class="code-editor-label">合并结果</div>
        <div ref="editorHost" class="code-editor-host" role="region" aria-label="代码编辑区" />
        <div class="code-editor-status" role="status">
          <span>行 {{ cursor.lineNumber }}，列 {{ cursor.column }}</span>
          <span>{{ lineCount }} 行</span><span>{{ indentation }}</span><span>{{ lineEnding }}</span><span>UTF-8</span><span>{{ language.toUpperCase() }}</span>
          <span v-if="diagnostics.errors || diagnostics.warnings">{{ diagnostics.errors }} 个错误 · {{ diagnostics.warnings }} 个警告</span>
          <span class="code-save-shortcut">⌘ / Ctrl + S 保存</span>
        </div>
      </template>
    </div>
    <template #footer>
      <div class="code-editor-footer">
        <span v-if="ready && !editable">符号链接文件仅支持预览，请打开原文件编辑。</span>
        <span v-else-if="conflict">{{ markersRemain ? '仍有冲突标记' : '冲突标记已清除，可保存并标记已解决' }}</span>
        <div class="conflict-actions">
          <el-button :disabled="!ready || !editable || !dirty || saving" :loading="saving" @click="save()">保存</el-button>
          <el-button v-if="conflict" type="primary" :disabled="!ready || !editable || markersRemain || saving" :loading="saving" @click="save(true)">保存并标记已解决</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.project-code-dialog.el-dialog) { display: flex; flex-direction: column; height: 91vh; margin-bottom: 0; padding: 16px 20px; }
:global(.project-code-dialog.el-dialog.is-fullscreen) { height: 100dvh; }
:global(.project-code-dialog .el-dialog__header) { flex: none; padding-bottom: 12px; }
:global(.project-code-dialog .el-dialog__title) { font: 600 15px/1.5 var(--mono, monospace); overflow-wrap: anywhere; }
:global(.project-code-dialog .el-dialog__body) { flex: 1; min-height: 0; display: flex; }
:global(.project-code-dialog .el-dialog__footer) { flex: none; padding-top: 12px; }
.code-editor-body { display: flex; flex: 1; flex-direction: column; gap: 10px; min-height: 240px; min-width: 0; }
.code-editor-context { display: flex; align-items: center; gap: 12px; min-height: 22px; flex: none; overflow-wrap: anywhere; color: var(--ui-muted); font: 12px/1.5 var(--mono, monospace); }
.code-editor-toolbar { display: flex; flex: none; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.conflict-navigation { display: flex; flex: none; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; }
.conflict-navigation :deep(.el-button) { margin: 0; }
.conflict-blocks { max-height: 25vh; min-height: 0; overflow: auto; display: flex; flex: 0 1 auto; flex-direction: column; gap: 12px; }
.conflict-block { border: 1px solid var(--ui-border); border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.conflict-block.is-active { border-color: var(--ui-accent); }
.conflict-location { font-weight: 600; }
.conflict-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 12px; background: var(--ui-raised); }
.conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.conflict-actions :deep(.el-button) { margin: 0; }
.conflict-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.conflict-sides > div { min-width: 0; padding: 10px 12px; }
.conflict-sides > div + div { border-left: 1px solid var(--ui-border); }
.conflict-sides span { font-size: 12px; color: var(--ui-muted); }
.conflict-sides pre { margin: 6px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.6 var(--mono, monospace); }
.code-editor-label { font-size: 13px; }
.code-editor-host { flex: 1; min-height: 180px; min-width: 0; border: 1px solid var(--ui-border); border-radius: 6px; overflow: hidden; text-align: left; }
.code-editor-host :deep(.project-conflict-highlight) { background: color-mix(in srgb, var(--ui-warning, #b7791f) 14%, transparent); }
.code-editor-host :deep(.project-conflict-gutter) { border-left: 3px solid #d89614; margin-left: 3px; }
.code-editor-host :deep(.project-change-highlight) { background: color-mix(in srgb, var(--ui-success, #237e5e) 10%, transparent); }
.code-editor-host :deep(.project-change-gutter) { border-left: 3px solid var(--ui-success, #237e5e); margin-left: 3px; }
.code-editor-status { display: flex; gap: 14px; flex: none; align-items: center; flex-wrap: wrap; color: var(--ui-muted); font: 12px/1.5 var(--mono, monospace); }
.code-save-shortcut { margin-left: auto; }
.code-editor-footer { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
.code-editor-footer > span { margin-right: auto; color: var(--ui-muted); font-size: 12px; }
@media (max-width: 650px) { .conflict-sides { grid-template-columns: 1fr; } .conflict-sides > div + div { border-left: 0; border-top: 1px solid var(--ui-border); } }
</style>

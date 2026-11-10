<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { Check, ChevronDown, Folder, FolderGit2, FolderOpen, GitBranch, Search, X } from '@lucide/vue';
import { workspacePathLabel, type AgentWorkspaceOption } from './workspace-catalog';

const props = withDefaults(defineProps<{
  workspaces: AgentWorkspaceOption[];
  disabled?: boolean;
  placement?: 'top-start' | 'bottom-start';
  emptyLabel?: string;
  showInlineTags?: boolean;
}>(), {
  disabled: false,
  placement: 'top-start',
  emptyLabel: '不选择项目',
  showInlineTags: true,
});

const workspacePath = defineModel<string>('workspacePath', { required: true });
const workspacePaths = defineModel<string[]>('workspacePaths', { default: () => [] });
const branch = defineModel<string>('branch', { default: '' });
const emit = defineEmits<{ chooseWorkspace: [] }>();

const menuOpen = shallowRef(false);
const query = shallowRef('');

watch(menuOpen, open => { if (!open) query.value = ''; });

// Keep workspacePath and workspacePaths synchronized bidirectionally
watch(workspacePath, next => {
  const trimmed = (next || '').trim();
  if (!trimmed) {
    if (workspacePaths.value.length) workspacePaths.value = [];
    return;
  }
  if (workspacePaths.value[0] !== trimmed) {
    workspacePaths.value = [trimmed, ...workspacePaths.value.filter(item => item !== trimmed)];
  }
}, { immediate: true });

watch(workspacePaths, list => {
  const primary = list[0] || '';
  if (workspacePath.value !== primary) {
    workspacePath.value = primary;
  }
  if (!primary) {
    branch.value = '';
  } else {
    const match = props.workspaces.find(item => item.path === primary);
    if (match?.branch && !branch.value) branch.value = match.branch;
  }
}, { deep: true });

const byPath = computed(() => new Map(props.workspaces.map(item => [item.path, item])));

function optionFor(path: string): AgentWorkspaceOption {
  return byPath.value.get(path) || {
    path,
    label: workspacePathLabel(path),
    branch: '',
    folder: path.split('/').filter(Boolean).at(-1) || path,
    source: 'custom',
  };
}

const selectedOptions = computed(() => workspacePaths.value.map(path => optionFor(path)));
const primaryOption = computed(() => selectedOptions.value[0]);

const triggerLabel = computed(() => {
  if (!selectedOptions.value.length) return props.emptyLabel;
  return primaryOption.value?.label || props.emptyLabel;
});

const filteredWorkspaces = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return props.workspaces;
  return props.workspaces.filter(item =>
    `${item.label} ${item.folder || ''} ${item.path} ${item.branch} ${item.repository || ''}`.toLowerCase().includes(term),
  );
});

function isSelected(path: string): boolean {
  return workspacePaths.value.includes(path);
}

function toggleWorkspace(item: AgentWorkspaceOption) {
  if (props.disabled) return;
  const current = [...workspacePaths.value];
  const index = current.indexOf(item.path);
  if (index >= 0) {
    current.splice(index, 1);
  } else {
    if (current.length >= 10) return;
    current.push(item.path);
  }
  workspacePaths.value = current;
  const nextPrimary = current[0] || '';
  workspacePath.value = nextPrimary;
  const primaryMeta = byPath.value.get(nextPrimary);
  if (primaryMeta?.branch) branch.value = primaryMeta.branch;
  else if (!nextPrimary) branch.value = '';
}

function makePrimary(path: string) {
  if (props.disabled) return;
  const rest = workspacePaths.value.filter(item => item !== path);
  workspacePaths.value = [path, ...rest];
  workspacePath.value = path;
  const meta = byPath.value.get(path);
  if (meta?.branch) branch.value = meta.branch;
}

function removeWorkspace(path: string) {
  if (props.disabled) return;
  const next = workspacePaths.value.filter(item => item !== path);
  workspacePaths.value = next;
  workspacePath.value = next[0] || '';
}

function clearWorkspaces() {
  if (props.disabled) return;
  workspacePaths.value = [];
  workspacePath.value = '';
  branch.value = '';
  menuOpen.value = false;
}

function chooseOtherFolder() {
  menuOpen.value = false;
  emit('chooseWorkspace');
}
</script>

<template>
  <div class="workspace-selector-wrap">
    <el-popover
      v-model:visible="menuOpen"
      trigger="click"
      :placement="placement"
      width="min(430px, calc(100vw - 24px))"
      :disabled="disabled"
      popper-class="agent-workspace-popper"
    >
      <template #reference>
        <button
          type="button"
          class="context-chip workspace-chip"
          :class="{ 'has-selection': selectedOptions.length > 0 }"
          :disabled="disabled"
          :title="selectedOptions.map(item => `${item.label} (${item.path})`).join('\n') || emptyLabel"
        >
          <FolderGit2 v-if="selectedOptions.length" :size="14" class="chip-icon active" />
          <Folder v-else :size="14" class="chip-icon" />
          <span class="chip-label">{{ triggerLabel }}</span>
          <span v-if="selectedOptions.length > 1" class="chip-count">+{{ selectedOptions.length - 1 }}</span>
          <ChevronDown :size="12" class="chip-arrow" :class="{ open: menuOpen }" />
        </button>
      </template>

      <div class="workspace-menu">
        <header class="workspace-menu-head">
          <div>
            <strong>选择项目工作区</strong>
            <small>支持多选项目，首项作为主执行目录</small>
          </div>
          <button v-if="selectedOptions.length" type="button" class="clear-btn" @click="clearWorkspaces">
            清空 ({{ selectedOptions.length }})
          </button>
        </header>

        <label class="workspace-search">
          <Search :size="14" />
          <input v-model="query" type="search" placeholder="搜索项目名称、目录、仓库或分支…" aria-label="搜索项目" />
          <button v-if="query" type="button" class="search-clear" aria-label="清除搜索" @click="query = ''">
            <X :size="12" />
          </button>
        </label>

        <div v-if="selectedOptions.length > 1" class="selected-strip" aria-label="已选项目列表">
          <span v-for="(item, idx) in selectedOptions" :key="item.path" class="selected-pill" :class="{ primary: idx === 0 }" :title="item.path">
            <em v-if="idx === 0">主</em>
            <button v-else type="button" class="pill-promote" title="设为主执行目录" @click.stop="makePrimary(item.path)">设主</button>
            <span>{{ item.label }}</span>
            <button type="button" class="pill-remove" :aria-label="`移除 ${item.label}`" @click.stop="removeWorkspace(item.path)">
              <X :size="11" />
            </button>
          </span>
        </div>

        <div class="workspace-options" role="listbox" aria-multiselectable="true">
          <button
            type="button"
            class="workspace-option no-project-option"
            :class="{ active: !selectedOptions.length }"
            @click="clearWorkspaces"
          >
            <span class="option-check" :class="{ checked: !selectedOptions.length }">
              <Check v-if="!selectedOptions.length" :size="12" />
            </span>
            <Folder :size="15" class="option-icon" />
            <span class="option-body">
              <span class="option-title-row">
                <strong>不选择项目</strong>
                <small class="option-tag">独立会话</small>
              </span>
              <small class="option-path">不绑定业务仓库，用于日常问答、方案讨论或跨项目只读分析</small>
            </span>
          </button>

          <button
            v-for="item in filteredWorkspaces"
            :key="item.path"
            type="button"
            class="workspace-option"
            :class="{ active: isSelected(item.path), 'is-primary': workspacePaths[0] === item.path }"
            @click="toggleWorkspace(item)"
          >
            <span class="option-check" :class="{ checked: isSelected(item.path) }">
              <Check v-if="isSelected(item.path)" :size="12" />
            </span>
            <FolderGit2 :size="15" class="option-icon" />
            <span class="option-body">
              <span class="option-title-row">
                <strong>{{ item.label }}</strong>
                <span v-if="item.folder && item.folder !== item.label" class="option-folder">{{ item.folder }}</span>
                <span v-if="workspacePaths[0] === item.path && selectedOptions.length > 0" class="option-primary-badge">主目录</span>
                <span
                  v-else-if="isSelected(item.path) && selectedOptions.length > 1"
                  role="button"
                  tabindex="0"
                  class="option-make-primary"
                  @click.stop="makePrimary(item.path)"
                  @keydown.enter.stop.prevent="makePrimary(item.path)"
                >设为主目录</span>
                <span v-if="item.branch" class="option-branch"><GitBranch :size="11" />{{ item.branch }}</span>
              </span>
              <small class="option-path" :title="item.path">{{ item.path }}</small>
            </span>
          </button>

          <p v-if="!filteredWorkspaces.length" class="workspace-empty">
            {{ query.trim() ? '没有匹配的项目或工作区' : '暂无已扫描项目，可点击下方选择本机文件夹' }}
          </p>
        </div>

        <footer class="workspace-menu-foot">
          <button type="button" class="choose-folder" @click="chooseOtherFolder">
            <FolderOpen :size="14" />
            <span>选择其他文件夹…</span>
          </button>
          <div class="foot-right">
            <span class="foot-count">{{ selectedOptions.length ? `已选 ${selectedOptions.length} 个项目` : '未选项目' }}</span>
            <button type="button" class="done-btn" @click="menuOpen = false">完成</button>
          </div>
        </footer>
      </div>
    </el-popover>

    <div v-if="showInlineTags && selectedOptions.length > 1" class="inline-selected-tags" aria-label="已关联的额外项目">
      <span
        v-for="item in selectedOptions.slice(1)"
        :key="item.path"
        class="inline-project-tag"
        :title="`关联项目：${item.label}\n路径：${item.path}\n点击左侧可设为主目录`"
      >
        <button type="button" class="inline-tag-label" :disabled="disabled" @click="makePrimary(item.path)">
          {{ item.label }}
        </button>
        <button v-if="!disabled" type="button" class="inline-tag-remove" :aria-label="`移除 ${item.label}`" @click="removeWorkspace(item.path)">
          <X :size="11" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.workspace-selector-wrap {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.context-chip.workspace-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 11px;
  border: 1px solid var(--agent-border, var(--ui-border, #dcdfe6));
  border-radius: 8px;
  background: var(--agent-panel, var(--ui-surface, #fff));
  color: var(--agent-secondary, var(--ui-secondary, #595c66));
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.context-chip.workspace-chip:hover:not(:disabled) {
  border-color: var(--agent-accent, var(--ui-accent, #5a4ee1));
  color: var(--agent-text, var(--ui-text, #24252b));
}
.context-chip.workspace-chip.has-selection {
  border-color: color-mix(in srgb, var(--agent-accent, var(--ui-accent, #5a4ee1)) 48%, var(--agent-border, #dcdfe6));
  background: color-mix(in srgb, var(--agent-accent, var(--ui-accent, #5a4ee1)) 12%, var(--agent-panel, #fff));
  color: var(--agent-text, var(--ui-text, #24252b));
}
.context-chip.workspace-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.chip-icon {
  flex-shrink: 0;
  color: var(--agent-muted, var(--ui-muted, #6f717b));
}
.chip-icon.active {
  color: var(--agent-accent, var(--ui-accent, #5a4ee1));
}
.chip-label {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--agent-accent, var(--ui-accent, #5a4ee1));
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.35;
}
.chip-arrow {
  flex-shrink: 0;
  color: var(--agent-muted, var(--ui-muted, #6f717b));
  transition: transform 0.15s ease;
}
.chip-arrow.open {
  transform: rotate(180deg);
}

.inline-selected-tags {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.inline-project-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--agent-border, var(--ui-border, #dcdfe6));
  border-radius: 6px;
  background: var(--agent-panel-strong, var(--ui-raised, #f4f5f8));
  color: var(--agent-secondary, var(--ui-secondary, #595c66));
  font-size: 11px;
}
.inline-tag-label {
  max-width: 130px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.inline-tag-label:hover:not(:disabled) {
  color: var(--agent-accent, var(--ui-accent, #5a4ee1));
}
.inline-tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--agent-muted, var(--ui-muted, #6f717b));
  cursor: pointer;
}
.inline-tag-remove:hover {
  background: color-mix(in srgb, var(--ui-danger, #ef4444) 15%, transparent);
  color: var(--ui-danger, #ef4444);
}

/* Popover interior */
.workspace-menu {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--ui-text, #24252b);
}
.workspace-menu-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 2px 0;
}
.workspace-menu-head strong {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ui-text, #24252b);
}
.workspace-menu-head small {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--ui-muted, #6f717b);
}
.clear-btn {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid var(--ui-border, #e2e3e9);
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary, #595c66);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.clear-btn:hover {
  border-color: var(--ui-danger, #ef4444);
  color: var(--ui-danger, #ef4444);
}

.workspace-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 11px;
  border: 1px solid var(--ui-border, #e2e3e9);
  border-radius: 8px;
  background: var(--ui-raised, #f7f7f9);
  color: var(--ui-muted, #6f717b);
  transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
}
.workspace-search:focus-within {
  border-color: var(--ui-accent, #5a4ee1);
  background: var(--ui-surface, #fff);
  box-shadow: 0 0 0 3px var(--ui-accent-soft, #efedff);
}
.workspace-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ui-text, #24252b);
  font-size: 12.5px;
}
.workspace-search input::placeholder {
  color: var(--ui-muted, #6f717b);
}
.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--ui-hover, #ebedf2);
  color: var(--ui-secondary, #595c66);
  cursor: pointer;
}

.selected-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--ui-border, #e2e3e9);
  border-radius: 8px;
  background: var(--ui-raised, #f7f7f9);
  max-height: 86px;
  overflow-y: auto;
}
.selected-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid var(--ui-border, #e2e3e9);
  background: var(--ui-surface, #fff);
  color: var(--ui-text, #24252b);
  font-size: 11.5px;
  line-height: 1.4;
}
.selected-pill.primary {
  border-color: color-mix(in srgb, var(--ui-accent, #5a4ee1) 45%, transparent);
  background: var(--ui-accent-soft, #efedff);
}
.selected-pill em {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--ui-accent, #5a4ee1);
  color: #fff;
  font-style: normal;
  font-size: 10px;
  font-weight: 600;
}
.pill-promote {
  padding: 0 4px;
  border: 1px solid var(--ui-border, #e2e3e9);
  border-radius: 4px;
  background: var(--ui-raised, #f7f7f9);
  color: var(--ui-muted, #6f717b);
  font-size: 10px;
  cursor: pointer;
}
.pill-promote:hover {
  border-color: var(--ui-accent, #5a4ee1);
  color: var(--ui-accent, #5a4ee1);
}
.pill-remove {
  display: inline-flex;
  align-items: center;
  padding: 1px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--ui-muted, #6f717b);
  cursor: pointer;
}
.pill-remove:hover {
  color: var(--ui-danger, #ef4444);
}

.workspace-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: min(310px, 38dvh);
  overflow-y: auto;
  padding-right: 2px;
}
.workspace-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-secondary, #595c66);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s, border-color 0.12s, color 0.12s;
}
.workspace-option:hover {
  background: var(--ui-hover, #f2f3f6);
  color: var(--ui-text, #24252b);
}
.workspace-option.active {
  border-color: color-mix(in srgb, var(--ui-accent, #5a4ee1) 35%, transparent);
  background: var(--ui-accent-soft, #efedff);
  color: var(--ui-text, #24252b);
}
.option-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  flex-shrink: 0;
  border: 1.5px solid var(--ui-border, #c8cad4);
  border-radius: 4px;
  background: var(--ui-surface, #fff);
  color: #fff;
  transition: all 0.12s ease;
}
.option-check.checked {
  border-color: var(--ui-accent, #5a4ee1);
  background: var(--ui-accent, #5a4ee1);
}
.option-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ui-muted, #6f717b);
}
.workspace-option.active .option-icon {
  color: var(--ui-accent, #5a4ee1);
}
.option-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.option-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.option-title-row strong {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ui-text, #24252b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.option-folder,
.option-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ui-raised, #f0f1f5);
  color: var(--ui-muted, #6f717b);
  font-size: 10.5px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.option-primary-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ui-accent, #5a4ee1);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}
.option-make-primary {
  padding: 1px 6px;
  border: 1px solid var(--ui-border, #d5d7e0);
  border-radius: 4px;
  background: var(--ui-surface, #fff);
  color: var(--ui-secondary, #595c66);
  font-size: 10px;
  cursor: pointer;
}
.option-make-primary:hover {
  border-color: var(--ui-accent, #5a4ee1);
  color: var(--ui-accent, #5a4ee1);
}
.option-branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-accent, #5a4ee1) 10%, var(--ui-raised, #f2f3f7));
  color: var(--ui-secondary, #595c66);
  font-size: 10.5px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.option-path {
  display: block;
  overflow: hidden;
  color: var(--ui-muted, #6f717b);
  font-size: 11px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-empty {
  margin: 12px 8px;
  color: var(--ui-muted, #6f717b);
  font-size: 12px;
  text-align: center;
}

.workspace-menu-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-divider, #e9e9ee);
}
.choose-folder {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border, #e2e3e9);
  border-radius: 7px;
  background: var(--ui-raised, #f7f7f9);
  color: var(--ui-secondary, #595c66);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
}
.choose-folder:hover {
  border-color: var(--ui-accent, #5a4ee1);
  color: var(--ui-accent, #5a4ee1);
}
.foot-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}
.foot-count {
  color: var(--ui-muted, #6f717b);
  font-size: 11.5px;
}
.done-btn {
  padding: 6px 14px;
  border: 0;
  border-radius: 7px;
  background: var(--ui-accent, #5a4ee1);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s ease;
}
.done-btn:hover {
  opacity: 0.92;
}
</style>

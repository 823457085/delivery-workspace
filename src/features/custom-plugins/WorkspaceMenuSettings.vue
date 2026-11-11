<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { ArrowUp, ArrowDown, GripVertical } from '@lucide/vue';
import { integrationCatalog } from '../../../shared/integration-plugins';
import { menuIconNames, type NavigationPreferences } from '../../../shared/workspace-navigation';
import { navigationPreferencesForSave, registeredWorkspaceSections, type WorkspaceSection } from '../../pages/agent/workspace-navigation';
import { menuIcons, menuIconLabels, workspaceMenuIcons } from '../../shared/menu-icons';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { customPluginsQueryKey, pluginRequest, useCustomPlugins } from './api';
const client = useQueryClient(), custom = useCustomPlugins(), integrations = useIntegrationPlugins();
const opened = ref(false), saving = ref(false), rows = ref<WorkspaceSection[]>([]), selected = ref(''), dragged = ref(''), dropTarget = ref('');
const draft = ref<NavigationPreferences>({ order: [], icons: {} });
const visibleIds = computed(() => new Set(registeredWorkspaceSections(integrations.active.value.map(p => p.id), custom.plugins.value).map(s => s.id)));
const reordered = ref(false);
function iconComponent(id: string) {
  const row = rows.value.find(row => row.id === id);
  return workspaceMenuIcons[draft.value.icons[id] || row?.icon || id] || menuIcons.grid;
}
function open() {
  reordered.value = false;
  draft.value = structuredClone({ order: [...custom.navigation.value.order], icons: { ...custom.navigation.value.icons } });
  rows.value = registeredWorkspaceSections(integrationCatalog.map(p => p.id), custom.plugins.value.map(p => ({ ...p, enabled: true, showInMenu: true, error: undefined })), { ...draft.value, icons: {} });
  selected.value = rows.value[0]?.id || ''; opened.value = true;
}
function move(from: number, to: number) {
  if (saving.value || from < 0 || to < 0 || to >= rows.value.length || from === to) return;
  reordered.value = true;
  const [row] = rows.value.splice(from, 1); rows.value.splice(to, 0, row);
}
function beginDrag(event: PointerEvent, id: string) {
  if (saving.value) return;
  dragged.value = id;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function trackDrag(event: PointerEvent) {
  if (!dragged.value) return;
  dropTarget.value = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-menu-id]')?.dataset.menuId || '';
}
function finishDrag(event: PointerEvent) {
  trackDrag(event);
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  drop(dropTarget.value); dropTarget.value = '';
}
function drop(target: string) { move(rows.value.findIndex(row => row.id === dragged.value), rows.value.findIndex(row => row.id === target)); dragged.value = ''; }
function reset() {
  reordered.value = false;
  draft.value = { order: [], icons: {} };
  rows.value = registeredWorkspaceSections(integrationCatalog.map(p => p.id), custom.plugins.value.map(p => ({ ...p, enabled: true, showInMenu: true, error: undefined })));
}
async function save() {
  saving.value = true;
  try {
    const ids = rows.value.map(row => row.id);
    const result = await pluginRequest('navigation/settings', navigationPreferencesForSave(draft.value, ids, reordered.value));
    client.setQueryData(customPluginsQueryKey, result); opened.value = false; ElMessage.success('菜单设置已保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '菜单保存失败'); }
  finally { saving.value = false; }
}
</script>
<template>
  <el-button :disabled="custom.query.isPending.value || !!custom.query.error.value" @click="open">菜单外观与顺序</el-button>
  <el-dialog v-model="opened" title="菜单外观与顺序" width="min(820px, 94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <p class="menu-help">拖动菜单或使用上下箭头调整顺序，点击菜单选择图标。“会话”固定在首位；未显示的菜单将在启用后按此顺序出现。</p>
    <div class="menu-editor">
      <ol class="menu-order" aria-label="菜单顺序">
        <li v-for="(row, index) in rows" :key="row.id" :data-menu-id="row.id" :draggable="!saving" :class="{ selected: selected === row.id, dragging: dragged === row.id, 'drop-target': dropTarget === row.id }" @dragstart="dragged = row.id; $event.dataTransfer?.setData('text/plain', row.id)" @dragend="dragged = ''" @dragover.prevent @drop.prevent="drop(row.id)">
          <button class="drag-handle" :disabled="saving" :aria-label="`拖动${row.label}`" @pointerdown.prevent="beginDrag($event, row.id)" @pointermove="trackDrag" @pointerup="finishDrag" @pointercancel="dragged = ''; dropTarget = ''"><GripVertical :size="16" aria-hidden="true" /></button>
          <button class="menu-select" :disabled="saving" :aria-pressed="selected === row.id" :aria-label="`设置${row.label}图标`" @click="selected = row.id"><component :is="iconComponent(row.id)" :size="18" /><span>{{ row.label }}</span><small v-if="!visibleIds.has(row.id)">未显示</small></button>
          <el-button text :disabled="saving || index === 0" :aria-label="`上移${row.label}`" @click="move(index, index - 1)"><ArrowUp :size="16" /></el-button>
          <el-button text :disabled="saving || index === rows.length - 1" :aria-label="`下移${row.label}`" @click="move(index, index + 1)"><ArrowDown :size="16" /></el-button>
        </li>
      </ol>
      <section class="icon-picker" aria-label="选择菜单图标">
        <h3>{{ rows.find(row => row.id === selected)?.label }}的图标</h3>
        <el-button class="default-icon" :disabled="saving || !selected" :aria-pressed="!draft.icons[selected]" @click="delete draft.icons[selected]">使用默认图标</el-button>
        <div class="icon-options">
          <button v-for="name in menuIconNames" :key="name" :disabled="saving || !selected" :aria-label="`${menuIconLabels[name]}图标`" :aria-pressed="draft.icons[selected] === name" @click="draft.icons[selected] = name"><component :is="menuIcons[name]" :size="21" /><span>{{ menuIconLabels[name] }}</span></button>
        </div>
      </section>
    </div>
    <template #footer><div class="menu-footer"><el-button :disabled="saving" @click="reset">恢复默认</el-button><span /><el-button :disabled="saving" @click="opened = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存菜单</el-button></div></template>
  </el-dialog>
</template>
<style scoped>
.menu-help{margin:0 0 18px;color:var(--ui-muted);line-height:1.7;font-size:13px}.menu-editor{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:20px;align-items:start}.menu-order{list-style:none;margin:0;padding:0;max-height:52vh;overflow:auto}.menu-order li{display:flex;gap:4px;align-items:center;padding:7px;border:1px solid var(--ui-border);border-radius:8px;margin-bottom:8px;background:var(--ui-surface)}.menu-order li.selected{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.menu-order li.dragging{opacity:.5}.menu-order li.drop-target{border-top:3px solid var(--ui-accent)}.drag-handle{display:grid;place-items:center;padding:0;border:0;background:transparent;flex-shrink:0;cursor:grab;color:var(--ui-muted);touch-action:none}.menu-select{display:flex;align-items:center;gap:8px;min-width:0;flex:1;background:transparent;border:0;text-align:left;color:var(--ui-text);cursor:pointer;font:inherit;font-size:13px;padding:5px}.menu-select svg{flex-shrink:0;color:var(--ui-accent)}.menu-select span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.menu-select small{white-space:nowrap;color:var(--ui-muted);font-size:11px}.menu-order :deep(.el-button){margin:0;padding:6px;min-height:28px}.icon-picker h3{font-size:14px;margin:0 0 12px}.default-icon{margin-bottom:12px}.icon-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.icon-options button{display:flex;align-items:center;flex-direction:column;gap:7px;padding:12px 4px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--ui-secondary);cursor:pointer;font:inherit;font-size:12px}.icon-options button[aria-pressed=true]{color:var(--ui-accent);background:var(--ui-accent-soft);border-color:var(--ui-accent)}button:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.menu-footer{display:flex;gap:8px}.menu-footer span{flex:1}.menu-footer :deep(.el-button){margin:0}@media(max-width:650px){.menu-editor{grid-template-columns:1fr;max-height:65vh;overflow:auto}.menu-order{max-height:30vh}.icon-options{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>

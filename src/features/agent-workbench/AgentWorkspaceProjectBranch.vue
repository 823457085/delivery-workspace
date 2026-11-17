<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { GitBranch, Plus, RotateCw, X } from '@lucide/vue';
import type { AgentWorkspaceBranches } from '../../../shared/agent-runtime';
const props = defineProps<{ path: string; disabled?: boolean }>();
const selected = defineModel<string[]>({default:()=>[]});
const state = ref<AgentWorkspaceBranches>();
const loading = ref(false), error = ref('');
const open = ref(false), query = ref(''), dragging = ref(''), over = ref('');
const candidates = computed(() => (state.value?.branches || []).filter(branch => branch.toLowerCase().includes(query.value.trim().toLowerCase())));
function add(branch: string) {
  if (props.disabled || selected.value.length >= 8 || selected.value.includes(branch)) return;
  selected.value = [...selected.value, branch];
}
function remove(branch: string) {
  if (!props.disabled) selected.value = selected.value.filter(item => item !== branch);
}
function move(source: string, target: string) {
  if (props.disabled || source === target || !selected.value.includes(source) || !selected.value.includes(target)) return;
  const next = selected.value.filter(item => item !== source);
  next.splice(selected.value.indexOf(target), 0, source);
  selected.value = next;
}
let pointer: {id:number; branch:string; x:number; y:number; element:HTMLElement} | undefined;
function startDrag(event: PointerEvent, branch: string) {
  if (props.disabled || event.button !== 0) return;
  const element = event.currentTarget as HTMLElement;
  pointer = {id:event.pointerId,branch,x:event.clientX,y:event.clientY,element};
  element.setPointerCapture(event.pointerId);
}
function dragOver(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId || props.disabled) return;
  if (!dragging.value && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<4) return;
  dragging.value = pointer.branch;
  const target = document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-branch]');
  over.value = target && pointer.element.parentElement?.contains(target) ? target.dataset.branch || '' : '';
}
function endDrag() {
  if (pointer?.element.hasPointerCapture(pointer.id)) pointer.element.releasePointerCapture(pointer.id);
  pointer = undefined; dragging.value = ''; over.value = '';
}
function drop(event: PointerEvent) {
  if (pointer?.id !== event.pointerId) return;
  move(dragging.value,over.value); endDrag();
}
function reorderKey(event: KeyboardEvent, branch: string) {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const target = selected.value[selected.value.indexOf(branch) + (event.key === 'ArrowLeft' ? -1 : 1)];
  if (target) move(branch, target);
}
watch(open, value => { if (value) query.value = ''; });
let request = 0;
let controller: AbortController | undefined;
async function refresh() {
  const version = ++request;
  controller?.abort();
  controller = new AbortController();
  loading.value = true; error.value = '';
  try {
    const response = await fetch(`/api/agent-runtimes/branches?${new URLSearchParams({workspacePath: props.path})}`, {signal: controller.signal});
    const result = await response.json();
    if (version !== request) return;
    if (!response.ok) throw new Error(result.message || '分支读取失败');
    state.value = result;
  } catch (e) {
    if (version === request) { state.value = undefined; error.value = e instanceof Error ? e.message : '分支读取失败'; }
  } finally { if (version === request) loading.value = false; }
}
watch(() => props.path, (_path, _old, cleanup) => {
  state.value = undefined; open.value = false; endDrag();
  void refresh();
  cleanup(() => { request++; controller?.abort(); endDrag(); });
}, {immediate:true});
</script>
<template>
  <div class="project-branch-control" @click.stop>
    <div class="branch-tags" aria-label="项目分支标签">
      <span v-for="(branch,index) in selected" :key="branch" class="branch-tag" :class="{primary:!index,'drag-over':over===branch&&dragging!==branch,dragging:dragging===branch}"
        :data-branch="branch" :tabindex="disabled ? -1 : 0" :title="`${branch}${!index ? ' · 默认主分支' : ''}；拖动排序，或按 Alt + 左右方向键`"
        :aria-label="`${branch}${!index ? '，默认主分支' : ''}，可拖动排序`"
        @pointerdown.stop="startDrag($event,branch)" @pointermove="dragOver" @pointerup="drop" @pointercancel="endDrag" @lostpointercapture="endDrag" @keydown.esc="endDrag" @keydown="reorderKey($event,branch)">
        <GitBranch :size="11"/><b v-if="!index" aria-hidden="true">*</b><span class="branch-name">{{branch}}</span>
        <button type="button" :aria-label="`移除分支 ${branch}`" :disabled="disabled" @click.stop="remove(branch)" @pointerdown.stop><X :size="11"/></button>
      </span>
      <el-popover v-model:visible="open" trigger="click" placement="bottom-start" :width="300" :disabled="disabled">
        <template #reference><button type="button" class="branch-add" :aria-label="`添加分支 ${path}`" title="添加分支" :disabled="disabled"><Plus :size="13"/></button></template>
        <div class="branch-picker">
          <div class="branch-picker-heading"><strong>选择分支</strong><small>{{selected.length}} / 8</small><button type="button" :aria-label="`刷新项目分支 ${path}`" :disabled="disabled||loading" @click="refresh"><RotateCw :size="13"/></button></div>
          <el-input v-model="query" placeholder="搜索分支" aria-label="搜索分支" clearable/>
          <div class="branch-options">
            <p v-if="loading">读取分支…</p>
            <p v-else-if="error" role="alert">{{error}}</p>
            <template v-else>
              <button v-for="branch in candidates" :key="branch" type="button" :disabled="disabled||selected.includes(branch)||selected.length>=8" @click="add(branch)"><GitBranch :size="12"/><span>{{branch}}</span><small v-if="selected.includes(branch)">已添加</small></button>
              <p v-if="!candidates.length">{{query ? '没有匹配分支' : '暂无可选分支'}}</p>
            </template>
          </div>
          <small>首个标签 * 为默认主分支，拖动标签可调整顺序。</small>
        </div>
      </el-popover>
      <small v-if="!selected.length" class="branch-empty">{{state?.current ? `使用当前目录（${state.current}）` : '使用当前目录'}}</small>
    </div>
    <small v-if="error&&!open" class="branch-error" role="alert">{{error}}</small>
  </div>
</template>
<style scoped>
.project-branch-control{min-width:0;color:var(--ui-muted);font-size:12px}.branch-tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.branch-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-height:24px;padding:2px 5px 2px 7px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-surface);color:var(--ui-text);cursor:grab;touch-action:none;user-select:none}.branch-tag.dragging{opacity:.55;cursor:grabbing}.branch-tag.primary{background:var(--ui-accent-soft);color:var(--ui-accent);border-color:color-mix(in srgb,var(--ui-accent) 30%,var(--ui-border))}.branch-tag.drag-over{box-shadow:-3px 0 0 var(--ui-accent)}.branch-tag:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.branch-tag svg,.branch-tag b{flex:none}.branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.branch-tag button,.branch-add,.branch-picker button{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--ui-muted);background:transparent;border:0;padding:3px;cursor:pointer}.branch-tag button:hover{color:var(--ui-danger,#dc2626)}.branch-add{width:25px;height:25px;border:1px dashed var(--ui-border);border-radius:5px;color:var(--ui-accent)}.branch-add:hover{background:var(--ui-accent-soft);border-color:var(--ui-accent)}.branch-empty,.branch-error{font-size:11px;overflow-wrap:anywhere}.branch-picker{display:grid;gap:8px;color:var(--ui-text);font-size:12px}.branch-picker-heading{display:flex;align-items:center;gap:8px}.branch-picker-heading strong{flex:1}.branch-picker small{font-size:11px;color:var(--ui-muted)}.branch-options{max-height:220px;overflow:auto}.branch-options button{width:100%;justify-content:flex-start;text-align:left;gap:6px;padding:7px;border-radius:5px;color:var(--ui-text)}.branch-options button span{flex:1;min-width:0;overflow-wrap:anywhere}.branch-options button:hover:enabled{background:var(--ui-accent-soft)}.branch-options p{margin:8px 0;color:var(--ui-muted);overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}
</style>

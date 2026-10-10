<script setup lang="ts">
import { Search, GitBranch, ChevronRight, Circle } from '@lucide/vue';
import type { Requirement } from '../../../shared/types';
import { sourceStatusLabel } from './useDelivery';
defineProps<{ items: Requirement[]; selectedId?: string; total: number }>();
defineEmits<{ select: [id: string] }>();
const search = defineModel<string>('search', { required: true });
</script>

<template>
  <aside class="requirement-panel">
    <div class="panel-heading"><h2>需求快照</h2><span class="count">{{ total }}</span></div>
    <label class="search-box"><Search :size="16" /><input v-model="search" aria-label="搜索需求" placeholder="搜索需求、Jira 编号…" /></label>
    <div class="list-caption">来自 JiraTaskCalendar <span>只读</span></div>
    <div class="requirement-list">
      <button v-for="item in items" :key="item.id" class="requirement-item" :class="{ selected: item.id === selectedId }" :aria-pressed="item.id === selectedId" @click="$emit('select', item.id)">
        <span class="item-top"><span class="mono">{{ item.id }}</span><span class="source-status" :class="item.sourceStatus.toLowerCase()"><Circle :size="6" fill="currentColor" />{{ sourceStatusLabel(item.sourceStatus) }}</span></span>
        <strong>{{ item.title }}</strong>
        <span class="item-bottom"><span><GitBranch :size="13" />{{ item.jiraKey }}</span><ChevronRight :size="15" /></span>
      </button>
      <p v-if="!items.length" class="empty small">没有匹配的需求</p>
    </div>
    <div class="list-footer"><span class="live-dot"></span>选择需求，创建独立演示运行</div>
  </aside>
</template>

<style scoped>
.requirement-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;display:flex;flex-direction:column;min-height:620px;max-height:calc(100vh - 250px);overflow:hidden}
.panel-heading{display:flex;align-items:center;gap:9px;padding:21px 19px 15px}.panel-heading h2{font-size:16px;margin:0}.count{font-size:12px;color:var(--muted);background:var(--ui-raised);padding:2px 7px;border-radius:5px}
.search-box{display:flex;align-items:center;gap:8px;margin:0 15px;border:1px solid var(--line);border-radius:8px;padding:9px 10px;color:var(--muted)}.search-box input{width:100%;border:0;outline:0;background:transparent;font-size:13px;min-width:0}
.list-caption{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;padding:14px 19px 10px}.list-caption span{color:var(--ui-muted)}
.requirement-list{overflow:auto;flex:1;padding:0 8px 8px}.requirement-item{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:9px;background:transparent;padding:13px 12px;margin:3px 0;cursor:pointer;color:var(--text);transition:background .15s}
.requirement-item:hover{background:var(--ui-accent-soft)}.requirement-item.selected{background:var(--ui-success-bg);border-color:var(--ui-border);box-shadow:inset 3px 0 var(--accent)}.item-top,.item-bottom{display:flex;justify-content:space-between;align-items:center}.item-top{font-size:12px;color:var(--muted);gap:5px}.source-status{display:inline-flex;align-items:center;gap:4px;font-size:11px}.source-status.blocked{color:var(--ui-warning)}.source-status.awaiting_review{color:var(--ui-warning)}.source-status.approved{color:var(--accent)}
.requirement-item strong{font-size:14px;line-height:1.65;display:block;margin:8px 0 10px;font-weight:550}.item-bottom{font-size:12px;color:var(--ui-muted)}.item-bottom span{display:flex;align-items:center;gap:5px}.selected .item-bottom{color:var(--accent)}.list-footer{padding:13px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;display:flex;align-items:center;gap:7px}
@media(max-width:1000px){.requirement-panel{max-height:400px;min-height:300px}}
</style>

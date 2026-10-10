<script setup lang="ts">
/** 模块与页面只负责导航和人工确认进度展示，不参与接口状态推断。 */
import { computed } from 'vue';
import { reviewLabel, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';

const props = defineProps<{ items: ReviewCatalogItem[]; records: ApexBffReviewState; available: boolean }>();
const module = defineModel<string>('module', { default: '' });
const page = defineModel<string>('page', { default: '' });
const groups = computed(() => {
  const grouped = new Map<string, { total: number; confirmed: number; pages: Map<string, { total: number; confirmed: number }> }>();
  for (const item of props.items) {
    const entry = grouped.get(item.ui.module) ?? { total: 0, confirmed: 0, pages: new Map() };
    const pageEntry = entry.pages.get(item.ui.page) ?? { total: 0, confirmed: 0 };
    entry.total += 1;
    pageEntry.total += 1;
    if (reviewLabel(props.records[item.id]) === '已联调') { entry.confirmed += 1; pageEntry.confirmed += 1; }
    entry.pages.set(item.ui.page, pageEntry);
    grouped.set(item.ui.module, entry);
  }
  return [...grouped].map(([name, value]) => ({ name, ...value, pages: [...value.pages].map(([pageName, count]) => ({ name: pageName, ...count })) }));
});
const totalConfirmed = computed(() => groups.value.reduce((sum, group) => sum + group.confirmed, 0));
function selectModule(name: string) { module.value = name; page.value = ''; }
</script>

<template>
  <aside class="surface review-navigation" aria-label="接口模块与页面">
    <div class="navigation-title"><strong>模块 / 页面</strong><small>已联调 / 接口</small></div>
    <button type="button" class="module-item" :class="{ active: !module }" @click="selectModule('')">
      <span>全部模块</span><small>{{ available ? totalConfirmed : '—' }}/{{ items.length }}</small>
    </button>
    <template v-for="group in groups" :key="group.name">
      <button type="button" class="module-item" :class="{ active: module === group.name }" @click="selectModule(group.name)">
        <span>{{ group.name }}</span><small>{{ available ? group.confirmed : '—' }}/{{ group.total }}</small>
      </button>
      <div v-if="module === group.name" class="page-list" aria-label="当前模块页面">
        <button type="button" :class="{ active: !page }" @click="page = ''">全部页面 <small>{{ group.total }}</small></button>
        <button v-for="item in group.pages" :key="item.name" type="button" :class="{ active: page === item.name }" @click="page = item.name">
          <span>{{ item.name }}</span><small>{{ available ? item.confirmed : '—' }}/{{ item.total }}</small>
        </button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.review-navigation{align-self:start;max-height:calc(100vh - 112px);overflow:auto;padding:10px 0}
.navigation-title{display:flex;justify-content:space-between;gap:8px;padding:9px 16px 13px;border-bottom:1px solid var(--ui-border)}
.navigation-title strong{font-size:13px}.navigation-title small,.module-item small,.page-list small{color:var(--ui-muted);font-size:11px;white-space:nowrap}
.module-item,.page-list button{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;width:100%;border:0;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer}
.module-item{padding:10px 16px;font-size:12px}.module-item:hover,.page-list button:hover{background:var(--ui-hover)}
.module-item.active{background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}
.page-list{padding:4px 0 8px 14px;border-bottom:1px solid var(--ui-border)}
.page-list button{padding:7px 12px 7px 16px;font-size:11px;line-height:1.5}
.page-list button.active{color:var(--ui-accent);font-weight:600;box-shadow:inset 2px 0 var(--ui-accent)}
.page-list button span{min-width:0;overflow-wrap:anywhere}
@media(max-width:1050px){.review-navigation{max-height:260px}}
</style>

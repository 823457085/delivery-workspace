<script setup lang="ts">
import { computed } from 'vue';
import { pluginReferences, type PluginResource } from '../../../shared/custom-plugins';
const props = defineProps<{ source: string; snapshot?: string }>();
const references = computed(() => pluginReferences(props.source));
const snapshots = computed<PluginResource[]>(() => {
  const marker = '<!-- delivery-plugin-context:v1 -->\n', index = props.snapshot?.lastIndexOf(marker) ?? -1;
  if (index < 0) return [];
  try { const items = JSON.parse(props.snapshot!.slice(index + marker.length)); return Array.isArray(items) ? items.filter(item => typeof item.reference === 'string' && references.value.includes(item.reference)) : []; } catch { return []; }
});
function contentFields(content: string | undefined) { try { return Object.entries(JSON.parse(content || '{}')); } catch { return [['内容', content || '']]; } }
function href(reference: string) { const [plugin, , id] = reference.slice(7).split('/'); return `/agent?view=plugins&plugin=${encodeURIComponent(plugin)}&record=${encodeURIComponent(id)}`; }
</script>
<template>
  <details v-if="references.length" class="plugin-history"><summary>引用的插件事项（{{ references.length }}）</summary><div v-for="reference in references" :key="reference"><a :href="href(reference)">{{ snapshots.find(s => s.reference === reference)?.title || reference }}</a><template v-if="snapshots.some(s => s.reference === reference)"><p>发送时快照 · {{ snapshots.find(s => s.reference === reference)?.updatedAt }}</p><dl><template v-for="[label, value] in contentFields(snapshots.find(s => s.reference === reference)?.content)" :key="String(label)"><dt>{{ label }}</dt><dd>{{ value || '—' }}</dd></template></dl></template><p v-else>此消息没有可用快照；原事项可能已停用或删除。</p></div></details>
</template>
<style scoped>.plugin-history{margin-top:10px;padding:10px;border:1px solid var(--ui-border);border-radius:8px}.plugin-history a{color:var(--ui-accent)}.plugin-history p{font-size:12px;color:var(--ui-muted)}dl{max-height:300px;overflow:auto}dt{font-weight:600}dd{margin:4px 0 10px;white-space:pre-wrap;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}</style>

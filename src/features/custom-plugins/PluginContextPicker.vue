<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { pluginReferences, type PluginResource, type CustomPluginInfo } from '../../../shared/custom-plugins';
import { pluginRequest } from './api';
const props = defineProps<{ disabled?: boolean }>(), draft = defineModel<string>({ default: '' });
const open = ref(false), query = ref(''), provider = ref(''), busy = ref(false);
const providers = ref<CustomPluginInfo[]>([]), resources = ref<PluginResource[]>([]), preview = ref<PluginResource>();
const titles = ref<Record<string, string>>({}), references = computed(() => pluginReferences(draft.value));
watch(references, (items, _old, cleanup) => {
  const controller = new AbortController(); cleanup(() => controller.abort());
  for (const reference of items.slice(0, 10).filter(item => !titles.value[item])) {
    void pluginRequest<PluginResource>(`resource?reference=${encodeURIComponent(reference)}`, undefined, controller.signal)
      .then(item => { if (!controller.signal.aborted) titles.value[reference] = item.title; })
      .catch(() => { if (!controller.signal.aborted) titles.value[reference] = '事项暂不可用，点击核对'; });
  }
}, { immediate: true });
const previewFields = computed(() => { try { return Object.entries(JSON.parse(preview.value?.content || '{}')); } catch { return [['内容', preview.value?.content || '']]; } });
watch([open, query, provider], async ([visible], _old, cleanup) => {
  if (!visible) return;
  const controller = new AbortController(); cleanup(() => controller.abort()); busy.value = true;
  try {
    const [list, result] = await Promise.all([pluginRequest('', undefined, controller.signal), pluginRequest(`resources?${new URLSearchParams({ q: query.value, provider: provider.value })}`, undefined, controller.signal)]);
    if (controller.signal.aborted) return;
    providers.value = list.plugins.filter((p: CustomPluginInfo) => p.enabled && p.grants.includes('conversation.context'));
    resources.value = result.resources;
    if (result.warnings.length) ElMessage.warning(result.warnings.join('；'));
    for (const resource of result.resources) titles.value[resource.reference] = resource.title;
  } catch (e) { if (!controller.signal.aborted) ElMessage.error(e instanceof Error ? e.message : '插件资源读取失败'); }
  finally { if (!controller.signal.aborted) busy.value = false; }
});
async function inspect(reference: string) {
  open.value = true; preview.value = undefined;
  try { preview.value = await pluginRequest(`resource?reference=${encodeURIComponent(reference)}`); titles.value[reference] = preview.value!.title; }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '资源不可用'); }
}
function cite(resource: PluginResource) {
  if (references.value.includes(resource.reference)) return;
  if (references.value.length >= 10) { ElMessage.warning('每条消息最多选择 10 个插件事项'); return; }
  titles.value[resource.reference] = resource.title;
  draft.value = `${draft.value}${draft.value && !/\s$/.test(draft.value) ? ' ' : ''}@${resource.reference} `;
}
function remove(reference: string) { draft.value = draft.value.replaceAll('@' + reference, '').replaceAll(reference, ''); }
</script>
<template>
  <div class="plugin-context">
    <el-button size="small" text :disabled="disabled" @click="preview = undefined; open = true">插件事项</el-button>
    <div v-if="references.length" class="resource-chips" aria-label="已选择插件事项"><el-tag v-for="reference in references" :key="reference" :closable="!disabled" @close="remove(reference)" @click="inspect(reference)">{{ titles[reference] || reference }}</el-tag></div>
    <el-dialog v-model="open" title="选择插件事项作为会话上下文" width="min(850px, 95vw)" append-to-body>
      <p>选择时可预览；发送时重新读取最新内容并保存快照。事项内容不会自动授权执行。</p>
      <div class="search-row"><el-select v-model="provider" placeholder="全部提供者" clearable><el-option v-for="p in providers" :key="p.manifest.id" :value="p.manifest.id" :label="p.manifest.name" /></el-select><el-input v-model="query" placeholder="搜索待办或其他插件事项" clearable /></div>
      <el-skeleton v-if="busy" :rows="3" animated /><el-empty v-else-if="!resources.length" description="暂无可引用事项，请先添加插件并创建事项" :image-size="50" />
      <div v-for="resource in resources" :key="resource.reference" class="resource-row"><div><strong>{{ resource.title }}</strong><small>{{ providers.find(p => p.manifest.id === resource.pluginId)?.manifest.name || resource.pluginId }} · {{ resource.updatedAt }}</small><p>{{ resource.excerpt }}</p></div><el-button @click="inspect(resource.reference)">预览</el-button><el-button :disabled="disabled || references.includes(resource.reference)" @click="cite(resource)">{{ references.includes(resource.reference) ? '已选择' : '添加引用' }}</el-button></div>
      <section v-if="preview"><h3>{{ preview.title }}</h3><dl><template v-for="[label, value] in previewFields" :key="String(label)"><dt>{{ label }}</dt><dd>{{ value || '—' }}</dd></template></dl><el-button :disabled="disabled || references.includes(preview.reference)" @click="cite(preview)">引用此事项</el-button></section>
      <template #footer><el-button type="primary" @click="open = false">完成选择（{{ references.length }}）</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>.resource-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.resource-chips .el-tag{cursor:pointer;max-width:100%;overflow:hidden}.search-row,.resource-row{display:flex;gap:12px;align-items:center;margin-bottom:16px}.resource-row{padding:12px;border-bottom:1px solid var(--ui-border)}.resource-row>div{min-width:0;flex:1}.resource-row small{display:block;color:var(--ui-muted)}.resource-row p{overflow-wrap:anywhere}dl{max-height:260px;overflow:auto}dt{font-weight:600;margin-top:12px}dd{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;padding:12px;background:var(--ui-hover)}</style>

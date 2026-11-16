<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { BookmarkPlus, Check } from '@lucide/vue';
import { useCustomPlugins } from './api';
import PluginRecordSaveDialog from './PluginRecordSaveDialog.vue';

const props = defineProps<{
  title?: string;
  content: string;
}>();

const router = useRouter();
const custom = useCustomPlugins();
const dialogOpen = ref(false);
const savedTarget = ref<{ pluginId: string; pluginName: string; recordId: string }>();

const hasWritablePlugin = computed(() => custom.plugins.value.some(plugin =>
  plugin.enabled && !plugin.error && plugin.grants.includes(plugin.manifest.records.storage === 'private' ? 'storage.write' : 'workspace.todos.write')));

const initialValues = computed(() => {
  const headingMatch = props.content.match(/^#{1,3}\s+(.+)$/m);
  const rawTitle = (headingMatch?.[1] || props.title || '').replace(/[`*_#]/g, '').trim().split('\n')[0] || '会话结论沉淀';
  return {
    title: rawTitle.slice(0, 160),
    details: props.content.trim().slice(0, 7800),
  };
});

function handleClick() {
  if (savedTarget.value) {
    void router.push({
      path: '/agent',
      query: { view: 'plugins', plugin: savedTarget.value.pluginId, record: savedTarget.value.recordId },
    });
    return;
  }
  dialogOpen.value = true;
}
</script>

<template>
  <button
    v-if="hasWritablePlugin && content.trim()"
    type="button"
    class="plugin-quick-save"
    :title="savedTarget ? `已沉淀至「${savedTarget.pluginName}」，点击查看` : '将本轮结论核对后写入自定义插件台账'"
    @click="handleClick"
  >
    <Check v-if="savedTarget" :size="12" />
    <BookmarkPlus v-else :size="12" />
    <span>{{ savedTarget ? `已存台账` : '沉淀台账' }}</span>
  </button>
  <PluginRecordSaveDialog
    v-if="dialogOpen"
    v-model="dialogOpen"
    :initial-values="initialValues"
    heading="沉淀会话结果到插件台账"
    @saved="savedTarget = $event"
  />
</template>

<style scoped>
.plugin-quick-save {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--agent-border, var(--ui-border));
  border-radius: 5px;
  background: transparent;
  color: var(--agent-muted, var(--ui-muted));
  font: 500 11px/1.4 var(--sans);
  cursor: pointer;
  transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
}
.plugin-quick-save:hover {
  color: var(--ui-accent);
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
}
</style>

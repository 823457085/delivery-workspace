<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CheckCircle2, FilePlus2, ArrowUpRight } from '@lucide/vue';
import { parsePluginRecordProposal } from '../../../shared/custom-plugins';
import PluginRecordSaveDialog from './PluginRecordSaveDialog.vue';

const props = defineProps<{ source: string }>();
const router = useRouter();
const dialogOpen = ref(false);
const savedInfo = ref<{ pluginId: string; pluginName: string; recordId: string; title: string }>();

const proposal = computed(() => parsePluginRecordProposal(props.source));
const entries = computed(() => Object.entries(proposal.value?.values || {}).slice(0, 12));

function openSaved() {
  if (!savedInfo.value) return;
  void router.push({
    path: '/agent',
    query: { view: 'plugins', plugin: savedInfo.value.pluginId, record: savedInfo.value.recordId },
  });
}
</script>

<template>
  <section class="plugin-proposal-card" aria-label="插件台账写入建议">
    <header class="proposal-header">
      <div class="proposal-title">
        <strong>插件台账草稿建议</strong>
        <small>{{ proposal?.recordId ? '建议更新已有事项' : '建议新增事项' }}{{ proposal?.pluginId ? ` · ${proposal.pluginId}` : '' }}</small>
      </div>
      <div v-if="proposal" class="proposal-actions">
        <button v-if="savedInfo" type="button" class="proposal-btn is-saved" @click="openSaved">
          <CheckCircle2 :size="13" />
          <span>已写入「{{ savedInfo.pluginName }}」· 查看</span>
          <ArrowUpRight :size="12" />
        </button>
        <button v-else type="button" class="proposal-btn" @click="dialogOpen = true">
          <FilePlus2 :size="13" />
          <span>核对并写入台账</span>
        </button>
      </div>
    </header>

    <template v-if="proposal">
      <dl class="proposal-fields">
        <div v-for="[key, value] in entries" :key="key">
          <dt>{{ key }}</dt>
          <dd>{{ value.length > 240 ? `${value.slice(0, 240)}…` : value || '—' }}</dd>
        </div>
      </dl>
      <details class="proposal-raw">
        <summary>查看原始建议 JSON</summary>
        <pre><code>{{ source }}</code></pre>
      </details>
      <PluginRecordSaveDialog
        v-model="dialogOpen"
        :initial-plugin-id="proposal.pluginId"
        :initial-record-id="proposal.recordId"
        :initial-values="proposal.values"
        heading="核对并写入插件台账"
        @saved="savedInfo = $event"
      />
    </template>
    <details v-else class="proposal-raw" open>
      <summary>台账建议 JSON 格式未通过校验（未执行写入）</summary>
      <pre><code>{{ source }}</code></pre>
    </details>
  </section>
</template>

<style scoped>
.plugin-proposal-card {
  margin: 10px 0;
  padding: 12px 14px;
  border: 1px solid var(--agent-border, var(--ui-border));
  border-radius: 8px;
  background: var(--agent-panel-strong, var(--ui-surface));
  font-size: 12px;
  line-height: 1.65;
}
.proposal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.proposal-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.proposal-title strong { font-size: 12.5px; color: var(--ui-text); }
.proposal-title small { font-size: 11px; color: var(--agent-muted, var(--ui-muted)); }
.proposal-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--ui-accent);
  border-radius: 6px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 600 11.5px/1 var(--sans);
  cursor: pointer;
}
.proposal-btn:hover { filter: brightness(1.06); }
.proposal-btn.is-saved {
  border-color: var(--ui-success, var(--ui-accent));
  color: var(--ui-success, var(--ui-accent));
  background: transparent;
}
.proposal-fields { margin: 10px 0 6px; display: grid; gap: 5px; }
.proposal-fields > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
.proposal-fields dt { color: var(--agent-muted, var(--ui-muted)); font-family: var(--mono); font-size: 11px; overflow-wrap: anywhere; }
.proposal-fields dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.proposal-raw { margin-top: 8px; color: var(--agent-muted, var(--ui-muted)); font-size: 11px; }
.proposal-raw > summary { cursor: pointer; }
.proposal-raw pre {
  margin: 6px 0 0;
  max-height: 240px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--agent-bg, var(--ui-bg));
  font: 11px/1.6 var(--mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

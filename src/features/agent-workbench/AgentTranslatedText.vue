<script setup lang="ts">
/**
 * 显示译文；翻译开关关闭或原文已是目标语言时不渲染。译文按纯文本/结构化 Markdown 呈现，不使用 v-html。
 * replace 模式包住原文：译文就绪后在原位置替换显示，可切回原文；状态行置于顶部，长消息也能立即看到翻译进度。
 */
import { shallowRef, watch } from 'vue';
import { Languages, RotateCcw } from '@lucide/vue';
import { agentTranslateLanguageLabels } from '../../../shared/agent-translate';
import AgentMarkdown from './AgentMarkdown.vue';
import { agentTranslateSettings, retryAgentTranslation, useAgentTranslation } from './useAgentTranslate';

const props = withDefaults(defineProps<{ source?: string; stable?: boolean; markdown?: boolean; compact?: boolean; replace?: boolean }>(), { stable: true });
const translation = useAgentTranslation(() => props.source, () => props.stable);
const showOriginal = shallowRef(false);
watch(() => [props.source, agentTranslateSettings.target, agentTranslateSettings.enabled], () => { showOriginal.value = false; });
</script>

<template>
  <template v-if="replace">
    <template v-if="translation.visible">
      <div class="translation-bar" :class="{ failed: translation.status === 'failed' }">
        <Languages :size="11" />
        <template v-if="translation.status === 'done'">{{ showOriginal ? '原文' : `译文 · ${agentTranslateLanguageLabels[agentTranslateSettings.target]}` }}
          <button type="button" @click="showOriginal = !showOriginal">{{ showOriginal ? '显示译文' : '显示原文' }}</button></template>
        <template v-else-if="translation.status === 'failed'">{{ translation.error }}
          <button type="button" @click="retryAgentTranslation(translation.source)"><RotateCcw :size="11" />重试</button></template>
        <template v-else>{{ translation.waiting && !stable ? '输出稳定后翻译…' : `正在翻译为${agentTranslateLanguageLabels[agentTranslateSettings.target]}…` }}</template>
      </div>
      <div v-if="translation.status === 'done' && !showOriginal" class="translated" :lang="agentTranslateSettings.target">
        <AgentMarkdown v-if="markdown" :source="translation.text" />
        <p v-else>{{ translation.text }}</p>
      </div>
      <slot v-else />
    </template>
    <slot v-else />
  </template>
  <div v-else-if="translation.visible" class="agent-translation" :class="{ compact, failed: translation.status === 'failed' }" :lang="agentTranslateSettings.target">
    <small v-if="!compact" class="translation-label"><Languages :size="11" />译文 · {{ agentTranslateLanguageLabels[agentTranslateSettings.target] }}</small>
    <template v-if="translation.status === 'done'">
      <AgentMarkdown v-if="markdown" :source="translation.text" />
      <p v-else>{{ translation.text }}</p>
    </template>
    <p v-else-if="translation.status === 'failed'" class="translation-state">{{ translation.error }}
      <button type="button" @click="retryAgentTranslation(translation.source)"><RotateCcw :size="11" />重试</button></p>
    <p v-else class="translation-state">{{ translation.waiting && !stable ? '输出稳定后翻译…' : '翻译中…' }}</p>
  </div>
</template>

<style scoped>
.agent-translation{margin-top:8px;padding:7px 10px;border-left:2px solid color-mix(in srgb,var(--agent-accent) 70%,transparent);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--agent-accent) 7%,transparent);color:inherit}
.agent-translation.compact{margin-top:4px;padding:3px 7px}
.agent-translation.failed{border-left-color:var(--el-color-danger)}
.translation-label{display:flex;align-items:center;gap:4px;margin-bottom:4px;color:var(--agent-muted);font-size:10px}
.agent-translation p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.translation-state{color:var(--agent-muted);font-size:11px}
.translation-state button,.translation-bar button{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 6px;border:1px solid var(--agent-border);border-radius:5px;background:transparent;color:inherit;font-size:10px;cursor:pointer}
.translation-bar{display:flex;align-items:center;gap:4px;margin-bottom:6px;color:var(--agent-muted);font-size:10px}
.translation-bar.failed{color:var(--el-color-danger)}
.translated{color:var(--agent-text)}.translated p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
</style>

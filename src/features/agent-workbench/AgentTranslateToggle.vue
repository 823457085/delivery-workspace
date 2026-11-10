<script setup lang="ts">
/** 会话翻译开关：选择目标语言即开启，标题、消息与右栏记录同步显示译文。 */
import { Check, Languages } from '@lucide/vue';
import { agentTranslateLanguageLabels, agentTranslateLanguages, type AgentTranslateLanguage } from '../../../shared/agent-translate';
import { agentTranslateSettings } from './useAgentTranslate';

function select(command: unknown) {
  if (command === 'off') { agentTranslateSettings.enabled = false; return; }
  agentTranslateSettings.target = command as AgentTranslateLanguage;
  agentTranslateSettings.enabled = true;
}
</script>

<template>
  <el-dropdown trigger="click" popper-class="studio-conversation-menu" @command="select">
    <button type="button" class="translate-toggle" :class="{ active: agentTranslateSettings.enabled }" aria-label="翻译会话内容" title="翻译会话内容">
      <Languages :size="15" /><span v-if="agentTranslateSettings.enabled">{{ agentTranslateLanguageLabels[agentTranslateSettings.target] }}</span>
    </button>
    <template #dropdown><el-dropdown-menu>
      <el-dropdown-item v-for="language in agentTranslateLanguages" :key="language" :command="language">
        <Check v-if="agentTranslateSettings.enabled && agentTranslateSettings.target === language" :size="14" /><span v-else style="width:14px" />翻译为 {{ agentTranslateLanguageLabels[language] }}
      </el-dropdown-item>
      <el-dropdown-item divided command="off" :disabled="!agentTranslateSettings.enabled">关闭翻译</el-dropdown-item>
    </el-dropdown-menu></template>
  </el-dropdown>
</template>

<style scoped>
.translate-toggle{display:flex;align-items:center;gap:4px;height:30px;padding:0 7px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--agent-muted);font-size:10px;cursor:pointer}
.translate-toggle:hover{background:var(--agent-panel-strong);color:var(--agent-text)}
.translate-toggle.active{border-color:color-mix(in srgb,var(--agent-accent) 45%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 12%,var(--agent-panel-strong));color:var(--agent-accent)}
</style>

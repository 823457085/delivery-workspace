<script setup lang="ts">
/**
 * 统一会话各入口的头像与尺寸；图标结构固定，颜色跟随主题，不持有账户或上传状态。
 * 使用一个无状态组件，避免侧栏、普通消息和补充消息各自维护不同的头像样式。
 */
import { Asterisk, UserRound } from '@lucide/vue';
import { computed } from 'vue';
import type { AgentProvider } from '../../../shared/agent-runtime';
import openaiMark from './assets/openai-mark.svg';
import cursorMark from './assets/cursor-mark.svg';
import claudeMark from './assets/claude-mark.svg';
import geminiMark from './assets/gemini-mark.svg';

const props = withDefaults(defineProps<{ user?: boolean; size?: number; provider?: AgentProvider; model?: string }>(), { user: false, size: 32 });
const brands = {
  codex: { label: 'OpenAI / GPT', icon: openaiMark, background: '#171717' },
  cursor: { label: 'Cursor', icon: cursorMark, background: '#14120b' },
  claude: { label: 'Claude', icon: claudeMark, background: '#faf9f5' },
  kiro: { label: 'Kiro', icon: '', background: '#2a2047' },
  antigravity: { label: 'Antigravity', icon: '', background: '#1c2b46' },
  deepseek: { label: 'DeepSeek', icon: '', background: '#263d85' },
  workbuddy: { label: 'WorkBuddy', icon: '', background: '#164569' },
  grok: { label: 'Grok', icon: '', background: '#171717' },
  api: { label: '模型 API', icon: '', background: '#174c47' },
};
const brand = computed(() => {
  if (props.provider === 'antigravity') {
    if (/^gemini(?:-|$)/i.test(props.model || '')) return { label: 'Gemini / Antigravity', icon: geminiMark, background: '#fff' };
    if (/^claude(?:-|$)/i.test(props.model || '')) return { ...brands.claude, label: 'Claude / Antigravity' };
  }
  return props.provider ? brands[props.provider] : undefined;
});
</script>

<template>
  <span class="agent-avatar studio-avatar" :class="{ 'studio-user-avatar': user }" :data-provider="user ? undefined : provider" role="img" :aria-label="user ? '你的头像' : brand ? `${brand.label} 头像` : 'Agent Studio 头像'" :style="{ width: `${size}px`, height: `${size}px`, ...(!user && brand ? { background: brand.background } : {}) }"><img v-if="!user && brand?.icon" class="provider-mark" :src="brand.icon" alt="" aria-hidden="true" /><component v-else :is="user ? UserRound : Asterisk" :size="Math.round(size * .7)" :stroke-width="1.5" /></span>

</template>

<style scoped>
.agent-avatar{display:block;flex-shrink:0;object-fit:cover;object-position:center;border-radius:28%;background:#0b142b}
.provider-mark{width:72%;height:72%;object-fit:contain}
</style>

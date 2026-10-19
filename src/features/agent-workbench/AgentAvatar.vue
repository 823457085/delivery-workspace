<script setup lang="ts">
/**
 * 统一会话各入口的头像与尺寸；图标结构固定，颜色跟随主题，不持有账户或上传状态。
 * 使用一个无状态组件，避免侧栏、普通消息和补充消息各自维护不同的头像样式。
 */
import { Asterisk, UserRound } from '@lucide/vue';

withDefaults(defineProps<{ user?: boolean; size?: number }>(), { user: false, size: 32 });
</script>

<template>
  <span class="agent-avatar studio-avatar" :class="{ 'studio-user-avatar': user }" role="img" :aria-label="user ? '你的头像' : '启元头像'" :style="{ width: `${size}px`, height: `${size}px` }"><component :is="user ? UserRound : Asterisk" :size="Math.round(size * .7)" :stroke-width="1.5" /></span>

</template>

<style scoped>
.agent-avatar{display:block;flex-shrink:0;object-fit:cover;object-position:center;border-radius:28%;background:#0b142b}
</style>

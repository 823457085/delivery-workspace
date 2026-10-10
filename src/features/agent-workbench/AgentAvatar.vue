<script setup lang="ts">
/**
 * 统一会话各入口的头像与尺寸；只负责本地图片展示，不持有账户或上传状态。
 * 使用一个无状态组件，避免侧栏、普通消息和补充消息各自维护不同的图片与裁切样式。
 */
import qiyuanAvatar from './assets/qiyuan-avatar.png';
import userAvatar from './assets/user-avatar.svg';

withDefaults(defineProps<{ user?: boolean; size?: number }>(), { user: false, size: 32 });
</script>

<template>
  <img class="agent-avatar" :src="user ? userAvatar : qiyuanAvatar" :alt="user ? '你的头像' : '启元头像'"
    :width="size" :height="size" :style="{ width: `${size}px`, height: `${size}px` }" decoding="async" draggable="false" />
</template>

<style scoped>
.agent-avatar{display:block;flex-shrink:0;object-fit:cover;object-position:center;border-radius:28%;background:#0b142b}
</style>

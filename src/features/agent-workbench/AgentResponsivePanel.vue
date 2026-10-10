<script setup lang="ts">
/** 两侧面板共用响应式容器：桌面保留网格，手机复用标准 Drawer 的遮罩、焦点管理和关闭行为，不复制业务面板。 */
defineProps<{ mobile: boolean; open: boolean; side: 'left' | 'right'; title: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div v-show="mobile || open" class="responsive-panel" :class="{ mobile }">
    <el-drawer v-if="mobile" :model-value="open" :title="title" :direction="side === 'left' ? 'ltr' : 'rtl'"
      size="min(92vw, 400px)" class="agent-mobile-drawer" @update:model-value="!$event && emit('close')">
      <slot />
    </el-drawer>
    <slot v-else />
  </div>
</template>

<style scoped>
.responsive-panel{min-width:0;min-height:0;overflow:hidden}.responsive-panel.mobile{display:contents}
.responsive-panel :deep(.agent-mobile-drawer){background:var(--agent-panel);color:var(--agent-text);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.responsive-panel :deep(.el-drawer__header){margin:0;padding:10px 16px;color:var(--agent-text);border-bottom:1px solid var(--agent-border)}
.responsive-panel :deep(.el-drawer__close-btn){min-width:44px;min-height:44px;color:var(--agent-text)}
.responsive-panel :deep(.el-drawer__body){padding:0;min-height:0;overflow:hidden}
</style>

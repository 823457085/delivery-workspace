<script setup lang="ts">
defineProps<{ state: 'pending' | 'answered' | 'expired'; changing: string; selected?: boolean }>();
const emit = defineEmits<{ reply: [] }>();
</script>
<template>
  <div v-if="state === 'pending'" class="question-reply"><span>待回答</span><el-button size="small" link :disabled="!!changing" @click="emit('reply')">{{ selected ? '正在回复' : '回复' }}</el-button></div>
  <small v-else class="question-state">{{ state === 'answered' ? '已回答' : '该问题已过期' }}</small>
</template>
<style scoped>
.question-reply{display:flex;align-items:center;gap:12px;margin-top:8px}.question-reply span,.question-state{font-size:12px;color:var(--ui-secondary)}.question-state{display:block;margin-top:8px}
</style>

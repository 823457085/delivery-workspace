<script setup lang="ts">
/** 只编辑暂停消息的文字，附件和运行设置原样保留；暂停及续跑交给容器，不覆盖历史执行记录。 */
import { computed } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
const props = defineProps<{ open: boolean; source?: AgentRun; submitting: boolean }>();
const objective = defineModel<string>({ required: true });
const emit = defineEmits<{ submit: []; close: [] }>();
const canSubmit = computed(() => !!objective.value.trim() || !!props.source?.attachments?.length);
</script>

<template>
  <el-dialog :model-value="open" title="编辑消息" width="min(640px, 92vw)"
    :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting"
    @update:model-value="!$event && emit('close')">
    <p class="edit-description">会话已暂停。保存后沿用原模型、权限和附件继续执行；原消息、已有结果和文件改动保留。</p>
    <el-input v-model="objective" type="textarea" :autosize="{ minRows: 5, maxRows: 14 }" :disabled="submitting"
      aria-label="编辑消息内容" placeholder="修改这条消息的内容" />
    <p v-if="source?.attachments?.length" class="edit-description">保留附件：{{ source.attachments.map(item => item.name).join('、') }}</p>
    <template #footer>
      <el-button :disabled="submitting" @click="emit('close')">暂不继续</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="emit('submit')">保存并继续</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.edit-description{margin:0 0 14px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
.edit-description:last-child{margin-top:12px}
</style>

<script setup lang="ts">
/** 后端部署申报只触发复验，不作为通过依据；表单不接收群聊天或改人工审核。 */
import { computed, shallowRef } from 'vue';
import type { ExecutionIssue, ExecutionRequest } from './execution-plan';
const props = defineProps<{ issues: ExecutionIssue[]; environment: string; busy: boolean }>();
const emit = defineEmits<{ submit: [request: Omit<ExecutionRequest, 'requestId'>] }>();
const issueId = shallowRef('');
const version = shallowRef('');
const candidates = computed(() => props.issues.filter(issue => issue.retest && issue.status !== '已关闭' && !issue.deferredReason));
const selected = computed(() => candidates.value.find(issue => issue.id === issueId.value));
const valid = computed(() => !!selected.value && !!version.value.trim() && !!props.environment && !props.busy);
function submit() {
  if (valid.value) emit('submit', { kind: 'retest', taskId: selected.value?.taskId, issueId: issueId.value, environment: props.environment, version: version.value.trim() });
}
</script>

<template>
  <section class="retest-form surface" aria-label="后端部署后申请回测">
    <div><h3>后端改完后回测</h3><p>群里说“改完”不会自动触发。后端部署后在这里提交，Agent 自动复验原请求、字段和对应页面。</p></div>
    <form class="retest-fields" @submit.prevent="submit">
      <el-select v-model="issueId" placeholder="选择问题" aria-label="回测问题" :disabled="busy"><el-option v-for="issue in candidates" :key="issue.id" :value="issue.id" :label="`${issue.id} · ${issue.summary}`" /></el-select>
      <span class="retest-environment">环境：{{ environment || '未配置' }}</span>
      <el-input v-model="version" maxlength="200" placeholder="部署版本 / Commit" aria-label="部署版本" :disabled="busy" />
      <el-button type="primary" native-type="submit" :disabled="!valid">已部署，申请回测</el-button>
    </form>
    <p v-if="selected" class="retest-baseline">原请求：{{ selected.retest?.request }} · 关联页面：{{ selected.retest?.pages.join('、') }}</p>
  </section>
</template>

<style scoped>
.retest-form{padding:18px 20px;margin-bottom:18px}.retest-form h3{margin:0;font-size:15px}.retest-form p{font-size:12px;line-height:1.7;color:var(--ui-secondary)}
.retest-fields{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.retest-fields :deep(.el-select){width:340px;max-width:100%}.retest-fields :deep(.el-input){width:230px;max-width:100%}
.retest-environment{font-size:13px;white-space:nowrap}.retest-baseline{overflow-wrap:anywhere;margin-bottom:0}
</style>

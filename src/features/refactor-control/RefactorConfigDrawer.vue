<script setup lang="ts">
/** 配置准确的资料来源与实际代码工作区；已有任务保留确认时的配置快照。 */
import { reactive, shallowRef, watch } from 'vue';
import type { RefactorConfig, RefactorDashboard } from '../../../shared/refactor-control';
const open = defineModel<boolean>({ default: false });
const props = defineProps<{ data: RefactorDashboard }>();
const emit = defineEmits<{ save: [config: RefactorConfig, revision: string] }>();
const form = reactive<RefactorConfig>({ sourceRoot: '', workspacePath: '', baseUrl: '', environment: '', assignee: '' });
const saving = shallowRef(false);
watch(open, value => { if (value) { Object.assign(form, props.data.config); saving.value = false; } });
function save() { if (!saving.value) { saving.value = true; emit('save', { ...form }, props.data.revision); } }
defineExpose({ finish() { saving.value = false; } });
</script>
<template>
  <el-drawer v-model="open" title="重构项目配置" size="min(520px, 94vw)" append-to-body :close-on-click-modal="!saving" :show-close="!saving">
    <form class="refactor-config" @submit.prevent="save">
      <label>联调资料目录<input v-model="form.sourceRoot" required placeholder="保存 public/integration-runs 和审核记录的工作台目录" :disabled="saving" /></label>
      <label>实际代码工作区<input v-model="form.workspacePath" required placeholder="与页面监听服务一致的前端工作区" :disabled="saving" /></label>
      <label>真实页面地址<input v-model="form.baseUrl" required type="url" placeholder="http://127.0.0.1:6791" :disabled="saving" /></label>
      <div><label>联调环境<input v-model="form.environment" required placeholder="DEV / PRE" maxlength="80" :disabled="saving" /></label><label>负责人账号<input v-model="form.assignee" required placeholder="Jira / 台账中的账号" maxlength="100" :disabled="saving" /></label></div>
      <p>保存后读取该负责人名下的模块、接口、问题和历史证据。配置变更用于后续任务，已确认的任务保留原执行范围。</p>
      <footer><el-button :disabled="saving" @click="open = false">取消</el-button><el-button type="primary" native-type="submit" :loading="saving">保存并读取</el-button></footer>
    </form>
  </el-drawer>
</template>
<style scoped>
.refactor-config{display:grid;gap:20px;font-family:var(--font,sans-serif)}.refactor-config label{display:grid;gap:9px;color:var(--ui-secondary);font-size:13px}.refactor-config input{box-sizing:border-box;min-width:0;width:100%;height:42px;padding:0 10px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-surface);color:var(--ui-text);font:inherit}.refactor-config>div{display:grid;grid-template-columns:1fr 1fr;gap:14px}.refactor-config p{margin:0;color:var(--ui-muted);font-size:12px;line-height:1.8}.refactor-config footer{display:flex;justify-content:flex-end;gap:8px}.refactor-config input:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}@media(max-width:500px){.refactor-config>div{grid-template-columns:1fr}}
</style>

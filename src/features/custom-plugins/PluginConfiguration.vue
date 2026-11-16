<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { CustomPluginInfo } from '../../../shared/custom-plugins';
import { pluginRequest } from './api';
const props = defineProps<{ plugin: CustomPluginInfo }>();
const visible = ref(false), busy = ref(false), values = ref<Record<string,string>>({}), secrets = ref<Record<string,boolean>>({}), clearSecrets = ref<string[]>([]), revision = ref('');
async function open() {
  busy.value = true;
  try { const data = await pluginRequest(`${props.plugin.manifest.id}/configuration`); values.value = data.values; secrets.value = data.secrets; revision.value = data.revision; clearSecrets.value = []; visible.value = true; }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '配置读取失败'); }
  finally { busy.value = false; }
}
function clear() { values.value = {}; secrets.value = {}; clearSecrets.value = []; revision.value = ''; }
async function save() {
  busy.value = true;
  try { await pluginRequest(`${props.plugin.manifest.id}/configure`, { values: values.value, clearSecrets: clearSecrets.value, revision: revision.value }); visible.value = false; clear(); ElMessage.success('配置已保存，下次插件请求使用新配置'); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '配置保存失败'); }
  finally { busy.value = false; }
}
</script>
<template>
  <el-button :loading="busy" @click="open">配置</el-button>
  <el-dialog v-model="visible" :title="`${plugin.manifest.name} · 配置`" width="min(600px, 92vw)" append-to-body destroy-on-close :close-on-click-modal="false" @closed="clear">
    <p class="configuration-hint">配置保存在本机。密码不回显，留空保留原值；保存后插件会重新连接。</p>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item v-for="field in plugin.manifest.configuration?.fields" :key="field.key" :label="field.label" :required="field.required">
        <el-input v-model="values[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :show-password="field.type === 'password'" :autocomplete="field.type === 'password' ? 'new-password' : 'off'" :maxlength="4000" :disabled="busy || clearSecrets.includes(field.key)" :placeholder="field.type === 'password' && secrets[field.key] ? '已配置，留空保留' : '请输入'" />
        <div v-if="field.description" class="configuration-hint">{{ field.description }}</div>
        <el-checkbox v-if="field.type === 'password' && secrets[field.key] && !field.required" :model-value="clearSecrets.includes(field.key)" :disabled="busy" @change="clearSecrets = $event ? [...clearSecrets, field.key] : clearSecrets.filter(k => k !== field.key)">清除已保存的密码</el-checkbox>
      </el-form-item>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="visible = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存配置</el-button></template>
  </el-dialog>
</template>
<style scoped>.configuration-hint{font-size:13px;color:var(--ui-muted);line-height:1.6;margin-bottom:12px}</style>

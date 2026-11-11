<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { pluginRequest } from './api';
import type { PluginRecord } from '../../../shared/custom-plugins';
import type { JiraField } from '../../../shared/jira-issue';
const props = defineProps<{ pluginId: string; record: PluginRecord & { version: string }; mode: 'jira.link' | 'jira.create' }>();
const open = defineModel<boolean>({ default: false }), emit = defineEmits<{ updated: [] }>();
const busy = ref(false), project = ref(''), type = ref(''), key = ref('');
const projects = ref<{ key: string; name: string }[]>([]), types = ref<{ id: string; name: string }[]>([]), fields = ref<JiraField[]>([]), values = ref<Record<string, any>>({});
const linked = ref<{ key: string; summary: string; url: string }>(), prepared = ref<any>(), outcome = ref<any>();
const previewRows = computed(() => Object.entries(prepared.value?.fields || {}).map(([id, value]) => {
  const field = fields.value.find(f => f.id === id);
  const display = (item: any): string => {
    if (item && typeof item === 'object') return field?.allowedValues?.find(option => String(option.id) === String(item.id))?.name || item.name || item.key || item.accountId || String(item.id || JSON.stringify(item));
    return String(item ?? '');
  };
  return { label: id === 'project' ? '项目' : id === 'issuetype' ? '事项类型' : field?.name || id,
    value: id === 'project' ? projects.value.find(p => p.key === project.value)?.name || project.value : id === 'issuetype' ? types.value.find(t => t.id === type.value)?.name || type.value : Array.isArray(value) ? value.map(display).join('、') : display(value) };
}));
async function run(work: () => Promise<void>) { busy.value = true; try { await work(); } catch (e) { ElMessage.error(e instanceof Error ? e.message : 'Jira 操作失败'); } finally { busy.value = false; } }
watch(open, value => { if (value) { project.value = ''; type.value = ''; key.value = ''; types.value = []; fields.value = []; values.value = {}; linked.value = undefined; prepared.value = undefined; outcome.value = undefined;
  if (props.mode === 'jira.create') void run(async () => { projects.value = (await pluginRequest(`${props.pluginId}/jira-projects`)).projects; });
} });
watch(key, () => { linked.value = undefined; });
async function selectProject() { type.value = ''; fields.value = []; prepared.value = undefined; if (!project.value) return; await run(async () => { types.value = (await pluginRequest(`${props.pluginId}/jira-metadata?project=${encodeURIComponent(project.value)}`)).types; }); }
async function selectType() { prepared.value = undefined; fields.value = []; if (!type.value) return; await run(async () => {
  const result = await pluginRequest(`${props.pluginId}/jira-metadata?${new URLSearchParams({ project: project.value, type: type.value })}`); fields.value = result.fields;
  values.value = Object.fromEntries(fields.value.map(f => [f.id, f.id === 'summary' ? props.record.values.title : f.id === 'description' ? props.record.values.details || '' : f.defaultValue ?? (f.schema?.type === 'array' ? [] : '')]));
}); }
function payloadFields() {
  return Object.fromEntries(fields.value.flatMap(field => {
    let value = values.value[field.id];
    if (value === '' || value === undefined || value === null) return [];
    if (field.schema?.type === 'user' && typeof value === 'string') value = { name: value };
    if (!field.allowedValues?.length && ![undefined,'string','date','datetime','number','boolean','user'].includes(field.schema?.type) && !(field.schema?.type === 'array' && field.schema.items === 'string') && typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new Error(`${field.name} 需要有效 JSON`); }
    }
    return [[field.id, value]];
  }));
}
async function prepare() { await run(async () => { prepared.value = await pluginRequest(`${props.pluginId}/jira-prepare`, { recordId: props.record.id, version: props.record.version, project: project.value, type: type.value, fields: payloadFields() }); }); }
async function commit() { await run(async () => { outcome.value = await pluginRequest(`${props.pluginId}/jira-commit`, { ticketId: prepared.value.ticketId, confirmed: true }); prepared.value = undefined; emit('updated'); if (outcome.value.status === 'done') ElMessage.success('Jira 已创建并回读确认'); }); }
async function find() { await run(async () => { linked.value = await pluginRequest(`${props.pluginId}/jira-find?key=${encodeURIComponent(key.value.trim().toUpperCase())}`); }); }
async function link() { await run(async () => { await pluginRequest(`${props.pluginId}/jira-link`, { recordId: props.record.id, version: props.record.version, key: linked.value!.key, confirmed: true }); emit('updated'); open.value = false; ElMessage.success('已关联现有 Jira 任务，未修改远端内容'); }); }
</script>
<template>
  <el-dialog v-model="open" :title="mode === 'jira.create' ? '创建 Jira 任务' : '关联已有 Jira 任务'" width="min(820px, 95vw)" append-to-body :close-on-click-modal="!busy" :show-close="!busy">
    <p>来源事项：{{ record.values.title }}</p>
    <template v-if="mode === 'jira.link'">
      <el-input v-model="key" placeholder="Jira 任务编号，如 DEMO-123" :disabled="busy" /><el-button :disabled="busy || !key.trim()" @click="find">读取并核对任务</el-button>
      <div v-if="linked"><h3>{{ linked.key }} · {{ linked.summary }}</h3><a :href="linked.url" target="_blank" rel="noopener">打开 Jira</a><p>只建立本地关联，不修改远端任务。</p><el-button type="primary" :disabled="busy" @click="link">确认关联</el-button></div>
    </template>
    <template v-else-if="outcome"><p role="status">{{ outcome.status === 'done' ? '创建成功，已保存关联' : outcome.message || '结果待核对' }}</p><a v-if="outcome.result" :href="outcome.result.url" target="_blank" rel="noopener">{{ outcome.result.key }} · {{ outcome.result.summary }}</a></template>
    <template v-else-if="prepared"><h3>核对即将提交的内容</h3><p>目标：{{ prepared.site }} · 预览 10 分钟内有效</p><el-table :data="previewRows"><el-table-column prop="label" label="字段" width="150" /><el-table-column prop="value" label="即将提交的内容" /></el-table><p>核对标记：{{ prepared.marker }}</p><el-button :disabled="busy" @click="prepared = undefined">返回修改</el-button><el-button type="primary" :loading="busy" @click="commit">确认创建 Jira 任务</el-button></template>
    <el-form v-else label-position="top" :disabled="busy">
      <el-form-item label="Jira 项目"><el-select v-model="project" filterable @change="selectProject"><el-option v-for="p in projects" :key="p.key" :value="p.key" :label="`${p.key} · ${p.name}`" /></el-select></el-form-item>
      <el-form-item label="事项类型"><el-select v-model="type" :disabled="!project" @change="selectType"><el-option v-for="t in types" :key="t.id" :value="t.id" :label="t.name" /></el-select></el-form-item>
      <el-form-item v-for="field in fields" :key="field.id" :label="field.name" :required="field.required">
        <el-select v-if="field.allowedValues?.length" v-model="values[field.id]" :multiple="field.schema?.type === 'array'" value-key="id" filterable clearable><el-option v-for="option in field.allowedValues" :key="String(option.id)" :label="option.name || option.value || option.displayName || String(option.id)" :value="{ id: String(option.id) }" /></el-select>
        <el-select v-else-if="field.schema?.type === 'array' && field.schema.items === 'string'" v-model="values[field.id]" multiple filterable allow-create default-first-option />
        <el-input-number v-else-if="field.schema?.type === 'number'" v-model="values[field.id]" />
        <el-switch v-else-if="field.schema?.type === 'boolean'" v-model="values[field.id]" />
        <el-date-picker v-else-if="field.schema?.type === 'date'" v-model="values[field.id]" type="date" value-format="YYYY-MM-DD" />
        <el-input v-else-if="field.schema?.type === 'datetime'" v-model="values[field.id]" placeholder="日期时间，例如 2026-11-10T09:00:00.000+0800" />
        <el-input v-else v-model="values[field.id]" :type="field.id === 'description' ? 'textarea' : 'text'" :rows="5" :placeholder="field.schema?.type === 'user' ? 'Jira 用户名' : ![undefined,'string'].includes(field.schema?.type) ? '该自定义字段请填写 JSON 值' : ''" />
      </el-form-item>
      <el-button type="primary" :disabled="!type || !fields.length || busy" @click="prepare">预览创建内容</el-button>
    </el-form>
  </el-dialog>
</template>
<style scoped>pre{max-height:45vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ui-hover);padding:16px;border-radius:8px}.el-select{width:100%}a{color:var(--ui-accent)}</style>

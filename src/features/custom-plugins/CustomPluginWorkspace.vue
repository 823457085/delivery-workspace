<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { pluginRequest } from './api';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import type { CustomPluginInfo, PluginRecord } from '../../../shared/custom-plugins';
import PageHeading from '../../shared/ui/PageHeading.vue';
defineProps<{ dedicated?: boolean }>();
import PluginJiraDialog from './PluginJiraDialog.vue';
const integrations = useIntegrationPlugins();
const route = useRoute(), router = useRouter(), workspace = inject(agentWorkspaceContext, undefined);
const plugins = ref<CustomPluginInfo[]>([]), items = ref<(PluginRecord & { version: string })[]>([]), busy = ref(false), query = ref(''), status = ref('');
const id = computed(() => typeof route.query.plugin === 'string' ? route.query.plugin : ''), plugin = computed(() => plugins.value.find(p => p.manifest.id === id.value));
const selected = ref<PluginRecord & { version: string }>(), form = ref<Record<string, string>>({}), editing = ref(false), detail = ref<any>();
const jiraOpen = ref(false), jiraMode = ref<'jira.link' | 'jira.create'>('jira.link');
const writable = computed(() => !!plugin.value?.grants.includes(plugin.value.manifest.records.storage === 'private' ? 'storage.write' : 'workspace.todos.write'));
const statusField = computed(() => plugin.value?.manifest.records.fields.find(f => f.key === 'status' && f.type === 'select'));
const filtered = computed(() => items.value.filter(item => (!status.value || item.values.status === status.value) && Object.values(item.values).join(' ').toLowerCase().includes(query.value.toLowerCase())));
async function run(work: () => Promise<void>) { busy.value = true; try { await work(); } catch (e) { ElMessage.error(e instanceof Error ? e.message : '插件操作失败'); } finally { busy.value = false; } }
async function load() { plugins.value = (await pluginRequest()).plugins; items.value = []; detail.value = undefined; selected.value = undefined; editing.value = false;
  if (plugin.value?.enabled) { items.value = (await pluginRequest(`${id.value}/records`)).items; const record = items.value.find(item => item.id === route.query.record); if (record) await select(record); else if (route.query.record) ElMessage.warning('事项已删除或不存在，历史会话中的快照仍可查看'); }
}
async function select(record: PluginRecord & { version: string }) { selected.value = record; editing.value = true; form.value = { ...record.values }; detail.value = await pluginRequest(`${id.value}/record?id=${record.id}`); }
function add() { selected.value = undefined; detail.value = undefined; form.value = Object.fromEntries((plugin.value?.manifest.records.fields || []).map(field => [field.key, field.default])); editing.value = true; }
async function save() { await run(async () => { const saved = await pluginRequest(`${id.value}/save`, { ...(selected.value ? { id: selected.value.id, expectedVersion: selected.value.version } : {}), values: form.value }); await load(); const item = items.value.find(item => item.id === saved.id); if (item) await select(item); ElMessage.success('事项已保存'); }); }
async function remove() {
  if (!selected.value) return;
  try { await ElMessageBox.confirm('删除该事项？历史会话快照和 Jira 关联记录将保留，远端任务不受影响。', '删除事项', { type: 'warning' }); } catch { return; }
  await run(async () => { await pluginRequest(`${id.value}/delete`, { id: selected.value!.id, expectedVersion: selected.value!.version }); await router.replace({ query: { ...route.query, record: undefined } }); await load(); });
}
async function command(action: string) {
  if (!selected.value) return;
  if (action === 'conversation.context') { await run(async () => { const result = await pluginRequest(`${id.value}/context`, { recordId: selected.value!.id }); workspace?.compose(result.prompt); }); }
  else { jiraMode.value = action as typeof jiraMode.value; jiraOpen.value = true; }
}
function allowed(action: string) { if (action.startsWith('jira.') && !integrations.capability(action === 'jira.create' ? 'issues.write' : 'issues.read')) return false; return !!plugin.value?.grants.includes(action === 'jira.link' ? 'jira.read' : action as any); }
async function updated() { if (selected.value) await run(async () => { detail.value = await pluginRequest(`${id.value}/record?id=${selected.value!.id}`); }); }
watch(id, () => { query.value = ''; status.value = ''; void run(load); });
onMounted(() => run(load));
</script>
<template>
  <div class="plugin-workspace">
    <PageHeading title="功能插件" description="" :loading="busy" @refresh="run(load)"><el-button @click="router.push({ query: { view: 'settings', settingsTab: 'plugins' } })">管理插件</el-button></PageHeading>
    <div v-if="!dedicated" class="toolbar"><el-select :model-value="id" placeholder="选择功能插件" @change="router.push({ query: { view: 'plugins', plugin: $event } })"><el-option v-for="p in plugins" :key="p.manifest.id" :value="p.manifest.id" :label="p.manifest.name + (p.enabled ? '' : '（已停用）')" /></el-select></div>
    <el-skeleton v-if="busy && !plugin" :rows="3" animated />
    <el-empty v-else-if="!plugin || !plugin.enabled" :description="id ? '插件已停用或移除，历史引用快照仍保留在会话中' : '请先在设置中添加插件，再选择要打开的功能'" />
    <template v-else>
      <h2 v-if="!dedicated">{{ plugin.manifest.page.title }}</h2><p>{{ plugin.manifest.description }}</p>
      <div class="toolbar plugin-record-filters"><el-input v-model="query" placeholder="搜索事项" clearable /><el-select v-if="statusField" v-model="status" placeholder="全部状态" clearable><el-option v-for="o in statusField.options" :key="o.value" :label="o.label" :value="o.value" /></el-select><el-button type="primary" :disabled="!writable || busy" @click="add">新增事项</el-button></div>
      <div class="records-layout" :class="{ 'is-editing': editing }">
        <div><el-empty v-if="!filtered.length" description="暂无匹配事项" :image-size="50" /><button v-for="item in filtered" :key="item.id" class="record-row" :class="{ active: selected?.id === item.id }" @click="run(() => select(item))"><strong>{{ item.values.title }}</strong><span>{{ statusField?.options?.find(o => o.value === item.values.status)?.label || '' }}</span><p>{{ item.values.details?.slice(0, 100) }}</p><small>{{ item.updatedAt }}</small></button></div>
        <section v-if="editing" class="record-editor">
          <el-form label-position="top" :disabled="busy || !writable"><el-form-item v-for="field in plugin.manifest.records.fields" :key="field.key" :label="field.label" :required="field.required">
            <el-select v-if="field.type === 'select'" v-model="form[field.key]"><el-option v-for="o in field.options" :key="o.value" :value="o.value" :label="o.label" /></el-select>
            <el-date-picker v-else-if="field.type === 'date'" v-model="form[field.key]" type="date" value-format="YYYY-MM-DD" @clear="form[field.key] = ''" />
            <el-input v-else v-model="form[field.key]" :type="field.type === 'textarea' ? 'textarea' : 'text'" :rows="5" :maxlength="field.maxLength" />
          </el-form-item><el-button type="primary" @click="save">保存事项</el-button><el-button v-if="selected" type="danger" plain @click="remove">删除事项</el-button></el-form>
          <template v-if="selected"><h3>关联操作</h3><p v-if="plugin.manifest.commands.some(c => c.action.startsWith('jira.')) && !integrations.capability('issues.read')">任务提供者未接入或不可用，请在插件管理中启用并配置。</p><p>操作使用已保存的事项内容；编辑后请先保存。</p><div class="toolbar"><el-button v-for="c in plugin.manifest.commands" :key="c.id" :disabled="busy || !allowed(c.action) || (c.action === 'conversation.context' && !workspace)" @click="command(c.action)">{{ c.label }}</el-button></div>
            <h4>关联的 Jira 任务</h4><p v-if="!detail?.links?.length">暂无关联</p><p v-for="link in detail?.links" :key="link.url"><a :href="link.url" target="_blank" rel="noopener">{{ link.key }} · {{ link.summary }}</a></p>
            <p v-for="operation in detail?.operations?.filter((o: any) => ['unknown', 'sending'].includes(o.status))" :key="operation.id" role="status">{{ operation.message || 'Jira 创建正在处理，请勿重复提交' }}</p>
            <h4>会话引用来源</h4><p v-if="!detail?.citations?.length">暂无已保存的会话引用</p><p v-for="citation in detail?.citations" :key="citation.runId"><a :href="citation.url">{{ citation.title }}</a> · {{ citation.createdAt }}</p>
          </template>
        </section>
      </div>
    </template>
    <PluginJiraDialog v-if="selected" v-model="jiraOpen" :plugin-id="id" :record="selected" :mode="jiraMode" @updated="updated" />
  </div>
</template>
<style scoped>
.plugin-workspace{padding:0 4px 20px;overflow:auto;min-height:0}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}.toolbar>.el-input{max-width:400px}.toolbar>.el-select{width:220px;max-width:100%}.plugin-record-filters>.el-input{flex:1;min-width:180px}.plugin-record-filters>.el-select{width:180px}.plugin-record-filters{margin:16px 0}.records-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.records-layout.is-editing{grid-template-columns:minmax(240px,1fr) minmax(300px,1.5fr)}.record-row{display:block;width:100%;border:1px solid var(--ui-border);border-radius:8px;padding:16px;margin-bottom:10px;text-align:left;background:var(--ui-surface);color:var(--ui-text);cursor:pointer}.record-row.active{border-color:var(--ui-accent)}.record-row span{float:right}.record-row p,.plugin-workspace p{color:var(--ui-muted);overflow-wrap:anywhere}.record-editor{padding:20px;border:1px solid var(--ui-border);border-radius:10px}.record-editor .el-select{width:100%}a{color:var(--ui-accent)}@media(max-width:850px){.records-layout.is-editing{grid-template-columns:1fr}}
</style>

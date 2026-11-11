<script setup lang="ts">
import WorkspaceMenuSettings from './WorkspaceMenuSettings.vue';
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { customPluginsQueryKey, pluginRequest } from './api';
import type { CustomPluginInfo, CustomPluginManifest, PluginCapability } from '../../../shared/custom-plugins';
const router = useRouter(), directory = ref(''), busy = ref(false), data = ref<{ plugins: CustomPluginInfo[]; errors: { id: string; message: string }[]; examples: { name: string; directory: string }[] }>({ plugins: [], errors: [], examples: [] });
const queryClient = useQueryClient(), showInMenu = ref(false);
const grantTarget = ref<CustomPluginInfo>(), selectedGrants = ref<PluginCapability[]>([]);
const inspected = ref<{ manifest: CustomPluginManifest; source: string; digest: string }>(), grants = ref<PluginCapability[]>([]);
const labels: Record<PluginCapability, string> = { 'storage.read': '读取插件私有数据', 'storage.write': '修改插件私有数据', 'workspace.todos.read': '读取个人待办', 'workspace.todos.write': '修改个人待办', 'jira.read': '读取 Jira 项目和任务', 'jira.create': '经确认创建 Jira 任务', 'conversation.context': '提供会话上下文' };
async function load() { data.value = await pluginRequest(); queryClient.setQueryData(customPluginsQueryKey, data.value); }
async function run(work: () => Promise<void>) { busy.value = true; try { await work(); } catch (e) { ElMessage.error(e instanceof Error ? e.message : '插件操作失败'); } finally { busy.value = false; } }
async function inspect() { inspected.value = undefined; showInMenu.value = false; await run(async () => { inspected.value = await pluginRequest('inspect', { directory: directory.value.trim() }); grants.value = [...inspected.value!.manifest.permissions]; }); }
async function install() { if (!inspected.value) return; await run(async () => { await pluginRequest('install', { directory: inspected.value!.source, digest: inspected.value!.digest, grants: grants.value, confirmed: true, showInMenu: showInMenu.value }); inspected.value = undefined; await load(); ElMessage.success('插件已添加并生效'); }); }
async function change(plugin: CustomPluginInfo, remove = false) {
  if (remove) { try { await ElMessageBox.confirm('移除插件入口并停用其能力，保留业务数据和历史引用。', '移除插件', { type: 'warning' }); } catch { return; } }
  await run(async () => { await pluginRequest(`${plugin.manifest.id}/change`, remove ? { remove: true } : { enabled: !plugin.enabled }); await load(); });
}
async function changeMenu(plugin: CustomPluginInfo, value: boolean) { await run(async () => { await pluginRequest(`${plugin.manifest.id}/change`, { showInMenu: value }); await load(); }); }
async function saveGrants() { if (!grantTarget.value) return; await run(async () => { await pluginRequest(`${grantTarget.value!.manifest.id}/change`, { grants: selectedGrants.value }); grantTarget.value = undefined; await load(); }); }
onMounted(() => run(load));
</script>
<template>
  <section class="surface manager">
    <div class="surface-header"><div><h2>自定义功能插件</h2><p>添加待办、备忘等功能，按需授权工作台能力，添加和停用立即生效。</p></div><div class="plugin-controls"><WorkspaceMenuSettings /><el-button :loading="busy" @click="run(load)">刷新</el-button></div></div>
    <div class="manager-body">
      <p v-for="error in data.errors" :key="error.id">{{ error.id }} · {{ error.message }}</p>
      <div class="install-row"><el-input v-model="directory" aria-label="插件目录" placeholder="本机插件目录的绝对路径" :disabled="busy" /><el-button :disabled="!directory.trim() || busy" @click="inspect">检查插件</el-button></div>
      <p class="examples">内附示例：<el-button v-for="example in data.examples" :key="example.directory" link type="primary" @click="directory = example.directory; inspect()">{{ example.name }}</el-button></p>
      <div v-if="inspected" class="package-preview">
        <h3>{{ inspected.manifest.name }} · {{ inspected.manifest.version }}</h3><p>{{ inspected.manifest.description }}</p><p>来源：{{ inspected.source }}</p>
        <p>选择允许使用的宿主能力。未授权的能力会被拒绝；Jira 写入仍需每次预览确认。</p>
        <el-checkbox-group v-model="grants"><el-checkbox v-for="permission in inspected.manifest.permissions" :key="permission" :value="permission">{{ labels[permission] }}</el-checkbox></el-checkbox-group>
        <div class="menu-setting"><el-checkbox v-model="showInMenu" :disabled="busy">在主菜单显示</el-checkbox></div>
        <el-button type="primary" :disabled="busy" @click="install">确认授权并添加</el-button><el-button @click="inspected = undefined">取消</el-button>
      </div>
      <el-skeleton v-if="busy && !data.plugins.length" :rows="3" animated />
      <el-empty v-else-if="!data.plugins.length" description="尚未添加自定义插件。填写本机插件目录，或选择上方示例开始。" :image-size="50" />
      <div v-for="plugin in data.plugins" :key="plugin.manifest.id" class="plugin-row">
        <div><strong>{{ plugin.manifest.name }}</strong> <span>{{ plugin.manifest.version }} · {{ plugin.enabled ? '已启用' : '已停用' }}</span><p>{{ plugin.manifest.description }}</p><small>{{ plugin.source }}</small><p v-if="plugin.error">{{ plugin.error }}</p></div>
        <div class="plugin-controls"><el-switch :model-value="plugin.showInMenu" :disabled="busy" active-text="在主菜单显示" :aria-label="`${plugin.manifest.name}在主菜单显示`" @change="changeMenu(plugin, Boolean($event))" /><el-button :disabled="busy || !plugin.enabled" @click="router.push({ path: '/agent', query: { view: 'plugins', plugin: plugin.manifest.id } })">打开</el-button><el-button :disabled="busy" @click="change(plugin)">{{ plugin.enabled ? '停用' : '启用' }}</el-button><el-button :disabled="busy" @click="grantTarget = plugin; selectedGrants = [...plugin.grants]">权限</el-button><el-button type="danger" plain :disabled="busy" @click="change(plugin, true)">移除</el-button></div>
      </div>
    </div>
    <el-dialog :model-value="!!grantTarget" title="插件宿主能力授权" width="min(600px, 90vw)" append-to-body @update:model-value="!$event && (grantTarget = undefined)"><p>权限变更立即生效；已发出的外部请求无法撤回。</p><el-checkbox-group v-model="selectedGrants"><el-checkbox v-for="permission in grantTarget?.manifest.permissions" :key="permission" :value="permission">{{ labels[permission] }}</el-checkbox></el-checkbox-group><template #footer><el-button @click="grantTarget = undefined">取消</el-button><el-button type="primary" :loading="busy" @click="saveGrants">确认保存权限</el-button></template></el-dialog>
  </section>
</template>
<style scoped>
.manager{margin-bottom:24px}.manager-body{padding:20px;display:grid;gap:16px}.install-row,.plugin-row{display:flex;gap:12px;align-items:center;justify-content:space-between}.plugin-row{padding:16px;border:1px solid var(--ui-border);border-radius:10px;flex-wrap:wrap}.plugin-row p,.manager p{color:var(--ui-muted);line-height:1.6}.plugin-row small{overflow-wrap:anywhere}.package-preview{padding:16px;background:var(--ui-hover);border-radius:10px}.package-preview .el-checkbox-group{margin-bottom:16px}
.plugin-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.plugin-controls :deep(.el-button) { margin: 0; }.plugin-controls :deep(.el-switch) { margin-right: 12px; }
.manager-body > p { margin: 0; font-size: 13px; }
.examples { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.examples :deep(.el-button) { margin: 0; }
@media (max-width: 600px) { .install-row { flex-wrap: wrap; } .install-row > .el-input { flex-basis: 100%; } }
</style>

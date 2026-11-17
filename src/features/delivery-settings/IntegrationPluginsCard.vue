<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type InputInstance } from 'element-plus';
import { Plug, ListChecks, BookOpen, MessageSquare, Braces, FolderGit2, Layers, Search } from '@lucide/vue';
import { integrationCatalog } from '../../../shared/integration-plugins';
import { fallbackLocalPluginStatus, saveLocalModuleOverride } from '../../plugins/runtime';
import StatusPill from '../../shared/ui/StatusPill.vue';
import WorkspaceRestartButton from '../../shared/version/WorkspaceRestartButton.vue';
import { useWorkspaceRestart } from '../../shared/version/useWorkspaceRestart';
import { filterIntegrationPlugins, summarizePluginRegistry, type PluginFilterTab } from './plugin-registry-studio';
interface Plugin {
  connection?: { type: string; label: string; openLabel: string; openPath?: string };
  transport?: 'http' | 'mcp' | 'github';
  githubKind?: 'market' | 'plugin'; githubPath?: string; githubPolicy?: 'stable' | 'all' | 'pinned'; githubRef?: string; githubToken?: string; githubTokenConfigured?: boolean; clearGithubToken?: boolean;
  local?: boolean; localPort?: number; id: string; name: string; description: string; enabled: boolean; baseUrl: string; username: string;
  installed: boolean; runningEnabled: boolean; runningConfigured: boolean; views: {id: string; label: string}[]; groupName: string; configured: boolean; restartRequired: boolean; source: string; token?: string; webhook?: string;
}
const client = useQueryClient(), router = useRouter(), route = useRoute();
const { query: restartQuery, busy: restarting, restart: triggerWorkspaceRestart } = useWorkspaceRestart();
const plugins = ref<Plugin[]>([]), busy = ref(false), autoApplying = ref(false);
const draft = ref<Plugin>();
const pluginSearch = ref('');
const pluginTab = ref<PluginFilterTab>('all');
const searchInputRef = ref<InputInstance>();
const capabilitiesById = Object.fromEntries(integrationCatalog.map(item => [item.id, item.capabilities || []]));
const icons = {
  jira: ListChecks, confluence: BookOpen, wecom: MessageSquare,
  'interface-center': Braces, 'system-catalog': FolderGit2, 'port-monitor': Layers, deployments: Layers, 'refactor-control': Layers, 'overseas-requirements': ListChecks,
};
const registryCounts = computed(() => summarizePluginRegistry(plugins.value));
const filteredPlugins = computed(() => filterIntegrationPlugins(plugins.value, pluginSearch.value, pluginTab.value, capabilitiesById));
const servicePlugins = computed(() => filteredPlugins.value.filter(item => !item.local));
const localModulePlugins = computed(() => filteredPlugins.value.filter(item => item.local));

function withFallbackLocalModules(remote: Plugin[]): Plugin[] {
  const known = new Set(remote.map(item => item.id));
  const extras: Plugin[] = integrationCatalog
    .filter(manifest => manifest.local && !known.has(manifest.id))
    .map(manifest => ({
      ...fallbackLocalPluginStatus(manifest),
      local: true,
      localPort: manifest.localPort,
      description: manifest.description,
      baseUrl: '',
      username: '',
      groupName: '',
      source: 'local',
      views: manifest.views.map(view => ({ id: view.id, label: view.label })),
    }));
  return extras.length ? [...remote, ...extras] : remote;
}
function status(plugin: Plugin) {
  if (!plugin.installed) return { value: 'paused', label: '已移除' };
  if (!plugin.runningEnabled) return { value: 'paused', label: '已停用' };
  if (plugin.restartRequired) return { value: 'pending', label: restarting.value || autoApplying.value ? '正在生效…' : '待生效' };
  if (plugin.local && !plugin.runningConfigured) return { value: 'pending', label: '当前端口不可用' };
  return plugin.runningConfigured ? { value: 'completed', label: '已启用' } : { value: 'pending', label: '待配置' };
}
function edit(plugin: Plugin) { draft.value = { ...plugin, transport: plugin.transport || 'http', githubKind: plugin.githubKind || 'market', githubPolicy: plugin.githubPolicy || 'stable', githubToken: '', clearGithubToken: false, token: '', webhook: '' }; }
function closeEditor() { if (!busy.value) draft.value = undefined; }
async function load() {
  busy.value = true;
  try {
    const response = await fetch('/api/plugins');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '读取接入插件失败');
    plugins.value = withFallbackLocalModules(result.plugins);
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : '读取接入插件失败'); }
  finally { busy.value = false; }
}
function maybeAutoApplyRestart(fallbackMessage: string) {
  const needsRestart = plugins.value.some(item => item.restartRequired);
  if (!needsRestart) {
    ElMessage.success(fallbackMessage);
    return;
  }
  if (restartQuery.data.value?.status === 'unavailable') {
    ElMessage.success(fallbackMessage);
    return;
  }
  autoApplying.value = true;
  if (!restarting.value) triggerWorkspaceRestart();
  ElMessage.success('已保存，正在自动生效（约 1 秒）…');
}
watch(restarting, async (nowBusy, wasBusy) => {
  if (!wasBusy || nowBusy || !autoApplying.value) return;
  autoApplying.value = false;
  await load();
  await client.invalidateQueries({ queryKey: ['integration-plugins'] });
  if (!plugins.value.some(item => item.restartRequired)) {
    ElMessage.success('插件连接配置已自动生效');
  }
});
async function act(plugin: Plugin, action: 'configure' | 'test') {
  busy.value = true;
  try {
    const config = plugin.connection?.type === 'catalog'
      ? { enabled: plugin.enabled, baseUrl: plugin.baseUrl, transport: plugin.transport || 'http', ...(plugin.transport === 'github' ? { githubKind: plugin.githubKind || 'market', githubPath: plugin.githubPath || '', githubPolicy: plugin.githubPolicy || 'stable', githubRef: plugin.githubRef || '', githubToken: plugin.githubToken || '', clearGithubToken: !!plugin.clearGithubToken } : {}) }
      : plugin.connection?.type === 'link'
      ? { enabled: plugin.enabled, baseUrl: plugin.baseUrl }
      : plugin.id === 'wecom'
      ? { enabled: plugin.enabled, groupName: plugin.groupName, webhook: plugin.webhook || '' }
      : { enabled: plugin.enabled, baseUrl: plugin.baseUrl, username: plugin.username, token: plugin.token || '' };
    const response = await fetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '插件操作失败');
    if (result.plugins) {
      const merged = withFallbackLocalModules(result.plugins);
      const saved = merged.find((item: Plugin) => item.id === plugin.id);
      plugins.value = merged;
      if (saved) Object.assign(plugin, saved, { token: '', webhook: '', githubToken: '', clearGithubToken: false });
      if (action === 'configure') draft.value = undefined;
    }
    await client.invalidateQueries({queryKey: ['integration-plugins']});
    if (action === 'configure' && !['link', 'catalog'].includes(plugin.connection?.type || '')) maybeAutoApplyRestart(result.message);
    else ElMessage.success(result.message);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '插件操作失败');
  }
  finally { busy.value = false; }
}
async function change(plugin: Plugin, input: {enabled?: boolean; installed?: boolean}) {
 busy.value = true;
 try {
  const response = await fetch(`/api/plugins/${plugin.id}/state`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes'}, body: JSON.stringify(input)});
  const result = await response.json();
  if (!response.ok) {
   if (plugin.local) {
    saveLocalModuleOverride(plugin.id, input);
    await load();
    await client.invalidateQueries({queryKey: ['integration-plugins']});
    ElMessage.success('页面显示已更新');
    return;
   }
   throw new Error(result.message);
  }
  plugins.value = withFallbackLocalModules(result.plugins);
  await client.invalidateQueries({queryKey: ['integration-plugins']});
  if (['link', 'catalog'].includes(plugin.connection?.type || '')) ElMessage.success(result.message);
  else maybeAutoApplyRestart(result.message);
 } catch(e) { ElMessage.error(e instanceof Error ? e.message : '插件状态修改失败'); } finally {busy.value = false;}
}
function onPluginKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || draft.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === '/') {
    event.preventDefault();
    searchInputRef.value?.focus();
  }
}
watch([() => route.query.configurePlugin, plugins], ([id]) => {
  if (typeof id !== 'string') return;
  const plugin = plugins.value.find(item => item.id === id);
  if (!plugin) return;
  edit(plugin);
  const { configurePlugin: _, ...query } = route.query;
  void router.replace({ query });
}, { immediate: true });
onMounted(() => {
  void load();
  window.addEventListener('keydown', onPluginKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onPluginKeydown));
</script>
<template>
  <section class="surface integration-plugins" aria-label="服务接入与内置模块插件" :aria-busy="busy">
    <div class="surface-header">
      <div><h2>固定插件与外部集成</h2><p>Jira、Confluence 和企微属于固定外部集成，使用现有连接配置；内置功能页面可按需开启或隐藏。</p></div>
      <el-button :loading="busy" @click="load">刷新</el-button>
    </div>
    <div class="plugin-registry-bar" role="region" aria-label="插件生态筛选栏">
      <div class="plugin-registry-search">
        <el-input ref="searchInputRef" v-model="pluginSearch" clearable placeholder="搜索插件名称、能力契约、端口（按 / 聚焦）" aria-label="搜索插件">
          <template #prefix><Search :size="14" /></template>
          <template #suffix><kbd v-if="!pluginSearch" class="plugin-kbd-hint">/</kbd></template>
        </el-input>
      </div>
      <div class="plugin-registry-pills" role="tablist" aria-label="插件分类筛选">
        <button type="button" class="plugin-filter-pill" :class="{ 'is-active': pluginTab === 'all' }" @click="pluginTab = 'all'">全部 <span>{{ registryCounts.all }}</span></button>
        <button type="button" class="plugin-filter-pill" :class="{ 'is-active': pluginTab === 'active' }" @click="pluginTab = 'active'">已启用 <span>{{ registryCounts.active }}</span></button>
        <button type="button" class="plugin-filter-pill" :class="{ 'is-active': pluginTab === 'service' }" @click="pluginTab = 'service'">外部连接 <span>{{ registryCounts.service }}</span></button>
        <button type="button" class="plugin-filter-pill" :class="{ 'is-active': pluginTab === 'local' }" @click="pluginTab = 'local'">本机模块 <span>{{ registryCounts.local }}</span></button>
        <button type="button" class="plugin-filter-pill" :class="{ 'is-active': pluginTab === 'setup' }" @click="pluginTab = 'setup'">待配置/停用 <span>{{ registryCounts.setup }}</span></button>
      </div>
    </div>
    <el-skeleton v-if="busy && !plugins.length" class="plugin-loading" :rows="3" animated />
    <el-empty v-else-if="!filteredPlugins.length && plugins.length" description="没有匹配当前筛选条件的插件或模块" :image-size="44">
      <el-button size="small" @click="pluginSearch = ''; pluginTab = 'all'">重置筛选条件</el-button>
    </el-empty>
    <div class="plugin-group-block" v-if="localModulePlugins.length">
      <div class="plugin-group-heading"><strong>可选功能页面</strong><span>共 {{ localModulePlugins.length }} 个 · 不常用的可随时停用隐藏</span></div>
      <div class="plugin-list">
        <article v-for="plugin in localModulePlugins" :key="plugin.id" class="plugin-row" :aria-label="plugin.name">
          <span class="plugin-icon"><component :is="icons[plugin.id as keyof typeof icons] || Plug" :size="20" /></span>
          <div class="plugin-info">
            <div class="plugin-title"><h3>{{ plugin.name }}</h3><StatusPill v-bind="status(plugin)" /></div>
            <p>{{ plugin.description }}</p>
            <div class="plugin-cap-chips">
              <span v-if="plugin.localPort" class="plugin-cap-chip is-port">:{{ plugin.localPort }}</span>
              <span v-for="cap in (capabilitiesById[plugin.id] || []).slice(0, 3)" :key="cap" class="plugin-cap-chip">{{ cap }}</span>
            </div>
            <p class="plugin-meta">{{ plugin.runningConfigured ? '本机功能 · 点一下立即显示或隐藏' : `请从本机 ${plugin.localPort} 端口打开` }}</p>
            <div v-if="plugin.installed && plugin.runningEnabled && plugin.runningConfigured && plugin.views.length" class="plugin-links">
              <el-button v-for="view in plugin.views" :key="view.id" link type="primary" @click="router.push({path:'/agent', query:{view:view.id}})">打开 {{ view.label }}</el-button>
            </div>
          </div>
          <div class="plugin-actions">
            <el-button v-if="!plugin.installed" :disabled="busy" @click="change(plugin, {installed: true, enabled: true})">恢复显示</el-button>
            <template v-else>
              <el-button :disabled="busy" @click="change(plugin, {enabled: !plugin.runningEnabled})">{{ plugin.runningEnabled ? '隐藏' : '显示' }}</el-button>
              <el-button text :disabled="busy" @click="change(plugin, {installed: false})">移除</el-button>
            </template>
          </div>
        </article>
      </div>
    </div>
    <div class="plugin-group-block" v-if="servicePlugins.length">
      <div class="plugin-group-heading"><strong>外部服务连接</strong><span>配置外部服务连接与访问链接</span></div>
      <div class="plugin-list">
        <article v-for="plugin in servicePlugins" :key="plugin.id" class="plugin-row" :aria-label="plugin.name">
          <span class="plugin-icon"><component :is="icons[plugin.id as keyof typeof icons] || Plug" :size="20" /></span>
          <div class="plugin-info">
            <div class="plugin-title"><h3>{{ plugin.name }}</h3><StatusPill v-bind="status(plugin)" /></div>
            <p>{{ plugin.description }}</p>
            <div v-if="(capabilitiesById[plugin.id] || []).length" class="plugin-cap-chips">
              <span v-for="cap in (capabilitiesById[plugin.id] || []).slice(0, 3)" :key="cap" class="plugin-cap-chip">{{ cap }}</span>
            </div>
            <p class="plugin-meta">{{ ['link', 'catalog'].includes(plugin.connection?.type || '') ? (plugin.configured ? '已配置连接' : '尚未配置连接') : (plugin.configured ? '已填写账号连接' : '尚未配置连接') }}</p>
            <p v-if="!plugin.installed" class="plugin-meta">配置和历史数据已保留，可随时恢复。</p>
            <div v-else-if="plugin.restartRequired" class="plugin-restart-inline">
              <p v-if="restarting || autoApplying" class="plugin-meta">配置已保存，正在后台自动切换生效，正在运行的任务不受影响…</p>
              <template v-else>
                <p class="plugin-meta">连接配置已保存，点击右侧按钮即可安全生效（正在运行的任务会自动保护）。</p>
                <WorkspaceRestartButton />
              </template>
            </div>
            <div v-if="plugin.installed && plugin.runningEnabled && plugin.runningConfigured && plugin.views.length" class="plugin-links">
              <el-button v-for="view in plugin.views" :key="view.id" link type="primary" @click="router.push({path:'/agent', query:{view:view.id}})">{{ view.label }}</el-button>
            </div>
            <div v-if="plugin.connection?.openPath" class="plugin-links">
              <el-button link type="primary" @click="router.push(plugin.connection.openPath)">{{ plugin.connection.openLabel }}</el-button>
            </div>
            <div v-if="plugin.connection?.type === 'link' && plugin.installed && plugin.runningEnabled && plugin.runningConfigured" class="plugin-links">
              <a :href="plugin.baseUrl" target="_blank" rel="noopener noreferrer">{{ plugin.connection.openLabel }}</a>
            </div>
          </div>
          <div class="plugin-actions">
            <el-button :disabled="busy" :aria-label="`配置 ${plugin.name}`" @click="edit(plugin)">{{ plugin.connection?.type === 'link' ? '配置链接' : '配置连接' }}</el-button>
            <el-button v-if="!plugin.installed" :disabled="busy" @click="change(plugin, {installed: true, enabled: true})">恢复接入</el-button>
            <template v-else>
              <el-button :disabled="busy" @click="change(plugin, {enabled: !plugin.runningEnabled})">{{ plugin.runningEnabled ? '停用' : '启用' }}</el-button>
              <el-button text :disabled="busy" @click="change(plugin, {installed: false})">移除接入</el-button>
            </template>
          </div>
        </article>
      </div>
    </div>
    <p class="plugin-note">移除后历史配置仍会保留，随时可以恢复；不确定账号对不对时，可先点“配置连接”测试一下。</p>
  </section>
  <el-dialog :model-value="!!draft" :title="draft ? `配置 ${draft.name}` : '配置连接'" width="min(560px, 92vw)" class="plugin-config-dialog" append-to-body :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && closeEditor()" @closed="closeEditor">
    <el-form v-if="draft" label-position="top" :disabled="busy" class="plugin-form" @submit.prevent="act(draft, 'configure')">
      <p class="editor-description">{{ draft.description.replace(/[。.]$/, '') }}。保存后会自动生效，正在运行的任务不受影响。</p>
      <template v-if="draft.connection?.type === 'catalog'">
        <el-form-item label="连接方式"><el-select v-model="draft.transport" aria-label="市场连接方式"><el-option label="HTTP（默认）" value="http" /><el-option label="MCP（Streamable HTTP）" value="mcp" /><el-option label="GitHub 仓库" value="github" /></el-select></el-form-item>
        <el-form-item :label="draft.transport === 'github' ? 'GitHub 仓库地址' : draft.connection.label"><el-input v-model="draft.baseUrl" :placeholder="draft.transport === 'github' ? 'https://github.com/owner/repository' : draft.transport === 'mcp' ? 'http://127.0.0.1:5499/mcp' : 'http://127.0.0.1:5499'" /></el-form-item>
        <template v-if="draft.transport === 'github'">
          <el-form-item label="仓库类型"><el-select v-model="draft.githubKind" aria-label="GitHub 仓库类型"><el-option label="市场仓库（catalog.json）" value="market" /><el-option label="单插件仓库（plugin.json）" value="plugin" /></el-select></el-form-item>
          <el-form-item label="目录路径（选填）"><el-input v-model="draft.githubPath" placeholder="留空为仓库根目录，例如 releases" /></el-form-item>
          <el-form-item label="版本策略"><el-select v-model="draft.githubPolicy" aria-label="GitHub 版本策略"><el-option label="稳定发布" value="stable" /><el-option label="包含预发布" value="all" /><el-option label="固定 Release 标签" value="pinned" /></el-select></el-form-item>
          <el-form-item v-if="draft.githubPolicy === 'pinned'" label="Release 标签"><el-input v-model="draft.githubRef" placeholder="v1.0.0" /></el-form-item>
          <el-form-item label="GitHub Token（私有仓库选填）"><el-input v-model="draft.githubToken" type="password" show-password autocomplete="new-password" :placeholder="draft.githubTokenConfigured ? '同一仓库留空保留现有凭据' : '公有仓库可留空，仅需 Contents 读取权限'" /></el-form-item>
          <el-checkbox v-if="draft.githubTokenConfigured" v-model="draft.clearGithubToken">清除已保存的 GitHub 凭据</el-checkbox>
          <p class="editor-description">读取发布标签下的声明，仅安装 Releases 中的 .dwp 包；不运行仓库源码。更换仓库会清除旧凭据。仅支持 github.com。</p>
        </template>
        <p class="editor-description">市场只提供目录与发布包，安装仍由本机检查并请求授权。HTTP 仅允许本机回环地址，远端须使用 HTTPS。</p>
      </template>
      <template v-else-if="draft.connection?.type === 'link'">
        <el-form-item :label="draft.connection.label"><el-input v-model="draft.baseUrl" placeholder="https://market.example.com/plugins" /></el-form-item>
        <p class="editor-description">在新标签页打开网站，不向网站开放本机安装管理权限。</p>
      </template>
      <template v-else-if="draft.id !== 'wecom'">
        <el-form-item label="服务地址"><el-input v-model="draft.baseUrl" placeholder="https://your-site.example.com" /></el-form-item>
        <el-form-item label="用户名 / 邮箱"><el-input v-model="draft.username" autocomplete="off" placeholder="使用 Bearer Token 时留空" /></el-form-item>
        <el-form-item label="Token"><el-input v-model="draft.token" type="password" show-password autocomplete="new-password" :placeholder="draft.configured ? '站点和账号不变时，留空保留现有凭据' : '输入认证 Token'" /></el-form-item>
        <p v-if="draft.source === 'legacy' && draft.configured" class="editor-description">当前沿用本机凭据。站点和账号不变时，留空即可测试连接；更换站点或账号时请填写新 Token。</p>
      </template>
      <template v-else>
        <el-form-item label="群名称"><el-input v-model="draft.groupName" /></el-form-item>
        <el-form-item label="机器人 Webhook"><el-input v-model="draft.webhook" type="password" show-password autocomplete="new-password" placeholder="留空保留已存地址" /></el-form-item>
        <p class="editor-description">检查地址格式不会真发消息；实际发送前仍可在消息页预览确认。</p>
      </template>
    </el-form>
    <template #footer>
      <div v-if="draft" class="editor-actions">
        <el-button :disabled="busy" @click="act(draft, 'test')">{{ draft.connection?.type === 'link' ? '检查链接格式' : draft.id === 'wecom' ? '检查地址格式' : '测试连接' }}</el-button>
        <span class="editor-spacer" />
        <el-button :disabled="busy" @click="closeEditor">取消</el-button>
        <el-button type="primary" :loading="busy" @click="act(draft, 'configure')">保存并生效</el-button>
      </div>
    </template>
  </el-dialog>
</template>
<style scoped>
.integration-plugins { margin-bottom: 16px; container-type: inline-size; }
.plugin-group-block + .plugin-group-block { border-top: 1px solid var(--ui-border); }
.plugin-group-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--ui-divider); background: color-mix(in srgb, var(--ui-raised) 65%, var(--ui-surface)); font-size: 12px; color: var(--ui-muted); }
.plugin-group-heading strong { color: var(--ui-text); font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
.plugin-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding: 12px 14px;
}
@container (min-width: 680px) {
  .plugin-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-width: 1040px) {
  .plugin-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.plugin-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  grid-template-rows: 1fr auto;
  align-items: start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: var(--ui-surface);
  transition: border-color 140ms ease, background-color 140ms ease;
}
.plugin-row:hover {
  border-color: color-mix(in srgb, var(--ui-text) 16%, var(--ui-border));
}
.plugin-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 7px;
  border: 1px solid var(--ui-border);
  color: var(--ui-secondary);
  background: var(--ui-raised);
}
.plugin-icon :deep(svg) { width: 16px; height: 16px; }
.plugin-info { min-width: 0; }
.plugin-title { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px; }
.plugin-title h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.45; color: var(--ui-text); }
.plugin-info p, .plugin-note, .editor-description { color: var(--ui-muted); line-height: 1.55; font-size: 12px; }
.plugin-info p { margin: 4px 0 0; }
.plugin-info .plugin-meta { font-size: 11.5px; color: var(--ui-muted); }
.plugin-restart-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; }
.plugin-restart-inline .plugin-meta { margin: 0; color: var(--ui-warning); }
.plugin-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.plugin-links a { text-decoration: none; }
.plugin-links a, .plugin-links :deep(.el-button.is-link) {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 8px;
  height: auto;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ui-text);
  transition: border-color 140ms ease, background-color 140ms ease;
}
.plugin-links a:hover, .plugin-links :deep(.el-button.is-link:hover) {
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
  background: var(--ui-hover);
  color: var(--ui-text);
}
.plugin-actions, .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.plugin-actions {
  grid-column: 1 / -1;
  align-self: end;
  justify-content: flex-start;
  padding-top: 8px;
  border-top: 1px solid var(--ui-divider);
  width: 100%;
}
.plugin-actions :deep(.el-button) { min-height: 26px; height: 26px; padding: 0 9px; font-size: 12px; border-radius: 6px; }
.plugin-actions :deep(.el-button), .plugin-links :deep(.el-button), .editor-actions :deep(.el-button) { margin: 0; }
.plugin-note { padding: 10px 14px; margin: 0; border-top: 1px solid var(--ui-divider); font-size: 11.5px; }
.plugin-loading { padding: 14px; }
.editor-description { margin: 0 0 16px; }
.editor-spacer { flex: 1; }
.plugin-registry-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-raised) 40%, var(--ui-surface));
}
.plugin-registry-search {
  flex: 1 1 260px;
  max-width: 420px;
  min-width: 200px;
}
.plugin-registry-search :deep(.el-input__wrapper) {
  min-height: 30px;
  font-size: 12px;
}
.plugin-kbd-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: 10.5px;
  line-height: 1;
}
.plugin-registry-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.plugin-filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 2px 9px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}
.plugin-filter-pill span {
  font-family: var(--ui-font-mono);
  font-size: 10.5px;
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}
.plugin-filter-pill:hover {
  border-color: color-mix(in srgb, var(--ui-text) 20%, var(--ui-border));
  color: var(--ui-text);
}
.plugin-filter-pill.is-active {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-accent) 12%, var(--ui-surface));
  color: var(--ui-text);
  font-weight: 600;
}
.plugin-filter-pill.is-active span {
  color: var(--ui-accent);
}
.plugin-cap-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.plugin-cap-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-family: var(--ui-font-mono);
  font-size: 10.5px;
  line-height: 1.4;
}
.plugin-cap-chip.is-port {
  border-color: color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-accent) 9%, var(--ui-raised));
  color: var(--ui-accent);
  font-weight: 600;
}
:global(.plugin-config-dialog.el-dialog) {
  color: var(--ui-text);
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
}
:global(.plugin-config-dialog .el-dialog__title) {
  color: var(--ui-text);
}
:root[data-theme='acid'] .plugin-row,
:root[data-theme='acid'] .plugin-icon,
:root[data-theme='acid'] .plugin-filter-pill,
:root[data-theme='acid'] .plugin-cap-chip,
:root[data-theme='acid'] .plugin-kbd-hint,
:root[data-theme='acid'] .plugin-links :deep(.el-button.is-link),
:root[data-theme='acid'] .plugin-actions :deep(.el-button) {
  border-radius: 0;
}
@media (max-width: 600px) {
  .plugin-list { padding: 10px; }
  .plugin-registry-bar { padding: 10px; }
  .plugin-registry-search { max-width: none; }
  .editor-spacer { display: none; }
}
</style>

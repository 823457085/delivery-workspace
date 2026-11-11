<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Plug, ListChecks, BookOpen, MessageSquare } from '@lucide/vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
interface Plugin {
  id: string; name: string; description: string; enabled: boolean; baseUrl: string; username: string;
  installed: boolean; runningEnabled: boolean; runningConfigured: boolean; views: {id: string; label: string}[]; groupName: string; configured: boolean; restartRequired: boolean; source: string; token?: string; webhook?: string;
}
const client = useQueryClient(), router = useRouter();
const plugins = ref<Plugin[]>([]), busy = ref(false);
const draft = ref<Plugin>();
const icons = { jira: ListChecks, confluence: BookOpen, wecom: MessageSquare };
function status(plugin: Plugin) {
  if (!plugin.installed) return { value: 'paused', label: '已移除' };
  if (!plugin.runningEnabled) return { value: 'paused', label: '已停用' };
  if (plugin.restartRequired) return { value: 'pending', label: '待重启' };
  return plugin.runningConfigured ? { value: 'active', label: '已启用' } : { value: 'pending', label: '待配置' };
}
function edit(plugin: Plugin) { draft.value = { ...plugin, token: '', webhook: '' }; }
function closeEditor() { if (!busy.value) draft.value = undefined; }
async function load() {
  busy.value = true;
  try {
    const response = await fetch('/api/plugins');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '读取接入插件失败');
    plugins.value = result.plugins;
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : '读取接入插件失败'); }
  finally { busy.value = false; }
}
async function act(plugin: Plugin, action: 'configure' | 'test') {
  busy.value = true;
  try {
    const config = plugin.id === 'wecom'
      ? { enabled: plugin.enabled, groupName: plugin.groupName, webhook: plugin.webhook || '' }
      : { enabled: plugin.enabled, baseUrl: plugin.baseUrl, username: plugin.username, token: plugin.token || '' };
    const response = await fetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '插件操作失败');
    if (result.plugins) {
      const saved = result.plugins.find((item: Plugin) => item.id === plugin.id);
      plugins.value = result.plugins;
      Object.assign(plugin, saved, { token: '', webhook: '' });
      if (action === 'configure') draft.value = undefined;
    }
    await client.invalidateQueries({queryKey: ['integration-plugins']});
    ElMessage.success(result.message);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '插件操作失败');
  }
  finally { busy.value = false; }
}
async function change(plugin: Plugin, input: {enabled?: boolean; installed?: boolean}) {
 busy.value = true;
 try {
  const response = await fetch(`/api/plugins/${plugin.id}/state`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes'}, body: JSON.stringify(input)});
  const result = await response.json(); if (!response.ok) throw new Error(result.message);
  plugins.value = result.plugins; await client.invalidateQueries({queryKey: ['integration-plugins']}); ElMessage.success(result.message);
 } catch(e) { ElMessage.error(e instanceof Error ? e.message : '插件状态修改失败'); } finally {busy.value = false;}
}
onMounted(load);
</script>
<template>
  <section class="surface integration-plugins" aria-label="服务接入插件" :aria-busy="busy">
    <div class="surface-header">
      <div><h2>服务接入</h2><p>管理业务服务的连接与功能入口，启停立即生效。</p></div>
      <el-button :loading="busy" @click="load">刷新</el-button>
    </div>
    <el-skeleton v-if="busy && !plugins.length" class="plugin-loading" :rows="3" animated />
    <div class="plugin-list">
      <article v-for="plugin in plugins" :key="plugin.id" class="plugin-row" :aria-label="plugin.name">
        <span class="plugin-icon"><component :is="icons[plugin.id as keyof typeof icons] || Plug" :size="20" /></span>
        <div class="plugin-info">
          <div class="plugin-title"><h3>{{ plugin.name }}</h3><StatusPill v-bind="status(plugin)" /></div>
          <p>{{ plugin.description }}</p>
          <p class="plugin-meta">{{ plugin.configured ? '已配置凭据' : '尚未配置凭据' }} · {{ plugin.source === 'legacy' ? '沿用本机配置' : '插件管理' }}</p>
          <p v-if="!plugin.installed" class="plugin-meta">配置和历史数据已保留，可随时恢复接入。</p>
          <p v-else-if="plugin.restartRequired" class="plugin-meta">连接配置已保存，请在任务结束后重启工作台。</p>
          <div v-if="plugin.installed && plugin.runningEnabled && plugin.runningConfigured && plugin.views.length" class="plugin-links">
            <el-button v-for="view in plugin.views" :key="view.id" link type="primary" @click="router.push({path:'/agent', query:{view:view.id}})">{{ view.label }}</el-button>
          </div>
        </div>
        <div class="plugin-actions">
          <el-button type="primary" plain :disabled="busy" :aria-label="`配置 ${plugin.name}`" @click="edit(plugin)">配置连接</el-button>
          <el-button v-if="!plugin.installed" :disabled="busy" @click="change(plugin, {installed: true, enabled: true})">恢复接入</el-button>
          <template v-else>
            <el-button :disabled="busy" @click="change(plugin, {enabled: !plugin.runningEnabled})">{{ plugin.runningEnabled ? '停用' : '启用' }}</el-button>
            <el-button text :disabled="busy" @click="change(plugin, {installed: false})">移除接入</el-button>
          </template>
        </div>
      </article>
    </div>
    <p class="plugin-note">移除接入会保留配置和历史数据。已配置凭据不代表权限验证通过，可在“配置连接”中测试。</p>
  </section>
  <el-dialog :model-value="!!draft" :title="draft ? `配置 ${draft.name}` : '配置连接'" width="min(560px, 92vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && closeEditor()" @closed="closeEditor">
    <el-form v-if="draft" label-position="top" :disabled="busy" class="plugin-form" @submit.prevent="act(draft, 'configure')">
      <p class="editor-description">{{ draft.description }}。连接配置保存后需重启工作台生效。</p>
      <template v-if="draft.id !== 'wecom'">
        <el-form-item label="服务地址"><el-input v-model="draft.baseUrl" placeholder="https://your-site.example.com" /></el-form-item>
        <el-form-item label="用户名 / 邮箱"><el-input v-model="draft.username" autocomplete="off" placeholder="使用 Bearer Token 时留空" /></el-form-item>
        <el-form-item label="Token"><el-input v-model="draft.token" type="password" show-password autocomplete="new-password" :placeholder="draft.configured ? '站点和账号不变时，留空保留现有凭据' : '输入认证 Token'" /></el-form-item>
        <p v-if="draft.source === 'legacy' && draft.configured" class="editor-description">当前沿用本机凭据。服务启用且站点和账号不变时，可留空测试连接。更换站点或账号时需填写新 Token。</p>
      </template>
      <template v-else>
        <el-form-item label="群名称"><el-input v-model="draft.groupName" /></el-form-item>
        <el-form-item label="机器人 Webhook"><el-input v-model="draft.webhook" type="password" show-password autocomplete="new-password" placeholder="留空保留已存地址" /></el-form-item>
        <p class="editor-description">地址检查不会发送消息；实际发送仍需在消息页预览并确认。停用插件同时停止工作台内专用报告机器人的发送。</p>
      </template>
    </el-form>
    <template #footer>
      <div v-if="draft" class="editor-actions">
        <el-button :disabled="busy" @click="act(draft, 'test')">{{ draft.id === 'wecom' ? '检查地址格式' : '只读测试连接' }}</el-button>
        <span class="editor-spacer" />
        <el-button :disabled="busy" @click="closeEditor">取消</el-button>
        <el-button type="primary" :loading="busy" @click="act(draft, 'configure')">保存连接</el-button>
      </div>
    </template>
  </el-dialog>
</template>
<style scoped>
.integration-plugins { margin-bottom: 22px; container-type: inline-size; }
.plugin-row { display: flex; align-items: flex-start; gap: 14px; padding: 20px; }
.plugin-row + .plugin-row { border-top: 1px solid var(--ui-border); }
.plugin-icon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 10px; color: var(--ui-accent); background: var(--ui-accent-soft); }
.plugin-info { min-width: 0; flex: 1; }
.plugin-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.plugin-title h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.6; }
.plugin-info p, .plugin-note, .editor-description { color: var(--ui-muted); line-height: 1.7; font-size: 13px; }
.plugin-info p { margin: 5px 0 0; }
.plugin-info .plugin-meta { font-size: 12px; }
.plugin-links { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; }
.plugin-actions, .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.plugin-actions { justify-content: flex-end; }
.plugin-actions :deep(.el-button), .plugin-links :deep(.el-button), .editor-actions :deep(.el-button) { margin: 0; }
.plugin-note { padding: 14px 20px; margin: 0; border-top: 1px solid var(--ui-border); font-size: 12px; }
.plugin-loading { padding: 20px; }
.editor-description { margin: 0 0 20px; }
.editor-spacer { flex: 1; }
@container (max-width: 760px) {
  .plugin-row { flex-wrap: wrap; }
  .plugin-info { flex-basis: calc(100% - 54px); }
  .plugin-actions { padding-left: 54px; justify-content: flex-start; }
}
@media (max-width: 600px) {
  .plugin-row { flex-wrap: wrap; padding: 16px; }
  .plugin-info { flex-basis: calc(100% - 54px); }
  .plugin-actions { padding-left: 0; justify-content: flex-start; }
  .editor-spacer { display: none; }
}
</style>

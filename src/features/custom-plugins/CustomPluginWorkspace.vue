<script setup lang="ts">
import PluginApplicationFrame from './PluginApplicationFrame.vue';
import { computed, defineAsyncComponent, inject, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Download, ExternalLink } from '@lucide/vue';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { pluginRequest } from './api';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { normalizePluginTags, type CustomPluginField, type CustomPluginInfo, type PluginRecord } from '../../../shared/custom-plugins';
import { dateTime, safeUrl } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
const PluginJiraDialog = defineAsyncComponent(() => import('./PluginJiraDialog.vue'));

defineProps<{ dedicated?: boolean }>();

const integrations = useIntegrationPlugins();
const route = useRoute(), router = useRouter(), workspace = inject(agentWorkspaceContext, undefined);
const plugins = ref<CustomPluginInfo[]>([]), items = ref<(PluginRecord & { version: string })[]>([]), busy = ref(false), query = ref(''), status = ref(''), activeTag = ref('');
const id = computed(() => typeof route.query.plugin === 'string' ? route.query.plugin : ''), plugin = computed(() => plugins.value.find(p => p.manifest.id === id.value));
const selected = ref<PluginRecord & { version: string }>(), form = ref<Record<string, string>>({}), tagDrafts = ref<Record<string, string>>({}), editing = ref(false), detail = ref<any>();
const jiraOpen = ref(false), jiraMode = ref<'jira.link' | 'jira.create'>('jira.link');
const applicationFrame = ref<{ reload(): Promise<void> }>();
async function refreshWorkspace() { if (plugin.value?.manifest.page.kind === 'application') await applicationFrame.value?.reload(); else await run(load); }
const writable = computed(() => !!plugin.value?.grants.includes(plugin.value.manifest.records.storage === 'private' ? 'storage.write' : 'workspace.todos.write'));
const statusField = computed(() => plugin.value?.manifest.records.fields.find(f => f.key === 'status' && f.type === 'select'));
const tagFields = computed(() => plugin.value?.manifest.records.fields.filter(f => f.type === 'tags') || []);
const urlFields = computed(() => plugin.value?.manifest.records.fields.filter(f => f.type === 'url') || []);
const checkboxFields = computed(() => plugin.value?.manifest.records.fields.filter(f => f.type === 'checkbox') || []);

const allTags = computed(() => {
  if (!tagFields.value.length) return [];
  const collected = new Set<string>();
  for (const item of items.value) {
    for (const field of tagFields.value) {
      for (const tag of normalizePluginTags(item.values[field.key] || '')) collected.add(tag);
    }
  }
  return [...collected].slice(0, 40);
});

const filtered = computed(() => items.value.filter(item => {
  if (status.value && item.values.status !== status.value) return false;
  if (activeTag.value && !tagFields.value.some(field => normalizePluginTags(item.values[field.key] || '').includes(activeTag.value))) return false;
  if (query.value && !Object.values(item.values).join(' ').toLowerCase().includes(query.value.toLowerCase())) return false;
  return true;
}));

async function run(work: () => Promise<void>) {
  busy.value = true;
  try { await work(); } catch (e) { ElMessage.error(e instanceof Error ? e.message : '插件操作失败'); } finally { busy.value = false; }
}

async function load() {
  plugins.value = (await pluginRequest()).plugins;
  items.value = [];
  detail.value = undefined;
  selected.value = undefined;
  editing.value = false;
  if (plugin.value?.enabled && plugin.value.manifest.page.kind !== 'application') {
    items.value = (await pluginRequest(`${id.value}/records`)).items;
    const record = items.value.find(item => item.id === route.query.record);
    if (record) await select(record);
    else if (route.query.record) ElMessage.warning('事项已删除或不存在，历史会话中的快照仍可查看');
  }
}

async function select(record: PluginRecord & { version: string }) {
  selected.value = record;
  editing.value = true;
  tagDrafts.value = {};
  form.value = Object.fromEntries((plugin.value?.manifest.records.fields || []).map(field => [
    field.key,
    record.values[field.key] ?? field.default,
  ]));
  detail.value = await pluginRequest(`${id.value}/record?id=${record.id}`);
}

function add() {
  selected.value = undefined;
  detail.value = undefined;
  tagDrafts.value = {};
  form.value = Object.fromEntries((plugin.value?.manifest.records.fields || []).map(field => [
    field.key,
    field.type === 'checkbox' ? (field.default === 'true' ? 'true' : 'false') : field.default,
  ]));
  editing.value = true;
}

function fieldTags(key: string) {
  return normalizePluginTags(form.value[key] || '');
}

function appendTag(field: CustomPluginField) {
  const raw = (tagDrafts.value[field.key] || '').trim();
  if (!raw) return;
  const merged = normalizePluginTags([form.value[field.key] || '', raw].filter(Boolean).join(', '));
  form.value[field.key] = merged.join(', ');
  tagDrafts.value[field.key] = '';
}

function removeTag(key: string, target: string) {
  form.value[key] = fieldTags(key).filter(tag => tag !== target).join(', ');
}

function recordTags(record: PluginRecord) {
  return [...new Set(tagFields.value.flatMap(field => normalizePluginTags(record.values[field.key] || '')))].slice(0, 6);
}

function firstSafeRecordUrl(record: PluginRecord) {
  for (const field of urlFields.value) {
    const valid = safeUrl(record.values[field.key] || '');
    if (valid) return { label: field.label, href: valid };
  }
  return undefined;
}

function escapeCsvCell(value: string) {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

function exportRecords(format: 'json' | 'csv') {
  if (!plugin.value || !filtered.value.length) return;
  const fields = plugin.value.manifest.records.fields;
  let content = '';
  let mime = 'application/json;charset=utf-8';
  if (format === 'json') {
    content = JSON.stringify(filtered.value.map(({ version: _version, ...item }) => item), null, 2) + '\n';
  } else {
    mime = 'text/csv;charset=utf-8';
    const header = ['id', ...fields.map(f => f.label), 'createdAt', 'updatedAt'].map(escapeCsvCell).join(',');
    const rows = filtered.value.map(item => [
      item.id,
      ...fields.map(f => item.values[f.key] || ''),
      item.createdAt,
      item.updatedAt,
    ].map(escapeCsvCell).join(','));
    content = '\uFEFF' + [header, ...rows].join('\n') + '\n';
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${plugin.value.manifest.id}-${new Date().toISOString().slice(0, 10)}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function save() {
  for (const field of tagFields.value) appendTag(field);
  await run(async () => {
    const saved = await pluginRequest(`${id.value}/save`, {
      ...(selected.value ? { id: selected.value.id, expectedVersion: selected.value.version } : {}),
      values: form.value,
    });
    await load();
    const item = items.value.find(item => item.id === saved.id);
    if (item) await select(item);
    ElMessage.success('事项已保存');
  });
}

async function remove() {
  if (!selected.value) return;
  try { await ElMessageBox.confirm('删除该事项？历史会话快照和 Jira 关联记录将保留，远端任务不受影响。', '删除事项', { type: 'warning' }); } catch { return; }
  await run(async () => {
    await pluginRequest(`${id.value}/delete`, { id: selected.value!.id, expectedVersion: selected.value!.version });
    await router.replace({ query: { ...route.query, record: undefined } });
    await load();
  });
}

async function command(action: string) {
  if (!selected.value) return;
  if (action === 'conversation.context') {
    await run(async () => {
      const result = await pluginRequest(`${id.value}/context`, { recordId: selected.value!.id });
      workspace?.compose(result.prompt);
    });
  } else {
    jiraMode.value = action as typeof jiraMode.value;
    jiraOpen.value = true;
  }
}

function allowed(action: string) {
  if (action.startsWith('jira.') && !integrations.capability(action === 'jira.create' ? 'issues.write' : 'issues.read')) return false;
  return !!plugin.value?.grants.includes(action === 'jira.link' ? 'jira.read' : action as any);
}

async function updated() {
  if (selected.value) await run(async () => { detail.value = await pluginRequest(`${id.value}/record?id=${selected.value!.id}`); });
}

async function reconcileJiraOperation(ticketId: string, outcome: 'auto' | 'linked' | 'not_created') {
  if (!selected.value) return;
  let issueKey: string | undefined;
  if (outcome === 'linked') {
    try {
      const prompt = await ElMessageBox.prompt('请输入已在 Jira 确认创建的任务编号（如 DEMO-123），系统将只读校验后关联并解除锁定：', '关联已创建任务', {
        confirmButtonText: '核对并关联',
        cancelButtonText: '取消',
        inputPlaceholder: 'DEMO-123',
        inputPattern: /^\s*[A-Za-z][A-Za-z0-9_]*-\d+\s*$/,
        inputErrorMessage: '请输入有效的 Jira 编号，例如 DEMO-123',
      });
      issueKey = prompt.value.trim().toUpperCase();
    } catch { return; }
  } else if (outcome === 'not_created') {
    try {
      await ElMessageBox.confirm('确认已在 Jira 核实该事项并未创建？确认后只解除本地创建锁，不会自动重发写请求。', '确认未创建并解锁', {
        type: 'warning',
        confirmButtonText: '确认未创建，解锁',
        cancelButtonText: '取消',
      });
    } catch { return; }
  }
  await run(async () => {
    const result = await pluginRequest(`${id.value}/jira-reconcile`, {
      ticketId,
      outcome,
      ...(issueKey ? { issueKey } : {}),
      confirmed: true,
    });
    detail.value = await pluginRequest(`${id.value}/record?id=${selected.value!.id}`);
    if (result.status === 'done') ElMessage.success(result.message || '已关联并解除锁定');
    else if (result.status === 'failed') ElMessage.success(result.message || '已解锁，可重新预览创建');
    else ElMessage.info(result.message || '仍待人工核对');
  });
}

watch(id, () => { query.value = ''; status.value = ''; activeTag.value = ''; void run(load); });
onMounted(() => run(load));
</script>

<template>
  <div class="plugin-workspace">
    <PageHeading
      :title="dedicated && plugin ? plugin.manifest.page.title : '功能插件中心'"
      :description="dedicated && plugin ? plugin.manifest.description : '集中管理自定义业务台账插件与内置模块启停，按需精简左侧菜单结构。'"
      :loading="busy"
      @refresh="refreshWorkspace"
    >
      <el-button v-if="id" @click="router.push({ query: { view: 'settings', settingsTab: 'plugins' } })">返回插件中心</el-button>
      <el-button @click="router.push({ query: { view: 'settings', settingsTab: 'plugins' } })">连接与凭据设置</el-button>
    </PageHeading>

    <div v-if="!dedicated && plugins.length" class="toolbar">
      <el-select
        :model-value="id"
        placeholder="切换到已安装的自定义插件工作区…"
        clearable
        @change="$event ? router.push({ query: { view: 'plugins', plugin: $event } }) : router.push({ query: { view: 'settings', settingsTab: 'plugins' } })"
      >
        <el-option v-for="p in plugins" :key="p.manifest.id" :value="p.manifest.id" :label="p.manifest.name + (p.enabled ? '' : '（已停用）')" />
      </el-select>
    </div>

    <el-skeleton v-if="busy && !plugin" :rows="3" animated />
    <el-empty v-else-if="!plugin || !plugin.enabled" :description="id ? '插件已停用或移除，历史引用快照仍保留在会话中' : '请先在插件中心添加或启用插件'" />
    <PluginApplicationFrame v-else-if="plugin.manifest.page.kind === 'application'" ref="applicationFrame" :key="plugin.manifest.id" :plugin-id="plugin.manifest.id" />
    <template v-else>
      <h2 v-if="!dedicated">{{ plugin.manifest.page.title }}</h2>
      <p v-if="!dedicated">{{ plugin.manifest.description }}</p>

      <div class="toolbar plugin-record-filters">
        <el-input v-model="query" placeholder="搜索事项标题、正文或标签" clearable @keydown.esc="query = ''" />
        <el-select v-if="statusField" v-model="status" placeholder="全部状态" clearable>
          <el-option v-for="o in statusField.options" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-select v-if="allTags.length" v-model="activeTag" placeholder="按标签筛选" clearable>
          <el-option v-for="tag in allTags" :key="tag" :label="tag" :value="tag" />
        </el-select>
        <el-dropdown v-if="filtered.length" trigger="click" @command="exportRecords($event)">
          <el-button :disabled="busy"><Download :size="14" />&nbsp;导出 ({{ filtered.length }})</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="csv">导出为 CSV 表格</el-dropdown-item>
              <el-dropdown-item command="json">导出为 JSON 备份</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button type="primary" :disabled="!writable || busy" @click="add">新增事项</el-button>
      </div>

      <div class="records-layout" :class="{ 'is-editing': editing }">
        <div>
          <el-empty v-if="!filtered.length" description="暂无匹配事项" :image-size="50" />
          <div
            v-for="item in filtered"
            :key="item.id"
            role="button"
            tabindex="0"
            class="record-row"
            :class="{ active: selected?.id === item.id }"
            @click="run(() => select(item))"
            @keydown.enter.prevent="run(() => select(item))"
          >
            <div class="record-row-head">
              <strong>{{ item.values.title }}</strong>
              <span v-if="statusField" class="record-status-pill">
                {{ statusField.options?.find(o => o.value === item.values.status)?.label || '' }}
              </span>
            </div>
            <p v-if="item.values.details">{{ item.values.details.slice(0, 110) }}</p>
            <div v-if="recordTags(item).length || checkboxFields.length || firstSafeRecordUrl(item)" class="record-badges">
              <span v-for="tag in recordTags(item)" :key="tag" class="record-tag">#{{ tag }}</span>
              <span
                v-for="check in checkboxFields.filter(f => item.values[f.key] === 'true')"
                :key="check.key"
                class="record-check-pill"
              >
                ✓ {{ check.label }}
              </span>
              <a
                v-if="firstSafeRecordUrl(item)"
                :href="firstSafeRecordUrl(item)!.href"
                target="_blank"
                rel="noopener noreferrer"
                class="record-url-link"
                @click.stop
              >
                <ExternalLink :size="11" /> {{ firstSafeRecordUrl(item)!.label }}
              </a>
            </div>
            <small>{{ dateTime(item.updatedAt) }}</small>
          </div>
        </div>

        <section v-if="editing" class="record-editor">
          <el-form label-position="top" :disabled="busy || !writable" @keydown.meta.enter.prevent="save" @keydown.ctrl.enter.prevent="save">
            <el-form-item v-for="field in plugin.manifest.records.fields" :key="field.key" :label="field.label" :required="field.required">
              <el-select v-if="field.type === 'select'" v-model="form[field.key]" clearable>
                <el-option v-for="o in field.options" :key="o.value" :value="o.value" :label="o.label" />
              </el-select>
              <el-date-picker
                v-else-if="field.type === 'date'"
                v-model="form[field.key]"
                type="date"
                value-format="YYYY-MM-DD"
                @clear="form[field.key] = ''"
              />
              <el-switch
                v-else-if="field.type === 'checkbox'"
                :model-value="form[field.key] === 'true'"
                active-text="是"
                inactive-text="否"
                @change="form[field.key] = $event ? 'true' : 'false'"
              />
              <div v-else-if="field.type === 'tags'" class="tags-editor">
                <div v-if="fieldTags(field.key).length" class="tags-chips">
                  <el-tag
                    v-for="tag in fieldTags(field.key)"
                    :key="tag"
                    size="small"
                    closable
                    @close="removeTag(field.key, tag)"
                  >
                    {{ tag }}
                  </el-tag>
                </div>
                <el-input
                  v-model="tagDrafts[field.key]"
                  placeholder="输入标签后按回车，或以逗号分隔"
                  @keydown.enter.prevent="appendTag(field)"
                  @blur="appendTag(field)"
                />
              </div>
              <div v-else-if="field.type === 'url'" class="url-editor">
                <el-input v-model="form[field.key]" type="url" placeholder="https://..." :maxlength="field.maxLength" />
                <a v-if="safeUrl(form[field.key])" :href="safeUrl(form[field.key])" target="_blank" rel="noopener noreferrer">
                  <ExternalLink :size="13" /> 打开
                </a>
              </div>
              <el-input
                v-else-if="field.type === 'number'"
                v-model="form[field.key]"
                inputmode="decimal"
                placeholder="输入数值"
                :maxlength="field.maxLength"
              />
              <el-input
                v-else
                v-model="form[field.key]"
                :type="field.type === 'textarea' ? 'textarea' : 'text'"
                :rows="5"
                :maxlength="field.maxLength"
              />
            </el-form-item>
            <el-button type="primary" @click="save">保存事项</el-button>
            <el-button v-if="selected" type="danger" plain @click="remove">删除事项</el-button>
            <el-button @click="editing = false; selected = undefined">收起编辑</el-button>
          </el-form>

          <template v-if="selected">
            <h3>关联操作</h3>
            <p v-if="plugin.manifest.commands.some(c => c.action.startsWith('jira.')) && !integrations.capability('issues.read')">
              任务提供者未接入或不可用，请在插件管理中启用并配置。
            </p>
            <p>操作使用已保存的事项内容；编辑后请先保存。</p>
            <div class="toolbar">
              <el-button
                v-for="c in plugin.manifest.commands"
                :key="c.id"
                :disabled="busy || !allowed(c.action) || (c.action === 'conversation.context' && !workspace)"
                @click="command(c.action)"
              >
                {{ c.label }}
              </el-button>
            </div>
            <h4>关联的 Jira 任务</h4>
            <p v-if="!detail?.links?.length">暂无关联</p>
            <p v-for="link in detail?.links" :key="link.url">
              <a :href="link.url" target="_blank" rel="noopener">{{ link.key }} · {{ link.summary }}</a>
            </p>
            <div
              v-for="operation in detail?.operations?.filter((o: any) => ['unknown', 'sending'].includes(o.status))"
              :key="operation.id"
              class="unknown-operation-box"
              role="status"
            >
              <p>{{ operation.message || 'Jira 创建正在处理，请勿重复提交' }}</p>
              <small v-if="operation.marker">核对标记：<code>{{ operation.marker }}</code></small>
              <div v-if="operation.status === 'unknown' && allowed('jira.create')" class="toolbar">
                <el-button size="small" type="primary" plain :disabled="busy" @click="reconcileJiraOperation(operation.id, 'auto')">自动回读核对</el-button>
                <el-button size="small" :disabled="busy" @click="reconcileJiraOperation(operation.id, 'linked')">填入已创建编号</el-button>
                <el-button size="small" :disabled="busy" @click="reconcileJiraOperation(operation.id, 'not_created')">确认未创建并解锁</el-button>
              </div>
            </div>
            <h4>会话引用来源</h4>
            <p v-if="!detail?.citations?.length">暂无已保存的会话引用</p>
            <p v-for="citation in detail?.citations" :key="citation.runId">
              <a :href="citation.url">{{ citation.title }}</a> · {{ dateTime(citation.createdAt) }}
            </p>
          </template>
        </section>
      </div>
    </template>
    <PluginJiraDialog v-if="selected && jiraOpen" v-model="jiraOpen" :plugin-id="id" :record="selected" :mode="jiraMode" @updated="updated" />
  </div>
</template>

<style scoped>
.plugin-workspace { padding: 0 4px 20px; overflow: auto; min-height: 0; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
.toolbar > .el-input { max-width: 400px; }
.toolbar > .el-select { width: 220px; max-width: 100%; }
.plugin-record-filters > .el-input { flex: 1; min-width: 180px; }
.plugin-record-filters > .el-select { width: 170px; }
.plugin-record-filters { margin: 16px 0; }
.records-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
.records-layout.is-editing { grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.5fr); }
.record-row {
  display: block;
  width: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 10px;
  text-align: left;
  background: var(--ui-surface);
  color: var(--ui-text);
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease;
}
.record-row:hover { border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--ui-border)); }
.record-row.active { border-color: var(--ui-accent); background: color-mix(in srgb, var(--ui-accent-soft) 35%, var(--ui-surface)); }
.record-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.record-status-pill { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; background: var(--ui-raised); color: var(--ui-secondary); flex-shrink: 0; }
.record-row p, .plugin-workspace p { color: var(--ui-muted); overflow-wrap: anywhere; margin: 6px 0; font-size: 13px; }
.record-row small { color: var(--ui-muted); font-size: 11.5px; }
.record-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 6px; }
.record-tag { padding: 1px 7px; border-radius: 6px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 11px; }
.record-check-pill { padding: 1px 7px; border-radius: 6px; background: var(--ui-raised); color: var(--ui-text); font-size: 11px; }
.record-url-link { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--ui-accent); }
.record-editor { padding: 20px; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-surface); }
.record-editor .el-select, .record-editor :deep(.el-date-editor) { width: 100%; }
.tags-editor { width: 100%; display: grid; gap: 8px; }
.tags-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.url-editor { width: 100%; display: flex; align-items: center; gap: 10px; }
.url-editor a { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font-size: 12.5px; color: var(--ui-accent); }
.unknown-operation-box { margin: 8px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--el-color-warning, #e6a23c) 45%, var(--ui-border)); background: color-mix(in srgb, var(--el-color-warning, #e6a23c) 8%, var(--ui-surface)); }
.unknown-operation-box small { color: var(--ui-muted); font-size: 11.5px; }
a { color: var(--ui-accent); }
@media (max-width: 850px) {
  .records-layout.is-editing { grid-template-columns: 1fr; }
}
</style>

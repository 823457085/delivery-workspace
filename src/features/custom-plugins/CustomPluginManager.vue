<script setup lang="ts">
import WorkspaceMenuSettings from './WorkspaceMenuSettings.vue';
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { customPluginsQueryKey, pluginRequest } from './api';
import type { CustomPluginInfo, CustomPluginManifest, CustomPluginUpgradePreview, PluginCapability } from '../../../shared/custom-plugins';

const emit = defineEmits<{ changed: [] }>();
const router = useRouter();
const queryClient = useQueryClient();
const directory = ref('');
const busy = ref(false);
const data = ref<{
  plugins: CustomPluginInfo[];
  removedPlugins?: { id: string; name: string; version: string; source: string; digest: string }[];
  errors: { id: string; message: string }[];
  examples: { name: string; directory: string }[];
}>({ plugins: [], removedPlugins: [], errors: [], examples: [] });

const showInMenu = ref(true);
const grantTarget = ref<CustomPluginInfo>();
const selectedGrants = ref<PluginCapability[]>([]);
const inspected = ref<{ manifest: CustomPluginManifest; source: string; digest: string }>();
const upgradePreview = ref<CustomPluginUpgradePreview>();
const dropRemovedFields = ref(false);
const grants = ref<PluginCapability[]>([]);

const labels: Record<PluginCapability, string> = {
  'storage.read': '读取插件私有数据',
  'storage.write': '修改插件私有数据',
  'workspace.todos.read': '读取个人待办',
  'workspace.todos.write': '修改个人待办',
  'jira.read': '读取 Jira 项目和任务',
  'jira.create': '经确认创建 Jira 任务',
  'conversation.context': '提供会话上下文',
};

const allExamples = computed(() => {
  const base = data.value.examples || [];
  const sample = base.find(item => item.directory.endsWith('/plugins/todos'));
  if (!sample) return base;
  const pluginsRoot = sample.directory.slice(0, -'/todos'.length);
  const bundled = [
    { name: '待办事项', directory: `${pluginsRoot}/todos` },
    { name: '轻量需求台账', directory: `${pluginsRoot}/requirement-ledger` },
    { name: '发版检查清单', directory: `${pluginsRoot}/release-checklist` },
    { name: '缺陷复盘台账', directory: `${pluginsRoot}/bug-retrospective` },
    { name: '项目备忘示例', directory: `${pluginsRoot}/example-notes` },
  ];
  const seen = new Set(base.map(item => item.directory));
  return [...base, ...bundled.filter(item => !seen.has(item.directory))];
});

async function load() {
  data.value = await pluginRequest();
  queryClient.setQueryData(customPluginsQueryKey, data.value);
  emit('changed');
}

async function run(work: () => Promise<void>) {
  busy.value = true;
  try {
    await work();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '插件操作失败');
  } finally {
    busy.value = false;
  }
}

async function inspect() {
  inspected.value = undefined;
  upgradePreview.value = undefined;
  dropRemovedFields.value = false;
  showInMenu.value = true;
  await run(async () => {
    const dir = directory.value.trim();
    const candidate = await pluginRequest<{ manifest: CustomPluginManifest; source: string; digest: string }>('inspect', { directory: dir });
    const existingActive = data.value.plugins.find(item => item.manifest.id === candidate.manifest.id);
    const existingRemoved = data.value.removedPlugins?.find(item => item.id === candidate.manifest.id);
    if (existingActive || (existingRemoved && existingRemoved.digest !== candidate.digest)) {
      const preview = await pluginRequest<CustomPluginUpgradePreview>('upgrade-preview', {
        id: candidate.manifest.id,
        directory: dir,
      });
      upgradePreview.value = preview;
      showInMenu.value = preview.showInMenu;
      const retained = new Set(preview.currentGrants);
      const newlyAdded = candidate.manifest.permissions.filter(p => !(existingActive?.manifest.permissions || []).includes(p));
      grants.value = [...new Set([...retained, ...(existingActive ? newlyAdded : candidate.manifest.permissions)])];
      return;
    }
    if (existingRemoved) {
      showInMenu.value = true;
    }
    inspected.value = candidate;
    grants.value = [...candidate.manifest.permissions];
  });
}

async function checkPluginUpgrade(plugin: CustomPluginInfo) {
  inspected.value = undefined;
  upgradePreview.value = undefined;
  dropRemovedFields.value = false;
  await run(async () => {
    const preview = await pluginRequest<CustomPluginUpgradePreview>('upgrade-preview', {
      id: plugin.manifest.id,
      directory: plugin.source,
    });
    if (!preview.changed) {
      ElMessage.info(`「${plugin.manifest.name}」当前已是最新声明（v${plugin.manifest.version}）`);
      return;
    }
    upgradePreview.value = preview;
    showInMenu.value = preview.showInMenu;
    const newlyAdded = preview.manifest.permissions.filter(p => !plugin.manifest.permissions.includes(p));
    grants.value = [...new Set([...preview.currentGrants, ...newlyAdded])];
  });
}

async function restoreRemoved(item: { id: string; source: string }) {
  directory.value = item.source;
  await inspect();
}

async function install() {
  if (!inspected.value) return;
  await run(async () => {
    await pluginRequest('install', {
      directory: inspected.value!.source,
      digest: inspected.value!.digest,
      grants: grants.value,
      confirmed: true,
      showInMenu: showInMenu.value,
    });
    inspected.value = undefined;
    await load();
    ElMessage.success('插件已添加并生效');
  });
}

async function confirmUpgrade() {
  if (!upgradePreview.value) return;
  await run(async () => {
    await pluginRequest('upgrade', {
      id: upgradePreview.value!.id,
      directory: upgradePreview.value!.source,
      digest: upgradePreview.value!.digest,
      grants: grants.value,
      confirmed: true,
      dropRemovedFields: dropRemovedFields.value,
      showInMenu: showInMenu.value,
    });
    const name = upgradePreview.value!.manifest.name;
    const toVersion = upgradePreview.value!.toVersion;
    upgradePreview.value = undefined;
    dropRemovedFields.value = false;
    await load();
    ElMessage.success(`「${name}」已安全迁移并升级至 v${toVersion}`);
  });
}

async function change(plugin: CustomPluginInfo, remove = false) {
  if (remove) {
    try {
      await ElMessageBox.confirm('移除插件入口并停用其能力，保留业务数据和历史引用。', '移除插件', { type: 'warning' });
    } catch {
      return;
    }
  }
  await run(async () => {
    await pluginRequest(`${plugin.manifest.id}/change`, remove ? { remove: true } : { enabled: !plugin.enabled });
    await load();
  });
}

async function changeMenu(plugin: CustomPluginInfo, value: boolean) {
  await run(async () => {
    await pluginRequest(`${plugin.manifest.id}/change`, { showInMenu: value });
    await load();
  });
}

async function saveGrants() {
  if (!grantTarget.value) return;
  await run(async () => {
    await pluginRequest(`${grantTarget.value!.manifest.id}/change`, { grants: selectedGrants.value });
    grantTarget.value = undefined;
    await load();
  });
}

onMounted(() => run(load));
</script>

<template>
  <section class="surface manager">
    <div class="surface-header">
      <div>
        <h2>自定义功能插件</h2>
        <p>添加需求台账、发版清单、缺陷复盘等功能，按需授权工作台能力，支持声明原地升级与安全数据迁移。</p>
      </div>
      <div class="plugin-controls">
        <WorkspaceMenuSettings />
        <el-button :loading="busy" @click="run(load)">刷新</el-button>
      </div>
    </div>

    <div class="manager-body">
      <p v-for="error in data.errors" :key="error.id" class="plugin-error-banner">{{ error.id }} · {{ error.message }}</p>

      <div class="install-row">
        <el-input v-model="directory" aria-label="插件目录" placeholder="本机插件目录的绝对路径" :disabled="busy" @keydown.enter.prevent="directory.trim() && inspect()" />
        <el-button :disabled="!directory.trim() || busy" @click="inspect">检查插件</el-button>
      </div>

      <p class="examples">
        内附插件包（点击一键读取并安装/检查更新）：
        <el-button v-for="example in allExamples" :key="example.directory" link type="primary" @click="directory = example.directory; inspect()">
          {{ example.name }}
        </el-button>
      </p>

      <div v-if="inspected" class="package-preview">
        <h3>{{ inspected.manifest.name }} · v{{ inspected.manifest.version }}</h3>
        <p>{{ inspected.manifest.description }}</p>
        <p class="preview-meta">来源：{{ inspected.source }} · 字段数：{{ inspected.manifest.records.fields.length }}</p>
        <p>选择允许使用的宿主能力。未授权的能力会被拒绝；Jira 写入仍需每次预览确认。</p>
        <el-checkbox-group v-model="grants">
          <el-checkbox v-for="permission in inspected.manifest.permissions" :key="permission" :value="permission">
            {{ labels[permission] }}
          </el-checkbox>
        </el-checkbox-group>
        <div class="menu-setting">
          <el-checkbox v-model="showInMenu" :disabled="busy">在主菜单显示</el-checkbox>
        </div>
        <div class="preview-actions">
          <el-button type="primary" :disabled="busy" @click="install">确认授权并添加</el-button>
          <el-button @click="inspected = undefined">取消</el-button>
        </div>
      </div>

      <div v-if="upgradePreview" class="package-preview upgrade-preview">
        <div class="upgrade-head">
          <h3>{{ upgradePreview.manifest.name }} · {{ upgradePreview.wasRemoved ? '恢复并迁移声明' : '插件声明升级预览' }}</h3>
          <span class="version-pill">v{{ upgradePreview.fromVersion }} → v{{ upgradePreview.toVersion }}</span>
        </div>
        <p>{{ upgradePreview.manifest.description }}</p>
        <p class="preview-meta">
          来源：{{ upgradePreview.source }} · 现有记录：{{ upgradePreview.recordCount }} 条
          <span v-if="!upgradePreview.changed">（声明摘要未变化）</span>
        </p>

        <div v-if="upgradePreview.addedFields.length || upgradePreview.updatedFields.length || upgradePreview.removedFields.length" class="migration-diff">
          <p v-if="upgradePreview.addedFields.length">
            <strong>新增字段（自动补齐默认值）：</strong>
            {{ upgradePreview.addedFields.map(f => `${f.label}(${f.key}:${f.type})`).join('、') }}
          </p>
          <p v-if="upgradePreview.updatedFields.length">
            <strong>变更字段：</strong>
            {{ upgradePreview.updatedFields.map(f => `${f.label}(${f.fromType}→${f.toType}${f.required ? '·必填' : ''})`).join('、') }}
          </p>
          <p v-if="upgradePreview.removedFields.length" class="diff-warn">
            <strong>移除字段：</strong>
            {{ upgradePreview.removedFields.map(f => `${f.label}(${f.key})`).join('、') }}
          </p>
        </div>

        <div v-if="!upgradePreview.compatible" class="incompatible-box" role="alert">
          <strong>检测到历史数据与新声明不兼容，已阻止破坏性覆盖：</strong>
          <ul>
            <li v-for="item in upgradePreview.incompatibleRecords" :key="item.id">
              「{{ item.title }}」：{{ item.reason }}
            </li>
          </ul>
        </div>

        <div v-if="upgradePreview.affectedRemovedFieldCount > 0" class="menu-setting">
          <el-checkbox v-model="dropRemovedFields" :disabled="busy">
            确认清理 {{ upgradePreview.affectedRemovedFieldCount }} 条历史记录中被移除字段的数据
          </el-checkbox>
        </div>

        <el-checkbox-group v-model="grants">
          <el-checkbox v-for="permission in upgradePreview.manifest.permissions" :key="permission" :value="permission">
            {{ labels[permission] }}
          </el-checkbox>
        </el-checkbox-group>
        <div class="menu-setting">
          <el-checkbox v-model="showInMenu" :disabled="busy">在主菜单显示</el-checkbox>
        </div>
        <div class="preview-actions">
          <el-button
            type="primary"
            :disabled="busy || !upgradePreview.compatible || (upgradePreview.affectedRemovedFieldCount > 0 && !dropRemovedFields)"
            @click="confirmUpgrade"
          >
            {{ upgradePreview.wasRemoved ? '确认迁移并恢复插件' : '确认迁移并升级声明' }}
          </el-button>
          <el-button @click="upgradePreview = undefined">取消</el-button>
        </div>
      </div>

      <el-skeleton v-if="busy && !data.plugins.length" :rows="3" animated />
      <el-empty v-else-if="!data.plugins.length" class="manager-empty" description="尚未添加自定义插件。填写本机插件目录，或选择上方内附插件包一键开始。" :image-size="36" />

      <div v-for="plugin in data.plugins" :key="plugin.manifest.id" class="plugin-row">
        <div>
          <strong>{{ plugin.manifest.name }}</strong>
          <span class="plugin-submeta"> · v{{ plugin.manifest.version }} · {{ plugin.enabled ? '已启用' : '已停用' }}</span>
          <p>{{ plugin.manifest.description }}</p>
          <small>{{ plugin.source }}</small>
          <p v-if="plugin.error" class="plugin-error-banner">{{ plugin.error }}</p>
        </div>
        <div class="plugin-controls">
          <el-switch
            :model-value="plugin.showInMenu"
            :disabled="busy"
            active-text="在主菜单显示"
            :aria-label="`${plugin.manifest.name}在主菜单显示`"
            @change="changeMenu(plugin, Boolean($event))"
          />
          <el-button :disabled="busy || !plugin.enabled" @click="router.push({ path: '/agent', query: { view: 'plugins', plugin: plugin.manifest.id } })">打开</el-button>
          <el-button :disabled="busy" @click="checkPluginUpgrade(plugin)">检查更新</el-button>
          <el-button :disabled="busy" @click="change(plugin)">{{ plugin.enabled ? '停用' : '启用' }}</el-button>
          <el-button :disabled="busy" @click="grantTarget = plugin; selectedGrants = [...plugin.grants]">权限</el-button>
          <el-button type="danger" plain :disabled="busy" @click="change(plugin, true)">移除</el-button>
        </div>
      </div>

      <details v-if="data.removedPlugins?.length" class="removed-plugins">
        <summary>已移除且保留历史数据的插件（{{ data.removedPlugins.length }}）</summary>
        <div v-for="item in data.removedPlugins" :key="item.id" class="removed-row">
          <div>
            <strong>{{ item.name }}</strong>
            <span class="plugin-submeta"> · v{{ item.version }}</span>
            <small>{{ item.source }}</small>
          </div>
          <el-button size="small" :disabled="busy" @click="restoreRemoved(item)">检查并恢复</el-button>
        </div>
      </details>
    </div>

    <el-dialog :model-value="!!grantTarget" title="插件宿主能力授权" width="min(600px, 90vw)" append-to-body @update:model-value="!$event && (grantTarget = undefined)">
      <p>权限变更立即生效；已发出的外部请求无法撤回。</p>
      <el-checkbox-group v-model="selectedGrants">
        <el-checkbox v-for="permission in grantTarget?.manifest.permissions" :key="permission" :value="permission">
          {{ labels[permission] }}
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="grantTarget = undefined">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveGrants">确认保存权限</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.manager { margin-bottom: 16px; }
.manager-body { padding: 14px; display: grid; gap: 12px; }
.install-row, .plugin-row, .removed-row { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.plugin-row { padding: 12px 14px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 8px); flex-wrap: wrap; }
.plugin-row p, .manager p { color: var(--ui-muted); line-height: 1.55; }
.plugin-row small, .removed-row small { display: block; color: var(--ui-muted); overflow-wrap: anywhere; }
.plugin-submeta { font-size: 12px; color: var(--ui-muted); }
.plugin-error-banner { color: var(--ui-danger, #ef4444) !important; }
.package-preview { padding: 12px 14px; background: var(--ui-raised); border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 8px); display: grid; gap: 8px; }
.package-preview h3 { margin: 0; font-size: 14px; }
.package-preview p { margin: 0; font-size: 12.5px; }
.preview-meta { font-size: 11.5px !important; }
.preview-actions { display: flex; gap: 8px; align-items: center; }
.upgrade-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.version-pill { padding: 2px 8px; border-radius: 999px; background: var(--ui-accent-soft); color: var(--ui-accent); font: 600 11px/1.5 var(--mono); }
.migration-diff { padding: 10px 12px; border-radius: 8px; background: var(--ui-surface); border: 1px solid var(--ui-border); display: grid; gap: 4px; }
.migration-diff strong { color: var(--ui-text); }
.diff-warn strong { color: var(--ui-warning, #f59e0b); }
.incompatible-box { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--ui-danger, #ef4444); background: color-mix(in srgb, var(--ui-danger, #ef4444) 10%, var(--ui-surface)); color: var(--ui-text); font-size: 12.5px; }
.incompatible-box ul { margin: 6px 0 0; padding-left: 18px; }
.plugin-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.plugin-controls :deep(.el-button) { margin: 0; }
.plugin-controls :deep(.el-switch) { margin-right: 12px; }
.manager-body > p { margin: 0; font-size: 12px; }
.examples { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.examples :deep(.el-button) {
  margin: 0;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 12px;
  font-weight: 500;
}
.examples :deep(.el-button:hover) {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.manager-empty {
  padding: 16px 12px !important;
  border: 1px dashed var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: color-mix(in srgb, var(--ui-raised) 55%, var(--ui-surface));
}
.manager-empty :deep(.el-empty__description) { margin-top: 8px; }
.manager-empty :deep(.el-empty__description p) { font-size: 12px; color: var(--ui-muted); }
.removed-plugins { padding: 10px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; font-size: 12.5px; }
.removed-plugins > summary { cursor: pointer; color: var(--ui-muted); font-weight: 500; }
.removed-row { padding-top: 10px; margin-top: 10px; border-top: 1px solid var(--ui-border); flex-wrap: wrap; }
@media (max-width: 600px) {
  .install-row { flex-wrap: wrap; }
  .install-row > .el-input { flex-basis: 100%; }
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { normalizePluginTags, type CustomPluginField, type CustomPluginInfo, type PluginRecord } from '../../../shared/custom-plugins';
import { safeUrl } from '../../shared/format';
import { customPluginsQueryKey, pluginRequest } from './api';

const props = defineProps<{
  initialPluginId?: string;
  initialRecordId?: string;
  initialValues: Record<string, string>;
  heading?: string;
}>();

const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{
  saved: [payload: { pluginId: string; pluginName: string; recordId: string; title: string }];
}>();

const router = useRouter();
const queryClient = useQueryClient();
const loading = ref(false);
const saving = ref(false);
const plugins = ref<CustomPluginInfo[]>([]);
const selectedPluginId = ref('');
const existingRecord = ref<(PluginRecord & { version: string }) | undefined>();
const form = ref<Record<string, string>>({});
const tagDrafts = ref<Record<string, string>>({});

const writablePlugins = computed(() => plugins.value.filter(plugin =>
  plugin.enabled && !plugin.error && plugin.grants.includes(plugin.manifest.records.storage === 'private' ? 'storage.write' : 'workspace.todos.write')));

const selectedPlugin = computed(() => writablePlugins.value.find(plugin => plugin.manifest.id === selectedPluginId.value));

function populateForm(plugin: CustomPluginInfo | undefined, baseValues?: Record<string, string>) {
  tagDrafts.value = {};
  if (!plugin) {
    form.value = {};
    return;
  }
  const fields = plugin.manifest.records.fields;
  const next: Record<string, string> = {};
  const incoming = props.initialValues || {};
  const fallbackTextareaKey = !fields.some(f => f.key === 'details')
    ? fields.find(f => f.type === 'textarea')?.key
    : undefined;

  for (const field of fields) {
    const fromExisting = baseValues?.[field.key];
    let candidate = Object.hasOwn(incoming, field.key) ? incoming[field.key] : undefined;
    if (candidate === undefined && field.key === fallbackTextareaKey && incoming.details) {
      candidate = incoming.details;
    }
    const raw = candidate ?? fromExisting ?? field.default ?? '';
    next[field.key] = field.type === 'checkbox'
      ? (raw === 'true' ? 'true' : 'false')
      : raw.slice(0, field.maxLength);
  }
  form.value = next;
}

async function syncTargetPlugin(pluginId: string) {
  const plugin = writablePlugins.value.find(item => item.manifest.id === pluginId);
  existingRecord.value = undefined;
  if (!plugin) {
    populateForm(undefined);
    return;
  }
  if (props.initialRecordId && props.initialPluginId === pluginId) {
    try {
      const res = await pluginRequest<{ items: (PluginRecord & { version: string })[] }>(`${pluginId}/records`);
      const found = res.items.find(item => item.id === props.initialRecordId);
      existingRecord.value = found;
      populateForm(plugin, found?.values);
      return;
    } catch {
      existingRecord.value = undefined;
    }
  }
  populateForm(plugin);
}

watch(open, async visible => {
  if (!visible) return;
  loading.value = true;
  try {
    const res = await pluginRequest<{ plugins: CustomPluginInfo[] }>();
    plugins.value = res.plugins || [];
    const preferred = props.initialPluginId && writablePlugins.value.some(p => p.manifest.id === props.initialPluginId)
      ? props.initialPluginId
      : writablePlugins.value[0]?.manifest.id || '';
    selectedPluginId.value = preferred;
    await syncTargetPlugin(preferred);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取可用插件失败');
  } finally {
    loading.value = false;
  }
}, { immediate: true });

function onPluginChange(nextId: string) {
  selectedPluginId.value = nextId;
  void syncTargetPlugin(nextId);
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

async function submit() {
  const plugin = selectedPlugin.value;
  if (!plugin || saving.value) return;
  saving.value = true;
  try {
    const saved = await pluginRequest<PluginRecord>(`${plugin.manifest.id}/save`, {
      ...(existingRecord.value ? { id: existingRecord.value.id, expectedVersion: existingRecord.value.version } : {}),
      values: form.value,
    });
    await queryClient.invalidateQueries({ queryKey: customPluginsQueryKey });
    emit('saved', {
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
      recordId: saved.id,
      title: saved.values.title || saved.id,
    });
    open.value = false;
    ElMessage.success(`已写入「${plugin.manifest.name}」`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存台账事项失败');
  } finally {
    saving.value = false;
  }
}

function openPluginCenter() {
  open.value = false;
  void router.push({ path: '/agent', query: { view: 'settings', settingsTab: 'plugins' } });
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="heading || '确认写入自定义插件台账'"
    width="min(680px, 94vw)"
    append-to-body
    :close-on-click-modal="false"
  >
    <el-skeleton v-if="loading" :rows="4" animated />
    <el-empty
      v-else-if="!writablePlugins.length"
      description="当前没有已启用且授予写入权限的自定义插件（如缺陷复盘台账、轻量需求台账、待办事项）。"
      :image-size="48"
    >
      <el-button type="primary" @click="openPluginCenter">前往插件中心启用或添加</el-button>
    </el-empty>
    <el-form v-else label-position="top" :disabled="saving" class="plugin-save-form">
      <p class="plugin-save-hint">
        Agent 内容仅作为草稿预填，核对无误后点击下方确认按钮才会写入本机台账。
        <span v-if="existingRecord">（将更新现有事项：{{ existingRecord.values.title }}）</span>
      </p>
      <el-form-item label="目标插件台账" required>
        <el-select :model-value="selectedPluginId" @change="onPluginChange">
          <el-option
            v-for="item in writablePlugins"
            :key="item.manifest.id"
            :value="item.manifest.id"
            :label="`${item.manifest.name}（${item.manifest.version}）`"
          />
        </el-select>
      </el-form-item>

      <template v-if="selectedPlugin">
        <el-form-item
          v-for="field in selectedPlugin.manifest.records.fields"
          :key="field.key"
          :label="field.label"
          :required="field.required"
        >
          <el-select v-if="field.type === 'select'" v-model="form[field.key]" clearable>
            <el-option v-for="option in field.options" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
          <el-date-picker
            v-else-if="field.type === 'date'"
            v-model="form[field.key]"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="YYYY-MM-DD"
            @clear="form[field.key] = ''"
          />
          <el-switch
            v-else-if="field.type === 'checkbox'"
            :model-value="form[field.key] === 'true'"
            active-text="是"
            inactive-text="否"
            @change="form[field.key] = $event ? 'true' : 'false'"
          />
          <div v-else-if="field.type === 'tags'" class="plugin-tags-input">
            <div v-if="fieldTags(field.key).length" class="plugin-tags-chips">
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
            <div class="plugin-tags-entry">
              <el-input
                v-model="tagDrafts[field.key]"
                placeholder="输入标签后按回车，或用逗号分隔"
                @keydown.enter.prevent="appendTag(field)"
                @blur="appendTag(field)"
              />
            </div>
          </div>
          <div v-else-if="field.type === 'url'" class="plugin-url-input">
            <el-input v-model="form[field.key]" type="url" placeholder="https://..." :maxlength="field.maxLength" />
            <a v-if="safeUrl(form[field.key])" :href="safeUrl(form[field.key])" target="_blank" rel="noopener noreferrer">打开</a>
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
            :rows="field.type === 'textarea' ? 5 : undefined"
            :maxlength="field.maxLength"
          />
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="open = false">取消</el-button>
      <el-button v-if="writablePlugins.length" type="primary" :loading="saving" @click="submit">
        {{ existingRecord ? '确认更新事项' : '确认写入台账' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.plugin-save-hint { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--ui-muted); }
.plugin-save-form :deep(.el-select), .plugin-save-form :deep(.el-date-editor) { width: 100%; }
.plugin-tags-input { width: 100%; display: grid; gap: 8px; }
.plugin-tags-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.plugin-url-input { width: 100%; display: flex; align-items: center; gap: 10px; }
.plugin-url-input a { flex-shrink: 0; font-size: 12px; color: var(--ui-accent); }
</style>

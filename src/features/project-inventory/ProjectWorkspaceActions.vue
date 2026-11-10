<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { WorkspaceRemovalPreview } from '../../../shared/project-workspaces';

const props = defineProps<{ path: string; revision?: string; disabled?: boolean }>();
const emit = defineEmits<{ removed: [path: string]; busy: [value: boolean] }>();
const preview = shallowRef<WorkspaceRemovalPreview>();
const loading = shallowRef(false), action = shallowRef(''), scheduleOpen = shallowRef(false);
const deleteAt = shallowRef<Date>();
const busy = computed(() => !!action.value);
const canSave = computed(() => !props.disabled && !loading.value && !busy.value && !!preview.value?.canSchedule && !!preview.value.revision
  && deleteAt.value instanceof Date && Number.isFinite(deleteAt.value.getTime()) && deleteAt.value.getTime() > Date.now());
const activeRule = computed(() => preview.value?.rule?.status !== 'deleted' ? preview.value?.rule : undefined);
const deadlineLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
let requestId = 0, selection = 0;
let controller: AbortController | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const removedPaths = new Set<string>();
function notifyRemoved(path: string) {
  if (removedPaths.has(path)) return;
  removedPaths.add(path); emit('removed', path);
}

async function loadPreview(background = false) {
  const path = props.path, request = ++requestId;
  controller?.abort(); controller = new AbortController();
  loading.value = true;
  try {
    const response = await fetch(`/api/projects/workspaces?path=${encodeURIComponent(path)}`, { signal: controller.signal });
    const data = await response.json();
    if (request !== requestId || path !== props.path) return;
    if (!response.ok) throw new Error(data.message || '工作区删除状态读取失败');
    if (background && (scheduleOpen.value || busy.value || props.disabled)) return;
    preview.value = data;
    deleteAt.value = activeRule.value ? new Date(activeRule.value.deleteAt) : undefined;
    if (data.rule?.status === 'deleted') notifyRemoved(path);
  } catch (error) {
    if (request === requestId && path === props.path && !(error instanceof Error && error.name === 'AbortError')) {
      preview.value = undefined;
      ElMessage.error(error instanceof Error ? error.message : '工作区删除状态读取失败');
    }
  } finally { if (request === requestId && path === props.path) loading.value = false; }
}

async function submit(kind: 'delete' | 'schedule' | 'cancel') {
  const current = preview.value;
  if (busy.value || loading.value || props.disabled || !current || (kind === 'delete' && !current.eligible && !current.requiresDiscardChanges)) return;
  if (kind === 'schedule' && !canSave.value) return;
  const discardChanges = kind === 'delete' && current.requiresDiscardChanges;
  const path = props.path, version = selection;
  const name = current.path.replace(/\/$/, '').split('/').at(-1)!;
  const deadline = kind === 'schedule' ? deleteAt.value!.toISOString() : null;
  action.value = kind; emit('busy', true);
  try {
    let confirmName: string | undefined;
    if (kind !== 'cancel') {
      const impact = kind === 'delete' ? (discardChanges ? '将删除本地工作区并丢弃暂存、未暂存、未跟踪文件及未完成的合并，无法恢复。' : '将立即删除本地工作区目录，无法恢复。')
        : `将在 ${deadlineLabel(deadline!)} 删除本地工作区目录，无法恢复。`;
      try {
        const confirmed = await ElMessageBox.prompt(`${impact}\n${current.path}\n请输入目录名“${name}”确认。`,
          kind === 'delete' ? '删除工作区' : '设置自动删除', {
            type: 'warning', inputPlaceholder: name, confirmButtonText: kind === 'delete' ? (discardChanges ? '丢弃改动并删除' : '确认删除') : '确认设置',
            cancelButtonText: '取消', closeOnClickModal: false,
            inputValidator: (value: string) => value === name || '请输入完整且一致的目录名',
          });
        confirmName = confirmed.value;
      } catch { return; }
    }
    if (path !== props.path || version !== selection || current.revision !== preview.value?.revision) return;
    const response = await fetch(`/api/projects/workspaces/${kind === 'delete' ? 'delete' : 'schedule'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ path, revision: current.revision, ...(kind === 'delete' ? {} : { deleteAt: deadline }),
        ...(discardChanges ? { discardChanges: true } : {}),
        ...(confirmName !== undefined ? { confirmName } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '工作区操作失败');
    if (kind === 'delete') {
      ElMessage.success('工作区已删除');
      notifyRemoved(path);
    } else if (path === props.path && version === selection) {
      ElMessage.success(kind === 'cancel' ? '已取消自动删除' : '自动删除时间已保存');
      scheduleOpen.value = false;
      await loadPreview();
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '工作区操作失败'); }
  finally { action.value = ''; emit('busy', false); }
}

watch(() => [props.path, props.revision] as const, ([path], previous) => {
  if (path !== previous?.[0]) {
    ++selection; preview.value = undefined; deleteAt.value = undefined; scheduleOpen.value = false;
  }
  if (path) void loadPreview();
}, { immediate: true });
watch([() => props.path, () => !!activeRule.value], ([, enabled]) => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = enabled ? setInterval(() => {
    if (!scheduleOpen.value && !busy.value && !loading.value && !props.disabled) void loadPreview(true);
  }, 15_000) : undefined;
});
onBeforeUnmount(() => { ++selection; ++requestId; controller?.abort(); if (refreshTimer) clearInterval(refreshTimer); emit('busy', false); });
</script>

<template>
  <div class="workspace-actions" aria-label="工作区删除管理">
    <el-button size="small" type="danger" plain :loading="action === 'delete'"
      :disabled="disabled || loading || busy || !(preview?.eligible || preview?.requiresDiscardChanges)" :title="preview?.reason || '删除选中的本地工作区'" @click="submit('delete')">删除工作区</el-button>
    <el-popover v-model:visible="scheduleOpen" trigger="click" placement="bottom-end" :width="320" :show-arrow="false">
      <template #reference><el-button size="small" :disabled="disabled || loading || busy || !preview">自动删除</el-button></template>
      <section class="workspace-schedule" aria-label="设置工作区自动删除时间">
        <strong>自动删除当前工作区</strong>
        <el-text size="small">到期后删除本地目录，无法恢复。有改动、未推送提交或正在使用时跳过。工作台关闭后，会在下次启动时检查。</el-text>
        <el-text v-if="activeRule" size="small">已设置：{{ deadlineLabel(activeRule.deleteAt) }}</el-text>
        <el-text v-if="activeRule?.message || preview?.reason" size="small" type="info">{{ activeRule?.message || preview?.reason }}</el-text>
        <el-date-picker v-model="deleteAt" type="datetime" size="small" format="YYYY-MM-DD HH:mm:ss"
          aria-label="自动删除日期和时间" placeholder="选择删除日期和时间" :disabled="busy || disabled" />
        <div class="workspace-schedule-actions">
          <el-button v-if="activeRule" size="small" :loading="action === 'cancel'" :disabled="busy || disabled || loading" @click="submit('cancel')">取消自动删除</el-button>
          <el-button size="small" type="primary" :loading="action === 'schedule'" :disabled="!canSave" @click="submit('schedule')">保存时间</el-button>
        </div>
      </section>
    </el-popover>
    <el-text v-if="activeRule" size="small" :title="activeRule.message">自动删除：{{ deadlineLabel(activeRule.deleteAt) }}</el-text>
  </div>
</template>

<style scoped>
.workspace-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.workspace-actions :deep(.el-button){margin:0}.workspace-actions>.el-text{max-width:100%;overflow-wrap:anywhere}
.workspace-schedule{display:flex;flex-direction:column;gap:12px}.workspace-schedule strong{font-size:13px}.workspace-schedule>.el-text{align-self:stretch;line-height:1.6}.workspace-schedule :deep(.el-date-editor){width:100%}.workspace-schedule-actions{display:flex;justify-content:flex-end;gap:6px}.workspace-schedule-actions :deep(.el-button){margin:0}
</style>

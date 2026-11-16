<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { SessionWorkspaceUsage } from '../../../shared/project-workspaces';
import ProjectWorkspaceActions from '../project-inventory/ProjectWorkspaceActions.vue';

const entries = shallowRef<SessionWorkspaceUsage[]>();
const scanning = ref(false);
const actionBusy = ref(false);
const selectedPath = ref('');
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function formatTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? timeFormat.format(time) : '—';
}

function formatSize(bytes: number | null) {
  if (bytes === null) return '未统计';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (index < units.length - 1 && bytes >= 1024) {
    bytes /= 1024;
    index++;
  }
  return `${Math.round(bytes * 10) / 10} ${units[index]}`;
}

async function scan() {
  if (scanning.value || actionBusy.value) return;
  scanning.value = true;
  selectedPath.value = '';
  try {
    const res = await fetch('/api/projects/workspaces/session-inventory');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '扫描会话工作区失败');
    entries.value = data.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '扫描会话工作区失败');
  } finally {
    scanning.value = false;
  }
}

function removeEntry(folder: string) {
  entries.value = entries.value?.filter(entry => entry.path !== folder);
  selectedPath.value = '';
}
</script>

<template>
  <section class="surface session-workspaces" aria-label="会话工作区盘点">
    <div class="surface-header session-workspaces-header">
      <div>
        <h2>会话工作区盘点</h2>
        <p>查看会话关联的 worktree、磁盘占用和最近活动。清理后仍保留 Git 分支和会话记录。</p>
      </div>
      <el-button :loading="scanning" :disabled="actionBusy" @click="scan">扫描工作区</el-button>
    </div>
    <el-table v-if="entries" v-loading="scanning" :data="entries" row-key="path" max-height="480"
      empty-text="没有找到会话关联的 worktree">
      <el-table-column label="工作区" min-width="235">
        <template #default="{ row }">
          <strong>{{ row.branch || '分支未知' }}</strong>
          <div class="workspace-path">{{ row.path }}</div>
        </template>
      </el-table-column>
      <el-table-column label="磁盘占用" width="94">
        <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
      </el-table-column>
      <el-table-column label="关联会话" min-width="175">
        <template #default="{ row }">
          <details>
            <summary>{{ row.sessions.length }} 个会话 · {{ formatTime(row.sessions[0].updatedAt) }}</summary>
            <ul class="session-titles">
              <li v-for="session in row.sessions" :key="session.id">{{ session.title }} · {{ formatTime(session.updatedAt) }}</li>
            </ul>
          </details>
        </template>
      </el-table-column>
      <el-table-column label="清理状态" min-width="180">
        <template #default="{ row }">{{ row.eligible ? '可清理' : row.reason || '受保护' }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="155">
        <template #default="{ row }">
          <template v-if="row.path === selectedPath">
            <ProjectWorkspaceActions :key="row.path" :path="row.path" session-worktree
              @busy="actionBusy = $event" @removed="removeEntry" />
            <el-button link size="small" :disabled="actionBusy" @click="selectedPath = ''">取消选择</el-button>
          </template>
          <el-button v-else-if="row.eligible" link type="primary" :disabled="actionBusy || scanning"
            @click="selectedPath = row.path">选择清理</el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.session-workspaces { margin-top: 18px; }
.session-workspaces-header { gap: 14px; flex-wrap: wrap; }
.session-workspaces-header p { margin: 4px 0 0; color: var(--ui-muted); }
.workspace-path { overflow-wrap: anywhere; color: var(--ui-muted); }
.session-titles { margin: 4px 0; padding-inline-start: 18px; }
summary { cursor: pointer; }
</style>

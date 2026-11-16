<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import { HardDrive, RefreshCw, Sparkles } from '@lucide/vue';
import type {
  WorkspaceStorageBucketId,
  WorkspaceStorageReclaimResult,
  WorkspaceStorageReport,
} from '../../../shared/storage-governance';
import { dateTime } from '../../shared/format';

const report = shallowRef<WorkspaceStorageReport>();
const loading = shallowRef(false);
const reclaiming = shallowRef(false);
const errorText = shallowRef('');
const lastResult = shallowRef<WorkspaceStorageReclaimResult>();

const selected = reactive<Record<WorkspaceStorageBucketId, boolean>>({
  artifactBloat: true,
  verificationWorktrees: true,
  orphanWorkspaces: true,
  finishedTeamDependencies: true,
  browserAndRetestCaches: true,
});

const ledgerLabels: Record<string, string> = {
  'agent-runs.json': '对话记录',
  'collaboration-state.json': '协作进度',
  'team-tasks.json': '团队任务',
  'group-chat.json': '群聊记录',
  'agent-usage-daily.json': '每日用量',
  'sessions/': '会话上下文',
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

const selectedReclaimableBytes = computed(() => {
  if (!report.value) return 0;
  return report.value.buckets
    .filter(bucket => selected[bucket.id])
    .reduce((sum, bucket) => sum + bucket.reclaimableBytes, 0);
});

async function loadStorage(force = false) {
  if (loading.value || reclaiming.value) return;
  loading.value = true;
  errorText.value = '';
  try {
    const response = await fetch(`/api/workspace/storage${force ? '?force=1' : ''}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || '读取存储空间占用失败');
    report.value = payload as WorkspaceStorageReport;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '读取存储空间占用失败';
  } finally {
    loading.value = false;
  }
}

async function reclaimStorage() {
  if (reclaiming.value || loading.value || selectedReclaimableBytes.value <= 0) return;
  reclaiming.value = true;
  errorText.value = '';
  try {
    const response = await fetch('/api/workspace/storage/reclaim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Delivery-Confirmed': 'yes',
      },
      body: JSON.stringify({
        artifactBloat: selected.artifactBloat,
        verificationWorktrees: selected.verificationWorktrees,
        orphanWorkspaces: selected.orphanWorkspaces,
        finishedTeamDependencies: selected.finishedTeamDependencies,
        browserAndRetestCaches: selected.browserAndRetestCaches,
        minAgeHours: 24,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || '清理存储空间失败');
    const result = payload as WorkspaceStorageReclaimResult;
    lastResult.value = result;
    report.value = result.report;
    ElMessage.success(result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : '清理存储空间失败';
    errorText.value = message;
    ElMessage.error(message);
  } finally {
    reclaiming.value = false;
  }
}

onMounted(() => { void loadStorage(false); });
</script>

<template>
  <section class="surface storage-governance-card" aria-label="存储空间清理">
    <div class="surface-header storage-header">
      <div class="storage-title">
        <HardDrive :size="16" />
        <div>
          <h2>存储空间清理</h2>
          <p>一键清理历史任务留下的临时缓存与无用副本；您的聊天记录、报告、截图和代码改动都会保留。</p>
        </div>
      </div>
      <div class="storage-header-actions">
        <el-button size="small" :loading="loading" :disabled="reclaiming" @click="loadStorage(true)">
          <RefreshCw :size="13" /> 重新检查
        </el-button>
        <el-button
          type="primary"
          size="small"
          :loading="reclaiming"
          :disabled="loading || selectedReclaimableBytes <= 0"
          @click="reclaimStorage"
        >
          <Sparkles :size="13" />
          {{ selectedReclaimableBytes > 0 ? `一键清理缓存（可腾出 ${formatBytes(selectedReclaimableBytes)}）` : '当前很干净，无需清理' }}
        </el-button>
      </div>
    </div>

    <div class="surface-body">
      <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" class="storage-alert" />
      <el-alert
        v-if="lastResult && !errorText"
        :title="lastResult.message"
        type="success"
        :closable="true"
        class="storage-alert"
        @close="lastResult = undefined"
      />
      <el-skeleton v-if="loading && !report" :rows="3" animated />

      <template v-else-if="report">
        <div class="storage-summary-bar">
          <div class="storage-metric">
            <small>工作台已用空间</small>
            <strong>{{ formatBytes(report.totalBytes) }}</strong>
          </div>
          <div class="storage-metric is-accent">
            <small>可清理的闲置缓存</small>
            <strong>{{ formatBytes(report.reclaimableBytes) }}</strong>
          </div>
          <div class="storage-metric">
            <small>上次检查时间</small>
            <span>{{ dateTime(report.scannedAt) }}</span>
          </div>
        </div>

        <div class="storage-buckets">
          <article v-for="bucket in report.buckets" :key="bucket.id" class="storage-bucket">
            <div class="storage-bucket-head">
              <el-checkbox v-model="selected[bucket.id]" :disabled="reclaiming || bucket.reclaimableBytes <= 0">
                <strong>{{ bucket.label }}</strong>
              </el-checkbox>
              <div class="storage-bucket-badges">
                <el-tag v-if="bucket.reclaimableBytes > 0" size="small" type="warning">
                  可清理 {{ formatBytes(bucket.reclaimableBytes) }}（{{ bucket.reclaimableCount }} 处）
                </el-tag>
                <el-tag v-else size="small" type="info">无需清理</el-tag>
                <span class="storage-bucket-total">占用 {{ formatBytes(bucket.totalBytes) }}</span>
              </div>
            </div>
            <p class="storage-bucket-desc">{{ bucket.description }}</p>
            <el-progress
              v-if="report.totalBytes > 0"
              :percentage="Math.min(100, Math.round((bucket.totalBytes / report.totalBytes) * 100))"
              :stroke-width="6"
              :show-text="false"
            />
          </article>
        </div>

        <div v-if="report.ledgers.length" class="storage-ledgers">
          <small class="storage-ledgers-label">自动保护的数据（聊天与任务记录，不会删除）：</small>
          <span v-for="item in report.ledgers" :key="item.name" class="storage-ledger-chip" :title="item.name">
            <strong>{{ ledgerLabels[item.name] || item.name }}</strong> {{ formatBytes(item.bytes) }}
          </span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.storage-governance-card { margin-top: 18px; }
.storage-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.storage-title { display: flex; align-items: flex-start; gap: 10px; min-width: 0; flex: 1; }
.storage-title svg { flex-shrink: 0; margin-top: 3px; color: var(--ui-accent); }
.storage-title h2 { margin: 0; font-size: 14px; line-height: 20px; }
.storage-title p { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--ui-muted); }
.storage-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.storage-alert { margin-bottom: 12px; }
.storage-summary-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 8px);
  background: var(--ui-raised);
}
.storage-metric { display: flex; flex-direction: column; gap: 3px; }
.storage-metric small { font-size: 11px; color: var(--ui-muted); }
.storage-metric strong { font: 600 16px/22px var(--mono); color: var(--ui-text); }
.storage-metric.is-accent strong { color: var(--ui-accent); }
.storage-metric span { font: 500 12px/20px var(--mono); color: var(--ui-secondary); }
.storage-buckets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 10px;
}
.storage-bucket {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 8px);
  background: var(--ui-surface);
}
.storage-bucket-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.storage-bucket-badges { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.storage-bucket-total { font: 500 11px/16px var(--mono); color: var(--ui-muted); }
.storage-bucket-desc { margin: 6px 0 8px; font-size: 12px; line-height: 1.55; color: var(--ui-muted); }
.storage-ledgers { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--ui-border); }
.storage-ledgers-label { font-size: 11px; color: var(--ui-muted); }
.storage-ledger-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 5px);
  background: var(--ui-raised);
  font: 500 11px/16px var(--mono);
  color: var(--ui-secondary);
}
</style>

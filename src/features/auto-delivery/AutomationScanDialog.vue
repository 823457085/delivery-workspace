<script setup lang="ts">
import { shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { AutomationScanPreview } from '../../../shared/hub';
import { readSource, useSourceActions } from '../../shared/api';

const actions = useSourceActions();
const visible = shallowRef(false);
const loading = shallowRef(false);
const preview = shallowRef<AutomationScanPreview>();
const labels = {
  transition: '状态流转',
  'end-date': '顺延结束日期',
  'split-create': '创建切片子任务',
  'split-update': '更新切片排期',
};

async function openPreview() {
  if (loading.value || actions.pending.value) return;
  preview.value = undefined;
  visible.value = true;
  loading.value = true;
  try {
    preview.value = await readSource<AutomationScanPreview>('scan-preview', {}, undefined, true);
  } catch (error) {
    visible.value = false;
    ElMessage.error(error instanceof Error ? error.message : '巡检预览未能读取');
  } finally {
    loading.value = false;
  }
}

async function confirmScan() {
  if (!preview.value?.id || actions.pending.value) return;
  const ok = await actions.execute('scan', { previewId: preview.value.id }, '拟执行动作', '', { skipConfirm: true });
  if (ok) visible.value = false;
  preview.value = undefined;
}
</script>

<template>
  <slot :open="openPreview" :pending="loading || actions.pending.value" />
  <el-dialog v-model="visible" title="拟执行动作" width="min(780px, 94vw)" append-to-body
    :close-on-click-modal="false" :show-close="!actions.pending.value" :close-on-press-escape="!actions.pending.value">
    <el-skeleton v-if="loading" :rows="4" animated />
    <template v-else-if="preview">
      <el-empty v-if="preview.truncated" :image-size="56"
        :description="`Jira 仅返回 ${preview.issueCount} / ${preview.total} 项，本轮无法执行`" />
      <template v-else>
        <p>已核对 {{ preview.issueCount }} 项 Jira 事项，预计执行 {{ preview.actions.length }} 项 Jira 变更。</p>
        <el-table v-if="preview.actions.length" :data="preview.actions" max-height="340">
          <el-table-column prop="issueKey" label="Jira" width="116" />
          <el-table-column label="动作" width="130"><template #default="{ row }">{{ labels[row.kind as keyof typeof labels] }}</template></el-table-column>
          <el-table-column label="目标" min-width="175"><template #default="{ row }">{{ row.from ? row.from + ' → ' : '' }}{{ row.target }}</template></el-table-column>
          <el-table-column prop="reason" label="依据" min-width="170" />
        </el-table>
        <p>确认后更新本地巡检计划。<template v-if="preview.autoPrepareJiraDev">符合条件的事项会生成研发预览。</template><template v-if="preview.autoCreateCodex">待派发事项按当前策略进入任务队列或启动研发。</template><template v-if="preview.autoCreateMergeRequest">启用自动交付的任务验证通过后可提交、推送并创建合并请求。</template></p>
      </template>
    </template>
    <template #footer>
      <el-button :disabled="actions.pending.value" @click="visible = false">关闭</el-button>
      <el-button v-if="preview?.id" type="primary" :loading="actions.pending.value" @click="confirmScan">确认执行巡检</el-button>
      <el-button v-else-if="!loading" type="primary" @click="openPreview">重新预览</el-button>
    </template>
  </el-dialog>
</template>

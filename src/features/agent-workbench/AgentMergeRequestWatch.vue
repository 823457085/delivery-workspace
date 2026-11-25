<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { GitPullRequest } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { useMergeRequestWatch } from './useMergeRequestWatch';

const props = defineProps<{ conversationId: string; paths: string[]; model: ReturnType<typeof useMergeRequestWatch> }>();
const view = computed(() => props.model.lookup(props.conversationId));
const open = shallowRef(false);
const url = shallowRef('');
const path = shallowRef('');
const linking = shallowRef(false);
const stateLabel = { open: '进行中', merged: '已合并', closed: '已关闭' };
const checkLabel = { passed: '通过', failed: '失败', running: '运行中' };
const reviewLabel = { approved: '通过', pending: '等待评审', 'changes-requested': '要求修改' };

function openMenu() {
  url.value = view.value.link?.url || '';
  path.value = view.value.link?.path || props.paths[0] || '';
}
async function linkRequest() {
  linking.value = true;
  try {
    await props.model.add(props.conversationId, { path: path.value, url: url.value.trim() });
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  } finally {
    linking.value = false;
  }
}
async function refresh() {
  try { await props.model.refresh(props.conversationId); }
  catch (error) { if (error instanceof Error && error.message) ElMessage.error(error.message); }
}
</script>

<template>
  <el-popover v-model:visible="open" trigger="click" placement="bottom-end" :width="330" @show="openMenu">
    <template #reference>
      <button type="button" class="mr-watch-trigger" :aria-expanded="open" aria-label="会话合并请求" title="会话合并请求">
        <GitPullRequest :size="16" />
        <span v-if="view.status">!{{ view.status.id }}</span>
      </button>
    </template>
    <section v-if="view.link" class="mr-watch-content" aria-label="合并请求状态">
      <a :href="view.link.url" target="_blank" rel="noopener noreferrer">{{ view.status?.title || '打开合并请求' }}</a>
      <dl v-if="view.status" class="mr-watch-status">
        <dt>状态</dt><dd>{{ stateLabel[view.status.state] }}</dd>
        <template v-if="view.status.state === 'open'">
          <dt>提交</dt><dd><code v-if="view.status.headSha">{{ view.status.headSha.slice(0, 8) }}</code><template v-else>待获取</template></dd>
          <dt>流水线</dt><dd>{{ view.status.checks ? checkLabel[view.status.checks] : '暂无状态' }}</dd>
          <dt>冲突</dt><dd>{{ view.status.conflict === true ? '有冲突' : view.status.conflict === false ? '无冲突' : '待平台检测' }}</dd>
          <dt>评审</dt><dd>{{ view.status.review ? reviewLabel[view.status.review] : '暂无状态' }}</dd>
        </template>
      </dl>
      <div class="mr-watch-actions">
        <el-button link type="primary" :loading="view.refreshing" @click="refresh">{{ view.error ? '重试查询' : '刷新状态' }}</el-button>
        <el-button link @click="model.remove(conversationId); url = ''; path = paths[0] || ''">取消关联</el-button>
      </div>
    </section>
    <form v-else class="mr-watch-content" aria-label="关联合并请求" @submit.prevent="linkRequest">
      <el-select v-if="paths.length > 1" v-model="path" aria-label="合并请求所属项目" placeholder="选择项目">
        <el-option v-for="item in paths" :key="item" :value="item" :label="item" />
      </el-select>
      <el-input v-model="url" aria-label="合并请求链接" placeholder="粘贴 Codeup 或 GitLab 的 MR 链接" />
      <div><el-button native-type="submit" type="primary" :loading="linking" :disabled="!path || !url.trim()">关联</el-button></div>
    </form>
  </el-popover>
</template>

<style scoped>
.mr-watch-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
  white-space: nowrap;
}
.mr-watch-trigger:hover { background: var(--ui-hover); color: var(--ui-accent); }
.mr-watch-content { display: grid; gap: 10px; }
.mr-watch-content a { color: var(--el-color-primary); overflow-wrap: anywhere; }
.mr-watch-status { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.mr-watch-status dd { margin: 0; }
.mr-watch-actions { display: flex; gap: 12px; }
.mr-watch-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>

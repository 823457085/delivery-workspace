<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';

interface ShareConfigData {
  jiraBaseUrl: string;
  jiraUsername: string;
  hasJiraToken: boolean;
  projectRoots: string[];
  credentialsFile: string;
}

const queryClient = useQueryClient();
const loading = shallowRef(false);
const addingRoot = shallowRef(false);

const projectRoots = ref<string[]>([]);
const manualRootPath = shallowRef('');

async function loadConfig() {
  loading.value = true;
  try {
    const res = await fetch('/api/share/config');
    const data = (await res.json()) as ShareConfigData;
    if (!res.ok) throw new Error('读取连接配置失败');
    projectRoots.value = Array.isArray(data.projectRoots) ? data.projectRoots : [];
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取配置失败');
  } finally {
    loading.value = false;
  }
}

async function pickProjectRoot() {
  addingRoot.value = true;
  try {
    const pickRes = await fetch('/api/workspace/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const picked = await pickRes.json();
    if (!pickRes.ok) throw new Error(picked.message || '选择文件夹失败');
    if (picked.cancelled || !picked.workspacePath) return;
    await addRootByPath(picked.workspacePath);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '选择文件夹失败');
  } finally {
    addingRoot.value = false;
  }
}

async function addManualRoot() {
  const pathVal = manualRootPath.value.trim();
  if (!pathVal) {
    ElMessage.warning('请输入本机目录的完整路径');
    return;
  }
  addingRoot.value = true;
  try {
    await addRootByPath(pathVal);
    manualRootPath.value = '';
  } finally {
    addingRoot.value = false;
  }
}

async function addRootByPath(targetPath: string) {
  const res = await fetch('/api/share/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add-root', path: targetPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '添加目录失败');
  if (data.config?.projectRoots) projectRoots.value = data.config.projectRoots;
  ElMessage.success(data.message || '已添加项目扫描目录');
  await queryClient.invalidateQueries({ queryKey: ['source', 'projects'] });
}

async function removeRoot(targetPath: string) {
  try {
    const res = await fetch('/api/share/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove-root', path: targetPath }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '移除目录失败');
    if (data.config?.projectRoots) projectRoots.value = data.config.projectRoots;
    ElMessage.success(data.message || '已移除目录');
    await queryClient.invalidateQueries({ queryKey: ['source', 'projects'] });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '移除目录失败');
  }
}

onMounted(() => {
  void loadConfig();
});
</script>

<template>
  <section class="share-connection-grid">
    <div class="surface">
      <div class="surface-header">
        <div>
          <h2>本地项目扫描目录 (LOCAL_PROJECT_ROOTS)</h2>
          <p>工作台会自动递归扫描以下目录中的 Git 仓库与多工作区</p>
        </div>
        <el-button size="small" type="primary" plain :loading="addingRoot" @click="pickProjectRoot">
          选择文件夹添加
        </el-button>
      </div>
      <div class="surface-body">
        <div class="root-list">
          <div v-for="dir in projectRoots" :key="dir" class="root-item">
            <span class="row-mono">{{ dir }}</span>
            <el-button
              link
              type="danger"
              size="small"
              :disabled="projectRoots.length <= 1"
              @click="removeRoot(dir)"
            >
              移除
            </el-button>
          </div>
        </div>
        <div class="root-manual-bar">
          <el-input
            v-model="manualRootPath"
            placeholder="或直接粘贴本机绝对路径，如 /Users/yourname/Projects"
            @keyup.enter="addManualRoot"
          />
          <el-button :loading="addingRoot" @click="addManualRoot">添加路径</el-button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.share-connection-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 22px;
  margin-bottom: 22px;
}
.share-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
}
.share-fields :deep(.el-form-item) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.share-fields :deep(.el-form-item__content) {
  display: block;
  flex: 0 0 auto;
}
.share-field-help {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}
.share-connection-grid .surface-header h2,
.share-connection-grid .surface-header p {
  overflow-wrap: anywhere;
}
.share-connection-grid .surface-header > .el-button {
  flex-shrink: 0;
}
.share-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 8px;
}
.root-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.root-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--ui-border);
}
.root-item .row-mono {
  min-width: 0;
  overflow-wrap: anywhere;
}
.root-item .el-button {
  flex-shrink: 0;
}
.root-manual-bar {
  display: flex;
  gap: 8px;
}
.root-manual-bar .el-input {
  min-width: 0;
}
.root-manual-bar .el-button {
  flex-shrink: 0;
}
@container workspace-page (max-width: 1000px) {
  .share-connection-grid {
    grid-template-columns: 1fr;
  }
}
@container workspace-page (max-width: 600px) {
  .share-fields {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .root-manual-bar {
    flex-wrap: wrap;
  }
}
@media (max-width: 1000px) {
  .share-connection-grid,
  .share-fields {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import StatusPill from '../../shared/ui/StatusPill.vue';

interface ShareConfigData {
  jiraBaseUrl: string;
  jiraUsername: string;
  hasJiraToken: boolean;
  projectRoots: string[];
  credentialsFile: string;
}

const queryClient = useQueryClient();
const loading = shallowRef(false);
const savingJira = shallowRef(false);
const testingJira = shallowRef(false);
const addingRoot = shallowRef(false);

const jiraBaseUrl = shallowRef('');
const jiraUsername = shallowRef('');
const jiraApiToken = shallowRef('');
const hasJiraToken = shallowRef(false);
const projectRoots = ref<string[]>([]);
const manualRootPath = shallowRef('');
const credentialsFile = shallowRef('');

async function loadConfig() {
  loading.value = true;
  try {
    const res = await fetch('/api/share/config');
    const data = (await res.json()) as ShareConfigData;
    if (!res.ok) throw new Error('读取连接配置失败');
    jiraBaseUrl.value = data.jiraBaseUrl || '';
    jiraUsername.value = data.jiraUsername || '';
    hasJiraToken.value = Boolean(data.hasJiraToken);
    projectRoots.value = Array.isArray(data.projectRoots) ? data.projectRoots : [];
    credentialsFile.value = data.credentialsFile || '.env.local';
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取配置失败');
  } finally {
    loading.value = false;
  }
}

async function testJiraConnection() {
  testingJira.value = true;
  try {
    const res = await fetch('/api/share/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'test-jira',
        jiraBaseUrl: jiraBaseUrl.value.trim(),
        jiraUsername: jiraUsername.value.trim(),
        jiraApiToken: jiraApiToken.value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Jira 连接测试失败');
    ElMessage.success(data.message || 'Jira 连接成功');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : 'Jira 连接测试失败');
  } finally {
    testingJira.value = false;
  }
}

async function saveJiraConnection() {
  savingJira.value = true;
  try {
    const res = await fetch('/api/share/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        jiraBaseUrl: jiraBaseUrl.value.trim(),
        jiraUsername: jiraUsername.value.trim(),
        jiraApiToken: jiraApiToken.value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '保存配置失败');
    jiraApiToken.value = '';
    if (data.config) {
      jiraBaseUrl.value = data.config.jiraBaseUrl;
      jiraUsername.value = data.config.jiraUsername;
      hasJiraToken.value = Boolean(data.config.hasJiraToken);
      projectRoots.value = data.config.projectRoots || [];
    }
    ElMessage.success(data.message || 'Jira 连接已保存并生效');
    await queryClient.invalidateQueries({ queryKey: ['source'] });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存配置失败');
  } finally {
    savingJira.value = false;
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
          <h2>Jira 连接与认证配置</h2>
          <p>保存在本机 {{ credentialsFile }}，无需手动编辑配置文件，保存后立即生效</p>
        </div>
        <StatusPill :value="hasJiraToken ? 'active' : 'paused'" :label="hasJiraToken ? '凭据已配置' : '待配置凭据'" />
      </div>
      <el-form class="surface-body share-form" label-position="top" :disabled="loading || savingJira">
        <div class="share-fields">
          <el-form-item label="Jira 服务地址 (JIRA_BASE_URL)">
            <el-input v-model="jiraBaseUrl" placeholder="https://jira.example.com" />
          </el-form-item>
          <el-form-item label="Jira 用户名 / 邮箱">
            <el-input v-model="jiraUsername" aria-describedby="jira-username-help" placeholder="例如 zhangsan 或 zhangsan@company.com" />
            <p id="jira-username-help" class="share-field-help">Bearer Token 模式可留空</p>
          </el-form-item>
        </div>
        <el-form-item :label="hasJiraToken ? 'API Token / 密码（已保存，留空则保持原密钥不变）' : 'API Token / 密码'">
          <el-input
            v-model="jiraApiToken"
            type="password"
            show-password
            placeholder="输入 Jira Personal Access Token 或登录密码"
          />
        </el-form-item>
        <div class="share-actions">
          <el-button :loading="testingJira" @click="testJiraConnection">测试 Jira 连接</el-button>
          <el-button type="primary" :loading="savingJira" @click="saveJiraConnection">保存 Jira 配置</el-button>
        </div>
      </el-form>
    </div>

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

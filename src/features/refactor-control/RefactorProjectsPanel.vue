<script setup lang="ts">
/** 项目入口复用工作台原生终端与 Cursor；只保存脚本名，启动、依赖与端口校验由本机服务负责。 */
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { RefactorProject, RefactorProjectDashboard, RefactorProjectStatus } from '../../../shared/refactor-projects';
import AgentCursorButton from '../agent-workbench/AgentCursorButton.vue';
import AgentTerminalButton from '../agent-workbench/AgentTerminalButton.vue';
import { refactorRequest } from './useRefactorControl';

const emit = defineEmits<{ changed: [] }>();
const suffix = '/workspace/projects';
const query = useQuery({ queryKey: ['refactor-projects'], queryFn: ({ signal }) => refactorRequest<RefactorProjectDashboard>(suffix, undefined, signal), refetchInterval: 5000, retry: false });
const projects = computed(() => query.data.value?.projects || []);
const editing = ref(false), busy = ref(false), draft = ref<RefactorProject[]>([]), revision = ref('');
const roles = { shell: '基座', 'micro-app': '微前端子应用', legacy: '旧版应用', service: '服务' };
const states = { running: '运行中', stopped: '未启动', conflict: '端口冲突', starting: '启动中', failed: '未就绪' };
const starting = computed(() => projects.value.some(project => project.state === 'starting'));
watch(() => query.error.value, error => { if (error) ElMessage.error(error.message); });
function edit() {
  revision.value = query.data.value?.revision || '';
  draft.value = projects.value.map(({ id, name, role, workspacePath, baseUrl, packageManager, startScript, dependencies }) => ({ id, name, role, workspacePath, baseUrl, packageManager, startScript, dependencies: [...dependencies] }));
  editing.value = true;
}
function add(project?: RefactorProject) {
  draft.value.push(project ? { ...project, id: crypto.randomUUID(), dependencies: [] } : {
    id: crypto.randomUUID(), name: '', role: 'micro-app', workspacePath: '', baseUrl: 'http://localhost:5173/', packageManager: 'pnpm', startScript: 'dev', dependencies: [],
  });
}
function remove(id: string) {
  draft.value = draft.value.filter(project => project.id !== id).map(project => ({ ...project, dependencies: project.dependencies.filter(value => value !== id) }));
}
async function selectDirectory(project: RefactorProject) {
  try {
    const response = await fetch('/api/workspace/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json(); if (!response.ok) throw new Error(result.message || '目录选择失败');
    if (!result.cancelled) project.workspacePath = result.workspacePath;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '目录选择失败'); }
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    await refactorRequest<RefactorProjectDashboard>(suffix, { revision: revision.value, projects: draft.value });
    editing.value = false; await query.refetch(); emit('changed'); ElMessage.success('项目组配置已保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '项目组保存失败'); }
  finally { busy.value = false; }
}
async function start(projectIds: string[]) {
  if (busy.value || starting.value) return;
  busy.value = true;
  try { await refactorRequest<RefactorProjectDashboard>(`${suffix}/start`, { projectIds }); await query.refetch(); emit('changed'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '项目启动失败'); }
  finally { busy.value = false; }
}
function scriptOptions(project: RefactorProject) { return projects.value.find(item => item.workspacePath === project.workspacePath)?.scripts || ['dev', 'start']; }
function tagType(project: RefactorProjectStatus) { return project.state === 'running' ? 'success' : project.state === 'starting' ? 'warning' : project.state === 'stopped' ? 'info' : 'danger'; }
</script>

<template>
  <section class="refactor-projects" aria-label="微前端项目组">
    <header class="refactor-project-heading"><div><h2>微前端项目组</h2><p>统一管理基座、子应用和服务的目录、依赖、启动与访问入口。</p></div><div class="refactor-project-actions"><el-button :loading="query.isFetching.value" @click="query.refetch()">刷新状态</el-button><el-button :disabled="!query.data.value || starting" @click="edit">项目配置</el-button><el-button type="primary" :loading="busy" :disabled="!projects.length || starting" @click="start(projects.map(project => project.id))">按依赖启动全部</el-button></div></header>
    <el-table v-if="projects.length" :data="projects" row-key="id" class="project-table">
      <el-table-column label="项目 / 角色" min-width="150"><template #default="{ row }"><strong>{{ row.name }}</strong><small>{{ roles[row.role as keyof typeof roles] }}</small><small>{{ row.packageManager }} run {{ row.startScript }}</small></template></el-table-column>
      <el-table-column label="本机目录 / 分支" min-width="230"><template #default="{ row }"><code>{{ row.workspacePath }}</code><small>{{ row.branch || '普通目录 / detached HEAD' }}<span v-if="row.head"> · {{ row.head.slice(0, 8) }}</span><span v-if="row.dirty"> · 有本机改动</span></small></template></el-table-column>
      <el-table-column label="运行状态" min-width="210"><template #default="{ row }"><el-tag :type="tagType(row)" size="small">{{ states[row.state as keyof typeof states] }}</el-tag><small>{{ row.message }}</small><small v-if="row.pids.length">PID {{ row.pids.join('、') }}</small></template></el-table-column>
      <el-table-column label="快捷入口" min-width="255"><template #default="{ row }"><a v-if="row.state === 'running'" :href="row.baseUrl" target="_blank" rel="noopener noreferrer">{{ row.baseUrl }}</a><span v-else :title="row.message">{{ row.baseUrl }}</span><div class="refactor-project-actions"><el-button size="small" :disabled="busy || starting || row.state === 'running' || row.state === 'conflict'" @click="start([row.id])">启动</el-button><AgentTerminalButton :workspace-path="row.workspacePath" size="small" /><AgentCursorButton :workspace-path="row.workspacePath" size="small" /></div></template></el-table-column>
    </el-table>
    <el-empty v-else-if="!query.isPending.value" description="先添加基座与子应用，保存后可按依赖启动并快捷访问" :image-size="58"><el-button type="primary" :disabled="!query.data.value" @click="edit">配置项目组</el-button></el-empty>
    <el-drawer v-model="editing" title="微前端项目组配置" size="min(850px, 96vw)" append-to-body :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
      <p class="project-config-intro">每个项目使用独立目录和端口；选择 package.json 中已有的启动脚本。依赖项目就绪后才会启动当前项目。</p>
      <article v-for="(project, index) in draft" :key="project.id" class="project-editor">
        <header><strong>项目 {{ index + 1 }}</strong><el-button link type="danger" :disabled="busy" @click="remove(project.id)">移除</el-button></header>
        <el-form label-position="top" :disabled="busy" class="project-fields">
          <el-form-item label="项目名称"><el-input v-model="project.name" maxlength="100" /></el-form-item>
          <el-form-item label="应用角色"><el-select v-model="project.role"><el-option v-for="(label, value) in roles" :key="value" :label="label" :value="value" /></el-select></el-form-item>
          <el-form-item label="项目目录" class="full-width"><el-input v-model="project.workspacePath" placeholder="本机项目绝对路径"><template #append><el-button @click="selectDirectory(project)">选择目录</el-button></template></el-input></el-form-item>
          <el-form-item label="访问地址" class="full-width"><el-input v-model="project.baseUrl" placeholder="http://localhost:7330/" /><small>地址需与项目启动脚本使用的实际端口一致。</small></el-form-item>
          <el-form-item label="包管理器"><el-select v-model="project.packageManager"><el-option v-for="manager in ['pnpm', 'npm', 'yarn']" :key="manager" :value="manager" :label="manager" /></el-select></el-form-item>
          <el-form-item label="启动脚本"><el-select v-model="project.startScript" filterable allow-create default-first-option><el-option v-for="script in scriptOptions(project)" :key="script" :value="script" :label="script" /></el-select></el-form-item>
          <el-form-item label="先启动的依赖项目" class="full-width"><el-select v-model="project.dependencies" multiple placeholder="没有依赖可留空"><el-option v-for="dependency in draft.filter(item => item.id !== project.id)" :key="dependency.id" :value="dependency.id" :label="dependency.name || '未命名项目'" /></el-select></el-form-item>
        </el-form>
      </article>
      <el-button :disabled="busy" @click="add()">添加项目</el-button>
      <el-dropdown v-if="query.data.value?.suggestions?.length" @command="add($event)"><el-button :disabled="busy">从本机发现添加</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="project in query.data.value.suggestions" :key="project.id" :command="project">{{ project.name }} · {{ project.workspacePath }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
      <template #footer><el-button :disabled="busy" @click="editing = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存项目组</el-button></template>
    </el-drawer>
  </section>
</template>

<style scoped>
.refactor-projects{min-width:0;padding:20px;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-bg-color)}.refactor-project-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px}.refactor-project-heading h2{margin:0;font-size:17px}.refactor-project-heading p,.project-config-intro{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.refactor-project-heading p{margin:7px 0 0}.refactor-project-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.refactor-project-actions :deep(.el-button){margin:0}.project-table small{display:block;margin-top:5px;font-size:11px;line-height:1.6;color:var(--el-text-color-secondary)}.project-table code{overflow-wrap:anywhere;font-size:11px}.project-table a{display:block;margin-bottom:10px;color:var(--el-color-primary);font-size:12px;overflow-wrap:anywhere}.project-editor{padding:16px 0;border-bottom:1px solid var(--el-border-color-lighter);margin-bottom:16px}.project-editor>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.project-fields{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.full-width{grid-column:1/-1}.project-fields :deep(.el-select){width:100%}@media(max-width:700px){.refactor-project-heading{flex-direction:column}.project-fields{grid-template-columns:1fr}.refactor-projects{padding:12px}}
</style>

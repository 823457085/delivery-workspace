<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { IssueResponse, JiraIssue } from '../../../shared/hub';
import { overseasRequirementFromJira, overseasRequirementPayload, type OverseasRequirement } from '../../../shared/overseas-requirements';
import { readSource } from '../../shared/api';
import TaskFilters from '../task-calendar/TaskFilters.vue';
import { advancedTaskDefaults, matchesPlannedFilter, taskQueryParams, type TaskFilter } from '../task-calendar/calendar-domain';

const props = defineProps<{ existing: OverseasRequirement[]; systems: string[] }>();
const emit = defineEmits<{ close: []; imported: [items: OverseasRequirement[]] }>();
const filters = ref<TaskFilter>({ ...advancedTaskDefaults, projects: '', keyword: '', includeSubtasks: true, includeDone: false });
const data = shallowRef<IssueResponse>();
const applied = shallowRef<Record<string, string>>({});
const loading = shallowRef(false), saving = shallowRef(false), page = shallowRef(1);
const selection = ref<JiraIssue[]>([]), assignedSystems = ref<string[]>([]);
const queryRevision = shallowRef(0);
const matching = computed(() => (data.value?.issues || []).filter(issue => matchesPlannedFilter(issue, applied.value)));
const visible = computed(() => matching.value.slice((page.value - 1) * 30, page.value * 30));
function registered(issue: JiraIssue) {
  return props.existing.some(item => item.issueUrl ? item.issueUrl === issue.url : item.issueKey === issue.key);
}
async function search(next: TaskFilter) {
  if (loading.value || saving.value) return;
  loading.value = true;
  try {
    const params = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)]));
    data.value = await readSource<IssueResponse>('issues', taskQueryParams(params), undefined, true);
    applied.value = params;
    selection.value = []; page.value = 1; queryRevision.value++;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Jira 查询失败'); }
  finally { loading.value = false; }
}
async function importSelected() {
  if (saving.value || loading.value || !selection.value.length || data.value?.source !== 'jira') return;
  saving.value = true;
  const saved: OverseasRequirement[] = [];
  try {
    for (const issue of selection.value.filter(issue => !registered(issue))) {
      const item = overseasRequirementFromJira(issue, crypto.randomUUID(), assignedSystems.value);
      const response = await fetch('/api/overseas-requirements', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(overseasRequirementPayload(item)) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message || `${issue.key} 导入失败`);
      saved.push(value);
    }
    emit('imported', saved); ElMessage.success(`已导入 ${saved.length} 项 Jira 事项`); emit('close');
  } catch (error) {
    if (saved.length) emit('imported', saved);
    selection.value = selection.value.filter(issue => !saved.some(item => item.issueUrl === issue.url));
    ElMessage.error(`${error instanceof Error ? error.message : '导入失败'}${saved.length ? `；已保存 ${saved.length} 项，其余可继续导入` : ''}`);
  } finally { saving.value = false; }
}
</script>

<template>
  <el-drawer :model-value="true" title="从 Jira 导入需求" size="min(1180px, 100vw)" :close-on-click-modal="false" :show-close="!saving"
    :close-on-press-escape="!saving" @close="emit('close')">
    <div class="jira-requirement-import">
      <TaskFilters v-model="filters" :loading="loading" @search="search" />
      <div class="import-summary"><span v-if="data">来源 {{ data.source }} · 返回 {{ data.issues.length }} / {{ data.total }} 项<span v-if="matching.length !== data.issues.length"> · 符合计划日期 {{ matching.length }} 项</span></span><span v-else>按人员、项目、版本或时间查询，可导入尚未启动开发的 Jira 事项。</span><el-select v-model="assignedSystems" multiple filterable allow-create default-first-option placeholder="归属系统（可选，可新增）" aria-label="导入需求的归属系统"><el-option v-for="system in systems" :key="system" :value="system" :label="system" /></el-select></div>
      <el-table :key="queryRevision" v-loading="loading" :data="visible" row-key="url" @selection-change="selection = $event">
        <el-table-column type="selection" width="48" :reserve-selection="true" :selectable="(issue: JiraIssue) => !registered(issue)" />
        <el-table-column label="Jira 事项" min-width="310"><template #default="{ row }"><a :href="row.url" target="_blank" rel="noreferrer">{{ row.key }}</a><p>{{ row.summary }}</p></template></el-table-column>
        <el-table-column prop="projectName" label="项目" min-width="120" />
        <el-table-column prop="status" label="Jira 状态" min-width="100" />
        <el-table-column prop="assignee" label="经办人" min-width="100" />
        <el-table-column label="版本" min-width="120"><template #default="{ row }">{{ row.fixVersions.join('、') }}</template></el-table-column>
        <el-table-column label="登记情况" width="100"><template #default="{ row }">{{ registered(row) ? '已在台账' : '可导入' }}</template></el-table-column>
        <template #empty><el-empty :description="data ? '没有符合条件的 Jira 事项' : '查询 Jira 事项后选择需要管理的需求'" :image-size="50" /></template>
      </el-table>
      <div class="import-pagination"><span>已选 {{ selection.length }} 项</span><el-pagination v-model:current-page="page" :total="matching.length" :page-size="30" layout="prev, pager, next" /></div>
    </div>
    <template #footer><el-button :disabled="saving" @click="emit('close')">取消</el-button><el-button type="primary" :disabled="!selection.length || loading || data?.source !== 'jira'" :loading="saving" @click="importSelected">导入所选事项</el-button></template>
  </el-drawer>
</template>

<style scoped>
.jira-requirement-import{color:var(--ui-text)}.jira-requirement-import :deep(.task-filters){padding:0 0 18px}.import-summary{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin:10px 0 18px;color:var(--ui-muted);font-size:12px}.import-summary .el-select{width:300px;max-width:100%}.jira-requirement-import a{color:var(--ui-accent);text-decoration:none}.jira-requirement-import p{margin:5px 0;line-height:1.7}.import-pagination{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;font-size:12px}
</style>

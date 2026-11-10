<script setup lang="ts">
import { computed, ref, shallowRef, useId } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, SlidersHorizontal } from '@lucide/vue';
import { advancedTaskDefaults, type TaskFilter } from './calendar-domain';

const filters = defineModel<TaskFilter>({ required: true });
defineProps<{ loading: boolean }>();
const emit = defineEmits<{ search: [filters: TaskFilter] }>();
const expanded = shallowRef(false);
const draft = ref({ ...filters.value });
const formId = useId();
const assigneeMode = computed({
  get: () => draft.value.assignee === advancedTaskDefaults.assignee ? 'current' : 'account',
  set: (mode: string) => { draft.value.assignee = mode === 'current' ? advancedTaskDefaults.assignee : ''; },
});
const advancedChanged = computed(() => Object.entries(advancedTaskDefaults)
  .filter(([key, value]) => key !== 'start' && key !== 'end' && filters.value[key as keyof TaskFilter] !== value).length);

function openAdvanced() {
  draft.value = { ...filters.value };
  expanded.value = true;
}
function resetAdvanced() {
  Object.assign(draft.value, advancedTaskDefaults);
}
function submit(candidate: TaskFilter) {
  const next = {
    ...candidate,
    assignee: candidate.assignee.trim(),
    versions: candidate.versions.trim(),
    start: candidate.allTime ? '' : candidate.start || '',
    end: candidate.allTime ? '' : candidate.end || '',
  };
  if (next.assignee !== advancedTaskDefaults.assignee && !/^[A-Za-z0-9_.@-]+$/.test(next.assignee)) {
    ElMessage.warning('请输入有效的 Jira 账号');
    return;
  }
  if (!next.allTime && !next.start && !next.end) {
    ElMessage.warning('请至少选择一个日期');
    return;
  }
  if (next.start && next.end && next.start > next.end) {
    ElMessage.warning('开始日期不能晚于结束日期');
    return;
  }
  filters.value = next;
  emit('search', next);
  expanded.value = false;
}
</script>

<template>
  <el-form class="task-filters" label-position="top" @submit.prevent="submit(filters)">
    <div class="task-filter-main">
      <el-input v-model="filters.keyword" class="task-filter-keyword" placeholder="搜索标题或正文，回车查询" clearable aria-label="关键词">
        <template #prefix><Search :size="14" /></template>
      </el-input>
      <el-input v-model="filters.projects" class="task-filter-projects" placeholder="项目，如 APEX,TEST" aria-label="项目" />
      <el-checkbox v-model="filters.includeSubtasks">含子任务</el-checkbox>
      <el-checkbox v-model="filters.includeDone">含已完成</el-checkbox>
      <button type="button" class="task-filter-more" aria-haspopup="dialog" :aria-expanded="expanded" @click="openAdvanced">
        <SlidersHorizontal :size="14" />更多筛选<span v-if="advancedChanged">{{ advancedChanged }}</span>
      </button>
      <el-button type="primary" native-type="submit" :loading="loading">查询任务</el-button>
    </div>
  </el-form>

  <el-dialog v-model="expanded" title="更多筛选" class="task-filter-dialog" width="min(600px, calc(100vw - 24px))"
    align-center append-to-body destroy-on-close :close-on-click-modal="false">
    <el-form :id="formId" class="task-advanced-form" label-position="top" @submit.prevent="submit(draft)">
      <el-form-item label="经办人">
        <el-select v-model="assigneeMode" aria-label="经办人">
          <el-option label="当前登录用户" value="current" />
          <el-option label="指定 Jira 账号" value="account" />
        </el-select>
        <el-input v-if="assigneeMode === 'account'" v-model="draft.assignee" class="task-filter-account"
          placeholder="输入 Jira 账号" aria-label="Jira 账号" />
      </el-form-item>
      <el-form-item label="版本">
        <el-input v-model="draft.versions" placeholder="全部版本，多个版本用逗号分隔" aria-label="版本" clearable />
      </el-form-item>
      <el-form-item label="时间字段">
        <el-select v-model="draft.dateField" aria-label="时间字段">
          <el-option label="计划日期" value="planned" />
          <el-option label="更新时间" value="updated" />
          <el-option label="创建时间" value="created" />
          <el-option label="截止日期" value="duedate" />
          <el-option label="解决时间" value="resolutiondate" />
        </el-select>
      </el-form-item>
      <el-form-item label="排序">
        <el-select v-model="draft.sortOrder" aria-label="排序">
          <el-option label="默认顺序" value="default" />
          <el-option label="结束日期升序" value="end-asc" />
          <el-option label="结束日期降序" value="end-desc" />
        </el-select>
      </el-form-item>
      <el-form-item label="时间范围">
        <el-checkbox v-model="draft.allTime">不限时间</el-checkbox>
      </el-form-item>
      <el-form-item label="最多返回">
        <el-select v-model="draft.maxResults" aria-label="最多返回">
          <el-option v-for="count in ['500', '1000', '2000', '5000']" :key="count" :value="count" :label="`${count} 条`" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="!draft.allTime" label="开始日期">
        <el-date-picker v-model="draft.start" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" aria-label="开始日期" />
      </el-form-item>
      <el-form-item v-if="!draft.allTime" label="结束日期">
        <el-date-picker v-model="draft.end" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" aria-label="结束日期" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button class="task-filter-reset" @click="resetAdvanced">恢复默认</el-button>
      <el-button @click="expanded = false">取消</el-button>
      <el-button type="primary" native-type="submit" :form="formId" :loading="loading">查询任务</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.task-filters { padding: 16px 20px; }
.task-filter-main { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; }
.task-filter-keyword { flex: 1 1 280px; max-width: 420px; }
.task-filter-keyword svg { color: var(--ui-muted); }
.task-filter-projects { flex: 0 1 220px; }
.task-filter-main :deep(.el-checkbox) { margin: 0; }
.task-filter-main :deep(.el-checkbox__label) { font-size: 12px; }
.task-filter-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: transparent;
  color: var(--ui-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.task-filter-more:hover, .task-filter-more[aria-expanded="true"] { border-color: var(--ui-accent); color: var(--ui-accent); }
.task-filter-more span { min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 11px; line-height: 18px; text-align: center; }
.task-filter-main > .el-button { min-width: 88px; margin-left: auto; }

.task-advanced-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.task-advanced-form :deep(.el-form-item) { min-width: 0; margin: 0; }
.task-advanced-form :deep(.el-form-item__label) { margin-bottom: 6px; color: var(--ui-secondary); line-height: 1.4; }
.task-advanced-form :deep(.el-date-editor), .task-advanced-form :deep(.el-select) { width: 100%; min-width: 0; }
.task-filter-account { margin-top: 8px; }
.task-filter-reset { margin-right: auto; }

:global(.task-filter-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 24px);
  padding: 0;
  overflow: hidden;
}
:global(.task-filter-dialog > .el-dialog__header) {
  flex: none;
  margin: 0;
  padding: 14px 44px 12px 16px;
  border-bottom: 1px solid var(--ui-divider);
}
:global(.task-filter-dialog > .el-dialog__body) {
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
:global(.task-filter-dialog > .el-dialog__footer) {
  display: flex;
  flex: none;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--ui-divider);
}
:global(.task-filter-dialog > .el-dialog__footer .el-button + .el-button) { margin-left: 0; }

@media (max-width: 600px) {
  .task-filter-keyword, .task-filter-projects { flex-basis: 100%; max-width: none; }
  .task-filter-main > .el-button { margin-left: 0; }
}
@media (max-width: 500px) {
  .task-advanced-form { grid-template-columns: minmax(0, 1fr); }
}
</style>

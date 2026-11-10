<script setup lang="ts">
/**
 * Jira 修复 / 需求开发表单：依次填写 Jira 来源、任务设置、工作区，再使用底部操作栏。
 * 确认后在工作台按所选执行器与模型新建会话；不再新建 Codex 聊天。
 */
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { JiraDevScanPreview } from '../../../shared/hub';
import { groupProgressText } from '../../../shared/agent-group-chat';
import type { JiraDevRequirementContext, JiraDevTaskView, JiraDevWorkflow } from '../../../shared/jira-dev';
import { jiraDevRequest, useJiraDevTask } from './useJiraDevTask';
import { useJiraDevRuntime } from './useJiraDevRuntime';
import { useJiraDevProject } from './useJiraDevProject';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import JiraDevRuntimePicker from './JiraDevRuntimePicker.vue';
import JiraDevPreviewDialog from './JiraDevPreviewDialog.vue';
import JiraDevProjectFields from './JiraDevProjectFields.vue';
import JiraDevProjectPicker from './JiraDevProjectPicker.vue';
import JiraDescription from '../jira-issue/JiraDescription.vue';
import { safeUrl } from '../../shared/format';

const props = defineProps<{ workflow: JiraDevWorkflow; requirementContext?: JiraDevRequirementContext }>();
const emit = defineEmits<{ openRun: [id: string]; task: [task: JiraDevTaskView]; next: [] }>();
const state = useJiraDevTask(props.workflow, id => emit('openRun', id), props.requirementContext);
const { form, issue, task, locked } = state;
watch(task, value => { if (value) emit('task', value); });
function nextTask() { state.next(); emit('next'); }
const runtime = useJiraDevRuntime(props.workflow, () => state.selectedProjects.value.length);
const project = useJiraDevProject(shallowRef(''), () => {}, () => state.selectedProjects.value.map(item => item.path));
const picker = useWorkspacePicker();
const projectPickerOpen = shallowRef(false);
const repair = props.workflow === 'jira';
const scanOpen = shallowRef(false), scanLoading = shallowRef(false);
const scanPreviews = shallowRef<JiraDevScanPreview[]>([]);
const scanStatuses = { started: '已自动启动', existing: '已有关联会话', awaiting_confirmation: '待确认', blocked: '启动受阻' };
const automationLabels = { start: 'Jira 开始状态', verification: '验证核对', mergeRequest: '合并请求', complete: 'Jira 完成状态' };
const deliverySteps = computed(() => Object.entries(automationLabels).flatMap(([key, label]) => {
  const step = task.value?.automationDelivery?.[key as keyof typeof automationLabels];
  return step ? [{ key, label, ...step }] : [];
}));
const checkingDelivery = shallowRef(false);
async function refreshDelivery() {
  const id = task.value?.taskId;
  if (!id || checkingDelivery.value) return;
  checkingDelivery.value = true;
  try {
    const result = await jiraDevRequest<JiraDevTaskView>('task', { taskId: id });
    if (task.value?.taskId === id) task.value = result;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取自动交付结果失败'); }
  finally { checkingDelivery.value = false; }
}
async function showScanPreviews() {
  scanOpen.value = true;
  scanLoading.value = true;
  scanPreviews.value = [];
  try {
    const result = await jiraDevRequest<{ previews: JiraDevScanPreview[]; error?: string }>(`automation-previews?workflow=${props.workflow}`);
    scanPreviews.value = result.previews;
    if (result.error) ElMessage.error(result.error);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取巡检预览失败'); }
  finally { scanLoading.value = false; }
}
async function openScanPreview(preview: JiraDevScanPreview) {
  if (!preview.taskId) return;
  if (state.taskId.value !== preview.taskId && (form.source || form.details)) {
    try { await ElMessageBox.confirm('打开巡检预览会替换当前表单内容。', '打开巡检预览', { confirmButtonText: '打开预览', cancelButtonText: '取消' }); }
    catch { return; }
  }
  if (await state.openScanPreview(preview.taskId, preview.issueKey)) scanOpen.value = false;
}
const frozen = computed(() => locked.value || state.busy.value || state.reading.value);
const requirementGroup = computed(() => !repair && runtime.selection.collaborationMode === 'group');
const canStart = computed(() => !!task.value && !state.launched.value && !state.startBlocker.value && !runtime.problem.value
  && (!requirementGroup.value || task.value.preparation?.review?.status === 'ready' && task.value.preparation.design?.status !== 'running'));
const startLabel = computed(() => !requirementGroup.value ? state.startLabel.value
  : task.value?.preparation?.design?.status === 'ready' ? '创建工作区并开始开发'
    : task.value?.preparation?.design?.status === 'running' ? '正在生成前端技术方案'
      : state.needsApply.value ? '确认 Jira 任务并生成技术方案' : '生成前端技术方案');
const description = computed(() => typeof issue.value?.description === 'string' ? issue.value.description : JSON.stringify(issue.value?.description ?? '', null, 2));
const scheduleRoles = computed(() => {
  const frontend = form.sourceKind === 'frontend';
  return { main: frontend ? 'implementation' as const : 'parent' as const, extra: frontend ? ['design'] as const : ['design', 'implementation'] as const };
});
const sourceKinds = [{ label: '产品需求', value: 'product' }, { label: '已有前端任务', value: 'frontend' }];
const scheduleLabels = { parent: '前端 DEV 排期（可选）', implementation: '前端实现排期（可选）' };
const inheritedVersions = computed(() => issue.value && (!form.repairProject || form.repairProject === issue.value.project?.key) ? issue.value.fixVersions || [] : []);

async function browse() {
  const selection = await picker.choose(form.projectPath);
  if (selection) {
    if (repair) state.edit('projectPath', selection.workspacePath);
    else state.selectProjects([...state.selectedProjects.value.map(item => item.path), selection.workspacePath]);
  }
  else if (picker.error.value) ElMessage.error(picker.error.value);
}
const versionSuggestions = (query: string, callback: (items: { value: string }[]) => void) =>
  callback(state.versions.value.filter(item => item.toLowerCase().includes(query.toLowerCase())).slice(0, 50).map(value => ({ value })));
const candidateNames = computed(() => new Map(project.candidates.value.map(item => [item.path, item.name])));
function projectTagLabel(value: string) {
  const path = String(value || '');
  const parts = path.split('/').filter(Boolean);
  const name = candidateNames.value.get(path) || parts.at(-1) || path;
  const duplicates = state.selectedProjects.value.filter(item => {
    const itemName = candidateNames.value.get(item.path) || item.path.split('/').filter(Boolean).at(-1) || item.path;
    return itemName === name;
  });
  return duplicates.length > 1 && parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : name;
}

// 操作条吸底时切换贴底样式：样式中 bottom 为 -1px，吸底时底部被裁掉 1px 且贴住滚动区域底边。
const actions = useTemplateRef<HTMLElement>('actions');
const stuck = shallowRef(false);
let actionsObserver: IntersectionObserver | undefined;
onMounted(() => {
  const element = actions.value;
  if (!element || typeof IntersectionObserver === 'undefined') return;
  actionsObserver = new IntersectionObserver(([entry]) => {
    if (!entry) return;
    const bottom = entry.rootBounds?.bottom ?? window.innerHeight;
    stuck.value = entry.intersectionRatio < 1 && entry.boundingClientRect.bottom >= bottom - 1;
  }, { root: element.closest('.workspace-panel-content'), threshold: [0, 1] });
  actionsObserver.observe(element);
});
onBeforeUnmount(() => actionsObserver?.disconnect());
</script>

<template>
  <section class="jira-dev" :aria-label="repair ? 'Jira 修复' : '需求开发'">
    <div class="jira-dev-fields" role="region" :aria-label="repair ? '修复任务表单' : '开发任务表单'" tabindex="0">
      <el-form label-position="top" class="task-layout" :disabled="frozen" @submit.prevent>
        <section class="card task-source" aria-label="任务来源">
          <label for="jira-dev-source" class="source-label">{{ repair ? '缺陷 Jira Key / 链接' : form.sourceKind === 'frontend' ? 'Jira 主任务或子任务' : '需求 Jira Key / 链接（可选）' }}</label>
          <el-input id="jira-dev-source" :model-value="form.source" maxlength="1000" :placeholder="repair ? '填写缺陷主任务或缺陷链接' : form.sourceKind === 'frontend' ? '填写已有开发主任务、子任务或关联的产品需求编号' : 'Jira Key 或链接；也可只填写下方需求正文'"
            @update:model-value="state.edit('source', $event)" @keydown.enter.prevent="state.readIssue()" />
          <div class="task-source-actions">
            <el-button :loading="state.reading.value" :disabled="!form.source.trim()" @click="state.readIssue()">读取 Jira</el-button>
            <el-button v-if="!props.requirementContext" @click="showScanPreviews">巡检预览</el-button>
          </div>
          <details v-if="issue" class="issue-material"><summary><strong>{{ issue.key }}</strong> {{ issue.summary }}</summary>
            <div class="issue-body"><a v-if="issue.url" :href="issue.url" target="_blank" rel="noreferrer">打开 Jira</a><JiraDescription class="issue-description" :text="description" :base-url="issue.url" /></div></details>
        </section>

        <section class="card task-settings" :class="{ 'requirement-settings': !repair }" aria-label="任务设置">
          <header class="card-head"><h3>任务设置</h3></header>
          <div class="option-box">
            <el-checkbox :model-value="form.useI18n" :disabled="frozen || !!task?.launch" @update:model-value="state.edit('useI18n', !!$event)">使用多语言位置编码</el-checkbox>
            <p class="hint">勾选后，本次新增或修改的前端文案使用多语言位置编码。</p>
          </div>
          <template v-if="repair">
            <el-form-item label="修复方式"><el-select :model-value="form.repairMode" @update:model-value="state.edit('repairMode', $event)">
              <el-option value="create" label="查重后新建开发 Jira" /><el-option value="reuse" label="复用已有开发 Jira" /><el-option value="direct" label="使用当前 Jira 直接修复" /></el-select></el-form-item>
            <template v-if="form.repairMode === 'create'">
              <el-form-item label="开发 Jira 标题（可选）"><el-input :model-value="form.repairSummary" maxlength="250" placeholder="留空使用“前端修复 + 原缺陷标题”" @update:model-value="state.edit('repairSummary', $event)" /></el-form-item>
              <div class="two-columns">
                <el-form-item label="目标 Jira 项目 Key（可选）"><el-input :model-value="form.repairProject" maxlength="100" placeholder="如 APEX；留空沿用原项目" @update:model-value="state.edit('repairProject', $event.toUpperCase())" @change="state.loadVersions()" /></el-form-item>
                <el-form-item label="版本名称（可选）"><el-autocomplete :model-value="form.repairVersion" :fetch-suggestions="versionSuggestions" maxlength="200" :placeholder="inheritedVersions.length > 1 ? `留空沿用原缺陷的全部 ${inheritedVersions.length} 个版本` : '填写目标项目中的准确版本名称'" @update:model-value="state.edit('repairVersion', $event)" /></el-form-item>
              </div>
              <div class="label-row"><p class="hint">{{ state.versionStatus.value }}</p><el-button link type="primary" @click="state.loadVersions()">读取可用版本</el-button></div>
              <div class="two-columns">
                <el-form-item label="计划开始日期（可选）"><el-date-picker :model-value="form.repairStartDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.edit('repairStartDate', $event || '')" /></el-form-item>
                <el-form-item label="计划结束日期（可选）"><el-date-picker :model-value="form.repairEndDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.edit('repairEndDate', $event || '')" /></el-form-item>
              </div>
              <p class="hint">新任务指派给当前 Jira 账号，并关联原缺陷。读取缺陷后带入标题、项目、版本和日期；缺失日期默认今天，可手动修改或清空。跨项目时不自动沿用原项目版本。默认工作分支使用开发 Jira 编号，手动指定的分支保留。</p>
            </template>
            <el-form-item v-else-if="form.repairMode === 'reuse'" label="已有开发主任务或子任务（可选）"><el-input :model-value="form.repairSource" maxlength="1000" placeholder="留空时，从原缺陷的关联和子任务中查找" @update:model-value="state.edit('repairSource', $event)" /></el-form-item>
            <p v-else class="hint direct-repair-note">直接使用上方测试缺陷作为开发与交接目标，不新建或关联 Jira。</p>
          </template>
          <template v-else>
            <el-form-item label="来源类型">
              <template #label>
                来源类型 <small class="source-kind-hint">{{ form.sourceKind === 'product' ? '创建或关联前端任务' : '自动查找已有任务' }}</small>
              </template>
              <el-segmented class="source-kind-options" aria-label="来源类型" :options="sourceKinds" :model-value="form.sourceKind" block
                @update:model-value="state.edit('sourceKind', $event)" />
            </el-form-item>
            <el-form-item v-if="form.sourceKind === 'product'" label="业务模块"><el-input :model-value="form.businessModule" maxlength="100" placeholder="如：设备管理；留空时按需求中的明确模块识别" @update:model-value="state.edit('businessModule', $event)" /></el-form-item>
            <el-form-item v-else label="已有 Jira 开发主任务">
              <el-select :model-value="form.developmentKey" aria-label="已有 Jira 开发主任务" filterable clearable
                :loading="state.reading.value" :placeholder="issue ? '选择关联的开发主任务' : '先读取上方 Jira'"
                :no-data-text="issue ? '未找到关联开发主任务' : '先读取上方 Jira'" @update:model-value="state.edit('developmentKey', $event || '')">
                <el-option v-for="item in state.developmentCandidates.value" :key="item.key" :value="item.key" :label="`${item.key} · ${item.summary}`" />
              </el-select>
            </el-form-item>
            <el-form-item label="已有技术方案（可选）" class="design-source"><el-input :model-value="form.designSource" maxlength="2000" placeholder="已保存方案的链接或本地绝对路径" @update:model-value="state.edit('designSource', $event)" /></el-form-item>
            <section class="schedule-group" aria-label="排期">
              <div class="schedule-row">
                <div>
                  <strong>{{ scheduleLabels[scheduleRoles.main] }}</strong>
                  <p class="hint">{{ form.sourceKind === 'product' ? '选择主任务日期后自动填写子任务日期；按中国大陆官方放假与调休跳过休假、计入补班。首个工作日安排技术方案，其余按每段最多 3 个连续工作日拆分实现任务，遇休假另起一段。' : '各任务分别排期；留空时已有任务保留原日期。' }}</p>
                </div>
                <div class="two-columns">
                  <el-form-item label="计划开始日期"><el-date-picker :model-value="form.schedules[scheduleRoles.main].startDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.editSchedule(scheduleRoles.main, 'startDate', $event)" /></el-form-item>
                  <el-form-item label="计划结束日期"><el-date-picker :model-value="form.schedules[scheduleRoles.main].endDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.editSchedule(scheduleRoles.main, 'endDate', $event)" /></el-form-item>
                </div>
              </div>
              <section v-if="state.childSchedules.value.length" class="child-schedule-preview" aria-label="自动拆分子任务">
                <header class="child-schedule-heading">
                  <strong>自动拆分子任务 · {{ state.childSchedules.value.length }} 项</strong>
                  <small>{{ state.plannedChildren.value.length ? '任务预览标题' : '拟定标题' }}</small>
                </header>
                <ul class="child-schedule-list">
                  <li v-for="row in state.childSchedules.value" :key="row.id">
                    <div class="child-schedule-task">
                      <small>{{ row.role === 'design' ? '技术方案' : '前端实现' }}<template v-if="row.key"> · {{ row.key }}</template></small>
                      <strong>{{ row.summary || '标题待确认' }}</strong>
                    </div>
                    <div class="child-schedule-meta">
                      <span>{{ row.startDate || '—' }}<template v-if="row.endDate !== row.startDate"> 至 {{ row.endDate || '—' }}</template></span>
                      <small v-if="row.workdays">{{ row.workdays }} 个工作日</small>
                    </div>
                  </li>
                </ul>
              </section>
              <details class="advanced">
                <summary>{{ form.sourceKind === 'frontend' ? '更多排期（可选）' : '调整拆分范围（可选）' }}</summary>
                <section v-for="role in scheduleRoles.extra" :key="role" class="schedule-row">
                  <strong>{{ form.sourceKind === 'product' ? role === 'design' ? '技术方案范围' : '实现任务总体范围' : '技术方案排期' }}</strong>
                  <div class="two-columns">
                    <el-form-item label="计划开始日期"><el-date-picker :model-value="form.schedules[role].startDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.editSchedule(role, 'startDate', $event)" /></el-form-item>
                    <el-form-item label="计划结束日期"><el-date-picker :model-value="form.schedules[role].endDate" type="date" value-format="YYYY-MM-DD" placeholder="年 / 月 / 日" @update:model-value="state.editSchedule(role, 'endDate', $event)" /></el-form-item>
                  </div>
                </section>
              </details>
            </section>
          </template>
        </section>

        <section class="card task-workspace" aria-label="工作区">
          <header class="card-head"><h3>工作区</h3><div class="tools">
            <el-popover trigger="click" width="360" placement="bottom-end"><template #reference><el-button link>扫描范围</el-button></template>
              <el-input v-model="project.roots.value" type="textarea" :rows="3" placeholder="每行一个绝对路径；留空使用默认目录" /><el-button class="scan-button" size="small" @click="project.rescan()">扫描这些目录</el-button></el-popover>
            <el-button link :loading="project.scan.isFetching.value" @click="project.rescan()">重新扫描</el-button></div></header>
          <div class="field-label">本地项目目录</div>
          <div class="input-row">
            <el-select v-if="!repair" :model-value="state.selectedProjects.value.map(item => item.path)" multiple :multiple-limit="10" collapse-tags collapse-tags-tooltip :max-collapse-tags="3" filterable :reserve-keyword="false" allow-create default-first-option clearable fit-input-width
              placeholder="选择项目，可多选或填写绝对路径" aria-label="本地项目目录" @update:model-value="state.selectProjects($event)">
              <template #label="{ value }"><span class="project-tag-label" :title="String(value)">{{ projectTagLabel(String(value)) }}</span></template>
              <el-option v-for="item in project.candidates.value" :key="item.path" :value="item.path" :label="`${item.name} ${item.path}`"><strong>{{ item.name }}</strong><small class="option-path">{{ item.path }}</small></el-option>
            </el-select>
            <el-select v-else :model-value="form.projectPath" filterable allow-create default-first-option clearable fit-input-width placeholder="选择扫描结果，或填写项目绝对路径" aria-label="本地项目目录" @update:model-value="state.edit('projectPath', $event || '')">
              <template #label="{ value }"><span class="project-tag-label" :title="String(value)">{{ value }}</span></template>
              <el-option v-for="item in project.candidates.value" :key="item.path" :value="item.path" :label="`${item.name} ${item.path}`"><strong>{{ item.name }}</strong><small class="option-path">{{ item.path }}</small></el-option>
            </el-select>
            <el-button :loading="picker.selecting.value" @click="repair ? browse() : projectPickerOpen = true">选择项目</el-button>
          </div>
          <p class="hint scan-summary">{{ project.scanSummary.value }}</p>
          <div v-if="state.selectedProjects.value.length" class="project-list">
            <JiraDevProjectFields v-for="(selection, index) in state.selectedProjects.value" :key="selection.path" :selection="selection" :name="projectTagLabel(selection.path)" :index="index + 1" :disabled="frozen"
              :multiple="state.selectedProjects.value.length > 1" @edit="(key, value) => state.editProject(selection.path, key, value)"
              @remove="state.selectProjects(state.selectedProjects.value.filter(item => item.path !== selection.path).map(item => item.path))" />
          </div>
          <el-form-item :label="repair ? '补充说明' : '需求正文 / 补充说明'" class="notes"><el-input :model-value="form.details" type="textarea" :rows="repair ? 4 : 5" maxlength="20000"
            :placeholder="repair ? '复现步骤、修复范围或验收要求' : '要开发的需求、范围与验收标准；未填写 Jira 时请提供需求正文'" @update:model-value="state.edit('details', $event)" /></el-form-item>
        </section>
      </el-form>

      <section v-if="task?.launch" class="card continuation" aria-label="本次任务">
        <div><strong>本次任务</strong><p class="hint">{{ task.title }} · {{ { preparing: '正在准备工作区', starting: '正在启动会话', started: '已在工作台启动', failed: '启动失败', uncertain: '启动结果待核对' }[task.launch.status] }}{{ task.launch.workspacePath ? ` · ${task.launch.workspacePath}` : '' }}</p>
          <p v-if="task.launch.groupProgress" class="hint">{{ groupProgressText(task.launch.groupProgress) }}</p><p v-if="task.launch.error" class="danger">{{ task.launch.error }}</p></div>
        <span v-if="task.launch.conversationMissing" class="hint">关联会话已不存在</span>
        <el-button v-else-if="task.launch.groupRoomId || task.launch.runId || task.launch.conversationId" type="primary" plain @click="emit('openRun', task.launch.groupRoomId ? `group:${task.launch.groupRoomId}` : task.launch.conversationId || task.launch.runId)">{{ task.launch.groupRoomId ? '打开团队群聊' : '打开会话' }}</el-button>
      </section>
      <section v-if="task?.launch && task.automationDelivery" class="card" aria-label="自动交付">
        <header class="section-head"><strong>自动交付</strong><el-button link :loading="checkingDelivery" @click="refreshDelivery">刷新结果</el-button></header>
        <p v-if="!deliverySteps.length" class="hint">等待任务状态或验证结果。</p>
        <p v-for="step in deliverySteps" :key="step.key" class="hint">
          {{ step.label }} · {{ step.message }}
          <a v-if="step.url" :href="safeUrl(step.url)" target="_blank" rel="noopener noreferrer">打开 MR</a>
        </p>
      </section>
      <p v-if="locked && !task?.launch" class="hint lock-hint">该任务的 Jira 计划已确认或待核对，表单已锁定；可查看任务预览继续，或点“开始下一项”。</p>

    </div>

    <el-dialog v-model="scanOpen" title="巡检预览" append-to-body width="min(560px, calc(100vw - 32px))">
      <div v-loading="scanLoading" class="scan-preview-list">
        <el-empty v-if="!scanLoading && !scanPreviews.length" description="暂无巡检预览" :image-size="56" />
        <article v-for="item in scanPreviews" :key="item.issueKey">
          <div><strong>{{ item.issueKey }} · {{ item.summary }}</strong><small>{{ [item.launchStatus && scanStatuses[item.launchStatus], item.error || item.projectPath].filter(Boolean).join(' · ') }}</small></div>
          <el-button v-if="item.taskId" :disabled="state.busy.value" @click="openScanPreview(item)">{{ item.runId ? '查看任务' : '打开预览' }}</el-button>
        </article>
      </div>
    </el-dialog>
    <footer ref="actions" class="task-actions" :class="{ 'is-stuck': stuck }">
      <JiraDevRuntimePicker :runtime="runtime" :disabled="state.busy.value || state.launched.value" />
      <p v-if="state.status.value" class="status" role="status">{{ state.status.value }}</p>
      <p v-else-if="!locked && state.problem.value" class="status pending" role="status">待完善：{{ state.problem.value }}</p>
      <div class="buttons">
        <el-button :disabled="state.busy.value || state.reading.value" @click="nextTask()">开始下一项</el-button>
        <el-button v-if="task" @click="state.previewOpen.value = true">查看任务预览</el-button>
        <el-button type="primary" :loading="state.busy.value" :disabled="locked || state.reading.value" @click="state.prepare()">生成任务预览</el-button>
      </div>
    </footer>
  </section>
  <JiraDevPreviewDialog v-model="state.previewOpen.value" :task="task" :busy="state.busy.value" :status="state.status.value" :start-label="startLabel" :requirement-group="requirementGroup" :can-review="!!runtime.selection.groupConfigRevision"
    :can-start="canStart" :runtime-summary="runtime.summary.value" @start="canStart && state.start({ ...runtime.selection })" @check="state.check($event)" @review="state.prepareReview({ ...runtime.selection })" @open-run="emit('openRun', $event)">
    <template v-if="!state.launched.value" #runtime>
      <JiraDevRuntimePicker :runtime="runtime" :disabled="state.busy.value" />
    </template>
  </JiraDevPreviewDialog>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
  <JiraDevProjectPicker v-if="!repair" :open="projectPickerOpen" :selected="state.selectedProjects.value.map(item => item.path)" :candidates="project.candidates.value"
    @select="state.selectProjects($event)" @close="projectPickerOpen = false" />
</template>

<style scoped>
.child-schedule-preview { container: child-schedule / inline-size; margin: 14px 0; }
.child-schedule-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 8px; font-size: 13px; }
.child-schedule-preview small { color: var(--ui-muted); font-size: 11px; }
.child-schedule-list { margin: 0; padding: 0; border: 1px solid var(--ui-border); border-radius: 10px; list-style: none; }
.child-schedule-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 16px; padding: 10px 12px; }
.child-schedule-list li + li { border-top: 1px solid var(--ui-divider); }
.child-schedule-task, .child-schedule-meta { display: grid; gap: 3px; min-width: 0; font-size: 12px; }
.child-schedule-task strong { font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.child-schedule-meta { justify-items: end; color: var(--ui-secondary); font-variant-numeric: tabular-nums; }
@container child-schedule (max-width: 500px) {
  .child-schedule-list li { grid-template-columns: minmax(0, 1fr); }
  .child-schedule-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
}
.jira-dev{display:flex;flex-direction:column;gap:12px;max-width:1320px;margin:0 auto;color:var(--ui-text)}
.card{padding:18px 20px;border:1px solid var(--ds-rule,var(--ui-border));border-radius:var(--ds-radius-lg,12px);background:var(--ui-surface);box-shadow:var(--ds-shadow,none);min-width:0}
.jira-dev-fields{display:flex;flex-direction:column;gap:12px;min-width:0}
.task-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.task-layout :deep(:is(.el-select__input,.el-input__inner):focus-visible){outline:none}
.task-source-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.task-source-actions>.el-button+.el-button{margin-left:0}
.scan-preview-list{min-height:80px;max-height:min(52vh,480px);overflow:auto}
.scan-preview-list article{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--ui-border)}
.scan-preview-list article>div{min-width:0;overflow-wrap:anywhere}
.scan-preview-list small{display:block;margin-top:4px;color:var(--ui-secondary)}
.task-source{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding-block:14px}
.source-label{font-size:14px;font-weight:600}
.issue-material{grid-column:1/-1;padding-top:10px;border-top:1px solid var(--ui-divider,var(--ui-border))}.issue-material summary{cursor:pointer;font-size:13px}.issue-body{margin-top:8px}.issue-description{max-height:280px;overflow:auto;margin:8px 0 0}
.task-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;column-gap:16px}
.task-settings.requirement-settings{grid-template-columns:repeat(3,minmax(0,1fr))}
.task-settings>:is(.card-head,.option-box,.schedule-group,.two-columns,.label-row,.hint:not(.direct-repair-note)){grid-column:1/-1}
.direct-repair-note{align-self:center}
.task-workspace{display:flex;flex-direction:column}
/* 卡片标题：左右两卡同一层级，工具按钮放在标题行右侧。 */
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:24px;margin:0 0 16px;padding-bottom:12px;border-bottom:1px solid var(--ui-divider,var(--ui-border))}
.card-head h3{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em}
.option-box{display:flex;align-items:center;flex-wrap:wrap;gap:2px 12px;margin-bottom:18px;padding:6px 12px;border-radius:var(--ds-radius-sm,8px);background:var(--ds-canvas,var(--ui-raised))}
.option-box .hint{margin:0}
.field-label{margin-bottom:8px;font-size:var(--el-form-label-font-size,14px);line-height:22px;color:var(--el-text-color-regular,var(--ui-text))}
.source-kind-hint{margin-inline-start:6px;color:var(--ui-muted);font-size:11px}
.source-kind-options{
  --el-segmented-color:var(--ui-secondary);
  --el-segmented-bg-color:var(--ui-raised);
  --el-segmented-item-selected-color:var(--ui-accent);
  --el-segmented-item-selected-bg-color:var(--ui-accent-soft);
  --el-segmented-item-selected-disabled-bg-color:var(--ui-hover);
  width:min(100%,320px);min-height:var(--ds-control-height,36px);border:1px solid var(--ui-border);font-size:12px;
}
.source-kind-options :deep(.el-segmented__item){flex:1 1 0;padding-inline:6px}
.source-kind-options :deep(.el-segmented__item.is-selected){font-weight:600}
.source-kind-options :deep(.el-segmented__item-selected.is-focus-visible::before){outline-color:var(--ui-accent)}
.two-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.two-columns :deep(.el-date-editor),.task-layout :deep(.el-select),.task-layout :deep(.el-autocomplete){width:100%}
.label-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.label-row label{font-size:13px;font-weight:600}.tools{display:flex;align-items:center;gap:12px}.tools .el-button+.el-button{margin-left:0}
.input-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px}
.input-row>.el-button,.input-row :deep(.el-select__wrapper){min-height:var(--ds-control-height,36px)}
.input-row>.el-button{padding-inline:14px}
.input-row :deep(.el-select__wrapper){padding:4px 8px}
.input-row :deep(.el-select__selection){gap:4px}
.input-row :deep(.el-tag){height:22px;padding:0 6px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ds-canvas,var(--ui-raised));color:var(--ui-text);font-weight:500}
.input-row :deep(.el-tag .el-tag__close){margin-left:3px;color:var(--ui-secondary)}
.input-row :deep(.el-tag .el-tag__close:hover){background:var(--ui-hover);color:var(--ui-text)}
.project-tag-label{display:inline-block;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.option-path{margin-left:10px;color:var(--ui-secondary);font:11px var(--mono)}
.hint{margin:0 0 8px;font-size:12px;line-height:1.7;color:var(--ui-secondary);overflow-wrap:anywhere}.danger{margin:4px 0 0;font-size:12px;color:var(--ui-danger)}
.hint.scan-summary{margin:6px 0 12px}
.project-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));align-items:start;gap:12px;margin-bottom:14px}
/* 排期独立成组：标题 + 说明 + 日期，子任务排期折叠在组内。 */
.schedule-group{padding-top:14px;border-top:1px solid var(--ui-divider,var(--ui-border))}
.schedule-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);align-items:start;gap:8px 16px}
.schedule-row strong{display:block;font-size:13px;font-weight:600}
.schedule-row .hint{margin:4px 0 0}
.task-settings .schedule-row .two-columns :deep(.el-form-item){margin-bottom:0}
.advanced{margin-top:12px;border-top:1px solid var(--ui-divider,var(--ui-border))}
.advanced summary{display:flex;align-items:center;gap:8px;width:fit-content;padding:8px 0 0;list-style:none;cursor:pointer;font-size:12px;color:var(--ui-secondary);transition:color var(--ds-fast,160ms) ease}
.advanced .schedule-row{margin-top:10px}
.advanced .schedule-row + .schedule-row{padding-top:10px;border-top:1px solid var(--ui-divider,var(--ui-border))}
.advanced summary::-webkit-details-marker{display:none}
.advanced summary::before{content:'';width:5px;height:5px;margin:0 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform var(--ds-fast,160ms) ease}
.advanced[open]>summary::before{transform:rotate(45deg)}.advanced summary:hover{color:var(--ui-text)}
.scan-button{margin-top:8px}
.task-layout .notes{margin-bottom:0}
.continuation{display:flex;align-items:center;justify-content:space-between;gap:16px}.continuation p{margin:4px 0 0}.lock-hint{margin:0}
.task-actions{position:sticky;bottom:0;display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 0;border-top:1px solid var(--ui-border);background:var(--ui-bg)}
.task-actions .status{flex:1 1 160px;min-width:0;margin:0;font-size:12px;color:var(--ui-accent);white-space:pre-wrap;overflow-wrap:anywhere}.task-actions .status.pending{color:var(--ui-muted)}
.buttons{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-left:auto}.buttons .el-button+.el-button{margin-left:0}
/* 会话侧栏会改变可用空间，按面板宽度换列。 */
@container workspace-page (max-width: 960px){
  .task-settings.requirement-settings{grid-template-columns:repeat(2,minmax(0,1fr))}
  .requirement-settings>.design-source{grid-column:1/-1}
}
@container workspace-page (max-width: 740px){
  .task-source{grid-template-columns:minmax(0,1fr) auto}
  .source-label{grid-column:1/-1}
  .schedule-row{grid-template-columns:minmax(0,1fr)}
}
@container workspace-page (max-width: 560px){
  :is(.task-settings,.task-settings.requirement-settings,.task-source,.two-columns,.input-row){grid-template-columns:minmax(0,1fr)}
  .task-source{gap:8px}
  .schedule-row .two-columns{row-gap:8px}
  .option-box{display:block;padding-block:8px}
  .option-box .hint{margin-left:22px}
  .input-row>.el-button{justify-self:start}
  .task-actions{position:static}
  .task-actions .status,.buttons{flex-basis:100%}
}
</style>

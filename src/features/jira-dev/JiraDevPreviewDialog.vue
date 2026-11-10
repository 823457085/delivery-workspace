<script setup lang="ts">
/** 任务预览只展示计划与指令；确认按钮执行计划中的 Jira 写入后，在工作台启动会话。关闭不撤销已确认的操作。 */
import { computed, shallowRef, watch } from 'vue';
import { jiraDevRequirementDocumentUrl, jiraDevRequirementLabels, type JiraDevProjectSelection, type JiraDevTaskView } from '../../../shared/jira-dev';
import JiraDescription from '../jira-issue/JiraDescription.vue';
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
const props = defineProps<{ task?: JiraDevTaskView; busy: boolean; status: string; startLabel: string; canStart: boolean; runtimeSummary: string; requirementGroup: boolean; canReview: boolean }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ start: []; check: [developmentKey?: string]; review: []; openRun: [id: string] }>();
const repair = computed(() => props.task?.workflow === 'jira');
const plan = computed(() => props.task?.plan);
const needsDevelopmentSelection = computed(() => plan.value?.sourceKind === 'frontend' && plan.value.status === 'local' && !props.task?.launch);
const developmentCandidates = computed(() => needsDevelopmentSelection.value ? plan.value?.developmentCandidates || [] : []);
const developmentKey = shallowRef('');
watch([open, () => props.task?.taskId, developmentCandidates], ([visible, taskId, candidates], [, previousTaskId]) => {
  if (!visible || taskId !== previousTaskId || !candidates.some(issue => issue.key === developmentKey.value)) developmentKey.value = '';
});
const projects = computed<JiraDevProjectSelection[]>(() => !props.task ? [] : props.task.projects?.length ? props.task.projects : [
  { path: props.task.projectPath, baseBranch: props.task.baseBranch, branchName: props.task.branchName },
]);
const roles = computed<Record<string, string>>(() => ({ parent: '前端研发任务', design: '技术方案任务', implementation: repair.value ? '前端修复任务' : '功能实现任务' }));
const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const planStatus = computed(() => {
  const value = plan.value;
  if (!value) return '';
  if (value.warning) return value.warning;
  if (value.sourceKind === 'frontend' && value.status === 'ready') return value.requiresConfirmation ? '已找到可复用的任务，请核对下面列出的事项和日期变更。' : '已找到可复用的任务，确认后使用下列 Jira 事项，不新建任务。';
  if (repair.value && value.status === 'ready' && value.items.some(item => item.action === 'reuse')) {
    return value.sourceLink?.action === 'create' ? '已找到已有修复任务。确认后将它与原缺陷关联，并开始修复。' : '已找到与原缺陷关联的修复任务，确认后复用该任务并开始修复。';
  }
  if (repair.value) return value.status === 'applied' ? '前端任务已核对。后续开发与交接绑定前端任务，原缺陷继续等待联调与测试验收。' : '请核对前端任务；确认后建立关联，再在工作台启动修复会话。原缺陷状态和负责人保持不变。';
  return { local: 'Jira 尚待对齐，使用本地任务草稿继续技术方案与开发。', applied: 'Jira 前端任务已创建或关联。', unknown: 'Jira 任务写入结果待核对，当前不能重复创建或启动开发。',
    error: 'Jira 明确返回失败，请核对后确认重试未完成项；已创建项会复用，尚未启动开发。', ready: '请核对以下将创建或复用的任务，确认后才执行 Jira 操作。' }[value.status];
});
const assignee = (value: unknown) => typeof value === 'string' ? value : (value as { displayName?: string; name?: string; id?: string } | undefined)?.displayName
  || (value as { name?: string })?.name || (value as { id?: string })?.id || '未指派';
const launchText = computed(() => {
  const launch = props.task?.launch;
  if (!launch) return '';
  if (launch.conversationMissing) return '关联会话已不存在';
  const run = launch.runtime.collaborationMode !== 'automatic' && launch.runStatus ? { queued: '会话排队中', running: '会话执行中', completed: '本轮已结束', failed: '本轮失败', interrupted: '已中断', cancelled: '已取消' }[launch.runStatus] : '';
  return [{ preparing: '正在准备工作区', starting: '正在启动会话', started: '已启动会话', failed: '启动失败', uncertain: '启动结果待核对' }[launch.status], run, launch.workspacePath].filter(Boolean).join(' · ');
});
</script>

<template>
  <el-dialog v-model="open" title="确认本次任务" width="min(860px, 94vw)" class="jira-dev-preview" :close-on-click-modal="false" align-center append-to-body>
    <div v-if="task" class="preview-body">
      <p class="preview-meta">使用多语言位置编码：{{ task.useI18n === false ? '关闭' : '开启' }} · 执行：{{ runtimeSummary }}</p>
      <p v-for="project in projects" :key="project.path" class="preview-meta">项目：{{ project.path }} · 基准 origin/{{ project.baseBranch }} → {{ project.branchName }}<template v-if="project.workspacePath"><br>工作区：{{ project.workspacePath }}</template></p>
      <section v-if="requirementGroup" class="plan" aria-label="研发前置文档">
        <article v-for="phase in (['review', 'design'] as const)" :key="phase" class="plan-item">
          <strong>{{ jiraDevRequirementLabels[phase] }}</strong>
          <p>{{ task.preparation?.[phase]?.summary || (phase === 'review' ? '先核对 Jira、PRD、原型、设计稿和现有代码，形成评审文档。' : '确认 Jira 任务和排期后，先生成方案，再创建开发工作区。') }}</p>
          <template v-if="task.preparation?.[phase]?.markdown">
            <details><summary>查看{{ jiraDevRequirementLabels[phase] }}</summary>
              <AgentMarkdown :source="task.preparation[phase]!.markdown!" />
            </details>
            <a :href="jiraDevRequirementDocumentUrl(task.taskId, phase)" download>下载 Markdown</a>
          </template>
        </article>
      </section>
      <section v-if="plan" class="plan" :aria-label="repair ? '前端修复任务预览' : '需求完整流程与 Jira 任务预览'">
        <ol v-if="!repair" class="stages"><li v-if="requirementGroup">需求评审</li><li>确认 Jira 拆分与排期</li><li>前端技术方案</li><li>独立工作区与功能开发</li><li>多语言与 i18n-test 验证</li><li>访问地址与交接</li></ol>
        <p class="plan-line">{{ plan.sourceIssue?.key ? `来源：${plan.sourceIssue.key} · ${plan.sourceIssue.summary || ''}${plan.sourceIssue.url ? `\n站点与事项：${plan.sourceIssue.url}` : '\n来源未实时核验'}` : '来源：用户提供的需求正文' }}</p>
        <p v-if="plan.developmentIssue && plan.developmentIssue.key !== plan.sourceIssue?.key" class="plan-line">开发与交接目标：{{ plan.developmentIssue.key }} · {{ plan.developmentIssue.summary }}</p>
        <p v-if="plan.sourceKind === 'product'" class="plan-line">业务模块：{{ plan.businessModule || '未提供，请在左侧补充' }}</p>
        <p v-if="!repair" class="plan-line muted">{{ plan.designDestination ? `技术方案目录：${plan.designDestination.spaceKey} / ${plan.designDestination.title}（父页面 ${plan.designDestination.parentId}）\n${plan.designDestination.url}\n确认开始后，将本任务方案生成为该目录的子页面，并保留工作区 Markdown 备份。` : '技术方案：保存到工作区 docs/requirements/；该预览未包含 Confluence 发布。' }}</p>
        <p class="plan-status">{{ planStatus }}</p>
        <div v-if="needsDevelopmentSelection" class="development-selection">
          <template v-if="developmentCandidates.length">
            <el-select v-model="developmentKey" aria-label="选择要复用的开发主任务" placeholder="选择要复用的开发主任务" filterable :disabled="busy">
              <el-option v-for="issue in developmentCandidates" :key="issue.key" :value="issue.key" :label="`${issue.key} · ${issue.summary}`" />
            </el-select>
            <el-button :loading="busy" :disabled="!developmentKey" @click="emit('check', developmentKey)">只读核对所选任务</el-button>
            <el-button link :disabled="busy" @click="emit('check')">重新读取</el-button>
          </template>
          <el-button v-else :loading="busy" @click="emit('check')">读取关联开发主任务</el-button>
        </div>
        <article v-for="item in plan.items" :key="item.id || item.key || item.role" class="plan-item">
          <strong>{{ item.action === 'reuse' ? '复用' : item.key ? '已创建，后续复用' : '创建' }} · {{ roles[item.role] || item.role }} · {{ item.summary }}</strong>
          <p class="muted">{{ item.key || '尚未创建' }}{{ item.url ? ` · ${item.url}` : '' }}{{ item.parentRole ? `\n父任务：${roles[item.parentRole] || item.parentRole}` : '' }}</p>
          <p v-if="repair" class="muted">目标项目：{{ plan.targetProject?.key || '待核对' }}{{ '\n' }}负责人：{{ assignee(plan.assignee) }}{{ '\n' }}版本：{{ plan.fixVersions?.map(version => version.name || version.id).join('、') || '未指定' }}</p>
          <p v-if="item.schedule" class="muted">计划开始日期：{{ item.action === 'reuse' && item.schedule.changed ? `${item.schedule.previousStartDate || '未设置'} → ` : '' }}{{ item.schedule.startDate || '未设置' }}{{ '\n' }}计划结束日期：{{ item.action === 'reuse' && item.schedule.changed ? `${item.schedule.previousEndDate || '未设置'} → ` : '' }}{{ item.schedule.endDate || '未设置' }}{{ item.action === 'reuse' && item.schedule.changed ? '\n确认后修改此任务的日期。' : '' }}</p>
          <p v-if="item.workdays" class="muted">本子任务：{{ item.workdays }} 个工作日（最多 3 个工作日）</p>
          <details><summary>任务正文</summary><JiraDescription class="plan-description" :text="text(item.description)" :base-url="plan.sourceIssue?.url" /></details>
          <p v-if="item.error" class="danger">{{ item.error }}</p>
        </article>
        <p v-if="!repair" class="muted">技术方案保存后继续开发，不新增方案审批步骤。缺接口文档时先按暂拟接入格式实现，真实联调另行对齐。</p>
      </section>
      <details class="prompt" :open="!plan"><summary>完整开发指令</summary><el-input :model-value="task.prompt" type="textarea" :rows="12" readonly aria-label="将发送的完整任务" /></details>
      <p class="muted">{{ requirementGroup ? '前置文档完成后，工作台拉取所选基准并创建独立工作区；业务验证、访问地址和交接在群聊查看。' : '确认后为各项目拉取所选基准、创建独立工作区并启动会话。' }}</p>
      <p v-if="launchText" class="launch" role="status">{{ launchText }}<template v-if="task.launch?.error"><br><span class="danger">{{ task.launch.error }}</span></template></p>
      <p v-if="status && status !== planStatus" class="status" role="status">{{ status }}</p>
    </div>
    <template #footer>
      <div v-if="$slots.runtime" class="preview-runtime"><slot name="runtime" /></div>
      <div class="preview-actions">
        <el-button v-if="plan && !needsDevelopmentSelection" :loading="busy" @click="emit('check')">只读核对 Jira 任务</el-button>
        <el-button v-if="task?.launch && !task.launch.conversationMissing && (task.launch.groupRoomId || task.launch.runId || task.launch.conversationId)" @click="emit('openRun', task.launch.groupRoomId ? `group:${task.launch.groupRoomId}` : task.launch.conversationId || task.launch.runId)">{{ task.launch.groupRoomId ? '打开团队群聊' : '打开会话' }}</el-button>
        <el-button v-if="requirementGroup && !task?.launch && task?.preparation?.review?.status !== 'ready'" type="primary" :loading="busy || task?.preparation?.review?.status === 'running'" :disabled="!canReview" @click="emit('review')">生成需求评审</el-button>
        <el-button v-else type="primary" :loading="busy" :disabled="!canStart" @click="emit('start')">{{ startLabel }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.jira-dev-preview.el-dialog){display:flex;flex-direction:column;max-height:calc(100dvh - 32px)}
:global(.jira-dev-preview .el-dialog__header){flex-shrink:0}
:global(.jira-dev-preview .el-dialog__body){min-height:0;overflow:auto;overscroll-behavior:contain}
:global(.jira-dev-preview .el-dialog__footer){flex-shrink:0;padding-top:12px;border-top:1px solid var(--ui-divider,var(--ui-border))}
.preview-body{display:flex;flex-direction:column;gap:12px;padding-right:4px;color:var(--ui-text)}
.preview-runtime{container:jira-preview-runtime / inline-size;margin-bottom:12px;padding:10px 12px;border:1px solid var(--ui-border);border-radius:9px;background:var(--ui-raised);text-align:left}
.preview-runtime :deep(.runtime-provider){flex:1 1 104px;min-width:0}
.preview-runtime :deep(.runtime-model){flex:1.5 1 140px;min-width:0}
.preview-runtime :deep(.runtime-effort),.preview-runtime :deep(.runtime-access){flex:0 1 106px;min-width:0}
.preview-runtime :deep(.team-summary){flex:1 1 150px;min-width:0}
.preview-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.preview-actions :deep(.el-button){max-width:100%;min-height:32px;height:auto;margin:0;white-space:normal}
@container jira-preview-runtime (max-width:740px){
  .preview-runtime :deep(.runtime-picker){display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .preview-runtime :deep(.runtime-label){display:none}
  .preview-runtime :deep(:is(.collaboration-mode,.team-summary,.runtime-problem)){grid-column:1/-1}
  .preview-runtime :deep(.runtime-picker > .el-select){width:100%}
}
.preview-meta,.plan-line,.plan-status,.muted,.status,.launch{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.7}
.muted,.preview-meta{color:var(--ui-secondary)}.plan-status,.status{color:var(--ui-accent)}.danger{color:var(--ui-danger)}
.plan{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised)}
.development-selection{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.development-selection :deep(.el-select){flex:1 1 260px;min-width:0}
.development-selection :deep(.el-button){margin:0}
.stages{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;padding-left:18px;font-size:12px;color:var(--ui-secondary)}
.plan-item{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface)}
.plan-item p{margin:0;white-space:pre-wrap;font-size:12px}.plan-description{max-height:360px;overflow:auto;margin:8px 0 0}
summary{cursor:pointer;font-size:13px;color:var(--ui-secondary)}.prompt :deep(textarea){font:12px/1.6 var(--mono)}
@media(max-width:720px){.stages{grid-template-columns:1fr 1fr}}
</style>

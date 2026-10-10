<script setup lang="ts">
/** 交接表单只负责展示证据、编辑评论和确认目标；请求与幂等状态由 composable / 服务端负责。 */
import { computed, ref, watch } from 'vue';
import { jiraFixHandoffComment, type JiraFixHandoffContext, type JiraHandoffDateField } from '../../../shared/jira-fix-handoff';
const props = defineProps<{ open: boolean; loading: boolean; submitting: boolean; generating: boolean; applyingStatus: boolean; canApplyStatus: boolean; error: string; context?: JiraFixHandoffContext; dateFields: JiraHandoffDateField[]; locked: boolean; canSubmit: boolean }>();
const form = defineModel<{ transitionId: string; cause: string; impact: string; suggestion: string; conclusion: string }>({ required: true });
const feedback = defineModel<string>('feedback', { required: true });
const transitionFields = defineModel<Record<string, string>>('transitionFields', { required: true });
const emit = defineEmits<{ close: []; submit: []; generate: []; applyStatus: [] }>();
const view = ref('preview');
const hasDraft = computed(() => [form.value.cause, form.value.impact, form.value.suggestion, form.value.conclusion].some(value => value.trim()));
const preview = computed(() => jiraFixHandoffComment(form.value));
const unavailableStatuses = computed(() => {
  const context = props.context;
  const reachable = new Set(context?.transitions.map(item => item.to.id));
  if (context?.testingPath) reachable.add(context.testingPath.statuses.at(-1)!.id);
  return context?.statuses?.filter(item => item.id !== context.issue.status.id && !reachable.has(item.id)) || [];
});
watch(() => props.open, () => { view.value = 'preview'; });
watch(() => props.generating, (value, previous) => { if (!value && previous) view.value = 'preview'; });
</script>

<template>
  <el-dialog :model-value="open" title="交接 Jira" width="min(760px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!submitting && !applyingStatus" :show-close="!submitting && !applyingStatus" @update:model-value="!$event && emit('close')">
    <div v-loading="loading" class="handoff-body">
      <template v-if="context">
        <p class="handoff-issue"><strong>{{ context.issue.key }}</strong> · {{ context.issue.summary }}</p>
        <p>当前状态：{{ context.issue.status.name }}　报告人：{{ context.issue.reporter?.name || '未设置' }}</p>
        <p class="handoff-hint">先生成评论并预览，可直接修改或补充意见后重新生成。生成不写 Jira；确认后才发布评论、流转状态并指派给报告人。</p>
        <details class="handoff-evidence"><summary>查看本轮执行结果</summary><pre>{{ context.result || '未保存执行结果，请先打开修复会话核对。' }}</pre></details>
        <el-form label-position="top" :disabled="submitting || locked || generating || applyingStatus">
          <el-form-item label="目标状态" required>
            <div class="handoff-status-action">
            <el-select v-model="form.transitionId" placeholder="选择当前可直接流转的状态" filterable>
              <el-option :label="`${context.issue.status.name}（保持当前状态）`" value="__current__" />
              <el-option v-for="item in context.transitions" :key="item.id" :value="item.id" :label="`${item.to.name}（${item.name}）`" />
              <el-option v-if="context.testingPath" value="__testing__" label="测试中（按流程生效）" />
              <el-option v-for="item in unavailableStatuses" :key="`status:${item.id}`" :value="`status:${item.id}`" :label="`${item.name}（当前不可直接流转）`" disabled />
            </el-select>
            <el-button :disabled="!canApplyStatus" :loading="applyingStatus" @click="emit('applyStatus')">状态生效</el-button>
            </div>
            <p v-if="form.transitionId === '__testing__'" class="handoff-hint">路径：{{ [context.issue.status.name, ...(context.testingPath?.statuses.map(item => item.name) || [])].join(' → ') }}。先点“状态生效”完成提测，再确认评论和交接。</p>
            <p class="handoff-hint">{{ context.statusWarning || (context.statuses ? '显示该项目和事项类型的完整状态；灰色项受当前工作流或权限限制，不能直接跳转。' : '尚未读取完整状态，当前仅展示可直接流转的状态；请更新后台后重新打开。') }}</p>
          </el-form-item>
          <el-form-item v-for="field in dateFields" :key="field.id" :label="field.name" :required="field.required">
            <el-date-picker v-model="transitionFields[field.id]" type="date" format="YYYY-MM-DD" value-format="YYYY-MM-DD" :placeholder="field.name" />
          </el-form-item>
          <template v-if="!locked">
            <el-form-item label="补充意见"><el-input v-model="feedback" type="textarea" :rows="2" maxlength="6000" placeholder="例如：补充影响页面、说明未验证项，或调整评论表述" /></el-form-item>
            <el-button :loading="generating" :disabled="submitting || loading || applyingStatus" @click="emit('generate')">{{ hasDraft ? '按当前草稿和意见重新生成' : '生成评论' }}</el-button>
          </template>
          <el-tabs v-if="hasDraft" v-model="view" class="comment-tabs">
            <el-tab-pane label="评论预览" name="preview"><pre class="comment-preview">{{ preview }}</pre></el-tab-pane>
            <el-tab-pane label="直接修改" name="edit">
              <el-form-item label="问题原因" required><el-input v-model="form.cause" type="textarea" :rows="2" maxlength="6000" placeholder="填写已确认的根因及修复说明" /></el-form-item>
              <el-form-item label="影响范围" required><el-input v-model="form.impact" type="textarea" :rows="2" maxlength="6000" placeholder="涉及的模块、页面或场景" /></el-form-item>
              <el-form-item label="测试建议" required><el-input v-model="form.suggestion" type="textarea" :rows="2" maxlength="6000" placeholder="报告人需要回归的操作和边界" /></el-form-item>
              <el-form-item label="自测结论" required><el-input v-model="form.conclusion" type="textarea" :rows="3" maxlength="6000" placeholder="实际验证结果及未验证项，不以执行结束代替通过" /></el-form-item>
            </el-tab-pane>
          </el-tabs>
          <p v-else class="handoff-hint">点击“生成评论”，根据缺陷资料及修复会话结果生成四段交接草稿。</p>
        </el-form>
        <p v-if="!context.issue.reporter?.active" class="handoff-error">报告人缺失或已停用，无法指派，请先在 Jira 核对。</p>
        <div v-if="context.handoff" class="handoff-progress">
          <p>评论：{{ context.handoff.commentId ? '已发布' : '未确认' }} · 状态流转：{{ context.handoff.transitioned ? '已执行' : '未确认' }} · 指派：{{ context.handoff.assigned ? '已执行' : '未确认' }}</p>
          <p v-if="context.handoff.status === 'completed'">回读确认：{{ context.handoff.result?.status.name }} · {{ context.handoff.result?.assignee?.name }}</p>
          <p v-else-if="context.handoff.error">{{ context.handoff.error }}</p>
        </div>
      </template>
      <p v-if="error" class="handoff-error" role="status">{{ error }}</p>
    </div>
    <template #footer>
      <el-button :disabled="submitting || applyingStatus" @click="emit('close')">关闭</el-button>
      <el-button v-if="context?.handoff?.status !== 'completed'" type="primary" :disabled="!canSubmit" :loading="submitting" @click="emit('submit')">{{ locked ? '重试剩余步骤' : '评论并交接给报告人' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.handoff-body{min-height:100px;max-height:65vh;overflow:auto;padding:0 4px}.handoff-issue{margin-top:0}.handoff-hint{color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.handoff-evidence{margin:16px 0}.handoff-evidence summary{cursor:pointer}.handoff-evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font:12px/1.6 var(--mono)}.handoff-error{color:var(--el-color-danger);font-size:13px;line-height:1.6}.handoff-progress{font-size:12px;line-height:1.6}.el-select{width:100%}
.comment-tabs{margin-top:16px}.comment-preview{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:14px;line-height:1.8;margin:0 0 16px}
.handoff-status-action{display:flex;gap:12px;width:100%}.handoff-status-action .el-select{flex:1;min-width:0}.handoff-status-action .el-button{flex-shrink:0}
</style>

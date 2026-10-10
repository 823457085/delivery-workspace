<script setup lang="ts">
/** 详情分别展示源系统事实、本机资料和人工证据；未知阶段不会从一个 completed 状态推导通过。 */
import { computed, shallowRef, watch } from 'vue';
import { Check, CircleDashed, ExternalLink } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import DesignReviewForm from './DesignReviewForm.vue';
import ExecutionStatus from './ExecutionStatus.vue';
import { buildHandoff, inputGaps, reviewIsCurrent, stageChecks, type DesignCard, type DesignReview } from './domain';
import { dateTime, safeUrl } from '../../shared/format';
const props = defineProps<{ card: DesignCard; executorReady: boolean; pending: boolean }>();
defineEmits<{ edit: []; remove: []; review: [review: DesignReview, blockedReason: string]; start: []; resume: [clarification: string]; stop: [] }>();
const visible = defineModel<boolean>({ default: false });
const tab = shallowRef('progress');
watch(() => props.card.execution?.id, (id) => { if (id) tab.value = 'execution'; }, { immediate: true });
const checks = computed(() => stageChecks(props.card));
const gaps = computed(() => inputGaps(props.card.input));
const handoff = computed(() => buildHandoff(props.card));
async function copy() {
  try { await navigator.clipboard.writeText(handoff.value); ElMessage.success('已复制交接内容，尚未创建会话或派发任务'); }
  catch { tab.value = 'handoff'; ElMessage.warning('无法访问剪贴板，请在交接文本框中手动复制'); }
}
</script>

<template>
  <RecordDrawer v-model="visible" :title="card.input.title" :subtitle="card.key" :record="card">
    <el-tabs v-model="tab">
      <el-tab-pane v-if="card.execution" label="执行进度" name="execution"><ExecutionStatus :run="card.execution" :pending="pending" @resume="$emit('resume', $event)" @stop="$emit('stop')" /></el-tab-pane>
      <el-tab-pane label="流程与证据" name="progress">
        <el-alert v-if="card.local?.review.checkedAt && !reviewIsCurrent(card)" type="warning" title="源记录已变化：此前人工核验需重新核对，旧证据仍保留。" :closable="false" show-icon />
        <div class="design-stages"><article v-for="(stage, index) in checks" :key="stage.title" :class="{ checked: stage.done }"><span class="stage-icon"><Check v-if="stage.done" :size="17" /><CircleDashed v-else :size="17" /></span><div><header><h3>{{ index + 1 }}. {{ stage.title }}</h3><span>{{ stage.done ? stage.label : '待核验' }}</span></header><p>{{ stage.detail }}</p></div></article></div>
        <el-alert v-if="gaps.length" type="warning" :title="`资料缺项：${gaps.join('、')}`" :closable="false" show-icon />
        <div class="detail-section"><h3>原系统事实</h3><dl class="detail-facts"><div><dt>执行状态（原系统上报）</dt><dd>{{ card.job?.status || card.plan?.jobStatus || '无执行记录' }}</dd></div><div><dt>Jira 状态（最近读取）</dt><dd>{{ card.plan?.issue.status || '当前计划中无此事项' }}</dd></div><div><dt>Codex 会话</dt><dd>{{ card.job?.threadId || '无已确认会话' }}</dd></div><div><dt>Jira 父事项</dt><dd>{{ card.plan?.issue.parent?.key || '尚未回读' }}</dd></div></dl>
          <div class="inline-links"><a v-if="safeUrl(card.job?.issueUrl || card.plan?.issue.url)" :href="safeUrl(card.job?.issueUrl || card.plan?.issue.url)" target="_blank" rel="noreferrer">打开 Jira <ExternalLink :size="12" /></a><a v-if="safeUrl(card.job?.artifactUrl)" :href="safeUrl(card.job?.artifactUrl)" target="_blank" rel="noreferrer">打开上报的方案文档 <ExternalLink :size="12" /></a></div>
          <p>{{ card.job?.result || '原系统未提供完整交付结果；Jira 已完成、文档链接存在均不能代替逐项回读。' }}</p><el-alert v-if="card.job?.error || card.local?.blockedReason" type="error" :title="card.local?.blockedReason || card.job?.error" :closable="false" />
        </div>
        <div class="detail-section"><h3>需求资料 <small>本机补充不会写回原需求</small></h3><dl class="detail-facts"><div><dt>Jira 项目 Key / Fix Version</dt><dd>{{ card.input.project || '待核实' }} / {{ card.input.fixVersion || '待核实' }}</dd></div><div><dt>负责人</dt><dd>{{ card.input.assignee || '待核实' }}</dd></div><div><dt>Jira 计划日期</dt><dd>{{ card.input.jiraStartDate || '未填写' }} → {{ card.input.jiraEndDate || '未填写' }}</dd></div><div><dt>工作区</dt><dd>{{ card.input.workspacePath || '未填写' }}</dd></div><div><dt>分支</dt><dd>{{ card.input.branch || '未填写' }}</dd></div></dl><div class="inline-links"><a v-if="safeUrl(card.input.prdUrl)" :href="safeUrl(card.input.prdUrl)" target="_blank" rel="noreferrer">PRD</a><a v-if="safeUrl(card.input.prototypeUrl)" :href="safeUrl(card.input.prototypeUrl)" target="_blank" rel="noreferrer">原型 / 截图来源</a><a v-if="safeUrl(card.input.confluenceParentUrl)" :href="safeUrl(card.input.confluenceParentUrl)" target="_blank" rel="noreferrer">Confluence 目标目录</a></div><p>{{ card.input.notes || '暂无额外资料说明' }}</p></div>
        <p class="source-footnote">人工记录：{{ card.local?.review.reviewer || '未登记' }} · {{ dateTime(card.local?.review.checkedAt) }}。资料填写、人工核验、远端验证和 G2a 审批分别记录。</p>
      </el-tab-pane>
      <el-tab-pane v-if="!card.execution" label="人工记录（可选）" name="review"><DesignReviewForm :card="card" @save="(review, reason) => $emit('review', review, reason)" /></el-tab-pane>
      <el-tab-pane v-if="!card.execution" label="交接预览" name="handoff"><el-alert type="info" title="确认创建任务后，在执行详情中获取绑定任务的 Codex 指令。复制预览不会执行。" :closable="false" /><el-input :model-value="handoff" type="textarea" :rows="20" readonly aria-label="Codex 执行交接内容" /><el-button class="copy-button" @click="copy">复制交接内容</el-button></el-tab-pane>
    </el-tabs>
    <template #footer><el-button v-if="card.local && !card.execution" type="danger" plain @click="$emit('remove')">移除本机记录</el-button><el-button v-if="!card.execution" @click="$emit('edit')">编辑任务输入</el-button><el-button v-if="!card.execution" type="primary" :disabled="!executorReady" :loading="pending" @click="$emit('start')">启动自动执行</el-button></template>
  </RecordDrawer>
</template>

<style scoped>
.design-stages{margin:10px 0 20px}.design-stages article{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--ui-divider)}.stage-icon{width:30px;height:30px;background:var(--ui-raised);color:var(--ui-muted);border:1px solid var(--ui-border);border-radius:8px;display:grid;place-items:center;flex-shrink:0}.checked .stage-icon{color:var(--ui-success);background:var(--ui-success-bg);border-color:var(--ui-success)}.design-stages article>div{flex:1;min-width:0}.design-stages header{display:flex;align-items:center;justify-content:space-between;gap:12px}.design-stages h3{font-size:13px;margin:3px 0}.design-stages header span{font-size:11px;color:var(--ui-muted);flex-shrink:0}.checked header span{color:var(--ui-success)}.design-stages p{font-size:12px;line-height:1.8;color:var(--ui-secondary);margin:5px 0 0}.detail-section small{font-size:11px;color:var(--ui-muted);font-weight:400;display:inline-block;margin-left:8px}.copy-button{margin-top:14px}
</style>

<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { ArrowUpRight, Check, ChevronDown, CircleAlert, CircleDashed, LoaderCircle, ShieldCheck } from '@lucide/vue';
import { EXECUTION_STAGES, isCurrentStepResult, type ExecutionDashboard, type ExecutionStage } from '../../../shared/design-execution';
import { executionCounts, executionLanes } from './domain';
import { dateTime } from '../../shared/format';

const props = defineProps<{ dashboard?: ExecutionDashboard; error: Error | null; updatedAt: number; activeStatus: string }>();
defineEmits<{ filter: [status: string]; open: [key: string] }>();
const counts = computed(() => executionCounts(props.dashboard?.runs));
const selectedRunId = shallowRef('');
const selectedStage = shallowRef<ExecutionStage>('intake');
const focusedRun = computed(() => {
  const runs = props.dashboard?.runs || [];
  return runs.find(run => run.id === selectedRunId.value) || runs.find(run => run.status === 'running') ||
    runs.find(run => run.status === 'blocked') || runs[0];
});
watch(() => focusedRun.value?.id, () => {
  selectedStage.value = focusedRun.value?.steps.find(step => step.status === 'running' || step.status === 'blocked')?.id ||
    focusedRun.value?.steps.find(step => step.status === 'pending')?.id || 'intake';
}, { immediate: true });
const stages = computed(() => EXECUTION_STAGES.map(stage => ({
  ...stage, step: focusedRun.value?.steps.find(step => step.id === stage.id),
})));
const selected = computed(() => stages.value.find(stage => stage.id === selectedStage.value)!);
const statusLabels = { pending: '等待执行', running: '执行中', passed: '已通过', blocked: '待处理' };
const stageOutputs: Record<ExecutionStage, string> = {
  intake: '需求、版本、工作区与发布目录', research: 'PRD、原型与代码证据', design: '技术方案与需求覆盖矩阵',
  publish: 'Confluence 文档与版本', jira: 'DEV 父任务、方案与实现子任务', verify: '文档与 Jira 回读回执',
};
const capabilities = computed(() => {
  const health = props.dashboard?.health;
  if (health?.mode === 'codex-desktop') return [
    { title: '执行方式', ok: true, detail: '当前 Codex 会话；不启动 CLI' },
    { title: 'Codex / Atlassian', ok: null, detail: '由执行会话核实账号、工具及远端权限' },
    { title: '领取 / 回写', ok: true, detail: '接口可用；不代表会话已领取任务' },
    { title: 'Skill / 规范包', ok: health.skillsReady, detail: health.skillsReady ? '交付技能与规范包存在' : '交付技能或规范包缺失' },
  ];
  return [
    { title: 'Codex CLI', ok: !!health?.cli, detail: health?.cli || '未找到可用 CLI' },
    { title: 'Codex 账号', ok: !!health?.authenticated, detail: health?.authenticated ? '本机登录状态可用' : '尚未登录' },
    { title: 'Atlassian', ok: !!health?.atlassianConfigured, detail: '本机连接配置；远端权限在执行时核实' },
    { title: 'Skill / 规范包', ok: !!health?.skillsReady, detail: health?.skillsReady ? '交付技能与规范包已就绪' : '交付技能或规范包缺失' },
  ];
});
</script>

<template>
  <section class="executor-overview" aria-label="自动执行概况">
    <div class="execution-metrics">
      <button v-for="item in executionLanes" :key="item.id" class="execution-metric" :class="[`tone-${item.tone}`, { active: activeStatus === item.id }]" :aria-pressed="activeStatus === item.id" :disabled="!dashboard" @click="$emit('filter', activeStatus === item.id ? 'all' : item.id)">
        <div class="metric-label"><i></i><span>{{ item.title }}</span><ArrowUpRight :size="14" /></div>
        <strong>{{ dashboard ? counts[item.id] : '—' }}</strong><small>{{ item.description }}</small>
      </button>
    </div>
    <details class="environment" :open="!!error || (!!dashboard && !dashboard.health.ready)">
      <summary><ShieldCheck :size="15" /><strong>执行环境</strong><span :class="error ? 'danger' : dashboard?.health.ready ? 'success' : ''">{{ error ? '连接异常 · 缓存可能过期' : dashboard ? dashboard.health.ready ? '本机配置就绪' : '需要配置' : '正在连接…' }}</span><ChevronDown :size="13" /><span class="environment-time">最近读取 {{ dateTime(updatedAt) }}</span></summary>
      <div class="capabilities">
        <div v-for="item in capabilities" :key="item.title"><CircleDashed v-if="!dashboard || error || item.ok === null" :size="17" /><Check v-else-if="item.ok" class="success" :size="17" /><CircleAlert v-else class="danger" :size="17" /><div><strong>{{ item.title }}</strong><p>{{ !dashboard || error ? '状态待核实' : item.detail }}</p></div></div>
      </div>
      <p class="environment-message">{{ error?.message || dashboard?.health.message || '等待后台执行器响应' }} <router-link to="/settings">交付设置 <ArrowUpRight :size="12" /></router-link></p>
    </details>
    <section class="workflow" aria-label="交付工作流">
      <header class="workflow-heading"><div><h2>交付工作流</h2><span>{{ focusedRun ? `${focusedRun.steps.filter(item => item.status === 'passed').length} / 6 阶段已通过` : '6 个阶段' }}</span></div><el-select v-if="dashboard?.runs.length" :model-value="focusedRun?.id" aria-label="查看任务工作流" @update:model-value="selectedRunId = $event"><el-option v-for="run in dashboard.runs" :key="run.id" :value="run.id" :label="`${run.input.issueKey} · ${run.input.title}`" /></el-select></header>
      <ol class="workflow-stages">
        <li v-for="(stage, index) in stages" :key="stage.id">
          <button :class="[stage.step?.status, { selected: selectedStage === stage.id }]" :aria-pressed="selectedStage === stage.id" @click="selectedStage = stage.id">
            <span class="stage-marker"><Check v-if="stage.step?.status === 'passed'" :size="16" /><LoaderCircle v-else-if="stage.step?.status === 'running'" class="spin" :size="16" /><CircleAlert v-else-if="stage.step?.status === 'blocked'" :size="16" /><span v-else>{{ index + 1 }}</span></span>
            <strong>{{ stage.title }}</strong><small>{{ focusedRun ? statusLabels[stage.step?.status || 'pending'] : '尚未启动' }}</small>
          </button>
        </li>
      </ol>
      <div class="stage-inspector" :class="{ 'has-blocker': selected.step?.status === 'blocked' }">
        <div><h3>{{ selected.title }} <span v-if="selected.step">{{ statusLabels[selected.step.status] }} · 尝试 {{ selected.step.attempts }} 次</span></h3><p>{{ focusedRun?.status === 'queued' && selected.step?.status !== 'passed' ? '等待 Codex 会话领取，尚未开始执行' : selected.step?.summary || stageOutputs[selectedStage] }}</p><small v-if="selected.step?.endedAt || selected.step?.startedAt">{{ selected.step.endedAt ? '结束' : '开始' }} {{ dateTime(selected.step.endedAt || selected.step.startedAt) }} · {{ isCurrentStepResult(selected.step) ? `${selected.step.proof.filter(proof => proof.succeeded).length} 条工具成功记录` : '本轮尚无结构化结果' }}</small></div>
        <el-button v-if="focusedRun" @click="$emit('open', focusedRun.input.issueKey)">任务详情 <ArrowUpRight :size="14" /></el-button>
      </div>
      <p v-if="focusedRun?.status === 'blocked' && selected.step?.status !== 'blocked'" class="run-blocker"><CircleAlert :size="14" />{{ focusedRun.error || '任务已暂停，打开详情补充资料后续跑。' }}</p>
    </section>
  </section>
</template>

<style scoped>
.executor-overview{margin-bottom:22px;min-width:0}
.execution-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.execution-metric{--metric-color:var(--ui-accent);padding:15px 18px;background:var(--ui-surface);border:1px solid var(--ui-border);border-top:3px solid var(--metric-color);border-radius:8px;text-align:left;cursor:pointer;color:var(--ui-text)}
.execution-metric:hover,.execution-metric.active{border-color:var(--metric-color)}
.tone-warning{--metric-color:var(--ui-warning)}.tone-danger{--metric-color:var(--ui-danger)}.tone-success{--metric-color:var(--ui-success)}
.metric-label{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--ui-secondary)}.metric-label>svg{margin-left:auto}.metric-label i{width:6px;height:6px;border-radius:50%;background:var(--metric-color)}
.execution-metric strong{display:block;font:28px var(--mono);color:var(--metric-color);margin:8px 0}.execution-metric small{font-size:11px;color:var(--ui-muted);line-height:1.8;display:block}
.environment{border-bottom:1px solid var(--ui-border);padding:14px 0}.environment summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;font-size:12px}.environment summary strong{font-weight:500}.environment-time{margin-left:auto;color:var(--ui-muted);font-size:11px}
.success{color:var(--ui-success)}.danger{color:var(--ui-danger)}
.capabilities{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:20px 0 6px}.capabilities>div{display:flex;gap:9px;min-width:0}.capabilities svg{flex-shrink:0}.capabilities strong{font-size:12px}
.capabilities p,.environment-message{font-size:11px;line-height:1.8;color:var(--ui-secondary);margin:6px 0;overflow-wrap:anywhere}.environment-message a{display:inline-flex;align-items:center;color:var(--ui-accent);margin-left:10px}
.workflow{padding:20px 0 0;border-bottom:1px solid var(--ui-border)}.workflow-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.workflow-heading>div:first-child{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.workflow-heading h2{font-size:14px;margin:0}.workflow-heading span{font-size:11px;color:var(--ui-muted)}.workflow-heading>.el-select{width:310px;max-width:100%}
.workflow-stages{list-style:none;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:0;padding:0}.workflow-stages li{min-width:0}
.workflow-stages button{width:100%;min-height:112px;display:flex;align-items:flex-start;flex-direction:column;gap:8px;padding:10px 8px;background:transparent;border:0;border-bottom:2px solid var(--ui-border);color:var(--ui-secondary);cursor:pointer;text-align:left}.workflow-stages button:hover,.workflow-stages button.selected{background:var(--ui-raised);border-bottom-color:var(--ui-accent)}
.stage-marker{display:grid;place-items:center;width:26px;height:26px;border:1px solid var(--ui-border);border-radius:50%;font:11px var(--mono);background:var(--ui-surface)}.workflow-stages strong{font-size:12px;line-height:1.6;overflow-wrap:anywhere}.workflow-stages small{font-size:11px;color:var(--ui-muted)}
.passed .stage-marker{color:var(--ui-success);border-color:var(--ui-success)}.blocked .stage-marker{color:var(--ui-danger);border-color:var(--ui-danger)}.running .stage-marker{color:var(--ui-accent);border-color:var(--ui-accent)}
.stage-inspector{display:flex;align-items:flex-start;gap:20px;padding:15px 0 18px}.stage-inspector>div{flex:1;min-width:0}.stage-inspector h3{margin:0;font-size:12px;line-height:1.8}.stage-inspector h3 span{font-weight:400;font-size:11px;color:var(--ui-muted);margin-left:8px}.stage-inspector p{font-size:12px;line-height:1.8;color:var(--ui-secondary);margin:6px 0;overflow-wrap:anywhere;max-height:86px;overflow:auto}.stage-inspector small{font-size:11px;color:var(--ui-muted)}.stage-inspector.has-blocker p{color:var(--ui-danger)}.stage-inspector .el-button{gap:5px}
.run-blocker{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.8;color:var(--ui-danger);overflow-wrap:anywhere;margin:0 0 16px}.run-blocker svg{flex-shrink:0;margin-top:4px}
@media(max-width:900px){.workflow-stages{grid-template-columns:repeat(3,minmax(0,1fr))}.capabilities{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.execution-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.execution-metric{padding:12px}.environment-time{width:100%;margin-left:25px}.workflow-heading{align-items:flex-start;flex-direction:column}.workflow-heading>.el-select{width:100%}.stage-inspector{flex-direction:column;gap:10px}.workflow-stages{gap:4px}.workflow-stages button{min-height:130px;padding:8px 4px}.stage-inspector h3 span{display:block;margin:0}.capabilities{gap:12px}}
</style>

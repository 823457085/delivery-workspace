<script setup lang="ts">
/** 分栏由证据规则派生，不允许拖拽伪造完成；卡片只发出打开事件。 */
import { computed } from 'vue';
import { ArrowUpRight, FileText, GitBranch } from '@lucide/vue';
import { cardLane, inputGaps, executionLanes, lanes, stageChecks, type DesignCard, type DesignView } from './domain';
import { EXECUTION_STAGES } from '../../../shared/design-execution';
import { dateTime } from '../../shared/format';
const props = defineProps<{ cards: DesignCard[]; view: DesignView }>();
defineEmits<{ open: [key: string] }>();
const columns = computed(() => {
  const definitions = props.view === 'executions' ? executionLanes : props.view === 'drafts' ? [{ id: 'prepare', title: '待启动', description: '输入已保存 · 尚未授权执行', tone: 'muted' }] : lanes.filter((lane) => props.cards.some((card) => cardLane(card) === lane.id));
  return definitions.map((lane) => ({ ...lane, cards: props.cards.filter((card) => props.view === 'drafts' || (props.view === 'executions' ? card.execution?.status : cardLane(card)) === lane.id).map((card) => {
    const stages = stageChecks(card);
    return { ...card, stages, checked: stages.filter((stage) => stage.done).length, gaps: inputGaps(card.input),
      currentStage: EXECUTION_STAGES.find((stage) => stage.id === card.execution?.steps.find((step) => step.status === 'running')?.id)?.title };
  }) }));
});
</script>

<template>
  <div class="design-kanban" :class="`view-${view}`" :style="{ '--column-count': columns.length }" role="region" :aria-label="view === 'executions' ? '自动执行队列' : view === 'drafts' ? '待启动草稿' : '历史方案记录'">
    <section v-for="column in columns" :key="column.id" class="design-column" :class="`tone-${column.tone}`" :aria-label="column.title">
      <header class="column-heading"><div><span class="column-dot"></span><h2>{{ column.title }}</h2><b>{{ column.cards.length }}</b></div><p>{{ column.description }}</p></header>
      <div class="column-body">
        <button v-for="card in column.cards" :key="card.key" class="design-card" :aria-label="`查看 ${card.key} ${card.input.title}`" @click="$emit('open', card.key)">
          <div class="card-eyebrow"><span>{{ card.key }}</span><ArrowUpRight :size="15" /></div>
          <h3>{{ card.input.title }}</h3>
          <div class="card-badges"><span>{{ card.execution ? 'Codex 会话执行' : view === 'drafts' ? '尚未启动' : '历史记录' }}</span><span v-if="card.local && (card.job || card.plan)">含原系统资料</span></div>
          <p v-if="card.execution" :class="card.execution.error ? 'card-blocker' : 'card-note'">{{ card.execution.status === 'queued' ? '等待 Codex 会话领取' : card.execution.error || (card.currentStage ? `当前步骤：${card.currentStage}` : card.execution.status === 'completed' ? '文档与 Jira 已回读 · G2a 待签署' : '等待阶段结果回写') }}</p>
          <p v-else-if="view === 'drafts'" class="card-note">{{ !card.input.workspacePath || !card.input.confluenceParentUrl ? '补齐仓库路径与发布目录后即可确认启动' : '输入已保存，打开草稿确认启动自动执行' }}</p>
          <p v-else-if="card.local?.blockedReason || card.job?.error" class="card-blocker">{{ card.local?.blockedReason || card.job?.error }}</p>
          <p v-else-if="column.id === 'verified'" class="card-note">人工核验已登记 · 尚未自动回读</p>
          <p v-else class="card-note">{{ card.job ? `执行上报：${card.job.status} · 尚需分项核验` : card.plan ? `Jira：${card.plan.issue.status} · 无完整交付回读` : `待补：${card.gaps.join('、') || '资料待权威来源核实'}` }}</p>
          <div class="card-meta"><FileText :size="13" /><span>{{ card.execution?.artifacts.fixVersion || card.input.fixVersion || '版本待核实' }}</span></div>
          <div class="card-meta"><GitBranch :size="13" /><span>{{ card.input.branch || '分支待核实' }}</span></div>
          <div v-if="view !== 'drafts'" class="card-stages" :aria-label="`${card.checked} / 6 ${card.execution ? '步已通过' : '项已登记'}`"><i v-for="(stage, index) in card.stages" :key="index" :class="{ filled: stage.done }" :title="`${stage.title}：${stage.done ? stage.label : '待核验'}`"></i></div>
          <footer><span>{{ view === 'drafts' ? '打开草稿 → 确认启动' : `${card.checked} / 6 ${card.execution ? '步已通过' : '项登记'}` }}</span><time>{{ dateTime(card.updatedAt) }}</time></footer>
        </button>
        <div v-if="!column.cards.length" class="column-empty"><span>—</span><p>暂无{{ column.title }}的事项</p></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.design-kanban{display:grid;grid-template-columns:repeat(var(--column-count),minmax(220px,1fr));gap:14px;overflow:auto;padding:2px 2px 16px}.design-column{--lane-color:var(--ui-muted);background:var(--ui-raised);border:1px solid var(--ui-border);border-radius:11px;min-width:0}.tone-accent{--lane-color:var(--ui-accent)}.tone-warning{--lane-color:var(--ui-warning)}.tone-danger{--lane-color:var(--ui-danger)}.tone-success{--lane-color:var(--ui-success)}.column-heading{padding:17px 14px;border-top:3px solid var(--lane-color);border-radius:10px 10px 0 0}.column-heading>div{display:flex;align-items:center;gap:8px}.column-heading h2{font-size:13px;margin:0;font-weight:650}.column-heading b{margin-left:auto;font:12px var(--mono);color:var(--lane-color);background:var(--ui-surface);padding:3px 7px;border-radius:5px}.column-heading p{font-size:11px;color:var(--ui-muted);margin:8px 0 0}.column-dot{height:7px;width:7px;border-radius:50%;background:var(--lane-color)}.column-body{padding:0 10px 10px;max-height:670px;min-height:305px;overflow:auto}.design-card{width:100%;display:block;text-align:left;background:var(--ui-surface);color:var(--ui-text);font:inherit;border:1px solid var(--ui-border);border-radius:8px;padding:15px;margin-bottom:11px;cursor:pointer;box-shadow:0 2px 5px color-mix(in srgb,var(--ui-text) 4%,transparent);transition: border-color .15s,transform .15s}.design-card:hover{border-color:var(--ui-accent);transform:translateY(-2px)}.design-card:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.card-eyebrow{display:flex;justify-content:space-between;align-items:center;color:var(--ui-accent);font:11px var(--mono)}.design-card h3{font-size:13px;line-height:1.8;margin:11px 0;overflow-wrap:anywhere}.card-badges{display:flex;gap:5px;flex-wrap:wrap}.card-badges span{color:var(--ui-secondary);background:var(--ui-raised);border:1px solid var(--ui-divider);border-radius:4px;padding:3px 6px;font-size:10px}.card-note,.card-blocker{font-size:11px;line-height:1.8;color:var(--ui-muted);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.card-blocker{color:var(--ui-danger)}.card-meta{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--ui-secondary);margin-top:7px;min-width:0}.card-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card-stages{display:flex;gap:4px;margin:17px 0 9px}.card-stages i{flex:1;height:4px;border-radius:2px;background:var(--ui-border)}.card-stages i.filled{background:var(--ui-accent)}.design-card footer{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--ui-muted)}.column-empty{text-align:center;border:1px dashed var(--ui-border);border-radius:8px;padding:42px 8px;color:var(--ui-muted);font-size:11px}.column-empty>span{font-size:20px}.column-empty p{line-height:1.8}@media(max-width:650px){.design-kanban{grid-template-columns:minmax(0,1fr)}.column-body{min-height:0;max-height:520px}.column-empty{padding:14px}.design-card h3{font-size:14px}}
.view-history .column-body,.view-drafts .column-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(230px,100%),1fr));align-content:start;gap:12px}.view-history .design-card,.view-drafts .design-card{margin-bottom:0}.view-drafts .design-card footer{margin-top:18px}
</style>

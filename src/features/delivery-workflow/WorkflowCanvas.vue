<script setup lang="ts">
import { computed } from 'vue';
import { ScanLine, Sparkles, ListChecks, UserRoundCheck, GitMerge, ReceiptText, Check, LoaderCircle, Pause, ArrowRight, ArrowLeft, ArrowDown } from '@lucide/vue';
import { WORKFLOW_STEPS, type RunView } from '../../../shared/types';
const props = defineProps<{ run?: RunView; selectedStep: string }>();
defineEmits<{ select: [id: string] }>();
const icons = [ScanLine, Sparkles, ListChecks, UserRoundCheck, GitMerge, ReceiptText];
const steps = computed(() => props.run?.steps ?? WORKFLOW_STEPS.map((item) => ({ ...item, status: 'pending' as const })));
const statusText = { pending: '等待执行', running: '执行中', suspended: '已暂停', success: '已完成', failed: '失败' };
</script>

<template>
  <section class="canvas" aria-label="Mastra 工作流图">
    <div class="canvas-heading"><span class="flow-tag"><span></span>delivery-workflow</span><span>6 STEPS <span class="dot-separator">·</span> v0.1</span></div>
    <div class="flow-grid">
      <button v-for="(step, index) in steps" :key="step.id" class="flow-node" :class="[step.status, { focused: selectedStep === step.id }]" :style="{ gridColumn: index < 3 ? index + 1 : 6 - index, gridRow: index < 3 ? 1 : 2 }" @click="$emit('select', step.id)">
        <span class="node-top"><span class="node-icon"><component :is="icons[index]" :size="19" /></span><span class="node-number">0{{ index + 1 }}</span></span>
        <strong>{{ step.title }}</strong><span class="node-subtitle">{{ step.subtitle }}</span>
        <span class="node-state"><Check v-if="step.status === 'success'" :size="12" /><Pause v-else-if="step.status === 'suspended'" :size="12" /><LoaderCircle v-else-if="step.status === 'running'" :size="12" class="spin" />{{ statusText[step.status] }}</span>
      </button>
      <span class="connector c1"><ArrowRight :size="18" /></span><span class="connector c2"><ArrowRight :size="18" /></span><span class="connector c3"><ArrowDown :size="18" /></span><span class="connector c4"><ArrowLeft :size="18" /></span><span class="connector c5"><ArrowLeft :size="18" /></span>
    </div>
    <div class="canvas-footer"><span><i class="legend done"></i>已完成</span><span><i class="legend paused"></i>等待输入</span><span><i class="legend pending"></i>尚未执行</span><span class="canvas-hint">点击节点查看详情</span></div>
  </section>
</template>

<style scoped>
.flow-node.pending{background:var(--ui-surface)}
.canvas{padding:18px 24px 16px;background-color:var(--ui-accent-soft);background-image:radial-gradient(var(--ui-accent-soft) .7px,transparent .7px);background-size:15px 15px;border-bottom:1px solid var(--line)}.canvas-heading{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;color:var(--ui-muted);margin-bottom:26px}.flow-tag{display:flex;align-items:center;gap:7px;color:var(--ui-secondary);background:var(--ui-surface);border:1px solid var(--line);padding:5px 8px;border-radius:5px}.flow-tag span{width:6px;height:6px;border-radius:2px;background:var(--accent)}.dot-separator{padding:0 6px}
.flow-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:38px 32px;position:relative}.flow-node{position:relative;min-width:0;background:var(--ui-surface);border:1px solid var(--ui-border);padding:13px 14px 10px;border-radius:10px;text-align:left;color:var(--text);cursor:pointer;box-shadow:0 3px 7px var(--ui-shadow-color);z-index:1;transition:box-shadow .2s,border-color .2s}.flow-node:hover,.flow-node.focused{box-shadow:0 0 0 3px var(--ui-shadow-color);border-color:var(--ui-border)}.flow-node.success{border-color:var(--ui-border)}.flow-node.suspended{border-color:var(--ui-border);background:var(--ui-warning-bg);box-shadow:0 0 0 3px var(--ui-shadow-color)}.flow-node.running{border-color:var(--ui-border)}.node-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}.node-icon{width:31px;height:31px;background:var(--ui-accent-soft);color:var(--ui-muted);border-radius:8px;display:grid;place-items:center}.success .node-icon{color:var(--accent);background:var(--ui-success-bg)}.suspended .node-icon{color:var(--ui-warning);background:var(--ui-warning-bg)}.running .node-icon{color:var(--accent);background:var(--ui-success-bg)}.node-number{font:11px var(--mono);color:var(--ui-muted)}.flow-node strong{display:block;font-size:14px;font-weight:600}.node-subtitle{display:block;font-size:11px;color:var(--muted);line-height:1.5;margin:5px 0 11px}.node-state{font-size:11px;display:flex;align-items:center;gap:4px;color:var(--ui-muted);border-top:1px solid var(--ui-border);padding-top:8px}.success .node-state{color:var(--accent)}.suspended .node-state{color:var(--ui-warning)}.running .node-state{color:var(--accent)}
.connector{position:absolute;color:var(--ui-muted);display:flex;align-items:center;justify-content:center}.c1{left:calc(33.333% - 10px);top:23%}.c2{left:calc(66.666% + 1px);top:23%}.c3{left:calc(83.333% - 5px);top:calc(50% - 9px)}.c4{left:calc(66.666% + 1px);top:76%}.c5{left:calc(33.333% - 10px);top:76%}.canvas-footer{margin-top:20px;display:flex;align-items:center;gap:14px;color:var(--ui-muted);font-size:11px}.canvas-footer span{display:flex;align-items:center;gap:5px}.legend{width:5px;height:5px;border-radius:50%}.done{background:var(--ui-success)}.paused{background:var(--ui-warning)}.pending{background:var(--ui-divider)}.canvas-hint{margin-left:auto}
@media(max-width:650px){.canvas{padding:16px 12px}.flow-grid{gap:32px 15px}.flow-node{padding:10px 8px}.node-subtitle{font-size:11px}.node-number{display:none}.connector{display:none}.canvas-hint{display:none}}
</style>

<script setup lang="ts">
/** 展示后台真实阶段、工具回读与日志，人工记录不能改变本组件的运行状态。 */
import { computed, shallowRef } from 'vue';
import { Copy } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { DesignExecution } from '../../../shared/design-execution';
import { EXECUTION_STAGES, isCurrentStepResult, desktopHandoff } from '../../../shared/design-execution';
import { dateTime, safeUrl } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
const props = defineProps<{ run: DesignExecution; pending: boolean }>();
defineEmits<{ resume: [clarification: string]; stop: [] }>();
const clarification = shallowRef('');
const handoff = computed(() => desktopHandoff(props.run, window.location.origin));
const showHandoff = shallowRef(false);
async function copyHandoff() {
  try { await navigator.clipboard.writeText(handoff.value); ElMessage.success('已复制，请发送到原 Codex 会话；尚未领取执行'); }
  catch { showHandoff.value = true; ElMessage.warning('复制失败，执行指令已展开'); }
}
</script>
<template>
  <section class="execution-status">
    <div class="execution-title"><h3>运行详情</h3><StatusPill :value="run.status" /></div>
    <p class="execution-note">Codex 会话执行 · 不启动 CLI · G2a 仍由人工签署</p>
    <el-alert v-if="run.status === 'queued'" title="等待 Codex 会话领取，尚未开始执行" type="info" :closable="false" />
    <div v-if="run.status !== 'completed'" class="resume-form"><el-button @click="copyHandoff"><Copy :size="15" />复制 Codex 执行指令</el-button><el-button text @click="showHandoff = !showHandoff">{{ showHandoff ? '收起指令' : '查看执行指令' }}</el-button><el-input v-if="showHandoff" :model-value="handoff" type="textarea" readonly :rows="7" aria-label="Codex 会话执行指令" /></div>
    <el-alert v-if="run.error" :title="run.error" type="error" :closable="false" show-icon />
    <ol class="execution-steps"><li v-for="(step, index) in run.steps" :key="step.id" :class="`step-${step.status}`"><div class="step-index">{{ index + 1 }}</div><div class="step-main"><header><strong>{{ EXECUTION_STAGES.find((item) => item.id === step.id)?.title }}</strong><span>{{ { pending: '待执行', running: '执行中', passed: '已通过', blocked: '阻塞' }[step.status] }}</span></header><p>{{ step.summary || (step.status === 'running' ? 'Codex 正在调用工具执行，请查看下方事件…' : '等待前一阶段完成') }}</p><small v-if="step.attempts">尝试 {{ step.attempts }} 次 · {{ dateTime(step.endedAt || step.startedAt) }} · {{ isCurrentStepResult(step) ? `${step.proof.filter((p) => p.succeeded).length} 条工具凭证` : '本轮尚无结构化结果' }}</small><details v-if="step.result"><summary>{{ isCurrentStepResult(step) ? '检查项与证据' : '历史检查项与证据（非本轮）' }}</summary><p v-if="!isCurrentStepResult(step)">{{ step.resultAttempt ? `以下为第 ${step.resultAttempt} 次尝试的结果。` : '旧记录未保存结果对应的尝试编号。' }}仅保留用于恢复核对，不代表本轮检查结论。工具凭证：{{ step.proof.filter((p) => p.succeeded).length }} 条。</p><ul><li v-for="check in step.result.checks" :key="check.id">{{ check.passed ? '✓' : '✕' }} {{ check.id }}：{{ check.detail }}</li></ul><ul><li v-for="(evidence, i) in step.result.evidence" :key="i">{{ evidence.kind }} · {{ evidence.ref }}：{{ evidence.detail }}</li></ul><pre v-if="step.result.markdown" class="detail-text">{{ step.result.markdown }}</pre></details></div></li></ol>
    <div class="detail-section"><h3>交付结果</h3><dl class="detail-facts"><div><dt>自动执行 ID</dt><dd>{{ run.id }}</dd></div><div><dt>Codex 会话</dt><dd>{{ run.threadId || '等待创建会话' }}</dd></div><div><dt>Jira 父 / 方案 / 实现</dt><dd>{{ [run.artifacts.devParentKey, run.artifacts.designTaskKey, run.artifacts.implementationTaskKey].filter(Boolean).join(' / ') || '尚未产生已核验层级' }}</dd></div><div><dt>文档版本</dt><dd>{{ run.artifacts.documentVersion || '尚未发布' }}</dd></div></dl><a v-if="safeUrl(run.artifacts.documentUrl)" :href="safeUrl(run.artifacts.documentUrl)" target="_blank" rel="noreferrer" class="hub-link">打开已回读的 Confluence 文档</a></div>
    <div v-if="run.status === 'blocked'" class="resume-form"><el-input v-model="clarification" type="textarea" :rows="3" aria-label="续跑补充说明" placeholder="说明已补齐的权限、Jira 版本或资料位置。不能通过补充说明扩大原授权范围。" maxlength="12000" /><el-button type="primary" :loading="pending" @click="$emit('resume', clarification)">补充后继续执行</el-button></div>
    <p v-if="run.steps.some(step => step.proofSource === 'codex-desktop')" class="execution-note">Codex 阶段凭证由执行会话上报；看板未独立捕获桌面工具日志。</p>
    <el-button v-if="run.status === 'running' || run.status === 'queued'" type="danger" plain :loading="pending" @click="$emit('stop')">停止领取与回写</el-button>
    <h3 class="event-title">执行事件</h3><div class="execution-events"><p v-for="(event, i) in [...run.events].reverse()" :key="`${event.at}-${i}`"><time>{{ dateTime(event.at) }}</time>{{ event.message }}</p></div>
  </section>
</template>
<style scoped>
.execution-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.execution-title h3{font-size:16px;margin:6px 0}.execution-note{font-size:12px;line-height:1.8;color:var(--ui-secondary)}.execution-steps{list-style:none;padding:0;margin:20px 0}.execution-steps>li{display:flex;gap:12px;padding:15px 0;border-bottom:1px solid var(--ui-border)}.step-index{flex-shrink:0;display:grid;place-items:center;height:29px;width:29px;border:1px solid var(--ui-border);border-radius:8px;color:var(--ui-muted);background:var(--ui-raised);font:12px var(--mono)}.step-passed .step-index{color:var(--ui-success);background:var(--ui-success-bg)}.step-running .step-index{color:var(--ui-accent);background:var(--ui-accent-soft)}.step-blocked .step-index{color:var(--ui-danger);background:var(--ui-danger-bg)}.step-main{min-width:0;flex:1}.step-main header{display:flex;gap:10px;justify-content:space-between;font-size:12px}.step-main header span{color:var(--ui-secondary);flex-shrink:0}.step-main p,.step-main li{font-size:12px;line-height:1.9;color:var(--ui-secondary);overflow-wrap:anywhere}.step-main small{font-size:11px;color:var(--ui-muted)}.step-main summary{font-size:12px;color:var(--ui-accent);cursor:pointer;margin-top:10px}.resume-form{display:grid;gap:12px;justify-items:start}.event-title{font-size:14px;margin-top:24px}.execution-events{max-height:300px;overflow:auto;padding:12px;background:var(--ui-raised);border:1px solid var(--ui-border);border-radius:8px}.execution-events p{font-size:11px;line-height:1.9;color:var(--ui-secondary);overflow-wrap:anywhere;margin:5px 0}.execution-events time{font-family:var(--mono);color:var(--ui-muted);margin-right:12px}
</style>

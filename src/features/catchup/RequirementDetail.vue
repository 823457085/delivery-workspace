<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import type { CatchupRequirement } from '../../../shared/hub';
import { sourceUrl } from '../../shared/api';
import { safeUrl, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import FullRecord from '../../shared/ui/FullRecord.vue';
import WorkspaceContextLinks from '../../shared/ui/WorkspaceContextLinks.vue';
import { catchupQuickPrompt } from '../agent-workbench/agent-quick-actions';
defineProps<{ item: CatchupRequirement }>();
</script>
<template>
  <WorkspaceContextLinks v-if="!item.sourceIncrement" :issue-key="item.session.jiraKey" :workspace-path="item.session.workspacePath" :thread-id="item.session.threadId" :prompt="catchupQuickPrompt(item, item.session.jiraKey)" />
  <div class="inline-links"><StatusPill :value="item.execution.status" /><StatusPill :value="item.session.status" /><a v-if="safeUrl(item.session.jiraUrl)" :href="safeUrl(item.session.jiraUrl)" target="_blank">{{ item.session.jiraKey }} ↗</a><a v-if="item.sourceIncrement" :href="`/catchup/apex-930.html#${item.id}`" target="_blank">完整 9.30 对照文档 ↗</a><a v-else :href="sourceUrl('document', { type: 'requirement', id: item.id })" target="_blank">完整需求文档 ↗</a></div>
  <el-alert v-if="item.execution.exclusionReason" :title="item.execution.exclusionReason" type="warning" :closable="false" />
  <section class="detail-section"><h3>业务目标</h3><p>{{ item.goal }}</p></section>
  <template v-if="item.sourceIncrement"><section class="detail-section"><h3>9.30 增量 · {{ item.sourceIncrement.category }}</h3><p>当前 Demo：{{ item.sourceIncrement.demoCommit }}<br>9.30 云端：{{ item.sourceIncrement.targetCommit }}</p><p>已确认源码增量，尚未核验重构版覆盖、浏览器与真实接口。</p></section><section class="detail-section"><h3>当前 Demo 原状</h3><p>{{ item.sourceIncrement.demoState }}</p></section><section v-if="item.sourceIncrement.issues.length" class="detail-section"><h3>源码关联需求</h3><ul><li v-for="issue in item.sourceIncrement.issues" :key="issue">{{ issue }}</li></ul></section></template>
  <dl class="detail-facts"><div><dt>领域 / 波次</dt><dd>{{ item.businessDomain }} · {{ item.wave }}</dd></div><div><dt>正式交付 / Demo API</dt><dd>{{ item.deliveryStatus }} / {{ item.demoApiStatus }}</dd></div><div><dt>需求工作区</dt><dd>{{ item.session.workspacePath || '未建立' }}</dd></div><div><dt>分支 / 真实任务 ID</dt><dd>{{ item.session.branch || '未建立' }}<br>{{ item.session.threadId || item.session.clientThreadId || '未创建' }}</dd></div></dl>
  <section class="detail-section"><h3>{{ item.sourceIncrement ? '源码检查点' : '验收标准' }} · {{ item.acceptanceCriteria.length }}</h3><ol><li v-for="ac in item.acceptanceCriteria" :key="ac.id"><strong>{{ ac.id }}</strong><br>{{ ac.text }}</li></ol></section>
  <template v-if="item.sourceIncrement"><section v-if="item.sourceIncrement.conflicts.length" class="detail-section"><h3>需求与源码待确认差异</h3><div v-for="conflict in item.sourceIncrement.conflicts" :key="conflict.title"><h4>{{ conflict.title }}</h4><p>{{ conflict.requirement }}</p><p>{{ conflict.source }}</p><p>{{ conflict.decision }}</p></div></section><section class="detail-section"><h3>目标源码证据</h3><ul><li v-for="evidence in item.sourceIncrement.evidence" :key="`${evidence.path}:${evidence.line}`"><span class="row-mono">{{ evidence.path }}:{{ evidence.line }}{{ evidence.endLine && evidence.endLine !== evidence.line ? `–${evidence.endLine}` : '' }}</span></li></ul></section><section class="detail-section"><h3>合入来源</h3><ul><li v-for="commit in item.sourceIncrement.commits" :key="commit.sha">{{ commit.subject }}<br><span class="row-mono">{{ commit.sha }} · {{ commit.committedAt }}</span></li></ul></section></template>
  <section class="detail-section"><h3>执行结果与阻塞</h3><el-alert v-if="item.session.error" :title="item.session.error" type="error" :closable="false" /><AgentMarkdown class="detail-text" :source="item.session.result || '尚无执行结果'" /><p class="source-footnote">最后回传 {{ dateTime(item.session.updatedAt) }}</p></section>
  <section class="detail-section"><h3>差距与下一步</h3><p>{{ item.gap || '没有记录差距' }}</p><p>{{ item.nextAction }}</p><ul><li v-for="value in item.deliveryFollowups" :key="value">{{ value }}</li></ul><p>交付信息待补：{{ item.readinessGaps.join('、') || '无' }}</p></section>
  <section v-if="item.architecturePlacement" class="detail-section"><h3>架构落点与边界</h3><FullRecord :value="item.architecturePlacement" /></section>
</template>

<script setup lang="ts">
import type { CatchupRequirement } from '../../../shared/hub';
import { sourceUrl } from '../../shared/api';
import { safeUrl, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import FullRecord from '../../shared/ui/FullRecord.vue';
import WorkspaceContextLinks from '../../shared/ui/WorkspaceContextLinks.vue';
defineProps<{ item: CatchupRequirement }>();
</script>
<template>
  <WorkspaceContextLinks :issue-key="item.session.jiraKey" :workspace-path="item.session.workspacePath" :thread-id="item.session.threadId" :prompt="`需求 ${item.id}：${item.title}。${item.session.jiraKey ? `@Jira:${item.session.jiraKey}` : ''} 请结合已有交付结果检查下一步，先只读分析。`" />
  <div class="inline-links"><StatusPill :value="item.execution.status" /><StatusPill :value="item.session.status" /><a v-if="safeUrl(item.session.jiraUrl)" :href="safeUrl(item.session.jiraUrl)" target="_blank">{{ item.session.jiraKey }} ↗</a><a :href="sourceUrl('document', { type: 'requirement', id: item.id })" target="_blank">完整需求文档 ↗</a></div>
  <el-alert v-if="item.execution.exclusionReason" :title="item.execution.exclusionReason" type="warning" :closable="false" />
  <section class="detail-section"><h3>业务目标</h3><p>{{ item.goal }}</p></section>
  <dl class="detail-facts"><div><dt>领域 / 波次</dt><dd>{{ item.businessDomain }} · {{ item.wave }}</dd></div><div><dt>正式交付 / Demo API</dt><dd>{{ item.deliveryStatus }} / {{ item.demoApiStatus }}</dd></div><div><dt>需求工作区</dt><dd>{{ item.session.workspacePath || '未建立' }}</dd></div><div><dt>分支 / 真实任务 ID</dt><dd>{{ item.session.branch || '未建立' }}<br>{{ item.session.threadId || item.session.clientThreadId || '未创建' }}</dd></div></dl>
  <section class="detail-section"><h3>验收标准 · {{ item.acceptanceCriteria.length }}</h3><ol><li v-for="ac in item.acceptanceCriteria" :key="ac.id"><strong>{{ ac.id }}</strong><br>{{ ac.text }}</li></ol></section>
  <section class="detail-section"><h3>执行结果与阻塞</h3><el-alert v-if="item.session.error" :title="item.session.error" type="error" :closable="false" /><pre class="detail-text">{{ item.session.result || '尚无执行结果' }}</pre><p class="source-footnote">最后回传 {{ dateTime(item.session.updatedAt) }}</p></section>
  <section class="detail-section"><h3>差距与下一步</h3><p>{{ item.gap || '没有记录差距' }}</p><p>{{ item.nextAction }}</p><ul><li v-for="value in item.deliveryFollowups" :key="value">{{ value }}</li></ul><p>交付信息待补：{{ item.readinessGaps.join('、') || '无' }}</p></section>
  <section v-if="item.architecturePlacement" class="detail-section"><h3>架构落点与边界</h3><FullRecord :value="item.architecturePlacement" /></section>
</template>

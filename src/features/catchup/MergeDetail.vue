<script setup lang="ts">
/** 完整证据分为结论、逐项测试、截图、分支；不以概要卡代替人工审核材料。 */
import { computed, ref } from 'vue';
import type { MergeItem, Screenshot } from '../../../shared/hub';
import { sourceUrl } from '../../shared/api';
import { safeUrl, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import WorkspaceContextLinks from '../../shared/ui/WorkspaceContextLinks.vue';
import { screenshotGroups, mergeItemGroup } from './domain';
const props = defineProps<{ item: MergeItem; targetBranch: string }>();
const tab = ref('evidence-summary');
const excluded = computed(() => mergeItemGroup(props.item) === 'excluded');
const images = computed(() => screenshotGroups(props.item));
const imageUrl = (shot: Screenshot) => sourceUrl('evidence', { requirementId: props.item.requirementId, filename: shot.filename });
const gallery = computed(() => [...images.value.submitted, ...images.value.supplementary].map(imageUrl));
const caseResults = computed(() => props.item.testPlan.cases.map((test) => ({ ...test, result: props.item.pipeline.evidence?.testResults?.find((result) => result.tcId === test.id) })));
const otherResults = computed(() => (props.item.pipeline.evidence?.testResults || []).filter((result) => !props.item.testPlan.cases.some((test) => test.id === result.tcId)));
</script>
<template>
  <WorkspaceContextLinks :issue-key="item.jiraKey" :workspace-path="item.sessionWorkspacePath || item.deliveryWorkspacePath" :thread-id="item.pipeline.threadId" :prompt="`交付 ${item.requirementId}：${item.title}。${item.jiraKey ? `@Jira:${item.jiraKey}` : ''} 请检查已有测试证据、阻塞与下一步，先只读分析，不执行合入。`" />
  <div class="inline-links"><StatusPill :value="item.status" :label="excluded ? '无需合入' : undefined" /><StatusPill v-if="!excluded" :value="item.gitStatus" /><a v-if="safeUrl(item.jiraUrl)" :href="safeUrl(item.jiraUrl)" target="_blank">{{ item.jiraKey }} ↗</a><a v-if="safeUrl(item.mrUrl)" :href="safeUrl(item.mrUrl)" target="_blank">MR !{{ item.mrIid }} ↗</a></div>
  <el-alert v-if="excluded" title="无需合入 · 已移出 Admin 交付范围" :description="item.decisionNote" type="info" :closable="false" show-icon />
  <el-alert v-if="item.pipeline.error" :title="item.pipeline.error" type="error" :closable="false" show-icon />
  <el-alert v-if="item.pipeline.reviewException" :title="item.status === 'EXCEPTION_MERGED' ? '例外已合入，未验证项仍需补测' : '已授权例外合入，不代表自测通过'" :description="`${item.pipeline.reviewException.reason} · ${dateTime(item.pipeline.reviewException.authorizedAt)}`" type="warning" :closable="false" show-icon />
  <el-alert v-if="item.status === 'AWAITING_REVIEW'" title="等待你逐项审核。底部确认按钮会授权真实合入、提交与推送，不是只修改面板状态。" type="warning" :closable="false" show-icon />
  <el-tabs v-model="tab" class="evidence-tabs">
    <el-tab-pane label="执行结论" name="evidence-summary">
      <section v-if="item.pipeline.reviewExceptionHistory?.length" class="detail-section"><h3>例外合入授权记录</h3><div v-for="entry in item.pipeline.reviewExceptionHistory" :key="entry.authorizedRevision" class="test-case"><p>{{ dateTime(entry.authorizedAt) }} · {{ entry.reason }}</p><p class="row-mono">{{ entry.sourceBranch }} → {{ entry.targetBranch }}<br>授权源提交 {{ entry.sourceSha }}</p><p>授权前状态：{{ entry.previousStatus }} · {{ entry.previousError || '未记录错误；不代表自测通过' }}</p></div></section>
      <section class="detail-section"><h3>功能与本轮结果</h3><p>{{ item.functionSummary }}</p><pre class="detail-text">{{ item.pipeline.result || '暂无本轮结果' }}</pre><p v-if="item.scopeReviewNote">范围说明：{{ item.scopeReviewNote }}</p></section>
      <dl class="detail-facts"><div><dt>审核门禁</dt><dd>{{ item.reviewGate.passed ? '来源门禁通过' : '来源门禁未通过' }} · {{ item.reviewGate.evidenceComplete ? '证据完整' : '证据待补' }}</dd></div><div><dt>逐项结果</dt><dd>{{ item.reviewGate.passedTestCaseIds.length }} PASS / {{ item.reviewGate.skippedTestCaseIds.length }} N/A / {{ item.reviewGate.failedTestCaseIds.length }} FAIL</dd></div><div><dt>缺少的用例</dt><dd>{{ item.reviewGate.missingTestCaseIds.join('、') || '无' }}</dd></div><div><dt>最后更新 / 尝试次数</dt><dd>{{ dateTime(item.pipeline.updatedAt) }} / {{ item.pipeline.attempts }} 次</dd></div></dl>
      <section class="detail-section"><h3>验收标准 · {{ item.acceptanceCriteria.length }} 条</h3><ol><li v-for="ac in item.acceptanceCriteria" :key="ac.id"><strong>{{ ac.id }}</strong><br>{{ ac.text }}</li></ol></section>
      <section class="detail-section"><h3>测试入口与关注范围</h3><ul><li v-for="page in item.testPages" :key="page">{{ page }}</li></ul><p>{{ item.testFocus }}</p><p>冲突区域：{{ item.conflictArea || '未记录' }}</p><p>{{ item.decisionNote }}</p></section>
      <section v-if="item.pipeline.evidence?.notes?.length" class="detail-section"><h3>证据备注</h3><ul><li v-for="note in item.pipeline.evidence.notes" :key="note">{{ note }}</li></ul></section>
    </el-tab-pane>
    <el-tab-pane :label="`逐项测试 (${item.testPlan.cases.length})`" name="evidence-tests">
      <p class="source-footnote">{{ item.testPlan.scope }} · {{ item.testPlan.basis }}</p><p class="source-footnote">AC {{ item.testPlan.coverage.acCovered }}/{{ item.testPlan.coverage.acTotal }} · P0 {{ item.testPlan.coverage.p0Total }} 条 · 追踪率 {{ item.testPlan.coverage.traceabilityPercent }}%</p>
      <el-alert title="N/A 是带理由的未验证项，不是 PASS；请核对每条理由与覆盖范围。" type="warning" :closable="false" />
      <section v-for="test in caseResults" :key="test.id" class="test-case"><header><span><strong>{{ test.id }}</strong> · {{ test.priority }} · {{ test.title }}</span><StatusPill :value="test.result?.status" :label="test.result ? undefined : '缺少结果'" /></header><p class="source-footnote">关联 AC：{{ test.acIds.join('、') }}</p><pre class="detail-text">{{ test.result?.evidence || '来源未回传该用例证据，不能判定通过。' }}</pre><details><summary>展开前置条件、测试步骤和期望结果</summary><h4>前置条件</h4><ul><li v-for="(line, index) in test.preconditions" :key="index">{{ line }}</li></ul><h4>测试步骤</h4><ol><li v-for="(line, index) in test.steps" :key="index">{{ line }}</li></ol><h4>期望结果</h4><ul><li v-for="(line, index) in test.expected" :key="index">{{ line }}</li></ul></details></section>
      <section v-for="result in otherResults" :key="result.tcId" class="test-case"><header><strong>{{ result.tcId }} · 计划外回传</strong><StatusPill :value="result.status" /></header><pre class="detail-text">{{ result.evidence }}</pre></section>
      <section class="detail-section"><h3>自动化检查 · {{ item.pipeline.evidence?.automatedChecks?.length || 0 }} 条</h3><div v-for="(check, index) in item.pipeline.evidence?.automatedChecks" :key="index" class="test-case"><header><strong>{{ check.name }}</strong><StatusPill :value="check.status" /></header><pre class="command-line">{{ check.command }}</pre><pre class="detail-text">{{ check.evidence }}</pre></div><el-empty v-if="!item.pipeline.evidence?.automatedChecks?.length" description="来源未提交自动化检查" /></section>
    </el-tab-pane>
    <el-tab-pane :label="`证据截图 (${gallery.length})`" name="evidence-images">
      <el-alert v-if="images.excluded.length" :title="`${images.excluded.length} 张认证或无效截图已隔离，不计为功能证据。原始记录仍保留文件名。`" type="warning" :closable="false" />
      <section v-for="group in [{ title: '本轮提交的审核截图', shots: images.submitted }, { title: '执行阶段补充截图（不自动计入审核）', shots: images.supplementary }]" :key="group.title" class="detail-section"><h3>{{ group.title }} · {{ group.shots.length }}</h3><div class="screenshot-grid"><figure v-for="shot in group.shots" :key="shot.filename"><el-image :src="imageUrl(shot)" :preview-src-list="gallery" :initial-index="gallery.indexOf(imageUrl(shot))" fit="contain" preview-teleported lazy><template #error><span class="image-error">截图读取失败，请检查原证据文件</span></template></el-image><figcaption><strong>{{ shot.caption || shot.filename }}</strong><small>{{ shot.testCaseIds?.join(' · ') || '来源未逐条标注用例 ID' }}</small><a :href="imageUrl(shot)" target="_blank">打开原图 ↗</a></figcaption></figure></div><el-empty v-if="!group.shots.length" description="该阶段没有可展示的功能截图" /></section>
    </el-tab-pane>
    <el-tab-pane label="分支与工作区" name="evidence-branches">
      <dl class="detail-facts"><div><dt>来源分支</dt><dd><a :href="safeUrl(item.sourceBranchUrl)" target="_blank">{{ item.sourceBranch }}</a></dd></div><div><dt>目标分支</dt><dd>{{ targetBranch }}</dd></div><div><dt>来源本地 SHA</dt><dd>{{ item.sourceLocalSha || '未读取' }}</dd></div><div><dt>来源远端 SHA</dt><dd>{{ item.sourceRemoteSha || '未读取' }}</dd></div><div><dt>本轮证据基线 source</dt><dd>{{ item.pipeline.evidence?.sourceSha || '无' }}</dd></div><div><dt>本轮证据基线 target</dt><dd>{{ item.pipeline.evidence?.targetSha || '无' }}</dd></div><div><dt>需求工作区</dt><dd>{{ item.sessionWorkspacePath }}</dd></div><div><dt>交付工作区</dt><dd>{{ item.deliveryWorkspacePath }}</dd></div><div><dt>真实任务 ID</dt><dd>{{ item.pipeline.threadId || item.pipeline.clientThreadId || '未创建' }}</dd></div><div><dt>当前阶段</dt><dd>{{ item.pipeline.phase === 'delivery' ? 'Git 交付' : '合入自测' }}</dd></div></dl>
      <el-alert title="这里保留本轮证据基线与当前来源分支 SHA；是否可继续执行以后台门禁与版本校验为准，后续状态可在当前面板刷新查看。" type="info" :closable="false" />
    </el-tab-pane>
  </el-tabs>
</template>
<style scoped>.evidence-tabs{margin-top:18px}.test-case{padding:16px 0;border-bottom:1px solid var(--ui-border)}.test-case header{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;font-size:12px;line-height:1.8}.test-case header>span:first-child{flex:1}.test-case details{font-size:12px;line-height:1.9;color:var(--ui-secondary);margin-top:12px}.test-case summary{cursor:pointer;color:var(--ui-accent)}.test-case h4{margin:12px 0 5px}.command-line{font:11px/1.9 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ui-accent-soft);padding:10px;border-radius:5px}.screenshot-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.screenshot-grid figure{margin:0;border:1px solid var(--ui-border);border-radius:7px;overflow:hidden}.screenshot-grid .el-image{width:100%;height:210px;background:var(--ui-accent-soft);display:flex;align-items:center;justify-content:center}.screenshot-grid figcaption{padding:12px}.screenshot-grid strong{font-size:12px;font-weight:500;line-height:1.8;display:block;overflow-wrap:anywhere}.screenshot-grid small{display:block;font-size:11px;color:var(--ui-muted);line-height:1.8;margin-top:5px}.screenshot-grid a{font-size:11px;color:var(--ui-accent);display:inline-block;margin-top:8px}.image-error{font-size:12px;color:var(--ui-danger);padding:20px}@media(max-width:600px){.screenshot-grid{grid-template-columns:1fr}}</style>

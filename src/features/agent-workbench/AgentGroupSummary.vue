<script setup lang="ts">
import { computed } from 'vue';
import { jiraDevRequirementDocumentUrl } from '../../../shared/jira-dev';
import type { RemoteDeliveryPreview } from '../../../shared/agent-remote-delivery';
import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRoundSummary } from './group-chat-summary';
import { groupSummaryPresentation } from './group-summary-presentation';
import AgentMarkdown from './AgentMarkdown.vue';

const props = defineProps<{ summary: GroupRoundSummary; deliveryText?: string; localDelivery?: RemoteDeliveryPreview }>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();
const view = computed(() => groupSummaryPresentation(props.summary, props.deliveryText));
const scenarioStatus = { passed: '已通过', failed: '未通过', blocked: '受阻', not_run: '未实测' };
const previewModes = { mock: 'Mock 演示', real: '真实接口', mixed: '真实接口与 Mock 混用' };
const apiStatus = { passed: '真实联调已通过', failed: '联调未通过', blocked: '联调受阻', mock_only: '只验证了 Mock', not_run: '未实测', not_applicable: '不涉及接口' };
const i18nStatus = { ready: '已生成', blocked: '受阻', not_applicable: '不涉及', pending: '待确认' };
</script>

<template>
  <section class="group-result-summary" aria-label="本轮结果与下一步">
    <p class="result-conclusion">{{ view.headline }}</p>
    <p v-if="view.overview" class="result-overview">{{ view.overview }}</p>
    <section v-if="view.requirement" class="result-summary-points requirement-results" aria-label="需求交付结果">
      <p class="result-overview"><strong>业务目标：</strong>{{ view.requirement.goal }}</p>
      <p v-if="view.requirement.issueKey">研发事项：
        <a v-if="view.requirement.issueUrl" :href="view.requirement.issueUrl" target="_blank" rel="noopener noreferrer">{{ view.requirement.issueKey }}</a>
        <span v-else>{{ view.requirement.issueKey }}</span>
      </p>
      <p v-if="localDelivery?.reviewArtifact"><a :href="localDelivery.reviewArtifact.downloadUrl" download>下载需求评审</a></p>
      <template v-if="view.requirement.scenarios.some(scene => scene.status !== 'not_run')">
        <h3>业务场景与实测</h3>
        <ul>
          <li v-for="scene in view.requirement.scenarios" :key="scene.name">
            <strong>{{ scene.name }} · {{ scenarioStatus[scene.status] }}</strong>
            <p>{{ scene.evidence }}</p>
          </li>
        </ul>
      </template>
      <template v-if="view.requirement.api && !['not_run', 'not_applicable'].includes(view.requirement.api.status)">
        <h3>后端接口联调</h3>
        <p>{{ apiStatus[view.requirement.api.status] }}：{{ view.requirement.api.evidence }}</p>
      </template>
      <template v-if="view.requirement.previews.length || localDelivery?.previewLinks?.length">
        <h3>业务访问地址</h3>
        <ul v-if="view.requirement.previews.length">
          <li v-for="preview in view.requirement.previews" :key="preview.url">
            <strong>{{ preview.project }} · {{ previewModes[preview.mode] }}</strong>
            <p><a :href="preview.url" target="_blank" rel="noopener noreferrer">{{ preview.url }}</a></p>
            <p>{{ preview.evidence }}</p>
          </li>
        </ul>
        <ul v-if="localDelivery?.previewLinks?.length">
          <li v-for="link in localDelivery.previewLinks" :key="link.url">
            <a :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.label }}</a>
            <p>{{ link.evidence }}</p>
          </li>
        </ul>
      </template>
      <h3>多语言 XLSX</h3>
      <template v-if="view.requirement.i18n">
        <p>{{ i18nStatus[view.requirement.i18n.status] }}：{{ view.requirement.i18n.evidence }}</p>
        <p v-if="view.requirement.i18n.xlsx" class="result-source-label">{{ view.requirement.i18n.xlsx }}</p>
      </template>
      <ul v-if="localDelivery?.i18nArtifacts?.length">
        <li v-for="file in localDelivery.i18nArtifacts" :key="file.id"><a :href="file.downloadUrl" :download="file.name">{{ file.name }}</a></li>
      </ul>
      <p v-else-if="!view.requirement.i18n">本轮未记录导入表路径或不涉及多语言的依据。</p>
      <h3>研发阶段与产物</h3>
      <ol>
        <li v-for="stage in view.requirement.stages" :key="stage.key">
          <strong>{{ stage.title }} · {{ stage.status }}</strong>
          <p v-if="stage.document"><a :href="jiraDevRequirementDocumentUrl(view.requirement.taskId, stage.document)" download>下载{{ stage.document === 'review' ? '需求评审' : '前端技术方案' }}</a></p>
          <template v-if="stage.key === 'verification'">
            <p v-for="check in view.requirement.verificationFeedback?.checks || []" :key="check.title"><strong>{{ check.title }}：</strong>{{ check.detail }}</p>
            <details v-if="stage.evidence || view.requirement.checkDetails.length"><summary>查看原始验证记录</summary>
              <p v-if="stage.evidence">{{ stage.evidence }}</p>
              <ul><li v-for="check in view.requirement.checkDetails" :key="check.title">{{ check.title }}：{{ check.evidence }}</li></ul>
            </details>
          </template>
          <details v-else-if="stage.evidence && stage.status === '已完成' && stage.evidence.length > 240" class="result-stage-record">
            <summary>查看{{ stage.title }}记录</summary>
            <p>{{ stage.evidence }}</p>
          </details>
          <p v-else-if="stage.evidence">{{ stage.evidence }}</p>
          <ul v-if="stage.key === 'tasks' && view.requirement.tasks?.length">
            <li v-for="item in view.requirement.tasks" :key="item.key">
              <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.key }}</a><span v-else>{{ item.key }}</span>
              · {{ item.summary }} · {{ item.startDate || '开始日期未设置' }} 至 {{ item.endDate || '结束日期未设置' }}
            </li>
          </ul>
          <p v-else-if="stage.key === 'tasks' && view.requirement.issueKeys.length">报告关联：{{ view.requirement.issueKeys.join('、') }}</p>
          <ul v-if="stage.key === 'development'">
            <li v-for="project in view.requirement.projects" :key="project.workspacePath">
              {{ project.branchName }} · {{ project.workspacePath }}
            </li>
          </ul>
        </li>
      </ol>
    </section>
    <section v-else-if="view.summaryPoints.length" class="result-summary-points" aria-label="本轮总结汇报">
      <h3>本轮汇报要点</h3>
      <ol>
        <li v-for="(point, index) in view.summaryPoints" :key="index">
          <strong v-if="point.title">{{ point.title }}</strong>
          <p>{{ point.detail }}</p>
        </li>
      </ol>
    </section>
    <section v-if="view.blockers.length" class="result-summary-points" aria-label="当前待处理项">
      <h3>当前待处理项</h3>
      <ul>
        <li v-for="blocker in view.blockers" :key="`${blocker.name}:${blocker.text}`">
          <strong>{{ blocker.name }}：</strong><span>{{ blocker.text }}</span>
        </li>
      </ul>
    </section>
    <p v-if="view.nextStep" class="result-next-step"><strong>建议怎么继续</strong>{{ view.nextStep }}</p>
    <section v-if="view.issues.length" class="result-issues" aria-label="需要关注的问题">
      <h3>需要关注的地方 · {{ view.issues.length }}</h3>
      <ol>
        <li v-for="issue in view.issues.slice(0, 4)" :key="issue.id" :data-issue="issue.id">
          <strong>{{ issue.title }}</strong>
          <p>{{ issue.impact }}</p>
          <p class="result-issue-action"><span>处理建议：</span>{{ issue.action }}</p>
        </li>
      </ol>
      <p v-if="view.issues.length > 4" class="result-more">其余 {{ view.issues.length - 4 }} 项待处理问题，可在下方展开查看。</p>
    </section>
    <p v-else-if="summary.status === 'blocked' && !view.overview && !view.requirement?.verificationFeedback" class="result-explanation">现有报告还没有把具体问题说明清楚。建议负责人补充：在哪个页面、做了什么操作、出现什么情况，以及应该是什么样。</p>
    <dl v-if="view.checks.length" class="result-checks" aria-label="检查结果">
      <div v-for="check in view.checks" :key="check.kind" :data-check-kind="check.kind"><dt>{{ check.title }}</dt><dd>{{ check.label }}</dd></div>
    </dl>
    <details v-if="view.completed.length || view.issues.length || view.roleDigests.length || view.unconfirmed.length || deliveryText" class="result-full">
      <summary>查看详细汇报与各岗位结论</summary>
      <section v-if="view.completed.length">
        <h3>报告中已完成的工作</h3>
        <ul><li v-for="text in view.completed" :key="text">{{ text }}</li></ul>
      </section>
      <section v-if="view.issues.length" aria-label="问题与处理建议">
        <h3>具体需要怎么处理（{{ view.issues.length }} 项）</h3>
        <ol>
          <li v-for="issue in view.issues" :key="issue.id" class="result-issue-detail">
            <strong>{{ issue.title }}</strong>
            <p><b>影响：</b>{{ issue.impact }}</p>
            <p><b>处理建议：</b>{{ issue.action }}</p>
            <p class="result-source-label">报告来源：{{ issue.sources.map(member => member.turn.member.name).join('、') }}</p>
          </li>
        </ol>
      </section>
      <section v-if="view.roleDigests.length" class="result-roles" aria-label="各岗位结论摘要">
        <h3>各岗位结论摘要</h3>
        <ul>
          <li v-for="role in view.roleDigests" :key="role.id" class="result-role-item">
            <div class="result-role-head">
              <strong>{{ role.name }}</strong>
              <span v-if="role.statusLabel" class="result-role-badge" :data-state="role.state">{{ role.statusLabel }}</span>
              <button v-if="role.run" type="button" @click="emit('inspect', role.run!)">查看执行动态</button>
            </div>
            <p>{{ role.summary }}</p>
          </li>
        </ul>
      </section>
      <section v-if="view.unconfirmed.length">
        <h3>还有哪些结果没确认</h3>
        <ul><li v-for="text in view.unconfirmed" :key="text">{{ text }}</li></ul>
      </section>
      <details v-if="deliveryText" class="result-raw-delivery">
        <summary>协调汇报原文</summary>
        <AgentMarkdown :source="deliveryText" />
      </details>
    </details>
  </section>
</template>

<style scoped>
.group-result-summary{min-width:0;max-width:100%;font-family:var(--sans);font-size:15px;line-height:1.8;color:var(--agent-text);overflow-wrap:anywhere}
.result-conclusion{margin:0 0 16px;font-weight:600;font-size:16px;color:var(--agent-text);line-height:1.6}
.result-overview{margin:0 0 16px;color:var(--agent-text);line-height:1.8}
.result-summary-points{margin:18px 0 22px;padding:0;border:0;background:transparent}
.requirement-results{padding:12px 14px;border:1px solid var(--agent-border);border-radius:10px;background:color-mix(in srgb,var(--agent-panel-strong) 65%,transparent)}
.requirement-results p{margin:8px 0;white-space:pre-wrap}
.requirement-results a{color:var(--agent-accent);text-underline-offset:3px}
.requirement-results a:hover{text-decoration:underline}
.result-summary-points ol,.result-summary-points ul{margin:10px 0;padding-left:24px}
.result-summary-points li{margin:14px 0}
.result-summary-points li>strong{color:var(--agent-text);font-weight:600}
.result-summary-points li>p{margin:6px 0 0;color:var(--agent-secondary);line-height:1.8}
.result-stage-record{margin:6px 0 0}.result-stage-record>summary{width:fit-content;cursor:pointer;color:var(--agent-muted);font-size:13px}.result-stage-record>summary:hover{color:var(--agent-text)}.result-stage-record[open]>summary{margin-bottom:8px}.result-stage-record p{color:var(--agent-secondary)}
.result-next-step{margin:20px 0}.result-next-step>strong{margin-right:10px;color:var(--agent-text);font-weight:600}
.group-result-summary h3{margin:24px 0 10px;color:var(--agent-text);font-size:15px;font-weight:600;line-height:1.6}
.group-result-summary section>h3:first-child{margin-top:0}
.result-issues ol,.result-full ol,.result-full ul{padding-left:20px}.result-issues li,.result-issue-detail{margin:12px 0}.result-issues li>strong,.result-issue-detail>strong{color:var(--agent-text);font-weight:600}.result-issues p,.result-full p{margin:4px 0}.result-issue-action>span{color:var(--agent-text);font-weight:500}.result-more,.result-source-label{color:var(--agent-muted);font-size:12px}.result-issue-detail b{font-weight:500}.result-explanation{margin:12px 0}
.result-checks{margin:16px 0}.result-checks>div{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 18px;padding:8px 0;border-bottom:1px solid var(--agent-border)}.result-checks dt{color:var(--agent-text);font-weight:500}.result-checks dd{margin:0}
.result-full{margin-top:24px;padding-top:16px;border-top:1px solid var(--agent-border);font-size:14px}.result-full>summary{color:var(--agent-accent);cursor:pointer;font-weight:500;font-size:13px}.result-full[open]>summary{margin-bottom:18px}
.result-roles ul{list-style:none;padding-left:0;margin:8px 0}
.result-role-item{padding:10px 0;border-top:1px solid var(--agent-border)}
.result-role-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.result-role-head strong{color:var(--agent-text);font-weight:600}
.result-role-badge{font-size:11px;color:var(--agent-muted)}
.result-role-badge[data-state="failed"],.result-role-badge[data-state="blocked"]{color:var(--ui-danger,var(--el-color-danger))}
.result-role-head button{margin-left:auto}
.result-raw-delivery{margin-top:10px}
.result-raw-delivery>summary{color:var(--agent-muted);cursor:pointer}
.group-result-summary button{padding:0;border:0;background:transparent;color:var(--agent-accent);font:inherit;font-size:12px;cursor:pointer}
</style>

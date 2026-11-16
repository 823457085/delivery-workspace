<script setup lang="ts">
/**
 * 会话「本轮交付」工作台卡片：汇聚累计改动文件账本、交付就绪度评分卡、
 * 智能提交说明、Release Notes 草稿、跨 Agent 交接简报以及一键补测试提示。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { CheckCircle2, Copy, FileCode2, FlaskConical, GitCommitHorizontal, Share2, Sparkles } from '@lucide/vue';
import type { AgentConversation } from './conversation';
import { conversationHandoffPacket } from './conversation-export';
import { formatHandoffPacketMarkdown } from '../../../shared/agent-handoff-packet';
import { buildSmartCommitMessage, scanDiffHygieneIssues } from '../../../shared/diff-review-hygiene';
import {
  draftCategorizedReleaseNotes,
  evaluateDeliveryReadinessScorecard,
  type DeliveryReadinessScorecard,
} from '../../../shared/delivery-readiness-scorecard';

const props = defineProps<{
  conversation: AgentConversation;
  paused?: boolean;
}>();

const emit = defineEmits<{
  askTest: [prompt: string];
}>();

function isTestPath(filePath: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec)\//i.test(filePath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function isSourcePath(filePath: string): boolean {
  if (isTestPath(filePath)) return false;
  return /\.(?:[cm]?[jt]sx?|vue|py|go|rs|java|kt|swift|rb|php|cs)$/i.test(filePath);
}

const handoffPacket = computed(() => conversationHandoffPacket(props.conversation));
const changedFiles = computed(() => handoffPacket.value.cumulativeChangedFiles);
const sourceFiles = computed(() => changedFiles.value.filter(f => f.latestStatus !== 'deleted' && isSourcePath(f.path)));
const testFiles = computed(() => changedFiles.value.filter(f => f.latestStatus !== 'deleted' && isTestPath(f.path)));
const missingTests = computed(() => sourceFiles.value.length > 0 && testFiles.value.length === 0);

const smartCommit = computed(() =>
  buildSmartCommitMessage({
    files: changedFiles.value.map(item => ({
      path: item.path,
      status: item.latestStatus === 'added' ? 'A' : item.latestStatus === 'deleted' ? 'D' : 'M',
    })),
    branch: props.conversation.latest.branch,
    issueTitle: props.conversation.title,
  }),
);

const releaseNotes = computed(() =>
  draftCategorizedReleaseNotes({
    title: props.conversation.title,
    sourceBranch: props.conversation.latest.branch || undefined,
    files: changedFiles.value.map(item => ({ path: item.path, status: item.latestStatus })),
  }),
);

const scorecard = computed<DeliveryReadinessScorecard>(() => {
  const activePaths = changedFiles.value.filter(f => f.latestStatus !== 'deleted').map(f => f.path);
  const hygieneWarnings = scanDiffHygieneIssues('', activePaths);
  return evaluateDeliveryReadinessScorecard({
    totals: {
      files: changedFiles.value.length,
      additions: 0,
      deletions: 0,
    },
    sourceFiles: sourceFiles.value.length,
    testFiles: testFiles.value.length,
    missingTestsWarning: missingTests.value,
    largeDiffTriggered: changedFiles.value.length > 30,
    hygieneWarnings,
  });
});

function pillTone(level: DeliveryReadinessScorecard['riskLevel']): string {
  if (level === 'low') return 'is-low';
  if (level === 'medium') return 'is-medium';
  return 'is-high';
}

async function copyText(content: string, label: string) {
  try {
    await navigator.clipboard.writeText(content);
    ElMessage.success(`已复制${label}`);
  } catch {
    ElMessage.error(`复制${label}失败，请检查剪贴板权限`);
  }
}

function requestMissingTests() {
  const refs = sourceFiles.value
    .slice(0, 6)
    .map(item => (/\s/.test(item.path) ? `@"${item.path}"` : `@${item.path}`))
    .join(' ');
  const prompt = `${refs ? `${refs} ` : ''}请针对当前会话改动的源码补充对应的单元/回归测试，并运行测试命令确认全部通过。`;
  emit('askTest', prompt);
}
</script>

<template>
  <section v-if="changedFiles.length > 0" class="session-delivery-brief" aria-label="会话交付就绪简报">
    <div class="brief-header">
      <div class="brief-badges">
        <span class="readiness-pill" :class="pillTone(scorecard.riskLevel)">
          <CheckCircle2 :size="13" />
          就绪度 {{ scorecard.readinessScore }}/100 · {{ scorecard.riskLabel }}
        </span>
        <span class="stat-chip">
          <FileCode2 :size="12" />
          累计净触及 {{ changedFiles.length }} 个文件（源码 {{ sourceFiles.length }} · 测试 {{ testFiles.length }}）
        </span>
      </div>
      <div class="brief-actions">
        <button type="button" class="brief-btn" @click="copyText(smartCommit.fullMessage, '建议提交说明')">
          <GitCommitHorizontal :size="13" /> 复制提交说明
        </button>
        <button type="button" class="brief-btn" @click="copyText(releaseNotes.markdown, 'Release Notes 发布说明')">
          <Sparkles :size="13" /> 复制 Release Notes
        </button>
        <button type="button" class="brief-btn" @click="copyText(formatHandoffPacketMarkdown(handoffPacket), '跨 Agent 交接简报')">
          <Share2 :size="13" /> 复制跨 Agent 交接包
        </button>
        <button
          v-if="missingTests && !paused"
          type="button"
          class="brief-btn is-accent"
          @click="requestMissingTests"
        >
          <FlaskConical :size="13" /> 让 Agent 补充测试
        </button>
      </div>
    </div>

    <div class="brief-commit-preview">
      <small>建议提交标题：</small>
      <code>{{ smartCommit.subject }}</code>
      <button type="button" class="inline-copy" title="仅复制提交标题" @click="copyText(smartCommit.subject, '提交标题')">
        <Copy :size="12" />
      </button>
    </div>

    <div class="brief-gates">
      <span
        v-for="gate in scorecard.gates"
        :key="gate.id"
        class="gate-chip"
        :class="`is-${gate.status}`"
        :title="gate.detail"
      >
        <b>{{ gate.status === 'pass' ? '✓' : gate.status === 'warn' ? '!' : '✕' }}</b>
        {{ gate.label }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.session-delivery-brief {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 26%, var(--ui-border));
  border-radius: var(--ds-radius-sm, 10px);
  background: color-mix(in srgb, var(--ui-accent-soft) 28%, var(--ui-surface));
  font-size: 12px;
}
.brief-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.brief-badges, .brief-actions, .brief-gates {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.readiness-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 11.5px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
}
.readiness-pill.is-low {
  color: var(--el-color-success, #67c23a);
  border-color: color-mix(in srgb, var(--el-color-success, #67c23a) 40%, var(--ui-border));
}
.readiness-pill.is-medium {
  color: var(--el-color-warning, #e6a23c);
  border-color: color-mix(in srgb, var(--el-color-warning, #e6a23c) 45%, var(--ui-border));
}
.readiness-pill.is-high {
  color: var(--el-color-danger, #f56c6c);
  border-color: color-mix(in srgb, var(--el-color-danger, #f56c6c) 48%, var(--ui-border));
}
.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11.5px;
}
.brief-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-text);
  font: 500 11.5px/1 var(--sans);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
.brief-btn:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.brief-btn.is-accent {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
.brief-commit-preview {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
}
.brief-commit-preview small {
  color: var(--ui-muted);
}
.brief-commit-preview code {
  font: 500 11.5px/1.4 var(--mono);
  color: var(--ui-text);
  overflow-wrap: anywhere;
}
.inline-copy {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-left: auto;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
}
.inline-copy:hover {
  border-color: var(--ui-border);
  color: var(--ui-accent);
}
.gate-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  font-size: 11px;
  cursor: help;
}
.gate-chip.is-pass {
  color: var(--el-color-success, #67c23a);
}
.gate-chip.is-warn {
  color: var(--el-color-warning, #e6a23c);
}
.gate-chip.is-block {
  color: var(--el-color-danger, #f56c6c);
  font-weight: 600;
}
</style>

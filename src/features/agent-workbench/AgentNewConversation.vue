<script setup lang="ts">
/**
 * 设计说明：新会话采用与 Codex 一致的“先进入空白会话，再在输入区切换上下文”模式。
 * 项目与分支为可选上下文；未选项目时由服务端创建独立会话目录，不默认绑定最近项目。
 */
import { computed, defineAsyncComponent, shallowRef, useTemplateRef, watch } from 'vue';
import { ArrowUpRight, AtSign, Check, ChevronDown, Code2, Compass, FolderGit2, GitBranch, Send, Settings2, Sparkles, Terminal, Wrench } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentReasoningEffort, AgentRunMode, AgentRuntimeHealth, AgentServiceTier, AgentWorkspaceBranches } from '../../../shared/agent-runtime';
import { useTheme } from '../../shared/theme/useTheme';

const ImmersivePhotoStage = defineAsyncComponent(() => import('../../shared/ui/ImmersivePhotoStage.vue'));
const CinematicVideoStage = defineAsyncComponent(() => import('../../shared/ui/CinematicVideoStage.vue'));
import AgentAccessSelector from './AgentAccessSelector.vue';
import AgentModelSpeed from './AgentModelSpeed.vue';
import AgentPromptEditor from './AgentPromptEditor.vue';
import AgentWorkspaceSelector from './AgentWorkspaceSelector.vue';
import { useAgentModelSelection } from './model-selection';
import { recordSubmittedPrompt } from './useAgentInputHistory';
import { appendContextMention, pickLaunchpadWorkspaces } from './prompt-studio-metrics';
import { workspacePathLabel, type AgentWorkspaceOption } from './workspace-catalog';
import type { AgentBusinessMention } from './agent-business-context';
import type { AgentAttachmentDraft } from './useAgentAttachments';

export type { AgentWorkspaceOption };

const { current: currentTheme } = useTheme();
const props = defineProps<{ runtimes: AgentRuntimeHealth[]; workspaces: AgentWorkspaceOption[]; changing: string; canStart: boolean;
  businessOptions: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft }>();
const provider = defineModel<AgentProvider>('provider', { required: true });
const mode = defineModel<AgentRunMode>('mode', { required: true });
const accessMode = defineModel<AgentAccessMode>('accessMode', { required: true });
const model = defineModel<string>('model', { required: true });
const serviceTier = defineModel<AgentServiceTier | undefined>('serviceTier', { required: true });
const reasoningEffort = defineModel<AgentReasoningEffort | ''>('reasoningEffort', { required: true });
const objective = defineModel<string>('objective', { required: true });
const attachments = defineModel<AgentAttachment[]>('attachments', { required: true });
const workspacePath = defineModel<string>('workspacePath', { required: true });
const workspacePaths = defineModel<string[]>('workspacePaths', { default: () => [] });
const branch = defineModel<string>('branch', { required: true });
const emit = defineEmits<{ send: []; chooseWorkspace: []; configureModels: [] }>();
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const branchOptions = shallowRef<string[]>([]);
const branchesLoading = shallowRef(false);
const runtime = computed(() => props.runtimes.find((item) => item.provider === provider.value));
const modelPicker = useAgentModelSelection(() => runtime.value, model, reasoningEffort);
const currentWorkspace = computed(() => props.workspaces.find((item) => item.path === workspacePath.value));
const workspaceLabel = computed(() => currentWorkspace.value?.label || (workspacePath.value ? workspacePathLabel(workspacePath.value) : '不选择项目'));
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
const modeLabel = computed(() => mode.value === 'agent' ? 'Agent 模式' : mode.value === 'plan' ? '方案分析' : '只读问答');

watch(mode, (value) => { if (value !== 'agent') accessMode.value = 'workspace'; });
// 执行器切换仅收紧权限；完全访问需要用户再次明确选择。
watch(() => runtime.value?.accessModes, modes => {
  if (modes && !modes.includes(accessMode.value)) accessMode.value = 'workspace';
});
watch(() => workspacePath.value, async (nextPath, _previousPath, onCleanup) => {
  branchOptions.value = [];
  branch.value = '';
  if (!nextPath) { branchesLoading.value = false; return; }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  branchesLoading.value = true;
  try {
    const params = new URLSearchParams({ workspacePath: nextPath });
    const response = await fetch(`/api/agent-runtimes/branches?${params}`, { signal: controller.signal });
    const result = await response.json() as AgentWorkspaceBranches & { message?: string };
    if (controller.signal.aborted || workspacePath.value !== nextPath) return;
    if (!response.ok) throw new Error(result.message || '分支列表读取失败');
    branchOptions.value = result.branches;
    branch.value = result.current || (result.branches.includes(branch.value) ? branch.value : result.branches[0] || '');
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : '分支列表读取失败');
  } finally {
    if (!controller.signal.aborted) branchesLoading.value = false;
  }
}, { immediate: true });

function submit() {
  if (props.canStart && !props.attachmentDraft?.pending && !branchesLoading.value) {
    if (typeof recordSubmittedPrompt === 'function' && typeof objective !== 'undefined') recordSubmittedPrompt(objective.value);
    emit('send');
  }
}

function focusPrompt() { void promptEditor.value?.focusInput(); }

const starterCards: { id: string; code: string; tag: string; title: string; detail: string; mode: AgentRunMode; prompt: string; icon: unknown }[] = [
  { id: 'implement', code: '01', tag: '写代码', title: '需求开发与缺陷修复', detail: '结合关联任务和项目代码，直接完成修改并验证', mode: 'agent', prompt: '请结合 @ 选择的 Jira 任务与当前项目代码，定位改动范围、完成代码实现并运行相关测试验证。', icon: Sparkles },
  { id: 'review', code: '02', tag: '查改动', title: '检查本地改动与风险', detail: '只看不改，帮我检查未提交代码有没有潜在问题', mode: 'ask', prompt: '请检查当前工作区的 Git 改动与最近提交，指出潜在回归风险、边界漏判与可优化点。', icon: Code2 },
  { id: 'plan', code: '03', tag: '定方案', title: '先出方案再动手', detail: '先梳理思路和修改步骤，确认后再写代码', mode: 'plan', prompt: '请先阅读相关模块代码，输出清晰的分步重构/开发方案、影响面评估与验证策略。', icon: Compass },
  { id: 'debug', code: '04', tag: '排故障', title: '排查报错与异常问题', detail: '定位构建失败、接口报错或功能异常原因并修复', mode: 'agent', prompt: '请帮我排查当前项目的报错或异常行为，定位根本原因并给出最小化修复。', icon: Wrench },
];

function applyStarter(card: typeof starterCards[number]) {
  if (runtime.value?.modes.includes(card.mode)) mode.value = card.mode;
  objective.value = card.prompt;
  focusPrompt();
}

const quickWorkspaces = computed(() => pickLaunchpadWorkspaces(props.workspaces, workspacePath.value, 5));
const quickJiraMentions = computed(() => props.businessOptions.filter(item => item.type === 'jira').slice(0, 4));

function toggleQuickWorkspace(path: string) {
  if (props.changing) return;
  const next = workspacePath.value === path ? '' : path;
  workspacePath.value = next;
  workspacePaths.value = next ? [next] : [];
  focusPrompt();
}

function injectQuickMention(mention: AgentBusinessMention) {
  if (props.changing) return;
  objective.value = appendContextMention(objective.value, mention.value);
  focusPrompt();
}

defineExpose({ focusPrompt });
</script>

<template>
  <section class="new-conversation" aria-label="新建 Agent 会话">
    <div class="new-stage-topbar">
      <div class="new-stage-crumb">
        <strong>发起新对话</strong>
      </div>
      <div class="new-header-actions"><slot name="header-actions" /></div>
    </div>

    <div class="new-compose-canvas">
      <div class="new-compose-stage">
        <!-- Cinematic Video Hero 专属电影感视频首屏 -->
        <CinematicVideoStage v-if="currentTheme.id === 'cinematic-video-hero'" mode="hero">
          <h1 v-if="workspacePaths.length > 1">想让我在 <em>{{ workspaceLabel }}</em> 等 {{ workspacePaths.length }} 个项目中完成什么？</h1>
          <h1 v-else-if="workspacePath">想让我在 <em>{{ workspaceLabel }}</em> 中完成什么？</h1>
          <h1 v-else>想让我帮你完成什么？</h1>
          <p>输入 @ 可快速关联 Jira 任务、项目或文件，按 Enter 发送。</p>
        </CinematicVideoStage>

        <!-- Immersive Photo 专属全画幅摄影主舞台 -->
        <ImmersivePhotoStage v-else-if="currentTheme.id === 'immersive-photo'" mode="hero">
          <h1 v-if="workspacePaths.length > 1">想让我在 <em>{{ workspaceLabel }}</em> 等 {{ workspacePaths.length }} 个项目中完成什么？</h1>
          <h1 v-else-if="workspacePath">想让我在 <em>{{ workspaceLabel }}</em> 中完成什么？</h1>
          <h1 v-else>想让我帮你完成什么？</h1>
          <p>输入 @ 可快速关联 Jira 任务、项目或文件，按 Enter 发送。</p>
        </ImmersivePhotoStage>

        <!-- Acid / Holy Grail / 其他主题专属控制台主舞台 -->
        <div v-else class="new-empty">
          <div class="new-hero-badge">
            <span class="new-mark" aria-hidden="true"><Terminal :size="14" /></span>
            <span class="new-runtime-pill">{{ runtime?.label || 'CLI' }} · {{ modeLabel }}</span>
          </div>
          <h1 v-if="workspacePaths.length > 1" class="acid-chrome">想让我在 <em>{{ workspaceLabel }}</em> 等 {{ workspacePaths.length }} 个项目中完成什么？</h1>
          <h1 v-else-if="workspacePath" class="acid-chrome">想让我在 <em>{{ workspaceLabel }}</em> 中完成什么？</h1>
          <h1 v-else class="acid-chrome">想让我帮你完成什么？</h1>
          <p class="new-hero-sub">可选绑定本地项目与分支，输入 <code>@</code> 可关联 Jira 任务、接口文档或代码文件。</p>
        </div>

        <!-- 一体化指令发射舱 -->
        <section class="new-composer" aria-label="会话编辑区">
          <div class="new-context-panel" role="group" aria-label="项目、分支和访问权限">
            <div class="new-project">
              <AgentWorkspaceSelector
                v-model:workspace-path="workspacePath"
                v-model:workspace-paths="workspacePaths"
                v-model:branch="branch"
                :workspaces="workspaces"
                :disabled="!!changing"
                @choose-workspace="emit('chooseWorkspace')"
              />
              <label v-if="workspacePath && (branchesLoading || branchOptions.length)" class="new-branch">
                <GitBranch :size="13" />
                <select v-model="branch" aria-label="切换分支" :disabled="branchesLoading || !!changing">
                  <option v-if="branchesLoading" value="">读取分支…</option>
                  <option v-for="item in branchOptions" :key="item" :value="item">{{ item }}</option>
                </select>
                <ChevronDown :size="12" />
              </label>
            </div>
            <div class="new-access"><AgentAccessSelector v-model="accessMode" :mode="mode" :provider="provider" :access-modes="runtime?.accessModes" :disabled="!!changing" /></div>
          </div>

          <AgentPromptEditor
            ref="promptEditor"
            v-model="objective"
            v-model:attachments="attachments"
            class="new-prompt"
            :workspace-path="workspacePath"
            :provider="provider"
            :modes="runtime?.modes || []"
            :attachment-draft="attachmentDraft"
            :selected-mode="mode"
            :business-options="businessOptions"
            :disabled="!!changing"
            :placeholder="'直接输入你想做的事（输 / 用快捷指令，输 @ 关联 Jira 任务、项目、接口或代码文件）…'"
            :min-rows="2"
            submit-on-enter
            @select-mode="mode = $event"
            @submit="submit"
          />

          <div class="composer-actions">
            <div class="composer-mode">
              <span class="manual-mode-label">{{ modeLabel }}</span>
              <el-select v-model="provider" class="composer-provider" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" aria-label="选择执行器">
                <el-option v-for="item in runtimes" :key="item.provider" :value="item.provider" :label="item.label" :disabled="!item.ready || !item.modes.length" />
              </el-select>
              <el-select v-model="modelPicker.model.value" class="composer-model" popper-class="agent-model-popper" size="small" filterable :disabled="changing === 'start'" :empty-values="[null, undefined]" aria-label="选择模型">
                <el-option v-for="item in modelPicker.models.value" :key="item.id || 'default'" :label="item.label" :value="item.id">
                  <span>{{ item.label }}</span>
                  <small v-if="item.customId">自定义</small>
                </el-option>
              </el-select>
              <el-select v-if="modelPicker.efforts.value.length" v-model="modelPicker.effort.value" class="composer-effort" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" :empty-values="[null, undefined]" :aria-label="`${runtime?.label || '模型'} 推理强度`">
                <el-option v-if="modelPicker.allowDefaultEffort.value" label="思考：默认" value="" />
                <el-option v-for="effort in modelPicker.efforts.value" :key="effort" :label="`思考：${effortLabels[effort]}`" :value="effort" />
              </el-select>
              <AgentModelSpeed v-model:service-tier="serviceTier" :runtime="runtime" :model="model" />
              <el-button text size="small" aria-label="管理自定义模型" @click="emit('configureModels')"><Settings2 :size="13" /></el-button>
            </div>
            <el-button class="send-button" type="primary" :disabled="!canStart || attachmentDraft?.pending || branchesLoading" :loading="changing === 'start'" aria-label="创建并发送" @click="submit">
              <template #icon><Send :size="15" /></template>发送
            </el-button>
          </div>
        </section>

        <!-- Open WebUI / Continue 实时工作区与待办事项秒绑启动栏 -->
        <section v-if="quickWorkspaces.length || quickJiraMentions.length" class="new-launchpad-strip" aria-label="快捷上下文绑定">
          <div v-if="quickWorkspaces.length" class="new-launchpad-row">
            <span class="new-launchpad-label"><FolderGit2 :size="12" /> 工作区秒绑</span>
            <div class="new-launchpad-chips">
              <button
                v-for="ws in quickWorkspaces"
                :key="ws.path"
                type="button"
                class="new-launchpad-chip"
                :class="{ 'is-active': workspacePath === ws.path }"
                :disabled="!!changing"
                :title="`${ws.label} (${ws.branch || '默认分支'}) · ${ws.path}`"
                @click="toggleQuickWorkspace(ws.path)"
              >
                <Check v-if="workspacePath === ws.path" :size="11" />
                <strong>{{ ws.label }}</strong>
                <code v-if="ws.branch">{{ ws.branch }}</code>
              </button>
            </div>
          </div>
          <div v-if="quickJiraMentions.length" class="new-launchpad-row">
            <span class="new-launchpad-label"><AtSign :size="12" /> 待办直引</span>
            <div class="new-launchpad-chips">
              <button
                v-for="item in quickJiraMentions"
                :key="item.id"
                type="button"
                class="new-launchpad-chip is-mention"
                :class="{ 'is-active': objective.includes(item.value) }"
                :disabled="!!changing"
                :title="`${item.label} · ${item.detail}`"
                @click="injectQuickMention(item)"
              >
                <code>{{ item.label }}</code>
                <span>{{ item.detail }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 四宫格索引式快捷工作流矩阵 -->
        <section class="new-starter-section" aria-label="快捷工作流模板">
          <div class="new-starters-head">
            <span>常用场景模板</span>
            <small>点击一键填入提示词</small>
          </div>
          <div class="new-bento-starters">
            <button
              v-for="card in starterCards"
              :key="card.id"
              type="button"
              class="new-starter-card"
              :disabled="!!changing"
              @click="applyStarter(card)"
            >
              <div class="new-starter-top">
                <span class="new-starter-code">{{ card.code }}</span>
                <span class="new-starter-tag">{{ card.tag }}</span>
                <span class="new-starter-icon"><component :is="card.icon" :size="13" /></span>
              </div>
              <strong>{{ card.title }}</strong>
              <small>{{ card.detail }}</small>
              <span class="new-starter-cta">填入提示词 <ArrowUpRight :size="12" /></span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.new-conversation {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--ui-text);
}

.new-stage-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 5px clamp(16px, 2vw, 24px);
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-surface);
  flex-shrink: 0;
}
:global(:root[data-theme='acid'] .new-stage-topbar) {
  background: #0e0e0e;
}
.new-stage-crumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.new-stage-zone {
  font: 700 10.5px/14px var(--ds-code, var(--mono));
  letter-spacing: 0.08em;
  color: var(--ui-muted);
  text-transform: uppercase;
}
:global(:root[data-theme='acid'] .new-stage-zone) {
  color: var(--acid-cyan, #00ffff);
}
.new-stage-crumb i {
  font-style: normal;
  color: var(--ui-border);
}
.new-stage-crumb strong {
  font: 600 13.5px/20px var(--ds-display, var(--sans));
  letter-spacing: -0.01em;
  color: var(--ui-text);
}
.new-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.new-hero-badge {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.new-protocol,
.new-runtime-pill {
  padding: 3px 9px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 4px);
  background: var(--ui-surface);
  font: 700 11px/16px var(--ds-code, var(--mono));
  letter-spacing: 0.06em;
}
.new-protocol { color: var(--ui-accent); }
.new-runtime-pill { color: var(--ui-secondary); font-weight: 500; }

.new-hero-sub {
  margin: 0;
  max-width: 680px;
  color: var(--ui-muted);
  font: 400 13px/20px var(--ds-display, var(--sans));
}
.new-hero-sub code {
  padding: 1px 5px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 4px);
  background: var(--ui-surface);
  color: var(--ui-accent);
  font: 600 12px/16px var(--ds-code, var(--mono));
}
.new-hero-ticks {
  max-width: 260px;
}
:global(:root[data-theme='acid'] .new-empty h1) {
  transform: skewX(-7deg);
}

.new-launchpad-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: color-mix(in srgb, var(--ui-surface) 88%, var(--ui-raised));
}
.new-launchpad-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}
.new-launchpad-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 78px;
  color: var(--ui-muted);
  font: 600 11px/1.3 var(--ds-code, var(--mono));
}
.new-launchpad-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.new-launchpad-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 260px;
  height: 26px;
  padding: 0 9px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color .14s ease, background .14s ease, color .14s ease;
}
.new-launchpad-chip:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  color: var(--ui-text);
  background: var(--ui-raised);
}
.new-launchpad-chip.is-active {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.new-launchpad-chip strong,
.new-launchpad-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.new-launchpad-chip strong { min-width: 44px; font-weight: 560; color: inherit; }
.new-launchpad-chip code {
  max-width: 124px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 10px/1.2 var(--ds-code, var(--mono));
  flex-shrink: 0;
}
.new-launchpad-chip.is-mention code {
  color: var(--ui-accent);
  background: color-mix(in srgb, var(--ui-accent-soft) 58%, var(--ui-surface));
  font-weight: 600;
}
:global(:root[data-theme='acid']) .new-launchpad-strip,
:global(:root[data-theme='acid']) .new-launchpad-chip,
:global(:root[data-theme='acid']) .new-launchpad-chip code {
  border-radius: 0 !important;
}

.new-starter-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.new-starters-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding-inline: 2px;
}
.new-starters-head span {
  font: 700 11px/16px var(--ds-code, var(--mono));
  letter-spacing: 0.08em;
  color: var(--ui-secondary);
  text-transform: uppercase;
}
.new-starters-head small {
  font: 400 12px/16px var(--ds-display, var(--sans));
  color: var(--ui-muted);
}

.new-bento-starters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
}
.new-starter-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 12px 13px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: var(--ui-surface);
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--ds-duration-color, 160ms) var(--ds-ease, ease),
    background-color var(--ds-duration-color, 160ms) var(--ds-ease, ease),
    box-shadow var(--ds-duration-color, 160ms) var(--ds-ease, ease);
}
.new-starter-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  background: var(--ui-raised);
}
:global(:root[data-theme='acid'] .new-starter-card:nth-child(1)) { border-top: 2px solid var(--acid-green, #39ff14); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(2)) { border-top: 2px solid var(--acid-cyan, #00ffff); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(3)) { border-top: 2px solid var(--acid-yellow, #e6ff00); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(4)) { border-top: 2px solid var(--acid-pink, #ff6ec7); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(2) :is(.new-starter-tag, .new-starter-code)) { color: var(--acid-cyan, #00ffff); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(3) :is(.new-starter-tag, .new-starter-code)) { color: var(--acid-yellow, #e6ff00); }
:global(:root[data-theme='acid'] .new-starter-card:nth-child(4) :is(.new-starter-tag, .new-starter-code)) { color: var(--acid-pink, #ff6ec7); }
:global(:root[data-theme='acid'] .new-starter-card:hover:not(:disabled)) {
  border-color: var(--acid-yellow, #e6ff00);
  box-shadow: 4px 4px 0 var(--acid-violet, #a020f0);
  transform: none;
}
:global(:root[data-theme='acid'] .new-starter-card:active:not(:disabled)) {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 var(--acid-green, #39ff14);
}
.new-starter-card:disabled { opacity: 0.55; cursor: not-allowed; }
.new-starter-top {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 6px;
}
.new-starter-code {
  font: 600 10.5px/14px var(--ds-code, var(--mono));
  color: var(--ui-muted);
}
.new-starter-tag {
  font: 600 10.5px/14px var(--ds-code, var(--mono));
  letter-spacing: 0.02em;
  color: var(--ui-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.new-starter-icon {
  display: grid;
  place-items: center;
  margin-left: auto;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 5px);
  background: var(--ui-raised);
  color: var(--ui-muted);
}
.new-starter-card strong {
  font: 600 13px/18px var(--ds-display, var(--sans));
  letter-spacing: -0.01em;
}
.new-starter-card small {
  font: 400 12px/16.5px var(--ds-display, var(--sans));
  color: var(--ui-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.new-starter-cta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: auto;
  padding-top: 3px;
  color: var(--ui-muted);
  font: 500 11px/15px var(--ds-display, var(--sans));
  transition: color 140ms ease;
}
.new-starter-card:hover .new-starter-cta { color: var(--ui-accent); }

@media (max-width: 1180px) {
  .new-bento-starters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .new-starter-section { display: none; }
}
.new-branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(100%, 340px);
  height: 32px;
  padding-inline: 9px;
  border: 1px solid var(--chat-rule, var(--ui-border));
  border-radius: var(--ds-radius-sm, 6px);
  background: var(--chat-panel, var(--ui-surface));
  color: var(--ui-secondary);
  font-size: 12px;
}
.new-branch:hover, .new-branch:focus-within { border-color: var(--ui-accent); }
.new-branch svg { flex-shrink: 0; }
.new-branch select { min-width: 0; max-width: 100%; appearance: none; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; text-overflow: ellipsis; }
.new-branch select:not(:disabled) { cursor: pointer; }
</style>

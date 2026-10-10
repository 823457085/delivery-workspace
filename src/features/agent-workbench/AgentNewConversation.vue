<script setup lang="ts">
/**
 * 设计说明：新会话采用与 Codex 一致的“先进入空白会话，再在输入区切换上下文”模式。
 * 项目与分支为可选上下文；未选项目时由服务端创建独立会话目录，不默认绑定最近项目。
 */
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { Bot, ChevronDown, Folder, FolderOpen, GitBranch, Laptop, Send, Settings2 } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentReasoningEffort, AgentRunMode, AgentRuntimeHealth, AgentServiceTier, AgentWorkspaceBranches } from '../../../shared/agent-runtime';
import AgentAccessSelector from './AgentAccessSelector.vue';
import AgentModelSpeed from './AgentModelSpeed.vue';
import AgentPromptEditor from './AgentPromptEditor.vue';
import type { AgentBusinessMention } from './agent-business-context';

export interface AgentWorkspaceOption {
  path: string;
  label: string;
  branch: string;
}

const props = defineProps<{ runtimes: AgentRuntimeHealth[]; workspaces: AgentWorkspaceOption[]; changing: string; canStart: boolean;
  businessOptions: AgentBusinessMention[] }>();
const provider = defineModel<AgentProvider>('provider', { required: true });
const mode = defineModel<AgentRunMode>('mode', { required: true });
const accessMode = defineModel<AgentAccessMode>('accessMode', { required: true });
const model = defineModel<string>('model', { required: true });
const serviceTier = defineModel<AgentServiceTier | undefined>('serviceTier', { required: true });
const reasoningEffort = defineModel<AgentReasoningEffort | ''>('reasoningEffort', { required: true });
const objective = defineModel<string>('objective', { required: true });
const attachments = defineModel<AgentAttachment[]>('attachments', { required: true });
const workspacePath = defineModel<string>('workspacePath', { required: true });
const branch = defineModel<string>('branch', { required: true });
const emit = defineEmits<{ send: []; chooseWorkspace: []; configureModels: [] }>();
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const workspaceMenuOpen = shallowRef(false);
const workspaceQuery = shallowRef('');
const branchOptions = shallowRef<string[]>([]);
const branchesLoading = shallowRef(false);
const runtime = computed(() => props.runtimes.find((item) => item.provider === provider.value));
const modelOptions = computed(() => runtime.value?.models || []);
const selectedModel = computed(() => modelOptions.value.find((item) => item.id === model.value));
const effortOptions = computed(() => selectedModel.value?.efforts || []);
const currentWorkspace = computed(() => props.workspaces.find((item) => item.path === workspacePath.value));
const workspaceLabel = computed(() => currentWorkspace.value?.label || (workspacePath.value ? workspacePath.value.split('/').filter(Boolean).at(-1) : '不选择项目'));
const filteredWorkspaces = computed(() => {
  const term = workspaceQuery.value.trim().toLowerCase();
  if (!term) return props.workspaces;
  return props.workspaces.filter((item) => `${item.label} ${item.path} ${item.branch}`.toLowerCase().includes(term));
});
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
const modeLabel = computed(() => mode.value === 'agent' ? 'Agent 模式' : mode.value === 'plan' ? 'Plan 模式' : 'Ask 模式');

watch(workspaceMenuOpen, (open) => { if (!open) workspaceQuery.value = ''; });
watch(mode, (value) => { if (value !== 'agent') accessMode.value = 'workspace'; });
watch(() => workspacePath.value, async (nextPath, _previousPath, onCleanup) => {
  branchOptions.value = [];
  if (!nextPath) { branch.value = ''; branchesLoading.value = false; return; }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  branchesLoading.value = true;
  try {
    const params = new URLSearchParams({ workspacePath: nextPath });
    const response = await fetch(`/api/agent-runtimes/branches?${params}`, { signal: controller.signal });
    const result = await response.json() as AgentWorkspaceBranches & { message?: string };
    if (!response.ok) throw new Error(result.message || '分支列表读取失败');
    branchOptions.value = result.branches;
    branch.value = result.current || (result.branches.includes(branch.value) ? branch.value : result.branches[0] || '');
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : '分支列表读取失败');
  } finally {
    if (!controller.signal.aborted) branchesLoading.value = false;
  }
}, { immediate: true });

function selectWorkspace(item: AgentWorkspaceOption) {
  workspacePath.value = item.path;
  branch.value = item.branch;
  workspaceMenuOpen.value = false;
}

function chooseWorkspace() {
  workspaceMenuOpen.value = false;
  emit('chooseWorkspace');
}

function clearWorkspace() {
  workspacePath.value = '';
  branch.value = '';
  workspaceMenuOpen.value = false;
}

function submit() {
  if (props.canStart) emit('send');
}

function focusPrompt() { void promptEditor.value?.focusInput(); }

defineExpose({ focusPrompt });
</script>

<template>
  <section class="new-conversation" aria-label="新建 Agent 会话">
    <header class="new-header"><strong>启元</strong><span>新会话</span></header>
    <div class="new-empty">
      <span class="new-mark">›_</span>
      <h1 v-if="workspacePath">想让我在 <em>{{ workspaceLabel }}</em> 中完成什么？</h1>
      <h1 v-else>想让我帮你完成什么？</h1>
    </div>
    <footer class="new-composer">
      <div class="context-row">
        <el-popover v-model:visible="workspaceMenuOpen" trigger="click" placement="top-start" :width="330" popper-class="agent-workspace-popper">
          <template #reference><button type="button" class="context-chip workspace-chip"><Folder :size="14" /><span>{{ workspaceLabel }}</span><ChevronDown :size="12" /></button></template>
          <div class="workspace-menu">
            <label><span>⌕</span><input v-model="workspaceQuery" type="search" placeholder="搜索项目" /></label>
            <div class="workspace-options">
              <button type="button" :class="{ active: !workspacePath }" @click="clearWorkspace"><Folder :size="14" /><span><strong>不选择项目</strong></span><i v-if="!workspacePath">✓</i></button>
              <button v-for="item in filteredWorkspaces" :key="item.path" type="button" :class="{ active: item.path === workspacePath }" @click="selectWorkspace(item)">
                <Folder :size="14" /><span><strong>{{ item.label }}</strong><small>{{ item.path }}</small></span><i v-if="item.path === workspacePath">✓</i>
              </button>
              <p v-if="!filteredWorkspaces.length">没有匹配的最近工作区</p>
            </div>
            <button type="button" class="choose-folder" @click="chooseWorkspace"><FolderOpen :size="14" /> 选择其他文件夹</button>
          </div>
        </el-popover>
        <label class="context-select"><Laptop :size="13" /><select v-model="provider" aria-label="选择执行器"><option v-for="item in runtimes" :key="item.provider" :value="item.provider" :disabled="!item.ready">{{ item.provider === 'codex' ? 'Codex CLI' : 'Cursor CLI' }}</option></select><ChevronDown :size="12" /></label>
        <span class="context-chip mode-chip"><Bot :size="13" />{{ modeLabel }}</span>
        <label v-if="workspacePath && (branchesLoading || branchOptions.length)" class="context-select branch-select"><GitBranch :size="13" /><select v-model="branch" aria-label="切换分支" :disabled="branchesLoading"><option v-if="branchesLoading" value="">读取分支…</option><option v-for="item in branchOptions" :key="item" :value="item">{{ item }}</option></select><ChevronDown :size="12" /></label>
      </div>
      <div class="composer-box">
        <AgentPromptEditor ref="promptEditor" v-model="objective" v-model:attachments="attachments" class="new-prompt" :workspace-path="workspacePath" :provider="provider" :modes="runtime?.modes || []"
          :selected-mode="mode" :business-options="businessOptions" :disabled="changing === 'start'" placeholder="随心输入，输入 @ 可选择 Jira、项目、接口、模式、Skill 或文件…" submit-on-enter
          @select-mode="mode = $event" @submit="submit" />
        <div class="composer-actions">
          <div>
            <AgentAccessSelector v-model="accessMode" :mode="mode" :disabled="changing === 'start'" />
            <el-select v-model="model" class="model-select" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" aria-label="选择模型"><el-option v-for="item in modelOptions" :key="item.id || 'default'" :label="item.label" :value="item.id" /></el-select>
            <el-select v-if="effortOptions.length" v-model="reasoningEffort" class="effort-select" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" aria-label="Codex 推理强度"><el-option v-for="effort in effortOptions" :key="effort" :label="`Thinking ${effortLabels[effort]}`" :value="effort" /></el-select>
            <AgentModelSpeed v-model:service-tier="serviceTier" :runtime="runtime" :model="model" />
            <el-button text size="small" aria-label="管理自定义模型" @click="emit('configureModels')"><Settings2 :size="13" /></el-button>
          </div>
          <el-button class="send-button" type="primary" circle :disabled="!canStart" :loading="changing === 'start'" aria-label="创建并发送" @click="submit"><Send :size="15" /></el-button>
        </div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.new-conversation{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background-color:var(--agent-bg);background-image:linear-gradient(var(--agent-wallpaper-empty-shade),var(--agent-wallpaper-empty-shade)),radial-gradient(circle at 50% 34%,color-mix(in srgb,var(--agent-accent) 15%,transparent) 0,transparent 30%),var(--agent-wallpaper);background-position:center,center,var(--agent-wallpaper-position);background-size:auto,auto,cover;color:var(--agent-text)}.new-header{display:flex;align-items:center;gap:8px;min-height:58px;padding:0 22px;border-bottom:1px solid var(--agent-border);background:color-mix(in srgb,var(--agent-panel) 90%,transparent)}.new-header strong,.new-header span{padding:5px 10px;border-radius:7px;font-size:10px}.new-header strong{background:linear-gradient(120deg,var(--agent-cyan),var(--agent-accent));color:#fff}.new-header span{background:var(--agent-panel-strong);color:var(--agent-muted)}.new-empty{display:grid;place-items:center;align-content:center;flex:1;min-height:0;padding:32px;text-align:center}.new-mark{display:grid;place-items:center;width:50px;height:50px;border:2px solid var(--agent-border);border-radius:50%;color:var(--agent-muted);font:20px var(--mono)}.new-empty h1{margin:26px 0 0;font-size:25px;font-weight:450;letter-spacing:-.4px;text-shadow:0 2px 18px var(--agent-bg)}.new-empty em{font-style:normal;text-decoration:underline;text-decoration-color:var(--agent-accent);text-underline-offset:5px}.new-composer{width:min(calc(100% - 64px),980px);margin:0 auto 26px}.context-row{display:flex;align-items:center;gap:7px;margin:0 10px -1px;overflow:hidden}.context-chip,.context-select{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--agent-border);border-bottom-color:var(--agent-panel-strong);border-radius:10px 10px 0 0;background:var(--agent-panel);color:var(--agent-secondary);font-size:10px;white-space:nowrap}.context-chip{cursor:pointer}.workspace-chip span{max-width:190px;overflow:hidden;text-overflow:ellipsis}.context-select select{min-width:0;border:0;outline:0;appearance:none;background:transparent;color:inherit;font:inherit;cursor:pointer}.context-select select:disabled{cursor:default;color:var(--agent-muted)}.branch-select{min-width:0;max-width:300px}.branch-select select{max-width:250px;text-overflow:ellipsis}.composer-box{padding:12px 14px 11px;border:1px solid var(--agent-border);border-radius:14px;background:color-mix(in srgb,var(--agent-panel) 93%,transparent);box-shadow:0 18px 52px #0006,0 0 0 1px #ffffff05 inset;backdrop-filter:blur(16px)}.new-prompt:deep(.prompt-tools){justify-content:flex-start;margin-bottom:7px}.new-prompt:deep(.editor-body){min-height:70px}.composer-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.composer-actions>div{display:flex;align-items:center;gap:6px}.model-select{width:170px}.effort-select{width:120px}.composer-actions:deep(.el-select__wrapper){min-height:29px;border:0;background:transparent;box-shadow:none}.composer-actions:deep(.el-select__selected-item){font-size:10px;color:var(--agent-secondary)}.composer-actions:deep(.el-button:not(.send-button)){color:var(--agent-accent)}.send-button{width:34px;height:34px;background:linear-gradient(125deg,var(--agent-cyan),var(--agent-accent))}
.workspace-menu{display:grid;gap:8px}.workspace-menu>label{display:flex;align-items:center;gap:7px;height:34px;padding:0 10px;border:1px solid #3b4354;border-radius:8px;background:#171b24;color:#858fa1}.workspace-menu input{width:100%;border:0;outline:0;background:transparent;color:#eef1f6;font-size:11px}.workspace-options{display:grid;max-height:260px;overflow-y:auto}.workspace-options button{display:flex;align-items:center;gap:9px;width:100%;padding:8px;border:0;border-radius:7px;background:transparent;color:#d5dae4;text-align:left;cursor:pointer}.workspace-options button:hover,.workspace-options button.active{background:#303440}.workspace-options button>span{display:grid;min-width:0;flex:1}.workspace-options strong{font-size:11px}.workspace-options small{margin-top:2px;overflow:hidden;color:#858fa1;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.workspace-options i{color:#c3bdff;font-style:normal}.workspace-options p{margin:10px;color:#858fa1;font-size:10px}.choose-folder{display:flex;align-items:center;gap:8px;padding:10px 8px;border:0;border-top:1px solid #363e4e;background:transparent;color:#c9cfdb;font-size:11px;cursor:pointer}.choose-folder:hover{color:#fff}
@media(max-width:900px){.new-composer{width:calc(100% - 32px)}.branch-select{display:none}.new-empty h1{font-size:21px}}
</style>

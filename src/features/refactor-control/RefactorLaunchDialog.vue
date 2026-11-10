<script setup lang="ts">
/** 明确展示本次范围和版本；后端重新核对范围及请求编号，重复点击不会重复派发。 */
import { computed, reactive, shallowRef, toRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { agentModelDefaults } from '../../shared/agent-model-defaults';
import { refactorActionLabels, refactorJobActive, refactorJobLabel, type RefactorAction, type RefactorDashboard, type RefactorLaunch, type RefactorPreview } from '../../../shared/refactor-control';
import { refactorRequest } from './useRefactorControl';
import AgentCollaborationMode from '../agent-workbench/AgentCollaborationMode.vue';
import RefactorTeamRoster from './RefactorTeamRoster.vue';
import { useAgentModelSelection } from '../agent-workbench/model-selection';
import type { RefactorBranchSource } from '../../../shared/refactor-local-retest';

const props = defineProps<{ data: RefactorDashboard; runtimes: AgentRuntimeHealth[]; selection: { action: RefactorAction; moduleIds: string[]; issueIds: string[]; interfaceIds?: string[]; version?: string; retestMode?: RefactorLaunch['retestMode']; branches?: RefactorLaunch['branches'] } }>();
const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{ start: [launch: RefactorLaunch, preview: RefactorPreview, requestId: string] }>();
const form = reactive<RefactorLaunch>({ action: 'integrate', moduleIds: [], issueIds: [], interfaceIds: [], version: '', notes: '', provider: 'codex', model: '', reasoningEffort: '', revision: '' });
const preview = shallowRef<RefactorPreview>();
const loading = shallowRef(false), submitting = shallowRef(false), requestId = shallowRef('');
const branchSources = shallowRef<RefactorBranchSource[]>([]), branchesLoading = shallowRef(false);
const localRetest = computed(() => form.action === 'retest' && form.retestMode === 'local');
const branchesReady = computed(() => branchSources.value.length > 0 && branchSources.value.every(source =>
  source.branches.some(branch => branch.ref === form.branches?.find(item => item.workspacePath === source.workspacePath)?.ref)));
const executors = computed(() => props.runtimes.filter(runtime => runtime.writable && runtime.ready && (!runtime.accessModes || runtime.accessModes.includes('full'))));
const executor = computed(() => executors.value.find(runtime => runtime.provider === form.provider));
const model = computed(() => executor.value?.models.find(model => model.id === form.model));
const modelPicker = useAgentModelSelection(() => executor.value, toRef(form, 'model'),
  computed({ get: () => form.reasoningEffort || '', set: value => { form.reasoningEffort = value; } }), { allowDefaultEffort: true });
const modules = computed(() => props.data.source?.modules.filter(module => !module.deferred
  && (form.action !== 'retest' && !props.selection.interfaceIds?.length || props.selection.moduleIds.includes(module.id))) || []);
const automatic = computed({ get: () => form.collaborationMode === 'automatic', set: value => { form.collaborationMode = value ? 'automatic' : 'manual'; } });
const existingTeamRetests = computed(() => form.action === 'retest' && !automatic.value ? props.data.jobs.filter(job =>
  job.action === 'retest' && job.collaborationMode === 'automatic' && form.moduleIds.includes(job.moduleId) && refactorJobActive(job)) : []);
watch(open, value => {
  if (!value) return;
  const defaults = agentModelDefaults.value;
  const runtime = executors.value.find(item => item.provider === (defaults.provider || 'codex')) || executors.value[0];
  Object.assign(form, { ...props.selection, interfaceIds: props.selection.interfaceIds || [], version: props.selection.version || '', notes: '', provider: runtime?.provider || 'codex',
    model: runtime?.models.some(item => item.id === defaults.model) ? defaults.model : runtime?.defaultModel || '', reasoningEffort: '', revision: props.data.revision,
    collaborationMode: 'automatic', teamRevision: props.data.groupConfig?.revision,
    retestMode: props.selection.action === 'retest' ? props.selection.retestMode || 'local' : undefined,
    branches: (props.selection.branches || []).map(item => ({ workspacePath: item.workspacePath, ref: item.ref })) });
  branchSources.value = [];
  const selected = runtime?.models.find(item => item.id === form.model);
  form.reasoningEffort = selected?.efforts?.includes(defaults.reasoningEffort as never) ? defaults.reasoningEffort : selected?.defaultEffort || '';
  submitting.value = false; requestId.value = crypto.randomUUID();
});
watch([open, localRetest, () => form.moduleIds.join('\n')], async ([visible, local], _previous, onCleanup) => {
  if (!visible || !local || !form.moduleIds.length) { branchesLoading.value = false; return; }
  const controller = new AbortController(); onCleanup(() => controller.abort());
  branchesLoading.value = true;
  try {
    const sources = await refactorRequest<RefactorBranchSource[]>('/branches', { moduleIds: form.moduleIds }, controller.signal);
    if (controller.signal.aborted) return;
    const previous = form.branches || [];
    branchSources.value = sources;
    form.branches = sources.map(source => ({ workspacePath: source.workspacePath,
      ref: source.branches.find(branch => branch.ref === previous.find(item => item.workspacePath === source.workspacePath)?.ref)?.ref || source.current }));
    const error = sources.find(source => source.error)?.error; if (error) ElMessage.error(error);
  } catch (error) {
    if (!controller.signal.aborted) { branchSources.value = []; form.branches = []; ElMessage.error(error instanceof Error ? error.message : String(error)); }
  } finally { if (!controller.signal.aborted) branchesLoading.value = false; }
});
watch([open, automatic, () => props.data.groupConfig?.revision], ([visible, useTeam, revision]) => {
  if (visible && useTeam && !submitting.value) form.teamRevision = revision;
});
watch(() => form.provider, (value, previous) => {
  if (previous === value || executor.value?.models.some(item => item.id === form.model)) return;
  form.model = executor.value?.defaultModel || '';
});
watch([() => form.provider, () => form.model], () => {
  if (!model.value?.efforts?.includes(form.reasoningEffort as never)) form.reasoningEffort = model.value?.defaultEffort || '';
});
watch([open, () => JSON.stringify(form), branchesLoading], ([visible], _previous, onCleanup) => {
  preview.value = undefined; loading.value = false;
  requestId.value = crypto.randomUUID();
  if (!visible || !form.moduleIds.length || (automatic.value ? !props.data.groupConfig : !executor.value)
    || form.action === 'retest' && (!form.issueIds.length || (localRetest.value ? branchesLoading.value || !branchesReady.value : !form.version.trim()))) return;
  const controller = new AbortController(); loading.value = true;
  const timer = setTimeout(async () => {
    try {
      const result = await refactorRequest<RefactorPreview>('/preview', JSON.parse(JSON.stringify(form)), controller.signal);
      if (!controller.signal.aborted) preview.value = result;
    }
    catch (error) { if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { if (!controller.signal.aborted) loading.value = false; }
  }, 300);
  onCleanup(() => { clearTimeout(timer); controller.abort(); });
});
function submit() {
  if (!preview.value || submitting.value) return;
  submitting.value = true;
  emit('start', JSON.parse(JSON.stringify(form)), preview.value, requestId.value);
}
defineExpose({ finish() { submitting.value = false; } });
</script>

<template>
  <el-dialog v-model="open" :title="refactorActionLabels[selection.action]" width="min(720px, 94vw)" top="5vh" class="refactor-launch-dialog" append-to-body :close-on-click-modal="!submitting" :show-close="!submitting">
    <div class="refactor-launch">
      <div class="launch-context"><span>{{ localRetest ? 'LOCAL' : preview?.environment || data.config.environment }}</span><code>{{ selection.moduleIds.length }} 个模块<template v-if="preview?.sourceHead && !localRetest"> · {{ preview.sourceHead.slice(0, 8) }}</template></code></div>
      <fieldset><legend>执行模块</legend><label v-for="module in modules" :key="module.id"><input v-model="form.moduleIds" type="checkbox" :value="module.id" :disabled="submitting" />{{ module.title }}</label></fieldset>
      <div class="launch-mode"><span>执行方式</span><AgentCollaborationMode v-model="automatic" :disabled="submitting" /></div>
      <RefactorTeamRoster v-if="automatic && data.groupConfig" :config="data.groupConfig" :runtimes="runtimes" compact />
      <p v-if="existingTeamRetests.length" class="launch-caption">
        所选模块已有 {{ existingTeamRetests.length }} 个团队复测任务<template v-if="existingTeamRetests.length === 1">（{{ refactorJobLabel(existingTeamRetests[0]!) }}）</template>。本次会新建单 Agent 复测任务。
        <template v-if="!localRetest || existingTeamRetests.some(job => !job.localPlan)">共享环境按队列顺序执行。</template>
      </p>
      <div class="launch-fields">
        <label v-if="form.action === 'retest'" class="launch-full">复测方式<el-radio-group v-model="form.retestMode" aria-label="复测方式" :disabled="submitting"><el-radio value="local">选择分支，本地复测</el-radio><el-radio value="deployed">复测已部署环境</el-radio></el-radio-group></label>
        <template v-if="localRetest">
          <label v-for="(source, index) in branchSources" :key="source.workspacePath" class="launch-full">{{ source.name }} · 复测分支
            <el-select v-if="form.branches?.[index]" v-model="form.branches[index]!.ref" :aria-label="`${source.name} · 复测分支`" filterable placeholder="选择分支" :loading="branchesLoading" :disabled="submitting">
              <el-option v-for="branch in source.branches" :key="branch.ref" :value="branch.ref" :label="`${branch.name}（${branch.ref.startsWith('refs/remotes/') ? '远端' : '本地'}） · ${branch.head.slice(0, 8)}`" />
            </el-select>
          </label>
          <el-skeleton v-if="branchesLoading" class="launch-full" :rows="1" animated />
          <small class="launch-full">使用所选分支的已提交代码，自动创建独立工作区并启动本地服务。</small>
        </template>
        <template v-if="!automatic"><label>本机执行器（完全访问）<el-select v-model="form.provider" aria-label="本机执行器（完全访问）" :disabled="submitting"><el-option v-for="runtime in executors" :key="runtime.provider" :value="runtime.provider" :label="runtime.label" /></el-select></label>
        <label>模型<el-select v-model="modelPicker.model.value" aria-label="模型" :disabled="submitting" :empty-values="[null, undefined]"><el-option v-for="item in modelPicker.models.value" :key="item.id" :value="item.id" :label="item.label" /></el-select></label>
        <label v-if="modelPicker.efforts.value.length">推理强度<el-select v-model="modelPicker.effort.value" aria-label="推理强度" :disabled="submitting || !modelPicker.efforts.value.length" :empty-values="[null, undefined]"><el-option v-if="modelPicker.allowDefaultEffort.value || !modelPicker.efforts.value.length" value="" label="模型默认" /><el-option v-for="effort in modelPicker.efforts.value" :key="effort" :value="effort" :label="effort" /></el-select></label></template>
        <label v-if="!localRetest" :class="{ 'launch-full': automatic }">{{ form.action === 'retest' ? '已部署版本 / Commit（必填）' : '本次验证版本 / Commit（选填）' }}<input v-model="form.version" maxlength="200" placeholder="填写实际已部署版本" :disabled="submitting" /></label>
      </div>
      <label class="launch-notes">补充要求<textarea v-model="form.notes" rows="2" maxlength="6000" placeholder="本次需要重点检查的页面、场景或设计基线" :disabled="submitting"></textarea></label>
      <el-skeleton v-if="loading" :rows="2" animated />
      <div v-else-if="preview" class="launch-scope"><strong>{{ preview.jobs.length }} 个模块任务 · {{ preview.jobs.reduce((sum, job) => sum + job.targetIds.length, 0) }} 个检查目标</strong><ul><li v-for="job in preview.jobs" :key="job.moduleId"><div>{{ job.moduleTitle }}<small v-if="job.localPlan">{{ job.localPlan.branch }} · {{ job.localPlan.head.slice(0, 8) }} · {{ job.localPlan.packageManager }} run {{ job.localPlan.startScript }}</small><small v-else-if="job.workspacePath">{{ job.workspacePath }}</small><small v-if="job.baseUrl && !job.localPlan">{{ job.baseUrl }}</small></div><span>{{ job.targetIds.length }} {{ form.action === 'retest' ? '个问题' : form.action.startsWith('style-') ? '个页面' : '条接口' }}</span></li></ul></div>
      <p class="launch-caption">{{ automatic ? '由团队负责人按已保存成员与职责安排协作，保留各岗位权限。' : '由所选 Agent 完全访问执行。' }}关闭页面后继续推进，检查结果与人工验收分别保留。</p>
    </div>
    <template #footer><div class="launch-footer"><span v-if="preview" class="launch-footer-summary"><strong>{{ preview.jobs.length }} 个模块 · {{ preview.jobs.reduce((sum, job) => sum + job.targetIds.length, 0) }} 个检查目标</strong><small>{{ automatic ? `${preview.teamName || data.groupConfig?.name || '团队群聊'} · 配置 v${preview.teamRevision}` : '单个 Agent' }}</small></span><div><el-button :disabled="submitting" @click="open = false">取消</el-button><el-button type="primary" :disabled="!preview || loading" :loading="submitting" @click="submit">{{ automatic ? '交给我的团队' : '确认并排队' }}</el-button></div></div></template>
  </el-dialog>
</template>

<style scoped>
.launch-mode{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:18px 0;font:13px var(--sans)}.launch-full{grid-column:1/-1}.refactor-launch .launch-fields{margin-top:18px}.refactor-launch :deep(.collaboration-mode){--agent-border:var(--ui-border);--agent-panel:var(--ui-surface);--agent-panel-strong:var(--ui-raised);--agent-accent:var(--ui-accent);--agent-secondary:var(--ui-secondary)}

.refactor-launch{font-family:var(--font,sans-serif);color:var(--ui-text)}.launch-context{display:flex;align-items:center;gap:12px}.launch-context span{padding:4px 8px;border-radius:5px;background:var(--ui-accent-soft);color:var(--ui-accent);font-size:12px}.launch-context code{font:12px var(--mono);color:var(--ui-secondary)}.launch-path{margin:8px 0 20px;font-size:12px;color:var(--ui-muted);overflow-wrap:anywhere}.refactor-launch fieldset{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0 0 18px;padding:12px 14px;border:1px solid var(--ui-border);border-radius:8px}.refactor-launch legend{padding:0 5px;font-size:12px;color:var(--ui-secondary)}.refactor-launch fieldset label{display:flex;align-items:center;gap:7px;min-height:36px;font-size:13px}.launch-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.launch-fields>label,.launch-notes{display:grid;min-width:0;gap:7px;font-size:12px;color:var(--ui-secondary)}.launch-fields>label>input,.launch-notes textarea{box-sizing:border-box;width:100%;min-width:0;min-height:40px;padding:9px 10px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-surface);color:var(--ui-text);font:inherit}.launch-fields :deep(.el-select){width:100%;min-width:0}.launch-fields :deep(.el-select__wrapper){min-height:40px;border-radius:7px}.launch-notes{margin:16px 0}.launch-notes textarea{resize:vertical}.launch-scope{padding-top:14px;border-top:1px solid var(--ui-border)}.launch-scope strong{font-size:14px}.launch-scope ul{margin:12px 0 0;padding:0;list-style:none}.launch-scope li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:13px}.launch-scope li span{white-space:nowrap;color:var(--ui-muted)}.launch-caption{margin:14px 0 0;color:var(--ui-muted);font-size:12px;line-height:1.6}.refactor-launch input[type=checkbox]{accent-color:var(--ui-accent)}.refactor-launch :is(input,select,textarea):focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}@media(max-width:560px){.launch-fields{grid-template-columns:1fr}.refactor-launch fieldset label{min-height:44px}.launch-context{flex-wrap:wrap}}
</style>

<style scoped>
@media(max-width:560px){.launch-fields>label>input,.launch-fields :deep(.el-select__wrapper){min-height:44px}.launch-mode{align-items:flex-start;flex-direction:column;gap:10px}.launch-mode :deep(.collaboration-mode){width:100%}}
</style>

<style scoped>
.launch-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}.launch-footer>div{margin-left:auto}.launch-footer-summary{display:grid;gap:3px;text-align:left;font:12px var(--sans);color:var(--ui-text)}.launch-footer-summary strong{font-weight:500}.launch-footer-summary small{font-size:11px;color:var(--ui-secondary)}
@media(max-width:560px){.launch-footer-summary{width:100%}.launch-footer :deep(.el-button){min-height:44px}}
</style>

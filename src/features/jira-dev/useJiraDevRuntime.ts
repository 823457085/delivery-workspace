/**
 * 设计说明：执行器选择只读取工作台已检测的 CLI 与模型，选择按流程保存在本机浏览器；
 * 模型与强度按执行器真实目录选择，访问权限以执行器实际支持为准，服务端启动时仍会再次校验。
 */
import { computed, reactive, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { agentProviderLabels, type AgentAccessMode, type AgentProvider, type AgentReasoningEffort, type AgentRuntimeHealth } from '../../../shared/agent-runtime';

export const jiraDevEffortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
import type { JiraDevRuntimeSelection, JiraDevWorkflow } from '../../../shared/jira-dev';
import { readGroupDashboard } from '../agent-workbench/group-chat-api';
import { agentModelDefaults } from '../../shared/agent-model-defaults';
import { useAgentModelSelection } from '../agent-workbench/model-selection';

export function useJiraDevRuntime(workflow: JiraDevWorkflow, projectCount: () => number = () => 1) {
  const storageKey = `qiyuan:jira-dev:${workflow}:runtime:v1`;
  const defaultAccess: AgentAccessMode = workflow === 'requirement' ? 'full' : 'workspace';
  const selection = reactive<JiraDevRuntimeSelection>({ collaborationMode: 'group', provider: 'codex', model: '', reasoningEffort: '', accessMode: defaultAccess });
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && ['codex', 'cursor', 'claude', 'kiro', 'antigravity'].includes(saved.provider) && typeof saved.model === 'string') { Object.assign(selection, saved); if (selection.collaborationMode === 'automatic') selection.collaborationMode = 'group'; restored = true; }
  } catch { /* 使用默认执行器。 */ }
  const automatic = computed({ get: () => selection.collaborationMode !== 'manual', set: (value: boolean) => { selection.collaborationMode = value ? 'group' : 'manual'; } });
  const query = useQuery({ queryKey: ['jira-dev-runtimes'], retry: false, staleTime: 60_000,
    queryFn: async ({ signal }): Promise<AgentRuntimeHealth[]> => {
      const response = await fetch('/api/agent-runtimes', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '执行器状态读取失败');
      return data.runtimes;
    } });
  const teamQuery = useQuery({ queryKey: ['agent-group-chat'], queryFn: ({ signal }) => readGroupDashboard(signal), enabled: automatic, retry: false, refetchInterval: 3000 });
  const team = computed(() => teamQuery.data.value?.config);
  const teamMembers = computed(() => team.value?.members.filter(member => member.enabled) || []);
  watch([automatic, team], ([enabled, value]) => { if (enabled && value) selection.groupConfigRevision = value.revision; else delete selection.groupConfigRevision; }, { immediate: true });
  const runtimes = computed(() => query.data.value || []);
  const runtime = computed(() => runtimes.value.find(item => item.provider === selection.provider));
  const model = computed(() => runtime.value?.models.find(item => item.id === selection.model));
  const modelPicker = useAgentModelSelection(() => runtime.value,
    computed({ get: () => selection.model, set: value => { selection.model = value; } }),
    computed({ get: () => selection.reasoningEffort, set: value => { selection.reasoningEffort = value; } }));
  const models = modelPicker.models, efforts = modelPicker.efforts;
  // 与运行器和会话页一致：省略能力列表表示两种权限均支持，显式列表才限定可选范围。
  const accessModes = computed<AgentAccessMode[]>(() => automatic.value ? ['workspace', 'full'] : runtime.value?.accessModes || ['workspace', 'full']);
  watch(accessModes, modes => {
    if (!modes.includes(selection.accessMode)) selection.accessMode = modes.includes(defaultAccess) ? defaultAccess : modes[0]!;
  });

  function defaultModel(target: AgentRuntimeHealth) {
    if (target.provider === (agentModelDefaults.value.provider || 'codex') && target.models.some(item => item.id === agentModelDefaults.value.model)) return agentModelDefaults.value.model;
    return target.models.some(item => item.id === target.defaultModel) ? target.defaultModel : target.models[0]?.id || '';
  }
  function defaultEffort() {
    const supported = model.value?.efforts || [];
    if (!supported.length) return '';
    const preferred = selection.provider === (agentModelDefaults.value.provider || 'codex') && selection.model === agentModelDefaults.value.model ? agentModelDefaults.value.reasoningEffort : '';
    return preferred && supported.includes(preferred) ? preferred : model.value?.defaultEffort || (selection.provider === 'claude' ? '' : supported[0] || '');
  }
  function choose(provider: AgentProvider) {
    const target = runtimes.value.find(item => item.provider === provider);
    selection.provider = provider;
    selection.model = target ? defaultModel(target) : '';
    selection.reasoningEffort = defaultEffort();
    if (!accessModes.value.includes(selection.accessMode)) selection.accessMode = accessModes.value.includes(defaultAccess) ? defaultAccess : accessModes.value[0]!;
  }
  function chooseModel(id: string) {
    modelPicker.model.value = id;
  }
  // 首次加载或执行器列表变化后，把失效的旧选择纠正为可用值，不静默切换仍有效的选择。
  watch(runtimes, items => {
    if (!items.length) return;
    if (!runtime.value) { choose(items.find(item => item.ready)?.provider || items[0]!.provider); return; }
    if (!restored && !selection.model) choose(selection.provider);
    if (!model.value) chooseModel(defaultModel(runtime.value));
    if (selection.reasoningEffort && !model.value?.efforts?.includes(selection.reasoningEffort)) selection.reasoningEffort = defaultEffort();
    if (!accessModes.value.includes(selection.accessMode)) selection.accessMode = accessModes.value[0]!;
  }, { immediate: true });
  watch(selection, value => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* 本次仍可启动。 */ } });

  const problem = computed(() => {
    if (projectCount() > 1 && selection.accessMode !== 'full') return '多项目任务需要完全访问权限，请选择完全访问后开始。';
    if (automatic.value) {
      if (teamQuery.error.value) return teamQuery.error.value.message;
      if (!team.value) return '正在读取团队配置…';
      if (!teamMembers.value.some(member => member.capability === 'write')) return '请在团队设置中启用可修改代码的成员';
      const unbound = teamMembers.value.find(member => !member.binding);
      if (unbound) return `请先为「${unbound.name}」设置本机模型`;
      if (query.error.value) return query.error.value.message;
      if (query.isPending.value) return '正在读取执行器…';
      for (const member of teamMembers.value) {
        const target = runtimes.value.find(item => item.provider === member.binding?.provider);
        if (!target?.ready) return `「${member.name}」的执行器尚未就绪${target?.message ? ` · ${target.message}` : ''}`;
      }
      return '';
    }
    if (query.error.value) return query.error.value.message;
    if (!runtime.value) return query.isPending.value ? '正在读取执行器…' : '请选择执行器';
    if (!runtime.value.ready) return runtime.value.message || `${runtime.value.label} 当前不可用`;
    if (!model.value) return '请选择模型';
    return '';
  });
  const summary = computed(() => automatic.value
    ? `团队群聊 · ${team.value?.name || '正在读取团队'} · ${teamMembers.value.map(member => member.name).join('、')} · ${selection.accessMode === 'full' ? '完全访问' : '仅工作区'}`
    : [agentProviderLabels[selection.provider], models.value.find(item => item.id === modelPicker.model.value)?.label || model.value?.label || selection.model || 'CLI 默认模型',
    modelPicker.effort.value ? `推理${jiraDevEffortLabels[modelPicker.effort.value]}` : '', selection.accessMode === 'full' ? '完全访问' : '仅工作区'].filter(Boolean).join(' · '));
  return { selection, automatic, team, teamMembers, runtimes, models, efforts, modelPicker, accessModes, problem, summary, loading: query.isPending, choose, chooseModel };
}

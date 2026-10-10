/**
 * 设计说明：@ 选择器统一编排业务上下文、运行模式、Codex Skills 与工作区文件。
 * 模式改变真实运行参数；其他选项只写入可识别引用，不在浏览器读取文件正文或执行业务写操作。
 */
import { computed, shallowRef, watch, type Ref } from 'vue';
import type { AgentProvider, AgentRunMode, AgentSkillOption } from '../../../shared/agent-runtime';
import type { AgentBusinessMention } from './agent-business-context';
import type { AgentNote } from '../../../shared/agent-notes';
import { noteRequest } from './useAgentNotes';

export type AgentMentionKind = 'business' | 'mode' | 'skill' | 'file' | 'note';

export interface AgentMentionOption {
  id: string;
  kind: AgentMentionKind;
  label: string;
  detail: string;
  value: string;
}

interface AgentMentionContext {
  workspacePath: string;
  provider: AgentProvider;
  modes: AgentRunMode[];
  selectedMode?: AgentRunMode;
  modeLocked?: boolean;
  businessOptions?: AgentBusinessMention[];
}

const modeDetails: Record<AgentRunMode, { label: string; detail: string }> = {
  agent: { label: 'Agent 模式', detail: '可修改工作区并运行必要命令' },
  plan: { label: 'Plan 模式', detail: '只读分析并输出可执行方案' },
  ask: { label: 'Ask 模式', detail: '只读回答当前问题' },
};

export function shouldPrioritizeSkillMentions(query: string | undefined) {
  const term = query?.trim() || '';
  if (!term) return false;
  if (/^(?:jira(?:任务)?|项目|接口|合入)(?:[:：\s]|$)/i.test(term)) return false;
  return !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+$/i.test(term);
}

export function useAgentMentions(draft: Ref<string>, context: () => AgentMentionContext, disabled: () => boolean,
  onSelectMode: (mode: AgentRunMode) => void) {
  const files = shallowRef<string[]>([]);
  const skills = shallowRef<AgentSkillOption[]>([]);
  const notes = shallowRef<AgentNote[]>([]);
  const loading = shallowRef(false);
  const open = shallowRef(false);
  const activeIndex = shallowRef(0);
  const mentionQuery = computed(() => draft.value.match(/(?:^|\s)@([^\s@"]*)$/)?.[1]);
  const prioritizeSkills = computed(() => shouldPrioritizeSkillMentions(mentionQuery.value));
  const options = computed<AgentMentionOption[]>(() => {
    const state = context();
    const term = (mentionQuery.value || '').toLowerCase();
    const availableModes = state.modeLocked && state.selectedMode ? [state.selectedMode] : state.modes;
    const modes = availableModes.filter((mode) => {
      const item = modeDetails[mode];
      return !term || `${mode} ${item.label} ${item.detail}`.toLowerCase().includes(term);
    }).map((mode) => ({ id: `mode:${mode}`, kind: 'mode' as const, label: modeDetails[mode].label,
      detail: state.modeLocked ? '当前会话模式，续聊时保持不变' : modeDetails[mode].detail, value: mode }));
    const filteredBusiness = (state.businessOptions || []).filter(option => !term
      || `${option.label} ${option.detail} ${option.value}`.toLowerCase().includes(term));
    const visibleBusiness = term ? filteredBusiness.slice(0, 40) : (['jira', 'project', 'interface', 'merge'] as const)
      .flatMap(type => filteredBusiness.filter(option => option.type === type).slice(0, 8));
    const business = visibleBusiness
      .map(option => ({ id: option.id, kind: 'business' as const, label: option.label, detail: option.detail, value: option.value }));
    const skillOptions = skills.value.map((skill) => ({ id: `skill:${skill.invocation}`, kind: 'skill' as const, label: `$${skill.invocation}`,
      detail: skill.description || skill.sourceLabel, value: skill.invocation }));
    const fileOptions = files.value.map((file) => ({ id: `file:${file}`, kind: 'file' as const, label: file, detail: '工作区文件', value: file }));
    const noteOptions = notes.value.map(note => ({ id: note.reference, kind: 'note' as const, label: note.title, detail: note.path, value: note.reference }));
    return prioritizeSkills.value
      ? [...skillOptions, ...noteOptions, ...modes, ...fileOptions]
      : [...business, ...modes, ...skillOptions, ...noteOptions, ...fileOptions];
  });
  const activeOption = computed(() => options.value[activeIndex.value]);

  watch([mentionQuery, () => context().workspacePath, () => context().provider, disabled], ([query, workspace, provider, isDisabled], _previous, onCleanup) => {
    if (query === undefined || isDisabled) { open.value = false; files.value = []; skills.value = []; notes.value = []; loading.value = false; return; }
    open.value = true;
    activeIndex.value = 0;
    files.value = []; skills.value = []; notes.value = [];
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      loading.value = true;
      try {
        const params = new URLSearchParams({ workspacePath: workspace, provider, q: query });
        const [workspaceResult, noteResult] = await Promise.allSettled([
          workspace ? fetch(`/api/agent-runtimes/mentions?${params}`, { signal: controller.signal }).then(async response => {
            const data = await response.json() as { message?: string; files?: unknown; skills?: unknown };
            if (!response.ok) throw new Error(data.message || '候选项读取失败');
            return data;
          }) : Promise.resolve({ files: [], skills: [] }),
          noteRequest<{ notes: AgentNote[] }>(`notes?q=${encodeURIComponent(query)}`, undefined, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const data = workspaceResult.status === 'fulfilled' ? workspaceResult.value : { files: [], skills: [] };
        notes.value = noteResult.status === 'fulfilled' ? noteResult.value.notes : [];
        files.value = Array.isArray(data.files) ? data.files.filter((item: unknown): item is string => typeof item === 'string') : [];
        skills.value = Array.isArray(data.skills) ? data.skills.filter((item: unknown): item is AgentSkillOption => !!item && typeof item === 'object'
          && typeof (item as AgentSkillOption).invocation === 'string' && typeof (item as AgentSkillOption).name === 'string') : [];
        activeIndex.value = 0;
      } catch {
        if (!controller.signal.aborted) { files.value = []; skills.value = []; notes.value = []; }
      } finally { if (!controller.signal.aborted) loading.value = false; }
    }, 120);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });

  function replaceTrigger(replacement = '') {
    draft.value = draft.value.replace(/(^|\s)@([^\s@"]*)$/, (_match, prefix: string) => `${prefix}${replacement}`);
  }

  function select(option: AgentMentionOption) {
    if (option.kind === 'mode') {
      if (!context().modeLocked) onSelectMode(option.value as AgentRunMode);
      replaceTrigger();
    } else if (option.kind === 'skill') {
      replaceTrigger(`$${option.value} `);
    } else if (option.kind === 'business') {
      replaceTrigger(`${option.value} `);
    } else {
      const reference = /\s/.test(option.value) ? `@"${option.value}"` : `@${option.value}`;
      replaceTrigger(`${reference} `);
    }
    open.value = false;
  }

  function insertTrigger() {
    draft.value = `${draft.value}${draft.value && !/\s$/.test(draft.value) ? ' ' : ''}@`;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open.value || !options.value.length) return false;
    if (event.key === 'ArrowDown') activeIndex.value = (activeIndex.value + 1) % options.value.length;
    else if (event.key === 'ArrowUp') activeIndex.value = (activeIndex.value - 1 + options.value.length) % options.value.length;
    else if (event.key === 'Enter' || event.key === 'Tab') select(options.value[activeIndex.value]);
    else if (event.key === 'Escape') open.value = false;
    else return false;
    event.preventDefault();
    return true;
  }

  return { loading, open, options, activeOption, prioritizeSkills, select, insertTrigger, handleKeydown };
}

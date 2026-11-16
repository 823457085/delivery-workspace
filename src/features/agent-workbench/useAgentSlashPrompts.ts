/**
 * 设计说明：借鉴 LibreChat / Cherry Studio 的 `/` 快捷指令与常用提示词库。
 * 仅在行首或消息开头输入 `/`（或点击快捷指令按钮）时唤起，避免与网址、文件路径中的斜杠冲突；
 * 支持内置高频研发指令与用户个人收藏指令（持久化于浏览器 localStorage）。
 */
import { computed, shallowRef, watch, type Ref } from 'vue';
import type { AgentRunMode } from '../../../shared/agent-runtime';
import { extractPromptVariables } from './prompt-variables-and-paste';

export interface AgentSlashPrompt {
  id: string;
  command: string;
  label: string;
  detail: string;
  template: string;
  mode?: AgentRunMode;
  custom?: boolean;
}

export const CUSTOM_SLASH_PROMPTS_KEY = 'agent-custom-slash-prompts:v1';
const MAX_CUSTOM_SLASH_PROMPTS = 30;

export const BUILTIN_SLASH_PROMPTS: readonly AgentSlashPrompt[] = [
  {
    id: 'builtin:review',
    command: '检查改动',
    label: '/检查改动',
    detail: '审阅当前代码改动，找出漏改、风险和边界问题（只读分析）',
    mode: 'ask',
    template: '请帮我仔细检查当前工作区的代码改动：\n1. 有没有潜在报错、边界遗漏或性能隐患；\n2. 有没有影响原有逻辑的地方；\n3. 用大白话列出需要关注的点和修改建议。',
  },
  {
    id: 'builtin:fix',
    command: '修报错',
    label: '/修报错',
    detail: '定位并直接修复报错或异常，改完后自动验证',
    mode: 'agent',
    template: '请帮我定位并修复下面这个问题，改完后顺手跑一下相关验证确认修好：\n',
  },
  {
    id: 'builtin:plan',
    command: '出方案',
    label: '/出方案',
    detail: '先只读梳理实现步骤与涉及文件，暂不直接改代码',
    mode: 'plan',
    template: '请先不要改代码，帮我梳理清楚实现方案（要改哪些文件、分几步做、有哪些风险点）：\n',
  },
  {
    id: 'builtin:test',
    command: '写测试',
    label: '/写测试',
    detail: '为最近改动补充自动化测试并实际跑通',
    mode: 'agent',
    template: '请针对最近的代码改动补充关键单元测试或回归测试，并实际运行确认全部通过。',
  },
  {
    id: 'builtin:simplify',
    command: '精简优化',
    label: '/精简优化',
    detail: '保持原有功能不变，清理重复逻辑并提升可读性',
    mode: 'agent',
    template: '请在确保现有功能和对外行为完全不变的前提下，帮我精简优化这部分代码，去掉冗余逻辑并验证通过：\n',
  },
  {
    id: 'builtin:summary',
    command: '总结进展',
    label: '/总结进展',
    detail: '用简短大白话汇总目前完成了什么、还剩什么',
    mode: 'ask',
    template: '请用简短易懂的大白话帮我总结：目前已经完成了哪些内容、改了哪些地方、接下来还需要做什么？',
  },
  {
    id: 'builtin:commit',
    command: '提交说明',
    label: '/提交说明',
    detail: '根据当前工作区 Git 改动生成清晰的提交说明',
    mode: 'ask',
    template: '请查看当前工作区的 Git 改动，帮我写一段简明清晰的 Git 提交说明（包含一句话标题和改动要点）。',
  },
  {
    id: 'builtin:rca',
    command: '根因分析',
    label: '/根因分析',
    detail: '只读追踪异常因果链，定位问题真正源头而非表面症状打补丁',
    mode: 'ask',
    template: '请先不要急着改代码，帮我对下面这个问题做深度根因分析（RCA）：\n1. 还原完整的调用/数据流因果链；\n2. 区分表面症状与根本原因（精确到文件与行号）；\n3. 给出最小侵入性的根治方案与回归验证点：\n',
  },
  {
    id: 'builtin:blast-radius',
    command: '影响面评估',
    label: '/影响面评估',
    detail: '梳理改动波及的导出符号、下游调用方与需覆盖的回归测试',
    mode: 'plan',
    template: '请帮我评估这部分逻辑修改的代码爆炸半径（Blast Radius）：\n1. 哪些导出函数/类型签名会受影响，有哪些未改动的下游调用方；\n2. 是否涉及跨端契约、持久化结构或兼容性边界；\n3. 需要重点运行或补充哪些测试文件：\n',
  },
  {
    id: 'builtin:hygiene',
    command: '安全自检',
    label: '/安全自检',
    detail: '扫描当前改动的硬编码密钥、路径越界、权限漏洞与调试残留',
    mode: 'ask',
    template: '请对当前工作区的未提交改动做一次安全与交付卫生自检：\n1. 是否存在硬编码密钥/Token、敏感日志输出或冲突标记残留；\n2. 是否存在未校验输入、路径穿越、越权访问或异常吞没风险；\n3. 列出必须阻断修复的问题与改进建议。',
  },
  {
    id: 'builtin:split-commits',
    command: '拆分提交',
    label: '/拆分提交',
    detail: '将当前混杂改动规划为职责单一、便于 Code Review 的原子提交序列',
    mode: 'plan',
    template: '请查看当前工作区的所有改动文件，按职责单一与依赖先后顺序，帮我规划一套清晰的原子化 Git 拆分提交方案（列出每一笔 Commit 包含的文件列表与建议提交标题）。',
  },
  {
    id: 'builtin:api-debug',
    command: '查接口',
    label: '/查接口',
    detail: '按接口路径与异常现象排查前后端传参及报错（支持填空）',
    mode: 'ask',
    template: '请帮我排查接口 {{接口路径或名称}}，目前现象是：{{异常现象:返回报错或字段不对}}。请核对前后端传参、返回结构与错误处理，并用大白话告诉我原因。',
  },
  {
    id: 'builtin:ui-tweak',
    command: '改页面',
    label: '/改页面',
    detail: '指定页面位置与预期效果快速修改界面并自测（支持填空）',
    mode: 'agent',
    template: '请帮我修改 {{页面或功能位置}}，具体调整要求：{{想改成什么样}}。改完后请自测构建确保不影响其他地方。',
  },
];

export function extractSlashTrigger(text: string): { prefix: string; query: string } | undefined {
  const match = text.match(/(^|\n)\/([^\s/]*)$/);
  if (!match) return undefined;
  return { prefix: match[1] || '', query: match[2] || '' };
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeSlashCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\s+/g, '-').slice(0, 24);
}

export function readCustomSlashPrompts(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): AgentSlashPrompt[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CUSTOM_SLASH_PROMPTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const result: AgentSlashPrompt[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const command = normalizeSlashCommandName(typeof item.command === 'string' ? item.command : '');
      const template = typeof item.template === 'string' ? item.template.trim() : '';
      if (!command || !template) continue;
      const id = typeof item.id === 'string' && item.id ? item.id : `custom:${command}`;
      const detail = typeof item.detail === 'string' && item.detail.trim()
        ? item.detail.trim()
        : template.replace(/\s+/g, ' ').slice(0, 60);
      result.push({
        id,
        command,
        label: `/${command}`,
        detail,
        template,
        custom: true,
      });
      if (result.length >= MAX_CUSTOM_SLASH_PROMPTS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function writeCustomSlashPrompts(
  prompts: readonly AgentSlashPrompt[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    const serializable = prompts.slice(0, MAX_CUSTOM_SLASH_PROMPTS).map(item => ({
      id: item.id,
      command: item.command,
      detail: item.detail,
      template: item.template,
    }));
    storage.setItem(CUSTOM_SLASH_PROMPTS_KEY, JSON.stringify(serializable));
  } catch {
    /* localStorage 不可用时仅在当前内存会话生效 */
  }
}

interface SlashPromptContext {
  modes: AgentRunMode[];
  modeLocked?: boolean;
}

export interface PendingSlashVariableContext {
  option: AgentSlashPrompt;
  prefixDraft: string;
}

export function useAgentSlashPrompts(
  draft: Ref<string>,
  context: () => SlashPromptContext,
  disabled: () => boolean,
  onSelectMode?: (mode: AgentRunMode) => void,
  storage: Storage | null = defaultStorage(),
  onVariablePrompt?: (ctx: PendingSlashVariableContext) => void,
) {
  const customPrompts = shallowRef<AgentSlashPrompt[]>(readCustomSlashPrompts(storage));
  const open = shallowRef(false);
  const manualOpen = shallowRef(false);
  const activeIndex = shallowRef(0);

  const slashTrigger = computed(() => extractSlashTrigger(draft.value));
  const slashQuery = computed(() => slashTrigger.value?.query);

  const canSaveDraft = computed(() => {
    const text = draft.value.trim();
    return text.length >= 4 && !extractSlashTrigger(draft.value);
  });

  const options = computed<AgentSlashPrompt[]>(() => {
    const term = (slashQuery.value ?? '').trim().toLowerCase();
    const all = [...customPrompts.value, ...BUILTIN_SLASH_PROMPTS];
    if (!term) return all;
    return all.filter(item =>
      `${item.command} ${item.label} ${item.detail} ${item.template}`.toLowerCase().includes(term),
    );
  });

  const activeOption = computed(() => options.value[activeIndex.value]);

  watch([slashQuery, disabled], ([query, isDisabled]) => {
    if (isDisabled) {
      open.value = false;
      manualOpen.value = false;
      return;
    }
    if (query !== undefined) {
      open.value = true;
      activeIndex.value = 0;
    } else if (!manualOpen.value) {
      open.value = false;
    }
  }, { immediate: true });

  watch(options, list => {
    if (activeIndex.value >= list.length) activeIndex.value = 0;
  });

  function close() {
    open.value = false;
    manualOpen.value = false;
  }

  function select(option: AgentSlashPrompt) {
    const state = context();
    if (option.mode && !state.modeLocked && state.modes.includes(option.mode)) {
      onSelectMode?.(option.mode);
    }
    if (onVariablePrompt && extractPromptVariables(option.template).length > 0) {
      const prefixDraft = slashTrigger.value !== undefined
        ? draft.value.replace(/(^|\n)\/([^\s/]*)$/, (_match, prefix: string) => prefix)
        : draft.value;
      draft.value = prefixDraft;
      close();
      onVariablePrompt({ option, prefixDraft });
      return;
    }
    const body = option.template.replace(/\{\{光标\}\}/g, '');
    if (slashTrigger.value !== undefined) {
      draft.value = draft.value.replace(/(^|\n)\/([^\s/]*)$/, (_match, prefix: string) => `${prefix}${body}`);
    } else {
      const current = draft.value;
      draft.value = current ? `${current}${current.endsWith('\n') ? '' : '\n'}${body}` : body;
    }
    close();
  }

  function togglePanel() {
    if (disabled()) return;
    if (open.value) {
      if (draft.value === '/') draft.value = '';
      close();
      return;
    }
    customPrompts.value = readCustomSlashPrompts(storage);
    if (!draft.value.trim()) {
      draft.value = '/';
      open.value = true;
      activeIndex.value = 0;
      return;
    }
    manualOpen.value = true;
    open.value = true;
    activeIndex.value = 0;
  }

  function saveCurrentAsCustom(rawName: string): AgentSlashPrompt | undefined {
    const template = draft.value.trim();
    if (!template) return undefined;
    const fallback = template.replace(/\s+/g, ' ').slice(0, 10);
    const command = normalizeSlashCommandName(rawName || fallback);
    if (!command) return undefined;
    const entry: AgentSlashPrompt = {
      id: `custom:${Date.now().toString(36)}:${command}`,
      command,
      label: `/${command}`,
      detail: template.replace(/\s+/g, ' ').slice(0, 60),
      template,
      custom: true,
    };
    const next = [
      entry,
      ...customPrompts.value.filter(item => item.command !== command),
    ].slice(0, MAX_CUSTOM_SLASH_PROMPTS);
    customPrompts.value = next;
    writeCustomSlashPrompts(next, storage);
    return entry;
  }

  function removeCustomPrompt(id: string) {
    const next = customPrompts.value.filter(item => item.id !== id);
    customPrompts.value = next;
    writeCustomSlashPrompts(next, storage);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return false;
    if (!open.value) return false;
    if (event.key === 'Escape') {
      close();
      event.preventDefault();
      return true;
    }
    if (!options.value.length) return false;
    if (event.key === 'ArrowDown') {
      activeIndex.value = (activeIndex.value + 1) % options.value.length;
    } else if (event.key === 'ArrowUp') {
      activeIndex.value = (activeIndex.value - 1 + options.value.length) % options.value.length;
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      select(options.value[activeIndex.value]!);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  return {
    open,
    options,
    customPrompts,
    activeOption,
    canSaveDraft,
    close,
    select,
    togglePanel,
    saveCurrentAsCustom,
    removeCustomPrompt,
    handleKeydown,
  };
}

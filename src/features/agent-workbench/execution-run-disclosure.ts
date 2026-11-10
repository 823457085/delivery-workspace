import { computed, shallowRef, watch } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';

/** 只控制记录的展开状态；轮询保留手动选择，不改写或丢弃运行数据。 */
export function useExecutionRunDisclosure(conversationId: () => string | undefined, runs: () => AgentRun[]) {
  const choices = shallowRef(new Map<string, boolean>());
  const defaults = computed(() => {
    const active = runs().filter(run => ['running', 'queued'].includes(run.status)
      || run.status === 'completed' && run.resultReady === false);
    const latest = runs().reduce<AgentRun | undefined>((current, run) => !current
      || Date.parse(run.updatedAt) > Date.parse(current.updatedAt) ? run : current, undefined);
    return new Set((active.length ? active : latest ? [latest] : []).map(run => run.id));
  });
  watch(conversationId, () => { choices.value = new Map(); }, { flush: 'sync' });
  function isExpanded(id: string) { return choices.value.get(id) ?? defaults.value.has(id); }
  function setExpanded(id: string, expanded: boolean) {
    if (!runs().some(run => run.id === id) || expanded === isExpanded(id)) return;
    choices.value = new Map(choices.value).set(id, expanded);
  }
  return { isExpanded, setExpanded };
}

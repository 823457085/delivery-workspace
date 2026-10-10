/** 分类筛选与分页只作用于当前查询结果，不改写本地来源、不把截断结果当成全库。 */
import { computed, shallowRef, watch, type Ref } from 'vue';
import type { AgentKnowledgeMatch, AgentKnowledgeScope, AgentSkillOption } from '../../../shared/agent-runtime';
import { knowledgeFileQuickPrompt, knowledgeMatchQuickPrompt, knowledgeSkillQuickPrompt } from './agent-quick-actions';
export interface KnowledgeEntry { id: string; title: string; subtitle: string; detail: string; prompt: string }
export function useKnowledgeCatalog(data: { skills: Ref<AgentSkillOption[]>; files: Ref<string[]>; matches: Ref<AgentKnowledgeMatch[]>;
  search: Ref<string>; scope: Ref<AgentKnowledgeScope> }, workspace: () => string) {
  const tab = shallowRef<'skills' | 'files' | 'matches'>('skills');
  const source = shallowRef('');
  const directory = shallowRef('');
  const page = shallowRef(1);
  const parent = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
  const directories = computed(() => [...new Set(data.files.value.map(parent))].sort());
  const entries = computed<KnowledgeEntry[]>(() => {
    if (tab.value === 'skills') return data.skills.value.filter(skill => !source.value || skill.source === source.value)
      .map(skill => ({ id: skill.invocation, title: skill.name, subtitle: skill.sourceLabel, detail: `$${skill.invocation}\n${skill.description || ''}`, prompt: knowledgeSkillQuickPrompt(skill) }));
    if (tab.value === 'files') return data.files.value.filter(file => !directory.value || parent(file) === directory.value)
      .map(file => ({ id: file, title: file.split('/').at(-1) || file, subtitle: parent(file), detail: file, prompt: knowledgeFileQuickPrompt(file) }));
    return data.matches.value.map(match => ({ id: `${match.path}:${match.line}`, title: `${match.path.split('/').at(-1)}:${match.line}`,
      subtitle: match.path, detail: match.excerpt, prompt: knowledgeMatchQuickPrompt(match, data.scope.value) }));
  });
  const pages = computed(() => Math.max(1, Math.ceil(entries.value.length / 12)));
  const visible = computed(() => entries.value.slice((page.value - 1) * 12, page.value * 12));
  watch([tab, source, directory, data.search, workspace], () => { page.value = 1; });
  watch([data.search, workspace], () => { directory.value = ''; });
  watch(workspace, () => { source.value = ''; });
  watch(pages, value => { page.value = Math.min(page.value, value); });
  return { tab, source, directory, directories, page, pages, entries, visible };
}

/**
 * 设计说明：知识检索一期只复用本机工作区文件索引与 Codex Skills，不虚构向量检索。
 * composable 负责可取消的查询状态；文件正文仍由用户选择后交给 CLI 在会话中读取。
 */
import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import type { AgentKnowledgeMatch, AgentKnowledgeScope, AgentProvider, AgentSkillOption } from '../../../shared/agent-runtime';

interface KnowledgeResponse {
  files?: unknown;
  matches?: unknown;
  skills?: unknown;
  scannedFiles?: unknown;
  truncated?: unknown;
  workspacePath?: unknown;
  branch?: unknown;
  headSha?: unknown;
  message?: string;
}

function isMatch(value: unknown): value is AgentKnowledgeMatch {
  return !!value && typeof value === 'object'
    && typeof (value as AgentKnowledgeMatch).path === 'string'
    && Number.isInteger((value as AgentKnowledgeMatch).line)
    && typeof (value as AgentKnowledgeMatch).excerpt === 'string';
}

function isSkill(value: unknown): value is AgentSkillOption {
  return !!value && typeof value === 'object'
    && typeof (value as AgentSkillOption).invocation === 'string'
    && typeof (value as AgentSkillOption).name === 'string';
}

export function useAgentKnowledgeSearch(workspacePath: MaybeRefOrGetter<string>, provider: MaybeRefOrGetter<AgentProvider>) {
  const search = shallowRef('');
  const files = shallowRef<string[]>([]);
  const skills = shallowRef<AgentSkillOption[]>([]);
  const matches = shallowRef<AgentKnowledgeMatch[]>([]);
  const scannedFiles = shallowRef(0);
  const truncated = shallowRef(false);
  const loading = shallowRef(false);
  const error = shallowRef('');
  const scope = shallowRef<AgentKnowledgeScope>({ workspacePath: '', branch: '', headSha: '' });

  watch([() => toValue(workspacePath), () => toValue(provider), search], ([workspace, currentProvider, query], _previous, onCleanup) => {
    if (!workspace) { files.value = []; skills.value = []; matches.value = []; scannedFiles.value = 0; truncated.value = false;
      scope.value = { workspacePath: '', branch: '', headSha: '' }; error.value = ''; loading.value = false; return; }
    const controller = new AbortController();
    loading.value = true;
    const timer = setTimeout(async () => {
      loading.value = true;
      error.value = '';
      try {
        const params = new URLSearchParams({ workspacePath: workspace, provider: currentProvider, q: query.trim() });
        const response = await fetch(`/api/agent-runtimes/knowledge?${params}`, { signal: controller.signal });
        const data = await response.json() as KnowledgeResponse;
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(data.message || '知识来源读取失败');
        files.value = Array.isArray(data.files) ? data.files.filter((item): item is string => typeof item === 'string') : [];
        skills.value = Array.isArray(data.skills) ? data.skills.filter(isSkill) : [];
        matches.value = Array.isArray(data.matches) ? data.matches.filter(isMatch) : [];
        scannedFiles.value = typeof data.scannedFiles === 'number' ? data.scannedFiles : 0;
        truncated.value = data.truncated === true;
        scope.value = {
          workspacePath: typeof data.workspacePath === 'string' ? data.workspacePath : workspace,
          branch: typeof data.branch === 'string' ? data.branch : '',
          headSha: typeof data.headSha === 'string' ? data.headSha : '',
        };
      } catch (reason) {
        if (!controller.signal.aborted) {
          files.value = [];
          skills.value = [];
          matches.value = [];
          scannedFiles.value = 0;
          truncated.value = false;
          scope.value = { workspacePath: workspace, branch: '', headSha: '' };
          error.value = reason instanceof Error ? reason.message : String(reason);
        }
      } finally {
        if (!controller.signal.aborted) loading.value = false;
      }
    }, 160);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }, { immediate: true });

  const total = computed(() => files.value.length + skills.value.length + matches.value.length);
  return { search, files, skills, matches, scannedFiles, truncated, scope, total, loading, error };
}

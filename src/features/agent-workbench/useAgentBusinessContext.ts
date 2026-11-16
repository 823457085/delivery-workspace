/**
 * 设计说明：该 composable 复用工作台已有读模型，为 Agent 会话提供可追溯的业务投影。
 * 它不封装写操作；需要审核、合并或配置时仍回到原功能页执行。
 */
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import type { AutomationData, IssueResponse, ProjectsData } from '../../../shared/hub';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { integrationCatalog } from '../../../shared/integration-plugins';
import { useSource } from '../../shared/api';
import type { AgentConversation } from './conversation';
import { buildAgentBusinessContextCore, buildAgentBusinessMentions } from './agent-business-context-core';

export function useAgentBusinessContext(
  conversation: MaybeRefOrGetter<AgentConversation | undefined>,
  active: MaybeRefOrGetter<boolean> = true,
) {
  const integrations = useIntegrationPlugins();
  const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '500' }, false, {
    active, staleTime: 60_000, refetchInterval: 120_000, refetchOnWindowFocus: false,
  });
  const projects = useSource<ProjectsData>('projects', {}, false, { active });
  const automation = useSource<AutomationData>('automation', {}, false, {
    active, staleTime: 45_000, refetchInterval: 60_000, refetchOnWindowFocus: false,
  });
  const snapshot = computed(() => ({
    issues: issues.data.value?.issues,
    projects: projects.data.value,
    automation: automation.data.value,
    catchup: undefined,
    merge: undefined,
    pages: [],
    review: undefined,
  }));
  const context = computed(() => buildAgentBusinessContextCore(toValue(conversation), snapshot.value));
  const mentions = computed(() => buildAgentBusinessMentions(snapshot.value).filter(option => {
    const owner = integrationCatalog.find(plugin => plugin.businessTypes?.includes(option.type));
    return !owner || integrations.available(owner.id);
  }));
  const loading = computed(() => [issues, projects, automation].some(query => query.isPending.value));
  return { context, mentions, loading, projectsData: projects.data };
}

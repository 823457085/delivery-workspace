/**
 * 设计说明：该 composable 复用工作台已有读模型，为 Agent 会话提供可追溯的业务投影。
 * 它不封装写操作；需要审核、合并或配置时仍回到原功能页执行。
 */
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { AutomationData, IssueResponse, ProjectsData } from '../../../shared/hub';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { integrationCatalog } from '../../../shared/integration-plugins';
import { useSource } from '../../shared/api';
import { buildMenuPagePlans } from '../api-integration/page-plan';
import { useIntegrationCatalog } from '../api-integration/useIntegrationCatalog';
import type { AgentConversation } from './conversation';
import { buildAgentBusinessContext, buildAgentBusinessMentions } from './agent-business-context';

export function useAgentBusinessContext(conversation: MaybeRefOrGetter<AgentConversation | undefined>) {
  const integrations = useIntegrationPlugins();
  const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '500' });
  const projects = useSource<ProjectsData>('projects');
  const automation = useSource<AutomationData>('automation');
  const { query: catalogQuery, catalog } = useIntegrationCatalog();
  const pages = computed(() => buildMenuPagePlans(catalogQuery.data.value?.plan.stages || []));
  const review = useQuery({ queryKey: ['apex-bff-review'], enabled: computed(() => pages.value.length > 0), retry: false,
    queryFn: async ({ signal }): Promise<ApexBffReviewState> => {
      const response = await fetch('/api/apex-bff-review', { signal });
      if (!response.ok) throw new Error('读取接口审核记录失败');
      return response.json();
    } });
  const snapshot = computed(() => ({
    issues: issues.data.value?.issues,
    projects: projects.data.value,
    automation: automation.data.value,
    catchup: undefined,
    merge: undefined,
    pages: pages.value,
    review: review.data.value,
    catalog: catalog.value,
    refactorRepository: catalogQuery.data.value?.refactorRepository,
  }));
  const context = computed(() => buildAgentBusinessContext(toValue(conversation), snapshot.value));
  const mentions = computed(() => buildAgentBusinessMentions(snapshot.value).filter(option => {
    const owner = integrationCatalog.find(plugin => plugin.businessTypes?.includes(option.type));
    return !owner || integrations.available(owner.id);
  }));
  const loading = computed(() => [issues, projects, automation, catalogQuery].some(query => query.isPending.value) || review.isLoading.value);
  return { context, mentions, loading, projectsData: projects.data };
}

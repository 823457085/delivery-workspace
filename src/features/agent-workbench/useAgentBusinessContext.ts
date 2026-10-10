/**
 * 设计说明：该 composable 复用工作台已有读模型，为 Agent 会话提供可追溯的业务投影。
 * 它不封装写操作；需要审核、合并或配置时仍回到原功能页执行。
 */
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useIntegrationCatalog } from '../api-integration/useIntegrationCatalog';
import { buildReviewCatalog } from '../api-integration/review-catalog';
import type { ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { AutomationData, CatchupData, IssueResponse, MergeData, ProjectsData } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { buildMenuPagePlans } from '../api-integration/page-plan';
import type { AgentConversation } from './conversation';
import { buildAgentBusinessContext, buildAgentBusinessMentions } from './agent-business-context';

export function useAgentBusinessContext(conversation: MaybeRefOrGetter<AgentConversation | undefined>) {
  const { query: catalog } = useIntegrationCatalog();
  const pages = computed(() => buildMenuPagePlans(catalog.data.value?.plan.stages || []));
  const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '500' });
  const projects = useSource<ProjectsData>('projects');
  const automation = useSource<AutomationData>('automation');
  const catchup = useSource<CatchupData>('catchup');
  const merge = useSource<MergeData>('merge');
  const review = useQuery({ queryKey: ['apex-bff-review'], queryFn: async ({ signal }): Promise<ApexBffReviewState> => {
    const response = await fetch('/api/apex-bff-review', { signal });
    if (!response.ok) throw new Error('读取接口审核记录失败');
    return response.json();
  }, retry: false });
  const snapshot = computed(() => ({ issues: issues.data.value?.issues, projects: projects.data.value, automation: automation.data.value,
    catchup: catchup.data.value, merge: merge.data.value, pages: pages.value, review: review.data.value,
    catalog: catalog.data.value ? buildReviewCatalog(catalog.data.value) : [], refactorRepository: catalog.data.value?.refactorRepository }));
  const context = computed(() => buildAgentBusinessContext(toValue(conversation), snapshot.value));
  const mentions = computed(() => buildAgentBusinessMentions(snapshot.value));
  const loading = computed(() => [issues, projects, automation, catchup, merge, review, catalog].some(query => query.isPending.value));
  return { context, mentions, loading };
}

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { AutomationData, IssueResponse } from '../../../shared/hub';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { useIntegrationPlugins } from '../../plugins/runtime';
import { useSource } from '../../shared/api';
import { useDesignExecutor } from '../tech-design-delivery/useDesignExecutor';
import { deliveryRecords, deliveryRecordState, launchDeliveryRecords, reconcileDeliveryRecords, workbenchDismissalKey } from './domain';
import { readLaunchRecords } from './launch-records';
import { deliveryAcceptanceQueryKey, readDeliveryAcceptances } from './acceptance-api';

export function useWorkbench(options: { applyDismissals?: boolean } = {}) {
  const integrations = useIntegrationPlugins();
  const automation = useSource<AutomationData>('automation', {}, true);
  const design = useDesignExecutor().query;
  const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '5000' }, true);
  const runtime = useAgentRuntimeSnapshot();
  const requirements = useQuery({ queryKey: ['requirement-development'], retry: false,
    queryFn: ({ signal }) => readLaunchRecords('requirement-development', signal), refetchInterval: 15_000 });
  const fixes = useQuery({ queryKey: ['jira-fix'], retry: false,
    queryFn: ({ signal }) => readLaunchRecords('jira-fix', signal), refetchInterval: 15_000 });
  const acceptance = useQuery({ queryKey: deliveryAcceptanceQueryKey, retry: false,
    queryFn: ({ signal }) => readDeliveryAcceptances(signal), refetchInterval: 15_000 });
  const dismissals = useQuery({
    queryKey: ['workbench-dismissals'],
    enabled: !!options.applyDismissals,
    retry: false,
    queryFn: async ({ signal }): Promise<string[]> => {
      const response = await fetch('/api/workspace/workbench-dismissals', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '读取清理记录失败');
      return data.keys;
    },
  });
  const sources = [{ name: '自动交付', query: automation }, { name: '技术方案', query: design },
    { name: '需求开发', query: requirements }, { name: 'Jira 修复', query: fixes }, { name: 'Agent 运行状态', query: runtime }, { name: '交付验收', query: acceptance }];
  const observedSources = options.applyDismissals ? [...sources, { name: '工作台清理记录', query: dismissals }] : sources;
  const allRecords = computed(() => reconcileDeliveryRecords([
    ...deliveryRecords(automation.data.value, design.data.value, undefined, undefined),
    ...launchDeliveryRecords(requirements.data.value, fixes.data.value, { requirements: !requirements.error.value, fixes: !fixes.error.value }),
  ], !issues.error.value && issues.data.value?.source !== 'mock' ? issues.data.value?.issues || [] : [], runtime.data.value?.runs || [],
  { includeStandalone: true, runtimeKnown: !!runtime.data.value && !runtime.error.value, workflows: runtime.data.value?.workflows,
    acceptances: acceptance.data.value, acceptanceKnown: !!acceptance.data.value && !acceptance.error.value }));
  return {
    records: computed(() => {
      if (!options.applyDismissals) return allRecords.value;
      if (dismissals.isPending.value) return [];
      const cleared = new Set(dismissals.data.value);
      return allRecords.value.filter(record => deliveryRecordState(record) !== 'blocked' || !cleared.has(workbenchDismissalKey(record)));
    }),
    runtime, issues, automation,
    errors: computed(() => observedSources.filter(source => source.query.error.value).map(source => `${source.name}：${source.query.error.value?.message}`)),
    loading: computed(() => observedSources.some(source => source.query.isPending.value)),
    fetching: computed(() => observedSources.some(source => source.query.isFetching.value)),
    incomplete: computed(() => integrations.capability('issues.read') && (!issues.data.value || !!issues.error.value || issues.data.value.source === 'mock') || observedSources.some(source => !source.query.data.value || source.query.error.value)),
    refresh: () => Promise.all([...observedSources.map(source => source.query.refetch()), issues.refetch()]),
  };
}

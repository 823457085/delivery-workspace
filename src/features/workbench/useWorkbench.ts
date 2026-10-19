import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { AutomationData, CatchupData, MergeData, IssueResponse } from '../../../shared/hub';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { useSource } from '../../shared/api';
import { useDesignExecutor } from '../tech-design-delivery/useDesignExecutor';
import { deliveryRecords, launchDeliveryRecords, reconcileDeliveryRecords } from './domain';
import { readLaunchRecords } from './launch-records';
import { deliveryAcceptanceQueryKey, readDeliveryAcceptances } from './acceptance-api';

export function useWorkbench() {
  const automation = useSource<AutomationData>('automation', {}, true);
  const design = useDesignExecutor().query;
  const catchup = useSource<CatchupData>('catchup', {}, true);
  const merge = useSource<MergeData>('merge', {}, true);
  const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '5000' }, true);
  const runtime = useAgentRuntimeSnapshot();
  const requirements = useQuery({ queryKey: ['requirement-development'], retry: false,
    queryFn: ({ signal }) => readLaunchRecords('requirement-development', signal), refetchInterval: 15_000 });
  const fixes = useQuery({ queryKey: ['jira-fix'], retry: false,
    queryFn: ({ signal }) => readLaunchRecords('jira-fix', signal), refetchInterval: 15_000 });
  const acceptance = useQuery({ queryKey: deliveryAcceptanceQueryKey, retry: false,
    queryFn: ({ signal }) => readDeliveryAcceptances(signal), refetchInterval: 15_000 });
  const sources = [{ name: '自动交付', query: automation }, { name: '技术方案', query: design }, { name: '追平执行', query: catchup }, { name: '合入审核', query: merge },
    { name: '需求开发', query: requirements }, { name: 'Jira 修复', query: fixes }, { name: 'Agent 运行状态', query: runtime }, { name: '交付验收', query: acceptance }];
  return {
    records: computed(() => reconcileDeliveryRecords([
      ...deliveryRecords(automation.data.value, design.data.value, catchup.data.value, merge.data.value),
      ...launchDeliveryRecords(requirements.data.value, fixes.data.value, { requirements: !requirements.error.value, fixes: !fixes.error.value }),
    ], !issues.error.value && issues.data.value?.source !== 'mock' ? issues.data.value?.issues || [] : [], runtime.data.value?.runs || [],
    { includeStandalone: true, runtimeKnown: !!runtime.data.value && !runtime.error.value,
      acceptances: acceptance.data.value, acceptanceKnown: !!acceptance.data.value && !acceptance.error.value })),
    runtime, issues, automation,
    errors: computed(() => sources.filter(source => source.query.error.value).map(source => `${source.name}：${source.query.error.value?.message}`)),
    loading: computed(() => sources.some(source => source.query.isPending.value)),
    fetching: computed(() => sources.some(source => source.query.isFetching.value)),
    incomplete: computed(() => !issues.data.value || !!issues.error.value || issues.data.value.source === 'mock' || sources.some(source => !source.query.data.value || source.query.error.value)),
    refresh: () => Promise.all([...sources.map(source => source.query.refetch()), issues.refetch()]),
  };
}

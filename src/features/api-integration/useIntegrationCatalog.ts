import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { IntegrationCatalog } from '../../../shared/integration-catalog';
import { buildReviewCatalog } from './review-catalog';

export async function readIntegrationCatalog(signal?: AbortSignal): Promise<IntegrationCatalog> {
  const response = await fetch('/api/integration-catalog', { signal, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '读取接口清单失败');
  return data;
}
export function useIntegrationCatalog() {
  const query = useQuery({ queryKey: ['integration-catalog'], queryFn: ({ signal }) => readIntegrationCatalog(signal), retry: false });
  const catalog = computed(() => query.data.value ? buildReviewCatalog(query.data.value) : []);
  return { query, catalog };
}

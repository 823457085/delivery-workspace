import { defineAsyncComponent } from 'vue';
import { confluenceRequest } from '../../src/features/agent-workbench/useConfluenceKnowledge';
import type { ConfluencePage } from '../../shared/confluence-knowledge';
export default { components: { knowledge: defineAsyncComponent(() => import('../../src/features/agent-workbench/AgentConfluencePanel.vue')) },
 async mentions(workspacePath: string, query: string, signal: AbortSignal) {
  const result = await confluenceRequest<{pages: ConfluencePage[]}>(`search?${new URLSearchParams({workspacePath, q: query})}`, undefined, signal);
  return result.pages.map(page => ({ id: page.reference, kind: 'confluence', label: page.title, detail: `${page.spaceKey} · v${page.version}`, value: page.reference }));
 } };

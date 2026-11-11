import { createJiraIssueService, createJiraIssueRoute } from '../../server/jira-issue.js';
import type { IntegrationHost, IntegrationExtension } from '../../server/plugins/integration-runtime.js';
export function createExtension(host: IntegrationHost): IntegrationExtension {
 const route = createJiraIssueRoute(createJiraIssueService(host.source.jiraIssueRequest));
 return {id: 'jira', contentTypes: ['application/json', 'multipart/form-data'], matches: url => url.pathname.startsWith('/api/jira/issues/'),
  async route(request, response) { await route(request, response, host.port); return true; }, async close() {},
 };
}

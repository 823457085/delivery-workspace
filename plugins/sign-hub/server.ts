import { signHubSession } from '../../server/sign-hub-session.js';
import type { IntegrationExtension, IntegrationHost } from '../../server/plugins/integration-runtime.js';

export function createExtension(host: IntegrationHost): IntegrationExtension {
  return {
    id: 'sign-hub',
    matches: url => url.pathname === '/api/sign-hub/session',
    async route(request, response) {
      await signHubSession(request, response, host.root ?? process.cwd(), host.port);
      return true;
    },
    async close() {},
  };
}

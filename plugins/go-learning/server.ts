import path from 'node:path';
import { createGoLearningService } from '../../server/go-learning.js';
import { createGoLearningRoutes } from '../../server/go-learning-routes.js';
import type { IntegrationExtension, IntegrationHost } from '../../server/plugins/integration-runtime.js';

export function createExtension(host: IntegrationHost): IntegrationExtension {
  let routes: Promise<ReturnType<typeof createGoLearningRoutes>> | undefined;
  return {
    id: 'go-learning',
    matches: url => url.pathname.startsWith('/api/go-learning/'),
    async route(request, response, url) {
      routes ??= createGoLearningService(path.join(host.directory, 'go-learning'), { rootDir: host.root ?? process.cwd() })
        .then(service => createGoLearningRoutes(service, host))
        .catch(error => { routes = undefined; throw error; });
      return (await routes)(request, response, url);
    },
    async close() {},
  };
}

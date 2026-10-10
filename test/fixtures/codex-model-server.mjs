import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (scenario === 'timeout') return;
  if (method === 'initialize') return reply(scenario === 'error' ? { id, error: { message: 'private diagnostic' } } : { id, result: {} });
  if (method === 'initialized') return;
  if (method === 'config/read') {
    if (params.includeLayers !== false) throw new Error('Config layers requested');
    return reply(scenario === 'config-error' ? { id, error: { message: 'private diagnostic' } }
      : { id, result: { config: { model: 'first-model', service_tier: 'priority', private_config: 'never-expose' } } });
  }
  if (method !== 'model/list') throw new Error('Only model discovery is allowed');
  if (params.includeHidden !== false) throw new Error('Hidden models requested');
  const cursor = params.cursor;
  const data = cursor ? [{ model: 'new-model', displayName: 'New model', isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] }] : [{ model: 'first-model' }];
  reply({ id, result: { data, nextCursor: scenario === 'loop' || !cursor ? 'next-page' : null } });
});

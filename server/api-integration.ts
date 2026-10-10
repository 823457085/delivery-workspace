/** 本地计划管理只保存人工记录；串行合并并原子写文件，避免并发保存不同接口时丢记录，不触发执行器。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadIntegrationCatalog } from './integration-catalog.js';
import { bffIntegrationStatuses, integrationStatuses, type IntegrationState } from '../shared/api-integration.js';

const stage = z.object({ owner: z.string().max(200), startDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/), endDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/), notes: z.string().max(20000) }).strict();
const operation = z.object({ bffStatus: z.enum(bffIntegrationStatuses).optional().default('待接入'), status: z.enum(integrationStatuses), notes: z.string().max(20000), evidence: z.string().max(20000) }).strict();
const updateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), id: z.string(), record: stage }).strict(),
  z.object({ kind: z.literal('operation'), id: z.string(), record: operation }).strict(),
]);
const stateSchema = z.object({ stages: z.record(z.string(), stage.extend({ updatedAt: z.string() })), operations: z.record(z.string(), operation.extend({ updatedAt: z.string() })) });

export async function createIntegrationStore(directory: string) {
  const catalog = await loadIntegrationCatalog();
  const { plan } = catalog;
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'api-integration.json');
  let state: IntegrationState = { stages: {}, operations: {} };
  try { state = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stageIds = new Set(plan.stages.map(s => s.id));
  const operationIds = new Set(plan.stages.flatMap(s => s.operations.map(o => o.operationId)));
  let writes = Promise.resolve();
  function update(input: unknown) {
    const task = writes.then(async () => {
      const data = updateSchema.parse(input);
      if (!(data.kind === 'stage' ? stageIds : operationIds).has(data.id)) throw new Error('找不到该联调计划记录');
      const next = structuredClone(state);
      const updatedAt = new Date().toISOString();
      if (data.kind === 'stage') next.stages[data.id] = { ...data.record, updatedAt };
      else next.operations[data.id] = { ...data.record, updatedAt };
      await fs.writeFile(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
      state = next;
      return structuredClone(state);
    });
    writes = task.then(() => {}, () => {});
    return task;
  }
  return { catalog, snapshot: () => structuredClone(state), update, close: () => writes };
}

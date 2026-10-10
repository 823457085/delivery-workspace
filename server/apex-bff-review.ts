/** 本机台账保存审核及 Jira 人员分工，不写回 Jira；分配独立于审核，避免改负责人时丢失证据和确认。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadIntegrationCatalog } from './integration-catalog.js';
import { reviewStatuses, type ApexBffReviewState } from '../shared/apex-bff-review.js';

const assigneeSchema = z.object({ name: z.string().trim().min(1).max(200), displayName: z.string().min(1).max(200).refine(value => !!value.trim()) }).strict();
const recordSchema = z.object({ status: z.enum(reviewStatuses).optional(), assignee: assigneeSchema.optional(), evidence: z.string().max(20000), blocker: z.string().max(20000), confirmedAt: z.string(), updatedAt: z.string() }).strict();
const stateSchema = z.record(z.string(), recordSchema);
const updateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), id: z.string(), status: z.enum(reviewStatuses) }).strict(),
  z.object({ action: z.literal('save'), id: z.string(), evidence: z.string().max(20000), blocker: z.string().max(20000) }).strict(),
  z.object({ action: z.literal('confirm'), id: z.string() }).strict(),
  z.object({ action: z.literal('reopen'), id: z.string() }).strict(),
  z.object({ action: z.literal('assign'), ids: z.array(z.string()).min(1).max(400), assignee: assigneeSchema.nullable() }).strict(),
]);

export async function createApexBffReviewStore(directory: string) {
  const catalog = await loadIntegrationCatalog();
  const { inventory, plan } = catalog;
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'apex-bff-review.json');
  const workbookPaths = new Set(inventory.items.map(item => item.path));
  const ids = new Set([
    ...inventory.items.map(item => item.id),
    ...plan.stages.flatMap(stage => stage.operations.filter(operation => !workbookPaths.has(operation.path)).map(operation => `plan:${operation.operationId}`)),
  ]);
  let state: ApexBffReviewState = {};
  try { state = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  function update(input: unknown) {
    const task = writes.then(async () => {
      const data = updateSchema.parse(input);
      const targetIds = data.action === 'assign' ? [...new Set(data.ids)] : [data.id];
      if (targetIds.some(id => !ids.has(id))) throw new Error('接口不在 APEX 联调清单中');
      const next = structuredClone(state);
      const updatedAt = new Date().toISOString();
      if (data.action === 'assign') {
        for (const id of targetIds) {
          const current = next[id];
          next[id] = { ...current, evidence: current?.evidence ?? '', blocker: current?.blocker ?? '', confirmedAt: current?.confirmedAt ?? '', updatedAt };
          if (data.assignee) next[id].assignee = data.assignee;
          else delete next[id].assignee;
        }
      } else {
        const current = next[data.id];
        if (data.action === 'status') {
          next[data.id] = { ...current, evidence: current?.evidence ?? '', blocker: current?.blocker ?? '', status: data.status, confirmedAt: data.status === '已联调' ? current?.confirmedAt || updatedAt : '', updatedAt };
        } else if (data.action === 'save') {
          const evidence = data.evidence.trim();
          const blocker = data.blocker.trim();
          const unchanged = current?.evidence === evidence && current?.blocker === blocker;
          const status = current?.status === '已替代' || current?.status === '不再使用' || unchanged ? current?.status : undefined;
          next[data.id] = { ...current, status, evidence, blocker, confirmedAt: unchanged ? current.confirmedAt : '', updatedAt };
        } else if (data.action === 'confirm') {
          next[data.id] = { ...current, status: '已联调', evidence: current?.evidence ?? '', blocker: current?.blocker ?? '', confirmedAt: updatedAt, updatedAt };
        } else if (current) {
          next[data.id] = { ...current, status: '待人工审核', confirmedAt: '', updatedAt };
        }
      }
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryAcceptanceInputSchema, deliveryAcceptanceRecordSchema, sameDeliverySource,
  type DeliveryAcceptanceRecord, type ResolvedDeliveryAcceptanceSource } from '../shared/delivery-acceptance.js';

export type DeliveryAcceptanceSourceResolver = (recordId: string) => ResolvedDeliveryAcceptanceSource | undefined
  | Promise<ResolvedDeliveryAcceptanceSource | undefined>;
const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** 只记录本机人工验收，不执行测试、Git、部署或任何外部写入。 */
export async function createDeliveryAcceptanceStore(directory: string, resolveSource: DeliveryAcceptanceSourceResolver,
  options: { writeJson?: (relative: string, value: unknown) => Promise<void> } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const records = new Map<string, DeliveryAcceptanceRecord>();
  const filename = (id: string) => `${createHash('sha256').update(id).digest('hex')}.json`;
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = deliveryAcceptanceRecordSchema.parse(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')));
    if (name !== filename(record.recordId)) throw new Error('验收记录与文件标识不匹配，请核对本机数据');
    records.set(record.recordId, record);
  }
  let writing: Promise<unknown> = Promise.resolve();
  async function save(raw: unknown) {
    const input = deliveryAcceptanceInputSchema.parse(raw);
    const update = writing.then(async () => {
      const current = records.get(input.recordId);
      if ((current?.revision || 0) !== input.expectedRevision) throw failure('验收记录已更新，请重新读取后再保存', 409);
      const source = await resolveSource(input.recordId);
      if (!source) throw failure('交付记录不存在，不能保存验收', 404);
      if (!sameDeliverySource(input.source, source)) throw failure('交付记录或运行已变化，请刷新并重新核对证据', 409);
      if (input.decision === 'accepted' && source.active) throw failure('任务仍在执行或排队，不能确认验收通过', 409);
      const record: DeliveryAcceptanceRecord = {
        recordId: input.recordId, source: { runId: source.runId, updatedAt: source.updatedAt }, checks: input.checks,
        decision: input.decision, summary: input.summary, revision: (current?.revision || 0) + 1, updatedAt: new Date().toISOString(),
      };
      if (options.writeJson) await options.writeJson(`delivery-acceptance/${filename(record.recordId)}`, record);
      else {
        const file = path.join(directory, filename(record.recordId));
        await fs.writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await fs.rename(`${file}.tmp`, file);
      }
      records.set(record.recordId, record);
      return structuredClone(record);
    });
    writing = update.catch(() => undefined);
    return update;
  }
  return { save, close: () => writing, list: () => structuredClone([...records.values()]), get: (id: string) => {
    const record = records.get(id); return record ? structuredClone(record) : undefined;
  } };
}

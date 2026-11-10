/** Durable per-run receipts. Unknown outcomes are never replayed automatically. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function privateRunFile(directory: string, runId: string) {
  return path.join(directory, `${createHash('sha256').update(runId).digest('hex')}.json`);
}
export async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
interface Receipt { digest: string; name: string; state: 'running' | 'completed' | 'unknown'; result?: unknown }
export async function createToolJournal(directory: string, runId: string) {
  const file = privateRunFile(directory, runId);
  let receipts: Record<string, Receipt> = Object.create(null);
  try { receipts = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机工具账本不可读，禁止重放'); }
  return {
    async execute(callId: string, name: string, args: unknown, execute: () => Promise<unknown>) {
      const digest = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
      const previous = Object.hasOwn(receipts, callId) ? receipts[callId] : undefined;
      if (previous) {
        if (previous.digest !== digest) throw new Error('工具调用 ID 被重复用于不同操作');
        if (previous.state !== 'completed') throw new Error('工具结果未知，请核对工作区后开启新轮次；未自动重放');
        return previous.result;
      }
      Object.defineProperty(receipts, callId, { configurable: true, enumerable: true, writable: true, value: { digest, name, state: 'running' } });
      await writePrivateJson(file, receipts);
      try {
        const result = await execute();
        receipts[callId] = { digest, name, state: 'completed', result };
        await writePrivateJson(file, receipts);
        return result;
      } catch (error) {
        receipts[callId] = { digest, name, state: 'unknown' };
        await writePrivateJson(file, receipts);
        throw error;
      }
    },
  };
}

/** 清理记录保持原值；用户授权重启后，只允许凭本轮新证据重新登记，防止复制旧问题。 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function assertIssueNotCleared(root: string, id: unknown, report?: unknown) {
  let policy: { issueIds: string[]; recheck?: { startedAt: string; requestIds: string[] } };
  try { policy = JSON.parse(await fs.readFile(path.join(path.resolve(root, process.env.DELIVERY_DATA_DIR || '.data'), 'integration-cleared-issues.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (typeof id !== 'string' || !policy.issueIds.includes(id)) return;
  const recheck = policy.recheck;
  if (recheck && Number.isFinite(Date.parse(recheck.startedAt)) && Array.isArray(recheck.requestIds)
    && typeof report === 'string' && /^\/integration-runs\/[a-zA-Z0-9._/-]+\.html$/.test(report) && !report.includes('..')) {
    try {
      const directory = await fs.realpath(path.join(root, 'public/integration-runs'));
      const evidence = await fs.realpath(path.join(root, 'public', report));
      const stat = await fs.stat(evidence);
      if (evidence.startsWith(directory + path.sep) && stat.isFile() && stat.mtimeMs >= Date.parse(recheck.startedAt)) {
        const content = await fs.readFile(evidence, 'utf8');
        if (content.includes(id) && recheck.requestIds.some(requestId => /^[a-f0-9-]{36}$/.test(requestId) && content.includes(requestId))) return;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('该问题已由用户清理，不能从旧报告恢复；重新登记需要本轮授权及新实测报告');
}

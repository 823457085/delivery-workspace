/** 从内嵌交付后端读取快照，供 Mastra 流程使用；不通过另一个本机 HTTP 服务取数。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Requirement, SourceSnapshot } from '../shared/types.js';

const rawItem = z.object({
  requirementId: z.string(), title: z.string(), jiraKey: z.string(),
  jiraUrl: z.string().default(''), sourceBranch: z.string().default(''),
  sourceRemoteSha: z.string().default(''), status: z.string(),
  verificationMode: z.string().default('browser'), conflictArea: z.string().default(''),
  acceptanceCriteria: z.array(z.object({ id: z.string().default(''), text: z.string().default('') })).default([]),
  pipeline: z.object({ result: z.string().default(''), error: z.string().default('') }).default({ result: '', error: '' }),
  reviewGate: z.object({
    passed: z.boolean().default(false), passedTestCaseIds: z.array(z.string()).default([]),
    skippedTestCaseIds: z.array(z.string()).default([]), failedTestCaseIds: z.array(z.string()).default([]),
    missingTestCaseIds: z.array(z.string()).default([]), screenshotCount: z.number().default(0),
  }),
});

export const sourceSchema = z.object({
  revision: z.number(), target: z.object({ branch: z.string(), remoteSha: z.string() }), items: z.array(rawItem),
});

export function normalizeSource(value: unknown): SourceSnapshot {
  const data = sourceSchema.parse(value);
  return {
    fetchedAt: new Date().toISOString(), revision: data.revision, origin: 'live',
    targetBranch: data.target.branch, message: '已读取原看板快照，新实验独立运行。',
    requirements: data.items.map((item): Requirement => ({
      id: item.requirementId, title: item.title, jiraKey: item.jiraKey, issueUrl: item.jiraUrl,
      sourceBranch: item.sourceBranch, sourceSha: item.sourceRemoteSha, targetSha: data.target.remoteSha,
      sourceStatus: item.status, verificationMode: item.verificationMode, conflictArea: item.conflictArea,
      summary: item.pipeline.result, error: item.pipeline.error, criteria: item.acceptanceCriteria,
      evidence: {
        passed: item.reviewGate.passedTestCaseIds.length, skipped: item.reviewGate.skippedTestCaseIds.length,
        failed: item.reviewGate.failedTestCaseIds.length, missing: item.reviewGate.missingTestCaseIds.length,
        screenshots: item.reviewGate.screenshotCount, gatePassed: item.reviewGate.passed,
      },
    })),
  };
}

export async function readSource(dataDirectory: string, readCurrent: () => Promise<unknown>): Promise<SourceSnapshot> {
  const file = path.join(dataDirectory, 'source-snapshot.json');
  try {
    const source = normalizeSource(await readCurrent());
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(source, null, 2));
    await fs.rename(`${file}.tmp`, file);
    return source;
  } catch (error) {
    try {
      const saved: SourceSnapshot = JSON.parse(await fs.readFile(file, 'utf8'));
      return { ...saved, origin: 'cache', message: '原看板暂不可用，显示上次成功读取的快照。' };
    } catch {
      return {
        fetchedAt: new Date().toISOString(),
        revision: 0,
        origin: 'sample',
        targetBranch: '',
        requirements: [],
        message: `交付数据暂不可用，且还没有缓存快照：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

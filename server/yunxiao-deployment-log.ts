/** 云效日志接口返回完整 content；官方未定义请求游标，因此按脱敏后的 UTF-8 字节位置在本机截取增量。
 * https://help.aliyun.com/zh/yunxiao/developer-reference/getpipelinejobrunlog
 */
import type { DeploymentLog } from '../shared/deployments.js';

export async function readYunxiaoDeploymentLog(options: {
  run: { pipelineRunId?: string; steps?: readonly { jobId?: string }[] };
  jobId: string;
  start: number;
  request(suffix: string): Promise<unknown>;
  redact(text: string): string;
}): Promise<DeploymentLog> {
  const { run, jobId, start, request, redact } = options;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('日志偏移必须为非负整数');
  if (!/^[1-9]\d*$/.test(run.pipelineRunId || '') || !/^[1-9]\d*$/.test(jobId)) throw new Error('云效运行或日志任务编号不正确');
  if (!run.steps?.some(step => step.jobId === jobId)) throw new Error('日志任务不属于本次云效部署');
  let value: unknown;
  try { value = await request(`/runs/${run.pipelineRunId}/job/${jobId}/log`); }
  catch (error) { throw new Error(redact(error instanceof Error ? error.message : '云效日志读取失败')); }
  const log = value as { content?: unknown; last?: unknown; more?: unknown } | null;
  if (!log || typeof log.content !== 'string' || !Number.isSafeInteger(log.last) || typeof log.more !== 'boolean') {
    throw new Error('云效未返回有效的任务日志');
  }
  // 先对完整内容脱敏，再切增量，避免 start 恰好落在凭据中间时绕过脱敏。
  const bytes = Buffer.from(redact(log.content), 'utf8');
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('云效任务日志超过 2 MB，偏移未推进');
  if (start > bytes.byteLength) throw new Error('云效日志内容已变化，请重新打开日志从头读取');
  if (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) throw new Error('云效日志偏移不在有效的文字边界');
  return { text: bytes.subarray(start).toString('utf8'), nextOffset: bytes.byteLength, moreData: log.more };
}

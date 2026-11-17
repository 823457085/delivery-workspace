import type http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { jiraAttachmentMediaType } from '../shared/jira-attachment-media.js';

export const maxJiraAttachmentBytes = 256 * 1024 * 1024;
export type JiraAttachmentReadOptions = { range?: string; signal?: AbortSignal };
export function jiraAttachmentRange(value: string | undefined): string | undefined {
  if (value === undefined) return;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  const start = match?.[1], end = match?.[2];
  if (!match || (!start && !end) || [start, end].some(v => v && !Number.isSafeInteger(Number(v)))
    || (start && end && Number(end) < Number(start)) || (!start && Number(end) === 0)) {
    throw Object.assign(new Error('附件仅支持有效的单段字节范围'), { statusCode: 416 });
  }
  return value;
}
export async function streamJiraAttachment(response: http.ServerResponse, file: { response: Response; filename: string; mimeType: string }, inline: boolean) {
  const upstream = file.response;
  const mediaType = inline ? jiraAttachmentMediaType(file) : undefined;
  if (inline && !mediaType) { await upstream.body?.cancel(); throw Object.assign(new Error('此附件类型不支持预览，请下载查看'), { statusCode: 415 }); }
  const contentRange = upstream.headers.get('content-range');
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    response.writeHead(416, { 'Cache-Control': 'no-store', ...(contentRange && /^bytes \*\/\d+$/.test(contentRange) ? { 'Content-Range': contentRange } : {}) });
    response.end(); return;
  }
  if (![200, 206].includes(upstream.status) || !upstream.body) {
    await upstream.body?.cancel(); throw Object.assign(new Error('读取 Jira 附件失败'), { statusCode: 502 });
  }
  if (upstream.status === 206 && (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange))) {
    await upstream.body.cancel(); throw Object.assign(new Error('Jira 附件分段响应无效'), { statusCode: 502 });
  }
  const length = upstream.headers.get('content-length');
  if (length && Number(length) > maxJiraAttachmentBytes) {
    await upstream.body.cancel(); throw Object.assign(new Error('附件超过 256 MB 本地读取限制'), { statusCode: 413 });
  }
  response.writeHead(upstream.status, {
    'Content-Type': mediaType || 'application/octet-stream',
    'Content-Disposition': `${mediaType ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...(length && /^\d+$/.test(length) ? { 'Content-Length': length } : {}),
    ...(upstream.status === 206 ? { 'Content-Range': contentRange!, 'Accept-Ranges': 'bytes' } :
      upstream.headers.get('accept-ranges') === 'bytes' ? { 'Accept-Ranges': 'bytes' } : {}),
  });
  let size = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > maxJiraAttachmentBytes ? new Error('附件超过 256 MB 本地读取限制') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), limit, response);
}

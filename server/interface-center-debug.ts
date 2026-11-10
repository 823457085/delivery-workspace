/** 只有调试路由收到用户发送动作后才执行；不保存请求、鉴权或响应。 */
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { ApiOperationDetail } from '../shared/interface-center.js';
import { apiDebugLimits, prepareApiDebugRequest, type ApiDebugResult } from '../shared/interface-center-debug.js';

type RequestPhase = 'connect' | 'tls' | 'headers' | 'body';

function requestError(error: unknown, phase: RequestPhase) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.code) ? error.code : '';
  // 原始网络异常可能携带带凭据的查询参数或请求头，不能放进日志/错误响应。
  const message = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? '无法解析目标服务域名'
    : code === 'ECONNREFUSED' ? '目标服务拒绝连接'
    : phase === 'tls' && code === 'ECONNRESET' ? '目标连接在 TLS 握手阶段被重置'
    : phase === 'tls' ? '与目标服务的 TLS 握手失败'
    : phase === 'body' ? '目标服务在响应读取完成前断开连接'
    : phase === 'headers' ? '连接在收到目标服务的 HTTP 响应前中断'
    : '无法连接目标服务';
  return new Error(code ? `${message}（${code}）` : message);
}
function cancelled() { const error = new Error('请求已取消'); error.name = 'AbortError'; return error; }

export async function executeApiDebug(detail: ApiOperationDetail, input: unknown, signal?: AbortSignal): Promise<ApiDebugResult> {
  const prepared = prepareApiDebugRequest(detail, input);
  if (signal?.aborted) throw cancelled();
  const target = new URL(prepared.url), transport = target.protocol === 'https:' ? https : http;
  const headers = Object.fromEntries(prepared.headers.map(item => [item.name, item.value]));
  headers['Accept-Encoding'] = 'identity';
  if (prepared.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(prepared.body, 'utf8'));
  const started = performance.now();
  return new Promise<ApiDebugResult>((resolve, reject) => {
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
    let phase: RequestPhase = 'connect';
    const chunks: Buffer[] = []; let sizeBytes = 0;
    const timer = setTimeout(() => fail(new Error(`请求超时（${prepared.timeoutMs} 毫秒）`)), prepared.timeoutMs);
    const abort = () => fail(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    function fail(error: Error) {
      if (settled) return;
      settled = true; cleanup(); response?.destroy(); request?.destroy(); reject(error);
    }
    function finish(truncated: boolean) {
      if (settled || !response) return;
      const bytes = Buffer.concat(chunks, sizeBytes);
      const contentType = String(response.headers['content-type'] || ''), contentEncoding = String(response.headers['content-encoding'] || 'identity');
      let bodyEncoding: ApiDebugResult['bodyEncoding'] = 'base64', body = bytes.toString('base64');
      if ((!contentType || /^(?:text\/)|(?:json|xml|javascript|x-www-form-urlencoded)/i.test(contentType)) && contentEncoding.toLowerCase() === 'identity') {
        try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated }); bodyEncoding = 'utf8'; }
        catch { /* 非 UTF-8 原始字节以 Base64 提供，避免伪造响应文本。 */ }
      }
      const responseHeaders = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.push({ name: response.rawHeaders[index]!, value: response.rawHeaders[index + 1]! });
      settled = true; cleanup();
      resolve({ method: prepared.method, url: prepared.url, status: response.statusCode || 0, statusText: response.statusMessage || '',
        headers: responseHeaders, body, bodyEncoding, sizeBytes, truncated, durationMs: Math.max(0, Math.round(performance.now() - started)) });
      if (truncated) { response.destroy(); request?.destroy(); }
    }
    try {
      request = transport.request(target, { method: prepared.method, headers, maxHeaderSize: apiDebugLimits.headerBytes,
        agent: false, rejectUnauthorized: true }, incoming => {
        phase = 'body';
        response = incoming;
        incoming.on('data', (value: Buffer) => {
          if (settled) return;
          const available = Math.min(value.length, apiDebugLimits.responseBytes - sizeBytes);
          if (available > 0) { chunks.push(value.subarray(0, available)); sizeBytes += available; }
          if (available < value.length) finish(true);
        });
        incoming.on('end', () => finish(false));
        incoming.on('aborted', () => fail(new Error('目标服务提前中断响应')));
        incoming.on('error', error => fail(requestError(error, phase)));
      });
      request.on('socket', socket => {
        socket.once('connect', () => { phase = target.protocol === 'https:' ? 'tls' : 'headers'; });
        if (target.protocol === 'https:') socket.once('secureConnect', () => { phase = 'headers'; });
      });
      request.on('error', error => fail(requestError(error, phase)));
      request.end(prepared.body);
    } catch (error) { fail(requestError(error, phase)); }
  });
}

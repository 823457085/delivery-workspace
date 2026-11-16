import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type Operation = { label: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string | ((input: any) => string); schema: z.ZodTypeAny; body?: (input: any) => unknown; readOnly?: boolean };
export function serviceEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请在插件配置中填写服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('服务地址必须是无账号密码、查询参数和路径的 HTTP(S) 地址');
  return url.origin;
}
export function jsonTransport(endpoint: string, secrets: string[] = [], fetcher: typeof fetch = fetch) {
  const active = new Set<AbortController>();
  let closed = false;
  function redact(text: string) { for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[已隐藏]'); return text; }
  return {
    async request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
      if (closed) throw new Error('插件已停止');
      if (!path.startsWith('/') || path.startsWith('//') || new URL(path, endpoint).origin !== endpoint) throw new Error('无效服务接口');
      const abort = new AbortController(); active.add(abort);
      const timer = setTimeout(() => abort.abort(), 50_000);
      try {
        const response = await fetcher(endpoint + path, { method, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', Origin: endpoint, ...headers },
          body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: abort.signal });
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4_000_000) { await reader.cancel(); throw new Error('服务响应过大，请缩小查询范围'); } chunks.push(part.value); }
        let data: any = null;
        if (size) { try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('服务未返回 JSON，请核对服务地址和版本'); } }
        if (!response.ok) {
          const error = new Error(redact(typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`));
          Object.assign(error, { status: response.status }); throw error;
        }
        return { data, cookies: response.headers.getSetCookie() };
      } catch (error: any) {
        if (error?.name === 'AbortError' || abort.signal.aborted) throw new Error('请求已中止或超时，请核对服务端结果；插件不会自动重试');
        if (error instanceof TypeError) throw new Error('无法连接服务，请核对地址、证书和服务状态');
        throw error;
      } finally { clearTimeout(timer); active.delete(abort); }
    },
    close() { closed = true; for (const abort of active) abort.abort(); active.clear(); },
  };
}
export function controlledService(operations: Record<string, Operation>, execute: (op: Operation, input: any) => Promise<unknown>, endpoint: string) {
  let closed = false;
  const previews = new Map<string, { op: Operation; input: unknown; expires: number }>();
  return {
    async request(method: string, raw: unknown) {
      if (closed) throw new Error('插件已停止');
      for (const [key, value] of previews) if (value.expires <= Date.now()) previews.delete(key);
      if (method === 'execute') {
        const { token } = z.object({ token: z.string().uuid() }).strict().parse(raw);
        const pending = previews.get(token); previews.delete(token);
        if (!pending) throw new Error('确认已失效，请重新预览；不要重复提交');
        return execute(pending.op, pending.input);
      }
      if (!['read', 'preview'].includes(method)) throw new Error('不支持的插件操作');
      const { operation, input } = z.object({ operation: z.string(), input: z.unknown().optional() }).strict().parse(raw);
      const op = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
      if (!op) throw new Error('不支持的服务操作');
      const value: any = op.schema.parse(input ?? {});
      const readOnly = op.method === 'GET' || op.readOnly === true;
      if (method === 'read') { if (!readOnly) throw new Error('请先预览并确认写入操作'); return execute(op, value); }
      if (readOnly) throw new Error('读取操作无需写入确认');
      if (previews.size >= 20) throw new Error('待确认操作过多，请稍后重试');
      const token = randomUUID(); previews.set(token, { op, input: structuredClone(value), expires: Date.now() + 120_000 });
      return { token, label: op.label, endpoint, target: typeof value?.id === 'string' ? value.id : '', expiresInSeconds: 120 };
    },
    close() { closed = true; previews.clear(); },
  };
}

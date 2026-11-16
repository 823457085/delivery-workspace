/**
 * 服务入口与网关安全基线模块（修复清单第七节 #1 / #2 / #6 / #8 与 P0-2）：
 * - 按字节限流并 `Buffer.concat` 后一次性 UTF-8 解码，彻底消除跨 TCP 分片的多字节中文乱码；
 * - 统一 `/api/*` 本机 `Host` 白名单校验，阻断 DNS Rebinding 跨站读取；
 * - 统一防嵌入响应头（`X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`）；
 * - 精确匹配 `application/json` MIME 主类型（拒绝 `text/plain; x=application/json` 伪装）；
 * - 动态解析服务端口与网关配对写令牌恒定时间比对。
 */
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

export async function readUtf8JsonBody(
  request: AsyncIterable<Buffer | string>,
  maxBytes = 300_000,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const rawChunk of request) {
    const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk), 'utf8');
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error('请求内容过大');
    }
    chunks.push(buf);
  }

  if (totalBytes === 0) return {};
  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  return JSON.parse(text || '{}');
}

export function isExactJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string' || !contentType.trim()) return false;
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mediaType === 'application/json';
}

export function isAllowedLocalHostHeader(
  hostHeader: string | undefined,
  expectedPort?: number,
): boolean {
  if (!hostHeader) return true;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return false;
  const allowedBase = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (allowedBase.has(trimmed)) return true;
  if (expectedPort && Number.isInteger(expectedPort) && expectedPort > 0) {
    return (
      trimmed === `localhost:${expectedPort}`
      || trimmed === `127.0.0.1:${expectedPort}`
      || trimmed === `[::1]:${expectedPort}`
    );
  }
  return /^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(trimmed);
}

export function applySecurityResponseHeaders(response: Pick<http.ServerResponse, 'setHeader' | 'hasHeader'>): void {
  if (!response.hasHeader('X-Frame-Options')) {
    response.setHeader('X-Frame-Options', 'DENY');
  }
  if (!response.hasHeader('Content-Security-Policy')) {
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (!response.hasHeader('X-Content-Type-Options')) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }
}

export function resolveWorkspaceServicePort(
  env: NodeJS.ProcessEnv = process.env,
  fallback = 5199,
): number {
  const raw = env.DELIVERY_PORT || env.PORT;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

export function verifyGatewayWriteToken(
  providedHeader: string | string[] | undefined,
  expectedToken: string,
): boolean {
  const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;
  if (typeof provided !== 'string' || !provided || !expectedToken) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expectedToken, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

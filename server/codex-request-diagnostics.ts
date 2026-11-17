/** Retain only allowlisted transport metadata; never persist raw CLI stderr or request bodies. */
const knownCodes = new Set(['other', 'badRequest', 'contextWindowExceeded', 'usageLimitExceeded',
  'httpConnectionFailed', 'responseStreamDisconnected', 'internalServerError',
  'responseTooManyFailedAttempts', 'unauthorized', 'sandboxError', 'threadRollbackFailed']);
export function createCodexRequestDiagnostics() {
  let tail = '', code = '', status = '', requestId = '';
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  function error(value: unknown) {
    const item = object(value), info = item.codexErrorInfo ?? item.codex_error_info;
    const tag = typeof info === 'string' ? info : Object.keys(object(info))[0];
    if (tag && knownCodes.has(tag)) {
      code = tag;
      const details = object(object(info)[tag]);
      const httpStatus = details.httpStatusCode ?? details.http_status_code;
      if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus <= 599) status = String(httpStatus);
    }
  }
  function stderr(chunk: string) {
    // Keep only a bounded fragment while matching fields split across chunks.
    tail = (tail + chunk).slice(-8192);
    const http = tail.match(/(?:unexpected status(?: code)?[:=]?\s*|http_status(?:_code)?[=:]\s*)([45]\d\d)\b/i);
    if (http) status = http[1]!;
    const request = tail.match(/\b(?:request[_ -]?id|x-request-id)[:=]\s*["']?(req_[a-zA-Z0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i);
    if (request) requestId = request[1]!;
  }
  function summary(phase: string) {
    tail = '';
    return `Codex 请求诊断：阶段=${phase}${code ? `；分类=${code}` : ''}${status ? `；HTTP=${status}` : ''}${requestId ? `；请求ID=${requestId}` : ''}；未记录请求正文或凭据`;
  }
  return { error, stderr, summary };
}

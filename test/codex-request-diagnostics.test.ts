import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexRequestDiagnostics } from '../server/codex-request-diagnostics.js';
import { analyzeAgentRunFailure } from '../shared/agent-failure-rca.js';

test('400 保留原始错误，诊断事件不是执行动作，也不生成业务修复重试指令', () => {
  const base = { provider: 'codex' as const, mode: 'agent' as const, accessMode: 'full' as const,
    status: 'failed' as const, error: '{"detail":"Bad Request"}' };
  const empty = analyzeAgentRunFailure({ ...base, events: [{ type: 'diagnostic', message: base.error }] })!;
  assert.equal(empty.category, 'request_rejected');
  assert.equal(empty.causalTrigger, undefined);
  assert.equal(empty.smartRetryPrompt, undefined);
  assert.equal(empty.blindRetryAdvisable, false);
  assert.ok(empty.summary.includes(base.error));
  const tools = analyzeAgentRunFailure({ ...base, events: [
    { type: 'tool', message: '执行完成：printf probe-ok' },
    { type: 'diagnostic', message: base.error },
    { type: 'diagnostic', message: 'Codex 请求诊断：阶段=turn/start；分类=other' },
  ] })!;
  assert.equal(tools.causalTrigger, '执行完成：printf probe-ok');
});

test('CLI 诊断只留白名单字段，不泄露请求正文、凭据、URL 或未知分类', () => {
  const d = createCodexRequestDiagnostics();
  d.stderr('Authorization: Bearer fixture-secret\nCookie: session=private\nunexpected sta');
  d.stderr('tus 400 Bad Request request_id=req_0123456789abcdef\nbody={"password":"private"}\nhttps://example.test/?token=private');
  d.error({ codexErrorInfo: 'other', additionalDetails: 'secret-key private' });
  const result = d.summary('turn/start');
  assert.match(result, /HTTP=400/);
  assert.match(result, /分类=other/);
  assert.match(result, /请求ID=req_0123456789abcdef/);
  assert.doesNotMatch(result, /fixture-secret|private|example.test|password|Bearer/);
  const unknown = createCodexRequestDiagnostics();
  unknown.error({ codexErrorInfo: 'private-token', message: 'secret' });
  assert.doesNotMatch(unknown.summary('initialize'), /private-token|secret/);
});

test('结构化传输错误保留 HTTP 状态，日志无元数据时不猜测原因', () => {
  const d = createCodexRequestDiagnostics();
  d.error({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } });
  assert.match(d.summary('turn/start'), /分类=httpConnectionFailed；HTTP=400/);
  const empty = createCodexRequestDiagnostics();empty.stderr('ordinary stderr message');
  assert.doesNotMatch(empty.summary('turn/start'), /HTTP=|分类=/);
});

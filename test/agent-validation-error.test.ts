import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { diagnosisResultSchema } from '../shared/agent-task-plan.js';
import { agentResultErrorMessage } from '../shared/agent-validation-error.js';

test('岗位结果校验错误显示字段路径和原始规则，不暴露 issues JSON 包装', () => {
  const result = z.object({ diagnosis: z.object({ evidence: z.array(z.string()), baseline: z.string() }) })
    .safeParse({ diagnosis: { evidence: [{ command: 'git status' }, 42], baseline: {} } });
  assert.equal(result.success, false);
  if (result.success) return;
  const original = result.error.message;
  const formatted = agentResultErrorMessage(result.error);
  assert.equal(formatted, `岗位返回的结果格式不符合约定：\ndiagnosis.evidence[0]：${result.error.issues[0].message}\ndiagnosis.evidence[1]：${result.error.issues[1].message}\ndiagnosis.baseline：${result.error.issues[2].message}`);
  assert.doesNotMatch(formatted, /"(?:code|expected|path)"\s*:/);
  assert.equal(result.error.message, original, '格式化不修改原始诊断');
});

test('普通接口文案、L 码和 JSON 字符串错误保持原样，只格式化真正 ZodError', () => {
  for (const value of ['L020 原始错误', "ENOENT: realpath '/workspace'", '[{"code":"invalid_type","path":["evidence"],"message":"原文"}]']) {
    assert.equal(agentResultErrorMessage(new Error(value)), value);
    assert.equal(agentResultErrorMessage(value), value);
  }
  const error = new z.ZodError([{ code: 'custom', path: [], message: '必须包含一个明确的结果' }]);
  assert.equal(agentResultErrorMessage(error), '岗位返回的结果格式不符合约定：\n结果：必须包含一个明确的结果');
});


test('诊断联合类型校验展开子问题，保留实际字段而不重复父路径', () => {
  const result = diagnosisResultSchema.safeParse({ summary: '诊断', rootCause: '原因',
    evidence: [{ finding: '命令结果', exitCode: '0' }], unverified: [], suggestions: [] });
  assert.equal(result.success, false);
  if (result.success) return;
  const formatted = agentResultErrorMessage(result.error);
  assert.match(formatted, /evidence\[0\]\.exitCode：Invalid input: expected number, received string/);
  assert.doesNotMatch(formatted, /evidence\[0\]\.evidence|"errors"|"path"/);
  const nested = z.object({ evidence: z.array(z.union([z.string(), z.object({ details: z.union([z.string(), z.object({ code: z.number() })]) })])) })
    .safeParse({ evidence: [{ details: { code: '0' } }] });
  assert.equal(nested.success, false);
  if (nested.success) return;
  assert.match(agentResultErrorMessage(nested.error), /evidence\[0\]\.details\.code：Invalid input: expected number, received string/);
});

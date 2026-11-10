import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosisResultSchema } from '../shared/agent-task-plan.js';

const diagnosis = { summary: '只核对本地差异', rootCause: '接口字段与入口不同',
  evidence: [{ acceptanceId: 'AC-1', status: 'not_run', finding: '需要真实接口核验', command: 'git diff branch -- src/api.ts',
    exitCode: 0, output: 'L0001\n原始差异', sources: ['src/api.ts:10'] }],
  baseline: { cwd: '/project/candidate', head: 'abc123', headState: 'DETACHED', comparisonRef: 'branch', comparisonCommit: 'def456', workingTree: '有未提交修改' },
  unverified: ['真实接口未执行'], suggestions: ['先核实接口契约'] };

test('诊断对象证据保留状态、命令、退出码、原输出、来源与基线，旧文本格式不变', () => {
  const parsed = diagnosisResultSchema.parse(diagnosis);
  assert.deepEqual(parsed.baseline, diagnosis.baseline);
  assert.deepEqual(parsed.unverified, diagnosis.unverified);
  for (const text of ['AC-1', 'not_run', '需要真实接口核验', 'git diff branch -- src/api.ts', '退出码：0', 'L0001\n原始差异', 'src/api.ts:10']) assert.ok(parsed.evidence[0].includes(text));
  assert.equal(parsed.evidence[0].includes('passed'), false);
  const legacy = { ...diagnosis, evidence: ['git diff：未发现差异'] }; delete (legacy as { baseline?: unknown }).baseline;
  assert.deepEqual(diagnosisResultSchema.parse(legacy), legacy);
});

test('诊断兼容仅接受明确结构，未知字段、错误类型和伪状态仍被拒绝', () => {
  for (const evidence of [null, {}, { finding: '差异', status: 'almost_done' }, { finding: '差异', exitCode: '0' },
    { finding: '差异', sources: [{ path: 'src/api.ts' }] }, { finding: '差异', arbitraryApproval: true }]) {
    assert.equal(diagnosisResultSchema.safeParse({ ...diagnosis, evidence: [evidence] }).success, false);
  }
  assert.equal(diagnosisResultSchema.safeParse({ ...diagnosis, baseline: { cwd: '/project', approval: true } }).success, false);
  assert.equal(diagnosisResultSchema.safeParse({ ...diagnosis, arbitraryApproval: true }).success, false);
});

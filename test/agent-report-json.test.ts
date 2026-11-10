import test from 'node:test';
import assert from 'node:assert/strict';
import { readAgentTaskReport, evaluateImplementation, evaluateVerification } from '../shared/agent-task-result.js';
import { readDeliveryReport } from '../shared/delivery-report.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';

const value = { version: 1, taskResult: { role: 'implementer', status: 'succeeded', summary: '已修复映射；浏览器未执行',
  acceptance: [{ id: 'AC-1', status: 'not_run', evidence: '未登录浏览器' }] } };
const json = '```json\n' + JSON.stringify(value) + '\n```';

test('Cursor 唯一顶层 json 任务报告可交给验证，未执行验收仍保持 not_run', () => {
  const result = '核实分支并分析查询链路。\n\n' + json;
  assert.deepEqual(readAgentTaskReport(result).taskResult.acceptance, value.taskResult.acceptance);
  assert.equal(evaluateImplementation(result, [{ path: 'src/map.ts', status: 'modified' }], true, ['src/**']).outcome, 'passed');
  const verification = '```json\n' + JSON.stringify({ ...value, taskResult: { ...value.taskResult, role: 'verifier' },
    validationEvidence: emptyDeliveryEvidence() }) + '\n```';
  assert.equal(evaluateVerification(verification, [{ id: 'AC-1' }]).outcome, 'blocked');
  assert.throws(() => readDeliveryReport(json), /delivery-report/, '正式文档导入保持严格协议');
});

test('JSON 兼容不采信普通对象、重复报告、嵌套示例、引用或残缺报告', () => {
  for (const result of [
    '```json\n{"ok":true}\n```', json + '\n' + json, json.slice(0, -3),
    '````markdown\n' + json + '\n````',
    json.split('\n').map(line => '> ' + line).join('\n'),
    json.split('\n').map(line => '   ' + line).join('\n'),
    json + '\n```delivery-report\n{unfinished',
    json.replace('"version":1', '"version":2'),
  ]) assert.throws(() => readAgentTaskReport(result));
  assert.throws(() => readAgentTaskReport(json.replace('"not_run"', '"almost_done"')), /acceptance/);
});

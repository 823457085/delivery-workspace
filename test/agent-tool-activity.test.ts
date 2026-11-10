import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunEvent } from '../shared/agent-runtime';
import { readableToolEvents } from '../src/features/agent-workbench/tool-activity';

function event(message: string, id = 'event-1'): AgentRunEvent {
  return { id, type: 'tool', message, createdAt: '2026-11-04T07:00:00Z' };
}

test('截图中的 shell 包装与多个文件读取归纳为一步，保留原始事件', () => {
  const input = event("执行完成: /bin/zsh -lc 'cat dist/es/core/Services/sessions/setup-session.js; cat dist/es/core/ProcessResponse/PaymentMethods/PaymentMethods.js'");
  const [step] = readableToolEvents([input]);
  assert.equal(step!.title, '读取文件');
  assert.equal(step!.target, 'setup-session.js、PaymentMethods.js');
  assert.equal(step!.status, 'finished');
  assert.equal(step!.events[0], input);
});

test('截图搜索、差异对比和版本核对按命令位置归纳，相邻开始与完成合并', () => {
  const command = '/bin/zsh -lc "rg -n \'apiConfirmPayment\' src/api src/pages/index/bill-management/payment-detail.vue; git diff --name-only master origin/master -- src/pages/index/bill-management/components/adyen-payment-popup.vue src/pages/index/bill-management/payment-detail.vue; git rev-parse origin/master"';
  const input = [event(`正在执行: ${command}`, 'start'), { ...event(`执行完成: ${command}`, 'end'), createdAt: '2026-11-04T07:01:00Z' }];
  const before = JSON.stringify(input);
  const [step] = readableToolEvents(input);
  assert.equal(readableToolEvents(input).length, 1);
  assert.equal(step!.title, '搜索代码、对比代码差异、核对版本');
  assert.match(step!.target, /apiConfirmPayment、src\/api、payment-detail.vue/);
  assert.match(step!.target, /master、origin\/master、adyen-payment-popup.vue/);
  assert.equal(step!.id, 'start');
  assert.equal(step!.createdAt, input[1]!.createdAt);
  assert.equal(step!.status, 'finished');
  assert.equal(step!.events[0], input[0]);
  assert.equal(step!.events[1], input[1]);
  assert.equal(JSON.stringify(input), before);
});

test('旧工具名称和中文命令前缀可识别，未知工具保守展示', () => {
  const steps = readableToolEvents([event('view_file：/work/setup-session.js'), event('read_file'), event('unknown_tool'),
    event('开始：执行命令：git rev-parse HEAD', 'start'), event('完成：执行命令：git rev-parse HEAD', 'end')]);
  assert.equal(steps[0]!.title, '读取文件');
  assert.equal(steps[0]!.target, 'setup-session.js');
  assert.equal(steps[1]!.title, '读取文件');
  assert.equal(steps[2]!.title, '调用工具');
  assert.equal(steps[3]!.title, '核对版本');
  assert.equal(steps[3]!.status, 'finished');
  assert.equal(steps[3]!.events.length, 2);
  assert.equal(readableToolEvents([event('run_command')])[0]!.title, '执行命令');
});

test('失败只来自明确前缀，结束与请求动作不推断通过或成功', () => {
  const steps = readableToolEvents([event('正在执行：npm test', 'start'), event('执行失败：npm test', 'failed'),
    event('执行完成：/bin/zsh -lc "exit 1"'), event('执行完成：curl https://example.com/api?token=private')]);
  assert.equal(steps[0]!.status, 'failed');
  assert.equal(steps[0]!.events.length, 2);
  assert.equal(steps[1]!.status, 'finished');
  assert.equal(steps[2]!.status, 'finished');
  assert.equal(steps[2]!.title, '请求接口');
  assert.equal(steps[2]!.target, 'https://example.com/api');
  assert.doesNotMatch(JSON.stringify(steps.map(({ title, target, status }) => ({ title, target, status }))), /成功|通过|passed|exitCode/);
});

test('命令参数中的工具名称、引号内的分隔符和展开内容不会误判为执行动作', () => {
  const steps = readableToolEvents([event('正在执行：echo "git diff; npm test"'), event("执行完成：cat 'git diff && npm test.txt'"),
    event("执行完成：/bin/zsh -lc 'cat first.js && cat second.js'"), event('执行完成：echo $(git diff)'),
    event('执行完成：/bin/zsh -lc "echo \\; git diff"'), event('执行完成：TOKEN=private curl https://example.com')]);
  assert.equal(steps[0]!.title, '执行命令');
  assert.equal(steps[1]!.title, '读取文件');
  assert.equal(steps[2]!.target, 'first.js、second.js');
  assert.equal(steps[3]!.title, '执行命令');
  assert.equal(steps[4]!.title, '执行命令');
  assert.equal(steps[5]!.target, '');
});

test('生命周期和空记录继续保留，单词命令不会误认作旧工具名称', () => {
  const steps = readableToolEvents([event(''), event('Codex 正在执行工作区命令'), event('工作区命令已完成'),
    event('只读检查未通过'), event('正在执行：cat')]);
  assert.equal(steps.length, 5);
  assert.equal(steps[0]!.status, 'recorded');
  assert.equal(steps[1]!.status, 'running');
  assert.equal(steps[2]!.status, 'finished');
  assert.equal(steps[3]!.status, 'failed');
  assert.equal(steps[4]!.title, '读取文件');
});

test('空开始与完成分别保留，sed 原地修改不会标成读取文件', () => {
  const empty = readableToolEvents([event('开始：执行命令：', 'start'), event('完成：执行命令：', 'end')]);
  assert.equal(empty.length, 2);
  assert.deepEqual(empty.map(step => step.status), ['running', 'finished']);
  for (const command of ["sed -i 's/a/b/' file.js", "sed --in-place=.bak 's/a/b/' file.js", "sed -ni 's/a/b/p' file.js"]) {
    assert.equal(readableToolEvents([event(`执行完成：${command}`)])[0]!.title, '执行命令');
  }
  assert.equal(readableToolEvents([event("执行完成：sed -n '1,10p' file.js")])[0]!.title, '读取文件');
});

test('仅合并相邻且命令完全一致的开始与结束，输入和原文均不变', () => {
  const input = [event('正在执行：cat first.js', 'a'), event('正在执行：cat second.js', 'b'), event('执行完成：cat first.js', 'c')];
  input.forEach(Object.freeze); Object.freeze(input);
  const steps = readableToolEvents(input);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map(step => step.status), ['running', 'running', 'finished']);
  assert.deepEqual(steps.flatMap(step => step.events), input);
  assert.equal(input[0]!.message, '正在执行：cat first.js');
  assert.deepEqual(readableToolEvents([]), []);
});

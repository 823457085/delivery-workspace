import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDeepseekAdapter, normalizeDeepseekBaseUrl } from '../server/deepseek-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { privateRunFile } from '../server/agent-tool-journal.js';

const json = (output: unknown, status = 'completed') => Response.json({ status, output, usage: { input_tokens: 8, output_tokens: 2 } });
const final = (text: string) => [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }];
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', status: 'completed', call_id: id, name, arguments: JSON.stringify(args) });
function run(root: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'first-run', provider: 'deepseek', customModelId: 'deepseek-config', mode: 'agent', accessMode: 'workspace', model: 'fixture-deepseek',
    reasoningEffort: '', objective: '修复并检查代码', workspacePath: root, branch: '', headSha: '', status: 'running', sessionId: '',
    pid: null, result: '', error: '', events: [], createdAt: '', updatedAt: '', ...overrides };
}
function context(run: AgentRun, extra: Partial<Parameters<AgentRuntimeAdapter['execute']>[0]> = {}) {
  return { run, imagePaths: [], fileAttachments: [], signal: new AbortController().signal, onPid() {}, onSession() {}, onEvent() {}, ...extra };
}
async function fixture(t: any, request: typeof fetch, history: AgentRun[] = []) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-runtime-test-')));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'state');
  const adapter = createDeepseekAdapter({ directory: state, models: () => [{ id: 'deepseek-config', modelId: 'fixture-deepseek', label: 'L_DEEPSEEK', api: { baseUrl: 'https://api.deepseek.com' } }],
    apiKey: async () => 'fixture-xai-secret', history: () => history, redact: text => text.replaceAll('fixture-xai-secret', '[redacted]'), request });
  return { directory: state, root, adapter };
}

test('DeepSeek Responses 工具循环真实修改并检查代码，保存协议历史，两轮与独立会话隔离', { skip: process.platform !== 'darwin' }, async t => {
  const requests: any[] = [], history: AgentRun[] = [];
  const oldContent = 'console.log(1)\n', newContent = 'console.log(2)\n';
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/responses');
    assert.equal(init!.redirect, 'error');
    assert.equal((init!.headers as any).Authorization, 'Bearer fixture-xai-secret');
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    assert.equal('store' in body, false);
    assert.equal('include' in body, false);
    assert.equal('previous_response_id' in body, false);
    assert.equal('conversation' in body, false);
    assert.equal('parallel_tool_calls' in body, false);
    assert.ok(body.tools.every((item: any) => item.strict && item.parameters.additionalProperties === false));
    switch (requests.length) {
      case 1: return json([{ type: 'reasoning', id: 'reasoning-1', content: [{ type: 'reasoning_text', text: 'fixture-reasoning' }] }, call('read-1', 'read_file', { path: 'index.js' })]);
      case 2:
        assert.equal(JSON.parse(body.input.at(-1).output).result.content, oldContent);
        return json([call('write-1', 'apply_patch', { path: 'index.js', expected_sha256: createHash('sha256').update(oldContent).digest('hex'), content: newContent })]);
      case 3: return json([call('check-1', 'run_command', { command: 'exec node --check index.js' })]);
      case 4:
        assert.equal(JSON.parse(body.input.at(-1).output).exitCode, 0);
        return json(final('L123 已修复'));
      case 5:
        assert.equal(body.input.at(-1).content, '第二轮读取结果');
        assert.equal(body.input.filter((item: any) => item.type === 'function_call_output').length, 3);
        assert.deepEqual(body.input.find((item: any) => item.type === 'reasoning').content, [{ type: 'reasoning_text', text: 'fixture-reasoning' }]);
        return json([call('read-2', 'read_file', { path: 'index.js' })]);
      case 6:
        assert.equal(JSON.parse(body.input.at(-1).output).result.content, newContent);
        return json(final('L456 第二轮完成'));
      default:
        assert.deepEqual(body.input, [{ role: 'user', content: '独立会话' }]);
        return json(final('独立结果'));
    }
  };
  const { adapter, root, directory } = await fixture(t, request, history);
  await fs.writeFile(path.join(root, 'index.js'), oldContent);
  const first = run(root);
  assert.equal(await adapter.execute(context(first)), 'L123 已修复');
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), newContent);
  history.push({ ...first, status: 'completed', result: 'L123 已修复' });
  assert.equal(await adapter.execute(context(run(root, { id: 'second-run', parentRunId: first.id, objective: '第二轮读取结果' }))), 'L456 第二轮完成');
  history.length = 0;
  assert.equal(await adapter.execute(context(run(root, { id: 'isolated-run', objective: '独立会话' }))), '独立结果');
  const saved = privateRunFile(path.join(directory, 'deepseek-transcripts'), first.id);
  assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(saved, 'utf8')).includes('fixture-xai-secret'), false);
  await assert.rejects(adapter.execute(context(first)), /已有协议记录/);
});

test('DeepSeek 失败、协议不完整和非法工具批次均不得伪报成功或执行部分副作用', { skip: process.platform !== 'darwin' }, async t => {
  const scenarios = [
    () => Response.json({ error: 'fixture-xai-secret' }, { status: 401 }),
    () => json(final('半段'), 'incomplete'),
    () => json([call('valid', 'apply_patch', { path: 'bad', expected_sha256: '', content: 'bad' }), call('invalid', 'unknown', {})]),
    () => json([call('same', 'list_files', { path: '.' }), call('same', 'list_files', { path: '.' })]),
  ];
  for (const [index, response] of scenarios.entries()) {
    const { adapter, root } = await fixture(t, async () => response());
    await assert.rejects(adapter.execute(context(run(root, { id: `bad-${index}` }))), error => error instanceof Error && !error.message.includes('fixture-xai-secret'));
    assert.equal(await fs.stat(path.join(root, 'bad')).then(() => true, () => false), false);
  }
});

test('DeepSeek 只读轮不能写入，full 明确拒绝，取消前不执行工具，敏感输出脱敏', { skip: process.platform !== 'darwin' }, async t => {
  let count = 0;
  const { adapter, root } = await fixture(t, async () => count++ === 0
    ? json([call('write', 'apply_patch', { path: 'bad', expected_sha256: '', content: 'bad' })]) : json(final('fixture-xai-secret L789')));
  await assert.rejects(adapter.execute(context(run(root, { mode: 'ask' }))), /只读/);
  await assert.rejects(adapter.execute(context(run(root, { id: 'full', accessMode: 'full' }))), /不支持完全访问/);
  await assert.rejects(adapter.execute(context(run(root, { id: 'replay', recoveryOfRunId: 'old' }))), /禁止自动重放/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.execute(context(run(root, { id: 'cancelled' }), { signal: controller.signal })));
  assert.equal(count, 1);
  assert.equal(await adapter.execute(context(run(root, { id: 'redacted' }))), '[redacted] L789');
});

test('DeepSeek health 不把配置存在当成认证，官方地址固定', async t => {
  assert.throws(() => normalizeDeepseekBaseUrl('https://api.deepseek.com/../../evil'), /仅接受官方/);
  assert.throws(() => normalizeDeepseekBaseUrl('https://evil.example/v1'), /仅接受官方/);
  const { adapter } = await fixture(t, async url => String(url).endsWith('/user/balance') ? Response.json({ is_available: true }) : Response.json({ data: [{ id: 'fixture-deepseek' }] }));
  const health = await adapter.health();
  assert.equal(health.authenticated, true);
  assert.equal(health.models[0].label, 'L_DEEPSEEK');
  assert.equal(JSON.stringify(health).includes('fixture-xai-secret'), false);
  const unavailable = createDeepseekAdapter({ directory: '/unused', models: () => [], apiKey: async () => '', history: () => [], redact: text => text,
    request: async () => { throw new Error('should not request'); } });
  assert.equal((await unavailable.health()).ready, false);
});

test('DeepSeek 认证通过但余额不足时不展示执行可用', async t => {
  const { adapter } = await fixture(t, async url => String(url).endsWith('/user/balance')
    ? Response.json({ is_available: false }) : Response.json({ data: [{ id: 'fixture-deepseek' }] }));
  const health = await adapter.health();
  assert.equal(health.authenticated, true);
  assert.equal(health.ready, false);
  assert.equal(health.writable, false);
  assert.match(health.message, /余额不足/);
});

test('DeepSeek 返回多个调用时宿主顺序执行，并将完整回执交回模型', { skip: process.platform !== 'darwin' }, async t => {
  let round = 0;
  const { adapter, root } = await fixture(t, async (_url, init) => {
    if (++round === 1) return json([
      call('create', 'apply_patch', { path: 'sequential.txt', expected_sha256: '', content: 'created-first' }),
      call('read-after-create', 'read_file', { path: 'sequential.txt' }),
    ]);
    const input = JSON.parse(String(init!.body)).input;
    const outputs = input.filter((item: any) => item.type === 'function_call_output');
    assert.deepEqual(outputs.map((item: any) => item.call_id), ['create', 'read-after-create']);
    assert.equal(JSON.parse(outputs[1].output).result.content, 'created-first');
    return json(final('sequential completed'));
  });
  assert.equal(await adapter.execute(context(run(root))), 'sequential completed');
  assert.equal(await fs.readFile(path.join(root, 'sequential.txt'), 'utf8'), 'created-first');
});

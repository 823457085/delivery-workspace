/** Protocol fixtures with an explicit mock host backend; no network inference or OS sandbox claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDeepseekAdapter, normalizeDeepseekBaseUrl, nvidiaDeepseekBaseUrl, nvidiaDeepseekModelId } from '../server/deepseek-runtime.js';
import { createGrokAdapter } from '../server/grok-runtime.js';
import { privateRunFile } from '../server/agent-tool-journal.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { ResponsesModelOptions } from '../server/responses-model-runtime.js';

const tool = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (content: string | null, calls: unknown[] = [], finish = calls.length ? 'tool_calls' : 'stop') => Response.json({
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: 'fixture reasoning', ...(calls.length ? { tool_calls: calls } : {}) } }],
  usage: { prompt_tokens: 7, completion_tokens: 3 },
});
function context(run: AgentRun, signal = new AbortController().signal): Parameters<AgentRuntimeAdapter['execute']>[0] {
  return { run, imagePaths: [], fileAttachments: [], signal, onPid() {}, onSession() {}, onEvent() {} };
}
async function fixture(t: any, request: typeof fetch, execute: (name: string, args: any) => Promise<any> = async () => ({ ok: true, result: 'L123 fixture-key' })) {
  await fs.mkdir('.local', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('.local/nvidia-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const history: AgentRun[] = [], calls: any[] = [], snapshots: AgentRun[] = [];
  const closed: boolean[] = [];
  const models = [{ id: 'nvidia-config', modelId: nvidiaDeepseekModelId, label: 'L_NVIDIA', api: { baseUrl: nvidiaDeepseekBaseUrl } }];
  const options: ResponsesModelOptions = { directory, models: () => models, apiKey: async id => {
    assert.equal(id, 'nvidia-config'); return 'fixture-key';
  }, history: () => history, redact: value => value.replaceAll('fixture-key', '[redacted]'), request, sandboxProbe: async () => true,
  createTools: async run => {
    const index = closed.push(false) - 1; snapshots.push({ ...run });
    return { async execute(name: string, args: any) { calls.push({ name, args }); return execute(name, args); }, async close() { closed[index] = true; } };
  } };
  const run = (extra: Partial<AgentRun> = {}) => ({ id: randomUUID(), provider: 'deepseek', customModelId: 'nvidia-config', model: nvidiaDeepseekModelId,
    mode: 'agent', accessMode: 'workspace', workspacePath: root, objective: '读取修改检查', status: 'running', events: [], reasoningEffort: '',
    sessionId: '', pid: null, result: '', error: '', branch: '', headSha: '', createdAt: '', updatedAt: '', ...extra }) as AgentRun;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, history, calls, snapshots, closed, models, options, run, adapter: createDeepseekAdapter(options) };
}

test('NVIDIA 原生工具协议顺序回传、reasoning保留、两轮历史和权限收紧；不混用其他通道历史', async t => {
  const requests: any[] = [];
  const f = await fixture(t, async (url, init) => {
    assert.equal(String(url), `${nvidiaDeepseekBaseUrl}/chat/completions`);
    assert.equal(init!.redirect, 'error');
    assert.equal((init!.headers as any).Authorization, 'Bearer fixture-key');
    const body = JSON.parse(String(init!.body)); requests.push(body);
    assert.equal(body.model, nvidiaDeepseekModelId);
    assert.equal(body.stream, false); assert.equal('input' in body, false); assert.equal('store' in body, false);
    assert.deepEqual(body.tools.map((x: any) => x.function.name), ['read_file', 'list_files', 'apply_patch', 'run_command']);
    assert.ok(body.tools.every((x: any) => x.function.parameters.additionalProperties === false));
    if (requests.length === 1) return response(null, [tool('read', 'read_file', { path: 'a.js' }), tool('list', 'list_files', { path: '.' })]);
    if (requests.length === 2) {
      assert.deepEqual(body.messages.slice(-2).map((x: any) => x.tool_call_id), ['read', 'list']);
      assert.ok(body.messages.some((x: any) => x.reasoning_content === 'fixture reasoning'));
      assert.equal(JSON.stringify(body.messages).includes('fixture-key'), false);
      return response('L_结果原文');
    }
    assert.equal(body.messages.at(-1).content, '第二轮只读');
    assert.ok(body.messages.some((x: any) => x.content === 'L_结果原文'));
    return response('第二轮完成');
  });
  // A completed official Responses parent must neither load a NVIDIA transcript nor leak its context.
  f.history.push(f.run({ status: 'completed', customModelId: 'official-config', model: 'official-model', objective: 'not shared' }));
  const first = f.run();
  assert.equal(await f.adapter.execute(context(first)), 'L_结果原文');
  f.history.push({ ...first, status: 'completed' });
  assert.equal(await f.adapter.execute(context(f.run({ mode: 'ask', objective: '第二轮只读', parentRunId: first.id }))), '第二轮完成');
  assert.deepEqual(f.calls.map(x => x.name), ['read_file', 'list_files']);
  assert.deepEqual(f.snapshots.map(x => x.mode), ['agent', 'ask']);
  assert.ok(f.closed.every(Boolean));
  const saved = privateRunFile(path.join(f.directory, 'nvidia-transcripts'), first.id);
  assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(saved, 'utf8')).includes('fixture-key'), false);
  await assert.rejects(f.adapter.execute(context(first)), /已有协议记录/);
});

test('NVIDIA 非完整终态、非法/重复工具批次在首个副作用前拒绝；429不重试或转付费', async t => {
  const scenarios = [
    () => response('truncated', [], 'length'),
    () => response(null, [tool('good', 'read_file', { path: 'a' }), tool('bad', 'apply_patch', { path: 'a', expected_sha256: '', content: 'x', roots: ['/'] })]),
    () => response(null, [tool('same', 'read_file', { path: 'a' }), tool('same', 'list_files', { path: '.' })]),
    () => response('text with tool call', [tool('bad', 'read_file', { path: 'a' })], 'stop'),
    () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [null] } }] }),
    () => Response.json({ error: 'fixture-key' }, { status: 429 }),
  ];
  for (const scenario of scenarios) {
    let requests = 0;
    const f = await fixture(t, async () => { requests++; return scenario(); });
    await assert.rejects(f.adapter.execute(context(f.run())), error => {
      assert.equal(String(error).includes('fixture-key'), false); return true;
    });
    assert.equal(requests, 1); assert.equal(f.calls.length, 0); assert.ok(f.closed.every(Boolean));
  }
});

test('NVIDIA 停止取消模型请求并关闭工具；未知结果和恢复请求不得自动重放', async t => {
  const controller = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const running = f.adapter.execute(context(f.run(), controller.signal));
  await pending; controller.abort(); await assert.rejects(running); assert.ok(f.closed.every(Boolean));
  let requests = 0;
  const g = await fixture(t, async () => { requests++; return response(null, [tool('effect', 'apply_patch', { path: 'a', expected_sha256: '', content: 'x' })]); },
    async () => { throw new Error('fixture backend result unknown'); });
  const first = g.run();
  await assert.rejects(g.adapter.execute(context(first)), /unknown/);
  const receipts = JSON.parse(await fs.readFile(privateRunFile(path.join(g.directory, 'nvidia-tools'), first.id), 'utf8'));
  assert.equal(receipts.effect.state, 'unknown');
  await assert.rejects(g.adapter.execute(context(g.run({ recoveryOfRunId: first.id }))), /禁止自动重放/);
  assert.equal(requests, 1);
});

test('NVIDIA固定地址、模型与独立密钥；health不以已配置冒充认证或工具可用', async t => {
  assert.equal(normalizeDeepseekBaseUrl(nvidiaDeepseekBaseUrl + '/'), nvidiaDeepseekBaseUrl);
  for (const base of ['http://integrate.api.nvidia.com/v1', nvidiaDeepseekBaseUrl + '?key=x', 'https://user:pass@integrate.api.nvidia.com/v1'])
    assert.throws(() => normalizeDeepseekBaseUrl(base));
  const f = await fixture(t, async url => {
    assert.equal(String(url), `${nvidiaDeepseekBaseUrl}/models`);
    return Response.json({ data: [{ id: nvidiaDeepseekModelId }] });
  });
  const health = await f.adapter.health(); assert.equal(health.authenticated, true); assert.match(health.label, /NVIDIA/);
  assert.equal(health.ready, false); assert.equal(health.writable, false); assert.match(health.message, /尚未验收/);
  const unavailable = createDeepseekAdapter({ ...f.options, apiKey: async () => '', request: async () => { throw new Error('not called'); } });
  assert.equal((await unavailable.health()).authenticated, false); assert.equal((await unavailable.health()).ready, false);
  f.models[0].modelId = 'paid-or-other-model';
  await assert.rejects(f.adapter.execute(context(f.run({ model: 'paid-or-other-model' }))), /仅接受/);
  assert.equal(f.calls.length, 0);
});

test('原有官方 DeepSeek/Grok Responses 协议保持原终态与选项，不受NVIDIA分支影响', async t => {
  const f = await fixture(t, async () => { throw new Error('unused'); });
  for (const provider of ['deepseek', 'grok'] as const) {
    const baseUrl = provider === 'grok' ? 'https://api.x.ai/v1' : 'https://api.deepseek.com';
    const factory = provider === 'grok' ? createGrokAdapter : createDeepseekAdapter;
    const adapter = factory({ ...f.options, models: () => [{ id: 'nvidia-config', modelId: 'official-model', label: 'L_NAME', api: { baseUrl } }],
      request: async (url, init) => {
        assert.equal(String(url), baseUrl + '/responses');
        const body = JSON.parse(String(init!.body));
        assert.ok(Array.isArray(body.input)); assert.equal('messages' in body, false);
        assert.equal('store' in body, provider === 'grok'); assert.equal('include' in body, provider === 'grok');
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'L_RESPONSE' }] }] });
      } });
    assert.equal(await adapter.execute(context(f.run({ provider, model: 'official-model' }))), 'L_RESPONSE');
  }
});

test('Grok Build 文件存在仅表示已安装，health及execute均保持执行阻断', async t => {
  const f = await fixture(t, async () => { throw new Error('no inference'); });
  const file = path.join(f.root, 'grok'); await fs.writeFile(file, 'not executable');
  const adapter = createGrokAdapter({ ...f.options, models: () => [], buildBinary: file });
  const health = await adapter.health();
  assert.equal(health.binary, file); assert.equal(health.authenticated, false);
  assert.equal(health.ready, false); assert.equal(health.writable, false); assert.match(health.message, /已发现 Grok Build/);
  await assert.rejects(adapter.execute(context(f.run({ provider: 'grok' }))), /尚未验收/);
  assert.equal(f.calls.length, 0);
});

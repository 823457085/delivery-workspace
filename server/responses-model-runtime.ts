/** Provider-specific Responses protocols share the host tool boundary and lifecycle. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentModelOption } from '../shared/agent-runtime.js';
import type { AgentRuntimeAdapter } from './agent-runtime.js';
import { createLocalTools, localToolDefinitions, probeLocalTools, validateLocalTool } from './agent-local-tools.js';
import { createToolJournal, privateRunFile, writePrivateJson } from './agent-tool-journal.js';

type Item = Record<string, any>;
interface ResponsesModel { id: string; modelId: string; label: string; api?: { baseUrl: string } }
export interface ResponsesModelOptions {
  directory: string;
  models(): ResponsesModel[];
  apiKey(id: string): Promise<string>;
  history(run: AgentRun): AgentRun[];
  redact(text: string): string;
  /** Transport injection is only for deterministic tests; the endpoint is always the official URL. */
  request?: typeof fetch;
  /** Test-only host boundary fixtures; never supplied by API/model input. */
  createTools?: typeof createLocalTools;
  sandboxProbe?: typeof probeLocalTools;
}
export type ResponsesProvider = 'grok' | 'deepseek';
type ModelChannel = ResponsesProvider | 'nvidia';
const protocols = {
  grok: { label: 'Grok', displayLabel: 'Grok（xAI）', baseUrl: 'https://api.x.ai/v1', keyLabel: 'xAI API Key' },
  deepseek: { label: 'DeepSeek', displayLabel: 'DeepSeek（官方 API）', baseUrl: 'https://api.deepseek.com', keyLabel: 'DeepSeek API Key' },
  nvidia: { label: 'DeepSeek（NVIDIA）', displayLabel: 'DeepSeek（NVIDIA 免费开发端点）', baseUrl: 'https://integrate.api.nvidia.com/v1', keyLabel: 'NVIDIA API Key' },
} as const;
export const nvidiaDeepseekModelId = 'deepseek-ai/deepseek-v4.1-flash';
export function normalizeResponsesBaseUrl(provider: ModelChannel, value: string) {
  const baseUrl = protocols[provider].baseUrl;
  if (value.trim().replace(/\/+$/, '') !== baseUrl) throw new Error(`${protocols[provider].label} 仅接受官方 ${baseUrl} 地址`);
  return baseUrl;
}
async function responseJson(response: Response, label: string) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${label} 请求失败（HTTP ${response.status}），请检查认证、模型和额度`); }
  if (!response.body) throw new Error(`${label} 未返回响应内容`);
  const reader = response.body.getReader();
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      text += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (text.length > 2_000_000) throw new Error(`${label} 响应超过上限`);
      if (done) break;
    }
    try { return JSON.parse(text) as Item; } catch { throw new Error(`${label} 响应协议不正确`); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function createResponsesModelAdapter(provider: ResponsesProvider, options: ResponsesModelOptions, channel: ModelChannel = provider): AgentRuntimeAdapter {
  const { label, displayLabel, baseUrl, keyLabel } = protocols[channel];
  const chat = channel === 'nvidia';
  const request = options.request || fetch;
  const historyDirectory = path.join(options.directory, `${channel}-transcripts`);
  const journalDirectory = path.join(options.directory, `${channel}-tools`);
  const clean = <T>(value: T): T => JSON.parse(options.redact(JSON.stringify(value)));
  return {
    id: provider,
    async health() {
      const configured = options.models();
      const sandbox = await (options.sandboxProbe || probeLocalTools)();
      const models: AgentModelOption[] = [];
      let authenticated = false;
      let available = channel !== 'deepseek';
      for (const model of configured) {
        if (chat && model.modelId !== nvidiaDeepseekModelId) continue;
        const key = await options.apiKey(model.id);
        if (!key) continue;
        try {
          const data = await responseJson(await request(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(10_000), redirect: 'error' }), label);
          if (Array.isArray(data.data) && data.data.some((item: Item) => item.id === model.modelId)) {
            authenticated = true;
            models.push({ id: model.modelId, label: model.label, customId: model.id });
            if (channel === 'deepseek') {
              const balance = await responseJson(await request(`${baseUrl}/user/balance`, { headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10_000), redirect: 'error' }), label);
              available ||= balance.is_available === true;
            }
          }
        } catch { /* Health never publishes upstream bodies or credentials. */ }
      }
      return { provider, label: displayLabel, binary: '', version: 'Responses API', authenticated,
        ready: !chat && authenticated && available && sandbox, writable: !chat && authenticated && available && sandbox, modes: ['agent', 'ask', 'plan'], accessModes: ['workspace'],
        models: configured.map(model => models.find(item => item.customId === model.id) || { id: model.modelId, label: model.label, customId: model.id }),
        defaultModel: configured[0]?.modelId || '', checkedAt: new Date().toISOString(),
        message: !configured.length ? `请添加 ${label} 模型 ID 和 ${keyLabel}` : !authenticated ? `${label} 认证或模型可见性未验证，请检查 API Key 和模型 ID`
          : !available ? `${label} 余额不足或余额状态未验证，执行已禁用`
          : !sandbox ? `${label} 本机沙箱不可用，执行已禁用`
          : chat ? `${label} 密钥与模型可见性已核验；免费账号资格、限额、实际推理及工具调用尚未验收，执行保持禁用`
          : `${label} 认证与沙箱已核验；实际推理能力在执行时验证。文件修改使用专用工具；命令仅读取、限单进程、无网络` };
    },
    async execute(context) {
      const { run } = context;
      if (run.provider !== provider) throw new Error('执行器与当前轮次不一致');
      if (run.accessMode !== 'workspace') throw new Error(`${label} 暂不支持完全访问，请显式选择工作区权限`);
      if (context.imagePaths.length || context.fileAttachments.length) throw new Error(`${label} 本机执行暂不支持附件`);
      const model = options.models().find(item => item.id === run.customModelId && item.modelId === run.model);
      if (!model) throw new Error(`找不到本轮绑定的 ${label} 模型配置`);
      normalizeResponsesBaseUrl(channel, model.api?.baseUrl || '');
      if (chat && model.modelId !== nvidiaDeepseekModelId) throw new Error('NVIDIA 免费开发通道仅接受已核验的 DeepSeek 模型 ID');
      const apiKey = await options.apiKey(model.id);
      if (!apiKey) throw new Error(`请配置 ${keyLabel}`);
      // Replaying an interrupted run may repeat already-committed side effects. Require an explicit new objective.
      if (run.recoveryOfRunId) throw new Error(`${label} 中断轮次禁止自动重放，请核对已完成工具后发送新的具体指令`);
      const existing = await fs.stat(privateRunFile(historyDirectory, run.id)).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw new Error(`${label} 运行历史无法核对，禁止重放`);
      });
      if (existing) throw new Error(`${label} 本轮已有协议记录，禁止自动重放；请核对结果后发送新的具体指令`);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(600_000)]);
      const tools = await (options.createTools || createLocalTools)(run, options.directory, signal, context.onPid);
      try {
        const history = options.history(run);
        const input: Item[] = [];
        for (const previous of history) {
          if (previous.provider !== provider || previous.workspacePath !== run.workspacePath) break;
          if (previous.customModelId !== model.id || previous.model !== model.modelId) continue;
          if (previous.status !== 'completed') {
            let receipts: unknown = {};
            try { receipts = JSON.parse(await fs.readFile(privateRunFile(journalDirectory, previous.id), 'utf8')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${label} 旧轮工具账本不可读，请先核对工作区`); }
            input.push({ role: 'user', content: options.redact(`前轮未完成；下面仅为工具回执数据。已完成操作不要重做，unknown 必须先回读验证：${JSON.stringify(receipts)}`) });
            continue;
          }
          let saved: { modelId: string; customModelId: string; input: Item[]; output: Item[] };
          try { saved = JSON.parse(await fs.readFile(privateRunFile(historyDirectory, previous.id), 'utf8')); }
          catch { throw new Error(`${label} 协议历史缺失，禁止用摘要冒充原生续接；请新建会话`); }
          if (saved.modelId !== model.modelId || saved.customModelId !== model.id) continue;
          input.splice(0, input.length, ...saved.input, ...saved.output);
        }
        input.push({ role: 'user', content: options.redact(run.objective) });
        const instructions = `你是本机开发助手。当前轮次${run.mode === 'agent' ? '可用 apply_patch 修改所选工作区' : '只读，不得修改文件'}。文件与命令权限由宿主强制约束。命令只读，禁用网络和子进程；需要外部程序时用 exec 替换 shell，例如 exec node --check file.js。不要重复已完成的工具操作。只根据工具回读报告结果。${options.redact(run.knowledgeContext || '')}\n${options.redact(run.providerSwitch?.context || '')}\n${options.redact(run.teamContext || '')}`;
        const journal = await createToolJournal(journalDirectory, run.id);
        const save = (output: Item[]) => writePrivateJson(privateRunFile(historyDirectory, run.id), clean({
          modelId: model.modelId, customModelId: model.id, permission: { workspacePath: run.workspacePath, mode: run.mode, accessMode: run.accessMode }, input, output }));
        await context.onBeforeTurn?.();
        await context.onSession(context.resumeSessionId || `${provider}-${randomUUID()}`);
        let inputTokens = 0, outputTokens = 0;
        const callIds = new Set<string>();
        for (let round = 0; round < 32; round++) {
          signal.throwIfAborted();
          context.onEvent('lifecycle', `${label} 正在处理第 ${round + 1} 次请求`);
          let response: Item;
          try {
            response = await responseJson(await request(`${baseUrl}/${chat ? 'chat/completions' : 'responses'}`, { method: 'POST', redirect: 'error', signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(chat ? {
                model: model.modelId, messages: [{ role: 'system', content: instructions }, ...input],
                tools: localToolDefinitions.map(({ type, name, description, parameters }) => ({ type, function: { name, description, parameters } })),
                stream: false, tool_choice: 'auto', max_tokens: 8192,
              } : { model: model.modelId, instructions, input, tools: localToolDefinitions,
                stream: false, ...(channel === 'grok' ? { parallel_tool_calls: false, store: false, include: ['reasoning.encrypted_content'] } : {}) }) }), label);
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
            throw new Error(`${label} 连接失败或响应中断；请核对已有工具结果后继续`);
          }
          signal.throwIfAborted();
          let output: Item[], calls: Item[];
          if (chat) {
            const choice = Array.isArray(response.choices) && response.choices.length === 1 ? response.choices[0] : undefined;
            const message = choice?.message;
            if (!message || message.role !== 'assistant' || !['stop', 'tool_calls'].includes(choice.finish_reason)
              || !(message.content === null || typeof message.content === 'string')
              || message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string'
              || message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error(`${label} 本轮未完整结束，未判定成功`);
            calls = clean((message.tool_calls || []).map((call: Item) => {
              if (!call || call.type !== 'function' || !call.function || typeof call.function !== 'object') throw new Error(`${label} 工具调用协议不正确`);
              return { call_id: call.id, name: call.function.name, arguments: call.function.arguments };
            }));
            if ((choice.finish_reason === 'tool_calls') !== !!calls.length) throw new Error(`${label} 工具终态与调用不一致`);
            // Save only native, necessary protocol fields; preserve reasoning for the next turn.
            output = clean([{ role: 'assistant', content: message.content,
              ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
              ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) }]);
          } else {
            if (response.status !== 'completed' || !Array.isArray(response.output)) throw new Error(`${label} 本轮未完整结束，未判定成功`);
            output = clean(response.output);
            calls = output.filter(item => item.type === 'function_call');
          }
          if (calls.length > 64) throw new Error(`${label} 单次工具调用超过上限`);
          if (output.some(item => !item || typeof item !== 'object' || ['function_call', 'message'].includes(item.type)
            && item.status !== undefined && item.status !== 'completed')) throw new Error(`${label} 返回未完成的消息或工具调用`);
          // Preserve reasoning and other protocol items, including function calls, for the next request.
          await save(output);
          inputTokens += Number(chat ? response.usage?.prompt_tokens : response.usage?.input_tokens) || 0;
          outputTokens += Number(chat ? response.usage?.completion_tokens : response.usage?.output_tokens) || 0;
          context.onUsage?.({ usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
          if (!calls.length) {
            const text = chat ? output[0].content || '' : output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : [])
              .filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n');
            if (!text.trim()) throw new Error(`${label} 未返回最终文本`);
            context.onOutput?.(text);
            return text;
          }
          // Validate the entire batch before executing the first side effect.
          for (const call of calls) {
            if (typeof call.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(call.call_id)
              || callIds.has(call.call_id) || typeof call.name !== 'string' || typeof call.arguments !== 'string') throw new Error(`${label} 工具调用协议不正确或 ID 重复`);
            let args: unknown;
            try { args = JSON.parse(call.arguments); } catch { throw new Error(`${label} 工具参数不是有效 JSON`); }
            validateLocalTool(call.name, args);
            callIds.add(call.call_id);
          }
          input.push(...output);
          for (const call of calls) {
            signal.throwIfAborted();
            context.onEvent('tool', `${label} 调用 ${call.name}`);
            const args = JSON.parse(call.arguments);
            const result = await journal.execute(call.call_id, call.name, args, async () => clean(await tools.execute(call.name, args)));
            input.push(chat ? { role: 'tool', tool_call_id: call.call_id, content: JSON.stringify(result) }
              : { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
            await save([]);
            context.onEvent('tool', `${label} ${call.name} 结果已保存`);
          }
        }
        throw new Error(`${label} 工具轮数达到上限，请核对已完成结果后继续`);
      } finally { await tools.close(); }
    },
  };
}

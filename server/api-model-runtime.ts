/** OpenAI 兼容 API 直接调用；会话历史由工作台提供，不借用本机 CLI 的登录或工具权限。 */
import { randomUUID } from 'node:crypto';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentRuntimeAdapter } from './agent-runtime.js';

export interface ApiModelConfig {
  id: string;
  modelId: string;
  label: string;
  api: { baseUrl: string };
}

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请填写有效的 API Base URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('API Base URL 需使用 HTTPS（本机可使用 HTTP），且不能包含凭据、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '');
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export function createApiModelAdapter(options: {
  models(): ApiModelConfig[];
  apiKey(customId: string): Promise<string>;
  history(run: AgentRun): AgentRun[];
}): AgentRuntimeAdapter {
  return {
    id: 'api',
    async health() {
      const models = options.models();
      return { provider: 'api', label: '模型 API', binary: '', version: 'OpenAI-compatible', authenticated: models.length > 0,
        ready: models.length > 0, message: models.length ? 'API 模型已配置，支持对话和规划；连接在发送时验证' : '请先添加 API 自定义模型',
        modes: ['ask', 'plan'], accessModes: ['workspace'], models: models.map(model => ({ id: model.modelId,
          label: model.label, customId: model.id })), defaultModel: models[0]?.modelId || '', writable: false,
        checkedAt: new Date().toISOString() };
    },
    async execute(context) {
      const { run } = context;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(180_000)]);
      const checkSignal = () => {
        context.signal.throwIfAborted();
        if (signal.aborted) throw new Error('模型 API 请求超时，请重试');
      };
      if (run.mode !== 'ask' && run.mode !== 'plan') throw new Error('API 模型当前支持对话和规划模式');
      if (context.imagePaths.length || context.fileAttachments.length) throw new Error('API 模型当前不支持附件，请使用文本消息');
      const model = options.models().find(item => item.modelId === run.model);
      if (!model) throw new Error('找不到所选 API 模型配置');
      const baseUrl = normalizeApiBaseUrl(model.api.baseUrl);
      const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
      const apiKey = await options.apiKey(model.id);
      checkSignal();
      const history = options.history(run).filter(item => item.id !== run.id && item.status === 'completed' && item.result);
      const messages = [
        { role: 'system', content: `你是工作台的对话助手。${run.mode === 'plan' ? '请分析任务并给出可执行计划。' : '请回答用户的问题。'}当前 API 会话没有本机文件、终端或其他执行工具；不要声称已执行这些操作。` },
        ...(run.knowledgeContext ? [{ role: 'system', content: run.knowledgeContext }] : []),
        ...(run.providerSwitch?.context ? [{ role: 'system', content: run.providerSwitch.context }] : []),
        ...(run.teamContext ? [{ role: 'system', content: run.teamContext }] : []),
        ...history.flatMap(item => [{ role: 'user', content: item.objective }, { role: 'assistant', content: item.result }]),
        { role: 'user', content: run.objective },
      ];
      await context.onBeforeTurn?.();
      await context.onSession(context.resumeSessionId || `api-${randomUUID()}`);
      context.onEvent('lifecycle', '正在请求模型 API');
      let response: Response;
      try {
        response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model: model.modelId,
          messages, stream: true, stream_options: { include_usage: true } }), signal, redirect: 'error' });
      } catch {
        checkSignal();
        throw new Error('模型 API 连接失败，请检查 Base URL、网络和服务状态');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`模型 API 请求失败（HTTP ${response.status}），请检查 API Key、模型 ID 和服务额度`);
      }
      let result = '', finished = false;
      const accept = (raw: unknown) => {
        const data = object(raw);
        if (data.error) throw new Error('模型 API 返回错误，请检查服务端状态');
        const usage = object(data.usage);
        if (Object.keys(usage).length) context.onUsage?.({ usage: {
          input_tokens: usage.prompt_tokens, cached_input_tokens: object(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens,
          output_tokens: usage.completion_tokens, reasoning_output_tokens: object(usage.completion_tokens_details).reasoning_tokens,
        } });
        const choice = object(Array.isArray(data.choices) ? data.choices[0] : undefined);
        const text = object(choice.delta).content ?? object(choice.message).content;
        if (typeof text === 'string') { result += text; context.onOutput?.(result); }
        if (choice.finish_reason != null) {
          if (choice.finish_reason !== 'stop') throw new Error('模型 API 回复未完整完成，请检查输出限制或模型能力');
          finished = true;
        }
      };
      try {
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          if (!response.body) throw new Error('模型 API 未返回响应内容');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '', streamDone = false;
          const dispatch = (event: string) => {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) return;
            if (data.trim() === '[DONE]') { streamDone = true; return; }
            let parsed: unknown;
            try { parsed = JSON.parse(data); }
            catch { throw new Error('模型 API 流式响应格式不正确'); }
            accept(parsed);
          };
          try {
            while (true) {
              const { done, value } = await reader.read();
              pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
              let boundary: RegExpExecArray | null;
              while (!streamDone && (boundary = /\r?\n\r?\n/.exec(pending))) {
                dispatch(pending.slice(0, boundary.index));
                pending = pending.slice(boundary.index + boundary[0].length);
              }
              if (streamDone) break;
              if (pending.length > 2_000_000) throw new Error('模型 API 流式响应事件过大');
              if (done) { if (pending.trim()) dispatch(pending); break; }
            }
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        } else {
          let data: unknown;
          try { data = await response.json(); }
          catch { throw new Error('模型 API 响应格式不正确'); }
          accept(data);
        }
      } catch (error) {
        checkSignal();
        if (error instanceof Error && error.message.startsWith('模型 API')) throw error;
        throw new Error('模型 API 响应中断，请重试');
      }
      checkSignal();
      if (!finished) throw new Error('模型 API 响应在完成前中断，请重试');
      if (!result.trim()) throw new Error('模型 API 未返回文本回复');
      return result;
    },
  };
}

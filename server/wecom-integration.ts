import { assertPluginEnabled, pluginEnabled } from './plugins/definitions.mjs';
/**
 * 设计说明：联调反馈和通用消息共用机器人配置、脱敏、限额与串行发送，避免两个入口重复刷群。
 * 边界是手动预览发送、本机草稿模板及回执，不修改接口审核、Jira 或运行 Agent；无需额外消息队列。
 * 不引入消息队列或自动重试：超时可能已经送达，重复提醒须先核对群消息。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadIntegrationCatalog } from './integration-catalog.js';
import type { IntegrationCatalog } from '../shared/integration-catalog.js';
import type { BackendFeedbackPreview, BackendFeedbackRecord, WecomPublicConfig } from '../shared/wecom-integration.js';
import { wecomMessageLimits, type WecomMessageInput, type WecomMessagePartsPreview, type WecomMessagePreview, type WecomMessageRecord, type WecomMessageSaved, type WecomMessageType } from '../shared/wecom-messages.js';

const configurationSchema = z.object({ groupName: z.string().trim().min(1).max(80), webhook: z.string().trim().max(500).optional() }).strict();
const requiredText = z.string().trim().min(1).max(12_000);
const inputSchema = z.object({
  interfaceId: z.string().min(1).max(200), summary: z.string().trim().min(1).max(160),
  environment: z.string().trim().min(1).max(200), parameters: requiredText, actual: requiredText,
  expected: requiredText, contractReference: z.string().trim().min(1).max(2000),
  traceId: z.string().trim().max(200).default(''),
}).strict();
const sendSchema = z.object({ input: inputSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const messageInputSchema = z.object({
  title: z.string().trim().min(1).max(160), msgtype: z.enum(['text', 'markdown_v2']),
  content: z.string().refine(value => value.trim().length > 0, '请输入消息正文'),
}).strict();
const messageSendSchema = z.object({ input: messageInputSchema, previewId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const messagePartsSendSchema = z.object({
  input: messageInputSchema,
  batchId: z.uuid(),
  partIds: z.array(z.uuid()).min(1).max(10),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const reconcileUnknownSchema = z.object({
  kind: z.enum(['message', 'report']),
  id: z.uuid(),
  outcome: z.enum(['delivered', 'not_delivered']),
  note: z.string().trim().max(500).default(''),
}).strict();
const messageSavedSchema = messageInputSchema.extend({ id: z.uuid().optional(), kind: z.enum(['draft', 'template']) }).strict();
const sensitiveKey = /^(authorization|cookie|set-cookie|.*password|.*passwd|.*token|.*secret|.*api[-_]?key|webhook|key|.*phone|.*mobile|.*email|.*idcard|.*bankcard)$/i;
const secretField = '(?:authorization|cookie|set-cookie|[\\w-]*password|[\\w-]*passwd|[\\w-]*token|[\\w-]*secret|[\\w-]*api[-_]?key|webhook|key|[\\w-]*phone|[\\w-]*mobile|[\\w-]*email|[\\w-]*idcard|[\\w-]*bankcard)';

export function redactFeedback(value: string): string {
  function clean(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, data]) => [key, sensitiveKey.test(key) ? '[已脱敏]' : clean(data)]));
    return typeof input === 'string' ? redactText(input) : input;
  }
  function redactText(text: string) {
    return text.replace(/https:\/\/qyapi\.weixin\.qq\.com\/[^\s"'<>]+/gi, '[机器人地址已隐藏]')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[密钥已隐藏]')
      .replace(/^\s*(?:[-\w]*authorization|cookie|set-cookie)\s*[:=].*$/gim, '[鉴权信息已隐藏]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [已脱敏]')
      .replace(new RegExp(`(["']?${secretField}["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,\\s&;]+)`, 'gi'), '$1"[已脱敏]"')
      .replace(/<@[^>]+>/g, '[提及已移除]');
  }
  // 请求编号和其他文本不是 JSON 容器，不能按数字等标量重新序列化。
  if (!/^[\s]*[\[{]/.test(value)) return redactText(value);
  try { return JSON.stringify(clean(JSON.parse(value)), null, 2); }
  catch { return redactText(value); }
}

export function webhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请填写有效的企业微信 Webhook'); }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.port || url.username || url.password || url.hash ||
    url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key') || [...url.searchParams.keys()].some(key => key !== 'key') || url.searchParams.getAll('key').length !== 1) {
    throw new Error('Webhook 必须为企业微信群机器人的 HTTPS 发送地址');
  }
  return url.href;
}

function clip(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
  let result = '';
  for (const char of text) {
    if (Buffer.byteLength(result + char + '…', 'utf8') > bytes) break;
    result += char;
  }
  return result + '…';
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function splitWecomMessageParts(content: string, msgtype: WecomMessageType): string[] {
  const limit = wecomMessageLimits[msgtype];
  if (Buffer.byteLength(content, 'utf8') <= limit) return [content];
  // 预留【99/99】标题和代码块闭合围栏字节，保证每段独立渲染且 UTF-8 字节严格不超限。
  const chunkLimit = limit - (msgtype === 'markdown_v2' ? 40 : 28);
  const rawChunks: string[] = [];
  let current = '';
  let activeFence = '';

  const splitOversizedSegment = (segment: string, maxBytes: number): string[] => {
    const pieces: string[] = [];
    let buffer = '';
    for (const char of segment) {
      if (Buffer.byteLength(buffer + char, 'utf8') > maxBytes && buffer) {
        pieces.push(buffer);
        buffer = char;
      } else {
        buffer += char;
      }
    }
    if (buffer) pieces.push(buffer);
    return pieces;
  };

  const flush = () => {
    if (!current) return;
    rawChunks.push(activeFence ? `${current}\n\`\`\`` : current);
    current = activeFence ? `${activeFence}` : '';
  };

  for (const line of content.split('\n')) {
    const linePrefix = current ? '\n' : '';
    if (Buffer.byteLength(`${current}${linePrefix}${line}`, 'utf8') <= chunkLimit) {
      current += `${linePrefix}${line}`;
    } else {
      if (current && current !== activeFence) flush();
      const available = Math.max(120, chunkLimit - (current ? Buffer.byteLength(`${current}\n`, 'utf8') : 0));
      if (Buffer.byteLength(line, 'utf8') <= available) {
        current = current ? `${current}\n${line}` : line;
      } else {
        for (const piece of splitOversizedSegment(line, Math.max(120, chunkLimit - (activeFence ? Buffer.byteLength(`${activeFence}\n`, 'utf8') : 0)))) {
          if (current && Buffer.byteLength(`${current}\n${piece}`, 'utf8') > chunkLimit) flush();
          current = current ? `${current}\n${piece}` : piece;
        }
      }
    }
    if (msgtype === 'markdown_v2') {
      const fenceMatch = line.trimStart().match(/^(`{3,})([^\s`]*)/);
      if (fenceMatch) {
        activeFence = activeFence ? '' : `${fenceMatch[1]}${fenceMatch[2] || ''}`;
      }
    }
  }
  if (current && current !== activeFence) {
    rawChunks.push(activeFence ? `${current}\n\`\`\`` : current);
  }
  if (rawChunks.length <= 1) return rawChunks.length ? rawChunks : [content];
  if (rawChunks.length > 10) {
    throw new Error(`消息分段后共 ${rawChunks.length} 条，超过单次 10 条上限，请精简后再预览`);
  }
  return rawChunks.map((chunk, index) => `【${index + 1}/${rawChunks.length}】\n${chunk}`);
}

export async function createWecomIntegration(directory: string, options: { configFile?: string; fetch?: typeof fetch; catalog?: IntegrationCatalog } = {}) {
  const { inventory, plan } = options.catalog ?? await loadIntegrationCatalog();
  const configFile = options.configFile || process.env.DELIVERY_WECOM_CONFIG_FILE || path.join(os.homedir(), 'Library', 'Application Support', 'DeliveryWorkspace', 'credentials', 'wecom-integration.json');
  const reportsFile = path.join(directory, 'wecom-integration-reports.json');
  const messageHistoryFile = path.join(directory, 'wecom-messages-history.json');
  const messageLibraryFile = path.join(directory, 'wecom-messages-library.json');
  const operations = new Map(plan.stages.flatMap(stage => stage.operations).map(item => [item.path, item]));
  const catalog = new Map([
    ...inventory.items.map(item => [item.id, { path: item.path, method: item.contract?.method || operations.get(item.path)?.method || '', name: item.name }] as const),
    ...[...operations.values()].filter(item => !inventory.items.some(record => record.path === item.path)).map(item => [`plan:${item.operationId}`, { path: item.path, method: item.method, name: item.summary }] as const),
  ]);
  let configuration: WecomPublicConfig & { webhook: string } = { groupName: '', webhook: '', hasWebhook: false };
  try {
    // 兼容已有配置中的人员映射；读取时忽略，之后保存时移除。
    const { owners: _legacyOwners, ...stored } = JSON.parse(await fs.readFile(configFile, 'utf8'));
    const data = configurationSchema.parse(stored);
    configuration = { ...data, webhook: data.webhook ? webhookUrl(data.webhook) : '', hasWebhook: !!data.webhook };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('企业微信配置文件格式不正确，请核对群名称和 Webhook'); }
  if (!options.configFile && process.env.DELIVERY_PLUGIN_WECOM_WEBHOOK) {
    configuration = { groupName: process.env.DELIVERY_PLUGIN_WECOM_GROUP || '', webhook: webhookUrl(process.env.DELIVERY_PLUGIN_WECOM_WEBHOOK), hasWebhook: true };
  }
  let reports: BackendFeedbackRecord[] = [];
  try { reports = JSON.parse(await fs.readFile(reportsFile, 'utf8')) as BackendFeedbackRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
  async function persistMessages(file: string, value: unknown) {
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(`${file}.tmp`, 0o600);
    await fs.rename(`${file}.tmp`, file);
  }
  let messages: WecomMessageRecord[] = [];
  let library: WecomMessageSaved[] = [];
  try { messages = JSON.parse(await fs.readFile(messageHistoryFile, 'utf8')) as WecomMessageRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { library = JSON.parse(await fs.readFile(messageLibraryFile, 'utf8')) as WecomMessageSaved[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (messages.some(record => record.status === 'sending')) {
    messages = messages.map(record => record.status === 'sending' ? { ...record, status: 'unknown', message: '服务中断，群内是否送达待确认；不会自动重发' } : record);
    await persistMessages(messageHistoryFile, messages);
  }
  async function persistReports() {
    await fs.writeFile(`${reportsFile}.tmp`, JSON.stringify(reports, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(`${reportsFile}.tmp`, reportsFile);
  }
  if (reports.some(record => record.status === 'sending')) {
    reports = reports.map(record => record.status === 'sending' ? { ...record, status: 'unknown', message: '服务中断，群内是否送达待确认；不会自动重发' } : record);
    await persistReports();
  }
  // ponytail: 当前联调串行写入及发送，防止并发双击重复提醒；多群高吞吐时再按 Webhook 拆队列。
  let writes = Promise.resolve();
  const pendingMessages = new Map<string, Promise<{ record: WecomMessageRecord; message: string }>>();
  function serial<T>(task: () => Promise<T>) {
    const next = writes.then(task);
    writes = next.then(() => {}, () => {});
    return next;
  }
  function config(): WecomPublicConfig {
    return structuredClone({ hasWebhook: !!configuration.webhook, groupName: redactMessage(configuration.groupName) });
  }
  function redactMessage(value: string): string {
    const key = configuration.webhook ? new URL(configuration.webhook).searchParams.get('key') : '';
    return redactFeedback(key ? value.replaceAll(key, '[密钥已隐藏]') : value);
  }
  function messageInput(value: unknown): WecomMessageInput {
    const raw = messageInputSchema.parse(value);
    const limit = wecomMessageLimits[raw.msgtype];
    if (Buffer.byteLength(raw.content, 'utf8') > limit) throw new Error(`消息正文超过 ${limit} 字节，请精简后重新预览`);
    const input = messageInputSchema.parse({ ...raw, title: redactMessage(raw.title), content: redactMessage(raw.content) });
    if (Buffer.byteLength(input.content, 'utf8') > limit) throw new Error(`消息正文超过 ${limit} 字节，请精简后重新预览`);
    return input;
  }
  function messageSnapshot(value: unknown, previewId: string): WecomMessagePreview {
    const input = messageInput(value);
    const snapshot = { input, previewId, groupName: redactMessage(configuration.groupName), content: input.content,
      bytes: Buffer.byteLength(input.content, 'utf8'), limit: wecomMessageLimits[input.msgtype], canSend: !!configuration.webhook && pluginEnabled('wecom') };
    return { ...snapshot, hash: hash({ snapshot, webhook: hash(configuration.webhook), groupName: configuration.groupName }) };
  }
  function messagePartsSnapshot(value: unknown, batchId: string, partIds?: string[]): WecomMessagePartsPreview {
    const raw = messageInputSchema.parse(value);
    if (Buffer.byteLength(raw.content, 'utf8') > 36_000) throw new Error('单次分段消息总长度不能超过 36000 字节');
    const redactedTitle = redactMessage(raw.title);
    const redactedContent = redactMessage(raw.content);
    const chunks = splitWecomMessageParts(redactedContent, raw.msgtype);
    if (partIds && partIds.length !== chunks.length) throw new Error('消息分段数量已变化，请重新预览');
    const parts = chunks.map((chunk, index) => messageSnapshot({
      title: chunks.length > 1 ? `${redactedTitle.slice(0, 140)} (${index + 1}/${chunks.length})` : redactedTitle,
      msgtype: raw.msgtype,
      content: chunk,
    }, partIds?.[index] || randomUUID()));
    const base = {
      batchId,
      title: redactedTitle,
      msgtype: raw.msgtype,
      groupName: redactMessage(configuration.groupName),
      totalBytes: Buffer.byteLength(redactedContent, 'utf8'),
      partCount: parts.length,
      canSend: !!configuration.webhook && pluginEnabled('wecom'),
      parts,
    };
    return { ...base, hash: hash({ base, webhook: hash(configuration.webhook), groupName: configuration.groupName }) };
  }
  function checkRateLimit(needed = 1) {
    const attempts = [...reports, ...messages].map(record => Date.parse(record.attemptedAt)).filter(time => time > Date.now() - 60_000).sort((a, b) => b - a);
    if (attempts.length + needed > 10) {
      const oldestBlocking = attempts[Math.max(0, 10 - needed)] ?? attempts.at(-1) ?? Date.now();
      throw Object.assign(new Error('本机器人每分钟最多提交 10 条消息或反馈，请稍后发送'), {
        code: 'WECOM_LOCAL_RATE_LIMIT', retryAfterMs: Math.max(1, Math.min(60_000, oldestBlocking + 60_001 - Date.now())),
      });
    }
  }
  function classifyHttpRejection(status: number) {
    // 4xx 为群机器人入口明确拒绝（请求未送达群内），标记为 failed 允许修订或重试；5xx 网关结果不明保留 unknown。
    return status >= 400 && status < 500
      ? { status: 'failed' as const, message: `机器人请求被拒绝（HTTP ${status}），消息未送达，核对后可重新发送` }
      : { status: 'unknown' as const, message: `机器人 HTTP ${status}，群内送达情况待确认；不会自动重发` };
  }
  function preview(value: unknown): BackendFeedbackPreview {
    const raw = inputSchema.parse(value);
    const item = catalog.get(raw.interfaceId);
    if (!item || !item.method) throw new Error('接口不在联调清单内或请求方法尚未确认');
    const input = { ...raw, summary: redactFeedback(raw.summary), environment: redactFeedback(raw.environment), parameters: redactFeedback(raw.parameters), actual: redactFeedback(raw.actual), expected: redactFeedback(raw.expected), contractReference: redactFeedback(raw.contractReference), traceId: redactFeedback(raw.traceId) };
    const request = `${item.method.toUpperCase()} ${item.path}`;
    const sections: [string, string, number][] = [
      ['APEX 后端联调问题', input.summary, 150], ['环境', input.environment, 70], ['接口请求', request, 220],
      ['请求参数', input.parameters, 260], ['实际返回', input.actual, 280], ['预期结果', input.expected, 280],
      ['契约依据', input.contractReference, 150], ['traceId', input.traceId || '未提供', 90],
    ];
    const content = sections.map(([label, text, size]) => `${label}：${clip(text, size)}`).join('\n');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 1850) throw new Error('消息摘要过长，请精简后重新预览');
    const snapshot = { input, request, groupName: config().groupName, content, bytes, truncated: sections.some(([, text, size]) => Buffer.byteLength(text) > size), canSend: !!configuration.webhook && pluginEnabled('wecom') };
    return { ...snapshot, hash: hash({ snapshot, webhook: hash(configuration.webhook) }) };
  }
  return {
    config,
    sanitizeContent: redactMessage,
    configure: (value: unknown) => serial(async () => {
      if (!options.configFile && process.env.DELIVERY_PLUGIN_WECOM_WEBHOOK) throw new Error('此机器人由插件管理，请到设置中的接入插件修改并重启');
      const data = configurationSchema.parse(value);
      const webhook = data.webhook ? webhookUrl(data.webhook) : configuration.webhook;
      if (!webhook) throw new Error('首次配置需要填写企业微信群机器人 Webhook');
      await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${configFile}.tmp`, JSON.stringify({ groupName: data.groupName, webhook }, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(`${configFile}.tmp`, configFile);
      configuration = { groupName: data.groupName, webhook, hasWebhook: true };
      return { ...config(), message: '企业微信机器人配置已保存，尚未发送消息' };
    }),
    preview,
    history: (interfaceId: string) => structuredClone(reports.filter(record => !interfaceId || record.preview.input.interfaceId === interfaceId).slice(-100).reverse()),
    messagePreview: (value: unknown): WecomMessagePreview => messageSnapshot(value, randomUUID()),
    messagePartsPreview: (value: unknown): WecomMessagePartsPreview => messagePartsSnapshot(value, randomUUID()),
    messageHistory: (): WecomMessageRecord[] => structuredClone(messages.slice(-100).reverse()),
    messageLibrary: (): WecomMessageSaved[] => structuredClone([...library].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
    saveMessage: (value: unknown): Promise<WecomMessageSaved> => serial(async () => {
      const data = messageSavedSchema.parse(value);
      const input = messageInput({ title: data.title, msgtype: data.msgtype, content: data.content });
      if (data.id && !library.some(item => item.id === data.id)) throw new Error('草稿或模板不存在，请刷新后重试');
      const saved = { ...input, id: data.id || randomUUID(), kind: data.kind, updatedAt: new Date().toISOString() };
      const next = [...library.filter(item => item.id !== saved.id), saved];
      await persistMessages(messageLibraryFile, next);
      library = next;
      return structuredClone(saved);
    }),
    deleteMessage: (value: unknown) => serial(async () => {
      const data = z.object({ id: z.uuid() }).strict().parse(value);
      if (!library.some(item => item.id === data.id)) throw new Error('草稿或模板不存在，请刷新后重试');
      const next = library.filter(item => item.id !== data.id);
      await persistMessages(messageLibraryFile, next);
      library = next;
      return { message: '草稿或模板已删除' };
    }),
    sendMessage: async (value: unknown) => {
      const data = messageSendSchema.parse(value);
      const submission = hash(data);
      const pending = pendingMessages.get(submission);
      if (pending) return pending;
      const attempt = serial(async () => {
        assertPluginEnabled('wecom');
        const snapshot = messageSnapshot(data.input, data.previewId);
        if (!snapshot.canSend) throw new Error('请配置群机器人');
        if (snapshot.hash !== data.hash) throw new Error('消息内容或机器人配置已变化，请重新预览');
        const duplicate = messages.find(record => record.fingerprint === snapshot.hash && record.status !== 'failed');
        if (duplicate) return { record: structuredClone(duplicate), message: '此预览已提交过，未重复发送；请核对群内消息' };
        checkRateLimit(1);
        const record: WecomMessageRecord = { id: randomUUID(), fingerprint: snapshot.hash, preview: snapshot, status: 'sending', attemptedAt: new Date().toISOString(), finishedAt: '', message: '' };
        messages.push(record);
        await persistMessages(messageHistoryFile, messages);
        try {
          const response = await (options.fetch || fetch)(configuration.webhook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ msgtype: snapshot.input.msgtype, [snapshot.input.msgtype]: { content: snapshot.content } }),
          });
          if (!response.ok) {
            const rejected = classifyHttpRejection(response.status);
            record.status = rejected.status; record.message = rejected.message;
          } else {
            const reply = z.object({ errcode: z.number(), errmsg: z.string().optional() }).parse(await response.json());
            record.status = reply.errcode === 0 ? 'sent' : 'failed';
            record.message = reply.errcode === 0 ? '机器人已接收消息，请到群内核对' : `企业微信返回 ${reply.errcode}：${redactMessage(reply.errmsg || '未提供说明')}`;
          }
        } catch {
          record.status = 'unknown'; record.message = '发送异常或超时，群内是否送达待确认；不会自动重发';
        }
        record.finishedAt = new Date().toISOString();
        await persistMessages(messageHistoryFile, messages);
        return { record: structuredClone(record), message: record.message };
      });
      pendingMessages.set(submission, attempt);
      try { return await attempt; }
      finally { pendingMessages.delete(submission); }
    },
    sendMessageParts: (value: unknown) => serial(async () => {
      assertPluginEnabled('wecom');
      const data = messagePartsSendSchema.parse(value);
      const batch = messagePartsSnapshot(data.input, data.batchId, data.partIds);
      if (!batch.canSend) throw new Error('请配置群机器人');
      if (batch.hash !== data.hash) throw new Error('分段消息内容或机器人配置已变化，请重新预览');
      const pendingParts = batch.parts.filter(part => !messages.some(record => record.fingerprint === part.hash && record.status !== 'failed'));
      if (!pendingParts.length) {
        const existing = batch.parts.map(part => messages.find(record => record.fingerprint === part.hash && record.status !== 'failed')!).filter(Boolean);
        return { records: structuredClone(existing), message: '此分段预览已提交过，未重复发送；请核对群内消息' };
      }
      checkRateLimit(pendingParts.length);
      const sentRecords: WecomMessageRecord[] = [];
      for (const snapshot of batch.parts) {
        const existing = messages.find(record => record.fingerprint === snapshot.hash && record.status !== 'failed');
        if (existing) {
          sentRecords.push(structuredClone(existing));
          if (existing.status !== 'sent') break;
          continue;
        }
        const record: WecomMessageRecord = { id: randomUUID(), fingerprint: snapshot.hash, preview: snapshot, status: 'sending', attemptedAt: new Date().toISOString(), finishedAt: '', message: '' };
        messages.push(record);
        await persistMessages(messageHistoryFile, messages);
        try {
          const response = await (options.fetch || fetch)(configuration.webhook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ msgtype: snapshot.input.msgtype, [snapshot.input.msgtype]: { content: snapshot.content } }),
          });
          if (!response.ok) {
            const rejected = classifyHttpRejection(response.status);
            record.status = rejected.status; record.message = rejected.message;
          } else {
            const reply = z.object({ errcode: z.number(), errmsg: z.string().optional() }).parse(await response.json());
            record.status = reply.errcode === 0 ? 'sent' : 'failed';
            record.message = reply.errcode === 0 ? '机器人已接收消息，请到群内核对' : `企业微信返回 ${reply.errcode}：${redactMessage(reply.errmsg || '未提供说明')}`;
          }
        } catch {
          record.status = 'unknown'; record.message = '发送异常或超时，群内是否送达待确认；不会自动重发';
        }
        record.finishedAt = new Date().toISOString();
        await persistMessages(messageHistoryFile, messages);
        sentRecords.push(structuredClone(record));
        if (record.status !== 'sent') break;
      }
      const allSent = sentRecords.length === batch.parts.length && sentRecords.every(item => item.status === 'sent');
      const last = sentRecords.at(-1);
      return {
        records: sentRecords,
        message: allSent ? `共 ${batch.parts.length} 段消息已全部接收，请到群内核对` : `分段发送在第 ${sentRecords.length}/${batch.parts.length} 段停止：${last?.message || '请核对群内消息'}`,
      };
    }),
    send: (value: unknown) => serial(async () => {
      assertPluginEnabled('wecom');
      const data = sendSchema.parse(value);
      const snapshot = preview(data.input);
      if (!snapshot.canSend) throw new Error('请配置群机器人');
      if (snapshot.hash !== data.hash) throw new Error('反馈内容或机器人配置已变化，请重新预览');
      const duplicate = reports.find(record => record.fingerprint === snapshot.hash && record.status !== 'failed');
      if (duplicate) return { record: structuredClone(duplicate), message: '相同反馈已提交过，未重复发送；请核对群内消息' };
      checkRateLimit(1);
      const record: BackendFeedbackRecord = { id: randomUUID(), fingerprint: snapshot.hash, preview: snapshot, status: 'sending', attemptedAt: new Date().toISOString(), finishedAt: '', message: '' };
      reports.push(record);
      await persistReports();
      try {
        const response = await (options.fetch || fetch)(configuration.webhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ msgtype: 'text', text: { content: snapshot.content } }),
        });
        if (!response.ok) {
          const rejected = classifyHttpRejection(response.status);
          record.status = rejected.status; record.message = rejected.message;
        } else {
          const reply = z.object({ errcode: z.number(), errmsg: z.string().optional() }).parse(await response.json());
          record.status = reply.errcode === 0 ? 'sent' : 'failed';
          record.message = reply.errcode === 0 ? '机器人已接收反馈，请到群内核对消息' : `企业微信返回 ${reply.errcode}：${redactFeedback(reply.errmsg || '未提供说明').replaceAll(new URL(configuration.webhook).searchParams.get('key')!, '[密钥已隐藏]')}`;
        }
      } catch {
        record.status = 'unknown'; record.message = '发送异常或超时，群内是否送达待确认；不会自动重发';
      }
      record.finishedAt = new Date().toISOString();
      await persistReports();
      return { record: structuredClone(record), message: record.message };
    }),
    reconcileUnknown: (value: unknown) => serial(async () => {
      const data = reconcileUnknownSchema.parse(value);
      const note = data.note ? redactMessage(data.note) : '';
      const reconciledAt = new Date().toISOString();
      if (data.kind === 'message') {
        const record = messages.find(item => item.id === data.id);
        if (!record) throw new Error('消息记录不存在，请刷新后重试');
        if (record.status !== 'unknown') throw new Error('当前消息记录不处于结果待确认状态，无需人工解除');
        record.status = data.outcome === 'delivered' ? 'sent' : 'failed';
        record.reconciledAt = reconciledAt;
        record.reconcileNote = note;
        record.message = data.outcome === 'delivered'
          ? `已人工核对确认群内已送达${note ? `：${note}` : ''}`
          : `已人工核对确认群内未送达，已解除重复保护${note ? `：${note}` : ''}`;
        await persistMessages(messageHistoryFile, messages);
        return { record: structuredClone(record), message: record.message };
      }
      const record = reports.find(item => item.id === data.id);
      if (!record) throw new Error('联调反馈记录不存在，请刷新后重试');
      if (record.status !== 'unknown') throw new Error('当前联调反馈记录不处于结果待确认状态，无需人工解除');
      record.status = data.outcome === 'delivered' ? 'sent' : 'failed';
      record.reconciledAt = reconciledAt;
      record.reconcileNote = note;
      record.message = data.outcome === 'delivered'
        ? `已人工核对确认群内已送达${note ? `：${note}` : ''}`
        : `已人工核对确认群内未送达，已解除重复保护${note ? `：${note}` : ''}`;
      await persistReports();
      return { record: structuredClone(record), message: record.message };
    }),
    close: () => writes,
  };
}

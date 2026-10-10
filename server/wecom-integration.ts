/**
 * 设计说明：联调问题通过一个服务端出口发送，集中保护 Webhook、脱敏与群消息回执。
 * 边界是通知及回执，不修改接口审核、Jira 或运行 Agent；本机文件和串行发送足够承接当前两人联调。
 * 不引入消息队列或自动重试：超时可能已经送达，重复提醒须先核对群消息。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadIntegrationCatalog } from './integration-catalog.js';
import type { BackendFeedbackPreview, BackendFeedbackRecord, WecomPublicConfig } from '../shared/wecom-integration.js';

const configurationSchema = z.object({ groupName: z.string().trim().min(1).max(80), webhook: z.string().trim().max(500).optional() }).strict();
const requiredText = z.string().trim().min(1).max(12_000);
const inputSchema = z.object({
  interfaceId: z.string().min(1).max(200), summary: z.string().trim().min(1).max(160),
  environment: z.string().trim().min(1).max(200), parameters: requiredText, actual: requiredText,
  expected: requiredText, contractReference: z.string().trim().min(1).max(2000),
  traceId: z.string().trim().max(200).default(''),
}).strict();
const sendSchema = z.object({ input: inputSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
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

export async function createWecomIntegration(directory: string, options: { configFile?: string; fetch?: typeof fetch } = {}) {
  const { inventory, plan } = await loadIntegrationCatalog();
  const configFile = options.configFile || process.env.DELIVERY_WECOM_CONFIG_FILE || path.join(directory, 'credentials', 'wecom-integration.json');
  const reportsFile = path.join(directory, 'wecom-integration-reports.json');
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
  let reports: BackendFeedbackRecord[] = [];
  try { reports = JSON.parse(await fs.readFile(reportsFile, 'utf8')) as BackendFeedbackRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
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
  function serial<T>(task: () => Promise<T>) {
    const next = writes.then(task);
    writes = next.then(() => {}, () => {});
    return next;
  }
  function config(): WecomPublicConfig {
    return structuredClone({ hasWebhook: !!configuration.webhook, groupName: configuration.groupName });
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
    const snapshot = { input, request, groupName: configuration.groupName, content, bytes, truncated: sections.some(([, text, size]) => Buffer.byteLength(text) > size), canSend: !!configuration.webhook };
    return { ...snapshot, hash: hash({ snapshot, webhook: hash(configuration.webhook) }) };
  }
  return {
    config,
    configure: (value: unknown) => serial(async () => {
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
    send: (value: unknown) => serial(async () => {
      const data = sendSchema.parse(value);
      const snapshot = preview(data.input);
      if (!snapshot.canSend) throw new Error('请配置群机器人');
      if (snapshot.hash !== data.hash) throw new Error('反馈内容或机器人配置已变化，请重新预览');
      const duplicate = reports.find(record => record.fingerprint === snapshot.hash && record.status !== 'failed');
      if (duplicate) return { record: structuredClone(duplicate), message: '相同反馈已提交过，未重复发送；请核对群内消息' };
      if (reports.filter(record => Date.parse(record.attemptedAt) > Date.now() - 60_000).length >= 10) throw new Error('本机器人每分钟最多提交 10 条反馈，请稍后发送');
      const record: BackendFeedbackRecord = { id: randomUUID(), fingerprint: snapshot.hash, preview: snapshot, status: 'sending', attemptedAt: new Date().toISOString(), finishedAt: '', message: '' };
      reports.push(record);
      await persistReports();
      try {
        const response = await (options.fetch || fetch)(configuration.webhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ msgtype: 'text', text: { content: snapshot.content } }),
        });
        if (!response.ok) {
          record.status = 'unknown'; record.message = `机器人 HTTP ${response.status}，群内送达情况待确认；不会自动重发`;
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
    close: () => writes,
  };
}

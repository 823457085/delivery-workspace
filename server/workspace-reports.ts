/** 基于真实任务快照生成确定性报告；沿用机器人脱敏和发送回执，不调用模型或扩大任务授权。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactFeedback } from './wecom-integration.js';
import type { WecomPublicConfig } from '../shared/wecom-integration.js';
import type { WecomMessageInput, WecomMessagePreview, WecomMessageRecord } from '../shared/wecom-messages.js';
import { defaultReportPolicy, reportPolicySchema, workspaceReportSettingsSchema, reportSectionLabels, reportSourceLabels,
  type ReportPolicy, type ReportTask, type ReportSnapshot, type ReportPreview, type ReportRun, type ReportCounts,
  type ReportSection, type WorkspaceReportSettings, type WorkspaceReportsDashboard } from '../shared/workspace-reports.js';

export interface ReportBot {
  config(): WecomPublicConfig;
  sanitizeContent(value: string): string;
  configure(input: unknown): Promise<WecomPublicConfig & { message: string }>;
  messagePreview(input: WecomMessageInput): WecomMessagePreview;
  sendMessage(input: { input: WecomMessageInput; previewId: string; hash: string }): Promise<{ record: WecomMessageRecord; message: string }>;
}
export interface WorkspaceReportOptions {
  bots: { integration: ReportBot; dedicated: ReportBot };
  readSnapshot(): ReportSnapshot | Promise<ReportSnapshot>;
  now?: () => Date;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}
const categories = ['doing', 'todo', 'blocked', 'review', 'completed'] as const;
function localClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, time: `${value('hour')}:${value('minute')}`, weekday: day || 7 };
}
function text(value: string) { return redactFeedback(value).replace(/\r/g, '').trim(); }
function taskLink(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return text(url.href).replace(/[()]/g, char => char === '(' ? '%28' : '%29');
  } catch { return ''; }
}
function taskTitle(task: ReportTask) {
  const title = text(task.title), key = title.match(/^([A-Z][A-Z0-9_]*-\d+)\b/)?.[1], href = taskLink(task.jiraUrl) || taskLink(task.url);
  return key && href ? `[${key}](${href})${title.slice(key.length)}` : title;
}
function daysUntil(due: string | undefined, date: string) {
  const day = due?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day) return undefined;
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) return undefined;
  return (timestamp - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
}
function taskLine(task: ReportTask, date: string, inlineNext: boolean) {
  const title = taskTitle(task);
  const state = text(task.status);
  const detail = text(task.detail || '');
  const href = taskLink(task.url), titleHref = title !== text(task.title) ? taskLink(task.jiraUrl) || href : '';
  const days = task.category === 'completed' ? undefined : daysUntil(task.dueDate, date);
  const urgency = days === 0 ? '（今天）' : days === 1 ? '（明天）' : days !== undefined && days < 0 ? `（已超期 ${-days} 天）` : '';
  const reference = href && href !== titleHref ? `\n  [查看任务](${href})` : task.url?.startsWith('/') ? `\n  电脑工作台：${text(task.url)}` : '';
  return `- **${title}**\n  当前状态：${state}${task.dueDate ? ` · 截止：${text(task.dueDate)}${urgency}` : ''}${inlineNext && task.category !== 'completed' && task.nextAction?.trim() ? `\n  下一步：${text(task.nextAction)}` : ''}${detail ? `\n  说明：${detail}` : ''}${reference}`;
}
/** 优先保持任务段落完整，超长段落再按行和 Unicode 字符分段；链接不拆开、正文不裁剪。 */
export function splitReportMarkdown(content: string): string[] {
  const budget = 3968, parts: string[] = [];
  let current = '';
  const append = (token: string) => {
    const bytes = Buffer.byteLength(token, 'utf8');
    if (bytes > budget) throw new Error('报告中的单个链接超过消息上限，请核对该链接');
    if (current && Buffer.byteLength(current + token, 'utf8') > budget) { parts.push(current); current = ''; }
    current += token;
  };
  for (const paragraph of content.split(/(?<=\n\n)/u)) {
    if (Buffer.byteLength(paragraph, 'utf8') <= budget) append(paragraph);
    else for (const line of paragraph.split(/(?<=\n)/u)) {
      if (Buffer.byteLength(line, 'utf8') <= budget) append(line);
      else for (const token of line.matchAll(/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s]+|[\s\S]/gu)) append(token[0]);
    }
  }
  if (current) parts.push(current);
  return parts;
}
function overdue(task: ReportTask, date: string) {
  const due = task.dueDate?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return !!due && due < date && task.category !== 'completed';
}

/** 个人群只发需要本人处理的事项。Jira 分组按原始 Jira 状态，不受关联会话的状态影响。 */
export function renderPersonalTaskReport(snapshot: ReportSnapshot, policy: ReportPolicy) {
  const clock = localClock(new Date(snapshot.generatedAt), policy.timeZone);
  const jiraTasks = snapshot.jiraTasks ?? snapshot.tasks.filter(task => task.source === 'jira');
  const personalSources = policy.sources.filter(source => source === 'jira' || source === 'manual');
  const coverage = personalSources.flatMap(source => {
    const records = snapshot.coverage.filter(item => item.source === source);
    return records.length ? records : [{ source, label: reportSourceLabels[source], available: false }];
  });
  const tasks = [...jiraTasks, ...snapshot.tasks.filter(task => task.source === 'manual')]
    .filter(task => personalSources.some(source => task.source === source) && policy.sections.includes(task.category))
    .filter(task => !policy.projectFilter || (task.project || '').toLocaleLowerCase().includes(policy.projectFilter.toLocaleLowerCase()))
    .filter(task => !/^(?:已取消|取消|cancelled|canceled)$/i.test(task.status.trim()))
    .filter(task => {
      if (task.category !== 'completed') return true;
      const finished = new Date(task.completedAt || task.updatedAt);
      return Number.isFinite(finished.getTime()) && localClock(finished, policy.timeZone).date === clock.date;
    });
  const counts = Object.fromEntries(categories.map(category => [category, tasks.filter(task => task.category === category).length])) as ReportCounts;
  const incomplete = tasks.filter(task => task.category !== 'completed');
  const jira = incomplete.filter(task => task.source === 'jira');
  const ranked = jira.map(task => ({ task, days: daysUntil(task.dueDate, clock.date) }));
  const byDeadline = (a: typeof ranked[number], b: typeof ranked[number]) =>
    (a.days ?? Infinity) - (b.days ?? Infinity) || b.task.updatedAt.localeCompare(a.task.updatedAt);
  const past = ranked.filter(row => row.days !== undefined && row.days < 0).sort(byDeadline);
  const soon = ranked.filter(row => row.days === 0 || row.days === 1).sort(byDeadline);
  const later = ranked.filter(row => row.days === undefined || row.days > 1).sort(byDeadline);
  const developing = (row: typeof ranked[number]) => /开发中|开发进行中|正在开发|\bin development\b|\bdeveloping\b/i.test(row.task.status);
  const escape = (value: string) => text(value).replace(/\s*\n\s*/g, ' ').replace(/[\\*_`\[\]<>]/g, '\\$&');
  function jiraLine({ task, days }: typeof ranked[number]) {
    const title = text(task.title);
    const key = title.match(/^([A-Z][A-Z0-9_]*-\d+)\b/)?.[1];
    const href = taskLink(task.jiraUrl) || taskLink(task.url);
    const label = key && href ? `[${escape(key)}](${href}) ${escape(title.slice(key.length))}` : escape(title);
    const due = days === undefined ? '' : days < 0 ? `超期 ${-days} 天`
      : days === 0 ? '今天到期' : days === 1 ? '明天到期' : `${task.dueDate!.slice(5, 10)} 到期`;
    return `- ${label} · ${escape(task.status)}${due ? ` · ${due}` : ''}`;
  }
  const manual = incomplete.filter(task => task.source === 'manual');
  const groups = [
    { title: '已超期', lines: past.map(jiraLine), jira: true },
    { title: '今天或明天到期', lines: soon.map(jiraLine), jira: true },
    { title: '开发中', lines: later.filter(developing).map(jiraLine), jira: true },
    { title: '其他未完成', lines: later.filter(row => !developing(row)).map(jiraLine), jira: true },
    { title: '个人待办', lines: manual.map(task => `- ${escape(task.title)}`), jira: false },
  ];
  const missing = [...new Set(coverage.filter(item => !item.available).map(item => reportSourceLabels[item.source]))];
  const completedJira = tasks.filter(task => task.source === 'jira' && task.category === 'completed').length;
  const jiraIncomplete = missing.includes(reportSourceLabels.jira);
  const sections = groups.filter(group => group.lines.length).map(group =>
    [`${group.jira ? '###' : '##'} ${group.title}（${group.lines.length}）`, ...group.lines].join('\n'));
  const jiraCount = jiraIncomplete ? `已读取 ${jira.length} 项未完成` : `${jira.length} 项未完成`;
  const jiraHeader = personalSources.includes('jira') && (!jiraIncomplete || jira.length || completedJira)
    ? `## Jira 任务\n${jiraCount}${!jiraIncomplete && !past.length ? ' · 无超期' : ''}${completedJira ? ` · 今天完成 ${completedJira} 项` : ''}` : '';
  const fullContent = [`## 个人任务提醒\n${clock.date} ${clock.time}`, jiraHeader, ...sections,
    missing.length ? `${missing.join('、')}未能完整读取，以上为已读取的事项。` : ''].filter(Boolean).join('\n\n');
  return { fullContent, content: fullContent, counts, coverage, truncated: false };
}
/** completed 仅包含策略时区当天的明确完成记录；状态和业务标题保留来源原文。 */
export function renderWorkspaceReport(snapshot: ReportSnapshot, policy: ReportPolicy) {
  const clock = localClock(new Date(snapshot.generatedAt), policy.timeZone);
  const tasks = snapshot.tasks.filter(task => (policy.sources.includes(task.source) || task.relatedSources?.some(source => policy.sources.includes(source)))
    && (!policy.projectFilter || (task.project || '').toLocaleLowerCase().includes(policy.projectFilter.toLocaleLowerCase()))
    && (policy.kind !== 'overdue' || overdue(task, clock.date))
    && (task.category !== 'completed' || (() => {
      const timestamp = new Date(task.completedAt || task.updatedAt);
      return Number.isFinite(timestamp.getTime()) && localClock(timestamp, policy.timeZone).date === clock.date;
    })()));
  const counts = Object.fromEntries(categories.map(category => [category, tasks.filter(task => task.category === category).length])) as ReportCounts;
  const coverage = policy.sources.flatMap(source => { const entries = snapshot.coverage.filter(item => item.source === source); return entries.length ? entries : [{ source, label: reportSourceLabels[source], available: false, detail: '来源未提供读取状态，不能认定没有任务' }]; });
  const groups = Object.fromEntries(categories.map(category => [category, tasks.filter(task => task.category === category)])) as Record<typeof categories[number], ReportTask[]>;
  const next = tasks.filter(task => task.category !== 'completed' && task.nextAction?.trim());
  const inlineNext = !policy.template.trim() && policy.sections.includes('next') && next.every(task => policy.sections.includes(task.category));
  const coverageContent = coverage.length ? coverage.map(item => `- ${text(item.label)}：${item.available ? '已读取' : '未能读取'}${item.detail ? `；${text(item.detail)}` : ''}`).join('\n') : '未提供来源覆盖信息，不能据此认定没有任务。';
  const dueDays = tasks.filter(task => task.category !== 'completed').map(task => daysUntil(task.dueDate, clock.date));
  const deadlines = [[dueDays.filter(day => day !== undefined && day < 0).length, '项已超期'], [dueDays.filter(day => day === 0).length, '项今天截止'], [dueDays.filter(day => day === 1).length, '项明天截止']]
    .filter(([count]) => !!count).map(([count, label]) => `${count} ${label}`).join('，');
  const zone = ['Asia/Singapore', 'Asia/Shanghai'].includes(policy.timeZone) ? '新加坡 / 北京时间' : policy.timeZone;
  const header = `**${text(policy.name)}**\n${clock.date} ${clock.time}（${zone}）\n\n待办 ${counts.todo} 项 · 卡住 ${counts.blocked} 项 · 等你确认 ${counts.review} 项\n正在进行 ${counts.doing} 项 · 今天已完成 ${counts.completed} 项${deadlines ? `\n**截止提醒：${deadlines}。**` : ''}${!tasks.length ? '\n本次没有查到符合条件的任务。' : ''}${coverage.some(item => !item.available) ? '\n统计仅含已读取来源，缺失来源不计为零；请同时查看末尾未能读取的项目。' : ''}`;
  function section(section: ReportSection) {
    if (section === 'coverage') return coverageContent;
    const items = section === 'next' ? next : groups[section];
    if (!items.length) return section === 'next' ? '来源未提供明确下一步，待补充。' : '当前已读取来源中没有符合条件的记录。';
    return items.map(task => section === 'next' ? `- ${taskTitle(task)}：${text(task.nextAction!)}` : taskLine(task, clock.date, inlineNext)).join('\n\n');
  }
  const selected = [...new Set([...policy.sections, 'coverage' as const])];
  const blocks = Object.fromEntries(Object.keys(reportSectionLabels).map(key => [key, section(key as ReportSection)]));
  let body: string;
  if (policy.template.trim()) {
    const placeholders = new Set([...policy.template.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]));
    body = policy.template.replace(/\{([^{}]+)\}/g, (_, key: string) => key === 'date' ? clock.date : blocks[key]);
    const missing = selected.filter(key => !placeholders.has(key));
    if (missing.length) body += '\n\n' + missing.map(key => `## ${reportSectionLabels[key]}\n${blocks[key]}`).join('\n\n');
  } else {
    const order: ReportSection[] = ['blocked', 'todo', 'review', 'doing', 'completed', 'next', 'coverage'];
    body = order.filter(key => selected.includes(key) && (key === 'coverage' || (key === 'next' ? next.length > 0 && !inlineNext : groups[key].length > 0)))
      .map(key => `## ${reportSectionLabels[key]}${key === 'coverage' ? '' : `（${key === 'next' ? next.length : groups[key].length}项）`}\n${key === 'review' ? '请打开任务核对结果或待确认的问题；有 AI 执行结果的事项，还需要你确认是否通过。\n\n' : ''}${blocks[key]}`).join('\n\n');
  }
  const fullContent = text(`${header}\n\n${body}`);
  return { fullContent, content: fullContent, counts, coverage, truncated: false };
}
interface StoredPreview { value: ReportPreview; policy: ReportPolicy; messages?: WecomMessagePreview[] }
interface ReportState { version: 1; settings: WorkspaceReportSettings; previews: StoredPreview[]; history: ReportRun[]; slots: Record<string, string> }
const policyContent = (policy: ReportPolicy) => JSON.stringify({ ...policy, enabledAt: undefined });
const sendInput = z.object({ previewId: z.uuid() }).strict();
const previewInput = z.object({ policyId: z.string().optional(), policy: reportPolicySchema.optional() }).strict().refine(value => !!value.policyId !== !!value.policy, '请选择已保存策略或提供策略草稿');

export async function createWorkspaceReports(directory: string, options: WorkspaceReportOptions) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'workspace-reports.json'), reports = path.join(directory, 'reports');
  if (await fs.lstat(file).then(stat => stat.isSymbolicLink(), () => false)) throw new Error('汇报状态文件不能是符号链接');
  const now = options.now || (() => new Date());
  let state: ReportState = { version: 1, settings: { policies: [defaultReportPolicy()], botTarget: 'dedicated', confirmedGroupName: '' }, previews: [], history: [], slots: {} };
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as ReportState;
    if (value.version !== 1 || !Array.isArray(value.previews) || !Array.isArray(value.history) || !value.slots || typeof value.slots !== 'object') throw new Error('汇报状态格式错误');
    state = { ...value, settings: workspaceReportSettingsSchema.parse(value.settings) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  async function write(target: string, value: unknown) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  const persist = () => write(file, state);
  if (state.history.some(run => run.status === 'sending')) {
    state.history = state.history.map(run => run.status === 'sending' ? { ...run, status: 'unknown', finishedAt: now().toISOString(),
      parts: run.parts?.map(part => part.status === 'sending' ? { ...part, status: 'unknown' as const, finishedAt: now().toISOString() } : part),
      message: '服务中断，送达状态待确认；不会自动重发' } : run);
    await persist();
  }
  let timer: ReturnType<typeof setInterval> | undefined, closing = false, running = 0, queue = Promise.resolve();
  let pendingTick: Promise<void> | undefined;
  function serial<T>(task: () => Promise<T>) {
    if (closing) return Promise.reject(new Error('汇报服务正在关闭'));
    running++;
    const next = queue.then(task);
    queue = next.then(() => { running--; }, () => { running--; });
    return next;
  }
  function bot() { return options.bots[state.settings.botTarget]; }
  function confirmed() { const config = bot().config(); return config.hasWebhook && !!config.groupName && state.settings.confirmedGroupName === config.groupName; }
  function dashboard(): WorkspaceReportsDashboard {
    return structuredClone({ settings: state.settings, bots: { integration: options.bots.integration.config(), dedicated: options.bots.dedicated.config() },
      history: [...state.history].reverse().slice(0, 100), running: running > 0,
      scheduler: { online: !!timer && !closing, note: '工作台服务在线时按时区调度；关闭或电脑休眠期间不会发送。恢复后只处理当天最近一个已启用时段，不补发历史日期；送达未知不自动重发。' } });
  }
  async function prepare(policy: ReportPolicy): Promise<StoredPreview> {
    const snapshot = await options.readSnapshot();
    const personal = state.settings.confirmedGroupName === '个人任务' && bot().config().groupName === '个人任务'
      && policy.kind === 'summary' && !policy.template.trim();
    const rendered = personal ? renderPersonalTaskReport(snapshot, policy) : renderWorkspaceReport(snapshot, policy);
    const bodies = splitReportMarkdown(bot().sanitizeContent(rendered.fullContent));
    const prefixes = bodies.map((_, index) => bodies.length > 1 ? `**完整汇报 · ${index + 1}/${bodies.length}**\n\n` : '');
    const messages = bodies.map((body, index) => {
      const input: WecomMessageInput = { title: text(policy.name), msgtype: 'markdown_v2', content: prefixes[index] + body };
      return bot().messagePreview(input);
    });
    const fullContent = messages.map((message, index) => message.content.slice(prefixes[index].length)).join('');
    const value: ReportPreview = { id: randomUUID(), policyId: policy.id, policyName: text(policy.name), generatedAt: snapshot.generatedAt,
      ...rendered, fullContent, content: fullContent, botTarget: state.settings.botTarget, groupName: bot().config().groupName,
      parts: messages.map(message => ({ content: message.content, bytes: message.bytes })),
      canSend: messages.every(message => message.canSend) && confirmed() && state.settings.policies.some(current => current.id === policy.id && policyContent(current) === policyContent(policy)),
      bytes: messages.reduce((total, message) => total + message.bytes, 0) };
    const saved = { value, policy, messages };
    await fs.mkdir(reports, { recursive: true, mode: 0o700 });
    await write(path.join(reports, `${value.id}.json`), saved);
    state.previews = [...state.previews, saved].slice(-100);
    await persist();
    return saved;
  }
  async function deliver(saved: StoredPreview, trigger: ReportRun['trigger'], slot = '') {
    const duplicate = state.history.find(run => run.previewId === saved.value.id);
    if (duplicate) return { record: structuredClone(duplicate), message: '该预览已提交，未重复发送；请核对回执与群消息' };
    if (!saved.messages?.length) throw new Error('汇报格式已更新，请重新生成完整 Markdown 预览');
    if (saved.value.botTarget !== state.settings.botTarget || !confirmed() || bot().config().groupName !== saved.value.groupName) throw new Error('机器人目标或群名确认已变化，请保存配置并重新预览');
    const currentPolicy = state.settings.policies.find(policy => policy.id === saved.policy.id);
    if (currentPolicy && policyContent(currentPolicy) !== policyContent(saved.policy)) throw new Error('汇报策略已变化，请保存后重新预览');
    const record: ReportRun = { id: randomUUID(), previewId: saved.value.id, policyId: saved.policy.id, policyName: saved.policy.name, trigger, slot,
      botTarget: saved.value.botTarget, groupName: saved.value.groupName, status: 'sending', attemptedAt: now().toISOString(), finishedAt: '', message: '',
      partCount: saved.messages.length, sentParts: 0, parts: [] };
    state.history.push(record);
    if (slot) state.slots[slot] = record.id;
    // 宿主先落盘固定预览及发送意图。崩溃后将 sending 转 unknown，避免再生成随机预览刷群。
    await persist();
    for (const [index, message] of saved.messages.entries()) {
      const part: NonNullable<ReportRun['parts']>[number] = { index: index + 1, status: 'sending', attemptedAt: now().toISOString(), finishedAt: '', message: '' };
      record.parts!.push(part);
      await persist();
      try {
        let sent: Awaited<ReturnType<ReportBot['sendMessage']>>;
        for (;;) {
          try { sent = await bot().sendMessage({ input: message.input, previewId: message.previewId, hash: message.hash }); break; }
          catch (error) {
            const rate = error as { code?: string; retryAfterMs?: number };
            // 仅等待尚未发起网络请求的本机限流，远端失败或送达未知绝不重试。
            if (rate.code !== 'WECOM_LOCAL_RATE_LIMIT' || !Number.isFinite(rate.retryAfterMs) || rate.retryAfterMs! <= 0) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(60_000, rate.retryAfterMs!)));
          }
        }
        part.status = sent.record.status === 'sending' ? 'unknown' : sent.record.status;
        part.message = sent.message;
        if (part.status === 'sent') record.sentParts!++;
      } catch (error) {
        part.status = 'unknown'; part.message = `发送异常，送达状态待确认；不会自动重发：${redactFeedback(error instanceof Error ? error.message : String(error))}`;
      }
      part.finishedAt = now().toISOString();
      if (part.status !== 'sent') record.status = part.status;
      await persist();
      if (part.status !== 'sent') break;
    }
    if (record.sentParts === record.partCount) record.status = 'sent';
    record.message = record.status === 'sent' ? `完整 Markdown 已发送，${record.sentParts}/${record.partCount} 条均获机器人接收回执，请到群内核对`
      : `已确认发送 ${record.sentParts}/${record.partCount} 条；后续已停止，不会自动重发。${record.parts!.at(-1)?.message || ''}`;
    record.finishedAt = now().toISOString();
    await persist();
    return { record: structuredClone(record), message: record.message };
  }
  function dueSlot(policy: ReportPolicy) {
    if (!policy.enabled || !policy.enabledAt) return '';
    const clock = localClock(now(), policy.timeZone);
    if (!policy.weekdays.includes(clock.weekday)) return '';
    const latest = [...new Set(policy.times)].sort().filter(time => time <= clock.time).at(-1);
    if (!latest) return '';
    const enabled = localClock(new Date(policy.enabledAt), policy.timeZone);
    if (`${clock.date} ${latest}` <= `${enabled.date} ${enabled.time}`) return '';
    const slot = `${policy.id}|${policy.timeZone}|${clock.date}|${latest}`;
    return state.slots[slot] ? '' : slot;
  }
  async function performTick() {
    for (const policy of state.settings.policies) {
      const slot = dueSlot(policy); if (!slot) continue;
      try {
        if (!confirmed()) throw new Error('群机器人未配置或目标群名已变化，请重新确认汇报接收群');
        const preview = await prepare(policy);
        await deliver(preview, 'schedule', slot);
      } catch (error) {
        const record: ReportRun = { id: randomUUID(), previewId: '', policyId: policy.id, policyName: policy.name, trigger: 'schedule', slot,
          botTarget: state.settings.botTarget, groupName: bot().config().groupName, status: 'failed', attemptedAt: now().toISOString(), finishedAt: now().toISOString(),
          message: redactFeedback(error instanceof Error ? error.message : String(error)) };
        state.history.push(record); state.slots[slot] = record.id; await persist();
      }
    }
  }
  function tick() {
    if (!pendingTick) pendingTick = serial(performTick).finally(() => { pendingTick = undefined; });
    return pendingTick;
  }
  return {
    dashboard,
    configure: (input: unknown) => serial(async () => {
      const value = workspaceReportSettingsSchema.parse(input);
      const target = options.bots[value.botTarget].config();
      if (value.policies.some(policy => policy.enabled) && (!target.hasWebhook || !target.groupName || value.confirmedGroupName !== target.groupName)) throw new Error('启用策略前，请配置机器人并确认当前接收群名称');
      const policies = value.policies.map(policy => {
        const prior = state.settings.policies.find(item => item.id === policy.id);
        const scheduleChanged = !prior || JSON.stringify([prior.times, prior.weekdays, prior.timeZone]) !== JSON.stringify([policy.times, policy.weekdays, policy.timeZone]);
        const targetChanged = value.botTarget !== state.settings.botTarget || value.confirmedGroupName !== state.settings.confirmedGroupName;
        const { enabledAt: _untrustedEnabledAt, ...definition } = policy;
        return { ...definition, ...(policy.enabled ? { enabledAt: prior?.enabled && prior.enabledAt && !scheduleChanged && !targetChanged ? prior.enabledAt : now().toISOString() } : {}) };
      });
      const previous = state.settings;
      state.settings = { ...value, policies };
      try { await persist(); } catch (error) { state.settings = previous; throw error; }
      return dashboard();
    }),
    configureBot: (input: unknown) => serial(async () => {
      await options.bots.dedicated.configure(input);
      // 更新凭据或目标后重新确认，不能沿用之前的日推授权。
      state.settings = { ...state.settings, confirmedGroupName: '', policies: state.settings.policies.map(policy => ({ ...policy, enabled: false, enabledAt: undefined })) };
      await persist(); return dashboard();
    }),
    preview: (input: unknown) => serial(async () => {
      const value = previewInput.parse(input);
      const policy = value.policy || state.settings.policies.find(item => item.id === value.policyId);
      if (!policy) throw new Error('汇报策略不存在');
      return structuredClone((await prepare(policy)).value);
    }),
    send: (input: unknown) => serial(async () => {
      const value = sendInput.parse(input), saved = state.previews.find(item => item.value.id === value.previewId);
      if (!saved) throw new Error('报告预览不存在或已过期，请重新预览');
      if (!state.settings.policies.some(policy => policy.id === saved.policy.id)) throw new Error('请先保存当前汇报策略，再重新预览发送');
      return deliver(saved, 'manual');
    }),
    tick,
    start() {
      if (timer || closing) return;
      timer = setInterval(() => { void tick().catch(error => options.onError?.(error)); }, options.intervalMs || 60_000).unref();
      void tick().catch(error => options.onError?.(error));
    },
    isIdle: () => running === 0 && !pendingTick,
    async close() { closing = true; if (timer) clearInterval(timer); timer = undefined; await queue; },
  };
}

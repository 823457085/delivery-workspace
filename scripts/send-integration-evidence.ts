/**
 * 设计说明：后端反馈需要页面上下文截图及原生 Network 详情，直接复用已保存的机器人配置。
 * 只发送已检查的 Markdown 和截图，不修改审核结果；本地执行入口避免上传截图或重启当前任务。
 * 正文限定为单个问题的5至6行事实，参数及关键返回直接可读；报告留工作台，截图地址由调用者明确提供。
 * 截图是发送前提；只发送一条内嵌关键截图的图文，不另发图片或文字消息。
 * markdown_v2 的行内代码实测为灰黑色；后端关注行用红色圆点标记，不转换接口原始值。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { redactFeedback, webhookUrl } from '../server/wecom-integration.js';

type Status = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
type Receipt = { fingerprint: string; content: string; screenshot: string; imageMd5: string; updatedAt: string; parts: { type: 'markdown' | 'markdown_v2' | 'image'; status: Status; code?: number; screenshot?: string; imageMd5?: string }[] };

// 同一机器人串行发送问题图文，避免五个会话触发限流；死进程锁可回收。
async function withRobotLock<T>(configFile: string, task: (pace: () => Promise<void>) => Promise<T>) {
  const lock = `${configFile}.evidence-lock`, sentAt = `${configFile}.evidence-sent-at`;
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lock, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(lock, { force: true }); continue; } }
      }
      if (Date.now() >= deadline) throw new Error('机器人图文发送锁等待超时，本问题尚未发送，请记录到工作台');
      await delay(50);
    }
  }
  try {
    return await task(async () => {
      const previous = Number(await fs.readFile(sentAt, 'utf8').catch(() => '0'));
      const remaining = previous + 3100 - Date.now();
      if (remaining > 0) await delay(remaining);
      await fs.writeFile(sentAt, String(Date.now()), { mode: 0o600 });
    });
  } finally { await fs.rm(lock, { force: true }); }
}

export async function sendIntegrationEvidence(markdownFile: string, screenshotFile: string, receiptFile: string, options: { send?: boolean; imageOnly?: boolean; textOnly?: boolean; inlineImageUrl?: string; additionalScreenshots?: string[]; configFile?: string; fetch?: typeof fetch } = {}) {
  // 保留旧调用参数并明确拒绝，让仍沿用旧指令的执行进程也不能外发无图消息。
  if (options.textOnly || !screenshotFile || screenshotFile === '-') throw new Error('群反馈必须提供真实截图；禁止纯文字或待补图消息，请先将缺图问题记录到工作台');
  if (options.imageOnly) throw new Error('群反馈须有独立的问题说明，禁止将全部文案画进图里');
  if (options.send && !options.inlineImageUrl) throw new Error('群反馈只发一条内嵌截图的图文，请使用 --send-inline 图片地址，禁止图片和正文分开发送');
  const sourceContent = await fs.readFile(markdownFile, 'utf8');
  let content = redactFeedback(sourceContent).trim();
  // 枚举选择表达式里的 key 会触发密钥脱敏，不能把丢失关键返回的正文发群。
  const enumSelectors = sourceContent.match(/\[\s*key\s*=\s*["'][A-Za-z_]\w*["']\s*\]/g) || [];
  if (enumSelectors.some(selector => !content.includes(selector))) throw new Error('枚举选择表达式被误脱敏；请改为“枚举组名.options=实际返回”，核对预览后发送');
  if (!content || Buffer.byteLength(content) > 3800) throw new Error('请将群反馈精简到 3800 UTF-8 字节以内，禁止静默截断问题描述');
  if (/<\/?font\b/i.test(content)) throw new Error('markdown_v2 不支持指定字体颜色；请用反引号标记关键字段及后端处理要求，沿用客户端行内代码样式');
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (/\bhttps?:\/\/\S+/i.test(content)) throw new Error('群反馈正文不要放报告或证据链接；请求参数与关键返回直接写在消息中，截图由发送器内嵌');
  // 兼容台账已有的模块长 ID 和八位摘要 ID，沿用原问题及回执，不要求另建编号。
  if (!/^#{0,6}\s*(?:(?:[A-Z0-9]+-)+(?:\d+|[A-F0-9]{8})|(?:equipment|finance|operations|configuration)-[a-z0-9]+(?:-[a-z0-9]+)+)\s*[｜|：:]\s*\S/i.test(lines[0])) throw new Error('群反馈首行须为“问题ID｜页面：具体异常”；进度、成功记录和取图验证不能作为问题发送');
  if (/-FE-/i.test(lines[0])) throw new Error('群里只推送需要后端处理的问题；前端问题修复回测后仅更新工作台，不推送');
  if (lines.length < 5 || lines.length > 6 || !lines.some(line => /^请求[：:]\s*(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+/i.test(line))
    || !lines.some(line => /^实际[：:]\s*\S/.test(line)) || !lines.some(line => /^预期[：:]\s*\S/.test(line)) || !lines.some(line => /^traceId[：:]\s*\S/i.test(line))) throw new Error('群反馈须为5至6行：问题、请求、实际关键返回、预期、traceId，可加必要参数；不依赖外部报告');
  const actual = lines.find(line => /^实际[：:]/.test(line))!;
  if (/net::ERR_[A-Z_]+|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b|网络(?:连接)?(?:失败|超时)|DNS解析失败|TLS握手失败|请求(?:已)?取消/i.test(actual)) throw new Error('网络或环境问题仅记录工作台，不推送群消息');
  if (options.inlineImageUrl) {
    const imageUrl = new URL(options.inlineImageUrl);
    if (!['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password || imageUrl.search || imageUrl.hash || !/\.(?:png|jpe?g)$/i.test(imageUrl.pathname) || /[()\s]/.test(imageUrl.href)) throw new Error('内嵌截图须为无凭据和查询参数的 HTTP(S) 图片地址');
    content += `\n\n![页面截图](${imageUrl.href})`;
    for (const file of options.additionalScreenshots || []) {
      const extraUrl = new URL(imageUrl.href);
      extraUrl.pathname = path.posix.dirname(imageUrl.pathname) + '/' + encodeURIComponent(path.basename(file));
      content += `\n\n![关键返回](${extraUrl.href})`;
    }
  }
  // 仅增加红色关注标记；保留格式更新前的指纹，避免重发已有反馈。
  const fingerprintContent = content;
  content = content.replace(/^预期([：:])(.*)$/m, (line, separator: string, detail: string) =>
    detail.trimStart().startsWith('🔴') ? line : `预期${separator}🔴 ${detail.trimStart()}`);
  if (!content || Buffer.byteLength(content) > 3800) throw new Error('请将群反馈精简到 3800 UTF-8 字节以内，禁止静默截断问题描述');
  if ((options.additionalScreenshots?.length || 0) > 2) throw new Error('一个问题最多提供3张关键截图');
  const images = await Promise.all([screenshotFile, ...(options.additionalScreenshots || [])].map(async file => {
    if (!file || file === '-') throw new Error('群反馈必须提供真实截图');
    const image = await fs.readFile(file);
    const png = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = image.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if ((!png && !jpeg) || image.length > 2 * 1024 * 1024) throw new Error('截图必须是 2MB 以内的 PNG/JPEG；发送前人工检查截图不含敏感信息');
    return { file, image, md5: createHash('md5').update(image).digest('hex') };
  }));
  const imageMd5 = images[0].md5;
  if (!options.send) return { content, screenshot: screenshotFile, imageBytes: images[0].image.length, imageMd5,
    screenshots: images.map(item => ({ screenshot: item.file, imageBytes: item.image.length, imageMd5: item.md5 })), sent: false };
  const configFile = options.configFile || process.env.DELIVERY_WECOM_CONFIG_FILE || path.join(process.env.DELIVERY_DATA_DIR || path.join(process.cwd(), '.data'), 'credentials', 'wecom-integration.json');
  const configuration = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const url = webhookUrl(configuration.webhook);
  const fingerprint = createHash('sha256').update(JSON.stringify({ content: fingerprintContent, imageMd5, url, ...(options.inlineImageUrl ? { inlineImage: true } : {}),
    ...(images.length > 1 ? { additionalImages: images.slice(1).map(item => item.md5) } : {}) })).digest('hex');
  const receipt: Receipt = { fingerprint, content, screenshot: path.basename(screenshotFile), imageMd5, updatedAt: new Date().toISOString(),
    parts: [{ type: 'markdown_v2', status: 'pending' }] };
  await fs.mkdir(path.dirname(receiptFile), { recursive: true });
  try {
    const file = await fs.open(receiptFile, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(receipt, null, 2)); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing: Receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    if (existing.fingerprint !== fingerprint) throw new Error('内容已变化，请使用新的回执文件');
    return { receipt: existing, duplicate: true, message: '已有发送记录，未重发；sending/unknown 请先核对群内消息' };
  }
  const persist = async () => {
    receipt.updatedAt = new Date().toISOString();
    await fs.writeFile(`${receiptFile}.tmp`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(`${receiptFile}.tmp`, receiptFile);
  };
  return withRobotLock(configFile, async pace => {
    for (const part of receipt.parts) {
      await pace();
      part.status = 'sending'; await persist();
      try {
        const body = { msgtype: 'markdown_v2', markdown_v2: { content } };
        const response = await (options.fetch || fetch)(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000), body: JSON.stringify(body) });
        const reply = response.ok ? await response.json() as { errcode?: number } : {};
        part.code = typeof reply.errcode === 'number' ? reply.errcode : undefined;
        part.status = part.code === 0 ? 'sent' : part.code === undefined ? 'unknown' : 'failed';
      } catch { part.status = 'unknown'; }
      await persist();
      if (part.status !== 'sent') break;
    }
    return { receipt, duplicate: false, message: receipt.parts.every(part => part.status === 'sent') ? '反馈获机器人成功回执，请到群内核对' : '未全部确认送达，请先核对群内消息；不会自动重发' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , markdown, image, receipt, mode, ...extra] = process.argv;
    const imageUrl = mode === '--send-inline' ? extra[0] : undefined;
    const additionalScreenshots = mode === '--send-inline' ? extra.slice(1) : extra;
    if (mode === '--send-text') throw new Error('群反馈禁止纯文字发送，必须先取得真实截图');
    if (mode === '--send-image') throw new Error('群反馈须有独立的问题说明，禁止将全部文案画进图里');
    if (!markdown || !image || !receipt || (mode && !['--send', '--send-inline'].includes(mode)) || (mode === '--send-inline' && !imageUrl)) throw new Error('用法：tsx scripts/send-integration-evidence.ts 描述.md 页面.jpg 回执.json [--send|--send-inline 图片地址] [请求证据.jpg] [响应证据.jpg]');
    console.log(JSON.stringify(await sendIntegrationEvidence(markdown, image, receipt, { send: !!mode, inlineImageUrl: imageUrl, additionalScreenshots }), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : '反馈执行失败'); process.exitCode = 1; }
}

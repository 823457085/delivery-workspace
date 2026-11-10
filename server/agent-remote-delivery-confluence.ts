/** 只向当前工作台已配置站点发布任务方案；先查重，写后回读，不重放不确定的写入。 */
import { createHash } from 'node:crypto';

export interface RemoteDesignDestination { site: string; spaceKey: string; parentId: string; title?: string; url?: string }
export interface RemoteDesignPublication {
  url: string; pageId: string; version: number; title: string; parentId: string; spaceKey: string; verifiedAt: string; bodySha256: string;
}
export interface RemoteDesignLookup {
  destination: RemoteDesignDestination; title: string; issueKeys?: string[]; existingPageId?: string;
}
export interface RemoteDesignMatch {
  pageId: string; title: string; version: number; url: string; bodySha256?: string; reason?: string;
}
interface Page {
  id: string; type?: string; title: string; space: { key: string }; version: { number: number };
  ancestors?: { id: string }[]; body?: { storage?: { value?: string } };
}
const pageId = /^[1-9]\d{0,31}$/;
const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
function normalizeSite(value: string) {
  const site = new URL(value);
  if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password || site.search || site.hash) throw new Error('Confluence 站点配置无效');
  return site.href.replace(/\/+$/, '');
}
function markdownStorage(body: string) {
  return `<ac:structured-macro ac:name="markdown" ac:schema-version="1"><ac:plain-text-body><![CDATA[${body.replaceAll(']]>', ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`;
}
function markdownBody(value: string | undefined) {
  // Confluence 可添加 macro-id；只认可独立 Markdown 宏，不覆盖夹有其他内容的页面。
  const macro = /^\s*<ac:structured-macro\b([^>]*)>\s*<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>\s*<\/ac:structured-macro>\s*$/.exec(value || '');
  if (!macro || !/\bac:name\s*=\s*["']markdown["']/.test(macro[1])) return undefined;
  const chunks = [...macro[2].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (!chunks.length || chunks.map(chunk => chunk[0]).join('') !== macro[2]) return undefined;
  return chunks.map(chunk => chunk[1]).join('');
}
async function json(response: Response) {
  if (!response.ok) throw Object.assign(new Error(`Confluence 请求失败：HTTP ${response.status}`),
    { definite: response.status >= 400 && response.status < 500 });
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error('Confluence 文档响应过大');
  try { return JSON.parse(body); } catch { throw new Error('Confluence 未返回有效文档数据'); }
}
function readPage(raw: unknown): Page {
  const page = raw as Page;
  if (!page || !pageId.test(page.id) || page.type !== 'page' || typeof page.title !== 'string' || !page.space?.key
    || !Number.isInteger(page.version?.number) || page.version.number < 1) throw new Error('Confluence 页面信息不完整');
  return page;
}

export function createAgentRemoteDeliveryConfluence(
  read: (resource: string) => Promise<Response>,
  write: (resource: string, method: 'POST' | 'PUT', body: unknown) => Promise<Response>,
  configuredSite = process.env.CONFLUENCE_BASE_URL || 'https://confluence.example.invalid',
) {
  const site = normalizeSite(configuredSite);
  const get = async (id: string) => readPage(await json(await read(`content/${id}?expand=space,version,ancestors,body.storage`)));
  const pageUrl = (id: string) => `${site}/pages/viewpage.action?pageId=${id}`;
  const sameParent = (page: Page, destination: RemoteDesignDestination) => page.id !== destination.parentId
    && page.space.key === destination.spaceKey && page.ancestors?.at(-1)?.id === destination.parentId;
  const isIssueKey = (key: string) => /^[A-Z][A-Z0-9_]*-\d+$/.test(key);
  const mentions = (text: string, key: string) => new RegExp(`(?:^|[^A-Z0-9_])${key}(?![A-Z0-9_])`, 'i').test(text);
  async function verifyDestination({ destination, title, existingPageId }: RemoteDesignLookup) {
    if (normalizeSite(destination.site) !== site) throw new Error('方案目标与当前工作台的 Confluence 站点不一致');
    if (!pageId.test(destination.parentId) || !/^[A-Za-z0-9_-]{1,100}$/.test(destination.spaceKey)
      || !title.trim() || title.length > 500 || /[\x00-\x1f\x7f]/.test(title)
      || existingPageId !== undefined && (!pageId.test(existingPageId) || existingPageId === destination.parentId)) throw new Error('技术方案发布信息无效');
    const parent = await get(destination.parentId);
    if (parent.space.key !== destination.spaceKey) throw new Error('技术方案目标父页面所属空间不一致');
  }
  async function findPage({ destination, title, issueKeys = [], existingPageId }: RemoteDesignLookup) {
    if (existingPageId) return get(existingPageId);
    const keys = [...new Set(issueKeys.filter(isIssueKey))];
    const titleClauses = [`title = ${JSON.stringify(title)}`, ...keys.map(key => `title ~ ${JSON.stringify(key)}`)];
    const cql = `type = page AND space = ${JSON.stringify(destination.spaceKey)} AND ancestor = ${destination.parentId} AND (${titleClauses.join(' OR ')})`;
    const found = await json(await read(`content/search?${new URLSearchParams({ cql, limit: '100', expand: 'space,version,ancestors' })}`));
    if (!Array.isArray(found.results) || found._links?.next || found.totalSize > found.results.length) throw new Error('方案查重结果不完整，请核对目标目录后重试');
    const matches = found.results.map(readPage).filter((page: Page) => sameParent(page, destination)
      && (page.title === title || /技术方案|tech(?:nical)?[ -]?design/i.test(page.title) && keys.some(key => mentions(page.title, key))));
    if (matches.length > 1) throw new Error('目标目录存在多个同名方案或关联方案，请先核对页面归属');
    return matches.length ? get(matches[0].id) : undefined;
  }
  return {
    async lookup(input: RemoteDesignLookup): Promise<RemoteDesignMatch | undefined> {
      await verifyDestination(input);
      const page = await findPage(input);
      if (!page) return;
      if (!sameParent(page, input.destination)) throw new Error('已关联方案的空间或父目录已变化，请核对原页面');
      const body = markdownBody(page.body?.storage?.value);
      const reason = body === undefined ? '已找到原页面，但正文不是独立 Markdown 方案，无法自动更新。'
        : !input.existingPageId && page.title !== input.title && !input.issueKeys?.some(key => isIssueKey(key) && mentions(body, key))
          ? '已找到关联标题的页面，但正文缺少任务编号，请先核对方案归属。' : '';
      return { pageId: page.id, title: page.title, version: page.version.number, url: pageUrl(page.id),
        ...(reason ? { reason } : { bodySha256: sha256(body!) }) };
    },
    async publish(input: RemoteDesignLookup & { body: string; taskId: string; expectedVersion?: number; expectedBodySha256?: string }): Promise<RemoteDesignPublication> {
      try {
        const { destination, title, body, taskId, existingPageId, expectedVersion, expectedBodySha256 } = input;
        if (!body.trim() || body.length > 500_000 || !/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error('技术方案发布信息无效');
        await verifyDestination(input);
        const verifyTarget = (page: Page) => {
          if (!sameParent(page, destination) || page.title !== title) throw new Error('技术方案页面标题、空间或父目录与预览不一致');
        };
        const result = (page: Page): RemoteDesignPublication => ({ pageId: page.id, title: page.title, version: page.version.number,
          parentId: destination.parentId, spaceKey: destination.spaceKey, url: pageUrl(page.id),
          verifiedAt: new Date().toISOString(), bodySha256: sha256(body) });
        const existing = await findPage(input);
        if (existing) {
          verifyTarget(existing);
          if (!existingPageId && markdownBody(existing.body?.storage?.value) !== body) {
            throw new Error('目标目录已有内容不同的同名或关联方案，请重新打开预览后更新原页');
          }
        }
        if (existing && markdownBody(existing.body?.storage?.value) === body) return result(existing);
        if (existing && (!Number.isInteger(expectedVersion) || expectedVersion !== existing.version.number
          || !expectedBodySha256 || markdownBody(existing.body?.storage?.value) === undefined
          || sha256(markdownBody(existing.body?.storage?.value)!) !== expectedBodySha256)) throw new Error('远端方案版本或正文与已登记记录不一致，请先核对远端改动，未覆盖页面');
        const payload = { type: 'page', title, space: { key: destination.spaceKey }, ancestors: [{ id: destination.parentId }],
          body: { storage: { value: markdownStorage(body), representation: 'storage' } },
          ...(existing ? { id: existing.id, version: { number: existing.version.number + 1 } } : {}) };
        try {
          const saved = await json(await write(existing ? `content/${existing.id}` : 'content', existing ? 'PUT' : 'POST', payload));
          if (!saved || !pageId.test(saved.id) || existing && saved.id !== existing.id) throw new Error('Confluence 未返回预期的方案页面编号');
          const page = await get(saved.id); verifyTarget(page);
          if (markdownBody(page.body?.storage?.value) !== body || page.version.number !== (existing ? existing.version.number + 1 : 1)) throw new Error('技术方案正文或版本回读不一致');
          return result(page);
        } catch (error) {
          if ((error as { definite?: boolean })?.definite) throw error;
          throw Object.assign(new Error(`技术方案写入结果待核对，请只读核对后再继续：${error instanceof Error ? error.message : '请求未完成'}`), { uncertain: true });
        }
      } catch (error) {
        if ((error as { uncertain?: boolean })?.uncertain) throw error;
        throw Object.assign(error instanceof Error ? error : new Error('技术方案发布前校验未完成'), { definite: true });
      }
    },
  };
}

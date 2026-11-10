/** 合并请求只使用已推送分支；Codeup 复用云效凭据，其他平台交给官方创建页面。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readProjectGitSnapshot, redact, withProjectGitLock } from './project-git.js';

const exec = promisify(execFile);
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const unknownMessage = '创建结果尚未确认，请先到代码平台核对，或重新准备以查询已有合并请求；不会自动重复创建。';
const repositorySchema = z.object({ path: z.string().min(1), remote: z.string().min(1).max(200), revision: z.string().optional() });
const inputSchema = repositorySchema.extend({
  sourceBranch: z.string().min(1).max(500), targetBranch: z.string().min(1).max(500),
  title: z.string().trim().max(256).optional(), description: z.string().max(10000).optional(),
});
type Options = { dataDirectory: string; fetcher?: typeof fetch };
type CreateOptions = Options & { reviewer?: string; beforeCreate?: () => Promise<void> };
export interface ProjectMergeRequest { id: number; url: string; title: string; state: string }
export interface ProjectMergeRequestListItem extends ProjectMergeRequest {
  sourceBranch: string; targetBranch: string; author?: string;
}
export interface ProjectMergeRequestPreparation {
  mode: 'api' | 'browser' | 'unavailable'; provider: string; remote: string;
  sourceBranch: string; targetBranch: string; sourceSha: string; targetSha: string; revision: string;
  repositoryUrl: string; url: string; title: string; description: string; canCreate: boolean;
  reason?: string; existing?: ProjectMergeRequest;
}

async function git(directory: string, args: string[]) {
  try {
    return (await exec('git', ['-C', directory, ...args], { timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } })).stdout.trim();
  } catch (error) {
    const value = error as { killed?: boolean; stderr?: string };
    throw fail(value.killed ? '远端分支核对超时，请稍后重新准备。' : redact(value.stderr || '无法核对远端分支。').slice(0, 2000));
  }
}

async function readRepository(data: z.infer<typeof repositorySchema>) {
  const snapshot = await readProjectGitSnapshot(data.path);
  if (!snapshot.isGit) throw fail('当前目录不是 Git 仓库。');
  if (data.revision && data.revision !== snapshot.revision) throw fail('仓库状态已变化，请刷新后重新准备合并请求。');
  const remote = snapshot.remotes.find(item => item.name === data.remote);
  if (!remote?.webUrl) throw fail('请选择可访问的 Codeup、GitLab 或 GitHub 远端。');
  const repository = new URL(remote.webUrl);
  if (repository.protocol !== 'https:' || repository.username || repository.password) throw fail('远端网页地址不正确。');
  const provider = repository.hostname === 'codeup.aliyun.com' ? 'Codeup'
    : repository.hostname === 'github.com' ? 'GitHub' : /gitlab/i.test(repository.hostname) ? 'GitLab' : '';
  if (!provider) throw fail('当前远端暂不支持创建合并请求，请从仓库网页操作。');
  return { snapshot, remote, repository, provider };
}

async function readSelection(input: unknown) {
  const data = inputSchema.parse(input);
  const { snapshot, remote, repository, provider } = await readRepository(data);
  for (const branch of [data.sourceBranch, data.targetBranch]) {
    if (branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch)) throw fail('分支名称格式不正确。');
    await git(snapshot.directory, ['check-ref-format', `refs/heads/${branch}`]);
  }
  if (data.sourceBranch === data.targetBranch) throw fail('源分支和目标分支不能相同。');
  const refs = await git(snapshot.directory, ['ls-remote', '--heads', remote.name,
    `refs/heads/${data.sourceBranch}`, `refs/heads/${data.targetBranch}`]);
  const heads = new Map(refs.split('\n').map(line => { const [sha, ref] = line.split('\t'); return [ref, sha]; }));
  const sourceSha = heads.get(`refs/heads/${data.sourceBranch}`), targetSha = heads.get(`refs/heads/${data.targetBranch}`);
  if (!sourceSha) throw fail('源分支尚未推送到所选远端，请先推送再创建合并请求。');
  if (!targetSha) throw fail('目标分支在远端不存在，请刷新远端分支后重新选择。');
  const current = snapshot.branches.find(item => item.current && !item.remote);
  const currentIsSource = current?.upstreamRemote === remote.name && current.upstreamRef === `refs/heads/${data.sourceBranch}`
    || snapshot.branch === data.sourceBranch;
  if (currentIsSource && sourceSha !== snapshot.head) throw fail('当前分支与远端源分支提交不一致，请先同步并推送，再创建合并请求。');
  const prepared: ProjectMergeRequestPreparation = { mode: provider === 'Codeup' ? 'api' : 'browser', provider,
    remote: remote.name, sourceBranch: data.sourceBranch, targetBranch: data.targetBranch, sourceSha, targetSha,
    revision: snapshot.revision, repositoryUrl: remote.webUrl, url: '',
    title: data.title || `合并 ${data.sourceBranch} 到 ${data.targetBranch}`, description: data.description || '', canCreate: true };
  return { data, snapshot, repository, prepared };
}

function browserUrl(info: ProjectMergeRequestPreparation) {
  // https://docs.github.com/en/pull-requests/reference/using-query-parameters-to-create-a-pull-request
  if (info.provider === 'GitHub') {
    const url = new URL(`${info.repositoryUrl}/compare/${encodeURIComponent(info.targetBranch)}...${encodeURIComponent(info.sourceBranch)}`);
    url.search = new URLSearchParams({ quick_pull: '1', title: info.title, body: info.description }).toString();
    return url.href;
  }
  const url = new URL(`${info.repositoryUrl}/-/merge_requests/new`);
  url.search = new URLSearchParams({ 'merge_request[source_branch]': info.sourceBranch,
    'merge_request[target_branch]': info.targetBranch, 'merge_request[title]': info.title,
    'merge_request[description]': info.description }).toString();
  return url.href;
}

async function codeupClient(repository: URL, options: Options) {
  const fullPath = decodeURIComponent(repository.pathname.replace(/^\//, '').replace(/\/$/, ''));
  const organizationId = fullPath.split('/')[0];
  if (!/^[a-f0-9]{24}$/.test(organizationId || '')) throw fail('Codeup 仓库缺少有效的组织 ID。');
  let token = '';
  try {
    const saved = JSON.parse(await fs.readFile(path.join(options.dataDirectory, 'yunxiao-credentials.json'), 'utf8')) as { token?: unknown };
    if (typeof saved.token !== 'string' || !saved.token || /[\x00-\x20\x7f]/.test(saved.token)) throw fail('云效令牌配置无效，请重新保存。');
    token = saved.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw fail('云效令牌配置无法读取或格式无效，请重新保存。');
  }
  const base = `https://openapi-rdc.aliyuncs.com/oapi/v1/codeup/organizations/${organizationId}`;
  async function api(suffix: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    let response: Response, text: string;
    try {
      response = await (options.fetcher || fetch)(base + suffix, { method,
        redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'x-yunxiao-token': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      text = await response.text();
    } catch { throw fail('Codeup 连接失败或超时，请重新查询。'); }
    if (Buffer.byteLength(text) > 2_000_000) throw fail('云效响应过大。');
    if (!response.ok) {
      // 不返回任意服务端响应，防止凭据或内部信息出现在操作输出中。
      const hint = response.status === 401 || response.status === 403 ? '请检查云效令牌的代码库及合并请求权限。' : '';
      throw Object.assign(fail(`Codeup 请求失败 (${response.status})。${hint}`),
        { rejected: [400, 401, 403, 404, 422].includes(response.status) });
    }
    try { return { value: JSON.parse(text) as unknown, headers: response.headers }; }
    catch { throw fail('Codeup 未返回有效的 JSON。'); }
  }
  // https://help.aliyun.com/zh/yunxiao/developer-reference/getrepository-query-the-code-base
  const { value } = await api(`/repositories/${encodeURIComponent(fullPath)}`);
  const metadata = value as { id?: unknown; pathWithNamespace?: unknown; archived?: unknown };
  if (!Number.isSafeInteger(metadata.id) || Number(metadata.id) <= 0 || metadata.pathWithNamespace !== fullPath) throw fail('Codeup 返回的仓库与当前远端不一致。');
  if (metadata.archived === true) throw fail('该 Codeup 仓库已归档，不能创建合并请求。');
  return { api, repositoryId: metadata.id as number };
}

type CodeupRequestResponse = {
  localId?: unknown; sourceBranch?: unknown; targetBranch?: unknown; sourceProjectId?: unknown; targetProjectId?: unknown;
  webUrl?: unknown; detailUrl?: unknown; title?: unknown; status?: unknown; state?: unknown; reviewers?: unknown;
  author?: { name?: unknown; username?: unknown } | null;
};

type RequestBranches = Pick<ProjectMergeRequestPreparation, 'sourceBranch' | 'targetBranch'>;
type RequestIdentity = RequestBranches & Pick<ProjectMergeRequestPreparation, 'repositoryUrl' | 'title'>;

function verifiedRequestId(item: CodeupRequestResponse, info: RequestBranches, repositoryId: number) {
  if (typeof item?.localId !== 'number' || !Number.isSafeInteger(item.localId) || item.localId <= 0 || item.sourceBranch !== info.sourceBranch
    || item.targetBranch !== info.targetBranch || item.sourceProjectId !== repositoryId || item.targetProjectId !== repositoryId) {
    throw fail('Codeup 返回的合并请求与本次选择不一致。');
  }
  return item.localId;
}

function requestInfo(value: unknown, info: RequestIdentity, repositoryId: number): ProjectMergeRequest {
  const item = value as CodeupRequestResponse;
  const id = verifiedRequestId(item, info, repositoryId);
  const repository = new URL(info.repositoryUrl);
  const prefix = repository.pathname.replace(/\/$/, '') + '/';
  // Codeup can return the repository homepage in webUrl and the request in detailUrl.
  for (const rawUrl of [item.detailUrl, item.webUrl]) {
    const url = typeof rawUrl === 'string' ? URL.parse(rawUrl) : null;
    if (url?.protocol === 'https:' && url.origin === repository.origin && !url.username && !url.password
      && url.pathname.startsWith(prefix) && url.pathname.length > prefix.length) {
      return { id, url: url.href, title: typeof item.title === 'string' ? item.title : info.title, state: String(item.status || item.state || '') };
    }
  }
  throw fail('Codeup 未返回与当前仓库匹配的合并请求详情地址。');
}

function listedRequest(item: CodeupRequestResponse, info: RequestIdentity, repositoryId: number): ProjectMergeRequestListItem {
  const author = [item.author?.name, item.author?.username].find(value => typeof value === 'string' && value.trim());
  return { ...requestInfo(item, info, repositoryId), sourceBranch: info.sourceBranch, targetBranch: info.targetBranch,
    ...(typeof author === 'string' ? { author } : {}) };
}

type CodeupClient = NonNullable<Awaited<ReturnType<typeof codeupClient>>>;

async function resolveCodeupReviewer(client: CodeupClient, reviewer: string) {
  // https://help.aliyun.com/zh/yunxiao/developer-reference/listrepositorymembers-query-code-base-member-list
  const { value } = await client.api(`/repositories/${client.repositoryId}/members`);
  if (!Array.isArray(value)) throw fail('Codeup 未返回有效的仓库成员列表。');
  const ids = new Set<string>();
  for (const member of value) {
    if (member?.memberType !== 'USERS' || member.state !== 'active' || typeof member.userId !== 'string'
      || !member.userId || (member.expiresAt && !(Date.parse(member.expiresAt) > Date.now()))) continue;
    if ([member.userId, member.name, member.username].includes(reviewer)) ids.add(member.userId);
  }
  if (ids.size !== 1) throw fail('无法唯一核对 Codeup 审核人，请配置有效的登录名或用户 ID。');
  return [...ids][0]!;
}

async function* openRequestPages(client: CodeupClient) {
  // https://help.aliyun.com/zh/yunxiao/developer-reference/listchangerequests-query-the-list-of-merge-requests
  for (let page = 1; page <= 100; page++) {
    const { value, headers } = await client.api(`/changeRequests?${new URLSearchParams({ projectIds: String(client.repositoryId), state: 'opened', perPage: '100', page: String(page) })}`);
    if (!Array.isArray(value)) throw fail('Codeup 未返回有效的合并请求列表。');
    yield value.filter((item): item is CodeupRequestResponse & RequestBranches =>
      !!item && item.sourceProjectId === client.repositoryId && item.targetProjectId === client.repositoryId
      && typeof item.sourceBranch === 'string' && !!item.sourceBranch && typeof item.targetBranch === 'string' && !!item.targetBranch
      && !['CLOSED', 'MERGED'].includes(String(item.state || item.status || '').toUpperCase()));
    const next = headers.get('x-next-page');
    const totalPages = Number(headers.get('x-total-pages'));
    const reportedPageSize = Number(headers.get('x-per-page'));
    const pageSize = Number.isInteger(reportedPageSize) && reportedPageSize > 0 ? reportedPageSize : 100;
    const hasTotalPages = Number.isInteger(totalPages) && totalPages > 0;
    // 中心版实测最后一页仍返回 x-next-page=当前页，不能只靠它判定是否结束。
    if (!value.length || hasTotalPages && page >= totalPages
      || !hasTotalPages && (value.length < pageSize || next === '' || next === '0')) return;
  }
  throw fail('合并请求数量过多，未能查询完整，请到 Codeup 查看。');
}

async function findExisting(client: CodeupClient, info: ProjectMergeRequestPreparation) {
  for await (const items of openRequestPages(client)) {
    const match = items.find(item => item.sourceBranch === info.sourceBranch && item.targetBranch === info.targetBranch);
    if (match) return requestInfo(match, info, client.repositoryId);
  }
}

export async function listProjectMergeRequests(input: unknown, options: Options) {
  const { repository, provider } = await readRepository(repositorySchema.parse(input));
  if (provider !== 'Codeup') throw fail('当前远端请在代码平台查看合并请求。');
  const client = await codeupClient(repository, options);
  if (!client) throw fail('请先在云效设置中保存具有合并请求读取权限的个人访问令牌。');
  const requests: ProjectMergeRequestListItem[] = [];
  for await (const items of openRequestPages(client)) {
    for (const item of items) {
      const { sourceBranch, targetBranch } = item;
      const info = { sourceBranch, targetBranch, repositoryUrl: repository.href, title: `合并 ${sourceBranch} 到 ${targetBranch}` };
      requests.push(listedRequest(item, info, client.repositoryId));
    }
  }
  return { requests };
}

export async function updateProjectMergeRequestTitle(input: unknown, options: Options) {
  const data = inputSchema.extend({
    id: z.number().int().positive(), repositoryUrl: z.url(), expectedTitle: z.string(),
    title: z.string().trim().min(1).max(256).refine(title => !/[\x00-\x1f\x7f]/.test(title), '标题不能包含控制字符'),
  }).parse(input);
  const { snapshot } = await readRepository(data);
  return withProjectGitLock(snapshot.directory, async () => {
    const { repository, provider } = await readRepository(data);
    if (provider !== 'Codeup' || repository.href !== data.repositoryUrl) throw fail('当前远端已变化，请刷新合并请求列表。');
    const client = await codeupClient(repository, options);
    if (!client) throw fail('请先在云效设置中保存具有合并请求读写权限的个人访问令牌。');
    const { api, repositoryId } = client;
    const endpoint = `/repositories/${repositoryId}/changeRequests/${data.id}`;
    async function readRequest() {
      const { value } = await api(endpoint);
      const item = value as CodeupRequestResponse;
      if (item?.localId !== data.id || typeof item.title !== 'string') throw fail('Codeup 返回的合并请求编号或标题无法核对。');
      return listedRequest(item, data, repositoryId);
    }
    const current = await readRequest();
    if (['CLOSED', 'MERGED'].includes(current.state.toUpperCase())) throw fail('合并请求已结束，请刷新列表。');
    if (current.title === data.title) return { request: current };
    if (current.title !== data.expectedTitle) throw fail('标题已被修改，请刷新列表后再编辑。');

    // https://help.aliyun.com/zh/yunxiao/developer-reference/updatechangerequest-update-merge-request-basic-information
    let result: unknown;
    try { result = (await api(endpoint, { title: data.title }, 'PUT')).value; }
    catch (error) {
      if ((error as { rejected?: boolean }).rejected) throw error;
      throw fail('标题保存结果尚未确认，请刷新列表后核对。');
    }
    if ((result as { result?: boolean } | null)?.result === false) throw fail('Codeup 未能保存标题，请刷新后再试。');
    const updated = await readRequest().catch(() => undefined);
    if (updated?.title !== data.title) throw fail('标题保存结果尚未确认，请刷新列表后核对。');
    return { request: updated };
  });
}

function pendingFile(info: ProjectMergeRequestPreparation, options: Options) {
  const key = createHash('sha256').update(JSON.stringify([info.repositoryUrl, info.sourceBranch, info.targetBranch])).digest('hex');
  return path.join(options.dataDirectory, 'project-merge-requests', `${key}.json`);
}

async function prepare(input: unknown, options: Options) {
  const selection = await readSelection(input);
  const info = selection.prepared;
  if (info.provider !== 'Codeup') { info.url = browserUrl(info); return { ...selection, client: undefined }; }
  const client = await codeupClient(selection.repository, options);
  if (!client) {
    info.mode = 'unavailable'; info.canCreate = false; info.url = info.repositoryUrl;
    info.reason = '请先在云效设置中保存具有代码库只读、合并请求读写权限的个人访问令牌。';
    return { ...selection, client };
  }
  const existing = await findExisting(client, info);
  if (existing) {
    info.existing = existing; info.url = existing.url; info.canCreate = false;
    await fs.rm(pendingFile(info, options), { force: true });
  } else if (await fs.stat(pendingFile(info, options)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    info.canCreate = false; info.reason = unknownMessage; info.url = info.repositoryUrl;
  } else if (info.sourceSha === info.targetSha || await git(selection.snapshot.directory,
    ['--no-replace-objects', 'merge-base', '--is-ancestor', info.sourceSha, info.targetSha]).then(() => true, () => false)) {
    // 仅根据已核对的远端提交确认包含关系。本地缺少提交对象时仍交给 Codeup 校验。
    info.canCreate = false;
    info.reason = '目标分支已包含源分支的全部提交，没有可合并的变更。';
  }
  return { ...selection, client };
}

export async function prepareProjectMergeRequest(input: unknown, options: Options): Promise<ProjectMergeRequestPreparation> {
  return (await prepare(input, options)).prepared;
}

export async function createProjectMergeRequest(input: unknown, options: CreateOptions) {
  const data = inputSchema.extend({ title: z.string().trim().min(1).max(256),
    expectedSourceSha: z.string().regex(/^[a-f0-9]{40,64}$/), expectedTargetSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).parse(input);
  const initial = await readProjectGitSnapshot(data.path);
  if (!initial.isGit) throw fail('当前目录不是 Git 仓库。');
  return withProjectGitLock(initial.directory, async () => {
    const { prepared: info, client } = await prepare(data, options);
    if (info.sourceSha !== data.expectedSourceSha || info.targetSha !== data.expectedTargetSha) throw fail('远端分支提交已变化，请重新准备并确认合并请求。');
    if (info.existing) return { ok: true, created: false, request: info.existing };
    if (info.mode !== 'api' || !client || !info.canCreate) throw fail(info.reason || '请前往代码平台创建合并请求。');
    const reviewerId = options.reviewer ? await resolveCodeupReviewer(client, options.reviewer) : undefined;
    const latest = (await readSelection(data)).prepared;
    if (latest.repositoryUrl !== info.repositoryUrl || latest.sourceSha !== data.expectedSourceSha || latest.targetSha !== data.expectedTargetSha) {
      throw fail('远端分支提交已变化，请重新准备并确认合并请求。');
    }
    await options.beforeCreate?.();
    const file = pendingFile(info, options);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // 先记录可能发出的请求；进程退出或响应丢失后不自动重试外部写入。
    await fs.writeFile(file, JSON.stringify({ repositoryUrl: info.repositoryUrl, sourceBranch: info.sourceBranch,
      targetBranch: info.targetBranch, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    let submitted = false;
    try {
      // https://help.aliyun.com/en/yunxiao/developer-reference/createchangerequest-create-merge-request
      const { value } = await client.api(`/repositories/${client.repositoryId}/changeRequests`, {
        title: data.title, description: data.description || '', sourceBranch: info.sourceBranch, targetBranch: info.targetBranch,
        sourceProjectId: client.repositoryId, targetProjectId: client.repositoryId, triggerAIReviewRun: false,
        ...(reviewerId ? { reviewerUserIds: [reviewerId] } : {}),
      });
      submitted = true;
      const createdId = verifiedRequestId(value as CodeupRequestResponse, info, client.repositoryId);
      // https://help.aliyun.com/en/yunxiao/developer-reference/getchangerequest-query-merge-request
      const response = (await client.api(`/repositories/${client.repositoryId}/changeRequests/${createdId}`)).value as CodeupRequestResponse;
      const confirmed = requestInfo(response, info, client.repositoryId);
      if (confirmed.id !== createdId) throw fail('创建后的合并请求编号回读不一致。');
      if (reviewerId && (!Array.isArray(response.reviewers) || !response.reviewers.some(item => item?.userId === reviewerId))) {
        throw fail('创建后的合并请求审核人回读不一致。');
      }
      await fs.rm(file, { force: true });
      return { ok: true, created: true, request: confirmed };
    } catch (error) {
      if (!submitted && (error as { rejected?: boolean }).rejected) { await fs.rm(file, { force: true }); throw error; }
      throw fail(unknownMessage);
    }
  });
}

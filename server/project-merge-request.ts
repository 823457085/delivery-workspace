/** 合并请求只使用已推送分支；Codeup 复用云效凭据，其他平台交给官方创建页面。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readProjectGitSnapshot, redact, withProjectGitLock } from './project-git.js';
import {
  analyzeUnifiedDiff,
  buildStructuredMergeRequestDescription,
  scanDiffHygieneIssues,
  summarizeDiffTriage,
  type MergeDiffTriageSummary,
} from './pr-review-intelligence.js';
import { analyzeRepoBlastRadius } from './repo-blast-radius.js';
import {
  draftCategorizedReleaseNotes,
  evaluateDeliveryReadinessScorecard,
  type DeliveryReadinessScorecard,
} from '../shared/delivery-readiness-scorecard.js';

const exec = promisify(execFile);
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const unknownMessage = '创建结果尚未确认，请先到代码平台核对，或重新准备以查询已有合并请求；不会自动重复创建。';
const repositorySchema = z.object({
  path: z.string().min(1),
  remote: z.string().min(1).max(200),
  revision: z.string().optional(),
  providerOverride: z.enum(['Codeup', 'GitHub', 'GitLab']).optional(),
});
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
  reason?: string; existing?: ProjectMergeRequest; triage?: MergeDiffTriageSummary;
  scorecard?: DeliveryReadinessScorecard; releaseNotesMarkdown?: string;
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

async function readRemoteBranchHeads(directory: string, remote: string, { sourceBranch, targetBranch }: RequestBranches) {
  const source = `refs/heads/${sourceBranch}`, target = `refs/heads/${targetBranch}`;
  const refs = await git(directory, ['ls-remote', '--heads', '--', remote, source, target]);
  const heads = new Map(refs.split('\n').map(line => { const [sha, ref] = line.split('\t'); return [ref, sha]; }));
  return { sourceSha: heads.get(source), targetSha: heads.get(target) };
}

async function readRepository(data: z.infer<typeof repositorySchema>) {
  const snapshot = await readProjectGitSnapshot(data.path);
  if (!snapshot.isGit) throw fail('当前目录不是 Git 仓库。');
  if (data.revision && data.revision !== snapshot.revision) throw fail('仓库状态已变化，请刷新后重新准备合并请求。');
  const remote = snapshot.remotes.find(item => item.name === data.remote);
  if (!remote?.webUrl) throw fail('请选择可访问的 Codeup、GitLab 或 GitHub 远端。');
  const repository = new URL(remote.webUrl);
  if (repository.protocol !== 'https:' || repository.username || repository.password) throw fail('远端网页地址不正确。');
  const detected = repository.hostname === 'codeup.aliyun.com' ? 'Codeup'
    : repository.hostname === 'github.com' ? 'GitHub' : /gitlab/i.test(repository.hostname) ? 'GitLab' : '';
  const provider = data.providerOverride || detected;
  if (!provider) throw fail('当前远端暂不支持创建合并请求，请显式指定 GitHub/GitLab 平台或从仓库网页操作。');
  return { snapshot, remote, repository, provider };
}

async function buildAutoMergeAnalysis(
  directory: string,
  sourceBranch: string,
  targetBranch: string,
  sourceSha: string,
  targetSha: string,
): Promise<{
  full: string;
  compact: string;
  triage?: MergeDiffTriageSummary;
  scorecard?: DeliveryReadinessScorecard;
  releaseNotesMarkdown?: string;
}> {
  if (!sourceSha || !targetSha || sourceSha === targetSha) return { full: '', compact: '' };
  try {
    await exec('git', ['--no-replace-objects', '-C', directory, 'cat-file', '-e', `${sourceSha}^{commit}`], { timeout: 5000 });
    await exec('git', ['--no-replace-objects', '-C', directory, 'cat-file', '-e', `${targetSha}^{commit}`], { timeout: 5000 });
    const ancestor = await exec('git', ['--no-replace-objects', '-C', directory, 'merge-base', '--is-ancestor', sourceSha, targetSha], { timeout: 5000 })
      .then(() => true, () => false);
    if (ancestor) return { full: '', compact: '' };

    const logResult = await exec(
      'git',
      ['--no-replace-objects', '-C', directory, 'log', '--no-merges', '--max-count=30', '--format=%H\t%s', `${targetSha}..${sourceSha}`],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    const commits = logResult.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const tab = line.indexOf('\t');
        return tab > 0 ? { sha: line.slice(0, tab), subject: line.slice(tab + 1) } : { sha: line, subject: '' };
      });

    const patchResult = await exec(
      'git',
      ['--no-replace-objects', '-C', directory, 'diff', '--find-renames', '--unified=2', `${targetSha}...${sourceSha}`, '--', '.', ':(exclude).delivery-artifacts'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    ).catch(() => ({ stdout: '' }));

    const triage = analyzeUnifiedDiff(patchResult.stdout);
    const triageSummary = triage.totals.files > 0 ? summarizeDiffTriage(triage) : undefined;
    const hygieneWarnings = patchResult.stdout ? scanDiffHygieneIssues(patchResult.stdout) : [];
    const blastRadius = patchResult.stdout
      ? await analyzeRepoBlastRadius(directory, patchResult.stdout).catch(() => undefined)
      : undefined;
    const scorecard = triage.totals.files > 0
      ? evaluateDeliveryReadinessScorecard({
        totals: {
          files: triage.totals.files,
          additions: triage.totals.additions,
          deletions: triage.totals.deletions,
        },
        sourceFiles: triageSummary?.sourceFiles,
        testFiles: triageSummary?.testFiles,
        generatedFiles: triageSummary?.generatedFiles,
        missingTestsWarning: triageSummary?.missingTestsWarning,
        largeDiffTriggered: triageSummary?.largeDiffTriggered,
        triageRisks: triageSummary?.risks,
        hygieneWarnings,
        blastRadius,
      })
      : undefined;
    const releaseNotesMarkdown = (commits.length > 0 || triage.totals.files > 0)
      ? draftCategorizedReleaseNotes({
        sourceBranch,
        targetBranch,
        commits,
        files: triage.files.map(item => ({ path: item.path, status: item.status })),
        triageRisks: triageSummary?.risks,
        breakingExports: blastRadius?.touchedExports,
      }).markdown
      : undefined;
    return {
      full: buildStructuredMergeRequestDescription({ sourceBranch, targetBranch, commits, triage, mode: 'full' }),
      compact: buildStructuredMergeRequestDescription({ sourceBranch, targetBranch, commits, triage, mode: 'compact' }),
      ...(triageSummary ? { triage: triageSummary } : {}),
      ...(scorecard ? { scorecard } : {}),
      ...(releaseNotesMarkdown ? { releaseNotesMarkdown } : {}),
    };
  } catch {
    return { full: '', compact: '' };
  }
}

async function readSelection(input: unknown) {
  const data = inputSchema.parse(input);
  const { snapshot, remote, repository, provider } = await readRepository(data);
  for (const branch of [data.sourceBranch, data.targetBranch]) {
    if (branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch)) throw fail('分支名称格式不正确。');
    await git(snapshot.directory, ['check-ref-format', `refs/heads/${branch}`]);
  }
  if (data.sourceBranch === data.targetBranch) throw fail('源分支和目标分支不能相同。');
  const { sourceSha, targetSha } = await readRemoteBranchHeads(snapshot.directory, remote.name, data);
  if (!sourceSha) throw fail('源分支尚未推送到所选远端，请先推送再创建合并请求。');
  if (!targetSha) throw fail('目标分支在远端不存在，请刷新远端分支后重新选择。');
  const current = snapshot.branches.find(item => item.current && !item.remote);
  const currentIsSource = current?.upstreamRemote === remote.name && current.upstreamRef === `refs/heads/${data.sourceBranch}`
    || snapshot.branch === data.sourceBranch;
  if (currentIsSource && sourceSha !== snapshot.head) throw fail('当前分支与远端源分支提交不一致，请先同步并推送，再创建合并请求。');
  const autoAnalysis = data.description === undefined
    ? await buildAutoMergeAnalysis(snapshot.directory, data.sourceBranch, data.targetBranch, sourceSha, targetSha)
    : { full: data.description, compact: data.description.slice(0, 1100), triage: undefined, scorecard: undefined, releaseNotesMarkdown: undefined };
  const prepared: ProjectMergeRequestPreparation = { mode: provider === 'Codeup' ? 'api' : 'browser', provider,
    remote: remote.name, sourceBranch: data.sourceBranch, targetBranch: data.targetBranch, sourceSha, targetSha,
    revision: snapshot.revision, repositoryUrl: remote.webUrl, url: '',
    title: data.title || `合并 ${data.sourceBranch} 到 ${data.targetBranch}`,
    description: data.description ?? autoAnalysis.full, canCreate: true,
    ...(autoAnalysis.triage ? { triage: autoAnalysis.triage } : {}),
    ...(autoAnalysis.scorecard ? { scorecard: autoAnalysis.scorecard } : {}),
    ...(autoAnalysis.releaseNotesMarkdown ? { releaseNotesMarkdown: autoAnalysis.releaseNotesMarkdown } : {}) };
  return { data, snapshot, repository, prepared, compactDescription: autoAnalysis.compact };
}

function browserUrl(info: ProjectMergeRequestPreparation, bodyOverride?: string) {
  const body = bodyOverride ?? info.description;
  // https://docs.github.com/en/pull-requests/reference/using-query-parameters-to-create-a-pull-request
  if (info.provider === 'GitHub') {
    const url = new URL(`${info.repositoryUrl}/compare/${encodeURIComponent(info.targetBranch)}...${encodeURIComponent(info.sourceBranch)}`);
    url.search = new URLSearchParams({ quick_pull: '1', title: info.title, body }).toString();
    return url.href;
  }
  const url = new URL(`${info.repositoryUrl}/-/merge_requests/new`);
  url.search = new URLSearchParams({ 'merge_request[source_branch]': info.sourceBranch,
    'merge_request[target_branch]': info.targetBranch, 'merge_request[title]': info.title,
    'merge_request[description]': body }).toString();
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

async function readOptionalTokenFile(filePath: string, label: string): Promise<string | undefined> {
  try {
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8')) as { token?: unknown };
    if (typeof saved.token !== 'string' || !saved.token.trim() || /[\x00-\x20\x7f]/.test(saved.token)) {
      throw fail(`${label}令牌配置无效，请重新保存。`);
    }
    return saved.token.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw fail(`${label}令牌配置无法读取或格式无效，请重新保存。`);
  }
}

type ExternalPlatformClient = {
  kind: 'GitHub' | 'GitLab';
  listOpen(): Promise<ProjectMergeRequestListItem[]>;
  findExisting(info: RequestBranches): Promise<ProjectMergeRequest | undefined>;
  create(info: ProjectMergeRequestPreparation, title: string, description: string): Promise<ProjectMergeRequest>;
};

async function githubClient(repository: URL, options: Options): Promise<ExternalPlatformClient | undefined> {
  const token = await readOptionalTokenFile(path.join(options.dataDirectory, 'github-credentials.json'), 'GitHub ');
  if (!token) return undefined;
  const fullPath = decodeURIComponent(repository.pathname.replace(/^\//, '').replace(/\/$/, ''));
  const parts = fullPath.split('/').filter(Boolean);
  if (parts.length !== 2) throw fail('GitHub 仓库路径需为 owner/repo 格式。');
  const [owner, repo] = parts as [string, string];
  const apiBase = repository.hostname === 'github.com' ? 'https://api.github.com' : `${repository.origin}/api/v3`;
  const repoSlug = `${owner}/${repo}`;
  const webPrefix = `${repository.origin}/${repoSlug}/pull/`;

  async function ghApi(suffix: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    let response: Response, text: string;
    try {
      response = await (options.fetcher || fetch)(`${apiBase}${suffix}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch {
      throw fail('GitHub 连接失败或超时，请稍后重试。');
    }
    if (Buffer.byteLength(text) > 2_000_000) throw fail('GitHub 响应过大。');
    if (!response.ok) {
      throw Object.assign(fail(`GitHub 请求失败 (${response.status})，请检查令牌权限或分支状态。`), {
        rejected: [400, 401, 403, 404, 422].includes(response.status),
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fail('GitHub 未返回有效的 JSON。');
    }
  }

  type GhPr = {
    number?: unknown;
    html_url?: unknown;
    title?: unknown;
    state?: unknown;
    user?: { login?: unknown } | null;
    head?: { ref?: unknown; repo?: { full_name?: unknown } | null } | null;
    base?: { ref?: unknown; repo?: { full_name?: unknown } | null } | null;
  };

  function parsePr(raw: unknown): ProjectMergeRequestListItem {
    const item = raw as GhPr;
    const num = Number(item?.number);
    const htmlUrl = typeof item?.html_url === 'string' ? item.html_url : '';
    const src = typeof item?.head?.ref === 'string' ? item.head.ref : '';
    const dst = typeof item?.base?.ref === 'string' ? item.base.ref : '';
    if (
      !Number.isSafeInteger(num)
      || num <= 0
      || !htmlUrl.startsWith(webPrefix)
      || !src
      || !dst
      || (item?.base?.repo?.full_name && String(item.base.repo.full_name).toLowerCase() !== repoSlug.toLowerCase())
    ) {
      throw fail('GitHub 返回的 Pull Request 与当前仓库不一致。');
    }
    const author = typeof item?.user?.login === 'string' && item.user.login.trim() ? item.user.login.trim() : undefined;
    return {
      id: num,
      url: htmlUrl,
      title: typeof item.title === 'string' ? item.title : `PR #${num}`,
      state: String(item.state || 'open').toUpperCase(),
      sourceBranch: src,
      targetBranch: dst,
      ...(author ? { author } : {}),
    };
  }

  async function listOpen(): Promise<ProjectMergeRequestListItem[]> {
    const raw = await ghApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`);
    if (!Array.isArray(raw)) throw fail('GitHub 未返回有效的 Pull Request 列表。');
    return raw.map(parsePr);
  }

  return {
    kind: 'GitHub',
    listOpen,
    async findExisting(info) {
      const openList = await listOpen();
      const matched = openList.find(item => item.sourceBranch === info.sourceBranch && item.targetBranch === info.targetBranch);
      return matched ? { id: matched.id, url: matched.url, title: matched.title, state: matched.state } : undefined;
    },
    async create(info, title, description) {
      const created = parsePr(
        await ghApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
          title,
          body: description,
          head: info.sourceBranch,
          base: info.targetBranch,
        }),
      );
      const readback = parsePr(await ghApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${created.id}`));
      if (readback.id !== created.id || readback.sourceBranch !== info.sourceBranch || readback.targetBranch !== info.targetBranch) {
        throw fail('创建后的 GitHub Pull Request 回读不一致。');
      }
      return { id: readback.id, url: readback.url, title: readback.title, state: readback.state };
    },
  };
}

async function gitlabClient(repository: URL, options: Options): Promise<ExternalPlatformClient | undefined> {
  const loadedToken = await readOptionalTokenFile(path.join(options.dataDirectory, 'gitlab-credentials.json'), 'GitLab ');
  if (!loadedToken) return undefined;
  const authToken: string = loadedToken;
  const fullPath = decodeURIComponent(repository.pathname.replace(/^\//, '').replace(/\/$/, ''));
  if (!fullPath.includes('/')) throw fail('GitLab 仓库路径无效。');
  const encodedProject = encodeURIComponent(fullPath);
  const apiBase = `${repository.origin}/api/v4/projects/${encodedProject}`;
  const webPrefix = `${repository.origin}/${fullPath}/`;

  async function glApi(suffix: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    let response: Response, text: string;
    const reqHeaders: Record<string, string> = { 'PRIVATE-TOKEN': authToken };
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
    try {
      response = await (options.fetcher || fetch)(`${apiBase}${suffix}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: reqHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch {
      throw fail('GitLab 连接失败或超时，请稍后重试。');
    }
    if (Buffer.byteLength(text) > 2_000_000) throw fail('GitLab 响应过大。');
    if (!response.ok) {
      throw Object.assign(fail(`GitLab 请求失败 (${response.status})，请检查令牌权限或分支状态。`), {
        rejected: [400, 401, 403, 404, 409, 422].includes(response.status),
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fail('GitLab 未返回有效的 JSON。');
    }
  }

  type GlMr = {
    iid?: unknown;
    web_url?: unknown;
    title?: unknown;
    state?: unknown;
    source_branch?: unknown;
    target_branch?: unknown;
    author?: { name?: unknown; username?: unknown } | null;
  };

  function parseMr(raw: unknown): ProjectMergeRequestListItem {
    const item = raw as GlMr;
    const iid = Number(item?.iid);
    const webUrl = typeof item?.web_url === 'string' ? item.web_url : '';
    const src = typeof item?.source_branch === 'string' ? item.source_branch : '';
    const dst = typeof item?.target_branch === 'string' ? item.target_branch : '';
    if (!Number.isSafeInteger(iid) || iid <= 0 || !webUrl.startsWith(webPrefix) || !src || !dst) {
      throw fail('GitLab 返回的合并请求与当前仓库不一致。');
    }
    const author = [item?.author?.name, item?.author?.username].find(v => typeof v === 'string' && v.trim()) as string | undefined;
    return {
      id: iid,
      url: webUrl,
      title: typeof item.title === 'string' ? item.title : `!${iid}`,
      state: String(item.state || 'opened').toUpperCase(),
      sourceBranch: src,
      targetBranch: dst,
      ...(author ? { author: author.trim() } : {}),
    };
  }

  async function listOpen(): Promise<ProjectMergeRequestListItem[]> {
    const raw = await glApi('/merge_requests?state=opened&per_page=100');
    if (!Array.isArray(raw)) throw fail('GitLab 未返回有效的合并请求列表。');
    return raw.map(parseMr);
  }

  return {
    kind: 'GitLab',
    listOpen,
    async findExisting(info) {
      const openList = await listOpen();
      const matched = openList.find(item => item.sourceBranch === info.sourceBranch && item.targetBranch === info.targetBranch);
      return matched ? { id: matched.id, url: matched.url, title: matched.title, state: matched.state } : undefined;
    },
    async create(info, title, description) {
      const created = parseMr(
        await glApi('/merge_requests', {
          source_branch: info.sourceBranch,
          target_branch: info.targetBranch,
          title,
          description,
        }),
      );
      const readback = parseMr(await glApi(`/merge_requests/${created.id}`));
      if (readback.id !== created.id || readback.sourceBranch !== info.sourceBranch || readback.targetBranch !== info.targetBranch) {
        throw fail('创建后的 GitLab 合并请求回读不一致。');
      }
      return { id: readback.id, url: readback.url, title: readback.title, state: readback.state };
    },
  };
}

type CodeupRequestResponse = {
  localId?: unknown; sourceBranch?: unknown; targetBranch?: unknown; sourceProjectId?: unknown; targetProjectId?: unknown;
  webUrl?: unknown; detailUrl?: unknown; title?: unknown; status?: unknown; state?: unknown; reviewers?: unknown;
  allRequirementsPass?: unknown; conflictCheckStatus?: unknown;
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
  if (provider === 'GitHub') {
    const gh = await githubClient(repository, options);
    if (!gh) throw fail('当前远端尚未配置 GitHub 令牌，请在代码平台查看或配置 github-credentials.json。');
    return { requests: await gh.listOpen() };
  }
  if (provider === 'GitLab') {
    const gl = await gitlabClient(repository, options);
    if (!gl) throw fail('当前远端尚未配置 GitLab 令牌，请在代码平台查看或配置 gitlab-credentials.json。');
    return { requests: await gl.listOpen() };
  }
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

export async function mergeProjectMergeRequest(input: unknown, options: Options) {
  const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  const data = inputSchema.omit({ providerOverride: true, title: true, description: true }).extend({
    id: z.number().int().positive(), repositoryUrl: z.url(),
    expectedSourceSha: sha, expectedTargetSha: sha,
  }).parse(input);
  if (data.sourceBranch === data.targetBranch) throw fail('源分支和目标分支不能相同。');
  const initial = await readProjectGitSnapshot(data.path);
  if (!initial.isGit) throw fail('当前目录不是 Git 仓库。');

  return withProjectGitLock(initial.directory, async () => {
    const { snapshot, remote, repository } = await readRepository(data);
    if (repository.hostname !== 'codeup.aliyun.com' || repository.href !== data.repositoryUrl) {
      throw fail('当前远端已变化，请刷新合并请求列表。');
    }
    for (const branch of [data.sourceBranch, data.targetBranch]) {
      await git(snapshot.directory, ['check-ref-format', `refs/heads/${branch}`]);
    }
    const client = await codeupClient(repository, options);
    if (!client) throw fail('请先在云效设置中保存具有合并请求读写权限的个人访问令牌。');
    const { api, repositoryId } = client;
    const endpoint = `/repositories/${repositoryId}/changeRequests/${data.id}`;
    async function readRequest() {
      const { value } = await api(endpoint);
      const item = value as CodeupRequestResponse;
      if (item?.localId !== data.id || typeof item.title !== 'string') throw fail('Codeup 返回的合并请求编号或标题无法核对。');
      return { item, request: listedRequest(item, { ...data, title: item.title }, repositoryId) };
    }

    const current = await readRequest();
    if (current.request.state.toUpperCase() === 'MERGED') return { request: current.request, alreadyMerged: true };
    if (current.request.state.toUpperCase() !== 'TO_BE_MERGED') throw fail('Codeup 合并请求当前不处于待合并状态，请刷新后核对。');
    if (current.item.allRequirementsPass === false) throw fail('Codeup 合并检查尚未全部通过，请到 Codeup 查看。');
    if (current.item.conflictCheckStatus === 'HAS_CONFLICT') throw fail('Codeup 检测到合并冲突，请处理后再试。');

    const { sourceSha, targetSha } = await readRemoteBranchHeads(snapshot.directory, remote.name, data);
    if (sourceSha !== data.expectedSourceSha || targetSha !== data.expectedTargetSha) {
      throw fail('远端分支提交已变化，请获取远端分支后重新确认。');
    }
    // Codeup 的合并 API 没有预期 SHA 参数，调用前核对分支，合并规则由 Codeup 执行。
    // https://help.aliyun.com/zh/yunxiao/developer-reference/mergechangerequest-merge-merge-request
    let rejection: Error | undefined;
    try {
      await api(`${endpoint}/merge`, { mergeType: 'no-fast-forward', removeSourceBranch: false });
    } catch (error) {
      if (error instanceof Error && (error as { rejected?: boolean }).rejected) rejection = error;
    }
    const updated = await readRequest().catch(() => undefined);
    if (updated?.request.state.toUpperCase() === 'MERGED') return { request: updated.request, alreadyMerged: false };
    if (rejection) throw rejection;
    throw fail('合并结果尚未确认，请到 Codeup 查看请求状态后再操作。');
  });
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

export async function updateProjectMergeRequestDescription(input: unknown, options: Options) {
  const data = inputSchema.extend({
    id: z.number().int().positive(),
    repositoryUrl: z.url(),
  }).parse(input);
  for (const branch of [data.sourceBranch, data.targetBranch]) {
    if (branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch)) throw fail('分支名称格式不正确。');
  }
  if (data.sourceBranch === data.targetBranch) throw fail('源分支和目标分支不能相同。');
  const { snapshot } = await readRepository(data);
  return withProjectGitLock(snapshot.directory, async () => {
    const { snapshot: latestSnapshot, remote, repository, provider } = await readRepository(data);
    if (provider !== 'Codeup' || repository.href !== data.repositoryUrl) throw fail('当前远端已变化，请刷新合并请求列表。');
    for (const branch of [data.sourceBranch, data.targetBranch]) {
      await git(latestSnapshot.directory, ['check-ref-format', `refs/heads/${branch}`]);
    }
    const client = await codeupClient(repository, options);
    if (!client) throw fail('请先在云效设置中保存具有合并请求读写权限的个人访问令牌。');
    const { api, repositoryId } = client;

    let nextDescription = data.description;
    let triage: MergeDiffTriageSummary | undefined;
    if (nextDescription === undefined) {
      const { sourceSha, targetSha } = await readRemoteBranchHeads(latestSnapshot.directory, remote.name, data);
      if (!sourceSha || !targetSha) throw fail('远端源分支或目标分支不存在，请刷新合并请求列表。');
      const hasObjects = await exec('git', ['--no-replace-objects', '-C', latestSnapshot.directory, 'cat-file', '-e', `${sourceSha}^{commit}`], { timeout: 5000 })
        .then(() => exec('git', ['--no-replace-objects', '-C', latestSnapshot.directory, 'cat-file', '-e', `${targetSha}^{commit}`], { timeout: 5000 }))
        .then(() => true, () => false);
      if (!hasObjects) throw fail('本机尚未获取该合并请求的最新远端提交，请先点击“获取远端分支”后再同步变更摘要。');
      const autoAnalysis = await buildAutoMergeAnalysis(latestSnapshot.directory, data.sourceBranch, data.targetBranch, sourceSha, targetSha);
      if (!autoAnalysis.full.trim()) throw fail('目标分支已包含源分支提交或暂无可生成的变更摘要。');
      nextDescription = autoAnalysis.full;
      triage = autoAnalysis.triage;
    }

    const endpoint = `/repositories/${repositoryId}/changeRequests/${data.id}`;
    async function readRequest() {
      const { value } = await api(endpoint);
      const item = value as CodeupRequestResponse & { description?: unknown };
      if (item?.localId !== data.id || typeof item.title !== 'string') throw fail('Codeup 返回的合并请求编号或标题无法核对。');
      return {
        listed: listedRequest(item, { ...data, title: item.title }, repositoryId),
        description: typeof item.description === 'string' ? item.description : undefined,
      };
    }
    const current = await readRequest();
    if (['CLOSED', 'MERGED'].includes(current.listed.state.toUpperCase())) throw fail('合并请求已结束，请刷新列表。');
    if (current.description === nextDescription) {
      return { request: current.listed, description: nextDescription, ...(triage ? { triage } : {}) };
    }

    let result: unknown;
    try { result = (await api(endpoint, { description: nextDescription }, 'PUT')).value; }
    catch (error) {
      if ((error as { rejected?: boolean }).rejected) throw error;
      throw fail('说明保存结果尚未确认，请到 Codeup 核对后再操作。');
    }
    if ((result as { result?: boolean } | null)?.result === false) throw fail('Codeup 未能保存合并请求说明，请刷新后再试。');
    const updated = await readRequest().catch(() => undefined);
    if (!updated || (updated.description !== undefined && updated.description !== nextDescription)) {
      throw fail('说明保存结果尚未确认，请到 Codeup 核对后再操作。');
    }
    return { request: updated.listed, description: nextDescription, ...(triage ? { triage } : {}) };
  });
}

function pendingFile(info: ProjectMergeRequestPreparation, options: Options) {
  const key = createHash('sha256').update(JSON.stringify([info.repositoryUrl, info.sourceBranch, info.targetBranch])).digest('hex');
  return path.join(options.dataDirectory, 'project-merge-requests', `${key}.json`);
}

async function prepare(input: unknown, options: Options) {
  const selection = await readSelection(input);
  const info = selection.prepared;
  if (info.provider === 'GitHub' || info.provider === 'GitLab') {
    const externalClient = info.provider === 'GitHub'
      ? await githubClient(selection.repository, options)
      : await gitlabClient(selection.repository, options);
    if (!externalClient) {
      info.url = browserUrl(info, selection.compactDescription);
      return { ...selection, client: undefined, externalClient: undefined };
    }
    info.mode = 'api';
    const existing = await externalClient.findExisting(info);
    if (existing) {
      info.existing = existing; info.url = existing.url; info.canCreate = false;
      await fs.rm(pendingFile(info, options), { force: true });
    } else if (await fs.stat(pendingFile(info, options)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      info.canCreate = false; info.reason = unknownMessage; info.url = info.repositoryUrl;
    } else if (info.sourceSha === info.targetSha || await git(selection.snapshot.directory,
      ['--no-replace-objects', 'merge-base', '--is-ancestor', info.sourceSha, info.targetSha]).then(() => true, () => false)) {
      info.canCreate = false;
      info.reason = '目标分支已包含源分支的全部提交，没有可合并的变更。';
    }
    return { ...selection, client: undefined, externalClient };
  }
  if (info.provider !== 'Codeup') { info.url = browserUrl(info, selection.compactDescription); return { ...selection, client: undefined, externalClient: undefined }; }
  const client = await codeupClient(selection.repository, options);
  if (!client) {
    info.mode = 'unavailable'; info.canCreate = false; info.url = info.repositoryUrl;
    info.reason = '请先在云效设置中保存具有代码库只读、合并请求读写权限的个人访问令牌。';
    return { ...selection, client, externalClient: undefined };
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
  return { ...selection, client, externalClient: undefined };
}

export async function prepareProjectMergeRequest(input: unknown, options: Options): Promise<ProjectMergeRequestPreparation> {
  return (await prepare(input, options)).prepared;
}

export async function reconcileProjectMergeRequest(input: unknown, options: Options): Promise<ProjectMergeRequestPreparation> {
  const data = inputSchema.parse(input);
  const initial = await readProjectGitSnapshot(data.path);
  if (!initial.isGit) throw fail('当前目录不是 Git 仓库。');
  return withProjectGitLock(initial.directory, async () => {
    const selection = await readSelection(data);
    const info = selection.prepared;
    if (info.provider === 'GitHub' || info.provider === 'GitLab') {
      const ext = info.provider === 'GitHub'
        ? await githubClient(selection.repository, options)
        : await gitlabClient(selection.repository, options);
      if (!ext) return (await prepare(data, options)).prepared;
      const existing = await ext.findExisting(info);
      await fs.rm(pendingFile(info, options), { force: true });
      if (existing) {
        info.mode = 'api'; info.existing = existing; info.url = existing.url; info.canCreate = false;
        return info;
      }
      return (await prepare(data, options)).prepared;
    }
    if (info.provider !== 'Codeup') return (await prepare(data, options)).prepared;
    const client = await codeupClient(selection.repository, options);
    if (!client) throw fail('请先在云效设置中保存个人访问令牌后再执行核对。');
    const existing = await findExisting(client, info);
    await fs.rm(pendingFile(info, options), { force: true });
    if (existing) {
      info.existing = existing;
      info.url = existing.url;
      info.canCreate = false;
      return info;
    }
    return (await prepare(data, options)).prepared;
  });
}

export async function createProjectMergeRequest(input: unknown, options: CreateOptions) {
  const data = inputSchema.extend({ title: z.string().trim().min(1).max(256),
    expectedSourceSha: z.string().regex(/^[a-f0-9]{40,64}$/), expectedTargetSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).parse(input);
  const initial = await readProjectGitSnapshot(data.path);
  if (!initial.isGit) throw fail('当前目录不是 Git 仓库。');
  return withProjectGitLock(initial.directory, async () => {
    const { prepared: info, client, externalClient } = await prepare(data, options);
    if (info.sourceSha !== data.expectedSourceSha || info.targetSha !== data.expectedTargetSha) throw fail('远端分支提交已变化，请重新准备并确认合并请求。');
    if (info.existing) return { ok: true, created: false, request: info.existing };
    if (info.mode !== 'api' || (!client && !externalClient) || !info.canCreate) throw fail(info.reason || '请前往代码平台创建合并请求。');
    if (externalClient) {
      const latest = (await readSelection(data)).prepared;
      if (latest.repositoryUrl !== info.repositoryUrl || latest.sourceSha !== data.expectedSourceSha || latest.targetSha !== data.expectedTargetSha) {
        throw fail('远端分支提交已变化，请重新准备并确认合并请求。');
      }
      await options.beforeCreate?.();
      const file = pendingFile(info, options);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, JSON.stringify({ repositoryUrl: info.repositoryUrl, sourceBranch: info.sourceBranch,
        targetBranch: info.targetBranch, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      try {
        const confirmed = await externalClient.create(
          info,
          data.title,
          data.description !== undefined ? data.description : info.description,
        );
        await fs.rm(file, { force: true });
        return { ok: true, created: true, request: confirmed };
      } catch (error) {
        if ((error as { rejected?: boolean }).rejected) { await fs.rm(file, { force: true }); throw error; }
        throw fail(unknownMessage);
      }
    }
    const reviewerId = options.reviewer ? await resolveCodeupReviewer(client!, options.reviewer) : undefined;
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
        title: data.title, description: data.description !== undefined ? data.description : info.description, sourceBranch: info.sourceBranch, targetBranch: info.targetBranch,
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

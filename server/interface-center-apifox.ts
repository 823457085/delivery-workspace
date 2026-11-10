/** Apifox 账号连接与显式契约同步；令牌仅在本机凭据存储，预览不写远端。
 * 账号/项目读取依据官方 apifox-cli 2.2.12 的公开客户端；导入导出采用官方 Open API 2024-03-28。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ApiProject } from '../shared/interface-center.js';
import type { ApifoxAccount, ApifoxConnection, ApifoxProject, ApifoxSyncPreview, ApifoxSyncResult, ApifoxTeam } from '../shared/interface-center-apifox.js';
import { apiOperations, maxContractBytes, parseApiDocument, type ApiDocument } from './interface-center-document.js';

export interface ApifoxCredentials {
  get(): Promise<string | undefined>; set(token: string): Promise<void>; delete(): Promise<void>;
}
export interface ApifoxServiceOptions { fetch?: typeof fetch; credentials?: ApifoxCredentials }
type State = { version: 1; account?: ApifoxAccount; preferredTeamId?: string; checkedAt?: string };
const execute = promisify(execFile);
const identifier = z.string().regex(/^[1-9]\d{0,14}$/);
const connectionInput = z.object({ token: z.string().trim().min(8).max(8192).regex(/^[A-Za-z0-9._~+/=-]+$/) }).strict();
const previewInput = z.object({ teamId: identifier, targetProjectId: identifier, mode: z.enum(['keep', 'overwrite']).default('keep') }).strict();
const exportInput = previewInput.pick({ teamId: true }).extend({ projectId: identifier });
const digest = (value: unknown): string => {
  const stable = (item: any): any => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
};
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const remoteId = (value: unknown) => identifier.parse(String(value));

function keychainCredentials(directory: string): ApifoxCredentials {
  const service = 'Delivery-Workspace-Apifox', account = digest(path.resolve(directory)).slice(0, 32);
  const supported = () => { if (process.platform !== 'darwin') throw new Error('当前平台尚未配置安全凭据存储'); };
  const get = async () => {
    supported();
    try { return (await execute('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { timeout: 15_000 })).stdout.trim(); }
    catch (error) { if ((error as { code?: number }).code === 44) return undefined; throw new Error('无法读取 Apifox 连接，请检查本机钥匙串权限'); }
  };
  return {
    get,
    async set(token) {
      supported();
      // 通过 stdin 传入十六进制密码，凭据不出现在进程参数或命令日志里。
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
        let timedOut = false, killTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          timedOut = true; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        }, 15_000);
        const clear = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); };
        child.once('error', () => { clear(); reject(new Error('无法保存 Apifox 凭据')); });
        child.once('close', code => {
          clear();
          if (timedOut) reject(new Error('保存 Apifox 凭据超时'));
          else code === 0 ? resolve() : reject(new Error('无法保存 Apifox 凭据'));
        });
        child.stdin.on('error', () => {});
        // security -i 遇到 stdin EOF 会退出，quit 不是它支持的命令。
        child.stdin.end(`add-generic-password -U -a ${account} -s ${service} -X ${Buffer.from(token).toString('hex')}\n`);
      });
      if (await get() !== token) throw new Error('Apifox 凭据未保存，请检查本机钥匙串权限');
    },
    async delete() {
      supported();
      try { await execute('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service], { timeout: 15_000 }); }
      catch (error) { if ((error as { code?: number }).code !== 44) throw new Error('无法移除 Apifox 连接'); }
    },
  };
}

export async function createApifoxConnection(directory: string, options: ApifoxServiceOptions = {}) {
  const credentials = options.credentials || keychainCredentials(directory), request = options.fetch || fetch;
  const filename = path.join(directory, 'apifox.json');
  let state: State = { version: 1 }, teams: ApifoxTeam[] = [], queue = Promise.resolve();
  try {
    state = z.object({ version: z.literal(1), account: z.object({ id: identifier, name: z.string() }).optional(),
      preferredTeamId: identifier.optional(), checkedAt: z.string().datetime().optional() }).strict().parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Apifox 连接配置无法读取，原文件已保留'); }
  const previews = new Map<string, { value: ApifoxSyncPreview; localHash: string; remoteHash: string; accountId: string }>();
  const completed = new Map<string, { localProjectId: string; result: ApifoxSyncResult }>();
  const serial = <T>(work: () => Promise<T>) => {
    const task = queue.then(work); queue = task.then(() => {}, () => {}); return task;
  };
  async function save(next: State) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename); state = next; }
    finally { await fs.rm(temporary, { force: true }); }
  }
  const snapshot = (): ApifoxConnection => structuredClone({ configured: !!state.account, account: state.account, teams, preferredTeamId: state.preferredTeamId, checkedAt: state.checkedAt });
  async function token() {
    if (!state.account) throw new Error('请先连接 Apifox 账号');
    const value = await credentials.get(); if (!value) throw new Error('请先连接 Apifox 账号'); return value;
  }
  async function call(route: string, accessToken: string, body?: unknown, projectId?: string) {
    let response: Response;
    try {
      response = await request(`https://api.apifox.com${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${accessToken}`, 'X-Apifox-Api-Version': route.startsWith('/api/') ? '2026-05-28' : '2024-03-28',
          ...(projectId ? { 'X-Project-Id': projectId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('Apifox 请求未完成，请检查连接后重新预览'); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (reader) try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > maxContractBytes * 2) { await reader.cancel(); throw new Error('Apifox 响应超过大小限制'); } chunks.push(next.value); } }
    catch { throw new Error('Apifox 响应读取未完成，请重试读取'); }
    let data: any;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(`Apifox 返回了无法解析的响应（HTTP ${response.status}）`); }
    if (!response.ok || data?.success === false) {
      const message = typeof data?.message === 'string' ? data.message : typeof data?.errorMessage === 'string' ? data.errorMessage : `Apifox 请求失败（HTTP ${response.status}）`;
      throw new Error(message.split(accessToken).join('[已隐藏凭据]').replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [已隐藏凭据]'));
    }
    return data;
  }
  async function identity(accessToken: string) {
    const [user, memberships] = await Promise.all([call('/api/v1/current-user', accessToken), call('/api/v1/user-teams', accessToken)]);
    const value = record(user.data);
    const account = { id: remoteId(value.id), name: String(value.username || value.name || value.email || value.id) };
    if (!Array.isArray(memberships.data)) throw new Error('Apifox 团队列表格式不正确');
    const nextTeams = memberships.data.map((item: any) => ({ id: remoteId(item.id), name: String(item.name || item.id) }));
    return { account, nextTeams };
  }
  async function projects(teamId: string, accessToken: string): Promise<ApifoxProject[]> {
    identifier.parse(teamId);
    const result = await call(`/api/v1/teams/${teamId}/projects`, accessToken);
    if (!Array.isArray(result.data)) throw new Error('Apifox 项目列表格式不正确');
    return result.data.map((item: any) => ({ id: remoteId(item.id), name: String(item.name || item.id), description: String(item.description || ''), teamId }));
  }
  async function exportDocument(project: ApifoxProject, accessToken: string, forSource = false) {
    const result = await call(`/v1/projects/${project.id}/export-openapi?locale=zh-CN`, accessToken, {
      scope: { type: 'ALL' }, exportFormat: 'JSON', oasVersion: '3.1', options: { includeApifoxExtensionProperties: false, addFoldersToTags: forSource },
    }, project.id);
    let unusedRequestBodyRefs = 0;
    try {
      const invalidBodies: string[] = [];
      const document = parseApiDocument(JSON.stringify(result), (count, names) => {
        unusedRequestBodyRefs = count;
        if (forSource) invalidBodies.push(...names);
      });
      for (const name of invalidBodies) delete document.components.requestBodies[name];
      return {
        document: invalidBodies.length ? parseApiDocument(JSON.stringify(document)) : document,
        unusedRequestBodyRefs, omittedRequestBodies: invalidBodies.length,
      };
    } catch (error) {
      const direction = forSource ? '来源' : '目标';
      throw new Error(`Apifox ${direction}项目「${project.name}」导出校验失败：${error instanceof Error ? error.message : '接口文档无效'}`);
    }
  }
  const projectUrl = (id: string) => `https://app.apifox.com/project/${id}`;
  return {
    snapshot,
    connect: (input: unknown) => serial(async () => {
      const { token: accessToken } = connectionInput.parse(input), { account, nextTeams } = await identity(accessToken);
      const previous = state.account ? await credentials.get() : undefined;
      try { await credentials.set(accessToken); await save({ ...state, account, checkedAt: new Date().toISOString() }); }
      catch (error) {
        try { if (previous) await credentials.set(previous); else await credentials.delete(); }
        catch {
          state = { version: 1, preferredTeamId: state.preferredTeamId }; teams = []; previews.clear(); completed.clear();
          await save(state).catch(() => {});
          throw new Error('凭据保存失败且旧连接未恢复，请重新连接 Apifox');
        }
        throw error;
      }
      teams = nextTeams; previews.clear(); completed.clear(); return snapshot();
    }),
    refresh: () => serial(async () => {
      const { account, nextTeams } = await identity(await token());
      if (state.account?.id !== account.id) { previews.clear(); completed.clear(); }
      await save({ ...state, account, checkedAt: new Date().toISOString() }); teams = nextTeams; return snapshot();
    }),
    disconnect: () => serial(async () => {
      await credentials.delete(); await save({ version: 1, preferredTeamId: state.preferredTeamId });
      teams = []; previews.clear(); completed.clear(); return snapshot();
    }),
    projects: (teamId: string) => serial(async () => {
      const result = await projects(teamId, await token());
      await save({ ...state, preferredTeamId: teamId }); return result;
    }),
    readProject: (input: unknown) => serial(async () => {
      const { teamId, projectId } = exportInput.parse(input), accessToken = await token();
      const project = (await projects(teamId, accessToken)).find(item => item.id === projectId);
      if (!project) throw new Error('Apifox 项目不属于所选团队或当前账号无权访问');
      const { document, omittedRequestBodies } = await exportDocument(project, accessToken, true);
      return { project, document, omittedRequestBodies };
    }),
    preview: (project: ApiProject, document: ApiDocument, input: unknown) => serial(async () => {
      const data = previewInput.parse(input), accessToken = await token();
      const target = (await projects(data.teamId, accessToken)).find(item => item.id === data.targetProjectId);
      if (!target) throw new Error('目标项目不属于所选团队或当前账号无权访问');
      const remote = await exportDocument(target, accessToken), remoteKeys = new Set(apiOperations(remote.document).map(item => item.key));
      const localKeys = new Set(apiOperations(document).map(item => item.key));
      const value: ApifoxSyncPreview = { id: randomUUID(), localProjectId: project.id, localProjectName: project.name, targetProject: target,
        teamId: data.teamId, mode: data.mode, operationCount: localKeys.size, added: [...localKeys].filter(key => !remoteKeys.has(key)).length,
        matched: [...localKeys].filter(key => remoteKeys.has(key)).length, remoteOnly: [...remoteKeys].filter(key => !localKeys.has(key)).length,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        ...(remote.unusedRequestBodyRefs ? { unusedRequestBodyRefs: remote.unusedRequestBodyRefs } : {}) };
      if (!localKeys.size) throw new Error('当前项目没有可同步的接口');
      for (const [key, saved] of previews) if (Date.parse(saved.value.expiresAt) < Date.now()) previews.delete(key);
      if (previews.size >= 30) previews.delete(previews.keys().next().value!);
      previews.set(value.id, { value, localHash: digest(document), remoteHash: digest(remote.document), accountId: state.account?.id || '' });
      return structuredClone(value);
    }),
    sync: (readSource: () => { project: ApiProject; document: ApiDocument }, input: unknown) => serial(async () => {
      const { project, document } = readSource();
      const { previewId } = z.object({ previewId: z.string().uuid() }).strict().parse(input);
      const done = completed.get(previewId);
      if (done) { if (done.localProjectId !== project.id) throw new Error('同步项目不匹配'); return structuredClone(done.result); }
      const pending = previews.get(previewId);
      if (!pending || pending.value.localProjectId !== project.id || Date.parse(pending.value.expiresAt) < Date.now()) throw new Error('同步预览已失效，请重新预览');
      if (pending.accountId !== state.account?.id || pending.localHash !== digest(document)) throw new Error('账号或本地契约已变化，请重新预览');
      const accessToken = await token(), { value } = pending;
      if (!(await projects(value.teamId, accessToken)).some(item => item.id === value.targetProject.id)) throw new Error('目标项目已变化或无权访问，请重新选择');
      const before = await exportDocument(value.targetProject, accessToken);
      if (digest(before.document) !== pending.remoteHash) throw new Error('Apifox 契约已变化，请重新预览');
      if (pending.localHash !== digest(readSource().document)) throw new Error('本地契约已变化，请重新预览');
      previews.delete(previewId);
      const behavior = value.mode === 'keep' ? 'KEEP_EXISTING' : 'OVERWRITE_EXISTING';
      const imported = await call(`/v1/projects/${value.targetProject.id}/import-openapi?locale=zh-CN`, accessToken, {
        input: JSON.stringify(document), options: { endpointOverwriteBehavior: behavior, schemaOverwriteBehavior: behavior,
          deleteUnmatchedResources: false, updateFolderOfChangedEndpoint: false, prependBasePath: false },
      }, value.targetProject.id);
      const rawCounters = record(record(imported.data).counters), counters: Record<string, number> = {};
      for (const [key, count] of Object.entries(rawCounters)) if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counters[key] = count;
      const result: ApifoxSyncResult = { projectId: value.targetProject.id, projectUrl: projectUrl(value.targetProject.id), syncedAt: new Date().toISOString(),
        counters, verified: false, missing: value.operationCount, message: '已提交导入，结果回读未完成，请到 Apifox 核对' };
      // 导入成功后，即使回读失败，同一个预览也不会再次写入。
      completed.set(previewId, { localProjectId: project.id, result });
      if (completed.size > 30) completed.delete(completed.keys().next().value!);
      try {
        const after = await exportDocument(value.targetProject, accessToken), keys = new Set(apiOperations(after.document).map(item => item.key));
        result.missing = apiOperations(document).filter(item => !keys.has(item.key)).length;
        result.verified = result.missing === 0 && Object.keys(counters).length > 0 && !Object.entries(counters).some(([key, count]) => /Failed$/.test(key) && count > 0);
        result.message = result.verified ? '同步完成，已回读确认接口目录' : '导入已返回，但部分接口未确认同步，请到 Apifox 核对';
      } catch { /* 不因回读错误再次提交导入。 */ }
      return structuredClone(result);
    }),
    close: () => queue,
  };
}

/** 云效中心版 OpenAPI：只运行本机已关联的流水线，提交不自动重试。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DeploymentProject, DeploymentRun, YunxiaoPipeline } from '../shared/deployments.js';
import { parseDeploymentLinks } from '../src/features/deployments/native-deployments.js';
import { readYunxiaoDeploymentLog } from './yunxiao-deployment-log.js';
import { redactJenkins } from './jenkins-client.js';

const targetSchema = z.object({ projectId: z.string().min(1).max(2000), environment: z.string().trim().min(1).max(100)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value)) });
const runSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), bindingId: z.string(), projectId: z.string(), projectName: z.string(), environment: z.string(),
  jobFullName: z.string(), provider: z.literal('yunxiao'), organizationId: z.string().regex(/^[a-f0-9]{24}$/), pipelineId: z.string().regex(/^\d+$/),
  pipelineRunId: z.string().regex(/^\d+$/).optional(), status: z.enum(['dispatching', 'queued', 'running', 'success', 'failed', 'cancelled', 'unknown']),
  createdAt: z.string(), updatedAt: z.string(), result: z.string().optional(), error: z.string().optional(),
  steps: z.array(z.object({ name: z.string(), status: z.string(), jobId: z.string().regex(/^[1-9]\d*$/).optional() })).optional(),
}).strict();
const unknownMessage = '提交结果待核对，请先核对该流水线的运行记录，勿重复提交';
const active = (run: DeploymentRun) => ['dispatching', 'queued', 'running'].includes(run.status);

export async function createYunxiaoDeployments(directory: string, options: { fetcher?: typeof fetch; pollIntervalMs?: number } = {}) {
  const credentialsFile = path.join(directory, 'yunxiao-credentials.json');
  const stateFile = path.join(directory, 'yunxiao-runs.json');
  let token = '', runs: DeploymentRun[] = [];
  try { token = z.object({ token: z.string().min(1).max(2000) }).strict().parse(JSON.parse(await fs.readFile(credentialsFile, 'utf8'))).token; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('云效凭据文件格式不正确'); }
  try { runs = z.array(runSchema).parse(JSON.parse(await fs.readFile(stateFile, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('云效部署记录格式不正确'); }
  async function atomic(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  const persist = () => atomic(stateFile, runs);
  async function links() {
    let text: string;
    try { text = await fs.readFile(path.join(directory, 'yunxiao-deployments.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return parseDeploymentLinks(JSON.parse(text));
  }
  for (const run of runs) if (run.status === 'dispatching') { run.status = 'unknown'; run.error = unknownMessage; }
  if (runs.some(run => run.error === unknownMessage)) await persist();
  let pending = 0, closing = false, mutations = Promise.resolve();
  const tasks = new Set<Promise<unknown>>();
  const refreshing = new Map<string, Promise<DeploymentRun>>();
  function task<T>(work: () => Promise<T>) {
    if (closing) return Promise.reject(new Error('部署服务正在退出'));
    pending++;
    const result = work().finally(() => { pending--; tasks.delete(result); });
    tasks.add(result); return result;
  }
  function exclusive<T>(work: () => Promise<T>) {
    const result = mutations.then(work); mutations = result.then(() => {}, () => {}); return result;
  }
  const redact = (value: string) => redactJenkins(value, { baseUrl: 'https://openapi-rdc.aliyuncs.com', username: '', token });
  async function api(organizationId: string, pipelineId: string, suffix = '', body?: unknown): Promise<unknown> {
    if (!token) throw new Error('请先在云效设置中保存具有流水线读写权限的个人访问令牌');
    const response = await (options.fetcher || fetch)(`https://openapi-rdc.aliyuncs.com/oapi/v1/flow/organizations/${organizationId}/pipelines/${pipelineId}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'x-yunxiao-token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 2_000_000) throw new Error('云效响应过大');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error(`云效未返回有效 JSON (${response.status})`); }
    if (!response.ok) {
      const error = value as { message?: unknown; errorMessage?: unknown };
      throw new Error(redact(typeof error?.message === 'string' ? error.message : typeof error?.errorMessage === 'string' ? error.errorMessage : `云效请求失败 (${response.status})`));
    }
    return value;
  }
  async function target(input: unknown) {
    const data = targetSchema.parse(input);
    const projects = await links();
    const project = projects.find(item => item.id === data.projectId);
    const binding = project?.environments.find(item => item.environment === data.environment);
    if (!project || !binding) throw new Error('云效项目环境尚未关联流水线');
    return { project, binding, organizationId: project.repository.split('/')[0]!, pipelineId: new URL(binding.url).pathname.split('/')[2]!, bindingId: binding.url };
  }
  async function prepare(input: unknown): Promise<YunxiaoPipeline> {
    const info = await target(input);
    const value = await api(info.organizationId, info.pipelineId) as { name?: unknown; pipelineConfig?: { sources?: { data?: { repo?: unknown; branch?: unknown } }[] } };
    if (typeof value.name !== 'string' || !Array.isArray(value.pipelineConfig?.sources)) throw new Error('云效未返回完整的流水线与代码源信息');
    return { name: value.name, sources: value.pipelineConfig.sources.map(source => {
      if (typeof source.data?.repo !== 'string' || typeof source.data.branch !== 'string') throw new Error('云效代码源信息不完整');
      return { repo: source.data.repo, branch: source.data.branch };
    }) };
  }
  const findRun = (id: string) => { const run = runs.find(item => item.id === id); if (!run) throw new Error('云效部署记录不存在'); return run; };
  async function refresh(id: string) {
    const run = structuredClone(findRun(id));
    if (!run.pipelineRunId) return run;
    // 云效可在同一次运行中重试任务并更换 jobId，终态也必须重新查询，不能永久复用旧任务编号。
    let update: Partial<DeploymentRun>;
    try {
      const value = await api(run.organizationId!, run.pipelineId!, `/runs/${run.pipelineRunId}`) as {
        pipelineId?: unknown; pipelineRunId?: unknown; status?: unknown;
        stages?: { name: string; stageInfo?: { status: string; jobs?: { id?: unknown; name: string; status: string }[] } }[];
      };
      if (String(value.pipelineId) !== run.pipelineId || String(value.pipelineRunId) !== run.pipelineRunId || typeof value.status !== 'string') throw new Error('云效返回的运行记录与本次部署不匹配');
      const state = value.status;
      const status = state === 'SUCCESS' ? 'success' : ['FAIL', 'FAILED'].includes(state) ? 'failed'
        : ['CANCELED', 'CANCELLED', 'STOPPED'].includes(state) ? 'cancelled'
        : ['QUEUED', 'PENDING', 'WAITING'].includes(state) ? 'queued' : state === 'RUNNING' ? 'running' : 'unknown';
      update = { status, result: state, error: undefined, steps: (value.stages || []).flatMap(stage => [
        { name: stage.name, status: stage.stageInfo?.status || '' }, ...(stage.stageInfo?.jobs || []).map(job => {
          const jobId = typeof job.id === 'string' || typeof job.id === 'number' && Number.isSafeInteger(job.id) ? String(job.id) : '';
          return { name: job.name, status: job.status, ...(/^[1-9]\d*$/.test(jobId) ? { jobId } : {}) };
        }),
      ]) };
    } catch (error) { update = { error: redact(error instanceof Error ? error.message : '云效状态查询失败') }; }
    return exclusive(async () => {
      const current = findRun(id), next = { ...current, ...update, updatedAt: new Date().toISOString() };
      runs[runs.indexOf(current)] = next; await persist(); return structuredClone(next);
    });
  }
  function getRun(id: string) {
    if (!refreshing.has(id)) {
      const promise = task(() => refresh(id)).finally(() => refreshing.delete(id)); refreshing.set(id, promise);
    }
    return refreshing.get(id)!;
  }
  const timer = options.pollIntervalMs === 0 ? undefined : setInterval(() => {
    if (!closing) void Promise.allSettled(runs.filter(run => run.pipelineRunId && (active(run) || run.status === 'unknown')).map(run => getRun(run.id)));
  }, options.pollIntervalMs || 5000).unref();
  return {
    snapshot: () => task(async () => ({ config: { hasToken: !!token }, runs: structuredClone(runs.slice(-200)) })),
    links: () => task(() => links()),
    saveManualBinding: (input: unknown, localProject?: DeploymentProject) => task(() => exclusive(async () => {
      const data = targetSchema.extend({ url: z.string().trim().min(1).max(2000) }).strict().parse(input);
      let url: URL;
      try { url = new URL(data.url); } catch { throw new Error('请输入完整的云效流水线地址'); }
      if (/[\u0000-\u0020\u007f\\]/.test(data.url) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(data.url)
        || url.origin !== 'https://flow.aliyun.com' || url.username || url.password || url.search || url.hash
        || !/^\/pipelines\/[1-9]\d*\/current\/?$/.test(url.pathname)) throw new Error('云效流水线地址不正确');
      const projects = await links();
      let project = projects.find(item => item.id === data.projectId);
      if (!project) {
        if (!localProject || localProject.id !== data.projectId || localProject.id !== `codeup.aliyun.com:${localProject.repository}`) {
          throw new Error('请选择当前工作台中的 Codeup 项目，再添加云效流水线');
        }
        project = { id: localProject.id, name: localProject.name, repository: localProject.repository,
          projectUrl: `https://codeup.aliyun.com/${localProject.repository}/pipeline`, environments: [] };
        projects.push(project);
      }
      const normalizedUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
      const existing = project.environments.find(item => item.environment === data.environment);
      if (existing) {
        if (existing.url === normalizedUrl) return structuredClone(existing);
        throw new Error('该项目环境已关联其他云效流水线，请填写新的环境名称');
      }
      if (projects.flatMap(item => item.environments).length >= 500) throw new Error('部署关联数量已达上限');
      const binding = { environment: data.environment, name: `流水线 ${url.pathname.split('/')[2]}`, url: normalizedUrl };
      project.environments.push(binding);
      // 与读取端使用同一校验，既有项目和环境保持原样；保存不请求运行接口。
      parseDeploymentLinks(projects);
      await atomic(path.join(directory, 'yunxiao-deployments.json'), projects);
      return structuredClone(binding);
    })),
    saveConfig: (input: unknown) => task(() => exclusive(async () => {
      const data = z.object({ token: z.string().trim().min(1).max(2000).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict().parse(input);
      if (runs.some(active)) throw new Error('仍有云效部署排队或执行，暂不能更换凭据');
      await atomic(credentialsFile, data); token = data.token; return { hasToken: true };
    })),
    prepare: (input: unknown) => task(() => prepare(input)),
    startRun: (input: unknown) => task(() => exclusive(async () => {
      const data = targetSchema.extend({ requestId: z.uuid(), branches: z.record(z.string().max(2000), z.string().trim().min(1).max(500)), acknowledgeUnknown: z.boolean().optional() }).strict().parse(input);
      const info = await target(data);
      const duplicate = runs.find(run => run.requestId === data.requestId);
      if (duplicate) {
        if (duplicate.bindingId !== info.bindingId) throw new Error('请求编号已用于另一个部署环境');
        return structuredClone(duplicate);
      }
      const previous = runs.filter(run => run.bindingId === info.bindingId).at(-1);
      if (runs.some(run => run.bindingId === info.bindingId && active(run))) throw new Error('该环境已有云效部署排队或运行');
      if (previous?.status === 'unknown' && !data.acknowledgeUnknown) throw new Error(unknownMessage);
      const pipeline = await prepare(data);
      if (Object.keys(data.branches).some(repo => !pipeline.sources.some(source => source.repo === repo))) throw new Error('运行分支包含流水线未定义的代码源');
      const timestamp = new Date().toISOString();
      const run: DeploymentRun = { id: randomUUID(), requestId: data.requestId, bindingId: info.bindingId, projectId: info.project.id, projectName: info.project.name,
        environment: info.binding.environment, jobFullName: pipeline.name, provider: 'yunxiao', organizationId: info.organizationId, pipelineId: info.pipelineId,
        status: 'dispatching', createdAt: timestamp, updatedAt: timestamp };
      runs.push(run);
      try { await persist(); } catch { runs.pop(); throw new Error('部署记录保存失败，未提交云效'); }
      try {
        // https://help.aliyun.com/zh/yunxiao/developer-reference/createpipelinerun
        const id = await api(info.organizationId, info.pipelineId, '/runs', { params: JSON.stringify({ runningBranchs: data.branches }) });
        if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 || typeof id === 'string' && /^[1-9]\d*$/.test(id))) throw new Error('云效未返回本次运行编号');
        run.pipelineRunId = String(id); run.status = 'queued';
        await persist();
      } catch (error) {
        run.status = 'unknown'; run.error = `${unknownMessage}。${redact(error instanceof Error ? error.message : '云效请求未确认')}`; await persist();
      }
      return structuredClone(run);
    })),
    getRun,
    log: (id: string, jobId: string, start: number) => task(async () => {
      const run = await getRun(id);
      return readYunxiaoDeploymentLog({ run, jobId, start, redact,
        request: suffix => api(run.organizationId!, run.pipelineId!, suffix) });
    }),
    isIdle: () => pending === 0 && !runs.some(active),
    close: async () => { closing = true; if (timer) clearInterval(timer); await Promise.allSettled([...tasks]); await mutations; },
  };
}

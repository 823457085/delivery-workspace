/** 部署记录先落盘再提交；外部提交不重试，重启后只恢复已知排队/构建的查询。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProjectsData } from '../shared/hub.js';
import type { DeploymentBinding, DeploymentDashboard, DeploymentLog, DeploymentProject, DeploymentRun, DeploymentStart, JenkinsConnection } from '../shared/deployments.js';
import { boundedText, buildFromUrl, createJenkinsClient, jenkinsBaseUrl, jenkinsJobPath, queueFromLocation, redactJenkins, type JenkinsCredentials } from './jenkins-client.js';

const configSchema = z.object({ baseUrl: z.string().trim().min(1).max(1000), username: z.string().trim().min(1).max(200)
  .refine(value => !/[:\r\n\u0000]/.test(value)), token: z.string().trim().max(1000).optional() }).strict();
const bindingSchema = z.object({ id: z.uuid().optional(), projectId: z.string().min(1).max(2000),
  environment: z.string().trim().min(1).max(100), jobFullName: z.string().trim().min(1).max(1000) }).strict();
const manualBindingSchema = z.object({ projectId: z.string().min(1).max(2000),
  environment: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  url: z.string().trim().min(1).max(2000) }).strict();
const storedBinding = bindingSchema.extend({ id: z.uuid() });
const runSchema = z.object({ id: z.uuid(), requestId: z.uuid(), bindingId: z.uuid(), projectId: z.string(), projectName: z.string(),
  environment: z.string(), jobFullName: z.string(), status: z.enum(['dispatching', 'queued', 'running', 'success', 'failed', 'cancelled', 'unknown']),
  createdAt: z.string(), updatedAt: z.string(), queueId: z.number().int().positive().optional(), buildNumber: z.number().int().positive().optional(),
  buildUrl: z.string().optional(), result: z.string().optional(), error: z.string().optional() }).strict();
const stateSchema = z.object({ bindings: z.array(storedBinding), runs: z.array(runSchema) }).strict();
const startSchema = z.object({ bindingId: z.uuid(), requestId: z.uuid(), parameters: z.record(z.string().max(200), z.union([z.string().max(20_000), z.boolean()])),
  acknowledgeUnknown: z.boolean().optional() }).strict();
const active = (run: DeploymentRun) => ['dispatching', 'queued', 'running'].includes(run.status);
const unknownMessage = '提交结果待确认，请先到 Jenkins 核对；确认没有同次执行后再重新发起';
interface Options {
  readProjects(): Promise<Pick<ProjectsData, 'projects'>>;
  credentialsPath?: string;
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
}
export async function createJenkinsDeployments(directory: string, options: Options) {
  const credentialsPath = options.credentialsPath || path.join(os.homedir(), 'Library', 'Application Support', 'DeliveryWorkspace', 'credentials', 'jenkins-integration.json');
  const stateFile = path.join(directory, 'jenkins-deployments.json');
  let credentials: JenkinsCredentials = { baseUrl: '', username: '', token: '' };
  try {
    const stored = configSchema.extend({ token: z.string().trim().min(1).max(1000) }).parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')));
    credentials = { baseUrl: jenkinsBaseUrl(stored.baseUrl), username: stored.username, token: stored.token };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Jenkins 凭据文件格式不正确，请在本机核对配置'); }
  let state: { bindings: DeploymentBinding[]; runs: DeploymentRun[] } = { bindings: [], runs: [] };
  try { state = stateSchema.parse(JSON.parse(await fs.readFile(stateFile, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('部署记录文件格式不正确，请在本机核对'); }
  await fs.mkdir(directory, { recursive: true });
  async function atomic(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  const persist = () => atomic(stateFile, state);
  if (state.runs.some(run => run.status === 'dispatching')) {
    state.runs = state.runs.map(run => run.status === 'dispatching' ? { ...run, status: 'unknown', updatedAt: new Date().toISOString(), error: unknownMessage } : run);
    await persist();
  }
  let closing = false, pending = 0;
  let mutations = Promise.resolve();
  const tasks = new Set<Promise<unknown>>();
  const refreshing = new Map<string, Promise<DeploymentRun>>();
  const runSecrets = new Map<string, string[]>();
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePoll() {
    if (closing || pollTimer || pollIntervalMs <= 0 || !state.runs.some(run => ['queued', 'running'].includes(run.status))) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (closing) return;
      const polling = Promise.allSettled(state.runs.filter(run => ['queued', 'running'].includes(run.status)).map(run => getRun(run.id)))
        .finally(() => { tasks.delete(polling); schedulePoll(); });
      tasks.add(polling);
    }, pollIntervalMs).unref();
  }
  function task<T>(work: () => Promise<T>) {
    if (closing) return Promise.reject(new Error('部署服务正在退出'));
    pending++;
    const promise = work().finally(() => { pending--; tasks.delete(promise); });
    tasks.add(promise);
    return promise;
  }
  function exclusive<T>(work: () => Promise<T>) {
    const promise = mutations.then(work);
    mutations = promise.then(() => {}, () => {});
    return promise;
  }
  const publicConfig = (): JenkinsConnection => ({ baseUrl: credentials.baseUrl, username: credentials.username, hasToken: !!credentials.token });
  const client = () => createJenkinsClient({ ...credentials }, options.fetcher);
  const findRun = (id: string) => { const run = state.runs.find(item => item.id === id); if (!run) throw new Error('部署记录不存在'); return run; };
  async function projects(): Promise<DeploymentProject[]> {
    const data = await options.readProjects();
    const result = new Map<string, DeploymentProject>();
    for (const item of data.projects) {
      let project = result.get(item.projectId);
      if (!project) {
        project = { id: item.projectId, name: item.displayName || item.suggestedDisplayName || item.projectName,
          repository: item.repository, paths: [], branches: [] };
        result.set(item.projectId, project);
      }
      if (item.path && !project.paths.includes(item.path)) project.paths.push(item.path);
      if (item.branch && !project.branches.includes(item.branch)) project.branches.push(item.branch);
    }
    return [...result.values()];
  }
  async function updateRun(id: string, update: Partial<DeploymentRun>) {
    return exclusive(async () => {
      const run = findRun(id);
      const index = state.runs.indexOf(run);
      state.runs[index] = { ...run, ...update, updatedAt: new Date().toISOString() };
      try { await persist(); } catch { state.runs[index] = run; throw new Error('部署状态保存失败，请核对 Jenkins 实际执行情况'); }
      return structuredClone(state.runs[index]!);
    });
  }
  async function refresh(id: string): Promise<DeploymentRun> {
    const run = structuredClone(findRun(id));
    if (!['queued', 'running'].includes(run.status)) return run;
    try {
      const api = client();
      if (!run.buildNumber) {
        if (!run.queueId) throw new Error('部署记录缺少排队编号');
        const queue = await api.json(`/queue/item/${run.queueId}/api/json?tree=id,cancelled,why,executable[number,url]`);
        if (queue.id !== undefined && queue.id !== run.queueId) throw new Error('Jenkins 排队编号不匹配');
        if (queue.cancelled === true) return updateRun(id, { status: 'cancelled', result: 'CANCELLED', error: undefined });
        if (!queue.executable) return updateRun(id, { error: undefined });
        const executable = queue.executable as { number?: unknown; url?: unknown };
        if (typeof executable.url !== 'string') throw new Error('Jenkins 未返回本次构建地址');
        const build = buildFromUrl(executable.url, run.jobFullName, api.baseUrl);
        if (executable.number !== build.number) throw new Error('Jenkins 构建编号不匹配');
        run.buildNumber = build.number;
        run.buildUrl = build.url;
      }
      const result = await api.json(`${jenkinsJobPath(run.jobFullName)}/${run.buildNumber}/api/json?tree=number,queueId,building,result,url`);
      if (result.number !== run.buildNumber || result.queueId !== run.queueId) throw new Error('Jenkins 构建未匹配本次排队编号');
      if (typeof result.url === 'string' && buildFromUrl(result.url, run.jobFullName, api.baseUrl).number !== run.buildNumber) throw new Error('Jenkins 构建地址不匹配');
      if (result.building === true) return updateRun(id, { status: 'running', buildNumber: run.buildNumber, buildUrl: run.buildUrl, error: undefined });
      if (result.building !== false) throw new Error('Jenkins 尚未返回明确的构建完成状态');
      const status = result.result === 'SUCCESS' ? 'success' : result.result === 'ABORTED' ? 'cancelled' : 'failed';
      return updateRun(id, { status, buildNumber: run.buildNumber, buildUrl: run.buildUrl,
        result: typeof result.result === 'string' ? result.result.slice(0, 100) : 'UNKNOWN', error: undefined });
    } catch (error) {
      return updateRun(id, { error: error instanceof Error ? redactJenkins(error.message, credentials) : 'Jenkins 状态查询失败' });
    }
  }
  function getRun(id: string) {
    if (!refreshing.has(id)) {
      const promise = task(() => refresh(id)).finally(() => refreshing.delete(id));
      refreshing.set(id, promise);
    }
    return refreshing.get(id)!;
  }
  schedulePoll();
  async function saveBinding(input: unknown) {
    const data = bindingSchema.parse(input);
    if (!data.id && state.bindings.length >= 500) throw new Error('部署关联数量已达上限');
    if (data.id && !state.bindings.some(item => item.id === data.id)) throw new Error('部署关联不存在');
    if (data.id && state.runs.some(run => run.bindingId === data.id && active(run))) throw new Error('该关联仍有部署排队或运行');
    if (!(await projects()).some(item => item.id === data.projectId)) throw new Error('项目不在当前工作台项目列表内');
    jenkinsJobPath(data.jobFullName);
    if (!(await client().job(data.jobFullName)).buildable) throw new Error('此 Jenkins 任务不可构建');
    const binding: DeploymentBinding = { ...data, id: data.id || randomUUID() };
    const previous = state.bindings;
    state.bindings = [...state.bindings.filter(item => item.id !== binding.id), binding];
    try { await persist(); } catch (error) { state.bindings = previous; throw error; }
    return structuredClone(binding);
  }
  return {
    snapshot: () => task(async (): Promise<DeploymentDashboard> => {
      const projectList = await projects();
      await Promise.all(state.runs.filter(run => ['queued', 'running'].includes(run.status)).map(run => getRun(run.id)));
      return { config: publicConfig(), projects: projectList, bindings: structuredClone(state.bindings), runs: structuredClone(state.runs.slice(-200).reverse()) };
    }),
    saveConfig: (input: unknown) => task(() => exclusive(async () => {
      const data = configSchema.parse(input);
      const baseUrl = jenkinsBaseUrl(data.baseUrl);
      if ((baseUrl !== credentials.baseUrl || data.username !== credentials.username) && state.runs.some(active)) {
        throw new Error('仍有部署排队或运行，暂不能切换 Jenkins 地址或账号');
      }
      if (credentials.baseUrl && baseUrl !== credentials.baseUrl && state.bindings.length) {
        throw new Error('切换 Jenkins 地址前请先解除现有流水线关联，避免任务名称指向其他项目');
      }
      if (credentials.token && (baseUrl !== credentials.baseUrl || data.username !== credentials.username) && !data.token) {
        throw new Error('更换 Jenkins 地址或账号时必须重新输入对应的 API Token');
      }
      const token = data.token || credentials.token;
      if (!token) throw new Error('首次配置需要填写 Jenkins API Token');
      if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error('Jenkins API Token 格式不正确');
      const next = { baseUrl, username: data.username, token };
      await atomic(credentialsPath, next);
      credentials = next;
      return publicConfig();
    })),
    checkConnection: () => task(() => client().check()),
    jobs: () => task(() => client().jobs()),
    saveBinding: (input: unknown) => task(() => exclusive(() => saveBinding(input))),
    saveManualBinding: (input: unknown) => task(() => exclusive(async () => {
      const data = manualBindingSchema.parse(input);
      if (!credentials.baseUrl) throw new Error('请先配置 Jenkins 连接');
      if (/[\u0000-\u0020\u007f\\]/.test(data.url) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(data.url)) throw new Error('Jenkins 流水线地址不正确');
      let url: URL;
      try { url = new URL(data.url); } catch { throw new Error('请输入完整的 Jenkins 流水线地址'); }
      if (url.origin !== credentials.baseUrl || url.username || url.password || url.search || url.hash) throw new Error('流水线地址必须属于当前已配置的 Jenkins，且不含凭据或参数');
      const parts = url.pathname.replace(/\/$/, '').slice(1).split('/');
      if (parts.length < 2 || parts.length % 2 || parts.some((part, index) => index % 2 === 0 && part !== 'job')) throw new Error('请填写 Jenkins 任务地址，不是构建记录或控制台地址');
      let names: string[];
      try { names = parts.filter((_, index) => index % 2 === 1).map(part => decodeURIComponent(part)); }
      catch { throw new Error('Jenkins 流水线地址编码不正确'); }
      if (names.some(name => name.includes('/'))) throw new Error('Jenkins 流水线地址不正确');
      const jobFullName = names.join('/');
      const existing = state.bindings.find(binding => binding.projectId === data.projectId && binding.environment === data.environment && binding.jobFullName === jobFullName);
      if (existing) {
        if (!(await projects()).some(item => item.id === data.projectId)) throw new Error('项目不在当前工作台项目列表内');
        return structuredClone(existing);
      }
      return saveBinding({ projectId: data.projectId, environment: data.environment, jobFullName });
    })),
    deleteBinding: (input: unknown) => task(() => exclusive(async () => {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input);
      if (!state.bindings.some(item => item.id === id)) throw new Error('部署关联不存在');
      if (state.runs.some(run => run.bindingId === id && active(run))) throw new Error('该关联仍有部署排队或运行');
      const previous = state.bindings;
      state.bindings = state.bindings.filter(item => item.id !== id);
      try { await persist(); } catch (error) { state.bindings = previous; throw error; }
      return { deleted: true };
    })),
    startRun: (input: unknown) => task(() => exclusive(async (): Promise<DeploymentRun> => {
      const data: DeploymentStart = startSchema.parse(input);
      const existing = state.runs.find(run => run.requestId === data.requestId);
      if (existing) {
        if (existing.bindingId !== data.bindingId) throw new Error('请求编号已用于另一个部署关联');
        return structuredClone(existing);
      }
      const binding = state.bindings.find(item => item.id === data.bindingId);
      if (!binding) throw new Error('部署关联不存在');
      const latest = state.runs.filter(run => run.bindingId === binding.id).at(-1);
      if (state.runs.some(run => run.bindingId === binding.id && active(run))) throw new Error('该项目环境已有部署排队或运行，请查看当前记录');
      if (latest?.status === 'unknown' && !data.acknowledgeUnknown) throw new Error(unknownMessage);
      const project = (await projects()).find(item => item.id === binding.projectId);
      if (!project) throw new Error('项目不在当前工作台项目列表内');
      const api = client();
      const job = await api.job(binding.jobFullName);
      if (!job.buildable) throw new Error('此 Jenkins 任务不可构建');
      if (job.parameters.some(item => item.type === 'unsupported')) throw new Error('此任务包含暂不支持的参数类型，请在 Jenkins 操作');
      const params = new URLSearchParams();
      const secrets: string[] = [];
      for (const [name, value] of Object.entries(data.parameters)) {
        const definition = job.parameters.find(item => item.name === name);
        if (!definition) throw new Error('包含 Jenkins 未定义的构建参数');
        if (definition.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error('构建参数类型不正确');
        if (definition.type === 'choice' && !definition.choices?.includes(String(value))) throw new Error('构建参数不在可选范围内');
        if (definition.type === 'password' && typeof value === 'string' && value) secrets.push(value);
        params.set(name, String(value));
      }
      const timestamp = new Date().toISOString();
      const run: DeploymentRun = { id: randomUUID(), requestId: data.requestId, bindingId: binding.id, projectId: project.id,
        projectName: project.name, environment: binding.environment, jobFullName: binding.jobFullName,
        status: 'dispatching', createdAt: timestamp, updatedAt: timestamp };
      state.runs.push(run);
      try { await persist(); } catch { state.runs.pop(); throw new Error('部署记录保存失败，未提交 Jenkins'); }
      runSecrets.set(run.id, secrets);
      try {
        const response = await api.request(`${jenkinsJobPath(binding.jobFullName)}/${job.parameters.length ? 'buildWithParameters' : 'build'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
        });
        if (response.status !== 201) throw new Error('Jenkins 未返回排队确认');
        run.queueId = queueFromLocation(response.headers.get('location') || '', api.baseUrl);
        run.status = 'queued';
        run.updatedAt = new Date().toISOString();
        await persist();
        schedulePoll();
      } catch (error) {
        run.status = 'unknown';
        run.updatedAt = new Date().toISOString();
        run.error = `${unknownMessage}。${error instanceof Error ? redactJenkins(error.message, credentials) : ''}`;
        await persist();
      }
      return structuredClone(run);
    })),
    getRun,
    log: (id: string, start: number) => task(async (): Promise<DeploymentLog> => {
      if (!Number.isSafeInteger(start) || start < 0) throw new Error('日志偏移必须为非负整数');
      const run = await getRun(id);
      if (!run.buildNumber) return { text: '', nextOffset: start, moreData: active(run) };
      if (!run.buildUrl || new URL(run.buildUrl).origin !== credentials.baseUrl) throw new Error('此构建属于先前的 Jenkins 地址，请恢复对应配置后查看日志');
      const api = client();
      const response = await api.request(`${jenkinsJobPath(run.jobFullName)}/${run.buildNumber}/logText/progressiveText?start=${start}`);
      const raw = await boundedText(response);
      const rawOffset = response.headers.get('x-text-size');
      const nextOffset = Number(rawOffset);
      if (!rawOffset || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(nextOffset) || nextOffset < start
        || (Buffer.byteLength(raw) > 0 && nextOffset === start)) throw new Error('Jenkins 日志偏移无效，偏移未推进');
      let text = redactJenkins(raw, credentials);
      for (const secret of runSecrets.get(id) || []) text = text.split(secret).join('[参数已隐藏]');
      return { text, nextOffset, moreData: response.headers.get('x-more-data') === 'true' };
    }),
    isIdle: () => pending === 0 && !state.runs.some(active),
    close: async () => { closing = true; if (pollTimer) clearTimeout(pollTimer); await Promise.allSettled([...tasks]); await mutations; },
  };
}

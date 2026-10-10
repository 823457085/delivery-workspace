import fs from 'node:fs/promises';
import path from 'node:path';
import { jiraFixInputSchema, jiraFixStartSchema, jiraReferenceSchema, jiraIssueKey, jiraFixPrompt, matchJiraFixProjects, repositoryIdentity,
  type JiraFixRecord, type JiraFixProject, type JiraFixContext, type JiraFixInput } from '../shared/jira-fix.js';
import type { AgentRun, StartAgentRunInput } from '../shared/agent-runtime.js';
import type { JiraIssue, ProjectsData } from '../shared/hub.js';
import { prepareRequirementWorkspace } from './requirement-development.js';
import { resolveRenamedWorkspace } from './generated-workspace.js';

interface Runtime {
  startJiraFix(input: StartAgentRunInput, sourceId: string, title: string): Promise<AgentRun>;
  findJiraFix(sourceId: string): AgentRun | undefined;
}
interface Source {
  readJiraFixIssue(reference: string): Promise<JiraIssue>;
  readLocalProjects(): Promise<ProjectsData>;
}
export async function createJiraFixService(directory: string, runtime: Runtime, source: Source,
  prepare: (input: JiraFixInput, id: string, signal?: AbortSignal) => ReturnType<typeof prepareRequirementWorkspace> = prepareRequirementWorkspace) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const records = new Map<string, JiraFixRecord>();
  let bindings: JiraFixProject[] = [];
  for (const name of await fs.readdir(directory)) {
    if (name === 'projects.json') bindings = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    else if (/^[0-9a-f-]{36}\.json$/.test(name)) {
      const record = await resolveRenamedWorkspace(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as JiraFixRecord);
      records.set(record.id, record);
    }
  }
  const pending = new Map<string, Promise<void>>();
  const shutdown = new AbortController();
  let bindingWrite = Promise.resolve();
  async function save(name: string, value: unknown) {
    const file = path.join(directory, `${name}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  function reconcile(record: JiraFixRecord): JiraFixRecord {
    const run = runtime.findJiraFix(record.id);
    if (run) return { ...record, status: 'started', runId: run.id, runStatus: run.status, runError: run.error, error: '' };
    if (['preparing', 'starting'].includes(record.status) && !pending.has(record.id)) {
      return { ...record, status: 'uncertain', error: '服务曾中断，请核对已创建目录和会话；不会自动重复拉取或执行。' };
    }
    return { ...record };
  }
  async function resolve(reference: string): Promise<JiraFixContext> {
    const issue = await source.readJiraFixIssue(jiraReferenceSchema.parse(reference));
    let projects: ProjectsData['projects'] = [], projectWarning = '';
    try { projects = (await source.readLocalProjects()).projects; }
    catch (error) { projectWarning = `本地项目读取失败，可手动配置：${error instanceof Error ? error.message : String(error)}`; }
    const available = new Map<string, JiraFixProject>();
    for (const item of projects) if (jiraFixInputSchema.shape.repository.safeParse(item.remoteUrl).success) available.set(repositoryIdentity(item.remoteUrl), {
      projectKey: issue.project, name: item.displayName || item.projectName, repository: item.remoteUrl,
      parentDirectory: item.rootPath, baseBranch: 'master',
    });
    for (const item of bindings.filter(item => item.projectKey === issue.project)) available.set(repositoryIdentity(item.repository), item);
    return { issue, candidates: matchJiraFixProjects(issue, bindings, projects), projects: [...available.values()], ...(projectWarning ? { projectWarning } : {}) };
  }
  async function remember(record: JiraFixRecord) {
    const update = async () => {
      const item: JiraFixProject = { projectKey: record.issue!.project, name: record.issue!.projectName || record.issue!.project,
        repository: record.input.repository, parentDirectory: record.input.parentDirectory, baseBranch: record.input.baseBranch };
      const next = bindings.filter(value => !(value.projectKey === item.projectKey && repositoryIdentity(value.repository) === repositoryIdentity(item.repository)));
      next.push(item); await save('projects', next); bindings = next;
    };
    const write = bindingWrite.then(update); bindingWrite = write.catch(() => {}); await write;
  }
  async function execute(record: JiraFixRecord) {
    try {
      await save(record.id, record);
      record.issue = await source.readJiraFixIssue(record.input.issueKey);
      shutdown.signal.throwIfAborted();
      Object.assign(record, await prepare(record.input, record.id, shutdown.signal));
      shutdown.signal.throwIfAborted();
      if (record.input.rememberProject) await remember(record);
      shutdown.signal.throwIfAborted();
      record.status = 'starting'; await save(record.id, record);
      const run = await runtime.startJiraFix({ provider: 'codex', mode: 'agent', accessMode: 'workspace',
        model: 'gpt-6-astra', reasoningEffort: 'xhigh', workspacePath: record.workspacePath, branch: record.input.branch,
        objective: jiraFixPrompt(record) }, record.id, `修复 ${record.issue.key} ${record.issue.summary}`);
      record.runId = run.id; record.status = 'started';
    } catch (error) {
      const run = runtime.findJiraFix(record.id);
      if (run) { record.runId = run.id; record.status = 'started'; }
      else { record.status = 'failed'; record.error = error instanceof Error ? error.message : '修复会话启动失败'; }
    }
    await save(record.id, record);
  }
  function start(raw: unknown) {
    if (shutdown.signal.aborted) throw new Error('服务正在退出，请稍后重试');
    const { requestId, input } = jiraFixStartSchema.parse(raw);
    const existing = records.get(requestId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('请求内容已改变，请核对原启动记录');
      return reconcile(existing);
    }
    const sameIssue = [...records.values()].filter(item => jiraIssueKey(item.input.issueKey) === jiraIssueKey(input.issueKey)
      && repositoryIdentity(item.input.repository) === repositoryIdentity(input.repository));
    const duplicate = sameIssue.find(item => JSON.stringify(item.input) === JSON.stringify(input) && reconcile(item).status !== 'failed');
    if (duplicate) return reconcile(duplicate);
    if (sameIssue.some(item => pending.has(item.id) || reconcile(item).status === 'uncertain' || ['running', 'queued'].includes(runtime.findJiraFix(item.id)?.status || ''))) {
      throw new Error('该 Jira 在此仓库已有运行中或待核对的修复，请打开原会话继续');
    }
    const record: JiraFixRecord = { id: requestId, input, status: 'preparing', workspacePath: '', headSha: '', runId: '', error: '', createdAt: new Date().toISOString() };
    records.set(record.id, record);
    const work = execute(record).catch(error => { record.status = 'uncertain'; record.error = `启动记录保存失败，请核对目录和会话：${error instanceof Error ? error.message : String(error)}`; })
      .finally(() => pending.delete(record.id));
    pending.set(record.id, work);
    return { ...record };
  }
  return { resolve, start, list: () => [...records.values()].map(reconcile).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    close: async () => { shutdown.abort(); await Promise.allSettled([...pending.values()]); } };
}

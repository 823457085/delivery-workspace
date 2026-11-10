/** 交付按钮只操作已登记任务；预览绑定结果、文件与目标，外部结果逐项落盘并回读。 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GroupJiraSource, GroupRoomDetail } from '../shared/agent-group-chat.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { RemoteDeliveryAttempt, RemoteDeliveryPreview, RemoteDeliverySubmit, RemoteDeliveryJiraTask, RemoteDeliveryI18nArtifact } from '../shared/agent-remote-delivery.js';
import type { JiraDevTaskRecord, JiraDevDesignDestination, JiraDevPlanItem } from './jira-dev/index.mjs';
import type { RemoteDesignLookup, RemoteDesignMatch } from './agent-remote-delivery-confluence.js';
import type { SourceBackend } from './source-backend.js';
import { executeProjectGitAction, readProjectGitSnapshot, type ProjectGitSnapshot } from './project-git.js';
import { readAgentDeliveryReport } from '../shared/delivery-report.js';
import { requirementProgressDataSchema, requirementStageLabels, requirementStageStatusLabels, requirementStages } from '../shared/requirement-development.js';
import { deliveryEvidenceSchema, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatusLabels } from '../shared/delivery-acceptance.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const maxArtifactBytes = 40 * 1024 * 1024;
const submitSchema = z.object({ requestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['design', 'jira', 'git']), projectId: z.string().max(100).optional(),
  files: z.array(z.string().min(1).max(2000)).max(200).optional(), message: z.string().trim().max(4000).optional() }).strict();
interface Publication {
  url: string; pageId: string; title: string; parentId: string; spaceKey: string; version: number; verifiedAt: string; bodySha256: string;
}
interface StoredAttempt extends RemoteDeliveryAttempt { input: RemoteDeliverySubmit; publication?: Publication }
interface Options {
  directory: string;
  find(roomId: string): GroupRoomDetail;
  findGroup?(taskId: string): { groupRoomId: string } | undefined;
  taskRuns?(taskId: string, workflow: 'jira' | 'requirement'): AgentRun[];
  task(taskId: string): Promise<JiraDevTaskRecord>;
  lookupJiraTasks?(task: JiraDevTaskRecord): Promise<{ items: JiraDevPlanItem[] } | undefined>;
  lookupDesign?(input: RemoteDesignLookup): Promise<RemoteDesignMatch | undefined>;
  source: SourceBackend;
  publishComment(taskId: string, body: string): Promise<{ url: string; verified: boolean }>;
  saveDesign?(taskId: string, input: { body: string; publication: Publication }): Promise<unknown>;
  publishDesign(input: RemoteDesignLookup & { destination: JiraDevDesignDestination; body: string; taskId: string; expectedVersion?: number; expectedBodySha256?: string }): Promise<Publication>;
  snapshot?: typeof readProjectGitSnapshot;
  git?: typeof executeProjectGitAction;
}
export async function createAgentRemoteDelivery(options: Options) {
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const pending = new Map<string, Promise<RemoteDeliveryAttempt>>();
  const states = new Map<string, StoredAttempt[]>();
  const jiraLookups = new Map<string, { until: number; result: Promise<{ items: JiraDevPlanItem[] } | undefined> }>();
  for (const name of await fs.readdir(options.directory)) if (/^[0-9a-f-]{36}\.json$/.test(name)) {
    const list = JSON.parse(await fs.readFile(path.join(options.directory, name), 'utf8')) as StoredAttempt[];
    for (const item of list) if (item.status === 'submitting') {
      item.status = 'uncertain'; item.detail = '服务曾中断，远端结果待核对；系统不会重复发布或提交。';
    }
    states.set(name.slice(0, -5), list);
  }
  const publicAttempt = ({ input: _input, publication: _publication, ...attempt }: StoredAttempt): RemoteDeliveryAttempt => attempt;
  function resolveStorageId(roomId: string) {
    try {
      const detail = options.find(roomId);
      return detail.room.id === roomId ? detail.room.id : roomId;
    } catch {
      return options.findGroup?.(roomId)?.groupRoomId || roomId;
    }
  }
  async function save(roomId: string) {
    const file = path.join(options.directory, `${roomId}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(states.get(roomId) || []), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  async function context(roomId: string) {
    let detail: GroupRoomDetail | undefined;
    try {
      detail = options.find(roomId);
      if (detail.room.id !== roomId) throw fail('群聊与当前交付记录不一致。');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('找不到这个团队群聊')) throw error;
      const group = options.findGroup?.(roomId);
      if (group?.groupRoomId) {
        detail = options.find(group.groupRoomId);
        if (detail.room.id !== group.groupRoomId || detail.room.source?.taskId !== roomId) {
          throw fail('群聊与当前交付记录不一致。');
        }
      }
    }
    if (!detail) {
      const task = await options.task(roomId);
      if (task.taskId !== roomId) throw fail('群聊与当前交付记录不一致。');
      const rawProjects = task.projects?.length ? task.projects : (task.projectPath && task.baseSha ? [{
        path: task.sourceProjectPath, workspacePath: task.projectPath,
        branchName: task.branchName, baseBranch: task.baseBranch, baseSha: task.baseSha,
      }] : []);
      if (!rawProjects.length || rawProjects.some(project => !project.workspacePath || !project.baseSha)) {
        throw fail('当前任务尚未创建独立工作区，暂不能执行远端交付。');
      }
      const projects = rawProjects.map(project => ({
        path: project.path, workspacePath: project.workspacePath!,
        branchName: project.branchName, baseBranch: project.baseBranch, baseSha: project.baseSha!,
      }));
      const plan = task.workflow === 'requirement' ? task.requirementPlan : task.repairPlan;
      const boundIssue = plan?.developmentIssue || task.issueSnapshot || task.sourceIssue;
      if (!boundIssue?.key || !boundIssue.url) throw fail('当前任务未绑定 Jira 事项来源，暂不能执行远端交付。');
      const runs = options.taskRuns?.(task.taskId, task.workflow) || [];
      const source: GroupJiraSource = {
        taskId: task.taskId,
        workflow: task.workflow,
        title: boundIssue.summary,
        issueKey: boundIssue.key,
        issueUrl: boundIssue.url,
        projects,
      };
      const synthesized: GroupRoomDetail = {
        room: {
          id: task.taskId,
          title: boundIssue.summary,
          workspacePath: projects[0]!.workspacePath,
          executionPath: projects[0]!.workspacePath,
          paused: false,
          cursorTrustPaths: [],
          createdAt: runs[0]?.createdAt || new Date(0).toISOString(),
          updatedAt: runs.at(-1)?.updatedAt || new Date(0).toISOString(),
          source,
          rounds: [],
        },
        runs,
      };
      const active = runs.some(run => ['queued', 'running'].includes(run.status));
      return { requestedId: roomId, storageId: task.taskId, detail: synthesized, source, task, plan, issue: { key: boundIssue.key, url: boundIssue.url, title: boundIssue.summary }, active };
    }
    const source = detail.room.source;
    if (!source) throw fail('当前群聊未绑定 Jira 研发任务，暂不能执行远端交付。');
    const task = await options.task(source.taskId);
    if (task.taskId !== source.taskId || task.workflow !== source.workflow) throw fail('群聊与研发任务关联不一致。');
    const projects = task.projects?.length ? task.projects : [{ path: task.sourceProjectPath, workspacePath: task.projectPath,
      branchName: task.branchName, baseBranch: task.baseBranch, baseSha: task.baseSha }];
    if (projects.length !== source.projects.length || source.projects.some(item => !projects.some(project => project.path === item.path
      && project.workspacePath === item.workspacePath && project.branchName === item.branchName && project.baseSha === item.baseSha))) {
      throw fail('任务工作区或分支关联已变化，请先核对原任务。');
    }
    const plan = task.workflow === 'requirement' ? task.requirementPlan : task.repairPlan;
    const boundIssue = plan?.developmentIssue || task.issueSnapshot || task.sourceIssue;
    if (!boundIssue || boundIssue.key !== source.issueKey || boundIssue.url !== source.issueUrl) throw fail('群聊与 Jira 事项来源不一致，请先核对原任务。');
    const active = detail.room.rounds.some(round => ['queued', 'running'].includes(round.state))
      || detail.runs.some(run => ['queued', 'running'].includes(run.status));
    return { requestedId: roomId, storageId: detail.room.id, detail, source, task, plan, issue: { key: boundIssue.key, url: boundIssue.url, title: boundIssue.summary }, active };
  }
  async function jiraTasksOf(found: Awaited<ReturnType<typeof context>>, fresh = false) {
    let lookup: { items: JiraDevPlanItem[] } | undefined;
    let reason = '';
    if (options.lookupJiraTasks && found.plan?.sourceKind === 'frontend' && !found.plan.reuseRuleVersion) {
      const id = found.task.taskId;
      let cached = jiraLookups.get(id);
      if (fresh || !cached || cached.until < Date.now()) {
        cached = { until: Date.now() + 30_000, result: options.lookupJiraTasks(found.task) };
        jiraLookups.set(id, cached);
      }
      try { lookup = await cached.result; }
      catch { reason = '关联 Jira 任务暂未核对完整，请刷新后重试。'; }
    }
    const items = lookup?.items || found.plan?.items || [];
    const metadata = (item: typeof items[number] | undefined) => ({
      ...(item?.role ? { role: item.role } : {}), ...(item?.action ? { action: item.action } : {}), ...(item?.state ? { state: item.state } : {}),
    });
    const tasks = new Map<string, RemoteDeliveryJiraTask>([[found.issue.key, { key: found.issue.key, url: found.issue.url,
      summary: found.issue.title, ...metadata(items.find(item => item.key === found.issue.key)) }]]);
    const sourceIssue = found.plan?.sourceIssue || found.task.sourceIssue;
    if (sourceIssue?.key && sourceIssue.url && !tasks.has(sourceIssue.key)) {
      tasks.set(sourceIssue.key, { key: sourceIssue.key, url: sourceIssue.url, summary: sourceIssue.summary });
    }
    for (const item of items) {
      if (!item.key?.trim() || !item.url?.trim() || tasks.has(item.key)) continue;
      tasks.set(item.key, { key: item.key, url: item.url, summary: item.summary, ...metadata(item) });
    }
    const jiraTasks = [...tasks.values()];
    const keys = [...new Set([found.issue.key, sourceIssue?.key || '',
      ...jiraTasks.filter(item => item.role === 'parent' || item.role === 'design').map(item => item.key)])]
      .filter(key => /^[A-Z][A-Z0-9_]*-\d+$/.test(key));
    return { jiraTasks, keys, reason };
  }
  async function readArtifact(found: Awaited<ReturnType<typeof context>>, index: number, kind: 'i18n' | 'review' | 'preview', keys = [found.issue.key]) {
    const project = found.source.projects[index];
    if (!project) throw fail('该文件不属于当前任务。', 404);
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(found.issue.key) || kind !== 'i18n' && found.task.workflow !== 'requirement') {
      throw fail('该文件不属于当前任务。', 404);
    }
    const root = await fs.realpath(project.workspacePath);
    const dir = kind === 'review' ? path.join(root, 'docs', 'requirements') : path.join(root, 'tempdocs');
    const names = kind === 'i18n' ? [...keys.flatMap(key => [`${key}-多语言.xlsx`, `${key}-i18n-import.xlsx`, `${key}-i18n.xlsx`]), 'i18n-import.xlsx']
      : keys.map(key => `${key}${kind === 'review' ? '-dev-prd-review.md' : '-delivery-preview.json'}`);
    let filename = '';
    for (const name of names) {
      const candidate = path.join(dir, name);
      const existing = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existing) { filename = candidate; break; }
    }
    if (!filename) throw fail('本地交付文件已不存在。', 404);
    const resolved = await fs.realpath(filename).catch(() => { throw fail('本地交付文件已不存在。', 404); });
    if (!resolved.startsWith(`${root}${path.sep}`)) throw fail('交付文件路径超出任务工作区。', 403);
    // 只读取固定任务产物；不接受客户端文件路径，也不沿末段符号链接打开文件。
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw fail('无法读取本任务的交付文件。', 404); });
    try {
      const stat = await handle.stat(), current = await fs.realpath(filename);
      const linked = await fs.stat(filename);
      if (current !== resolved || !current.startsWith(`${root}${path.sep}`) || stat.dev !== linked.dev || stat.ino !== linked.ino) {
        throw fail('交付文件位置已变化，请刷新产物。');
      }
      if (!stat.isFile()) throw fail('交付产物不是普通文件。', 404);
      const sizeLimit = kind === 'i18n' ? maxArtifactBytes : kind === 'review' ? 500_000 : 12_000;
      if (stat.size > sizeLimit) throw fail(kind === 'i18n' ? '多语言文件超过 40MB，无法下载。' : '交付文件超过大小上限。', 413);
      // 多读一个字节检测读取期间增长，避免 readFile 在并发改写时突破大小限制。
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw fail('交付文件已变化，请刷新产物。');
      const data = buffer.subarray(0, size), sha256 = createHash('sha256').update(data).digest('hex');
      const id = `${kind}-${index}`, name = path.basename(filename);
      const artifact: RemoteDeliveryI18nArtifact = { id, projectId: String(index), path: filename, name, size, sha256,
        downloadUrl: `/api/agent-runtimes/group-chat/rooms/${encodeURIComponent(found.requestedId)}/artifacts/${id}?sha256=${sha256}` };
      return { artifact, data };
    } finally { await handle.close(); }
  }
  const previewLinksSchema = z.array(z.object({
    url: z.url().max(500).refine(value => {
      const url = new URL(value);
      return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && !!url.port && !url.username && !url.password;
    }),
    label: z.string().trim().min(1).max(100),
    mode: z.enum(['i18n-test', 'mock']),
    evidence: z.string().trim().min(1).max(500),
  }).strict()).max(6);
  async function optionalArtifact(found: Awaited<ReturnType<typeof context>>, index: number, kind: 'i18n' | 'review' | 'preview', keys: string[]) {
    try { return await readArtifact(found, index, kind, keys); }
    catch (error) {
      if ([403, 404, 409, 413].includes((error as { statusCode?: number }).statusCode || 0)) return undefined;
      throw error;
    }
  }
  async function designOf(found: Awaited<ReturnType<typeof context>>, keys: string[], jiraReason: string) {
    const { task, source, plan, issue } = found;
    const roots = await Promise.all(source.projects.map(project => fs.realpath(project.workspacePath)));
    const privateRoot = await fs.realpath(path.resolve(options.directory, '..', 'jira-dev', 'technical-designs', task.taskId)).catch(() => '');
    const proposed = roots.flatMap(root => keys.flatMap(key => [
      path.join(root, 'docs', 'requirements', `${key}-tech-design.md`),
      path.join(root, 'docs', 'tech-design', `${key}-frontend-tech-design.md`),
      path.join(root, 'docs', 'tech-design', `${key}-tech-design.md`),
    ]));
    if (task.technicalDesign?.status === 'ready' && typeof task.technicalDesign.path === 'string') proposed.push(task.technicalDesign.path);
    let filename = '', body = '', newest = -Infinity;
    for (const candidate of new Set(proposed)) {
      const real = await fs.realpath(candidate).catch(() => '');
      if (!real || !roots.some(root => real.startsWith(`${root}${path.sep}`)) && !(privateRoot && real.startsWith(`${privateRoot}${path.sep}`))) continue;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > 500_000 || stat.mtimeMs <= newest) continue;
      const markdown = await fs.readFile(real, 'utf8');
      if (!markdown.trim()) continue;
      body = markdown; filename = real; newest = stat.mtimeMs;
    }
    const destination = plan?.designDestination || undefined;
    const latest = [...(states.get(found.storageId) || [])].reverse().find(item => item.kind === 'design' && item.status === 'completed');
    const publication = task.technicalDesign?.publication as { status?: string; url?: string; pageId?: string; version?: number; bodySha256?: string } | undefined;
    const title = `${issue.key} ${issue.title} · 前端技术方案`;
    const saved = latest?.publication || publication;
    let match: RemoteDesignMatch | undefined;
    let lookupReason = '';
    if (destination && options.lookupDesign) {
      try { match = await options.lookupDesign({ destination, title, issueKeys: keys, existingPageId: saved?.pageId }); }
      catch (error) { lookupReason = error instanceof Error ? error.message : '暂未核对 Confluence 原页面，请刷新后重试。'; }
    }
    const page = match || saved;
    const unchanged = !!body && !!match?.bodySha256 && createHash('sha256').update(body).digest('hex') === match.bodySha256;
    const reason = lookupReason || match?.reason || (!page?.pageId ? jiraReason : '') || (found.active ? '团队仍在执行，请待本轮结束后预览。'
      : unchanged ? '本地方案与原页面一致。' : !body ? '未找到本任务已生成的技术方案文件。' : !destination ? '该任务尚未配置技术方案归档目录。' : '');
    return { path: filename, body, title: match?.title || title, destination, available: !reason, reason,
      url: page?.url || latest?.url, version: page?.version, issueKeys: keys,
      existingPageId: page?.pageId, expectedVersion: page?.version, expectedBodySha256: page?.bodySha256 };
  }
  function runSummary(detail: GroupRoomDetail) {
    const current = detail.room.rounds.at(-1);
    const candidates = current?.turns?.length
      ? [...current.turns].reverse().map(turn => ({ label: `${turn.member.name}本轮报告`, run: detail.runs.find(item => item.id === turn.runId) }))
      : [...detail.runs].reverse().map(run => ({ label: '本轮会话报告', run }));
    for (const { label, run } of candidates) {
      if (!run) continue;
      try {
        const report = readAgentDeliveryReport(run.result) as { requirementProgress?: unknown; validationEvidence?: unknown };
        const progress = requirementProgressDataSchema.safeParse(report.requirementProgress);
        const validation = deliveryEvidenceSchema.safeParse(report.validationEvidence);
        if (!progress.success && !validation.success) continue;
        return [`结果来源：${label}（待人工核对）`,
          ...(progress.success ? requirementStages.map(stage => `${requirementStageLabels[stage]}：${requirementStageStatusLabels[progress.data.stages[stage].status]}${progress.data.stages[stage].evidence ? `；${progress.data.stages[stage].evidence.slice(0, 1200)}` : ''}`) : ['任务进度：尚未确认']),
          ...(validation.success ? deliveryEvidenceKinds.map(kind => `${deliveryEvidenceLabels[kind]}：${deliveryEvidenceStatusLabels[validation.data[kind].status]}${validation.data[kind].evidence ? `；${validation.data[kind].evidence.slice(0, 2000)}` : ''}`) : ['验证情况：尚未确认'])].join('\n\n');
      } catch { /* 无结构化验证时保持未确认，不按completed猜测验收通过。 */ }
    }
    return '验证结论尚未确认，请核对本地执行结果；成员执行结束不代表业务验收通过。';
  }
  async function build(roomId: string, fresh = false) {
    const found = await context(roomId), { source, issue, active, detail, storageId } = found;
    const { jiraTasks, keys, reason: jiraReason } = await jiraTasksOf(found, fresh);
    const [design, i18nFiles, reviewFile, previewFile] = await Promise.all([
      designOf(found, keys, jiraReason),
      Promise.all(source.projects.map((_project, index) => optionalArtifact(found, index, 'i18n', keys))),
      optionalArtifact(found, 0, 'review', keys), optionalArtifact(found, 0, 'preview', keys),
    ]);
    const i18nArtifacts = i18nFiles.flatMap(file => file ? [file.artifact] : []);
    let previewLinks: z.infer<typeof previewLinksSchema> | undefined;
    if (previewFile) try {
      previewLinks = previewLinksSchema.safeParse(JSON.parse(previewFile.data.toString('utf8'))).data;
    } catch { /* 不展示无法核对格式的地址。 */ }
    const localArtifacts = { ...(reviewFile ? { reviewArtifact: reviewFile.artifact } : {}),
      ...(previewLinks?.length ? { previewLinks } : {}) };
    const snapshots = new Map<string, ProjectGitSnapshot>();
    const projects = await Promise.all(source.projects.map(async (project, index) => {
      const id = String(index), snapshot = await (options.snapshot || readProjectGitSnapshot)(project.workspacePath, { forDelivery: true });
      if (snapshot.directory !== await fs.realpath(project.workspacePath)) throw fail('实际 Git 根目录与任务工作区不一致。');
      snapshots.set(id, snapshot);
      const remote = snapshot.remotes.find(item => item.name === 'origin') || (snapshot.remotes.length === 1 ? snapshot.remotes[0] : undefined);
      const writeRuns = detail.room.rounds.length
        ? new Set(detail.room.rounds.flatMap(round => round.turns.filter(turn => turn.member.capability === 'write').flatMap(turn => [
          turn.runId, ...(turn.fallbacks || []).map(fallback => fallback.runId),
          ...detail.runs.filter(run => run.team?.taskId === (round.automatic?.taskId || detail.room.id)
            && run.team.nodeId === turn.id).map(run => run.id),
        ])))
        : new Set(detail.runs.filter(run => run.mode === 'agent' || run.changedFiles?.length).map(run => run.id));
      const paths = new Set(detail.runs.filter(run => writeRuns.has(run.id) && run.workspacePath === project.workspacePath)
        .flatMap(run => (run.changedFiles || []).map(file => path.isAbsolute(file.path) ? path.relative(project.workspacePath, file.path) : file.path)));
      const reason = active ? '团队仍在执行，请待本轮结束后预览。' : !snapshot.isGit || snapshot.branch !== project.branchName
        ? '当前 Git 分支与任务分支不一致。' : snapshot.truncated || snapshot.mergeInProgress || snapshot.counts.conflicts
          ? '改动列表不完整、存在冲突或正在合并，请先处理仓库。' : !remote || remote.pushUrls.length !== 1 ? '请先配置唯一的 Git 推送目标。' : '';
      let remoteWeb = '';
      try { const parsed = new URL(remote?.pushUrl || ''); if (parsed.hostname && ['http:', 'https:', 'ssh:'].includes(parsed.protocol)) remoteWeb = `${parsed.protocol === 'http:' ? 'http' : 'https'}://${parsed.host}${parsed.pathname.replace(/\.git$/, '')}`; }
      catch { const parsed = /^([^@]+@)?([^:]+):(.+)$/.exec(remote?.pushUrl || ''); if (parsed) remoteWeb = `https://${parsed[2]}/${parsed[3].replace(/\.git$/, '')}`; }
      const remoteHost = remoteWeb ? new URL(remoteWeb).hostname : '';
      const url = remoteWeb ? remoteHost === 'github.com' ? `${remoteWeb}/tree/${encodeURIComponent(project.branchName)}`
        : /gitlab/i.test(remoteHost) ? `${remoteWeb}/-/tree/${encodeURIComponent(project.branchName)}` : remoteWeb : '';
      return { id, path: project.workspacePath, branch: snapshot.branch, head: snapshot.head, remote: remote?.name || '', url, pushUrl: remote?.pushUrl || '',
        files: snapshot.files.map(file => ({ path: file.path, status: file.status, recommended: paths.has(file.path) })),
        message: `${issue.key}：更新${issue.title}前端实现`, available: !reason, reason };
    }));
    const fileContents = await Promise.all([...snapshots].map(async ([id, snapshot]) => [id, await Promise.all(snapshot.files.map(async file => {
      const filename = path.join(snapshot.directory, file.path), stat = await fs.lstat(filename).catch(() => undefined);
      if (!stat) return [file.path, 'missing'];
      if (stat.isSymbolicLink()) return [file.path, 'symlink', await fs.readlink(filename)];
      if (!stat.isFile()) return [file.path, 'non-file'];
      return [file.path, createHash('sha256').update(await fs.readFile(filename)).digest('hex')];
    }))]));
    const linked = jiraTasks.filter(item => item.key !== issue.key).map(item => `${item.key} ${item.url}`);
    const attempts = states.get(storageId) || [];
    const gitLinks = source.projects.map((_project, index) => [...attempts].reverse().find(item => item.kind === 'git' && item.projectId === String(index) && item.status === 'completed'))
      .filter((item): item is StoredAttempt => !!item).map(item => `${item.url || 'Git'}${item.revision ? ` (${item.revision})` : ''}`);
    const body = [`工作台本地开发进度与交付关联`, `关联事项：${issue.key} ${issue.url}`, ...linked,
      `技术方案：${design.url || (design.path ? '本地已生成，待发布' : '尚未生成')}`,
      `Git：${gitLinks.length ? gitLinks.join('\n') : '尚未核对远端提交'}`,
      '本条仅记录当前开发进度，不变更 Jira 状态、指派或验收结论。', runSummary(detail)].join('\n\n');
    const { existingPageId: _pageId, expectedVersion: _version, expectedBodySha256: _bodySha, issueKeys: _issueKeys, ...publicDesign } = design;
    const fingerprint = hash({ roomId: storageId, source, issue, results: detail.room.rounds.map(round => [round.id, round.state,
      round.turns.map(turn => [turn.id, turn.runId, turn.status])]), runs: detail.runs.map(run => [run.id, run.status, run.result]),
      design: { ...design, body: hash(design.body) }, jiraTasks, i18nArtifacts,
      git: [...snapshots].map(([id, snapshot]) => [id, snapshot.revision]), fileContents, body });
    const preview: RemoteDeliveryPreview = { roomId: found.requestedId, taskId: source.taskId, fingerprint, issue, design: publicDesign,
      jira: { body, available: !active && !!issue.url, reason: jiraReason || (active ? '团队仍在执行，请待本轮结束后预览。' : '') }, projects,
      attempts: attempts.map(publicAttempt), jiraTasks, i18nArtifacts, ...localArtifacts };
    return { preview, found, design, snapshots };
  }
  async function execute(roomId: string, input: RemoteDeliverySubmit) {
    const storageId = resolveStorageId(roomId);
    const list = states.get(storageId) || [];
    const prior = list.find(item => item.id === input.requestId);
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(input)) throw fail('同一交付请求不能更换预览或执行内容。');
      return publicAttempt(prior);
    }
    if (list.some(item => item.kind === input.kind && item.projectId === input.projectId && item.status === 'uncertain')) {
      throw fail('上次远端写入结果待核对，请先核对远端；系统不会重复执行。');
    }
    const current = await build(roomId, input.kind === 'design'), { preview, found, design, snapshots } = current;
    if (preview.fingerprint !== input.fingerprint) throw fail('本地结果、文件或目标已变化，请重新打开交付预览。');
    const duplicate = list.find(item => item.kind === input.kind && item.projectId === input.projectId && item.fingerprint === input.fingerprint && item.status === 'completed'
      && JSON.stringify(item.input.files) === JSON.stringify(input.files) && item.input.message === input.message);
    if (duplicate) return publicAttempt(duplicate);
    const project = preview.projects.find(item => item.id === input.projectId);
    const allowed = input.kind === 'design' ? preview.design : input.kind === 'jira' ? preview.jira : project;
    if (!allowed?.available) throw fail(allowed?.reason || '请选择当前任务中的交付项目。');
    if (input.kind === 'git') {
      if ((input.files || []).some(file => !project!.files.some(item => item.path === file))) throw fail('所选文件不在本次预览中。');
      if ((input.files || []).length && (!input.message?.trim() || !/[\u3400-\u9fff]/.test(input.message))) throw fail('请填写中文提交说明。');
    } else if (input.files !== undefined || input.message !== undefined || input.projectId !== undefined) throw fail('该交付类型不接受 Git 文件、项目或提交说明。');
    const attempt: StoredAttempt = { id: input.requestId, kind: input.kind, projectId: input.projectId, fingerprint: input.fingerprint,
      input, status: 'submitting', updatedAt: new Date().toISOString(), detail: '正在执行并核对远端结果。' };
    list.push(attempt); states.set(storageId, list); await save(storageId);
    try {
      if (input.kind === 'design') {
        const publication = await options.publishDesign({ destination: design.destination!, title: design.title, body: design.body,
          taskId: found.source.taskId, issueKeys: design.issueKeys, existingPageId: design.existingPageId,
          expectedVersion: design.expectedVersion, expectedBodySha256: design.expectedBodySha256 });
        attempt.publication = publication; attempt.url = publication.url; attempt.revision = String(publication.version);
        // 先保存已确认的远端页面身份；本地关联失败也保留证据，后续不会重复创建页面。
        await save(storageId);
        await options.saveDesign?.(found.source.taskId, { body: design.body, publication });
        attempt.detail = '技术方案已发布，正文、目录和版本已回读核对。';
      } else if (input.kind === 'jira') {
        const comment = await options.publishComment(found.source.taskId, preview.jira.body);
        if (!comment.verified) throw new Error('Jira 评论尚未回读核对。');
        attempt.url = comment.url; attempt.detail = '进度及技术方案、Git 关联评论已发布并回读核对。';
      } else {
        const result = await (options.git || executeProjectGitAction)({ action: 'deliver', path: project!.path, branch: project!.branch,
          remote: project!.remote, revision: snapshots.get(project!.id)!.revision, files: input.files || [], message: input.message || '' }, options.source);
        attempt.url = project!.url; attempt.revision = result.snapshot!.head; attempt.detail = '选定文件已提交推送，远端任务分支 SHA 已回读核对。';
      }
      attempt.status = 'completed';
    } catch (error) {
      // 写请求开始后的失败不能证明远端未写入；保留现场，避免超时后重复创建/提交。
      attempt.status = (error as { definite?: boolean }).definite ? 'failed' : 'uncertain';
      attempt.detail = `${error instanceof Error ? error.message : '远端交付未完成'}${attempt.status === 'uncertain' ? '；请先核对远端，系统不会重复执行。' : ''}`;
    }
    attempt.updatedAt = new Date().toISOString(); await save(storageId); return publicAttempt(attempt);
  }
  return {
    preview: async (roomId: string) => (await build(roomId)).preview,
    async downloadArtifact(roomId: string, artifactId: string, sha256: string) {
      const input = z.object({ artifactId: z.string().regex(/^(?:i18n-(?:0|[1-9]\d*)|review-0)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse({ artifactId, sha256 });
      const found = await context(roomId);
      const [kind, number] = input.artifactId.split('-');
      const index = Number(number);
      if (!Number.isSafeInteger(index)) throw fail('该文件不属于当前任务。', 404);
      const { keys } = await jiraTasksOf(found);
      const file = await readArtifact(found, index, kind === 'review' ? 'review' : 'i18n', keys);
      if (file.artifact.sha256 !== input.sha256) throw fail('交付文件已变化，请刷新产物后下载。');
      return { name: file.artifact.name, data: file.data };
    },
    submit(roomId: string, raw: unknown) {
      const input = submitSchema.parse(raw);
      const storageId = resolveStorageId(roomId);
      if (pending.has(storageId)) return Promise.reject(fail('本群聊正在执行远端交付，请稍候。'));
      const work = execute(roomId, input).finally(() => pending.delete(storageId)); pending.set(storageId, work); return work;
    },
    isIdle: () => !pending.size,
    close: async () => { await Promise.allSettled(pending.values()); },
  };
}

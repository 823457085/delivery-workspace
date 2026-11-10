/** 关联真实聊天、工作区和方案正文；发布记录只保存调用方回读证据，绑定预览目标与正文哈希，不另建发布客户端。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writePrivateJson } from './ui-state.mjs';
import { DatabaseSync } from 'node:sqlite';

function designPublication(publication, destination, sha256) {
  if (!destination) throw new Error('该历史需求未配置技术方案发布目录，不能补记发布结果。');
  if (publication.parentId !== destination.parentId || publication.spaceKey !== destination.spaceKey) throw new Error('技术方案发布结果与已确认的 Confluence 目录或空间不一致。');
  if (!/^[1-9]\d*$/.test(publication.pageId) || publication.pageId === destination.parentId) throw new Error('技术方案必须记录目标目录下的独立页面，不能使用目录页面本身。');
  if (publication.bodySha256 !== sha256) throw new Error('技术方案发布证据的正文哈希与本次保存的 Markdown 不一致，请核对正文后重新回读。');
  let url, site;
  try { url = new URL(publication.url); site = new URL(destination.site); }
  catch { throw new Error('技术方案发布链接无效。'); }
  const contextPath = site.pathname.replace(/\/+$/, '');
  const pagePath = url.pathname.startsWith(`${contextPath}/`) ? url.pathname.slice(contextPath.length) : '';
  const queryIds = url.searchParams.getAll('pageId');
  const queryPage = pagePath === '/pages/viewpage.action' && queryIds.length === 1 && queryIds[0] === publication.pageId;
  const pathPage = pagePath.match(/^\/spaces\/([^/]+)\/pages\/([1-9]\d*)(?:\/.*)?$/);
  const matchingPath = pathPage?.[1] === encodeURIComponent(destination.spaceKey) && pathPage?.[2] === publication.pageId && queryIds.every(id => id === publication.pageId);
  if (url.origin !== site.origin || url.username || url.password || (!queryPage && !matchingPath)) throw new Error('技术方案发布链接与已确认的 Confluence 站点、空间或页面编号不一致。');
  const { pageId, title, parentId, spaceKey, version, verifiedAt, bodySha256 } = publication;
  return { status: 'published', pageId, url: publication.url, title, parentId, spaceKey, version, verifiedAt, bodySha256 };
}

export function createTaskRecords({ dataDirectory }) {
  const path = join(dataDirectory, 'tasks.json');
  let queue = Promise.resolve();
  const serial = callback => {
    const result = queue.then(async () => {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const lock = new DatabaseSync(join(dataDirectory, 'task-operation-lock.sqlite'));
      try {
        try { lock.exec('BEGIN IMMEDIATE'); } catch { throw new Error('另一个面板正在更新任务关联，请稍后重试。'); }
        return await callback();
      } finally { lock.close(); }
    });
    queue = result.catch(() => {}); return result;
  };
  async function load() {
    try { const records = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(records)) throw new Error(); return records; }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('本机任务关联无法读取，未覆盖原记录。'); }
  }
  async function save(records) { await mkdir(dataDirectory, { recursive: true, mode: 0o700 }); await writePrivateJson(path, records); }
  async function withDesign(record) {
    if (record?.technicalDesign?.status !== 'ready') return record;
    try {
      const body = await readFile(record.technicalDesign.path, 'utf8');
      if (createHash('sha256').update(body).digest('hex') !== record.technicalDesign.sha256) throw new Error();
      return record;
    } catch { return { ...record, technicalDesign: { ...record.technicalDesign, status: 'pending', ...(record.requirementPlan?.designDestination || record.technicalDesign.publication ? { publication: { ...record.technicalDesign.publication, status: 'pending' } } : {}), warning: '技术方案文件缺失或已变化，请核对后重新保存。' } }; }
  }
  return {
    list: () => serial(async () => Promise.all((await load()).map(withDesign))),
    get: taskId => serial(async () => withDesign((await load()).find(record => record.taskId === taskId))),
    session: (taskId, threadId) => serial(async () => {
      if (!/^[0-9a-f-]{36}$/i.test(threadId || '')) throw new Error('聊天编号无效。');
      const records = await load(), record = records.find(item => item.taskId === taskId);
      if (!record) throw new Error('任务记录不存在。');
      if (record.threadId === threadId) return record;
      record.threadId = threadId; record.chatVerifiedAt = new Date().toISOString();
      await save(records); return record;
    }),
    create: record => serial(async () => {
      const records = await load(); records.push(record);
      const pending = item => ['ready', 'unknown', 'error'].includes(item.requirementPlan?.status) || ['ready', 'unknown', 'error'].includes(item.repairPlan?.status);
      const recent = new Set(records.filter(item => !pending(item)).slice(-500));
      await save(records.filter(item => pending(item) || recent.has(item))); return record;
    }),
    requirement: (taskId, requirementPlan) => serial(async () => {
      const records = await load(), record = records.find(item => item.taskId === taskId);
      if (!record || record.workflow !== 'requirement' || requirementPlan.taskId !== taskId) throw new Error('需求任务关联不匹配。');
      record.requirementPlan = requirementPlan;
      if (requirementPlan.status === 'applied' && requirementPlan.developmentIssue) {
        const issue = requirementPlan.developmentIssue;
        Object.assign(record, { key: issue.key, issueUrl: issue.url, issueSnapshot: issue });
      }
      await save(records); return withDesign(record);
    }),
    repair: (taskId, repairPlan) => serial(async () => {
      const records = await load(), record = records.find(item => item.taskId === taskId);
      if (!record || record.workflow !== 'jira' || repairPlan.taskId !== taskId || repairPlan.sourceKind !== 'defect') throw new Error('修复任务关联不匹配。');
      record.repairPlan = repairPlan;
      if (repairPlan.status === 'applied' && repairPlan.developmentIssue) {
        const issue = repairPlan.developmentIssue;
        if (!record.projectPath && record.branchName === `feature/${record.sourceIssue.key}`) record.branchName = `feature/${issue.key}`;
        Object.assign(record, { key: issue.key, issueUrl: issue.url, issueSnapshot: issue });
      }
      await save(records); return record;
    }),
    technicalDesign: (taskId, { body, evidence, source, publication }) => serial(async () => {
      const records = await load(), record = records.find(item => item.taskId === taskId);
      if (!record || record.workflow !== 'requirement' || !['applied', 'local'].includes(record.requirementPlan?.status) || !record.projectPath || !record.baseSha) throw new Error('请先确认需求任务并绑定独立工作区，再保存技术方案。');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const destination = record.requirementPlan.designDestination;
      if (publication && destination && record.requirementPlan.designPublicationAuthorized !== true) throw new Error('该需求尚未确认 Confluence 发布目标，请先在面板确认需求预览。');
      const previousPublication = record.technicalDesign?.publication;
      const nextPublication = publication ? designPublication(publication, destination, sha256) : destination
        ? previousPublication?.pageId && previousPublication.bodySha256 === sha256 ? { ...previousPublication, status: 'published' } : { ...previousPublication, status: 'pending' }
        : undefined;
      const directory = join(dataDirectory, 'technical-designs', taskId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const designPath = join(directory, 'tech-design.md'), temporary = join(directory, `.tech-design-${randomUUID()}.tmp`);
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await rename(temporary, designPath);
      record.technicalDesign = { status: 'ready', path: designPath, sha256, updatedAt: new Date().toISOString(), evidence, ...(source ? { source } : {}), ...(nextPublication ? { publication: nextPublication } : {}) };
      await save(records); return record.technicalDesign;
    }),
    workspace: (taskId, workspace, projectIndex = 0) => serial(async () => {
      const records = await load(), record = records.find(item => item.taskId === taskId);
      const selections = record?.projects?.length ? record.projects : [{ path: record?.sourceProjectPath, baseBranch: record?.baseBranch, branchName: record?.branchName }];
      const selection = selections[projectIndex];
      if (!record || !selection || workspace.sourcePath !== selection.path || workspace.branchName !== selection.branchName) throw new Error('实际工作区与已确认的任务不匹配。');
      if ((projectIndex === 0 && record.baseSha && record.baseSha !== workspace.baseSha) || (projectIndex > 0 && selection.baseSha && selection.baseSha !== workspace.baseSha)) throw new Error('不能覆盖任务已确认的基准 SHA。');
      if (projectIndex === 0) Object.assign(record, { projectPath: workspace.workspacePath, baseSha: workspace.baseSha });
      if (record.projects?.[projectIndex]) Object.assign(record.projects[projectIndex], { workspacePath: workspace.workspacePath, baseSha: workspace.baseSha });
      await save(records); return record;
    }),
  };
}

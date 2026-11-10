/** 本机接口工作区：契约导入、显式请求调试与 Apifox 连接。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ApiCatalog, ApiImportPreview, ApiProject, ApiProjectDetail, ApiProjectImportPreview, ApiRepositoryPreview, ApiSource } from '../shared/interface-center.js';
import { apiDebugLimits, parseApiDebugRequest } from '../shared/interface-center-debug.js';
import { apiGroups, apiOperationDetail, apiOperations, apiOperationSignature, appendApiOperations, maxContractBytes, parseApiDocument, type ApiDocument } from './interface-center-document.js';
import { createApifoxConnection, type ApifoxServiceOptions } from './interface-center-apifox.js';
import { executeApiDebug } from './interface-center-debug.js';

interface StoredProject { project: ApiProject; document: ApiDocument | null }
interface State { version: 1; projects: StoredProject[] }
const execute = promisify(execFile);
const projectInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional().default('') }).strict();
const fileInput = z.object({ content: z.string().min(1).max(maxContractBytes), filename: z.string().trim().min(1).max(255) }).strict();
const importInput = fileInput.extend({ expectedUpdatedAt: z.string().min(1).max(100) });
const repositoryInput = z.object({ repositoryPath: z.string().trim().min(1).max(2000), ref: z.string().trim().min(1).max(200) }).strict();
const repositoryImport = repositoryInput.extend({ commit: z.string().regex(/^[0-9a-f]{40}$/) });
const projectImportInput = z.object({
  source: z.discriminatedUnion('kind', [
    fileInput.extend({ kind: z.literal('file') }),
    repositoryImport.partial({ commit: true }).extend({ kind: z.literal('repository'), file: z.string().min(1).max(1024) }),
    z.object({ kind: z.literal('apifox'), teamId: z.string(), projectId: z.string() }).strict(),
  ]),
  targetId: z.string().min(1).max(255).optional(),
  sync: z.boolean().default(false),
}).strict();
const storedProject = z.object({
  id: z.string().min(1), name: z.string().min(1), description: z.string(), version: z.string(), openapi: z.string(),
  operationCount: z.number().int().nonnegative(), groups: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
  source: z.object({ kind: z.enum(['file', 'repository', 'manual', 'apifox']), label: z.string(), repositoryPath: z.string().optional(), ref: z.string().optional(), commit: z.string().optional(), file: z.string().optional(), apifoxTeamId: z.string().optional(), apifoxProjectId: z.string().optional() }),
  updatedAt: z.string().datetime(),
});
const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const nextDate = (previous = '') => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();

function sourceProjectId(source: ApiSource) {
  if (source.kind === 'repository' && source.repositoryPath && source.file) return `repo-${idFor(`${source.repositoryPath}\n${source.file}`)}`;
  if (source.kind === 'apifox' && source.apifoxProjectId) return `apifox-${idFor(source.apifoxProjectId)}`;
}

function sourceProject(projects: StoredProject[], id: string) {
  return projects.find(item => item.project.id === id) || projects.find(item => sourceProjectId(item.project.source) === id);
}

function documentChanges(document: ApiDocument, previousDocument: ApiDocument | null) {
  const operations = apiOperations(document), previous = previousDocument ? apiOperations(previousDocument) : [];
  const currentKeys = new Set(operations.map(operation => operation.key)), previousKeys = new Set(previous.map(operation => operation.key));
  const shared = (value: ApiDocument | null) => JSON.stringify(value && { components: value.components, definitions: value.definitions, parameters: value.parameters, responses: value.responses, securityDefinitions: value.securityDefinitions,
    security: value.security, servers: value.servers, host: value.host, basePath: value.basePath, schemes: value.schemes, consumes: value.consumes, produces: value.produces, jsonSchemaDialect: value.jsonSchemaDialect });
  const sharedChanged = shared(document) !== shared(previousDocument);
  return { operationCount: operations.length, groups: apiGroups(operations),
    added: operations.filter(operation => !previousKeys.has(operation.key)).length,
    updated: operations.filter(operation => previousKeys.has(operation.key) && (sharedChanged || apiOperationSignature(document, operation) !== apiOperationSignature(previousDocument!, operation))).length,
    removed: previous.filter(operation => !currentKeys.has(operation.key)).length };
}

function metadata(id: string, document: ApiDocument, source: ApiSource, previous?: ApiProject): ApiProject {
  const operations = apiOperations(document);
  return { id, name: source.kind === 'repository' ? document.info.title : previous?.name || document.info.title, description: previous?.source.kind === 'manual' && previous.description ? previous.description : String(document.info.description || ''),
    version: String(document.info.version || ''), openapi: document.openapi || document.swagger,
    operationCount: operations.length, groups: apiGroups(operations), source, updatedAt: nextDate(previous?.updatedAt) };
}

async function readRepository(input: z.infer<typeof repositoryInput>, requiredCommit?: string, fetchLatest = false) {
  if (!path.isAbsolute(input.repositoryPath)) throw new Error('请填写 BFF 仓库的绝对路径');
  let repositoryPath: string;
  try { repositoryPath = await fs.realpath(input.repositoryPath); }
  catch { throw new Error('本机仓库路径不存在'); }
  if (input.ref.startsWith('-') || !/^[\w./~^@{}-]+$/.test(input.ref)) throw new Error('Git 版本格式不正确');
  const git = async (args: string[], maxBuffer = maxContractBytes) => {
    try { return (await execute('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer, windowsHide: true })).stdout.trimEnd(); }
    catch { throw new Error('无法读取仓库版本或契约文件，请检查路径和 Git 版本'); }
  };
  const top = await git(['rev-parse', '--show-toplevel']);
  if (await fs.realpath(top) !== repositoryPath) throw new Error('请填写 Git 仓库根目录');
  let ref = input.ref;
  if (fetchLatest) {
    const tracking = ref.replace(/^refs\/remotes\//, '');
    const remote = (await git(['remote'])).split('\n').sort((a, b) => b.length - a.length)
      .find(name => name && tracking.startsWith(`${name}/`));
    const branch = remote ? tracking.slice(remote.length + 1) : '';
    if (!remote || !branch || branch === 'HEAD') throw new Error('请指定远端分支，例如 origin/dev');
    ref = `refs/remotes/${tracking}`;
    await git(['check-ref-format', ref]);
    const symbolic = await execute('git', ['-C', repositoryPath, 'symbolic-ref', '--quiet', ref], { timeout: 15_000 })
      .then(() => true, error => { if (error.code === 1) return false; throw new Error('无法检查远端分支引用'); });
    if (symbolic) throw new Error('该远端引用指向其他分支，请填写实际的远端分支名');
    try {
      await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', repositoryPath, 'fetch', '--refmap=', '--no-tags', '--no-prune',
        '--no-prune-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
        '--', remote, `+refs/heads/${branch}:${ref}`], {
        timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      const failure = error as { killed?: boolean; stderr?: string };
      if (failure.killed) throw new Error('拉取远端分支超时，请检查网络后重试');
      if (failure.stderr?.includes("couldn't find remote ref")) throw new Error(`远端没有分支 ${tracking}`);
      throw new Error(`拉取 ${tracking} 失败，请检查 Git 凭据、仓库权限和网络连接`);
    }
  }
  const commit = await git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('无法确认 Git 提交');
  if (requiredCommit && commit !== requiredCommit) throw new Error('仓库版本已变化，请重新预览再导入');
  const candidates = (await git(['ls-tree', '-r', '--name-only', commit], 2 * 1024 * 1024)).split('\n')
    .filter(file => /^(?:[^/\s]+\/)?openapi\.(?:yaml|yml|json)$/.test(file));
  // 同一目录存在生成的 JSON 时，以仓库标准 YAML 契约为准，避免一个项目出现两份目录。
  const byDirectory = new Map<string, string>();
  const priority = (file: string) => file.endsWith('.yaml') ? 0 : file.endsWith('.yml') ? 1 : 2;
  for (const file of candidates.sort((a, b) => priority(a) - priority(b))) if (!byDirectory.has(path.posix.dirname(file))) byDirectory.set(path.posix.dirname(file), file);
  const files = [...byDirectory.values()].sort();
  if (!files.length) throw new Error('未找到仓库根目录或项目子目录中的 openapi.yaml / openapi.json');
  if (files.length > 50) throw new Error('项目超过 50 个，请分仓库导入');
  const documents = [];
  for (const file of files) documents.push({ file, document: parseApiDocument(await git(['show', `${commit}:${file}`])) });
  const preview: ApiRepositoryPreview = { repositoryPath, ref, commit,
    projects: documents.map(({ file, document }) => { const operations = apiOperations(document); return {
      file, name: document.info.title, operationCount: operations.length, groups: apiGroups(operations),
    }; }) };
  return { preview, documents };
}

export async function createInterfaceCenter(directory: string, options: { apifox?: ApifoxServiceOptions } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'catalog.json');
  let state: State = { version: 1, projects: [] };
  try {
    const loaded = JSON.parse(await fs.readFile(filename, 'utf8')) as State;
    if (loaded.version !== 1 || !Array.isArray(loaded.projects)) throw new Error('invalid');
    for (const item of loaded.projects) {
      storedProject.parse(item.project);
      if (item.document !== null) parseApiDocument(JSON.stringify(item.document));
    }
    if (new Set(loaded.projects.map(item => item.project.id)).size !== loaded.projects.length) throw new Error('invalid');
    state = loaded;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机接口目录无法读取，原文件已保留'); }
  let writes = Promise.resolve();
  const snapshot = (): ApiCatalog => ({ projects: state.projects.map(item => structuredClone(item.project)) });
  const find = (id: string, current = state) => { const found = current.projects.find(item => item.project.id === id); if (!found) throw new Error('接口项目不存在'); return found; };
  const apifox = await createApifoxConnection(directory, options.apifox);
  const importPreviews = new Map<string, {
    value: ApiProjectImportPreview; document: ApiDocument; source: ApiSource;
    target?: ApiProject; boundId?: string; expires: number;
  }>();
  const source = (id: string) => {
    const item = find(id); if (!item.document) throw new Error('当前项目尚未导入接口');
    return structuredClone({ project: item.project, document: item.document });
  };
  async function update<T>(transform: (next: State) => T | Promise<T>): Promise<T> {
    const task = writes.then(async () => {
      const next = structuredClone(state);
      const result = await transform(next);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename); state = next; }
      finally { await fs.rm(temporary, { force: true }); }
      return structuredClone(result);
    });
    writes = task.then(() => {}, () => {});
    return task;
  }
  return {
    snapshot,
    apifox,
    export: source,
    previewApifox: (id: string, input: unknown) => { const item = source(id); return apifox.preview(item.project, item.document, input); },
    syncApifox: (id: string, input: unknown) => apifox.sync(() => source(id), input),
    async previewProjectImport(input: unknown): Promise<ApiProjectImportPreview> {
      const { source: selection, targetId, sync } = projectImportInput.parse(input);
      if (sync && selection.kind === 'file') throw new Error('文件导入请选择本地项目');
      let document: ApiDocument, provenance: ApiSource;
      let omittedRequestBodies = 0;
      let sourceName: string | undefined;
      if (selection.kind === 'file') {
        document = parseApiDocument(selection.content);
        const file = path.basename(selection.filename);
        provenance = { kind: 'file', label: file, file };
      } else if (selection.kind === 'repository') {
        if (!selection.commit && !sync) throw new Error('请先读取仓库版本');
        const { preview, documents } = await readRepository(selection, selection.commit);
        const entry = documents.find(item => item.file === selection.file);
        if (!entry) throw new Error('所选提交中没有该契约文件，请重新读取仓库');
        document = entry.document;
        provenance = { kind: 'repository', label: entry.file, file: entry.file, repositoryPath: preview.repositoryPath, ref: preview.ref, commit: preview.commit };
      } else {
        const remote = await apifox.readProject({ teamId: selection.teamId, projectId: selection.projectId });
        document = remote.document;
        omittedRequestBodies = remote.omittedRequestBodies;
        sourceName = sync ? remote.project.name : undefined;
        provenance = { kind: 'apifox', label: `Apifox · ${remote.project.name}`,
          ...(sync ? { apifoxTeamId: remote.project.teamId, apifoxProjectId: remote.project.id } : {}) };
      }
      const boundId = sync ? sourceProjectId(provenance) : undefined;
      const target = targetId ? find(targetId) : boundId ? sourceProject(state.projects, boundId) : undefined;
      if (sync && target && sourceProjectId(target.project.source) !== boundId) throw new Error('当前项目的同步来源已变化，请重新选择');
      const changes = sync ? documentChanges(document, target?.document ?? null) : undefined;
      const merged = !sync && target?.document ? appendApiOperations(target.document, document)
        : { document, added: changes?.added ?? apiOperations(document).length, skipped: 0 };
      const operationCount = changes?.operationCount ?? apiOperations(merged.document).length;
      if (sync ? !operationCount && !target : !merged.added && !merged.skipped) throw new Error('契约没有可同步或导入的接口');
      const value: ApiProjectImportPreview = {
        id: randomUUID(), title: String(document.info.title), source: provenance.label,
        targetName: target?.project.name || (sourceName?.trim() || String(document.info.title).trim()).slice(0, 120),
        create: !target, added: merged.added, skipped: merged.skipped, operationCount,
        ...(changes ? { sync: { updated: changes.updated, removed: changes.removed, omittedRequestBodies } } : {}),
      };
      for (const [id, preview] of importPreviews) if (preview.expires <= Date.now()) importPreviews.delete(id);
      if (importPreviews.size >= 5) importPreviews.delete(importPreviews.keys().next().value!);
      importPreviews.set(value.id, { value, document: merged.document, source: provenance, target: target?.project, boundId, expires: Date.now() + 10 * 60_000 });
      return value;
    },
    async confirmProjectImport(input: unknown): Promise<ApiProject> {
      const { previewId, name } = z.object({
        previewId: z.string().uuid(), name: z.string().trim().min(1).max(120).optional(),
      }).strict().parse(input);
      return update(next => {
        const preview = importPreviews.get(previewId);
        if (!preview || preview.expires <= Date.now()) throw new Error('导入预览已失效，请重新预览');
        const { value, target, document, source, boundId } = preview;
        if (!target) {
          const id = boundId || `import-${previewId}`, created = sourceProject(next.projects, id);
          if (created) {
            if (!boundId || JSON.stringify(created.document) === JSON.stringify(document) && JSON.stringify(created.project.source) === JSON.stringify(source)) return created.project;
            throw new Error('该来源已同步，请重新预览');
          }
          if (next.projects.length >= 200) throw new Error('项目已达到 200 个，请先整理目录');
          const project = { ...metadata(id, document, source), name: name || value.targetName };
          next.projects.push({ project, document });
          return project;
        }
        const existing = find(target.id, next);
        if (existing.project.updatedAt !== target.updatedAt) throw new Error('项目已更新，请重新预览再导入');
        if (!value.added && !boundId) return existing.project;
        existing.project = {
          ...metadata(target.id, document, boundId || !existing.document ? source : target.source, target),
          name: target.name, description: target.description || String(document.info.description || ''),
        };
        existing.document = document;
        return existing.project;
      });
    },
    async create(input: unknown): Promise<ApiProject> {
      const data = projectInput.parse(input);
      return update(next => {
        if (next.projects.length >= 200) throw new Error('项目已达到 200 个，请先整理目录');
        const project: ApiProject = { id: randomUUID(), name: data.name, description: data.description, version: '', openapi: '', operationCount: 0, groups: [], source: { kind: 'manual', label: '手动创建' }, updatedAt: nextDate() };
        next.projects.push({ project, document: null });
        return project;
      });
    },
    detail(id: string): ApiProjectDetail {
      const item = find(id);
      return { project: structuredClone(item.project), operations: item.document ? apiOperations(item.document) : [] };
    },
    operation(id: string, key: string) { const item = find(id); if (!item.document) throw new Error('当前项目尚未导入接口'); return apiOperationDetail(item.document, key); },
    preview(id: string, input: unknown): ApiImportPreview {
      const data = fileInput.parse(input), item = find(id), document = parseApiDocument(data.content);
      return { title: document.info.title, ...documentChanges(document, item.document), expectedUpdatedAt: item.project.updatedAt };
    },
    async import(id: string, input: unknown): Promise<ApiProject> {
      const data = importInput.parse(input), document = parseApiDocument(data.content);
      return update(next => {
        const item = find(id, next);
        if (data.expectedUpdatedAt !== item.project.updatedAt) throw new Error('项目已更新，请重新预览再导入');
        item.project = metadata(id, document, { kind: 'file', label: path.basename(data.filename), file: path.basename(data.filename) }, item.project);
        item.document = document;
        return item.project;
      });
    },
    async previewRepository(input: unknown) { return (await readRepository(repositoryInput.parse(input))).preview; },
    async fetchRepository(input: unknown) { return (await readRepository(repositoryInput.parse(input), undefined, true)).preview; },
    async importRepository(input: unknown): Promise<ApiCatalog> {
      const data = repositoryImport.parse(input);
      const { preview, documents } = await readRepository(data, data.commit);
      return update(next => {
        for (const { file, document } of documents) {
          const id = `repo-${idFor(`${preview.repositoryPath}\n${file}`)}`;
          const previous = sourceProject(next.projects, id);
          const project = metadata(previous?.project.id || id, document, { kind: 'repository', label: file, file, repositoryPath: preview.repositoryPath, ref: preview.ref, commit: preview.commit }, previous?.project);
          if (previous) { previous.project = project; previous.document = document; }
          else next.projects.push({ project, document });
        }
        if (next.projects.length > 200) throw new Error('项目已达到 200 个，请先整理目录');
        return { projects: next.projects.map(item => item.project) };
      });
    },
    close: async () => { await Promise.all([writes, apifox.close()]); },
  };
}

export function createInterfaceCenterRoutes(service: Awaited<ReturnType<typeof createInterfaceCenter>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  const base = '/api/interface-center';
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      && [`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '');
    if (!local || request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
      io.json(response, 403, { message: '请从本机工作台访问接口联调中心' }); return true;
    }
    try {
      const matched = url.pathname.match(/^\/api\/interface-center\/projects\/([^/]+)(?:\/(operation|preview|import|export|debug|apifox\/preview|apifox\/sync))?$/);
      const id = matched ? decodeURIComponent(matched[1]) : '', action = matched?.[2];
      if (request.method === 'GET') {
        if (url.pathname === base) io.json(response, 200, service.snapshot());
        else if (matched && !action) io.json(response, 200, service.detail(id));
        else if (matched && action === 'operation') io.json(response, 200, service.operation(id, url.searchParams.get('key') || ''));
        else if (matched && action === 'export') {
          const value = service.export(id);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${value.project.name}.openapi.json`)}` });
          response.end(JSON.stringify(value.document, null, 2));
        }
        else if (url.pathname === `${base}/apifox`) io.json(response, 200, service.apifox.snapshot());
        else if (url.pathname === `${base}/apifox/projects`) io.json(response, 200, await service.apifox.projects(url.searchParams.get('teamId') || ''));
        else io.json(response, 404, { message: '接口不存在' });
        return true;
      }
      if (request.method !== 'POST') { io.json(response, 405, { message: '请求方法不支持' }); return true; }
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
        io.json(response, 403, { message: '请从本机工作台操作接口目录' }); return true;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { io.json(response, 415, { message: '请发送 JSON' }); return true; }
      if (action === 'debug' || url.pathname.startsWith(`${base}/import/`)) request.setEncoding('utf8');
      const input = await io.body(request, action === 'debug' ? apiDebugLimits.requestEnvelopeLength : 24 * 1024 * 1024);
      if (url.pathname === `${base}/projects`) io.json(response, 201, await service.create(input));
      else if (url.pathname === `${base}/import/preview`) io.json(response, 200, await service.previewProjectImport(input));
      else if (url.pathname === `${base}/import/confirm`) io.json(response, 200, await service.confirmProjectImport(input));
      else if (matched && action === 'debug') {
        const { operationKey } = parseApiDebugRequest(input);
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        if (response.destroyed) controller.abort();
        try {
          const result = await executeApiDebug(service.operation(id, operationKey), input, controller.signal);
          if (!response.destroyed) io.json(response, 200, result);
        } finally { response.off('close', cancel); }
      }
      else if (matched && action === 'apifox/preview') io.json(response, 200, await service.previewApifox(id, input));
      else if (matched && action === 'apifox/sync') io.json(response, 200, await service.syncApifox(id, input));
      else if (url.pathname === `${base}/apifox/connect`) io.json(response, 200, await service.apifox.connect(input));
      else if (url.pathname === `${base}/apifox/refresh`) { z.object({}).strict().parse(input); io.json(response, 200, await service.apifox.refresh()); }
      else if (url.pathname === `${base}/apifox/disconnect`) { z.object({}).strict().parse(input); io.json(response, 200, await service.apifox.disconnect()); }
      else if (matched && action === 'preview') io.json(response, 200, service.preview(id, input));
      else if (matched && action === 'import') io.json(response, 200, await service.import(id, input));
      else if (url.pathname === `${base}/repository/preview`) io.json(response, 200, await service.previewRepository(input));
      else if (url.pathname === `${base}/repository/fetch`) io.json(response, 200, await service.fetchRepository(input));
      else if (url.pathname === `${base}/repository/import`) io.json(response, 200, await service.importRepository(input));
      else io.json(response, 404, { message: '接口不存在' });
    } catch (error) {
      if (!response.destroyed) io.json(response, 400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof Error ? error.message : '接口目录操作失败' });
    }
    return true;
  };
}

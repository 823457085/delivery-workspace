/** 导入原件与本轮执行结果分开保存；执行复用重构队列，不把历史通过当成本轮验收。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createRefactorProjects } from './refactor-projects.js';
import type { createRefactorControl } from './refactor-control.js';
import type { RefactorModule } from '../shared/refactor-control.js';
import type { RefactorDocument, RefactorDocumentRow, RefactorWorkspaceDashboard } from '../shared/refactor-workspace.js';

const exec = promisify(execFile);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = z.string().max(60000).default('');
const rowSchema = z.object({ row: z.number().int().positive(), issueId: text, title: text, method: text, path: text,
  request: text, parameters: text, expected: text, actual: text, sourceStatus: text, reporter: text, notes: text,
  state: z.enum(['pending_test', 'pending_retest', 'passed', 'blocked', 'unclassified']) });
const parsedSchema = z.object({ sheets: z.array(z.object({ name: z.string().max(200), index: z.number().int().nonnegative(),
  rows: z.array(rowSchema).max(10000) })).max(100), imageCount: z.number().int().nonnegative(), warnings: z.array(z.string()).default([]) });
const classificationVersion = 2;
const exportRulesVersion = 2;
type StoredDocument = Omit<RefactorDocument, 'projectName' | 'moduleId'> & { classificationVersion?: number };
type State = { version: 1; revision: string; documents: StoredDocument[] };
type Control = Pick<Awaited<ReturnType<typeof createRefactorControl>>, 'dashboard'>;
const redact = (value: string) => value
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
  .replace(/(^|\r?\n)([ \t]*(?:authorization|cookie|set-cookie)\s*:)\s*[^\r\n]*/gi, '$1$2 [redacted]')
  .replace(/(\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi, '$1[redacted]')
  .replace(/(\b(?:authorization|password|api[-_]?key|access[-_]?token|refresh[-_]?token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\n]+)/gi, '$1[redacted]');

export async function createRefactorWorkspace(root: string, directory: string, options: { control: () => Control }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const projects = await createRefactorProjects(root, path.join(directory, 'projects'));
  const stateFile = path.join(directory, 'documents.json');
  let state: State;
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.version !== 1 || !z.string().uuid().safeParse(state.revision).success || !Array.isArray(state.documents)) throw new Error('联调文档记录格式无效，未覆盖原记录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { version: 1, revision: randomUUID(), documents: [] };
  }
  let queue = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => { const result = queue.then(action); queue = result.then(() => {}, () => {}); return result; };
  async function save() {
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, stateFile);
  }
  const original = (id: string) => path.join(directory, 'documents', id, 'original.xlsx');
  function find(id: string) { const doc = state.documents.find(item => item.id === id); if (!doc) throw new Error('联调文档不存在'); return doc; }
  const moduleId = (doc: StoredDocument) => {
    const project = projects.get(doc.projectId);
    return project ? `doc-${doc.id}-${digest({ id: project.id, workspacePath: project.workspacePath, baseUrl: project.baseUrl }).slice(0, 16)}` : '';
  };
  async function workbook(args: string[]) {
    try {
      const result = await exec('/usr/bin/python3', [path.join(root, 'scripts/refactor-workbook.py'), ...args],
        { timeout: 45000, maxBuffer: 12_000_000 });
      return result.stdout;
    } catch { throw new Error('联调工作簿无法读取或生成，请检查 XLSX 文件格式、大小和文档结构'); }
  }
  const migrationWarnings = new Map<string, string>();
  const updated: { id: string; classification: boolean }[] = [];
  const documents: StoredDocument[] = [];
  for (const doc of state.documents) {
    const needsClassification = doc.classificationVersion !== classificationVersion;
    const needsReporter = doc.rows.some(row => typeof row.reporter !== 'string');
    if (!needsClassification && !needsReporter) { documents.push(doc); continue; }
    try {
      const bytes = await fs.readFile(original(doc.id));
      if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) throw new Error('原件内容变化');
      const parsed = parsedSchema.parse(JSON.parse(await workbook(['inspect', original(doc.id)])));
      const rows = new Map(parsed.sheets.flatMap(sheet => sheet.rows.map(row => [`${sheet.index}:${row.row}`, row] as const)));
      if (rows.size !== doc.rows.length || doc.rows.some(row => rows.get(`${row.sheet}:${row.row}`)?.issueId !== row.issueId)) throw new Error('原件行位置变化');
      documents.push({ ...doc, ...(needsClassification ? { classificationVersion } : {}), rows: doc.rows.map(row => {
        const source = rows.get(`${row.sheet}:${row.row}`)!;
        return { ...row, ...(needsClassification ? { state: source.state } : {}),
          ...(typeof row.reporter !== 'string' ? { reporter: source.reporter } : {}) };
      }) });
      updated.push({ id: doc.id, classification: needsClassification });
    } catch {
      documents.push(doc);
      migrationWarnings.set(doc.id, needsClassification
        ? '原始文档缺失、内容变化或结构无法核对，已保留原分类；请检查原件后重新启动工作台'
        : '原始文档缺失、内容变化或结构无法核对，已保留原记录；请检查原件后重新启动工作台');
    }
  }
  if (updated.length) {
    const previous = state; state = { ...state, revision: randomUUID(), documents };
    try { await save(); }
    catch {
      state = previous;
      for (const item of updated) migrationWarnings.set(item.id, item.classification
        ? '分类更新未能保存，已保留原分类；请检查文档存储目录后重新启动工作台'
        : '提出人员更新未能保存，已保留原记录；请检查文档存储目录后重新启动工作台');
    }
  }
  async function enriched(scope?: { documentId: string; jobId: string }): Promise<RefactorDocument[]> {
    const dashboard = await options.control().dashboard();
    return state.documents.filter(doc => !scope || doc.id === scope.documentId).map(doc => {
      const project = projects.get(doc.projectId), id = moduleId(doc);
      const jobs = dashboard.jobs.filter(job => job.moduleId === id && ['integrate', 'retest'].includes(job.action)
        && (scope ? job.id === scope.jobId : job.environment === dashboard.config.environment || job.retestMode === 'local'));
      if (scope) {
        const targetIds = jobs[0]?.targetIds;
        const rowIds = new Set(doc.rows.map(row => row.id));
        if (!targetIds?.length || !targetIds.every(target => rowIds.has(target))) throw new Error('该任务不属于当前联调文档');
      }
      const rows = doc.rows.map(row => {
        const job = jobs.find(job => job.targetIds.includes(row.id) && (job.report || job.reportError || job.status === 'failed'
            || ['failed', 'interrupted', 'cancelled'].includes(job.runStatus || '')));
        const item = job?.report?.items.find(item => item.targetId === row.id);
        const latest = job ? { status: item?.status || 'not_run' as const, actual: item?.actual || job.reportError || job.error || '未取得本轮接口结论',
          expected: item?.expected, evidence: item?.evidence || [],
          environment: job.environment, version: job.version, checkedAt: job.startedAt || job.createdAt, jobId: job.id } : undefined;
        const state = latest?.status === 'passed' ? 'passed' : latest && ['failed', 'blocked'].includes(latest.status) ? 'pending_retest' : row.state;
        return { ...row, state, ...(scope || latest ? { latest } : {}) };
      });
      return { ...doc, warnings: [...doc.warnings, ...(migrationWarnings.has(doc.id) ? [migrationWarnings.get(doc.id)!] : [])],
        projectName: project?.name || '', moduleId: id, rows };
    });
  }
  const exporting = new Map<string, Promise<string>>();
  async function exportDocument(doc: RefactorDocument) {
    const source = await fs.readFile(original(doc.id));
    if (createHash('sha256').update(source).digest('hex') !== doc.sha256) throw new Error('原始联调文档内容已变化，无法按导入原件生成新版');
    const results = doc.rows.map(row => ({ sheet: row.sheet, row: row.row, status: row.latest?.status || 'not_run',
      actual: row.latest?.actual || '本轮未执行，原文档历史记录保留',
      ...(row.latest?.expected !== undefined ? { expected: row.latest.expected } : {}),
      evidence: row.latest?.evidence || [], environment: row.latest?.environment || '', version: row.latest?.version || '',
      checkedAt: row.latest?.checkedAt || '', jobId: row.latest?.jobId || '' }));
    const signature = digest({ exportRulesVersion, sha256: doc.sha256, results });
    const outputDir = path.join(directory, 'documents', doc.id, 'reports');
    const output = path.join(outputDir, `${signature}.xlsx`);
    if (await fs.stat(output).then(stat => stat.isFile(), () => false)) return output;
    const existing = exporting.get(signature); if (existing) return existing;
    const task = (async () => {
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      const input = path.join(outputDir, `${signature}.json`);
      await fs.writeFile(input, JSON.stringify(results), { mode: 0o600 });
      const temporary = path.join(outputDir, `${signature}.${randomUUID()}.xlsx`);
      await workbook(['export', original(doc.id), temporary, input]);
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, output); return output;
    })().finally(() => exporting.delete(signature));
    exporting.set(signature, task); return task;
  }
  async function snapshot(): Promise<RefactorWorkspaceDashboard> {
    const [documents, projectData] = await Promise.all([enriched(), projects.snapshot()]);
    // 只有已有本轮结论才自动留存新版本；没有执行过的文档仍可手动导出“未执行”。
    await Promise.all(documents.filter(doc => doc.rows.some(row => row.latest)).map(async doc => {
      try { await exportDocument(doc); }
      catch (error) { doc.exportError = error instanceof Error ? error.message : '新版联调文档暂时无法生成'; }
    }));
    return { revision: state.revision, documents, projects: projectData.projects };
  }
  return {
    projects, snapshot,
    importDocument: (input: unknown) => serial(async () => {
      const body = z.object({ name: z.string().min(1).max(200), data: z.string().min(1).max(56_000_000),
        projectId: z.string().uuid().or(z.literal('')).default(''), revision: z.string().uuid() }).strict().parse(input);
      if (body.revision !== state.revision) throw new Error('文档列表已变化，请刷新后重新导入');
      if (body.projectId && !projects.get(body.projectId)) throw new Error('所选项目不存在，请先保存项目配置');
      if (!/\.xlsx$/i.test(body.name) || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error('请选择有效的 XLSX 文件');
      const buffer = Buffer.from(body.data, 'base64');
      if (!buffer.length || buffer.length > 40 * 1024 * 1024 || buffer.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('XLSX 文件为空、超过 40 MB 或格式不正确');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      if (state.documents.some(doc => doc.sha256 === sha256 && doc.projectId === body.projectId)) return snapshot();
      const id = randomUUID(), filename = original(id);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await fs.writeFile(filename, buffer, { flag: 'wx', mode: 0o600 });
      let parsed: z.infer<typeof parsedSchema>;
      try { parsed = parsedSchema.parse(JSON.parse(await workbook(['inspect', filename]))); }
      catch (error) { await fs.rm(path.dirname(filename), { recursive: true, force: true }); throw error; }
      const rows = parsed.sheets.flatMap(sheet => sheet.rows.map(row => ({ ...row, id: `xlsx:${id}:${sheet.index}:${row.row}`, sheet: sheet.index, sheetName: sheet.name })));
      if (!rows.length) { await fs.rm(path.dirname(filename), { recursive: true, force: true }); throw new Error('未识别到问题行，请核对问题编号、请求接口和问题说明表头'); }
      const doc: StoredDocument = { id, classificationVersion, name: path.basename(body.name).replace(/[\u0000-\u001f]/g, ''), importedAt: new Date().toISOString(),
        sha256, imageCount: parsed.imageCount, projectId: body.projectId, rows, warnings: parsed.warnings };
      const previous = state; state = { ...state, revision: randomUUID(), documents: [...state.documents, doc] };
      try { await save(); } catch (error) { state = previous; throw error; }
      return snapshot();
    }),
    bind: (input: unknown) => serial(async () => {
      const body = z.object({ documentId: z.string().uuid(), projectId: z.string().uuid(), revision: z.string().uuid() }).strict().parse(input);
      if (body.revision !== state.revision) throw new Error('文档列表已变化，请刷新后重试');
      if (!projects.get(body.projectId)) throw new Error('项目不存在，请先保存项目配置');
      const doc = find(body.documentId), previous = state;
      state = { ...state, revision: randomUUID(), documents: state.documents.map(item => item === doc ? { ...item, projectId: body.projectId } : item) };
      try { await save(); } catch (error) { state = previous; throw error; }
      return snapshot();
    }),
    async download(id: string, format: 'original' | 'export', jobId?: string) {
      const doc = find(id);
      if (format === 'original') return original(id);
      const scope = jobId === undefined ? undefined : { documentId: id, jobId: z.string().uuid().parse(jobId) };
      return exportDocument((await enriched(scope)).find(item => item.id === doc.id)!);
    },
    downloadName(id: string, format: 'original' | 'export') {
      const name = find(id).name;
      return format === 'original' ? name : `${name.replace(/\.xlsx$/i, '')}_原表更新.xlsx`;
    },
    async modules(): Promise<RefactorModule[]> {
      return state.documents.flatMap(doc => {
        const id = moduleId(doc); if (!id) return [];
        const interfaces = doc.rows.map(row => ({ id: row.id, name: redact(row.title || row.issueId), method: row.method, path: redact(row.path),
          page: doc.name, route: '', category: row.state === 'blocked' ? '暂不联调' : '本轮联调', reviewStatus: '待人工审核',
          previousStatus: redact(row.sourceStatus), previousResult: redact(row.actual), checkedAt: '', request: redact(row.request), parameters: redact(row.parameters),
          expected: redact(row.expected), notes: redact(row.notes), document: { id: doc.id, name: doc.name, sheet: row.sheetName, row: row.row, originalFile: original(doc.id) } }));
        const issues = doc.rows.map(row => ({ id: row.id, summary: redact(row.title || row.issueId), kind: '文档联调', status: redact(row.sourceStatus),
          description: JSON.stringify({ issueId: row.issueId, request: redact(row.request), parameters: redact(row.parameters), expected: redact(row.expected),
            actual: redact(row.actual), notes: redact(row.notes), document: { id: doc.id, name: doc.name, sheet: row.sheetName, row: row.row, originalFile: original(doc.id) } }),
          interfaceIds: [row.id], moduleId: id, moduleTitle: doc.name,
          eligibility: row.state === 'blocked' ? '原文档暂缓处理，需先确认范围' : !row.path ? '缺少请求接口，需先确认' : '' }));
        return [{ id, title: doc.name, module: projects.get(doc.projectId)!.name, deferred: false, interfaces, issues, pages: [],
          updatedAt: doc.importedAt, previousStatus: '导入文档历史记录' }];
      });
    },
    projectConfig(module: string) {
      const doc = state.documents.find(doc => moduleId(doc) === module), project = doc && projects.get(doc.projectId);
      return project ? { workspacePath: project.workspacePath, baseUrl: project.baseUrl, projectId: project.id,
        name: project.name, startScript: project.startScript, packageManager: project.packageManager } : undefined;
    },
    async close() { await queue; await Promise.allSettled([...exporting.values()]); await projects.close(); },
  };
}

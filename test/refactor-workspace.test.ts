import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRefactorWorkspace } from '../server/refactor-workspace.js';
import { createRefactorControl } from '../server/refactor-control.js';
import type { AgentRun, AgentRuntimeDashboard, StartAgentRunInput } from '../shared/agent-runtime.js';
import { refactorJobActive, refactorJobLabel, type RefactorLaunch } from '../shared/refactor-control.js';

const exec = promisify(execFile), appRoot = fileURLToPath(new URL('..', import.meta.url));
const makeWorkbook = `import sys,zipfile
from xml.etree import ElementTree as E
X='http://schemas.openxmlformats.org/spreadsheetml/2006/main';R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';P='http://schemas.openxmlformats.org/package/2006/relationships'
w=E.Element('worksheet',{'xmlns':X});E.SubElement(w,'dimension',{'ref':'A1'});d=E.SubElement(w,'sheetData')
for i,vs in enumerate([['问题编号','修改状态','问题说明','请求接口','预期 / 后端关注','请求参数','','提出人(人员)','提出人'],['FIRST','待测试','首次检查','GET /admin/list','接口原文 L123','region=NA','','示例用户（人员全名）','示例用户'],['RETEST','已修复待复测','需要复测','GET /admin/options','保留字段','id=2','','人员辅助值','L_REPORTER_001'],['DEFER','暂不处理','暂缓','GET /admin/deferred','','','','示例成员（人员全名）','示例成员']],1):
 r=E.SubElement(d,'row',{'r':str(i)})
 for j,v in enumerate(vs):
  c=E.SubElement(r,'c',{'r':chr(65+j)+str(i),'t':'inlineStr'});E.SubElement(E.SubElement(c,'is'),'t').text=v
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
 z.writestr('xl/workbook.xml','<workbook xmlns="'+X+'" xmlns:r="'+R+'"><sheets><sheet name="联调问题清单" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="'+P+'"><Relationship Id="rId1" Type="'+R+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml',E.tostring(w,encoding='utf-8'))
 z.writestr('xl/media/image1.png',b'fixture-original-image')
`;
async function fixture(t: TestContext, options: { missingLegacy?: boolean; historicalPass?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-workspace-chain-'));
  const projectPath = path.join(directory, 'frontend'); await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ scripts: { dev: 'node fixture.mjs' } }));
  if (options.missingLegacy) {
    await fs.mkdir(path.join(directory, 'public/integration-runs'), { recursive: true });
    await fs.writeFile(path.join(directory, 'public/integration-runs/demo-user-plan.json'), JSON.stringify({ automation: {
      workspacePath: path.join(directory, 'deleted-old-workspace'), baseUrl: 'http://127.0.0.1:6791', environment: 'DEV', assignee: 'demo-user',
    } }));
  }
  const source = path.join(directory, 'original.xlsx');
  await exec('/usr/bin/python3', ['-c', options.historicalPass ? makeWorkbook.replace("'FIRST','待测试'", "'FIRST','复测通过'") : makeWorkbook, source]);
  const bytes = await fs.readFile(source), checksum = createHash('sha256').update(bytes).digest('hex');
  const runs = new Map<string, AgentRun>(), calls: StartAgentRunInput[] = [];
  const runtime = {
    async dashboard() { return { runtimes: [{ provider: 'codex', ready: true, writable: true, models: [{ id: 'fixture', label: 'Fixture' }] }], runs: [] } as unknown as AgentRuntimeDashboard; },
    getRun: (id: string) => [...runs.values()].find(run => run.id === id), findManagedRefactor: (id: string) => runs.get(id),
    async startManagedRefactor(input: StartAgentRunInput, jobId: string) {
      calls.push(input); const run = { id: randomUUID(), status: 'running', events: [] } as unknown as AgentRun; runs.set(jobId, run); return run;
    },
    async stop(id: string) { const run = [...runs.values()].find(run => run.id === id)!; run.status = 'cancelled'; return run; },
  };
  let control: Awaited<ReturnType<typeof createRefactorControl>>;
  const workspace = await createRefactorWorkspace(appRoot, path.join(directory, 'workspace'), { control: () => control });
  control = await createRefactorControl(directory, path.join(directory, 'control'), runtime, {
    autoDispatch: false, extraModules: () => workspace.modules(), moduleConfig: id => workspace.projectConfig(id),
  });
  t.after(async () => { await control.close(); await workspace.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const project = { id: randomUUID(), name: '测试子应用', role: 'micro-app' as const, workspacePath: projectPath,
    baseUrl: 'http://127.0.0.1:65081', packageManager: 'npm' as const, startScript: 'dev', dependencies: [] };
  const projectData = await workspace.projects.snapshot(); await workspace.projects.configure({ revision: projectData.revision, projects: [project] });
  const before = await workspace.snapshot();
  await workspace.importDocument({ name: 'fixture.xlsx', data: bytes.toString('base64'), projectId: project.id, revision: before.revision });
  const doc = (await workspace.snapshot()).documents[0];
  const launch = (overrides: Partial<RefactorLaunch> = {}): RefactorLaunch => ({ action: 'integrate', moduleIds: [doc.moduleId], issueIds: [],
    interfaceIds: [doc.rows[0].id], provider: 'codex', model: 'fixture', version: 'fixture-v1', notes: '', revision: '', ...overrides });
  return { directory, workspace, control, project, doc, launch, runs, calls, bytes, checksum, source };
}

test('真实XLSX导入→精确选择接口→项目工作区派发→结构化报告→自动新版文档，原件与未执行项保持独立', async t => {
  const f = await fixture(t), dashboard = await f.control.dashboard();
  assert.equal(f.doc.rows.length, 3); assert.equal(f.doc.imageCount, 1);
  assert.deepEqual(f.doc.rows.map(row => row.reporter), ['示例用户', 'L_REPORTER_001', '示例成员']);
  const launch = f.launch({ revision: dashboard.revision });
  const preview = await f.control.preview(launch);
  assert.deepEqual(preview.jobs[0].targetIds, [f.doc.rows[0].id]);
  assert.equal(preview.jobs[0].workspacePath, await fs.realpath(f.project.workspacePath));
  assert.equal(preview.jobs[0].baseUrl, f.project.baseUrl + '/');
  const request = { launch, scopeHash: preview.scopeHash, requestId: randomUUID() };
  const batch = await f.control.start(request); await f.control.pump();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].workspacePath, await fs.realpath(f.project.workspacePath));
  assert.match(f.calls[0].objective, /原文截图/); assert.match(f.calls[0].objective, /接口原文 L123/);
  assert.match(f.calls[0].objective, /主交付文件必须基于本次导入的原始联调文档/);
  assert.ok(f.calls[0].objective.includes(`/workspace/documents/${f.doc.id}/export`));
  assert.match(f.calls[0].objective, /额外协助清单只能作为补充附件/);
  assert.equal((await f.control.start(request)).reused, true);
  const jobId = batch.jobIds[0], artifacts = path.join(f.directory, 'control/artifacts', jobId);
  await fs.writeFile(path.join(artifacts, 'request.json'), '{"fixture":true,"readOnly":true}');
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ jobId, environment: 'DEV', version: 'fixture-v1', status: 'passed', summary: '仅测试夹具链路',
    items: [{ targetId: f.doc.rows[0].id, status: 'passed', actual: '仅夹具模拟结果，不是业务联调', evidence: ['request.json'] }],
    checks: [{ name: 'fixture-only', status: 'passed', detail: '没有调用业务接口' }], changedFiles: [] }));
  const doc = (await f.workspace.snapshot()).documents[0];
  const stillRunning = (await f.control.dashboard()).jobs.find(job => job.id === jobId)!;
  assert.equal(stillRunning.runStatus, 'running');
  assert.equal(refactorJobActive(stillRunning), true);
  assert.equal(refactorJobLabel(stillRunning), '执行中', '可下载验证报告不代表执行器结束');
  assert.equal(doc.rows[0].latest?.status, 'passed'); assert.equal(doc.rows[0].state, 'passed');
  assert.deepEqual(doc.rows[0].latest?.evidence, ['request.json']);
  assert.equal(doc.rows[1].latest, undefined); assert.equal(doc.rows[2].state, 'blocked');
  const output = await f.workspace.download(doc.id, 'export'); assert.ok((await fs.stat(output)).size > 0);
  const original = await fs.readFile(await f.workspace.download(doc.id, 'original'));
  assert.equal(createHash('sha256').update(original).digest('hex'), f.checksum);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  const result = JSON.parse((await exec('/usr/bin/python3', [path.join(appRoot, 'scripts/refactor-workbook.py'), 'inspect', output])).stdout);
  assert.equal(result.sheets[0].rows[0].latest.status, 'passed');
  assert.equal(result.sheets[0].rows[0].sourceStatus, '复测通过');
  assert.equal(result.sheets[0].rows[0].actual, '仅夹具模拟结果，不是业务联调');
  assert.equal(result.sheets[0].rows[0].expected, '接口原文 L123', '未提供本轮expected不能改写原预期');
  assert.equal(f.workspace.downloadName(doc.id, 'original'), 'fixture.xlsx');
  assert.equal(f.workspace.downloadName(doc.id, 'export'), 'fixture_原表更新.xlsx');
  assert.equal(result.sheets[0].rows[1].latest.status, 'not_run');
  assert.equal(result.imageCount, 1);
  f.runs.get(jobId)!.status = 'completed';
  const nextLaunch = f.launch({ revision: dashboard.revision, interfaceIds: [f.doc.rows[0].id, f.doc.rows[1].id] });
  const nextPreview = await f.control.preview(nextLaunch);
  const { jobIds: [nextId] } = await f.control.start({ launch: nextLaunch, scopeHash: nextPreview.scopeHash, requestId: randomUUID() });
  await f.control.pump();
  const nextArtifacts = path.join(f.directory, 'control/artifacts', nextId);
  await fs.writeFile(path.join(nextArtifacts, 'request.json'), '{"fixture":true}');
  await fs.writeFile(path.join(nextArtifacts, 'result.json'), JSON.stringify({ jobId: nextId, environment: 'DEV', version: 'fixture-v1', status: 'partial', summary: '另一批夹具结果',
    items: [{ targetId: f.doc.rows[0].id, status: 'failed', actual: '第二批重测失败', evidence: ['request.json'] },
      { targetId: f.doc.rows[1].id, status: 'passed', actual: '第二批新增结论', evidence: ['request.json'] }], checks: [], changedFiles: [] }));
  const latestOutput = await f.workspace.download(doc.id, 'export');
  assert.notEqual(latestOutput, output);
  assert.equal(await f.workspace.download(doc.id, 'export', jobId), output, '第一批导出不吸收第二批同一行和新增行的结果');
  assert.equal(await f.workspace.download(doc.id, 'export', nextId), latestOutput);
  const latest = JSON.parse((await exec('/usr/bin/python3', [path.join(appRoot, 'scripts/refactor-workbook.py'), 'inspect', latestOutput])).stdout);
  assert.deepEqual(latest.sheets[0].rows.slice(0, 2).map((row: { latest: { jobId: string; status: string } }) => [row.latest.jobId, row.latest.status]),
    [[nextId, 'failed'], [nextId, 'passed']]);
  await assert.rejects(f.workspace.download(doc.id, 'export', 'not-a-uuid'), /uuid/i);
  await assert.rejects(f.workspace.download(doc.id, 'export', randomUUID()), /不属于当前联调文档/);
  const projectData = await f.workspace.projects.snapshot();
  await f.workspace.projects.configure({ revision: projectData.revision, projects: [{ ...f.project, baseUrl: 'http://127.0.0.1:65083' }] });
  const changed = (await f.workspace.snapshot()).documents[0];
  assert.notEqual(changed.moduleId, f.doc.moduleId);
  assert.equal(changed.rows[0].latest, undefined, '旧项目的通过结果不能用于新地址');
  await assert.rejects(f.workspace.download(doc.id, 'export', jobId), /不属于当前联调文档/);
  assert.equal((await f.control.dashboard()).jobs.find(job => job.id === jobId)?.report?.status, 'passed', '原任务历史仍可查看');
});

test('本地分支复测结果绑定LOCAL与实际Commit，文档回读及导出不会因原配置DEV丢失结果', async t => {
  const f = await fixture(t), cwd = f.project.workspacePath;
  const git = async (...args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  await fs.writeFile(path.join(cwd, 'fixture.mjs'), "import http from 'node:http';http.createServer((req,res)=>res.end('local-fixture')).listen(Number(process.env.PORT),process.env.HOST);");
  await git('init', '-b', 'feature/local-retest'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('add', '.'); await git('commit', '-m', '测试本地复测');
  const head = await git('rev-parse', 'HEAD'), source = (await f.control.branches({ moduleIds: [f.doc.moduleId] }))[0];
  const launch = f.launch({ action: 'retest', interfaceIds: [], issueIds: [f.doc.rows[1].id], version: '', retestMode: 'local',
    branches: [{ workspacePath: source.workspacePath, ref: source.current }], revision: (await f.control.dashboard()).revision });
  const preview = await f.control.preview(launch);
  const { jobIds: [jobId] } = await f.control.start({ launch, scopeHash: preview.scopeHash, requestId: randomUUID() }); await f.control.pump();
  assert.ok(f.calls[0].objective.includes(`/workspace/documents/${f.doc.id}/export`), '问题复测也绑定原文档统一导出');
  const artifacts = path.join(f.directory, 'control/artifacts', jobId);
  await fs.writeFile(path.join(artifacts, 'request.json'), '{"fixture":true}');
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ jobId, environment: 'LOCAL', version: head, status: 'passed', summary: '本地测试夹具',
    items: [{ targetId: f.doc.rows[1].id, status: 'passed', actual: '真实本地测试服务可响应，仅验证工作流', evidence: ['request.json'] }],
    checks: [{ name: 'fixture', status: 'passed', detail: '没有调用业务接口' }], changedFiles: [] }));
  f.runs.get(jobId)!.status = 'completed'; await f.control.pump();
  const doc = (await f.workspace.snapshot()).documents[0];
  assert.equal(doc.rows[1].latest?.environment, 'LOCAL'); assert.equal(doc.rows[1].latest?.version, head); assert.equal(doc.rows[1].state, 'passed');
  assert.equal(doc.rows[0].latest, undefined);
  const output = await f.workspace.download(doc.id, 'export');
  const parsed = JSON.parse((await exec('/usr/bin/python3', [path.join(appRoot, 'scripts/refactor-workbook.py'), 'inspect', output])).stdout);
  assert.equal(parsed.sheets[0].rows[1].latest.environment, 'LOCAL'); assert.equal(parsed.sheets[0].rows[1].latest.version, head);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('文档目标不能越界或执行暂缓接口，项目地址变化令旧预览失效，重复导入不制造副本', async t => {
  const f = await fixture(t), dashboard = await f.control.dashboard();
  await assert.rejects(f.control.preview(f.launch({ revision: dashboard.revision, interfaceIds: ['another-document-row'] })), /所选接口/);
  await assert.rejects(f.control.preview(f.launch({ revision: dashboard.revision, interfaceIds: [f.doc.rows[2].id] })), /所选接口/);
  const launch = f.launch({ revision: dashboard.revision }), preview = await f.control.preview(launch);
  await assert.rejects(f.control.start({ launch: { ...launch, action: 'develop' }, scopeHash: preview.scopeHash, requestId: randomUUID() }), /范围已变化/);
  await assert.rejects(f.control.start({ launch: { ...launch, version: 'another-version' }, scopeHash: preview.scopeHash, requestId: randomUUID() }), /范围已变化/);
  const projectData = await f.workspace.projects.snapshot();
  await f.workspace.projects.configure({ revision: projectData.revision, projects: [{ ...f.project, baseUrl: 'http://127.0.0.1:65082' }] });
  await assert.rejects(f.control.start({ launch, scopeHash: preview.scopeHash, requestId: randomUUID() }), /范围/);
  assert.equal(f.calls.length, 0);
  const before = await f.workspace.snapshot();
  const after = await f.workspace.importDocument({ name: 'another-name.xlsx', data: f.bytes.toString('base64'), projectId: f.project.id, revision: before.revision });
  assert.equal(after.documents.length, 1);
  await assert.rejects(f.workspace.importDocument({ name: 'fixture.xlsx', data: f.bytes.toString('base64'), projectId: '', revision: randomUUID() }), /文档列表已变化/);
});

test('新导出规则不复用旧版缓存，缓存存在时也校验原件完整性', async t => {
  const f = await fixture(t);
  const legacyResults = f.doc.rows.map(row => ({ sheet: row.sheet, row: row.row, status: 'not_run',
    actual: '本轮未执行，原文档历史记录保留', expected: row.expected, evidence: [], environment: '', version: '', checkedAt: '', jobId: '' }));
  const legacyHash = createHash('sha256').update(JSON.stringify({ sha256: f.doc.sha256, results: legacyResults })).digest('hex');
  const reports = path.join(f.directory, 'workspace/documents', f.doc.id, 'reports');
  await fs.mkdir(reports, { recursive: true });
  const legacyFile = path.join(reports, `${legacyHash}.xlsx`);
  await fs.writeFile(legacyFile, 'old-append-only-cache');
  const output = await f.workspace.download(f.doc.id, 'export');
  assert.notEqual(output, legacyFile);
  assert.equal((await fs.readFile(output)).subarray(0, 2).toString(), 'PK');
  assert.equal(await f.workspace.download(f.doc.id, 'export'), output, '相同结果复用新版缓存');
  const parsed = JSON.parse((await exec('/usr/bin/python3', [path.join(appRoot, 'scripts/refactor-workbook.py'), 'inspect', output])).stdout);
  assert.equal(parsed.sheets[0].rows[0].sourceStatus, '待测试');
  await fs.appendFile(await f.workspace.download(f.doc.id, 'original'), 'unexpected-change');
  await assert.rejects(f.workspace.download(f.doc.id, 'export'), /原始联调文档内容已变化/);
});

test('排队后项目绑定改变不在旧目录执行；未取得本轮结论不会显示通过', async t => {
  const f = await fixture(t), dashboard = await f.control.dashboard();
  const launch = f.launch({ revision: dashboard.revision }), preview = await f.control.preview(launch);
  const batch = await f.control.start({ launch, scopeHash: preview.scopeHash, requestId: randomUUID() });
  const before = await f.workspace.projects.snapshot();
  await f.workspace.projects.configure({ revision: before.revision, projects: [{ ...f.project, baseUrl: 'http://127.0.0.1:65084' }] });
  await f.control.pump();
  assert.equal(f.calls.length, 0);
  const job = (await f.control.dashboard()).jobs.find(job => job.id === batch.jobIds[0])!;
  assert.equal(job.status, 'failed'); assert.match(job.error, /范围已变化/);
  assert.equal((await f.workspace.snapshot()).documents[0].rows[0].latest, undefined);
});

test('原件保留认证字段，派发上下文完整脱敏Bearer、多Cookie和原始响应', async t => {
  const f = await fixture(t);
  const tokens = ['fixture-auth-secret', 'fixture-cookie-one', 'fixture-cookie-two', 'fixture-password', 'fixture-response-secret'];
  const parameters = `Authorization: Bearer ${tokens[0]}\nCookie: one=${tokens[1]}; two=${tokens[2]}\n{"password":"${tokens[3]}"}`;
  await exec('/usr/bin/python3', ['-c', `import sys,zipfile,os
from xml.etree import ElementTree as E
p=sys.argv[1];X='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(p) as z:parts={n:z.read(n) for n in z.namelist()}
r=E.fromstring(parts['xl/worksheets/sheet1.xml']);rows=r.find(X+'sheetData')
rows[1].find("./"+X+"c[@r='F2']/"+X+"is/"+X+"t").text=sys.argv[2]
for row,ref,value in [(rows[0],'G1','实际结果'),(rows[1],'G2',sys.argv[3])]:
 c=E.SubElement(row,X+'c',{'r':ref,'t':'inlineStr'});E.SubElement(E.SubElement(c,X+'is'),X+'t').text=value
parts['xl/worksheets/sheet1.xml']=E.tostring(r,encoding='utf-8')
with zipfile.ZipFile(p+'.tmp','w',zipfile.ZIP_DEFLATED) as z:
 for n,b in parts.items():z.writestr(n,b)
os.replace(p+'.tmp',p)`, f.source, parameters, `Authorization: Bearer ${tokens[4]}`]);
  const before = await f.workspace.snapshot(), bytes = await fs.readFile(f.source);
  const next = await f.workspace.importDocument({ name: 'secrets-fixture.xlsx', data: bytes.toString('base64'), projectId: f.project.id, revision: before.revision });
  const doc = next.documents.find(doc => doc.name === 'secrets-fixture.xlsx')!;
  assert.equal(doc.rows[0].parameters, parameters, '导入文档原文仍保留');
  const targets = JSON.stringify((await f.workspace.modules()).find(module => module.id === doc.moduleId));
  for (const token of tokens) assert.equal(targets.includes(token), false, token);
  assert.ok(targets.includes('[redacted]'));
});

test('旧单项目工作区失效不阻止已绑定有效项目的文档联调', async t => {
  const f = await fixture(t, { missingLegacy: true }), dashboard = await f.control.dashboard();
  assert.equal(dashboard.source?.workspace.branch, '旧模块工作区不可用');
  const launch = f.launch({ revision: dashboard.revision }), preview = await f.control.preview(launch);
  await f.control.start({ launch, scopeHash: preview.scopeHash, requestId: randomUUID() });
  await f.control.pump();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].workspacePath, await fs.realpath(f.project.workspacePath));
});

test('旧导入分类按原件升级，只更新派生状态并保留编号、绑定、原文和执行证据；本轮失败仍覆盖历史通过', async t => {
  const f = await fixture(t, { historicalPass: true }), dashboard = await f.control.dashboard();
  await f.control.close(); await f.workspace.close();
  const stateFile = path.join(f.directory, 'workspace/documents.json');
  const legacy = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  delete legacy.documents[0].classificationVersion;
  legacy.documents[0].rows[0].state = 'pending_retest';
  legacy.documents[0].rows[1].latest = { status: 'failed', actual: '保留执行原文 L456', evidence: ['request.json'],
    environment: 'DEV', version: 'fixture-v1', checkedAt: '2026-11-04T00:00:00Z', jobId: 'preserved-job' };
  await fs.writeFile(stateFile, JSON.stringify(legacy));
  const failedJob = { id: 'fixture-latest-failure', moduleId: f.doc.moduleId, environment: dashboard.config.environment,
    action: 'retest', targetIds: [f.doc.rows[0].id], version: 'fixture-v2', createdAt: '2026-11-04T01:00:00Z',
    report: { items: [{ targetId: f.doc.rows[0].id, status: 'failed', actual: '真实后继失败 L789', evidence: [] }] } } as typeof dashboard.jobs[number];
  let jobs: typeof dashboard.jobs = [];
  const control = () => ({ dashboard: async () => ({ ...dashboard, jobs }) });
  const reopened = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), { control });
  try {
    const migrated = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(migrated.documents[0].classificationVersion, 2);
    assert.notEqual(migrated.revision, legacy.revision);
    const { classificationVersion, ...doc } = migrated.documents[0];
    assert.deepEqual(doc, { ...legacy.documents[0], rows: legacy.documents[0].rows.map((row: object, index: number) => index === 0 ? { ...row, state: 'passed' } : row) });
    assert.equal((await reopened.snapshot()).documents[0].rows[0].state, 'passed');
    jobs = [failedJob];
    const failed = (await reopened.snapshot()).documents[0].rows[0];
    assert.equal(failed.state, 'pending_retest'); assert.equal(failed.latest?.status, 'failed');
    assert.equal(failed.latest?.actual, '真实后继失败 L789');
    assert.equal(createHash('sha256').update(await fs.readFile(await reopened.download(f.doc.id, 'original'))).digest('hex'), f.checksum);
    const persisted = await fs.readFile(stateFile, 'utf8');
    await reopened.close();
    const again = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), { control });
    try { assert.equal(await fs.readFile(stateFile, 'utf8'), persisted, '成功升级只执行一次'); }
    finally { await again.close(); }
  } finally { await reopened.close(); }
});

test('分类升级遇到原件缺失或内容变化保留旧记录，提供识别说明而不阻止服务启动', async t => {
  for (const mode of ['missing', 'changed']) {
    const f = await fixture(t, { historicalPass: true }), dashboard = await f.control.dashboard();
    await f.control.close(); await f.workspace.close();
    const stateFile = path.join(f.directory, 'workspace/documents.json'), legacy = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    delete legacy.documents[0].classificationVersion; legacy.documents[0].rows[0].state = 'pending_retest';
    const persisted = JSON.stringify(legacy); await fs.writeFile(stateFile, persisted);
    const original = path.join(f.directory, 'workspace/documents', f.doc.id, 'original.xlsx');
    if (mode === 'missing') await fs.rm(original);
    else await fs.appendFile(original, 'changed');
    const reopened = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), { control: () => ({ dashboard: async () => dashboard }) });
    try {
      const doc = (await reopened.snapshot()).documents[0];
      assert.equal(doc.rows[0].state, 'pending_retest'); assert.equal(doc.rows[0].sourceStatus, '复测通过');
      assert.ok(doc.warnings.some(warning => warning.includes('已保留原分类')));
      assert.equal(await fs.readFile(stateFile, 'utf8'), persisted);
    } finally { await reopened.close(); }
  }
});

test('旧文档仅回补缺失提出人，保留分类版本、状态、行ID、历史和原件图片，保存后不重复读取', async t => {
  const f = await fixture(t, { historicalPass: true }), dashboard = await f.control.dashboard();
  await f.control.close(); await f.workspace.close();
  const stateFile = path.join(f.directory, 'workspace/documents.json');
  const legacy = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const rows = legacy.documents[0].rows;
  delete rows[0].reporter; delete rows[1].reporter;
  rows[0].state = 'blocked';
  rows[1].latest = { status: 'failed', actual: '保留执行原文 L456', evidence: ['request.json'],
    environment: 'DEV', version: 'fixture-v1', checkedAt: '2026-11-04T00:00:00Z', jobId: 'preserved-job' };
  rows[2].reporter = '已保存原文 L_KEEP';
  await fs.writeFile(stateFile, JSON.stringify(legacy));
  const control = () => ({ dashboard: async () => ({ ...dashboard, jobs: [] }) });
  const reopened = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), { control });
  try {
    const migrated = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.notEqual(migrated.revision, legacy.revision);
    assert.deepEqual(migrated.documents, [{ ...legacy.documents[0], rows: rows.map((row: object, index: number) =>
      index < 2 ? { ...row, reporter: ['示例用户', 'L_REPORTER_001'][index] } : row) }]);
    const doc = (await reopened.snapshot()).documents[0];
    assert.equal(doc.rows[0].state, 'blocked', '回补人员不重算已有处理分类');
    assert.equal(doc.rows[1].latest?.actual, '保留执行原文 L456');
    assert.equal(doc.imageCount, 1);
    const original = await reopened.download(doc.id, 'original');
    assert.deepEqual(await fs.readFile(original), f.bytes, '包含图片的原始压缩包逐字节保留');
    const persisted = await fs.readFile(stateFile, 'utf8');
    await reopened.close();
    await fs.rename(original, `${original}.saved`);
    const again = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), { control });
    try {
      assert.equal(await fs.readFile(stateFile, 'utf8'), persisted);
      assert.deepEqual((await again.snapshot()).documents[0].warnings, f.doc.warnings, '成功回补后原件不再参与解析');
    } finally { await again.close(); }
  } finally { await reopened.close(); }
});

test('人员回补遇到原件缺失、变化或行身份不一致时保留全部旧记录并使用现有识别说明', async t => {
  for (const mode of ['missing', 'changed', 'position']) {
    const f = await fixture(t), dashboard = await f.control.dashboard();
    await f.control.close(); await f.workspace.close();
    const stateFile = path.join(f.directory, 'workspace/documents.json');
    const legacy = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    delete legacy.documents[0].rows[0].reporter;
    legacy.documents[0].rows[0].state = 'blocked';
    if (mode === 'position') legacy.documents[0].rows[0].row = 999;
    const persisted = JSON.stringify(legacy); await fs.writeFile(stateFile, persisted);
    const original = path.join(f.directory, 'workspace/documents', f.doc.id, 'original.xlsx');
    if (mode === 'missing') await fs.rm(original);
    else if (mode === 'changed') await fs.appendFile(original, 'changed');
    const reopened = await createRefactorWorkspace(appRoot, path.join(f.directory, 'workspace'), {
      control: () => ({ dashboard: async () => ({ ...dashboard, jobs: [] }) }),
    });
    try {
      const doc = (await reopened.snapshot()).documents[0];
      assert.deepEqual(doc.rows, legacy.documents[0].rows);
      assert.ok(doc.warnings.some(warning => warning.includes('已保留原记录')));
      assert.equal(await fs.readFile(stateFile, 'utf8'), persisted);
    } finally { await reopened.close(); }
  }
});

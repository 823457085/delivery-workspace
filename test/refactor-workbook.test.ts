import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/refactor-workbook.py', import.meta.url));
const python = '/usr/bin/python3';
const makeFixture = `
import pathlib,sys,zipfile,json
from xml.etree import ElementTree as E
p=pathlib.Path(sys.argv[1]);mode=sys.argv[2]
X='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P='http://schemas.openxmlformats.org/package/2006/relationships'
headers=['问题编号','修改说明','修改状态','修改人','提出人','问题说明','预期 / 后端关注','请求接口','请求参数','实际结果','截图','截图-图片','截图（续）','截图（续）-图片','记录时间（北京时间）','traceId','契约依据','补充 / 复测记录','提出人(人员)']
rows=[headers,
 ['affiliatedDealer','','已修复待复测','','','下拉选项','应显示选项','GET /admin/options','region=NA','旧结果'],
 ['14','','复测通过','','','多接口查询','','GET /admin/a\\nGET /admin/b','','历史结果','','','','','','','','2026-10-20 复测结果：复测不通过\\n2026-10-19 复测结果：复测通过'],
 ['VM-008、NV-L006','','待处理','','','多项目接口','','GET /admin/a\\nPOST /admin/create','',''],
 ['product_enum_dict','','暂不处理','','','未标明方法','','/admin/v1/enums','',''],
 ['6','','复测通过','','','历史通过','','GET /admin/old','','旧结果','','','','','','','','2026-10-29 复测通过（本次未重新测试）'],
]
if mode=='unknown-status':rows[1][2]='后台说好了'
if mode=='pending-test':rows[1][2]='待测试'
if mode=='status-conflicts':
 for row,status in zip(rows[1:],['复测通过','复测不通过','已修复待复测','暂不处理','待测试']):
  row[2]=status
  while len(row)<18:row.append('')
  row[17]='2026-10-29 复测结果：'+('复测不通过' if status=='复测通过' else '复测通过')
if mode=='notes-fallback':
 rows[2][2]=''
for row,reporter in zip(rows[1:],['示例用户','L_REPORTER_001','示例成员','示例用户','示例成员']):
 row[4]=reporter
 while len(row)<19:row.append('')
 row[18]='人员全名-'+reporter
if mode=='reporter-primary-last':
 for row in rows:row[4],row[18]=row[18],row[4]
if mode.startswith('reporter-alias:'):
 headers[4]=mode.split(':',1)[1];headers[18]='其他人员信息'
if mode=='missing-result-columns':
 for i,label in [(2,'原状态资料'),(6,'原预期资料'),(9,'原结果资料'),(17,'原补充资料')]:headers[i]=label
root=E.Element('worksheet',{'xmlns':X});E.SubElement(root,'dimension',{'ref':'A1'});data=E.SubElement(root,'sheetData')
def col(i):
 s=''
 while i:
  i,d=divmod(i-1,26);s=chr(65+d)+s
 return s
for i,vs in enumerate(rows,1):
 row=E.SubElement(data,'row',{'r':str(i)})
 for j,v in enumerate(vs,1):
  c=E.SubElement(row,'c',{'r':col(j)+str(i),'t':'inlineStr'});E.SubElement(E.SubElement(c,'is'),'t').text=v
if mode=='missing-result-columns':
 tail=E.SubElement(data,'row',{'r':'7'})
 c=E.SubElement(tail,'c',{'r':'Z7'});E.SubElement(c,'f').text='1+1'
parts={
 '[Content_Types].xml':b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
 'xl/workbook.xml':('<workbook xmlns="'+X+'" xmlns:r="'+R+'"><sheets><sheet name="联调问题清单" sheetId="1" r:id="rId1"/></sheets></workbook>').encode(),
 'xl/_rels/workbook.xml.rels':('<Relationships xmlns="'+P+'"><Relationship Id="rId1" Type="'+R+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>').encode(),
 'xl/worksheets/sheet1.xml':E.tostring(root,encoding='utf-8'),
 'xl/media/image1.png':b'fixture-image-preserve-exactly',
 'xl/drawings/drawing1.xml':b'<fixture>preserve drawing bytes</fixture>',
 'xl/styles.xml':b'<fixture>preserve styles bytes</fixture>',
}
if mode=='prefixed-multiple-sheets':
 # Workbook order and physical part numbers deliberately differ; include a locally styled empty cell.
 E.register_namespace('s',X)
 second=E.fromstring(parts['xl/worksheets/sheet1.xml'])
 cell=second.find('.//{'+X+'}c[@r="J2"]');cell.clear();cell.attrib.update({'r':'J2','s':'2'})
 parts['xl/worksheets/sheet7.xml']=parts.pop('xl/worksheets/sheet1.xml')
 parts['xl/worksheets/sheet3.xml']=E.tostring(second,encoding='utf-8')
 parts['xl/workbook.xml']=('<workbook xmlns="'+X+'" xmlns:r="'+R+'"><sheets><sheet name="模块一" sheetId="7" r:id="first"/><sheet name="模块二" sheetId="3" r:id="second"/></sheets></workbook>').encode()
 parts['xl/_rels/workbook.xml.rels']=('<Relationships xmlns="'+P+'"><Relationship Id="first" Type="'+R+'/worksheet" Target="worksheets/sheet7.xml"/><Relationship Id="second" Type="'+R+'/worksheet" Target="worksheets/sheet3.xml"/></Relationships>').encode()
 parts['[Content_Types].xml']=parts['[Content_Types].xml'].replace(b'/xl/worksheets/sheet1.xml',b'/xl/worksheets/sheet7.xml').replace(b'</Types>',b'<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
if mode=='macro':parts['xl/vbaProject.bin']=b'fixture'
if mode=='external':parts['xl/worksheets/_rels/sheet1.xml.rels']=('<Relationships xmlns="'+P+'"><Relationship Id="rId9" Type="'+R+'/externalLink" Target="https://fixture.test/data" TargetMode="External"/></Relationships>').encode()
if mode=='entity':parts['xl/workbook.xml']=b'<!DOCTYPE workbook [<!ENTITY x "payload">]><workbook>&x;</workbook>'
if mode=='traversal':parts['../escape.xml']=b'fixture'
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
 for name,b in parts.items():z.writestr(name,b)
 if mode=='duplicate':z.writestr('xl/media/image1.png',b'duplicate')
 if mode=='bomb':z.writestr('xl/padding.bin',b'0'*(2*1024*1024))
 if mode=='too-many':
  for i in range(4100):z.writestr('padding/'+str(i),b'')
`;

async function fixture(mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-workbook-'));
  const input = path.join(directory, 'source.xlsx');
  await exec(python, ['-c', makeFixture, input, mode]);
  const inspect = async (file = input) => JSON.parse((await exec(python, [script, 'inspect', file])).stdout);
  return { directory, input, inspect, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('读取实际单元格而非错误dimension，保留非标准编号和原文，多接口不提升写入权限', async () => {
  const f = await fixture();
  try {
    const d = await f.inspect();
    assert.equal(d.sheets.length, 1);
    assert.equal(d.imageCount, 1);
    const sheet = d.sheets[0], rows = sheet.rows;
    assert.equal(sheet.headers.length, 19);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r: any) => r.issueId), ['affiliatedDealer', '14', 'VM-008、NV-L006', 'product_enum_dict', '6']);
    assert.equal(rows[0].state, 'pending_retest');
    assert.equal(rows[0].parameters, 'region=NA');
    assert.equal(rows[1].state, 'passed');
    assert.equal(rows[1].sourceStatus, '复测通过');
    assert.equal(rows[1].method, 'GET');
    assert.equal(rows[1].request, 'GET /admin/a\nGET /admin/b');
    assert.equal(rows[2].method, '');
    assert.equal(rows[2].state, 'blocked');
    assert.equal(rows[3].method, '');
    assert.equal(rows[3].path, '');
    assert.equal(rows[4].state, 'passed');
    assert.equal(rows[4].latest, undefined);
    assert.ok(d.warnings.some((s: string) => s.includes('历史记录')));
  } finally { await f.cleanup(); }
});

test('提出人原文和L码完整保留，重复人员表头按主字段优先，辅助别名可兼容', async () => {
  for (const mode of ['normal', 'reporter-primary-last', ...['提出人员', '提出人(人员)', '提出人（人员）'].map(header => `reporter-alias:${header}`)]) {
    const f = await fixture(mode);
    try {
      assert.deepEqual((await f.inspect()).sheets[0].rows.map((row: any) => row.reporter), ['示例用户', 'L_REPORTER_001', '示例成员', '示例用户', '示例成员']);
    } finally { await f.cleanup(); }
  }
});

test('导出回填原行并留存历史，保留其他行/图片/样式字节，结果文本不执行为公式', async () => {
  const f = await fixture();
  try {
    const results = path.join(f.directory, 'results.json'), output = path.join(f.directory, 'out.xlsx');
    const row = { sheet: 0, row: 2, status: 'passed', actual: '=HYPERLINK("https://fixture.test","原文")', expected: '正常显示',
      evidence: ['local/evidence.json'], environment: 'fixture-local', version: 'fixture-sha', checkedAt: '2026-11-04T03:00:00Z', jobId: 'job-1' };
    await fs.writeFile(results, JSON.stringify([row]));
    const result = JSON.parse((await exec(python, [script, 'export', f.input, output, results])).stdout);
    assert.equal(result.resultCount, 1);
    assert.equal(result.sourceRowsPreserved, true);
    const d = await f.inspect(output), actual = d.sheets[0].rows[0];
    assert.equal(d.sheets.length, 1);
    assert.equal(d.sheets[0].rows.length, 5);
    assert.equal(actual.state, 'passed');
    assert.equal(actual.sourceStatus, '复测通过');
    assert.equal(actual.actual, row.actual);
    assert.equal(actual.expected, row.expected);
    assert.ok(actual.notes.includes('旧结果'));
    assert.ok(actual.notes.includes('已修复待复测'));
    assert.ok(actual.notes.includes('应显示选项'));
    assert.ok(actual.notes.includes('local/evidence.json'));
    assert.equal(result.updatedRowCount, 1);
    assert.equal(actual.latest.actual, row.actual);
    assert.equal(actual.latest.jobId, 'job-1');
    const check = await exec(python, ['-c', `import zipfile,sys,json
a,b=map(zipfile.ZipFile,sys.argv[1:])
names=['xl/media/image1.png','xl/drawings/drawing1.xml','xl/styles.xml']
assert all(a.read(n)==b.read(n) for n in names)
from xml.etree import ElementTree as E
import re
pattern=rb'<(?:[A-Za-z_][\\w.-]*:)?row\\b[^>]*>.*?</(?:[A-Za-z_][\\w.-]*:)?row>'
old=re.findall(pattern,a.read('xl/worksheets/sheet1.xml'),re.S)
new=re.findall(pattern,b.read('xl/worksheets/sheet1.xml'),re.S)
assert len(old)==len(new)==6
assert all(before==after for i,(before,after) in enumerate(zip(old,new)) if i!=1)
assert not E.fromstring(b.read('xl/worksheets/sheet1.xml')).findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f')
x=E.fromstring(b.read('xl/worksheets/sheet2.xml'))
assert not x.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f')
assert len(x.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}hyperlink'))==1
print('preserved')`, f.input, output]);
    assert.equal(check.stdout.trim(), 'preserved');
    await fs.writeFile(results, JSON.stringify([{ ...row, status: 'not_run', checkedAt: '2026-11-04T04:00:00Z', actual: '当前未执行', jobId: 'job-2' }]));
    const second = path.join(f.directory, 'out2.xlsx');
    await exec(python, [script, 'export', output, second, results]);
    const reimport = await f.inspect(second);
    assert.equal(reimport.sheets[0].rows[0].state, 'pending_retest');
    assert.equal(reimport.sheets[0].rows[0].sourceStatus, '未执行（待复测）');
    assert.equal(reimport.sheets[0].rows[0].actual, '当前未执行');
    assert.ok(reimport.sheets[0].rows[0].notes.includes(actual.notes));
    assert.equal(reimport.sheets[0].rows[0].latest.jobId, 'job-2');
    assert.equal(reimport.imageCount, 1);
    await assert.rejects(exec(python, [script, 'export', f.input, f.input, results]), /Command failed/);
  } finally { await f.cleanup(); }
});

test('空结果导出明确未执行且不伪造源问题通过，错误结果不生成文件', async () => {
  const f = await fixture();
  try {
    const results = path.join(f.directory, 'results.json'), output = path.join(f.directory, 'not-run.xlsx');
    await fs.writeFile(results, '[]');
    await exec(python, [script, 'export', f.input, output, results]);
    assert.deepEqual((await f.inspect(output)).sheets, (await f.inspect()).sheets);
    await exec(python, ['-c', `import zipfile,sys
b=zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet2.xml')
assert '未执行'.encode() in b
assert '尚无本轮执行结果'.encode() in b
assert b'<hyperlinks' not in b`, output]);
    const bad = path.join(f.directory, 'bad.xlsx');
    await fs.writeFile(results, JSON.stringify([{ sheet: 0, row: 999, status: 'passed' }]));
    await assert.rejects(exec(python, [script, 'export', f.input, bad, results]));
    await assert.rejects(fs.stat(bad));
  } finally { await f.cleanup(); }
});

test('多工作表按关系和原行定位，支持带前缀及自闭合单元格，保持其他sheet与样式属性', async () => {
  const f = await fixture('prefixed-multiple-sheets');
  try {
    const results = path.join(f.directory, 'results.json'), output = path.join(f.directory, 'out.xlsx');
    const result = { sheet: 1, row: 2, status: 'failed', actual: 'L_BACKEND_ERROR\n接口原文 <保持> & 不翻译', expected: '原样字段',
      evidence: ['evidence.json'], environment: 'DEV', version: 'commit', checkedAt: '2026-11-05T03:00:00Z', jobId: 'multi-sheet-job' };
    await fs.writeFile(results, JSON.stringify([result]));
    await exec(python, [script, 'export', f.input, output, results]);
    const imported = await f.inspect(output);
    assert.deepEqual(imported.sheets.map((s: any) => [s.index, s.name]), [[0, '模块一'], [1, '模块二']]);
    assert.equal(imported.sheets[0].rows[0].sourceStatus, '已修复待复测');
    assert.equal(imported.sheets[0].rows[0].actual, '旧结果');
    assert.equal(imported.sheets[1].rows[0].actual, result.actual);
    assert.equal(imported.sheets[1].rows[0].sourceStatus, '复测不通过');
    assert.equal(imported.sheets[1].rows[0].issueId, 'affiliatedDealer');
    await exec(python, ['-c', `import zipfile,sys,re
from xml.etree import ElementTree as E
a,b=map(zipfile.ZipFile,sys.argv[1:]);X='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
for n in ['xl/worksheets/sheet7.xml','xl/styles.xml','xl/media/image1.png','xl/drawings/drawing1.xml']:assert a.read(n)==b.read(n),n
root=E.fromstring(b.read('xl/worksheets/sheet3.xml'))
assert root.find('.//'+X+'c[@r="J2"]').get('s')=='2'
assert root.find('.//'+X+'c[@r="J2"]').get('t')=='inlineStr'
audit=E.fromstring(b.read('xl/worksheets/sheet1.xml'))
assert audit.find('.//'+X+'hyperlink').get('location')=="'模块二'!A2"
`, f.input, output]);
  } finally { await f.cleanup(); }
});

test('重导入相同结果不重复历史或审计页，缺失预期不覆盖原值，旧报告不回滚新结论', async () => {
  const f = await fixture();
  try {
    const results = path.join(f.directory, 'results.json');
    const first = path.join(f.directory, 'first.xlsx'), again = path.join(f.directory, 'again.xlsx');
    const row = { sheet: 0, row: 3, status: 'passed', actual: 'L_RESULT 原样\r\n全部明细',
      evidence: ['evidence.json'], environment: 'DEV', version: 'v1', checkedAt: '2026-11-05T03:00:00Z', jobId: 'history-job-1' };
    const original = (await f.inspect()).sheets[0].rows[1];
    await fs.writeFile(results, JSON.stringify([row]));
    await exec(python, [script, 'export', f.input, first, results]);
    const updated = (await f.inspect(first)).sheets[0].rows[1];
    assert.equal(updated.actual, row.actual);
    assert.equal(updated.expected, original.expected);
    assert.ok(updated.notes.includes(original.notes));
    const repeated = JSON.parse((await exec(python, [script, 'export', first, again, results])).stdout);
    assert.equal(repeated.updatedRowCount, 0);
    assert.equal(repeated.resultSheet, '');
    assert.deepEqual((await f.inspect(again)).sheets, (await f.inspect(first)).sheets);
    await exec(python, ['-c', `import zipfile,sys
a,b=map(zipfile.ZipFile,sys.argv[1:]);assert set(a.namelist())==set(b.namelist());assert all(a.read(n)==b.read(n)for n in a.namelist())`, first, again]);
    const newer = path.join(f.directory, 'newer.xlsx');
    await fs.writeFile(results, JSON.stringify([{ ...row, status: 'blocked', actual: '新的测试条件不满足', expected: '明确的新预期', checkedAt: '2026-11-05T04:00:00Z', jobId: 'history-job-2' }]));
    await exec(python, [script, 'export', again, newer, results]);
    const next = (await f.inspect(newer)).sheets[0].rows[1];
    assert.equal(next.sourceStatus, '暂缓/阻塞');
    assert.equal(next.expected, '明确的新预期');
    assert.ok(next.notes.includes(updated.notes));
    assert.equal(next.notes.split('任务 history-job-1').length - 1, 1);
    assert.equal(next.notes.split('任务 history-job-2').length - 1, 1);
    const stale = path.join(f.directory, 'stale.xlsx');
    await fs.writeFile(results, JSON.stringify([{ ...row, actual: '较早的另一次报告', checkedAt: '2026-11-05T02:00:00Z', jobId: 'stale-job' }]));
    await exec(python, [script, 'export', newer, stale, results]);
    assert.deepEqual((await f.inspect(stale)).sheets, (await f.inspect(newer)).sheets);
    const omitted = path.join(f.directory, 'omitted.xlsx');
    await fs.writeFile(results, JSON.stringify([{ ...row, actual: '后续通过结果', checkedAt: '2026-11-05T05:00:00Z', jobId: 'history-job-3' }]));
    await exec(python, [script, 'export', newer, omitted, results]);
    assert.equal((await f.inspect(omitted)).sheets[0].rows[1].expected, '明确的新预期');
    const cleared = path.join(f.directory, 'cleared.xlsx');
    await fs.writeFile(results, JSON.stringify([{ ...row, expected: '', checkedAt: '2026-11-05T06:00:00Z', jobId: 'history-job-4' }]));
    await exec(python, [script, 'export', omitted, cleared, results]);
    assert.equal((await f.inspect(cleared)).sheets[0].rows[1].expected, '');
  } finally { await f.cleanup(); }
});

test('缺结果列时在全部原单元格之后追加本轮列，原资料和非目标公式完整保留', async () => {
  const f = await fixture('missing-result-columns');
  try {
    const results = path.join(f.directory, 'results.json'), output = path.join(f.directory, 'out.xlsx');
    await fs.writeFile(results, JSON.stringify([{ sheet: 0, row: 2, status: 'failed', actual: '实际原文', expected: '预期原文',
      evidence: [], environment: 'DEV', version: 'v1', checkedAt: '2026-11-05T03:00:00Z', jobId: 'append-columns' }]));
    await exec(python, [script, 'export', f.input, output, results]);
    const imported = await f.inspect(output), row = imported.sheets[0].rows[0];
    assert.deepEqual(imported.sheets[0].headers.slice(26), ['本轮状态', '本轮实际结果', '本轮预期结果', '本轮复测记录']);
    assert.equal(row.sourceStatus, '复测不通过');
    assert.equal(row.actual, '实际原文');
    assert.equal(row.expected, '预期原文');
    await exec(python, ['-c', `import zipfile,sys
from xml.etree import ElementTree as E
a,b=map(zipfile.ZipFile,sys.argv[1:]);X='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
old,new=[E.fromstring(z.read('xl/worksheets/sheet1.xml'))for z in[a,b]]
for cell in old.findall('.//'+X+'c'):
 same=new.find('.//'+X+'c[@r="'+cell.get('r')+'"]');assert E.tostring(cell)==E.tostring(same),cell.get('r')
assert new.find(X+'dimension').get('ref')=='A1:AD7'
for n in ['xl/media/image1.png','xl/drawings/drawing1.xml','xl/styles.xml']:assert a.read(n)==b.read(n)
`, f.input, output]);
  } finally { await f.cleanup(); }
});

test('拒绝重复及越界结果定位，真实未执行结果也必须具备任务和时间', async () => {
  const f = await fixture();
  try {
    const results = path.join(f.directory, 'results.json');
    const valid = { sheet: 0, row: 2, status: 'not_run', actual: '未取得执行结果', evidence: [], environment: 'DEV', version: 'v1',
      checkedAt: '2026-11-05T03:00:00Z', jobId: 'real-not-run' };
    for (const [i, cases] of [[valid, valid], [{ ...valid, sheet: 1 }], [{ ...valid, row: 1 }],
      [{ ...valid, jobId: '' }], [{ ...valid, checkedAt: '' }], [{ ...valid, sheet: false }]].entries()) {
      const output = path.join(f.directory, `invalid-${i}.xlsx`);
      await fs.writeFile(results, JSON.stringify(cases));
      await assert.rejects(exec(python, [script, 'export', f.input, output, results]));
      await assert.rejects(fs.stat(output));
    }
  } finally { await f.cleanup(); }
});

test('未知状态待确认，明确待测试才分类待测试', async () => {
  for (const [mode, expected] of [['unknown-status', 'unclassified'], ['pending-test', 'pending_test']]) {
    const f = await fixture(mode);
    try { assert.equal((await f.inspect()).sheets[0].rows[0].state, expected); }
    finally { await f.cleanup(); }
  }
});

test('明确状态优先于历史备注，状态缺失时才用有日期的结论', async () => {
  const conflict = await fixture('status-conflicts'), fallback = await fixture('notes-fallback');
  try {
    const rows = (await conflict.inspect()).sheets[0].rows;
    assert.deepEqual(rows.map((row: any) => row.state), ['passed', 'pending_retest', 'pending_retest', 'blocked', 'pending_test']);
    assert.equal(rows[0].sourceStatus, '复测通过');
    assert.equal(rows[0].notes, '2026-10-29 复测结果：复测不通过');
    assert.equal((await fallback.inspect()).sheets[0].rows[1].state, 'pending_retest');
  } finally { await conflict.cleanup(); await fallback.cleanup(); }
});

test('一项执行结果与其余空时间未执行行可导出，空时间不会覆盖已有更新结果', async () => {
  const f = await fixture();
  try {
    const results = path.join(f.directory, 'mixed-results.json'), output = path.join(f.directory, 'mixed.xlsx');
    const notRun = { status: 'not_run', actual: '本轮未执行，原文档历史记录保留', checkedAt: '', jobId: '', environment: '', version: '', evidence: [] };
    const rows = (await f.inspect()).sheets[0].rows;
    const executed = { ...notRun, status: 'passed', actual: 'fixture 请求通过', checkedAt: '2026-11-04T03:00:00Z', jobId: 'fixture-executed-job' };
    await fs.writeFile(results, JSON.stringify(rows.map((row: any, i: number) => ({ sheet: 0, row: row.row, ...(i === 0 ? executed : notRun) }))));
    await exec(python, [script, 'export', f.input, output, results]);
    const imported = await f.inspect(output);
    assert.equal(imported.sheets[0].rows[0].latest.status, 'passed');
    for (const row of imported.sheets[0].rows.slice(1)) {
      assert.equal(row.latest.status, 'not_run');
      assert.equal(row.latest.checkedAt, '');
      assert.equal(row.state, rows.find((source: any) => source.row === row.row).state, '未执行占位不能改变原分类');
    }
    await fs.writeFile(results, JSON.stringify(rows.map((row: any) => ({ sheet: 0, row: row.row, ...notRun }))));
    const second = path.join(f.directory, 'mixed-again.xlsx');
    await exec(python, [script, 'export', output, second, results]);
    const retained = (await f.inspect(second)).sheets[0].rows[0];
    assert.equal(retained.latest.status, 'passed');
    assert.equal(retained.latest.checkedAt, executed.checkedAt);
    assert.equal(retained.latest.jobId, executed.jobId);
    const failed = { ...executed, sheet: 0, row: rows[1].row, status: 'failed', actual: '真实后继失败', jobId: 'fixture-failed-job' };
    await fs.writeFile(results, JSON.stringify([failed]));
    const failedOutput = path.join(f.directory, 'failed.xlsx');
    await exec(python, [script, 'export', f.input, failedOutput, results]);
    const failedRow = (await f.inspect(failedOutput)).sheets[0].rows[1];
    assert.equal(failedRow.sourceStatus, '复测不通过');
    assert.equal(failedRow.state, 'pending_retest', '真实后继失败仍需复测');
    assert.equal(failedRow.latest.status, 'failed');
    await fs.writeFile(results, JSON.stringify([{ sheet: 0, row: 2, ...executed, checkedAt: '' }]));
    await assert.rejects(exec(python, [script, 'export', f.input, path.join(f.directory, 'missing-time.xlsx'), results]));
    await fs.writeFile(results, JSON.stringify([{ sheet: 0, row: 2, ...executed, jobId: '' }]));
    await assert.rejects(exec(python, [script, 'export', f.input, path.join(f.directory, 'missing-job.xlsx'), results]));
  } finally { await f.cleanup(); }
});

test('拒绝ZIP危险/重复路径、炸弹、超量条目、宏、外部关系和XML实体', async () => {
  for (const mode of ['traversal', 'duplicate', 'bomb', 'too-many', 'macro', 'external', 'entity']) {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.inspect(), (error: any) => {
        assert.ok(error.stdout.includes('error'), mode);
        assert.equal(error.stdout.includes('Traceback'), false);
        return true;
      });
    } finally { await f.cleanup(); }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createOverseasRequirementRoutes, createOverseasRequirements } from '../server/overseas-requirements.js';
import { emptyOverseasRequirement, filterOverseasRequirements, mergeOverseasRequirements, overseasRequirementFromJira, overseasRequirementPayload, overseasRequirementSaveSchema } from '../shared/overseas-requirements.js';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development.js';
import type { JiraIssue } from '../shared/hub.js';
import { validateStateJson } from '../server/state-backup.js';

const input = (title = '新增支付方式') => ({ ...overseasRequirementPayload(emptyOverseasRequirement(randomUUID())), title });
async function fixture(t: test.TestContext, hasExecution?: (id: string) => boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overseas-requirements-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, service: await createOverseasRequirements(directory, hasExecution) };
}

test('需求和跨系统证据可重载，接口文案包括 L 码与空白原样保存', async t => {
  const { directory, service } = await fixture(t);
  const value = { ...input(' L_PAY_033 '), jiraStatus: ' L_STATUS_01 ', description: '  返回的原始正文\n', systems: [
    { name: 'APEX', status: 'passed', evidence: '商家配置页面实际验证', previewUrl: 'http://localhost:8080/merchant' },
    { name: 'App', status: 'verification', evidence: '仍需验证支付流程', previewUrl: '' },
  ], i18n: { status: 'in_progress', evidence: 'tempdocs/i18n-import.xlsx，待导入' } };
  const saved = await service.save(value);
  assert.equal(saved.title, value.title); assert.equal(saved.jiraStatus, value.jiraStatus); assert.equal(saved.description, value.description);
  assert.equal(saved.revision, 1); assert.equal(saved.systems[1].status, 'verification');
  assert.deepEqual((await createOverseasRequirements(directory)).list(), [saved]);
  const detached = service.list(); detached[0].systems[0].evidence = '不能污染原记录';
  assert.equal(service.list()[0].systems[0].evidence, value.systems[0].evidence);
  assert.equal((await fs.stat(path.join(directory, 'requirements.json'))).mode & 0o777, 0o600);
});

test('并发新增不丢数据，同版本并发修改和重复关联不会覆盖已有需求', async t => {
  const { directory, service } = await fixture(t);
  const executionId = randomUUID();
  const [first] = await Promise.all([service.save({ ...input(), executionIds: [executionId] }), service.save(input('第二条需求'))]);
  const edits = await Promise.allSettled(['第一份编辑', '第二份编辑'].map(title => service.save({ ...overseasRequirementPayload(first), title })));
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  assert.match((edits.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message, /已被更新/);
  await assert.rejects(service.save({ ...input(), executionIds: [executionId] }), /已关联其他需求/);
  const items = (await createOverseasRequirements(directory)).list();
  assert.equal(items.length, 2); assert.equal(items.find(item => item.id === first.id)?.revision, 2);
});

test('已验证、语言就绪和已验收需要对应证据，日期和预览链接遵守契约', () => {
  const value = input();
  for (const override of [
    { title: '   ' }, { endDate: '2026-02-30' }, { startDate: '2026-11-09', endDate: '2026-11-08' },
    { systems: [{ name: 'APEX', status: 'passed', evidence: '  ', previewUrl: '' }] },
    { i18n: { status: 'ready', evidence: '' } }, { stage: 'accepted' },
    { prdUrl: 'javascript:alert(1)' }, { prototypeUrl: 'https://user:secret@example.com' },
  ]) assert.equal(overseasRequirementSaveSchema.safeParse({ ...value, ...override }).success, false);
  const accepted = { ...value, stage: 'accepted', acceptanceEvidence: '人工核对全部场景并验收', i18n: { status: 'ready', evidence: '已导入并验证' },
    systems: [{ name: 'APEX', status: 'passed', evidence: '浏览器验证结果', previewUrl: '' }] };
  assert.equal(overseasRequirementSaveSchema.safeParse(accepted).success, true);
  assert.equal(overseasRequirementSaveSchema.safeParse({ ...accepted, blocker: '等待接口' }).success, false);
  assert.equal(overseasRequirementSaveSchema.safeParse({ ...accepted, systems: [...accepted.systems, { name: 'PC', status: 'pending', evidence: '', previewUrl: '' }] }).success, false);
});

test('历史执行进入台账且不推断业务验收，登记后按关联标识去重', async t => {
  const id = randomUUID();
  const legacyId = randomUUID();
  const { directory, service } = await fixture(t, value => value === id || value === legacyId);
  const record: RequirementDevelopmentRecord = { id, status: 'started', runStatus: 'completed', runId: randomUUID(), workspacePath: '/repo/web', headSha: 'abc', error: '', createdAt: '2026-11-05T00:00:00.000Z',
    input: { title: ' L_SOURCE_TITLE ', issueKey: 'https://jira.example.com/browse/APEX-602', prdUrl: '', requirement: '按确认原型实现', project: 'APEX', fixVersion: 'v1', assignee: '', startDate: '', endDate: '', repository: '', parentDirectory: '', branch: 'feature/APEX-602', confluenceParentUrl: '' } };
  const merged = mergeOverseasRequirements([], [record]);
  assert.equal(merged[0].title, record.input.title); assert.equal(merged[0].stage, 'unconfirmed'); assert.equal(merged[0].issueKey, 'APEX-602');
  assert.equal(merged[0].acceptanceEvidence, ''); assert.deepEqual(merged[0].systems, []);
  const saved = await service.save({ ...overseasRequirementPayload(merged[0]), id: randomUUID(), systems: [{ name: 'APEX', status: 'pending', evidence: '', previewUrl: '' }], blocker: '等待接口', owner: '张三', version: 'v1' });
  assert.equal(mergeOverseasRequirements([saved], [record]).length, 1);
  const filter = { search: 'l_source', system: 'APEX', stage: 'blocked', owner: '张三', version: 'v1' };
  assert.equal(filterOverseasRequirements([saved], filter).length, 1);
  assert.equal(filterOverseasRequirements([saved], { ...filter, system: 'PC' }).length, 0);

  await assert.rejects(service.remove({ id: saved.id, expectedRevision: 0 }), /需求已被更新/);
  await assert.rejects(service.remove({ id, expectedRevision: 0 }), /已不在列表/);
  await service.remove({ id: saved.id, expectedRevision: saved.revision });
  await service.remove({ id: legacyId, expectedRevision: 0 });
  await service.remove({ id: legacyId, expectedRevision: 0 });
  await assert.rejects(service.save(overseasRequirementPayload({ ...merged[0], id: legacyId })), /需求已被更新/);
  const reopened = await createOverseasRequirements(directory);
  assert.deepEqual(mergeOverseasRequirements(reopened.list(), [record, { ...record, id: legacyId }], reopened.removedIds()), []);
  assert.deepEqual(reopened.systems(), ['APEX']);
});

test('损坏文件和符号链接不能被空台账或新写入覆盖', async t => {
  const { directory, service } = await fixture(t);
  await service.save(input());
  const file = path.join(directory, 'requirements.json'), outside = path.join(directory, 'outside.json');
  await fs.writeFile(outside, '保留原文'); await fs.rm(file); await fs.symlink(outside, file);
  await assert.rejects(createOverseasRequirements(directory), /普通文件/);
  await assert.rejects(service.save(input()), /普通文件/);
  assert.equal(await fs.readFile(outside, 'utf8'), '保留原文');
  await fs.rm(file); await fs.writeFile(file, '{"version":1,"items":[{}]}');
  await assert.rejects(createOverseasRequirements(directory), /读取失败/);
});

test('本机 HTTP 读写校验来源，保存失败和版本冲突有明确响应', async t => {
  const { service } = await fixture(t);
  let port = 0;
  const io = { get port() { return port; },
    json(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); },
    async body(request: http.IncomingMessage, limit = 150000) { let text = ''; for await (const chunk of request) { text += chunk; if (text.length > limit) throw new Error('请求过大'); } return JSON.parse(text); },
  };
  const route = createOverseasRequirementRoutes(service, io);
  const server = http.createServer(async (request, response) => { if (!await route(request, response, new URL(request.url!, `http://127.0.0.1:${port}`))) io.json(response, 404, {}); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${port}`, url = origin + '/api/overseas-requirements';
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' };
  const post = (value: unknown, override = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(value) });
  assert.deepEqual(await (await fetch(url)).json(), { items: [], systems: [], removedIds: [] });
  for (const override of [{ Origin: 'https://example.com' }, { Origin: '' }, { 'X-Delivery-Confirmed': '' }]) assert.equal((await post(input(), override)).status, 403);
  assert.equal((await post(input(), { 'Content-Type': 'text/plain' })).status, 415);
  const value = input(); assert.equal((await post(value)).status, 200); assert.equal((await post(value)).status, 409);
  assert.equal((await post({ ...input(), stage: 'accepted' })).status, 400);
  assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 405);
  const systemResponse = await fetch(url + '/systems', { method: 'POST', headers, body: JSON.stringify({ name: '其他业务系统' }) });
  assert.equal(systemResponse.status, 200); assert.deepEqual(await systemResponse.json(), { systems: ['其他业务系统'] });
  assert.equal(service.list().length, 1);
  const remove = (origin = headers.Origin) => fetch(url + '/delete', { method: 'POST', headers: { ...headers, Origin: origin },
    body: JSON.stringify({ id: value.id, expectedRevision: 1 }) });
  assert.equal((await remove('https://example.com')).status, 403);
  assert.deepEqual(await (await remove()).json(), { deleted: true, removedIds: [value.id] });
  assert.deepEqual(await (await fetch(url)).json(), { items: [], systems: ['其他业务系统'], removedIds: [value.id] });
});

test('业务系统由用户扩展并持久化，不固定为三个系统；旧格式自动兼容', async t => {
  const { directory, service } = await fixture(t);
  for (const name of ['APEX', 'PC', 'App', 'OPAY', '商家门户', '多语言平台']) await service.addSystem({ name });
  await service.addSystem({ name: 'apex' });
  assert.equal(service.systems().length, 6);
  assert.deepEqual((await createOverseasRequirements(directory)).systems(), service.systems());
  await assert.rejects(service.addSystem({ name: '' }));
  const legacy = { version: 1, items: [await service.save(input())] };
  await fs.writeFile(path.join(directory, 'requirements.json'), JSON.stringify(legacy));
  assert.deepEqual((await createOverseasRequirements(directory)).systems(), []);
  validateStateJson('overseas-requirements/requirements.json', legacy);
  assert.throws(() => validateStateJson('overseas-requirements/requirements.json', { version: 1, items: [{}] }));
});

test('未启动开发的 Jira 事项也可进入台账，保留原字段并阻止重复导入', async t => {
  const { service } = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const issue = { key: `DEMO-${index}`, url: `https://jira.example.test/browse/DEMO-${index}`, summary: ` L_REQUIREMENT_${index} `,
      description: ' L_DESCRIPTION ', status: 'L_STATUS', assignee: 'L_USER', fixVersions: ['L_VERSION'], startDate: '2026-11-05',
      endDate: null, dueDate: null } as JiraIssue;
    const item = overseasRequirementFromJira(issue, randomUUID(), ['自定义业务系统']);
    const saved = await service.save(overseasRequirementPayload(item));
    assert.equal(saved.title, issue.summary); assert.equal(saved.jiraStatus, issue.status); assert.equal(saved.owner, issue.assignee);
    assert.equal(saved.stage, 'unconfirmed'); assert.deepEqual(saved.executionIds, []);
    await assert.rejects(service.save(overseasRequirementPayload({ ...item, id: randomUUID() })), /已在需求台账/);
  }
  assert.equal(mergeOverseasRequirements(service.list(), []).length, 5);
});

test('外部接续群聊可关联已有 Jira 需求并重载，旧客户端编辑保留关联', async t => {
  const { directory, service } = await fixture(t);
  const original = await service.save({ ...input(' L_OFFLINE_REQUIREMENT '), issueUrl: 'https://jira.example.test/browse/OPAY-700' });
  const groupRoomId = randomUUID();
  await assert.rejects(service.save({ ...input(), issueUrl: original.issueUrl, groupRoomIds: [groupRoomId] }), /已在需求台账/);
  const linked = await service.save({ ...overseasRequirementPayload(original), groupRoomIds: [groupRoomId] });
  assert.equal(linked.id, original.id); assert.equal(linked.revision, 2); assert.equal(linked.stage, original.stage);
  assert.deepEqual(linked.executionIds, []); assert.equal(service.list().length, 1);
  assert.deepEqual((await createOverseasRequirements(directory)).list()[0].groupRoomIds, [groupRoomId]);
  const { groupRoomIds: _groups, ...oldClientPayload } = overseasRequirementPayload(linked);
  const edited = await service.save({ ...oldClientPayload, title: ' L_UPDATED_TITLE ' });
  assert.deepEqual(edited.groupRoomIds, [groupRoomId]);
  assert.equal(edited.title, ' L_UPDATED_TITLE ');
  await assert.rejects(service.save({ ...input(), groupRoomIds: [groupRoomId] }), /团队群聊已关联其他需求/);
  for (const ids of [[groupRoomId, groupRoomId], ['not-a-room-uuid']]) {
    assert.equal(overseasRequirementSaveSchema.safeParse({ ...input(), groupRoomIds: ids }).success, false);
  }
  validateStateJson('overseas-requirements/requirements.json', { version: 1, items: [edited] });
  assert.throws(() => validateStateJson('overseas-requirements/requirements.json', {
    version: 1, items: [edited, { ...edited, id: randomUUID(), issueUrl: '' }],
  }), /状态结构校验失败/);
  const detached = await service.save({ ...overseasRequirementPayload(edited), groupRoomIds: [] });
  assert.deepEqual(detached.groupRoomIds, []);
});

test('旧台账不含群聊字段仍可读取，不将历史记录自动归到任何群聊', async t => {
  const { directory, service } = await fixture(t);
  const saved = await service.save(input());
  const { groupRoomIds: _groups, ...legacy } = saved;
  await fs.writeFile(path.join(directory, 'requirements.json'), JSON.stringify({ version: 1, items: [legacy] }));
  validateStateJson('overseas-requirements/requirements.json', { version: 1, items: [legacy] });
  const restored = (await createOverseasRequirements(directory)).list()[0];
  assert.deepEqual(restored.groupRoomIds, []);
  assert.equal(restored.id, saved.id); assert.equal(restored.stage, saved.stage);
});

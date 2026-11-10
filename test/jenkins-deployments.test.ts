import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectsData } from '../shared/hub.js';
import { createJenkinsDeployments } from '../server/jenkins-deployments.js';
import { buildFromUrl, createJenkinsClient, jenkinsBaseUrl, jenkinsJobPath, queueFromLocation, redactJenkins } from '../server/jenkins-client.js';

const baseUrl = 'https://jenkins.example.test';
const username = 'operator';
const token = 'private-api-token-for-fixture';
const jobName = 'frontend/translation test';
const jobPath = '/job/frontend/job/translation%20test';
const projectId = 'gitlab.example.test:frontend/translation';
const projects = [{ projectId, displayName: '多语言管理', suggestedDisplayName: '', projectName: 'translation', repository: 'frontend/translation', path: '/repos/a', branch: 'test' },
  { projectId, displayName: '多语言管理', suggestedDisplayName: '', projectName: 'translation', repository: 'frontend/translation', path: '/repos/b', branch: 'prod' }] as ProjectsData['projects'];
const job = { fullName: jobName, name: 'translation test', buildable: true, property: [{ parameterDefinitions: [
  { name: 'branch', type: 'StringParameterDefinition', defaultParameterValue: { value: 'test' } },
  { name: 'clean', type: 'BooleanParameterDefinition', defaultParameterValue: { value: false } },
  { name: 'region', type: 'ChoiceParameterDefinition', choices: ['cn', 'us'], defaultParameterValue: { value: 'cn' } },
  { name: 'password', type: 'PasswordParameterDefinition', defaultParameterValue: { value: 'never-return-this' } },
] }] };
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { status: 200, ...init });

test('日志脱敏覆盖任务脚本 curl 用户认证和机器人 key，保留正常文案、域名及普通查询', () => {
  const authValues = ['fixture-user:plain-fixture-password', 'fixture-user:double quoted fixture', 'fixture-user:single quoted fixture',
    'fixture-user:equals-fixture', 'fixture-user:attached-fixture'];
  const lines = [
    `+ curl -u ${authValues[0]} -X POST https://example.test/build`,
    `+ curl --request POST --user "${authValues[1]}" https://example.test/build`,
    `+ curl --user='${authValues[2]}' https://example.test/build`,
    `+ curl -u=${authValues[3]} --user=${authValues[0]} https://example.test/build`,
    `+ curl -u${authValues[4]} https://example.test/build`,
    '+ curl \\\n  --user "fixture-user:continued-fixture" https://example.test/build',
    "+ curl -X POST 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=robot-fixture-secret'",
    'https://example.test/path?access_token=access-fixture&api_key=api-fixture&password=password-fixture&signature=signature-fixture&page=2&branch=test',
    'https://url-fixture-user:p%40ssword-fixture@example.test/path?mode=normal',
    '构建完成，返回文案 L_000001；https://example.test/path?page=2&branch=test&name=a%20b；普通参数 -u unchanged',
  ];
  const output = redactJenkins(lines.join('\n'), { baseUrl, username, token });
  for (const secret of [...authValues, 'continued-fixture', 'robot-fixture-secret', 'access-fixture', 'api-fixture', 'password-fixture',
    'signature-fixture', 'url-fixture-user', 'p%40ssword-fixture']) assert.equal(output.includes(secret), false, `假凭据应已隐藏: ${secret}`);
  assert.match(output, /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=\[凭据已隐藏\]/);
  assert.equal(output.includes('https://example.test/path?page=2&branch=test&name=a%20b'), true);
  assert.equal(output.includes('构建完成，返回文案 L_000001'), true);
  assert.equal(output.includes('普通参数 -u unchanged'), true);
});

test('敏感 URL 查询名不区分大小写且支持编码字段，普通查询逐字保留', () => {
  const input = 'https://example.test/p?TOKEN=t-fixture&access%5Ftoken=a-fixture&apiKey=k-fixture&X-Amz-Signature=s-fixture'
    + '&secret=secret-fixture&client_secret=client-fixture&key=first-fixture&key=second-fixture&monkey=normal&path=%2Fa%3Fx%3D1';
  const output = redactJenkins(input, { baseUrl, username, token });
  for (const secret of ['t-fixture', 'a-fixture', 'k-fixture', 's-fixture', 'secret-fixture', 'client-fixture', 'first-fixture', 'second-fixture']) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(output.endsWith('&monkey=normal&path=%2Fa%3Fx%3D1'), true);
  assert.equal(redactJenkins('https://example.test/path?page=3&branch=test#section', { baseUrl, username, token }), 'https://example.test/path?page=3&branch=test#section');
  const fakeApiToken = '11' + 'a'.repeat(32);
  assert.equal(redactJenkins(`示例 Token ${fakeApiToken}，构建成功`, { baseUrl, username, token }), '示例 Token [凭据已隐藏]，构建成功');
});
async function fixture(pollIntervalMs = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-jenkins-test-'));
  const credentialsPath = path.join(directory, 'credentials', 'jenkins.json');
  const requests: { url: string; init?: RequestInit }[] = [];
  let result = 'SUCCESS', building: unknown = false, mismatch = false, cancelled = false, interrupted = false, oversize = false, offset: string | null = '987';
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    assert.equal(new URL(url).origin, baseUrl);
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`);
    if (init?.method === 'POST') {
      if (interrupted) throw new Error(`network contains ${token}`);
      return new Response('', { status: 201, headers: { location: 'http://internal-jenkins:8080/queue/item/81/' } });
    }
    const pathname = new URL(url).pathname;
    if (pathname === `${jobPath}/api/json`) return json(job);
    if (pathname === '/api/json') return json({ jobs: [{ name: 'frontend', fullName: 'frontend' }] });
    if (pathname === '/job/frontend/api/json') return json({ fullName: 'frontend', jobs: [{ name: 'translation test', fullName: jobName }] });
    if (pathname === '/queue/item/81/api/json') return json({ id: 81, cancelled, executable: cancelled ? undefined : { number: 12, url: `http://internal-jenkins:8080${jobPath}/12/` } });
    if (pathname === `${jobPath}/12/api/json`) return json({ number: 12, queueId: mismatch ? 82 : 81, result, building,
      url: `http://internal-jenkins:8080${jobPath}/12/` });
    if (pathname === `${jobPath}/12/logText/progressiveText`) return new Response(`中文日志 ${token} Basic ${Buffer.from(`${username}:${token}`).toString('base64')} password-value <script>raw</script>`, {
      headers: { ...(offset === null ? {} : { 'x-text-size': offset }), 'x-more-data': 'true', ...(oversize ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}) },
    });
    throw new Error(`unexpected mock path ${pathname}`);
  };
  const options = { readProjects: async () => ({ projects }), credentialsPath, fetcher, pollIntervalMs };
  const service = await createJenkinsDeployments(directory, options);
  await service.saveConfig({ baseUrl, username, token });
  const binding = await service.saveBinding({ projectId, environment: '测试', jobFullName: jobName });
  return { directory, credentialsPath, service, options, binding, requests,
    set: (value: { result?: string; building?: unknown; mismatch?: boolean; cancelled?: boolean; interrupted?: boolean; oversize?: boolean; offset?: string | null }) => {
      result = value.result ?? result; if ('building' in value) building = value.building; mismatch = value.mismatch ?? mismatch;
      cancelled = value.cancelled ?? cancelled; interrupted = value.interrupted ?? interrupted; oversize = value.oversize ?? oversize;
      if ('offset' in value) offset = value.offset!;
    },
    start: (requestId = randomUUID(), acknowledgeUnknown = false) => service.startRun({ bindingId: binding.id, requestId,
      parameters: { branch: 'test', clean: true, region: 'cn', password: 'password-value' }, acknowledgeUnknown }),
    close: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('配置只公开 hasToken，空 Token 保留原值，凭据私有权限，工作区按项目去重，目录递归参数不泄漏密码默认值', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.saveConfig({ baseUrl: baseUrl + '/', username, token: '' }), { baseUrl, username, hasToken: true });
    const dashboard = await f.service.snapshot();
    assert.equal(JSON.stringify(dashboard).includes(token), false);
    await assert.rejects(f.service.saveConfig({ baseUrl: 'https://other.example.test', username, token: '' }), /先解除现有流水线关联/);
    await assert.rejects(f.service.saveConfig({ baseUrl, username: 'different' }), /必须重新输入/);
    assert.deepEqual(dashboard.projects[0]?.paths, ['/repos/a', '/repos/b']);
    assert.deepEqual(dashboard.projects[0]?.branches, ['test', 'prod']);
    assert.equal(dashboard.projects.length, 1);
    assert.equal((await fs.stat(f.credentialsPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(f.credentialsPath))).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await fs.readFile(f.credentialsPath, 'utf8')).token, token);
    const jobs = await f.service.jobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.fullName, jobName);
    assert.deepEqual(jobs[0]?.parameters.map(item => item.type), ['string', 'boolean', 'choice', 'password']);
    assert.equal(jobs[0]?.parameters.find(item => item.type === 'password')?.defaultValue, undefined);
    assert.equal(JSON.stringify(jobs).includes('never-return-this'), false);
    assert.equal((await f.service.checkConnection()).message.includes('未触发构建'), true);
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 0);
  } finally { await f.close(); }
});

test('已有项目关联时禁止切换 Jenkins origin，解除关联后仍须提供新凭据', async () => {
  const f = await fixture();
  try {
    const other = 'https://other.example.test';
    await assert.rejects(f.service.saveConfig({ baseUrl: other, username, token: 'new-private-token' }), /先解除现有流水线关联/);
    assert.equal((await f.service.snapshot()).config.baseUrl, baseUrl);
    await f.service.deleteBinding({ id: f.binding.id });
    await assert.rejects(f.service.saveConfig({ baseUrl: other, username }), /必须重新输入/);
    assert.deepEqual(await f.service.saveConfig({ baseUrl: other, username, token: 'new-private-token' }), { baseUrl: other, username, hasToken: true });
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 0);
  } finally { await f.close(); }
});

test('手动添加解析当前 Jenkins 地址、保持幂等和自定义环境，仅做读取校验', async () => {
  const f = await fixture();
  try {
    const input = { projectId, environment: '预发验证', url: `${baseUrl}${jobPath}/` };
    const saved = await f.service.saveManualBinding(input);
    assert.equal(saved.jobFullName, jobName);
    assert.equal(saved.environment, '预发验证');
    assert.deepEqual(await f.service.saveManualBinding(input), saved);
    assert.equal((await f.service.snapshot()).bindings.length, 2);
    const count = f.requests.length;
    for (const url of [`https://evil.test${jobPath}`, `${baseUrl}${jobPath}/12/`, `${baseUrl}${jobPath}?token=fixture`,
      `${baseUrl}/job/a%2Fb/`, `${baseUrl}/job/../job/translation%20test/`, `https://name:secret@jenkins.example.test${jobPath}`]) {
      await assert.rejects(f.service.saveManualBinding({ ...input, url }));
    }
    assert.equal(f.requests.length, count);
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 0);
    assert.equal((await f.service.snapshot()).runs.length, 0);
  } finally { await f.close(); }
});

test('缺少或非法 building 字段时即使 result 为 SUCCESS 也不能完成或变绿', async () => {
  for (const building of [undefined, null, 'false', 0]) {
    const f = await fixture();
    try {
      f.set({ building });
      const run = await f.start();
      const checked = await f.service.getRun(run.id);
      assert.equal(checked.status, 'queued');
      assert.match(checked.error!, /明确的构建完成状态/);
    } finally { await f.close(); }
  }
});

test('根列表已含参数元数据时单次读取全部叶任务，禁用任务不会出现在可部署列表', async () => {
  let calls = 0;
  const client = createJenkinsClient({ baseUrl, username, token }, async () => {
    calls++;
    return json({ jobs: [job, { name: 'disabled', fullName: 'disabled', buildable: false }] });
  });
  // 根目录名称必须是单段，完整的文件夹目录由 children 提供。
  const direct = { ...job, name: 'translation test', fullName: 'translation test' };
  const optimized = createJenkinsClient({ baseUrl, username, token }, async () => { calls++; return json({ jobs: [direct, { name: 'disabled', fullName: 'disabled', buildable: false }] }); });
  const jobs = await optimized.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.parameters.length, 4);
  assert.equal(calls, 1);
  await assert.rejects(client.jobs(), /任务目录不匹配/);
});

test('单次 POST 返回排队并精确跟踪 build，内部 URL 改回固定 HTTPS；只 SUCCESS 为成功', async () => {
  const f = await fixture();
  try {
    const queued = await f.start();
    assert.equal(queued.status, 'queued');
    assert.equal(queued.queueId, 81);
    const posts = f.requests.filter(item => item.init?.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.url, `${baseUrl}${jobPath}/buildWithParameters`);
    assert.equal(new URLSearchParams(String(posts[0]?.init?.body)).get('clean'), 'true');
    f.set({ building: true });
    const running = await f.service.getRun(queued.id);
    assert.equal(running.status, 'running');
    assert.equal(running.buildUrl, `${baseUrl}${jobPath}/12/`);
    f.set({ building: false });
    assert.equal((await f.service.getRun(queued.id)).status, 'success');
    for (const [result, expected] of [['FAILURE', 'failed'], ['UNSTABLE', 'failed'], ['ABORTED', 'cancelled']]) {
      f.set({ result });
      const run = await f.start();
      assert.equal((await f.service.getRun(run.id)).status, expected);
    }
    assert.equal((await fs.readFile(path.join(f.directory, 'jenkins-deployments.json'), 'utf8')).includes('password-value'), false);
  } finally { await f.close(); }
});

test('重复 requestId 幂等、活跃关联禁止重复，构建 queueId 不匹配不能显示成功', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    const [one, two] = await Promise.all([f.start(requestId), f.start(requestId)]);
    assert.equal(one.id, two.id);
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 1);
    await assert.rejects(f.start(), /已有部署排队或运行/);
    await assert.rejects(f.service.saveConfig({ baseUrl: 'https://other.example.test', username }), /暂不能切换/);
    await assert.rejects(f.service.deleteBinding({ id: f.binding.id }), /排队或运行/);
    f.set({ mismatch: true });
    const mismatch = await f.service.getRun(one.id);
    assert.equal(mismatch.status, 'queued');
    assert.match(mismatch.error!, /未匹配本次排队编号/);
    assert.equal(f.service.isIdle(), false);
  } finally { await f.close(); }
});

test('提交中断记为 unknown，不自动重发；确认后新请求可人工重新发起', async () => {
  const f = await fixture();
  try {
    f.set({ interrupted: true });
    const requestId = randomUUID();
    const unknown = await f.start(requestId);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.error?.includes(token), false);
    assert.equal((await f.start(requestId)).id, unknown.id);
    await assert.rejects(f.start(), /提交结果待确认/);
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 1);
    f.set({ interrupted: false });
    assert.equal((await f.start(randomUUID(), true)).status, 'queued');
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 2);
  } finally { await f.close(); }
});

test('重启 dispatching 转 unknown 且不重发，queued 恢复精确查询，取消排队显示取消', async () => {
  const f = await fixture();
  try {
    const queued = await f.start();
    await f.service.close();
    let resumed = await createJenkinsDeployments(f.directory, f.options);
    f.set({ cancelled: true });
    assert.equal((await resumed.getRun(queued.id)).status, 'cancelled');
    await resumed.close();
    const filename = path.join(f.directory, 'jenkins-deployments.json');
    const data = JSON.parse(await fs.readFile(filename, 'utf8'));
    data.runs[0].status = 'dispatching';
    await fs.writeFile(filename, JSON.stringify(data));
    resumed = await createJenkinsDeployments(f.directory, f.options);
    assert.equal((await resumed.getRun(queued.id)).status, 'unknown');
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 1);
    await resumed.close();
  } finally { await f.close(); }
});

test('无需页面读取也自动跟踪部署，恢复中的排队记录完成后释放闲置状态，关闭后停止轮询', async () => {
  const f = await fixture();
  let resumed: Awaited<ReturnType<typeof createJenkinsDeployments>> | undefined;
  try {
    const queued = await f.start();
    assert.equal(f.service.isIdle(), false);
    await f.service.close();
    resumed = await createJenkinsDeployments(f.directory, { ...f.options, pollIntervalMs: 5 });
    const deadline = Date.now() + 2000;
    while (!resumed.isIdle() && Date.now() < deadline) await delay(5);
    assert.equal(resumed.isIdle(), true);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'jenkins-deployments.json'), 'utf8'));
    assert.equal(saved.runs.find((run: { id: string }) => run.id === queued.id).status, 'success');
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 1);
    await resumed.close();
    const count = f.requests.length;
    await delay(20);
    assert.equal(f.requests.length, count);
  } finally { await resumed?.close(); await f.close(); }
});

test('增量日志使用 Jenkins 字节偏移、保留纯文本并屏蔽 token/basic/密码；超大响应不假推进', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    const log = await f.service.log(run.id, 7);
    assert.equal(log.nextOffset, 987);
    assert.equal(log.moreData, true);
    assert.equal(log.text.includes(token), false);
    assert.equal(log.text.includes(Buffer.from(`${username}:${token}`).toString('base64')), false);
    assert.equal(log.text.includes('password-value'), false);
    assert.equal(log.text.includes('<script>raw</script>'), true);
    assert.equal(f.requests.at(-1)?.url.endsWith('progressiveText?start=7'), true);
    f.set({ oversize: true });
    await assert.rejects(f.service.log(run.id, 987), /超过 2 MB，偏移未推进/);
    await assert.rejects(f.service.log(run.id, -1), /非负整数/);
  } finally { await f.close(); }
});

test('HTTPS origin 和任务路径校验，响应只接受严格 queue/build 路径，重定向无第二次请求', async () => {
  for (const value of ['http://jenkins.test', 'https://user:password@jenkins.test/', 'https://jenkins.test/sub', 'https://jenkins.test/?token=x']) {
    assert.throws(() => jenkinsBaseUrl(value));
  }
  for (const value of ['../prod', '/prod', 'a//b', 'a/..', 'a\\b', 'a?b', 'a\nb']) assert.throws(() => jenkinsJobPath(value));
  assert.equal(jenkinsJobPath('folder/a b'), '/job/folder/job/a%20b');
  for (const value of ['https://bad/queue/item/1/?x=1', 'https://bad/queue/item/1/#x', 'https://u:p@bad/queue/item/1/', 'https://bad/queue/item/../item/1/']) {
    assert.throws(() => queueFromLocation(value, baseUrl));
  }
  assert.throws(() => buildFromUrl('http://internal/job/production/12/', jobName, baseUrl));
  let calls = 0;
  const client = createJenkinsClient({ baseUrl, username, token }, async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://evil.example/' } }); });
  await assert.rejects(client.check(), /重定向/);
  assert.equal(calls, 1);
});

test('缺少、回退或无效的日志字节偏移不能伪造日志推进', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    for (const offset of [null, 'a', '-1', '1e3', '9007199254740992', '6', '7']) {
      f.set({ offset });
      await assert.rejects(f.service.log(run.id, 7), /日志偏移无效，偏移未推进/);
    }
  } finally { await f.close(); }
});

test('参数类型和选项错误在 POST 前拒绝，配置/日志不接受越权关联', async () => {
  const f = await fixture();
  try {
    for (const parameters of [{ unknown: 'x' }, { clean: 'yes' }, { region: 'invalid' }, { branch: true }]) {
      await assert.rejects(f.service.startRun({ bindingId: f.binding.id, requestId: randomUUID(), parameters }));
    }
    await assert.rejects(f.service.saveBinding({ projectId: 'other', environment: '生产', jobFullName: jobName }), /不在当前工作台/);
    assert.equal(f.requests.filter(item => item.init?.method === 'POST').length, 0);
  } finally { await f.close(); }
});

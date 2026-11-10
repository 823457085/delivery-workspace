import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentRemoteDelivery } from '../server/agent-remote-delivery.js';
import { executeProjectGitAction, readProjectGitSnapshot } from '../server/project-git.js';
import { matchConversationJiraDevTask, jiraDevTaskDeliveryId, jiraDevTaskWorkspacePaths } from '../src/features/agent-workbench/jira-dev-context.js';
import type { SourceBackend } from '../server/source-backend.js';
import type { GroupRoomDetail } from '../shared/agent-group-chat.js';
import type { JiraDevTaskRecord } from '../server/jira-dev/index.mjs';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { emptyRequirementProgress } from '../shared/requirement-development.js';

const exec = promisify(execFile);
const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-remote-'));
  const repo = path.join(directory, 'repo'), fetchRemote = path.join(directory, 'fetch.git'), pushRemote = path.join(directory, 'push.git');
  await fs.mkdir(repo); await git(repo, 'init', '-q', '-b', 'feature/delivery');
  await git(repo, 'config', 'user.name', 'Delivery Fixture'); await git(repo, 'config', 'user.email', 'fixture@localhost');
  await fs.writeFile(path.join(repo, 'feature.txt'), 'base\n'); await fs.writeFile(path.join(repo, 'unrelated.txt'), 'base\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', '初始化验证仓库');
  for (const remote of [fetchRemote, pushRemote]) await git(directory, 'init', '--bare', '-q', remote);
  await git(repo, 'remote', 'add', 'origin', fetchRemote); await git(repo, 'config', 'remote.origin.pushurl', pushRemote);
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  const issue = { key: 'TEST-1', url: 'https://jira.example.test/browse/TEST-1', summary: '账户升级 L123' };
  const project = { path: repo, workspacePath: repo, baseBranch: 'master', branchName: 'feature/delivery', baseSha };
  const taskId = randomUUID(), roomId = randomUUID(), runId = randomUUID();
  const progress = emptyRequirementProgress(), evidence = emptyDeliveryEvidence();
  progress.issueKeys = [issue.key]; progress.stages.verification = { status: 'in_progress', evidence: '仍有失败项' };
  evidence.tests = { status: 'failed', evidence: '19 项中 15 通过、4 失败；L123 原样', sha: '' };
  const detail = { room: { id: roomId, title: '测试群聊', workspacePath: repo, executionPath: repo, paused: false, cursorTrustPaths: [],
    createdAt: '2026-11-04T01:00:00Z', updatedAt: '2026-11-04T02:00:00Z',
    source: { taskId, workflow: 'requirement', title: issue.summary, issueKey: issue.key, issueUrl: issue.url, projects: [project] },
    rounds: [{ id: randomUUID(), requestId: 'fixture', requestHash: 'fixture', text: '实现账户升级', attachmentIds: [], accessMode: 'workspace',
      state: 'completed', createdAt: '2026-11-04T01:00:00Z', updatedAt: '2026-11-04T02:00:00Z', turns: [{ id: randomUUID(),
        member: { id: 'frontend', name: '前端开发', capability: 'write', enabled: true, instructions: '实现本任务' }, runId, status: 'completed', attempt: 1,
        result: '', error: '', updatedAt: '2026-11-04T02:00:00Z' }] }] },
    runs: [{ id: runId, workspacePath: repo, status: 'completed', result: '```delivery-report\n' + JSON.stringify({ version: 1,
      requirementProgress: progress, validationEvidence: evidence }) + '\n```', changedFiles: [{ path: 'feature.txt', status: 'modified' }] }] } as unknown as GroupRoomDetail;
  const task = { taskId, workflow: 'requirement', projects: [project], projectPath: repo, sourceProjectPath: repo, branchName: project.branchName,
    baseSha, sourceIssue: issue, issueSnapshot: issue, requirementPlan: { status: 'applied', developmentIssue: issue, items: [{ role: 'implementation', action: 'create', summary: '实现账户升级', key: 'TEST-2', url: 'https://jira.example.test/browse/TEST-2' }],
      designDestination: { site: 'https://docs.example.test', spaceKey: 'DEV', parentId: '42', title: '方案目录', url: 'https://docs.example.test/pages/viewpage.action?pageId=42' } } } as unknown as JiraDevTaskRecord;
  await fs.mkdir(path.join(repo, 'docs', 'requirements'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'requirements', 'TEST-1-tech-design.md'), '# 本地技术方案\n\nL123');
  await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n'); await fs.writeFile(path.join(repo, 'unrelated.txt'), 'unrelated\n');
  const calls: { kind: string; taskId: string; body: string }[] = [];
  const options = { directory: path.join(directory, 'state'), find: () => detail, task: async () => task, source,
    publishComment: async (id: string, body: string) => { calls.push({ kind: 'jira', taskId: id, body }); return { url: issue.url + '?focusedCommentId=1', verified: true }; },
    publishDesign: async (input: { taskId: string; body: string; title: string }) => {
      calls.push({ kind: 'design', taskId: input.taskId, body: input.body });
      return { url: 'https://docs.example.test/pages/viewpage.action?pageId=43', pageId: '43', title: input.title, parentId: '42', spaceKey: 'DEV',
        version: 1, verifiedAt: '2026-11-04T02:00:00Z', bodySha256: createHash('sha256').update(input.body).digest('hex') };
    },
    saveDesign: async (id: string, input: { body: string }) => { calls.push({ kind: 'saveDesign', taskId: id, body: input.body }); } };
  return { directory, repo, fetchRemote, pushRemote, detail, task, issue, roomId, taskId, calls, options,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('真实 Git 交付只提交选定文件，推送及回读使用独立 pushURL，保留无关脏文件', async () => {
  const f = await fixture();
  try {
    const before = await readProjectGitSnapshot(f.repo);
    const delivered = await executeProjectGitAction({ action: 'deliver', path: f.repo, revision: before.revision,
      branch: 'feature/delivery', remote: 'origin', files: ['feature.txt'], message: '更新账户功能' }, source);
    assert.equal(await git(f.pushRemote, 'rev-parse', 'refs/heads/feature/delivery'), delivered.snapshot!.head);
    assert.equal(await git(f.fetchRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '');
    assert.equal(await git(f.repo, 'show', 'HEAD:feature.txt'), 'feature');
    assert.equal(await git(f.repo, 'show', 'HEAD:unrelated.txt'), 'base');
    assert.equal(await fs.readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'unrelated\n');
    assert.equal((await readProjectGitSnapshot(f.repo)).files.find(file => file.path === 'unrelated.txt')?.unstaged, true);
    assert.equal(await git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'feature.txt');
  } finally { await f.cleanup(); }
});

test('真实 Git 交付完整提交重命名，拒绝混入未选择的暂存文件', async () => {
  const f = await fixture();
  try {
    await git(f.repo, 'mv', 'feature.txt', 'renamed.txt'); await git(f.repo, 'add', 'unrelated.txt');
    let snapshot = await readProjectGitSnapshot(f.repo);
    const act = () => executeProjectGitAction({ action: 'deliver', path: f.repo, revision: snapshot.revision,
      branch: 'feature/delivery', remote: 'origin', files: ['renamed.txt'], message: '重命名账户文件' }, source);
    await assert.rejects(act(), (error: any) => error.definite === true && /未选择的文件/.test(error.message));
    await git(f.repo, 'restore', '--staged', 'unrelated.txt'); snapshot = await readProjectGitSnapshot(f.repo);
    await act();
    assert.equal(await git(f.repo, 'ls-tree', '--name-only', 'HEAD'), 'renamed.txt\nunrelated.txt');
    assert.equal(await git(f.pushRemote, 'rev-parse', 'refs/heads/feature/delivery'), await git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(await git(f.repo, 'show', 'HEAD:renamed.txt'), 'feature');
  } finally { await f.cleanup(); }
});

test('非快进推送拒绝后保留本地提交，重新核对合并后仅推送不重复提交', async () => {
  const f = await fixture();
  try {
    const act = async (files: string[]) => executeProjectGitAction({ action: 'deliver', path: f.repo,
      revision: (await readProjectGitSnapshot(f.repo)).revision, branch: 'feature/delivery', remote: 'origin', files, message: '更新账户功能' }, source);
    await act(['feature.txt']);
    const peer = path.join(f.directory, 'peer');
    await git(f.directory, 'clone', '-q', '--branch', 'feature/delivery', f.pushRemote, peer);
    await git(peer, 'config', 'user.name', 'Peer Fixture'); await git(peer, 'config', 'user.email', 'peer@localhost');
    await fs.writeFile(path.join(peer, 'peer.txt'), 'peer\n'); await git(peer, 'add', 'peer.txt'); await git(peer, 'commit', '-qm', '远端新增内容');
    await git(peer, 'push', '-q');
    const remoteSha = await git(f.pushRemote, 'rev-parse', 'refs/heads/feature/delivery');
    await fs.writeFile(path.join(f.repo, 'feature.txt'), 'next version\n');
    const before = await git(f.repo, 'rev-parse', 'HEAD');
    await assert.rejects(act(['feature.txt']), (error: any) => error.definite === true && /本地提交已保留/.test(error.message));
    const local = await git(f.repo, 'rev-parse', 'HEAD'); assert.notEqual(local, before);
    assert.equal(await git(f.pushRemote, 'rev-parse', 'refs/heads/feature/delivery'), remoteSha);
    await git(f.repo, 'fetch', '-q', f.pushRemote, 'refs/heads/feature/delivery'); await git(f.repo, 'merge', '--no-edit', 'FETCH_HEAD');
    const merged = await git(f.repo, 'rev-parse', 'HEAD');
    await act([]);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), merged);
    assert.equal(await git(f.pushRemote, 'rev-parse', 'refs/heads/feature/delivery'), merged);
    assert.equal(await fs.readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'unrelated\n');
  } finally { await f.cleanup(); }
});

test('预览仅只读关联当前任务，保留验证失败事实；文件或 Jira 来源变化后拒绝旧预览', async () => {
  const f = await fixture();
  const service = await createAgentRemoteDelivery(f.options);
  try {
    const preview = await service.preview(f.roomId);
    assert.equal(f.calls.length, 0); assert.equal(preview.design.body, '# 本地技术方案\n\nL123');
    assert.equal(preview.design.destination?.parentId, '42');
    assert.equal(preview.projects[0].files.find(file => file.path === 'feature.txt')?.recommended, true);
    assert.equal(preview.projects[0].files.find(file => file.path === 'unrelated.txt')?.recommended, false);
    assert.match(preview.jira.body, /测试 \/ 检查：未通过；19 项中 15 通过、4 失败；L123 原样/);
    assert.match(preview.jira.body, /TEST-2 https:\/\/jira\.example\.test\/browse\/TEST-2/);
    assert.doesNotMatch(preview.jira.body, /\/private\/|\/tmp\/|"status"/);
    await fs.writeFile(path.join(f.repo, 'feature.txt'), 'changed\n');
    await assert.rejects(service.submit(f.roomId, { requestId: randomUUID(), kind: 'jira', fingerprint: preview.fingerprint }), /已变化/);
    f.task.requirementPlan!.developmentIssue!.key = 'OTHER-1';
    await assert.rejects(service.preview(f.roomId), /来源不一致/);
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('代码交付忽略本地验证产物，拒绝提交强制暂存的产物', async () => {
  const f = await fixture();
  const service = await createAgentRemoteDelivery(f.options);
  const artifact = '.delivery-artifacts/check.log';
  try {
    const before = await service.preview(f.roomId);
    await fs.mkdir(path.join(f.repo, '.delivery-artifacts'));
    await Promise.all(Array.from({ length: 201 }, (_, index) => fs.writeFile(path.join(f.repo, '.delivery-artifacts', `${index}.log`), 'log')));
    await fs.writeFile(path.join(f.repo, artifact), 'log');
    const preview = await service.preview(f.roomId);
    assert.equal(preview.projects[0].available, true);
    assert.deepEqual(preview.projects[0].files, before.projects[0].files);
    assert.equal(preview.fingerprint, before.fingerprint);
    await assert.rejects(service.submit(f.roomId, { requestId: randomUUID(), kind: 'git', projectId: '0',
      fingerprint: preview.fingerprint, files: [artifact], message: '提交本地日志' }), /不在本次预览中/);

    await git(f.repo, 'add', '-f', '--', artifact);
    const staged = await service.preview(f.roomId);
    const result = await service.submit(f.roomId, { requestId: randomUUID(), kind: 'git', projectId: '0',
      fingerprint: staged.fingerprint, files: ['feature.txt'], message: '更新账户功能' });
    assert.equal(result.status, 'failed');
    assert.match(result.detail, /暂存区包含本地验证产物/);
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), staged.projects[0].head);
    assert.equal(await git(f.repo, 'diff', '--cached', '--name-only'), artifact);
  } finally { await service.close(); await f.cleanup(); }
});

test('方案发布回读后保存原任务关联，Jira 使用新链接；重复请求和重启不重复发布', async () => {
  const f = await fixture();
  let service = await createAgentRemoteDelivery(f.options);
  try {
    const initial = await service.preview(f.roomId);
    const designInput = { requestId: randomUUID(), kind: 'design' as const, fingerprint: initial.fingerprint };
    const design = await service.submit(f.roomId, designInput);
    assert.equal(design.status, 'completed'); assert.equal(f.calls.filter(call => call.kind === 'saveDesign').length, 1);
    assert.equal((await service.submit(f.roomId, designInput)).id, design.id);
    const updated = await service.preview(f.roomId);
    assert.match(updated.jira.body, /技术方案：https:\/\/docs.example.test\/pages\/viewpage.action\?pageId=43/);
    const jiraInput = { requestId: randomUUID(), kind: 'jira' as const, fingerprint: updated.fingerprint };
    assert.equal((await service.submit(f.roomId, jiraInput)).status, 'completed');
    await service.close(); service = await createAgentRemoteDelivery(f.options);
    assert.equal((await service.submit(f.roomId, jiraInput)).status, 'completed');
    assert.equal(f.calls.filter(call => call.kind === 'jira').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'design').length, 1);
    assert.equal(f.calls.find(call => call.kind === 'jira')?.taskId, f.taskId);
    await assert.rejects(service.submit(f.roomId, { ...jiraInput, kind: 'design' }), /同一交付请求/);
  } finally { await service.close(); await f.cleanup(); }
});

test('旧会话显示关联任务和远端方案，生成新版后以原页面编号发布', async () => {
  const f = await fixture();
  f.task.requirementPlan!.sourceKind = 'frontend';
  const oldLocal = path.join(f.repo, 'docs', 'requirements', 'TEST-1-tech-design.md');
  await fs.unlink(oldLocal);
  const remote = { pageId: '43', title: 'TEST-2 前端技术方案', url: 'https://docs.example.test/pages/viewpage.action?pageId=43',
    version: 3, bodySha256: createHash('sha256').update('# 旧方案').digest('hex') };
  const service = await createAgentRemoteDelivery({ ...f.options,
    lookupJiraTasks: async () => ({ items: [
      { role: 'parent', action: 'reuse', key: 'TEST-2', url: 'https://jira.example.test/browse/TEST-2', summary: '前端开发' },
      { role: 'design', action: 'reuse', key: 'TEST-3', url: 'https://jira.example.test/browse/TEST-3', summary: '技术方案' },
    ] }),
    lookupDesign: async ({ issueKeys }) => { assert.deepEqual(issueKeys, ['TEST-1', 'TEST-2', 'TEST-3']); return remote; },
    publishDesign: async input => {
      assert.equal(input.existingPageId, '43');
      assert.equal(input.expectedVersion, 3);
      assert.equal(input.expectedBodySha256, remote.bodySha256);
      assert.equal(input.title, remote.title);
      assert.equal(input.body, '# 新版方案');
      return f.options.publishDesign(input);
    },
  });
  try {
    const before = await service.preview(f.roomId);
    assert.deepEqual(before.jiraTasks?.map(item => [item.key, item.role]), [['TEST-1', undefined], ['TEST-2', 'parent'], ['TEST-3', 'design']]);
    assert.equal(before.design.path, '');
    assert.equal(before.design.url, remote.url);
    assert.equal(before.design.version, 3);
    assert.equal(before.design.available, false);
    await fs.writeFile(oldLocal, '# 旧方案');
    await fs.utimes(oldLocal, 1, 1);
    const newLocal = path.join(f.repo, 'docs', 'requirements', 'TEST-2-tech-design.md');
    await fs.writeFile(newLocal, '# 新版方案');
    const after = await service.preview(f.roomId);
    assert.equal(after.design.path, await fs.realpath(newLocal));
    assert.equal(after.design.available, true);
    const result = await service.submit(f.roomId, { requestId: randomUUID(), kind: 'design', fingerprint: after.fingerprint });
    assert.equal(result.status, 'completed');
    assert.equal(f.calls.filter(call => call.kind === 'design').length, 1);
  } finally { await service.close(); await f.cleanup(); }
});

test('同一写入步骤早期重试产物仍推荐，其他任务或节点的同岗位产物不混入', async () => {
  const f = await fixture();
  const turn = f.detail.room.rounds[0].turns[0], currentRun = f.detail.runs[0];
  const teamTaskId = f.detail.room.id;
  currentRun.changedFiles = [];
  currentRun.team = { taskId: teamTaskId, nodeId: turn.id, stageKey: 'implementation', profileId: 'frontend', profileRevision: 1 };
  f.detail.runs.push({ ...currentRun, id: randomUUID(), status: 'failed', changedFiles: [{ path: 'feature.txt', status: 'modified' }],
    team: { ...currentRun.team } });
  f.detail.runs.push({ ...currentRun, id: randomUUID(), changedFiles: [{ path: 'unrelated.txt', status: 'modified' }],
    team: { ...currentRun.team, taskId: randomUUID() } });
  f.detail.runs.push({ ...currentRun, id: randomUUID(), changedFiles: [{ path: 'unrelated.txt', status: 'modified' }],
    team: { ...currentRun.team, nodeId: randomUUID() } });
  const service = await createAgentRemoteDelivery(f.options);
  try {
    const preview = await service.preview(f.roomId);
    assert.equal(preview.projects[0].files.find(file => file.path === 'feature.txt')?.recommended, true);
    assert.equal(preview.projects[0].files.find(file => file.path === 'unrelated.txt')?.recommended, false);
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('明确未写入允许修正后重试，写后结果不确定落盘且阻止盲目重发', async () => {
  const f = await fixture();
  let mode = 'definite', count = 0;
  const service = await createAgentRemoteDelivery({ ...f.options, publishComment: async () => {
    count++; throw Object.assign(new Error(mode === 'definite' ? '认证未配置' : '网络超时'), mode === 'definite' ? { definite: true } : {});
  } });
  try {
    const preview = await service.preview(f.roomId);
    assert.equal((await service.submit(f.roomId, { requestId: randomUUID(), kind: 'jira', fingerprint: preview.fingerprint })).status, 'failed');
    mode = 'uncertain';
    assert.equal((await service.submit(f.roomId, { requestId: randomUUID(), kind: 'jira', fingerprint: preview.fingerprint })).status, 'uncertain');
    await assert.rejects(service.submit(f.roomId, { requestId: randomUUID(), kind: 'jira', fingerprint: preview.fingerprint }), /待核对/);
    assert.equal(count, 2);
    const saved = JSON.parse(await fs.readFile(path.join(f.options.directory, `${f.roomId}.json`), 'utf8'));
    assert.deepEqual(saved.map((attempt: { status: string }) => attempt.status), ['failed', 'uncertain']);
  } finally { await service.close(); await f.cleanup(); }
});

test('任务产物列表保留真实事项原文和创建来源，去重且不为未创建草稿补造链接', async () => {
  const f = await fixture();
  f.task.requirementPlan!.items = [
    { role: 'parent', action: 'reuse', summary: '旧计划里的标题', key: f.issue.key, url: f.issue.url, state: 'reused' },
    { role: 'design', action: 'create', summary: '技术方案 L123', key: 'TEST-2', url: 'https://jira.example.test/browse/TEST-2', state: 'created' },
    { role: 'implementation', action: 'create', summary: '重复事项不替换原记录', key: 'TEST-2', url: 'https://jira.example.test/browse/TEST-2', state: 'created' },
    { role: 'implementation', action: 'create', summary: '尚未创建' },
    { role: 'implementation', action: 'create', summary: '只有Key未取得真实URL', key: 'TEST-3' },
  ];
  const before = JSON.stringify(f.detail), service = await createAgentRemoteDelivery(f.options);
  try {
    const preview = await service.preview(f.roomId);
    assert.deepEqual(preview.jiraTasks, [
      { key: f.issue.key, url: f.issue.url, summary: f.issue.summary, role: 'parent', action: 'reuse', state: 'reused' },
      { key: 'TEST-2', url: 'https://jira.example.test/browse/TEST-2', summary: '技术方案 L123', role: 'design', action: 'create', state: 'created' },
    ]);
    assert.equal(JSON.stringify(f.detail), before);
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('多语言产物从主任务真实文件发现并按原始字节下载，不要求伪造历史运行文件登记', async () => {
  const f = await fixture(), body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x81, 0x32]);
  await fs.mkdir(path.join(f.repo, 'tempdocs'));
  await fs.writeFile(path.join(f.repo, 'tempdocs', 'i18n-import.xlsx'), body);
  const before = JSON.stringify(f.detail), service = await createAgentRemoteDelivery(f.options);
  try {
    const preview = await service.preview(f.roomId), artifact = preview.i18nArtifacts![0]!;
    assert.equal(preview.i18nArtifacts!.length, 1);
    assert.equal(artifact.id, 'i18n-0'); assert.equal(artifact.projectId, '0');
    assert.equal(artifact.path, path.join(await fs.realpath(f.repo), 'tempdocs', 'i18n-import.xlsx'));
    assert.equal(artifact.name, 'i18n-import.xlsx'); assert.equal(artifact.size, body.length);
    assert.equal(artifact.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(artifact.downloadUrl, `/api/agent-runtimes/group-chat/rooms/${f.roomId}/artifacts/i18n-0?sha256=${artifact.sha256}`);
    const file = await service.downloadArtifact(f.roomId, artifact.id, artifact.sha256);
    assert.equal(file.name, artifact.name); assert.deepEqual(file.data, body);
    assert.equal(JSON.stringify(f.detail), before); assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('多语言新名称使用绑定任务编号，优先于历史文件且下载保留原始字节', async () => {
  const f = await fixture(), service = await createAgentRemoteDelivery(f.options);
  const folder = path.join(f.repo, 'tempdocs'), legacy = Buffer.from('historical workbook');
  const current = await fs.readFile(new URL('../server/jira-dev/skills/jira-dev-i18n/templates/多语言模板-后台导入.xlsx', import.meta.url));
  try {
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'i18n-import.xlsx'), legacy);
    const oldArtifact = (await service.preview(f.roomId)).i18nArtifacts![0]!;
    await fs.writeFile(path.join(folder, 'TEST-1-多语言.xlsx'), current);
    const artifact = (await service.preview(f.roomId)).i18nArtifacts![0]!;
    assert.equal(artifact.name, 'TEST-1-多语言.xlsx');
    assert.equal(artifact.path, path.join(await fs.realpath(folder), 'TEST-1-多语言.xlsx'));
    const downloaded = await service.downloadArtifact(f.roomId, artifact.id, artifact.sha256);
    assert.equal(downloaded.name, 'TEST-1-多语言.xlsx'); assert.deepEqual(downloaded.data, current);
    await assert.rejects(service.downloadArtifact(f.roomId, oldArtifact.id, oldArtifact.sha256), /已变化/);
    assert.deepEqual(await fs.readFile(path.join(folder, 'i18n-import.xlsx')), legacy);
    await fs.unlink(path.join(folder, 'TEST-1-多语言.xlsx'));
    assert.equal((await service.preview(f.roomId)).i18nArtifacts![0]!.name, 'i18n-import.xlsx');
    await fs.unlink(path.join(folder, 'i18n-import.xlsx'));
    await fs.writeFile(path.join(folder, 'TEST-1-i18n.xlsx'), legacy);
    assert.equal((await service.preview(f.roomId)).i18nArtifacts![0]!.name, 'TEST-1-i18n.xlsx');
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('新命名多语言表仍拒绝符号链接越界，不回退读取历史文件', async () => {
  const f = await fixture(), service = await createAgentRemoteDelivery(f.options);
  try {
    const folder = path.join(f.repo, 'tempdocs'), outside = path.join(f.directory, 'outside.xlsx');
    await fs.mkdir(folder); await fs.writeFile(outside, 'outside data');
    await fs.writeFile(path.join(folder, 'i18n-import.xlsx'), 'legacy data');
    await fs.symlink(outside, path.join(folder, 'TEST-1-多语言.xlsx'));
    assert.deepEqual((await service.preview(f.roomId)).i18nArtifacts, []);
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-0', '0'.repeat(64)), /超出任务工作区/);
  } finally { await service.close(); await f.cleanup(); }
});

test('多语言下载拒绝缺失文件、旧指纹、任意路径及其他房间或项目身份', async () => {
  const f = await fixture(), service = await createAgentRemoteDelivery(f.options);
  const filename = path.join(f.repo, 'tempdocs', 'i18n-import.xlsx');
  try {
    assert.deepEqual((await service.preview(f.roomId)).i18nArtifacts, []);
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-0', '0'.repeat(64)), /已不存在/);
    await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, 'original bytes');
    const artifact = (await service.preview(f.roomId)).i18nArtifacts![0]!;
    await fs.writeFile(filename, 'new bytes');
    await assert.rejects(service.downloadArtifact(f.roomId, artifact.id, artifact.sha256), /已变化/);
    await assert.rejects(service.downloadArtifact(f.roomId, '../i18n-0', artifact.sha256));
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-1', artifact.sha256), /不属于当前任务/);
    await assert.rejects(service.downloadArtifact(randomUUID(), artifact.id, artifact.sha256), /群聊与当前交付记录不一致/);
    await fs.unlink(filename);
    await assert.rejects(service.downloadArtifact(f.roomId, artifact.id, artifact.sha256), /已不存在/);
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('多语言下载拒绝文件或父目录符号链接越界，以及超过40MB的文件', async () => {
  const f = await fixture(), service = await createAgentRemoteDelivery(f.options);
  const folder = path.join(f.repo, 'tempdocs'), outside = path.join(f.directory, 'outside');
  await fs.mkdir(folder); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'i18n-import.xlsx'), 'not a task artifact');
  try {
    await fs.symlink(path.join(outside, 'i18n-import.xlsx'), path.join(folder, 'i18n-import.xlsx'));
    assert.deepEqual((await service.preview(f.roomId)).i18nArtifacts, []);
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-0', '0'.repeat(64)), /超出任务工作区/);
    await fs.unlink(path.join(folder, 'i18n-import.xlsx')); await fs.rmdir(folder);
    await fs.symlink(outside, folder);
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-0', '0'.repeat(64)), /超出任务工作区/);
    await fs.unlink(folder); await fs.mkdir(folder);
    const handle = await fs.open(path.join(folder, 'i18n-import.xlsx'), 'w');
    try { await handle.truncate(40 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(service.downloadArtifact(f.roomId, 'i18n-0', '0'.repeat(64)), /超过 40MB/);
    assert.equal(f.calls.length, 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('历史需求的命名 XLSX 和独立评审可下载，预览文件不能提供外部或带凭据的地址', async () => {
  const f = await fixture();
  try {
    const service = await createAgentRemoteDelivery(f.options);
    const docs = path.join(f.repo, 'docs', 'requirements');
    await fs.mkdir(path.join(f.repo, 'tempdocs'));
    await fs.writeFile(path.join(f.repo, 'tempdocs', 'TEST-1-i18n-import.xlsx'), 'original artifact');
    await fs.writeFile(path.join(docs, 'TEST-1-dev-prd-review.md'), '# 需求评审');
    const file = path.join(f.repo, 'tempdocs', 'TEST-1-delivery-preview.json');
    const link = { url: 'http://127.0.0.1:5232/country', label: '国家配置 Mock', mode: 'mock', evidence: '本地演示' };
    await fs.writeFile(file, JSON.stringify([link]));
    const result = await service.preview(f.roomId);
    assert.equal(result.i18nArtifacts?.[0]?.name, 'TEST-1-i18n-import.xlsx');
    assert.deepEqual(result.previewLinks, [link]);
    assert.ok(result.reviewArtifact);
    const review = await service.downloadArtifact(f.roomId, result.reviewArtifact.id, result.reviewArtifact.sha256);
    assert.equal(review.data.toString('utf8'), '# 需求评审');
    for (const url of ['https://example.test/country', 'http://x:y@127.0.0.1:5232/country']) {
      await fs.writeFile(file, JSON.stringify([{ ...link, url }]));
      assert.equal((await service.preview(f.roomId)).previewLinks, undefined);
    }
  } finally { await f.cleanup(); }
});

test('普通会话任务可通过 taskId 直接读取需求开发交付产物，并与对应群聊共享发布记录', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.repo, 'tempdocs'), { recursive: true });
    await fs.writeFile(path.join(f.repo, 'tempdocs', 'TEST-1-多语言.xlsx'), 'i18n-content');
    const standaloneService = await createAgentRemoteDelivery({
      ...f.options,
      find: (id: string) => {
        if (id === f.roomId) return f.detail;
        throw new Error('找不到这个团队群聊');
      },
      task: async (id: string) => {
        if (id !== f.taskId) throw new Error('找不到该 Jira 任务');
        return f.task;
      },
      taskRuns: (id: string) => (id === f.taskId ? f.detail.runs : []),
    });
    try {
      const preview = await standaloneService.preview(f.taskId);
      assert.equal(preview.roomId, f.taskId);
      assert.equal(preview.taskId, f.taskId);
      assert.equal(preview.issue.key, 'TEST-1');
      assert.equal(preview.design.path, path.join(await fs.realpath(f.repo), 'docs', 'requirements', 'TEST-1-tech-design.md'));
      assert.equal(preview.i18nArtifacts?.[0]?.name, 'TEST-1-多语言.xlsx');
      const artifact = preview.i18nArtifacts![0]!;
      const downloaded = await standaloneService.downloadArtifact(f.taskId, artifact.id, artifact.sha256);
      assert.equal(downloaded.data.toString('utf8'), 'i18n-content');

      const submitted = await standaloneService.submit(f.taskId, {
        requestId: randomUUID(),
        fingerprint: preview.fingerprint,
        kind: 'design',
      });
      assert.equal(submitted.status, 'completed');

      const groupBoundService = await createAgentRemoteDelivery({
        ...f.options,
        find: (id: string) => {
          if (id === f.roomId) return f.detail;
          throw new Error('找不到这个团队群聊');
        },
        findGroup: (id: string) => (id === f.taskId ? { groupRoomId: f.roomId } : undefined),
        task: async (id: string) => {
          if (id !== f.taskId) throw new Error('找不到该 Jira 任务');
          return f.task;
        },
      });
      try {
        const synced = await groupBoundService.preview(f.taskId);
        assert.equal(synced.roomId, f.taskId);
        assert.equal(synced.taskId, f.taskId);
      } finally {
        await groupBoundService.close();
      }
    } finally {
      await standaloneService.close();
    }
  } finally { await f.cleanup(); }
});

test('普通会话关联匹配支持按 sourceId、独立 worktree、分支和 Jira Key 匹配研发任务', () => {
  const task = {
    taskId: '11111111-1111-4111-8111-111111111111',
    workflow: 'requirement' as const,
    title: '需求开发 · VMS-748 · 【APP】开发 Adyen商家账户拆分',
    projectPath: '/workspace/merchant-front',
    baseBranch: 'master',
    branchName: 'feature/VMS-747',
    projects: [{ path: '/workspace/merchant-front', workspacePath: '/workspace/merchant-front-tasks/vms-748', baseBranch: 'master', branchName: 'feature/VMS-747' }],
    prompt: '',
    createdAt: '2026-11-07T01:00:00Z',
    updatedAt: '2026-11-07T02:00:00Z',
    launch: {
      status: 'started' as const,
      collaborationMode: 'group' as const,
      groupRoomId: '22222222-2222-4222-8222-222222222222',
      workspacePath: '/workspace/merchant-front-tasks/vms-748',
      projects: [{ path: '/workspace/merchant-front', workspacePath: '/workspace/merchant-front-tasks/vms-748', baseBranch: 'master', branchName: 'feature/VMS-747' }],
      startedAt: '2026-11-07T01:00:00Z',
      updatedAt: '2026-11-07T02:00:00Z',
    },
  };
  assert.equal(jiraDevTaskDeliveryId(task), '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(jiraDevTaskWorkspacePaths(task), ['/workspace/merchant-front-tasks/vms-748']);

  const byKeyConversation = {
    id: 'conv-1',
    title: '排查 VMS-748 商家账户拆分问题',
    updatedAt: '2026-11-07T02:00:00Z',
    source: 'workbench' as const,
    loaded: true,
    latest: { id: 'run-1', workspacePath: '/workspace/merchant-front', objective: '继续处理 VMS-748', events: [] },
    runs: [{ id: 'run-1', workspacePath: '/workspace/merchant-front', objective: '继续处理 VMS-748', events: [] }],
  } as any;
  assert.equal(matchConversationJiraDevTask(byKeyConversation, [task])?.taskId, task.taskId);

  const byBranchConversation = {
    id: 'conv-2',
    title: '本地联调会话',
    updatedAt: '2026-11-07T02:00:00Z',
    source: 'workbench' as const,
    loaded: true,
    latest: { id: 'run-2', workspacePath: '/workspace/merchant-front', branch: 'feature/VMS-747', objective: '跑一下构建', events: [] },
    runs: [{ id: 'run-2', workspacePath: '/workspace/merchant-front', branch: 'feature/VMS-747', objective: '跑一下构建', events: [] }],
  } as any;
  assert.equal(matchConversationJiraDevTask(byBranchConversation, [task])?.taskId, task.taskId);
});

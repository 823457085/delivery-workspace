import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { shallowRef } from 'vue';
import { checkAgentRecovery, processIsAlive, readProcessStartTime } from '../server/agent-recovery.js';
import { executeProjectGitAction } from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { CodexSessionSource } from '../server/codex-session-source.js';

const exec = promisify(execFile);

test('Round 13 [P1-15]: 进程存活判定比对启动时间，PID 被复用给无关进程时不再误判原任务仍在运行', async () => {
  const selfStart = readProcessStartTime(process.pid);
  assert.ok(selfStart, '应能读取当前进程启动时间');
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(process.pid, selfStart), true);
  // 记录的启动时间与当前同 PID 进程不一致 => PID 已被复用
  assert.equal(processIsAlive(process.pid, 'Thu Jan  1 00:00:00 1970'.replace(/\s+/g, ' ')), false);
  // 无法读取启动时间时保守视为仍存活，避免误放行重复执行
  assert.equal(processIsAlive(process.pid, 'anything', () => undefined), true);

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
  await new Promise(resolve => child.once('spawn', resolve));
  const childPid = child.pid!;
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(processIsAlive(childPid), false, '已退出进程不应视为存活');

  const seen: unknown[][] = [];
  const run = {
    id: 'r13-run', provider: 'cursor', status: 'interrupted', sessionId: '', result: '', error: '',
    recovery: { previousStatus: 'running', previousPid: 4242, previousPidStartedAt: 'Mon Nov 16 09:00:00 2026', state: 'pending', checkedAt: '', message: '' },
  } as unknown as AgentRun;
  const outcome = await checkAgentRecovery(run, {} as CodexSessionSource, (...args: unknown[]) => { seen.push(args); return false; });
  assert.deepEqual(seen[0], [4242, 'Mon Nov 16 09:00:00 2026']);
  assert.equal(outcome.recovery?.state, 'needs-review');
});

test('Round 13 [P1-18]: 改动超过 200 项时显式确认后可全部暂存与提交，未确认时给出总数提示', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round13-git-'));
  const repo = path.join(root, 'repo');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;
  try {
    await fs.mkdir(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Round13 Tester');
    await git('config', 'user.email', 'round13@localhost');
    await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await git('add', 'README.md');
    await git('commit', '-qm', 'chore: init');
    await fs.mkdir(path.join(repo, 'generated'));
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      fs.writeFile(path.join(repo, 'generated', `item-${String(index).padStart(3, '0')}.txt`), `value ${index}\n`)));

    await assert.rejects(
      executeProjectGitAction({ path: repo, action: 'stage-all' }, source),
      /共 205 项.*超过展示上限 200 项/,
    );
    const staged = await executeProjectGitAction({ path: repo, action: 'stage-all', acknowledgeTruncated: true }, source);
    assert.equal(staged.snapshot.truncated, true);
    assert.equal(staged.snapshot.counts.staged, 205);

    await assert.rejects(
      executeProjectGitAction({ path: repo, action: 'commit', message: 'feat: bulk generated files' }, source),
      /已暂存 205 项/,
    );
    const committed = await executeProjectGitAction(
      { path: repo, action: 'commit', message: 'feat: bulk generated files', acknowledgeTruncated: true }, source);
    assert.equal(committed.snapshot.clean, true);
    assert.match(await git('log', '-1', '--pretty=%s'), /bulk generated files/);
    assert.equal((await git('ls-files', 'generated')).trim().split('\n').length, 205);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Round 13 [P1-23]: 其他会话提交中时停止操作不再被全局锁静默丢弃，发送被拒时给出提示', async () => {
  const raw = readFileSync(new URL('../src/features/agent-workbench/useAgentRuntimes.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('useAgentRuntimes.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pieces: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && ['stop', 'start', 'claimConversationSubmission'].includes(node.name.text)) pieces.push(node.getText(tree));
    else if (ts.isVariableStatement(node) && (node.getText(tree).includes('stoppingRuns = new Set') || node.getText(tree).includes('submittingConversations = new Set'))) pieces.push(node.getText(tree));
    else ts.forEachChild(node, visit);
  };
  visit(tree);
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const changing = shallowRef('start');
  const posts: string[] = [], warnings: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deps = {
    changing,
    ElMessage: { success: () => {}, error: (message: string) => assert.fail(message), warning: (message: string) => warnings.push(message) },
    post: async (url: string) => { posts.push(url); await gate; return {}; },
  };
  const actions = new Function(...Object.keys(deps), `${code}\nreturn { stop, start };`)(...Object.values(deps)) as {
    stop: (run: { id: string }) => Promise<void>; start: (input: Record<string, unknown>) => Promise<unknown>;
  };
  // 另一会话正在发送（changing='start'），停止 B 会话仍应发出请求
  const stopping = actions.stop({ id: 'run-b' });
  await actions.stop({ id: 'run-b' }); // 重复点击去重
  assert.deepEqual(posts, ['/api/agent-runtimes/runs/run-b/stop']);
  assert.equal(changing.value, 'start', '不得改写其他会话的进行中标记');
  release(); await stopping;
  assert.equal(changing.value, 'start');
  // 发送被全局锁拒绝时提示用户，而不是静默丢弃
  assert.equal(await actions.start({ provider: 'codex', objective: 'x' }), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /请稍候/);
});

test('Round 13 [第七节-5 & 第七节-7 & 第六节-12]: 打包扫描覆盖更多凭据类型、关闭流程不跳过租约释放、PM2 防崩溃循环', async () => {
  const script = readFileSync(new URL('../tools/package-share.py', import.meta.url), 'utf8');
  const block = script.slice(script.indexOf('secrets = re.compile('), script.indexOf('\nfor file in files:'));
  const pattern = new RegExp([...block.matchAll(/r'((?:[^'\\]|\\.)*)'/g)].map(match => match[1]).join(''));
  const samples = {
    atlassian: 'ATATT3' + 'xFfGF0T1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEf',
    gitlab: 'glpat-' + 'AbCdEfGhIjKlMnOpQrSt',
    aliyun: 'LTAI' + '5tAbCdEfGhIjKlMn',
    wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + '1b2c3d4e-1234-4abc-9def-0123456789ab',
    openai: 'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz012345',
  };
  for (const [name, value] of Object.entries(samples)) assert.match(value, pattern, name);
  for (const safe of ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-fixture-only', 'ATATT_placeholder', 'glpat-short'])
    assert.doesNotMatch(safe, pattern, safe);

  const index = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const shutdown = index.match(/function shutdown\(exitCode = 0\) \{([\s\S]*?)\n\}/);
  assert.ok(shutdown, '普通关闭的退出码默认为 0');
  assert.match(shutdown[1], /finally \{[\s\S]*releaseStateLease\(\)[\s\S]*process\.exit\(exitCode\)/);
  assert.match(index, /process\.on\('unhandledRejection'/);
  assert.match(index, /async function closeStep\(/);

  // PM2 配置只随分享包分发，源码仓库没有该文件。
  if (existsSync(new URL('../ecosystem.share.config.cjs', import.meta.url))) {
    const require = createRequire(import.meta.url);
    const pm2 = require('../ecosystem.share.config.cjs') as { apps: Record<string, unknown>[] };
    assert.equal(typeof pm2.apps[0].max_restarts, 'number');
    assert.ok(Number(pm2.apps[0].min_uptime) >= 10_000);
    assert.ok(Number(pm2.apps[0].exp_backoff_restart_delay) > 0);
  }

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Agent Studio|Mastra 实验台/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runProjectCommand, redactProjectOutput, createProjectLogBuffer, readManagedLaunchLog } from '../server/project-command-runner.js';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-command-runner-')));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const previousPath = process.env.PATH, previousHome = process.env.PM2_HOME;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const writeBinary = (name: string, source: string) => fs.writeFile(path.join(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return { root, bin, writeBinary };
}

test('项目命令真实流式转发 stdout/stderr，中文跨字节分块完整且只影响子进程环境', async t => {
  const f = await fixture(t);
  const previous = { CI: process.env.CI, FORCE_COLOR: process.env.FORCE_COLOR, BROWSER: process.env.BROWSER };
  await f.writeBinary('npm', `
    const text = Buffer.from('中文结果🙂');
    process.stdout.write(text.subarray(0, 1));
    setTimeout(() => { process.stdout.write(text.subarray(1, 5));
      setTimeout(() => { process.stdout.write(text.subarray(5)); process.stderr.write('错误通道\\n');
        process.stdout.write('\\n' + JSON.stringify([process.env.CI, process.env.FORCE_COLOR, process.env.BROWSER, process.argv.slice(2)])); }, 10);
    }, 10);`);
  const output: string[] = [];
  const result = await runProjectCommand({ workspacePath: f.root, binary: 'npm', args: ['run', 'test', 'literal;echo injected'],
    signal: new AbortController().signal, onOutput: value => output.push(value) });
  assert.deepEqual(result, { exitCode: 0, cancelled: false, timedOut: false });
  const text = output.join('');
  assert.match(text, /中文结果🙂/); assert.match(text, /错误通道/); assert.doesNotMatch(text, /�/);
  assert.ok(text.includes(JSON.stringify(['1', '0', 'none', ['run', 'test', 'literal;echo injected']])));
  assert.deepEqual({ CI: process.env.CI, FORCE_COLOR: process.env.FORCE_COLOR, BROWSER: process.env.BROWSER }, previous);
  assert.ok(output.length > 2);
});

test('命令失败、缺少可执行程序和预先取消均有准确可回读结果', async t => {
  const f = await fixture(t);
  await f.writeBinary('npm', 'process.stderr.write("构建失败\\n"); process.exitCode = 7;');
  const input = { workspacePath: f.root, binary: 'npm' as const, args: ['run', 'build'], signal: new AbortController().signal, onOutput() {} };
  assert.deepEqual(await runProjectCommand(input), { exitCode: 7, cancelled: false, timedOut: false });
  process.env.PATH = f.bin;
  const output: string[] = [];
  const missing = await runProjectCommand({ ...input, binary: 'pnpm', onOutput: value => output.push(value) });
  assert.equal(missing.exitCode, null); assert.match(output.join(''), /未找到可执行程序/);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await runProjectCommand({ ...input, signal: controller.signal }), { exitCode: null, cancelled: true, timedOut: false });
});

test('stdout/stderr 交错的半截凭据按各自完整行发布，不向累计日志泄漏秘密后半段', async t => {
  const f = await fixture(t);
  await f.writeBinary('npm', `
    process.stdout.write('API_TOKEN=STDOUT_PREFIX_');
    setTimeout(() => { process.stderr.write('error line\\nCookie=STDERR_PREFIX_');
      setTimeout(() => { process.stdout.write('STDOUT_SUFFIX_PRIVATE\\n最终中文');
        setTimeout(() => process.stderr.write('STDERR_SUFFIX_PRIVATE\\n'), 20);
      }, 20);
    }, 20);`);
  const buffer = createProjectLogBuffer(), observed: string[] = [], frames: string[] = [];
  const result = await runProjectCommand({ workspacePath: f.root, binary: 'npm', args: [], signal: new AbortController().signal,
    onOutput: text => { frames.push(text); observed.push(buffer.append(text)); } });
  observed.push(buffer.flush());
  assert.equal(result.exitCode, 0);
  assert.ok(frames.every(frame => frame.endsWith('\n')));
  for (const text of observed) assert.doesNotMatch(text, /PREFIX|SUFFIX|PRIVATE/);
  assert.match(buffer.read(), /error line/); assert.match(buffer.read(), /最终中文/);
});

test('取消和超时清理仅本次进程组；父进程先退出也不能遗留忽略 TERM 的孙进程', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill('SIGKILL'));
  for (const mode of ['abort', 'timeout', 'parent-exit']) {
    const marker = path.join(f.root, `late-${mode}`);
    await f.writeBinary('npm', `
      const {spawn}=require('node:child_process');
      const source='process.on("SIGTERM",()=>{}); process.stdout.write("grandchild-ready\\\\n"); setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"escaped"),1600); setInterval(()=>{},1000);';
      spawn(process.execPath,['-e',source],{stdio:['ignore','inherit','inherit']});
      ${mode === 'parent-exit' ? 'setTimeout(()=>process.exit(0),200);' : 'setInterval(()=>{},1000);'}`);
    const controller = new AbortController();
    const result = await runProjectCommand({ workspacePath: f.root, binary: 'npm', args: [], signal: controller.signal,
      ...(mode === 'timeout' ? { timeoutMs: 400 } : {}),
      onOutput: value => { if (mode === 'abort' && value.includes('grandchild-ready')) controller.abort(); } });
    assert.equal(result.cancelled, mode === 'abort');
    assert.equal(result.timedOut, mode === 'timeout');
    assert.equal(process.kill(unrelated.pid!, 0), true, '无关进程仍运行');
    await delay(1100);
    assert.equal(await fs.access(marker).then(() => true, () => false), false, mode);
  }
});

test('日志脱敏覆盖常见凭据、URL认证及已知敏感环境值，不读取环境文件', () => {
  const previous = process.env.PROJECT_FIXTURE_SECRET;
  process.env.PROJECT_FIXTURE_SECRET = 'ENV_PRIVATE_FIXTURE';
  try {
    const raw = ['token=ASSIGN_PRIVATE', '"api_key": "JSON_PRIVATE"', "password='SPACE PRIVATE'", 'secret: SECRET_PRIVATE',
      'Authorization: Bearer HEADER_PRIVATE', 'Cookie: sid=COOKIE_PRIVATE; other=MORE_PRIVATE',
      'curl -u user:BASIC_PRIVATE https://user:URL_PRIVATE@example.com/api?token=QUERY_PRIVATE',
      'https://user:URL_FIRST_PRIVATE@URL_LAST_PRIVATE@example.com/a',
      'Bearer FREE_PRIVATE', 'sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'xai-abcdefghijklmnopqrstuvwxyz012345', 'ENV_PRIVATE_FIXTURE'].join('\n');
    const result = redactProjectOutput(raw);
    for (const secret of ['ASSIGN_PRIVATE', 'JSON_PRIVATE', 'SPACE PRIVATE', 'SECRET_PRIVATE', 'HEADER_PRIVATE', 'COOKIE_PRIVATE',
      'MORE_PRIVATE', 'BASIC_PRIVATE', 'URL_PRIVATE', 'URL_FIRST_PRIVATE', 'URL_LAST_PRIVATE', 'QUERY_PRIVATE', 'FREE_PRIVATE', 'abcdefghijklmnopqrstuvwxyz', 'ENV_PRIVATE_FIXTURE']) assert.equal(result.includes(secret), false, secret);
    assert.match(result, /example\.com/);
    assert.equal(redactProjectOutput('构建成功：L_CODE_123'), '构建成功：L_CODE_123');
  } finally { if (previous === undefined) delete process.env.PROJECT_FIXTURE_SECRET; else process.env.PROJECT_FIXTURE_SECRET = previous; }
});

test('累计日志等待完整行，分块凭据无中间泄露，限长不会截出秘密尾巴', () => {
  const log = createProjectLogBuffer(512);
  assert.equal(log.append('ok\ntoken=PART'), 'ok\n');
  assert.equal(log.read(), 'ok\n');
  assert.equal(log.append('IAL_PRIVATE\n'), 'ok\ntoken=[redacted]\n');
  assert.equal(log.append('https://user:URL_'), 'ok\ntoken=[redacted]\n');
  assert.doesNotMatch(log.append('PRIVATE@example.com/a\r'), /URL_|PRIVATE|PARTIAL/);
  log.append(`password=${'A'.repeat(100_000)}`);
  assert.doesNotMatch(log.read(), /AAAA/);
  log.append('TRAILING_PRIVATE\n');
  for (let index = 0; index < 100; index++) log.append(`line-${index} 中文\n`);
  log.append('secret=LAST_PRIVATE');
  assert.doesNotMatch(log.read(), /LAST_PRIVATE/);
  const final = log.flush();
  assert.doesNotMatch(final, /PRIVATE|AAAA|PARTIAL/);
  assert.ok(final.length <= 512); assert.equal(log.truncated(), true);
  assert.match(final, /line-99/); assert.match(final, /secret=\[redacted\]/);
});

test('PM2 日志只读取精确自有服务，尾部有界且首条截断行不外泄', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, 'pm2');
  const logs = path.join(home, 'logs'); await fs.mkdir(logs, { recursive: true });
  process.env.PM2_HOME = home; await fs.writeFile(path.join(home, 'pm2.pid'), String(process.pid));
  const manager = `delivery-launch-${'a'.repeat(24)}`, command = 'npm run dev';
  const out = path.join(logs, `${manager}-out.log`), error = path.join(logs, `${manager}-error.log`);
  await fs.writeFile(out, `${'TRUNCATED_PRIVATE'.repeat(5000)}\n中文构建完成\ntoken=LOG_PRIVATE\n`);
  await fs.writeFile(error, 'Cookie: sid=COOKIE_PRIVATE\n警告 L_CODE\nhttps://user:PARTIAL_PRIVATE');
  const list = path.join(f.root, 'jlist.json');
  const entry = { name: manager, pm2_env: { pm_exec_path: '/bin/zsh', pm_cwd: f.root, args: ['-lc', command], pm_out_log_path: out, pm_err_log_path: error, ENV_SECRET: 'JLIST_PRIVATE' } };
  await fs.writeFile(list, JSON.stringify([{ name: 'unrelated', pm2_env: { ENV_SECRET: 'OTHER_PRIVATE' } }, entry]));
  await f.writeBinary('pm2', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(list)},'utf8'));`);
  const input = { manager, workspacePath: f.root, command };
  const output = await readManagedLaunchLog(input);
  assert.match(output, /中文构建完成/); assert.match(output, /警告 L_CODE/); assert.doesNotMatch(output, /PRIVATE|�/); assert.ok(output.length < 65_536);
  for (const change of [{ pm_cwd: os.tmpdir() }, { args: ['-lc', 'npm run unrelated'] }, { pm_exec_path: '/bin/sh' }, { pm_out_log_path: path.join(f.root, 'outside.log') }]) {
    await fs.writeFile(list, JSON.stringify([{ ...entry, pm2_env: { ...entry.pm2_env, ...change } }]));
    await assert.rejects(readManagedLaunchLog(input));
  }
  await fs.writeFile(list, JSON.stringify([entry]));
  const outside = path.join(f.root, 'outside.log'); await fs.writeFile(outside, 'OUTSIDE_PRIVATE');
  await fs.unlink(out); await fs.symlink(outside, out);
  await assert.rejects(readManagedLaunchLog(input), /安全核对/);
  await fs.unlink(out); await fs.link(outside, out);
  await assert.rejects(readManagedLaunchLog(input), /安全核对/);
  await fs.unlink(out); await fs.writeFile(out, 'safe');
  await fs.rename(logs, `${logs}-original`); await fs.symlink(`${logs}-original`, logs);
  await assert.rejects(readManagedLaunchLog(input), /符号链接/);
});

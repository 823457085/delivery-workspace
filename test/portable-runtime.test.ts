import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findCliOnPath, isCompleteCodexRuntime, resolveCliBinaries } from '../server/cli-runtime.js';
import { initializeSourceEnvironment } from '../server/source-backend.js';

const exec = promisify(execFile);
const root = path.resolve('.');
async function binary(filename: string) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return filename;
}

test('CLI 在 PATH 中可用，并通过真实路径识别同目录 code-mode-host', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-cli-discovery-'));
  try {
    const bin = path.join(directory, 'bin');
    const runtime = path.join(directory, 'complete-runtime');
    const isolated = await binary(path.join(directory, 'isolated-codex'));
    const codex = await binary(path.join(runtime, 'codex'));
    await binary(path.join(runtime, 'codex-code-mode-host'));
    await fs.mkdir(bin, { recursive: true });
    const link = path.join(bin, 'codex');
    await fs.symlink(codex, link);
    const cursor = await binary(path.join(bin, 'cursor-agent'));
    const environment = { PATH: bin, DELIVERY_CODEX_BIN: isolated };
    assert.equal(findCliOnPath('codex', environment), link);
    assert.equal(isCompleteCodexRuntime(link), true);
    assert.deepEqual(resolveCliBinaries(environment, directory, 'linux'), { codex: link, cursor });
    assert.deepEqual(resolveCliBinaries({ PATH: '', DELIVERY_CODEX_BIN: isolated, DELIVERY_CURSOR_BIN: cursor }, directory, 'linux'),
      { codex: isolated, cursor });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('macOS 可发现用户 Applications 中的完整 Codex.app 运行时', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-macos-cli-'));
  try {
    const codex = await binary(path.join(home, 'Applications/Codex.app/Contents/Resources/codex'));
    await binary(path.join(path.dirname(codex), 'codex-code-mode-host'));
    assert.equal(resolveCliBinaries({ PATH: '' }, home, 'darwin').codex, codex);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('macOS 可发现嵌套 CodexCLI.app 布局的桌面运行时', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-nested-cli-'));
  try {
    const codex = await binary(path.join(home, 'Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'));
    await binary(path.join(path.dirname(codex), 'codex-code-mode-host'));
    assert.equal(resolveCliBinaries({ PATH: '' }, home, 'darwin').codex, codex);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('source 默认写入仓库 .data/source，独立凭据使用标准 dotenv 解析且不覆盖环境', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-source-isolation-'));
  const keys = ['DELIVERY_PORT', 'DELIVERY_DATA_DIR', 'DELIVERY_SOURCE_DATA_DIR', 'DELIVERY_CREDENTIALS_FILE', 'DELIVERY_PORTABLE_TEST'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const defaults = initializeSourceEnvironment(5991, directory);
    assert.deepEqual(defaults, { credentials: path.join(directory, '.env'), dataDirectory: path.join(directory, '.data/source') });
    assert.equal(process.env.DELIVERY_PORT, '5991');
    delete process.env.DELIVERY_SOURCE_DATA_DIR;
    const credentials = path.join(directory, 'personal.env');
    await fs.writeFile(credentials, 'DELIVERY_DATA_DIR="/recipient/data # with spaces"\nDELIVERY_PORTABLE_TEST="from file"\n');
    process.env.DELIVERY_CREDENTIALS_FILE = credentials;
    process.env.DELIVERY_PORTABLE_TEST = 'already configured';
    assert.equal(initializeSourceEnvironment(5992, directory).dataDirectory, '/recipient/data # with spaces/source');
    assert.equal(process.env.DELIVERY_PORTABLE_TEST, 'already configured');
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Node 在 import CLI 配置前加载 .env 中的运行时路径', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-env-startup-'));
  try {
    const codex = await binary(path.join(directory, 'codex'));
    await binary(path.join(directory, 'codex-code-mode-host'));
    const cursor = await binary(path.join(directory, 'cursor-agent'));
    const envFile = path.join(directory, '.env');
    await fs.writeFile(envFile, `DELIVERY_CODEX_BIN="${codex}"\nDELIVERY_CURSOR_BIN="${cursor}"\n`);
    const environment = { ...process.env };
    delete environment.DELIVERY_CODEX_BIN;
    delete environment.DELIVERY_CURSOR_BIN;
    const result = await exec(process.execPath, [`--env-file-if-exists=${envFile}`, '--import', 'tsx', '--input-type=module', '--eval',
      "import { cliBinary, cursorBinary } from './server/cli-runtime.ts'; console.log(JSON.stringify({codex:cliBinary,cursor:cursorBinary}));"],
      { cwd: root, env: environment, timeout: 10_000 });
    assert.deepEqual(JSON.parse(result.stdout), { codex, cursor });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('doctor 只报告登录状态，不输出 CLI 认证命令返回的内容', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-doctor-redaction-'));
  try {
    const fixture = path.join(directory, 'codex');
    await fs.writeFile(fixture, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.2.3 STDOUT_SECRET_TEST"; echo "codex 9.9.9 STDERR_SECRET_TEST" >&2; else echo "Logged in SECRET_TEST_DO_NOT_PRINT"; fi\n', { mode: 0o755 });
    await binary(path.join(directory, 'codex-code-mode-host'));
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/doctor.mjs'], { cwd: root,
      env: { ...process.env, DELIVERY_CODEX_BIN: fixture, DELIVERY_CURSOR_BIN: path.join(directory, 'missing-cursor') }, timeout: 30_000 });
    assert.match(result.stdout, /Codex CLI: codex-cli 1\.2\.3 · 已登录/);
    assert.equal(result.stdout.includes('SECRET_TEST_DO_NOT_PRINT'), false);
    assert.equal(result.stdout.includes('STDOUT_SECRET_TEST'), false);
    assert.equal(result.stdout.includes('STDERR_SECRET_TEST'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('空 CODEX_HOME 下桌面技术方案使用附包 Skill 与绝对路径 Kit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-desktop-support-'));
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { desktopHealth, desktopPacket } from './server/design-executor/desktop.ts';
      const packet = desktopPacket({id:'fixture',input:{},steps:[{id:'intake',status:'pending'}],artifacts:{}});
      console.log(JSON.stringify({health:await desktopHealth(),prompt:packet.prompt}));
    `], { cwd: root, env: { ...process.env, CODEX_HOME: directory,
      DELIVERY_SKILLS_ROOT: './support/skills', AI_DELIVERY_KIT_ROOT: './support/ai-delivery-kit' }, timeout: 10_000 });
    const output = JSON.parse(result.stdout);
    assert.equal(output.health.ready, true);
    assert.equal(output.health.skillsReady, true);
    assert.ok(output.prompt.includes(path.join(root, 'support/skills/apex-frontend-tech-design-delivery/SKILL.md')));
    assert.ok(output.prompt.includes(path.join(root, 'support/ai-delivery-kit')));
    assert.equal(output.prompt.includes(path.join(directory, 'skills')), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

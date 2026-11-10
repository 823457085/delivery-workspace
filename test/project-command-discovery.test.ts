import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverProject, projectCommands } from '../server/project-command-discovery.js';
import type { LaunchConfig } from '../shared/project-launch.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-command-discovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  const manifest = (value: unknown) => fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify(value));
  return { root, workspace, manifest };
}

test('发现真实脚本、稳定默认启动配置和命令，不公开正文或提供发布脚本', async t => {
  const f = await fixture(t);
  await f.manifest({ packageManager: 'pnpm@9.15.0', scripts: {
    dev: 'vite', 'dev:test': 'vite --mode test', 'dev:i18n-test': 'vite --mode i18n-test', 'dev:pre': 'vite --mode pre', 'dev:prod': 'vite --mode prod',
    start: 'next start', serve: 'vue-cli-service serve', build: 'node build.js --credential PRIVATE_BODY', 'build:pre': 'vite build --mode pre',
    test: 'node --test', 'test:unit': 'vitest run', lint: 'eslint src', typecheck: 'tsc --noEmit', check: 'node check.js', 'check:types': 'vue-tsc --noEmit',
    deploy: 'node deploy.js', publish: 'npm publish', release: 'release-it', upload: 'node upload.js',
    'dev:deploy': 'node deploy.js', 'build:release': 'release-it', 'test:upload': 'node upload.js',
    'dev;touch-owned': 'node nope.js', 'bad name': 'node nope.js', empty: '', object: { unexpected: true },
  } });
  const discovered = await discoverProject(f.workspace), commands = projectCommands(discovered, discovered.defaultConfigs);
  assert.deepEqual(discovered.defaultConfigs.map(config => config.name), ['开发', '测试', '国际化测试', '预发', '生产接口', '默认启动', '本地服务']);
  assert.equal(discovered.defaultConfigs[0].id, createHash('sha256').update('dev').digest('hex').slice(0, 24));
  assert.deepEqual(discovered.defaultConfigs, (await discoverProject(f.workspace)).defaultConfigs);
  assert.ok(!discovered.scripts.includes('dev;touch-owned') && !discovered.scripts.includes('bad name') && !discovered.scripts.includes('empty'));
  assert.equal(commands[0].id, 'install'); assert.equal(commands[0].command, 'pnpm install');
  assert.deepEqual(commands.filter(command => command.kind === 'run').map(command => [command.environment, command.script]), [
    ['dev', 'dev'], ['test', 'dev:test'], ['i18n-test', 'dev:i18n-test'], ['pre', 'dev:pre'], ['prod', 'dev:prod'],
  ]);
  assert.deepEqual(commands.filter(command => command.kind === 'build').map(command => [command.environment, command.script]), [['pre', 'build:pre'], ['prod', 'build']]);
  assert.ok(commands.every(command => ['install', 'run', 'build'].includes(command.kind)));
  assert.equal(commands[0].environment, undefined);
  assert.doesNotMatch(JSON.stringify(commands), /PRIVATE_BODY|deploy|publish|release|upload/);
  assert.ok(commands.every(command => /^[a-f0-9]{64}$/.test(command.fingerprint)));
});

test('有效保存配置保留自己的名称和包管理器，失效及危险脚本不进入执行命令', async t => {
  const f = await fixture(t); await f.manifest({ scripts: { dev: 'vite', test: 'node --test', deploy: 'node deploy.js' } });
  const project = await discoverProject(f.workspace);
  const saved: LaunchConfig = { ...project.defaultConfigs[0], id: 'custom-dev', name: '自定义环境', packageManager: 'yarn', port: 7444 };
  const commands = projectCommands(project, [saved, { ...saved, id: 'missing', script: 'missing' }, { ...saved, id: 'danger', script: 'deploy' }]);
  assert.deepEqual(commands.find(command => command.kind === 'run'), { id: 'run:custom-dev', kind: 'run', name: '自定义环境',
    configId: 'custom-dev', script: 'dev', environment: 'dev', command: 'yarn run dev', fingerprint: commands[1].fingerprint });
  assert.equal(commands.filter(command => command.kind === 'run').length, 1);
  assert.ok(!commands.some(command => command.id === 'script:test'));
});

test('ops环境菜单优先明确dev脚本，旧保存配置不改写且每环境至多一个启动和构建', async t => {
  const f = await fixture(t);
  await f.manifest({ packageManager: 'pnpm@10.8.0', scripts: {
    dev: 'vite --port 7332 --mode development', 'dev:workbench': 'vite --port 7334 --mode development',
    'dev:dev': 'vite --port 7332 --mode dev', 'dev:test': 'vite --port 7332 --mode test',
    'dev:pre': 'vite --port 7332 --mode pre', 'dev:prod': 'vite --port 7332 --mode production',
    'build:dev': 'pnpm typecheck && vite build --mode dev', 'build:test': 'pnpm typecheck && vite build --mode test',
    'build:pre': 'pnpm typecheck && vite build --mode pre', build: 'pnpm typecheck && vite build --mode production',
    test: 'vitest run', 'test:watch': 'vitest', lint: 'eslint src', typecheck: 'vue-tsc --noEmit',
  } });
  await fs.writeFile(path.join(f.workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  const project = await discoverProject(f.workspace);
  const configs = project.defaultConfigs.map(config => config.script === 'dev:dev'
    ? { ...config, id: 'saved-dev', name: '已有开发配置', packageManager: 'yarn' as const, port: 7999, protocol: 'https' as const } : config);
  configs.push({ ...configs.find(config => config.script === 'dev:dev')!, id: 'duplicate-dev', port: 8000 });
  const before = structuredClone(configs), commands = projectCommands(project, configs);
  assert.deepEqual(commands.filter(command => command.kind !== 'install').map(command => [command.kind, command.environment, command.script]), [
    ['run', 'dev', 'dev:dev'], ['build', 'dev', 'build:dev'], ['run', 'test', 'dev:test'], ['build', 'test', 'build:test'],
    ['run', 'pre', 'dev:pre'], ['build', 'pre', 'build:pre'], ['run', 'prod', 'dev:prod'], ['build', 'prod', 'build'],
  ]);
  const development = commands.find(command => command.kind === 'run' && command.environment === 'dev')!;
  assert.equal(development.configId, 'saved-dev'); assert.equal(development.id, 'run:saved-dev');
  assert.equal(development.name, '已有开发配置'); assert.equal(development.command, 'yarn run dev:dev');
  assert.equal(commands[0].command, 'pnpm install --frozen-lockfile'); assert.equal(commands[0].environment, undefined);
  assert.deepEqual(configs, before);
  assert.deepEqual(project.defaultConfigs.map(config => config.script), ['dev', 'dev:workbench', 'dev:dev', 'dev:test', 'dev:pre', 'dev:prod']);
  const withoutExplicitDev = projectCommands(project, configs.filter(config => config.script !== 'dev:dev'));
  assert.equal(withoutExplicitDev.find(command => command.kind === 'run' && command.environment === 'dev')!.script, 'dev');
  assert.deepEqual(withoutExplicitDev[0], commands[0], '安装不受所选环境或启动配置影响');
});

test('商户与旧admin构建按真实legacy脚本映射，标准构建优先且不会把单测当构建', async t => {
  const f = await fixture(t);
  const scripts = {
    dev: 'node static-check.js && uni', 'dev:test': 'node static-check.js && uni --mode test',
    'dev:i18n-test': 'node static-check.js && uni --mode i18n-test', 'dev:pre': 'node static-check.js && uni --mode pre',
    'dev:prod': 'node static-check.js && uni --mode production',
    develop: 'node scripts/fetch-lang.js && uni build --mode development', test: 'node scripts/fetch-lang.js && uni build --mode test',
    'i18n-test': 'node scripts/fetch-lang.js && uni build --mode i18n-test', pre: 'node scripts/fetch-lang.js && uni build --mode pre',
    'build:prod': 'node scripts/fetch-lang.js && uni build --mode production', build: 'node scripts/fetch-lang.js && uni build --mode production',
  };
  await f.manifest({ scripts }); await fs.writeFile(path.join(f.workspace, 'package-lock.json'), '{}');
  let project = await discoverProject(f.workspace), commands = projectCommands(project, project.defaultConfigs);
  assert.deepEqual(commands.filter(command => command.kind === 'build').map(command => [command.environment, command.script]), [
    ['dev', 'develop'], ['test', 'test'], ['i18n-test', 'i18n-test'], ['pre', 'pre'], ['prod', 'build:prod'],
  ]);
  assert.equal(commands[0].command, 'npm ci');
  const legacyAdmin: Record<string, string> = { ...scripts }; delete legacyAdmin['build:prod'];
  await f.manifest({ scripts: { ...legacyAdmin, develop: 'node static-check.cjs && vite build --mode dev',
    'build:test': 'vite build --mode test', test: 'vitest run', pre: 'node check-pre.js', 'i18n-test': 'node check-i18n.js' } });
  project = await discoverProject(f.workspace); commands = projectCommands(project, project.defaultConfigs);
  assert.deepEqual(commands.filter(command => command.kind === 'build').map(command => [command.environment, command.script]), [
    ['dev', 'develop'], ['test', 'build:test'], ['prod', 'build'],
  ]);
  assert.ok(commands.filter(command => command.kind !== 'install').every(command => Object.hasOwn(project.scriptCommands, command.script!)));
});

test('启动只选真实启动脚本，生产别名归一且未知或矛盾mode不冒充所选环境', async t => {
  const f = await fixture(t);
  await f.manifest({ scripts: {
    dev: 'vite build --mode development', start: 'vite preview', serve: 'vue-cli-service serve --mode development',
    'dev:production': 'node check.cjs && vite --mode="production"', 'dev:test': 'vite --mode production',
    'dev:i18n-test': 'vite --mode $RUNTIME_MODE', 'dev:pre': 'vitest run', 'dev:workbench': 'vite --mode development',
    'build:production': 'vite build', 'build:pre': 'vite build --mode production',
  } });
  let project = await discoverProject(f.workspace), commands = projectCommands(project, project.defaultConfigs);
  assert.deepEqual(commands.filter(command => command.kind !== 'install').map(command => [command.kind, command.environment, command.script]), [
    ['run', 'dev', 'serve'], ['run', 'prod', 'dev:production'], ['build', 'prod', 'build:production'],
  ]);
  await f.manifest({ scripts: { start: 'next start' } });
  project = await discoverProject(f.workspace); commands = projectCommands(project, project.defaultConfigs);
  assert.deepEqual(commands.filter(command => command.kind === 'run').map(command => [command.environment, command.script]), [['prod', 'start']]);
  await f.manifest({ scripts: { start: 'node server.js', build: 'node build.js' } });
  project = await discoverProject(f.workspace); commands = projectCommands(project, project.defaultConfigs);
  assert.deepEqual(commands.filter(command => command.kind !== 'install').map(command => [command.kind, command.environment, command.script]), [
    ['run', 'dev', 'start'], ['build', 'prod', 'build'],
  ]);
});

test('安装优先真实包管理器声明，再检查对应锁文件，Yarn版本控制冻结参数', async t => {
  const f = await fixture(t);
  const cases: { manager?: string; files: Record<string, string>; expected: string }[] = [
    { manager: 'npm@10.9.0', files: { 'package-lock.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 9' }, expected: 'npm ci' },
    { manager: 'npm@10.9.0', files: { 'pnpm-lock.yaml': 'lockfileVersion: 9' }, expected: 'npm install' },
    { files: { 'pnpm-lock.yaml': 'lockfileVersion: 9', 'yarn.lock': '# yarn lockfile v1' }, expected: 'pnpm install --frozen-lockfile' },
    { manager: 'yarn@1.22.22', files: { 'yarn.lock': '# yarn lockfile v1' }, expected: 'yarn install --frozen-lockfile' },
    { manager: 'yarn@4.6.0', files: { 'yarn.lock': '__metadata:\n  version: 8' }, expected: 'yarn install --immutable' },
    { files: { 'yarn.lock': '__metadata:\n  version: 8' }, expected: 'yarn install --immutable' },
    { manager: 'yarn@4.6.0', files: {}, expected: 'yarn install' },
    { files: { 'npm-shrinkwrap.json': '{}' }, expected: 'npm ci' },
    { files: {}, expected: 'npm install' },
  ];
  for (const entry of cases) {
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) await fs.rm(path.join(f.workspace, name), { force: true });
    await f.manifest({ ...(entry.manager ? { packageManager: entry.manager } : {}), scripts: { dev: 'vite' } });
    for (const [name, text] of Object.entries(entry.files)) await fs.writeFile(path.join(f.workspace, name), text);
    const project = await discoverProject(f.workspace);
    assert.equal(projectCommands(project, [])[0].command, entry.expected);
  }
});

test('仅在明确匹配的monorepo边界继承管理器和锁，不继承无关父目录或跨Git边界', async t => {
  const f = await fixture(t), monorepo = path.join(f.root, 'monorepo'), child = path.join(monorepo, 'apps', 'web');
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(path.join(child, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  await fs.writeFile(path.join(monorepo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.1' }));
  await fs.writeFile(path.join(monorepo, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - '!apps/excluded'\n");
  await fs.writeFile(path.join(monorepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  let discovered = await discoverProject(child);
  assert.equal(discovered.packageManager, 'pnpm'); assert.equal(discovered.packageManagerVersion, '9.15.1');
  assert.equal(discovered.lockfile, path.join(monorepo, 'pnpm-lock.yaml'));
  assert.deepEqual(discovered.installArgs, ['install', '--frozen-lockfile']);
  const inheritedInstall = projectCommands(discovered, [])[0].fingerprint;
  await fs.writeFile(path.join(monorepo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.1', scripts: { postinstall: 'node changed-root-hook.js' } }));
  assert.notEqual(projectCommands(await discoverProject(child), [])[0].fingerprint, inheritedInstall, '根包真实安装脚本变化也使继承命令指纹过期');
  await fs.mkdir(path.join(child, '.git'));
  assert.equal((await discoverProject(child)).packageManager, 'npm');
  await fs.rm(path.join(child, '.git'), { recursive: true });
  await fs.writeFile(path.join(child, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.0', scripts: { dev: 'vite' } }));
  assert.equal((await discoverProject(child)).packageManager, 'npm', '本项目明确声明不被根包覆盖');
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0' }));
  await f.manifest({ scripts: { dev: 'vite' } });
  assert.equal((await discoverProject(f.workspace)).packageManager, 'npm', '仅父目录有packageManager不能证明workspace归属');
  await fs.rm(path.join(monorepo, 'pnpm-workspace.yaml'));
  await fs.writeFile(path.join(monorepo, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', workspaces: ['apps/*'] }));
  await fs.rm(path.join(monorepo, 'pnpm-lock.yaml')); await fs.writeFile(path.join(monorepo, 'yarn.lock'), '__metadata:\n  version: 8');
  await fs.writeFile(path.join(child, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  discovered = await discoverProject(child); assert.equal(discovered.packageManager, 'yarn');
  assert.deepEqual(discovered.installArgs, ['install', '--immutable']);
});

test('端口优先脚本参数和PORT，其次静态Vite配置，再使用框架默认；未知有明确fallback标记', async t => {
  const f = await fixture(t);
  await f.manifest({ scripts: { dev: 'vite --port 7301', 'dev:short': 'vite -p7302', 'dev:env': 'cross-env PORT=7303 vite',
    'dev:config': 'vite', 'dev:unknown': 'vite --port $RUNTIME_PORT', 'dev:next': 'next dev', 'dev:react': 'react-scripts start', serve: 'node opaque-server.js' } });
  await fs.writeFile(path.join(f.workspace, 'vite.config.ts'), "import ssl from '@vitejs/plugin-basic-ssl'; export default defineConfig({ plugins: [ssl()], server: { port: 7304, https: {} } });");
  const project = await discoverProject(f.workspace), byScript = Object.fromEntries(project.defaultConfigs.map(config => [config.script, config]));
  assert.equal(byScript.dev.port, 7301); assert.equal(byScript['dev:short'].port, 7302); assert.equal(byScript['dev:env'].port, 7303);
  assert.equal(byScript['dev:config'].port, 7304); assert.equal(byScript['dev:config'].protocol, 'https');
  assert.equal(byScript['dev:unknown'].port, 5173); assert.equal(project.inferences['dev:unknown'].port, 'fallback');
  assert.equal(byScript['dev:next'].port, 3000); assert.equal(byScript['dev:react'].port, 3000);
  await fs.rm(path.join(f.workspace, 'vite.config.ts'));
  const opaque = await discoverProject(f.workspace);
  assert.equal(opaque.defaultConfigs.find(config => config.script === 'serve')!.port, 5173);
  assert.equal(opaque.inferences.serve.port, 'fallback');
  for (const source of [
    'export default defineConfig(() => { if (process.env.MODE) return {server:{port:7333}}; return {server:{port:7444}}; });',
    'export default {server:{port:7333}, ...dynamicConfig()};',
  ]) {
    await fs.writeFile(path.join(f.workspace, 'vite.config.ts'), source);
    const dynamic = await discoverProject(f.workspace);
    assert.equal(dynamic.defaultConfigs.find(config => config.script === 'dev:config')!.port, 5173);
    assert.equal(dynamic.inferences['dev:config'].port, 'fallback');
  }
});

test('指纹绑定脚本正文、生命周期、包管理器版本、锁文件和实际保存配置', async t => {
  const f = await fixture(t); const value = { packageManager: 'pnpm@9.15.0', scripts: { dev: 'vite', build: 'node original.js', prebuild: 'node before.js' } };
  await f.manifest(value); await fs.writeFile(path.join(f.workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  const first = await discoverProject(f.workspace), before = projectCommands(first, first.defaultConfigs);
  assert.deepEqual(projectCommands(first, first.defaultConfigs), before);
  await f.manifest({ ...value, scripts: { ...value.scripts, build: 'node changed.js' } });
  let next = await discoverProject(f.workspace);
  assert.notEqual(projectCommands(next, next.defaultConfigs).find(command => command.id === 'script:build')!.fingerprint, before.find(command => command.id === 'script:build')!.fingerprint);
  await f.manifest({ ...value, scripts: { ...value.scripts, prebuild: 'node changed-hook.js' } });
  next = await discoverProject(f.workspace);
  assert.notEqual(projectCommands(next, next.defaultConfigs).find(command => command.id === 'script:build')!.fingerprint, before.find(command => command.id === 'script:build')!.fingerprint);
  await f.manifest({ ...value, packageManager: 'pnpm@10.0.0' }); next = await discoverProject(f.workspace);
  assert.notEqual(projectCommands(next, [])[0].fingerprint, before[0].fingerprint);
  await f.manifest(value); await fs.writeFile(path.join(f.workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nchanged: true');
  next = await discoverProject(f.workspace); assert.notEqual(projectCommands(next, [])[0].fingerprint, before[0].fingerprint);
  assert.notEqual(projectCommands(first, [{ ...first.defaultConfigs[0], port: 7999 }])[1].fingerprint, before[1].fingerprint);
});

test('发现只读JSON与静态配置，不执行项目JS、不读取.env或跟随外部配置链接', async t => {
  const f = await fixture(t), marker = path.join(f.root, 'must-not-execute');
  await f.manifest({ scripts: { dev: 'vite' } });
  await fs.writeFile(path.join(f.workspace, '.env'), 'PORT=9999\nSECRET=PRIVATE_DOTENV');
  const source = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default { server: { port: Number(process.env.PORT) }, plugins: [basicSsl()] };`;
  await fs.writeFile(path.join(f.workspace, 'vite.config.js'), source);
  const before = await fs.readdir(f.workspace);
  let project = await discoverProject(f.workspace);
  assert.equal(project.defaultConfigs[0].port, 5173); assert.equal(project.inferences.dev.port, 'fallback');
  assert.equal(project.defaultConfigs[0].protocol, 'https');
  await assert.rejects(fs.access(marker)); assert.deepEqual(await fs.readdir(f.workspace), before);
  assert.equal(await fs.readFile(path.join(f.workspace, 'vite.config.js'), 'utf8'), source);
  assert.doesNotMatch(JSON.stringify(projectCommands(project, project.defaultConfigs)), /PRIVATE_DOTENV|must-not-execute/);
  await fs.rm(path.join(f.workspace, 'vite.config.js'));
  await fs.symlink(path.join(f.workspace, '.env'), path.join(f.workspace, 'vite.config.js'));
  project = await discoverProject(f.workspace); assert.equal(project.defaultConfigs[0].protocol, 'http');
  await assert.rejects(discoverProject('relative/project'), /绝对路径/);
});

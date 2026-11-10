import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import type { LaunchConfig, ProjectCommand, ProjectEnvironment } from '../shared/project-launch.js';

const scriptName = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/;
const dangerousName = /(?:^|[:._-])(?:deploy|publish|release|upload)(?:$|[:._-])/i;
const managers = ['npm', 'pnpm', 'yarn'] as const;
const lockNames = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const displayNames: Record<string, string> = { dev: '开发', 'dev:test': '测试', 'dev:i18n-test': '国际化测试', 'dev:pre': '预发', 'dev:prod': '生产接口', start: '默认启动', serve: '本地服务' };
type Manifest = Record<string, unknown>;
type Manager = LaunchConfig['packageManager'];
type Inference = { port: 'script' | 'vite-config' | 'framework' | 'fallback'; protocol: 'script' | 'vite-config' | 'fallback' };
export type DiscoveredProject = {
  workspacePath: string; scripts: string[]; scriptCommands: Record<string, string>; packageManager: Manager;
  packageManagerVersion: string; packageManagerDeclaration: string; managerSource: string; manifestHash: string;
  defaultConfigs: LaunchConfig[]; installArgs: string[]; lockfile: string; lockfileHash: string;
  inferences: Record<string, Inference>;
};

async function readOptional(filename: string) {
  const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  return stat?.isFile() && !stat.isSymbolicLink() ? fs.readFile(filename, 'utf8') : undefined;
}
async function metadata(directory: string) {
  const manifestText = await readOptional(path.join(directory, 'package.json'));
  let manifest: Manifest = {};
  if (manifestText !== undefined) {
    const parsed: unknown = JSON.parse(manifestText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('项目 package.json 格式不正确');
    manifest = parsed as Manifest;
  }
  const locks = new Map<string, string>();
  for (const name of lockNames) { const text = await readOptional(path.join(directory, name)); if (text !== undefined) locks.set(name, text); }
  return { directory, manifest, manifestText, locks };
}
function declaredManager(manifest: Manifest) {
  if (typeof manifest.packageManager !== 'string' || !manifest.packageManager.trim()) return undefined;
  const match = /^(npm|pnpm|yarn)@([^\s]+)$/.exec(manifest.packageManager.trim());
  if (!match) throw new Error('项目 packageManager 仅支持 npm、pnpm 或 yarn 的版本声明');
  return { name: match[1] as Manager, version: match[2], declaration: match[0] };
}
function lockManager(locks: Map<string, string>): Manager | undefined {
  return locks.has('pnpm-lock.yaml') ? 'pnpm' : locks.has('yarn.lock') ? 'yarn'
    : locks.has('package-lock.json') || locks.has('npm-shrinkwrap.json') ? 'npm' : undefined;
}
async function workspaceAncestor(workspacePath: string) {
  if (await fs.lstat(path.join(workspacePath, '.git')).then(() => true, () => false)) return;
  let directory = path.dirname(workspacePath);
  for (let depth = 0; depth < 8 && directory !== path.dirname(directory) && directory !== os.homedir(); depth++, directory = path.dirname(directory)) {
    if (path.basename(directory) === 'node_modules') return;
    const current = await metadata(directory).catch(() => undefined);
    if (!current) return;
    const yaml = await readOptional(path.join(directory, 'pnpm-workspace.yaml'));
    const workspaces = current.manifest.workspaces;
    let patterns: unknown = Array.isArray(workspaces) ? workspaces
      : workspaces && typeof workspaces === 'object' ? (workspaces as { packages?: unknown }).packages : undefined;
    if (yaml !== undefined) {
      try { patterns = (parseYaml(yaml) as { packages?: unknown } | null)?.packages; }
      catch { return; }
    }
    if (Array.isArray(patterns)) {
      const relative = path.relative(directory, workspacePath).split(path.sep).join('/');
      const strings = patterns.filter((value): value is string => typeof value === 'string');
      const matched = strings.some(value => !value.startsWith('!') && path.matchesGlob(relative, value))
        && !strings.some(value => value.startsWith('!') && path.matchesGlob(relative, value.slice(1)));
      return matched ? { ...current, pnpmWorkspace: yaml !== undefined } : undefined;
    }
    if (yaml !== undefined || workspaces !== undefined || await fs.lstat(path.join(directory, '.git')).then(() => true, () => false)) return;
  }
}

function viteSettings(source: string) {
  const tree = ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true);
  const variables = new Map<string, ts.Expression>();
  for (const statement of tree.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) variables.set(declaration.name.text, declaration.initializer);
  }
  function object(node: ts.Node | undefined, depth = 0): ts.ObjectLiteralExpression | undefined {
    if (!node || depth > 5) return;
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return object(node.expression, depth + 1);
    if (ts.isIdentifier(node)) return object(variables.get(node.text), depth + 1);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineConfig') return object(node.arguments[0], depth + 1);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (!ts.isBlock(node.body)) return object(node.body, depth + 1);
      if (node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0])) return object(node.body.statements[0].expression, depth + 1);
    }
  }
  const config = object(tree.statements.find(ts.isExportAssignment)?.expression);
  const property = (node: ts.ObjectLiteralExpression | undefined, name: string) => node?.properties.some(ts.isSpreadAssignment) ? undefined
    : node && [...node.properties].reverse().find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)?.initializer;
  const server = object(property(config, 'server')), portNode = property(server, 'port'), https = property(server, 'https');
  const port = portNode && ts.isNumericLiteral(portNode) ? Number(portNode.text) : undefined;
  const sslNames = new Set(['basicSsl']);
  for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === '@vitejs/plugin-basic-ssl' && statement.importClause?.name) sslNames.add(statement.importClause.name.text);
  const plugins = property(config, 'plugins');
  const basicSsl = plugins && ts.isArrayLiteralExpression(plugins) && plugins.elements.some(node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && sslNames.has(node.expression.text));
  const protocol = https?.kind === ts.SyntaxKind.FalseKeyword ? 'http'
    : https && (https.kind === ts.SyntaxKind.TrueKeyword || ts.isObjectLiteralExpression(https)) || basicSsl ? 'https' : undefined;
  return { port: port && port >= 1 && port <= 65535 ? port : undefined, protocol: protocol as LaunchConfig['protocol'] | undefined };
}
function scriptSettings(command: string) {
  const flag = /(?:^|\s)(?:--port(?:=|\s+)|-p(?:=|\s*))(["']?)(\d+)\1(?=\s|$|[;&|])/.exec(command);
  const hasPortFlag = /(?:^|\s)(?:--port(?:=|\s|$)|-p(?:\s|=|\d|$))/.test(command);
  const environment = /(?:^|\s)PORT=(["']?)(\d+)\1(?=\s|$|[;&|])/.exec(command);
  const number = flag ? Number(flag[2]) : !hasPortFlag && environment ? Number(environment[2]) : undefined;
  const protocol = /(?:^|\s)(?:--(?:experimental-)?https(?:\s|$)|HTTPS=["']?true["']?(?:\s|$))/.test(command) ? 'https'
    : /(?:^|\s)HTTPS=["']?false["']?(?:\s|$)/.test(command) ? 'http' : undefined;
  return { port: number && number >= 1 && number <= 65535 ? number : undefined, hasPortFlag, protocol: protocol as LaunchConfig['protocol'] | undefined };
}

export async function discoverProject(inputPath: string): Promise<DiscoveredProject> {
  if (!path.isAbsolute(inputPath)) throw new Error('请选择本机项目的绝对路径');
  const workspacePath = await fs.realpath(inputPath).catch(() => { throw new Error('项目目录不存在'); });
  if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error('请选择有效的项目目录');
  const own = await metadata(workspacePath).catch(() => { throw new Error('项目 package.json 无法读取'); });
  if (own.manifestText === undefined) throw new Error('项目 package.json 无法读取');
  const declaration = declaredManager(own.manifest);
  const ancestor = !declaration && !own.locks.size ? await workspaceAncestor(workspacePath) : undefined;
  const inherited = ancestor ? declaredManager(ancestor.manifest) : undefined;
  const packageManager = declaration?.name || lockManager(own.locks) || inherited?.name || (ancestor?.pnpmWorkspace ? 'pnpm' : ancestor && lockManager(ancestor.locks)) || 'npm';
  const selected = declaration || inherited;
  const managerSource = declaration || own.locks.size ? workspacePath : ancestor?.directory || workspacePath;
  const locks = managerSource === workspacePath ? own.locks : ancestor!.locks;
  const lockName = packageManager === 'pnpm' ? 'pnpm-lock.yaml' : packageManager === 'yarn' ? 'yarn.lock'
    : locks.has('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const lock = locks.get(lockName);
  const yarnModern = selected?.name === 'yarn' && Number.parseInt(selected.version, 10) >= 2 || packageManager === 'yarn' && /^__metadata\s*:/m.test(lock || '');
  const installArgs = packageManager === 'npm' && lock !== undefined ? ['ci'] : ['install', ...(lock === undefined ? []
    : packageManager === 'yarn' && yarnModern ? ['--immutable'] : ['--frozen-lockfile'])];
  const sourceScripts = own.manifest.scripts && typeof own.manifest.scripts === 'object' && !Array.isArray(own.manifest.scripts) ? own.manifest.scripts : {};
  const scriptCommands = Object.fromEntries(Object.entries(sourceScripts).filter(([name, command]) => scriptName.test(name) && typeof command === 'string' && command.trim())) as Record<string, string>;
  const scripts = Object.keys(scriptCommands), inferences: DiscoveredProject['inferences'] = {};
  const viteSources = (await Promise.all(['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']
    .map(name => readOptional(path.join(workspacePath, name))))).filter((source): source is string => source !== undefined);
  const vite = viteSources.length === 1 ? viteSettings(viteSources[0]) : { port: undefined, protocol: undefined };
  const defaultConfigs = scripts.filter(script => /^(?:dev|start|serve)(?::[\w.-]+)*$/.test(script) && !dangerousName.test(script)).map(script => {
    const command = scriptCommands[script], explicit = scriptSettings(command);
    const isVite = /(?:^|[\s;&|])vite(?:\s|$)/.test(command);
    const framework = /(?:^|[\s;&|])(?:next\s+(?:dev|start)|react-scripts\s+start)(?:\s|$)/.test(command) ? 3000
      : /(?:^|[\s;&|])vue-cli-service\s+serve(?:\s|$)/.test(command) ? 8080 : undefined;
    const configPort = !explicit.hasPortFlag && (isVite || !framework) ? vite.port : undefined;
    const port = explicit.port || configPort || (!explicit.hasPortFlag ? framework : undefined) || 5173;
    const protocol = explicit.protocol || ((isVite || !framework) ? vite.protocol : undefined) || 'http';
    inferences[script] = { port: explicit.port ? 'script' : configPort ? 'vite-config' : framework && !explicit.hasPortFlag ? 'framework' : 'fallback',
      protocol: explicit.protocol ? 'script' : vite.protocol && (isVite || !framework) ? 'vite-config' : 'fallback' };
    return { id: createHash('sha256').update(script).digest('hex').slice(0, 24), name: displayNames[script] || script, script, packageManager, port, protocol };
  });
  return { workspacePath, scripts, scriptCommands, packageManager, packageManagerVersion: selected?.version || '', packageManagerDeclaration: selected?.declaration || '',
    managerSource, manifestHash: digest([own.manifestText, ancestor?.manifestText]), defaultConfigs, installArgs, lockfile: lock !== undefined ? path.join(managerSource, lockName) : '',
    lockfileHash: lock !== undefined ? digest(lock) : '', inferences };
}

const environments: ProjectEnvironment[] = ['dev', 'test', 'i18n-test', 'pre', 'prod'];
const environmentAliases = (environment: ProjectEnvironment) => environment === 'dev' ? ['dev', 'development']
  : environment === 'prod' ? ['prod', 'production'] : [environment];
function normalizedEnvironment(value: string): ProjectEnvironment | undefined {
  return environments.find(environment => environmentAliases(environment).includes(value));
}
function commandMode(command: string): ProjectEnvironment | null | undefined {
  const modes = [...command.matchAll(/(?:^|\s)--mode(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)];
  if (!modes.length) return /(?:^|\s)--mode(?:=|\s|$)/.test(command) ? null : undefined;
  const values = modes.map(match => normalizedEnvironment(match[1] || match[2] || match[3]));
  return values[0] && values.every(value => value === values[0]) ? values[0] : null;
}
function frameworkCommands(command: string) {
  return [...command.matchAll(/(?:^|[\s;&|])(vite|uni|vue-cli-service|next|react-scripts)(?=\s|$)(?:\s+([^\s;&|]+))?/g)];
}
function isLaunchScript(command: string) {
  const frameworks = frameworkCommands(command);
  if (!frameworks.length) return !/(?:^|[\s;&|])(?:vitest|jest|eslint|tsc|vue-tsc)(?:\s|$)|(?:^|[\s;&|])node\s+--test(?:\s|$)/.test(command);
  return frameworks.every(([, framework, action]) => framework === 'vite' ? !action || action.startsWith('-') || ['dev', 'serve'].includes(action)
    : framework === 'uni' ? !action || action.startsWith('-') || action === 'dev'
      : framework === 'vue-cli-service' ? action === 'serve' : framework === 'next' ? action === 'dev' || action === 'start' : action === 'start');
}
function scriptEnvironment(script: string, command: string, kind: 'run' | 'build'): ProjectEnvironment | undefined {
  const mode = commandMode(command), suffix = script.includes(':') ? normalizedEnvironment(script.slice(script.indexOf(':') + 1)) : undefined;
  if (mode === null || mode && suffix && mode !== suffix) return;
  return mode || suffix || (kind === 'build' ? script === 'develop' ? 'dev' : normalizedEnvironment(script) || 'prod'
    : /(?:^|[\s;&|])next\s+start(?:\s|$)/.test(command) ? 'prod' : 'dev');
}

export function projectCommands(project: DiscoveredProject, configs: LaunchConfig[]): ProjectCommand[] {
  const fingerprint = (details: unknown) => digest({ manifest: project.manifestHash, manager: project.packageManager,
    version: project.packageManagerVersion || 'unknown', declaration: project.packageManagerDeclaration, managerSource: project.managerSource,
    lock: project.lockfileHash, details });
  const commands: ProjectCommand[] = [{ id: 'install', kind: 'install', name: '安装依赖', command: `${project.packageManager} ${project.installArgs.join(' ')}`,
    fingerprint: fingerprint({ kind: 'install', args: project.installArgs }) }];
  const validConfigs = configs.filter(config => scriptName.test(config.script) && !dangerousName.test(config.script)
    && Object.hasOwn(project.scriptCommands, config.script) && managers.includes(config.packageManager) && /^[A-Za-z0-9_-]{1,80}$/.test(config.id));
  // 只投影操作菜单；保留原配置和编号，使已启动的旧配置仍可查询、停止。
  for (const environment of environments) {
    const aliases = environmentAliases(environment);
    const namedRuns = ['dev', 'start', 'serve'].flatMap(prefix => aliases.map(alias => `${prefix}:${alias}`));
    const runScripts = environment === 'dev' ? ['dev:dev', 'dev', 'start', 'serve', ...namedRuns] : [...namedRuns, 'dev', 'start', 'serve'];
    const config = runScripts.map(script => validConfigs.find(item => item.script === script && isLaunchScript(project.scriptCommands[script])
      && scriptEnvironment(script, project.scriptCommands[script], 'run') === environment)).find(Boolean);
    if (config) commands.push({ id: `run:${config.id}`, kind: 'run', name: config.name, configId: config.id, script: config.script, environment,
      command: `${config.packageManager} run ${config.script}`, fingerprint: fingerprint({ kind: 'run', environment, config, body: project.scriptCommands[config.script] }) });
    const legacy = environment === 'dev' ? 'develop' : environment === 'prod' ? undefined : environment;
    const buildScripts = [...aliases.map(alias => `build:${alias}`), ...(legacy ? [legacy] : []), 'build'];
    const script = buildScripts.find(name => Object.hasOwn(project.scriptCommands, name)
      && (name !== legacy || frameworkCommands(project.scriptCommands[name]).some(([, , action]) => action === 'build'))
      && scriptEnvironment(name, project.scriptCommands[name], 'build') === environment);
    if (script) commands.push({ id: `script:${script}`, kind: 'build', name: script, script, environment, command: `${project.packageManager} run ${script}`,
      fingerprint: fingerprint({ kind: 'build', environment, script, body: project.scriptCommands[script] }) });
  }
  return commands;
}

import { readCatalogRemote, type CatalogSource } from './catalog-transport.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { pluginManifestSchema, capabilitySchema } from '../../shared/custom-plugins.js';
import { fingerprint, privateJson, readJson, type CustomPluginRuntime } from './custom-runtime.js';
import { readApplicationPackage } from './application-package.js';

const maxBytes = 41_000_000, maxCatalog = 2_000_000;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const releaseSchema = z.object({ id: z.string(), version: z.string(), manifest: pluginManifestSchema, package: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.dwp$/), sha256: hashSchema }).strict();
const catalogSchema = z.object({ protocol: z.literal(1), releases: z.array(releaseSchema).max(500) }).strict();
type Source = CatalogSource;
type Task = { id: string; status: 'awaiting-confirmation' | 'installing' | 'installed' | 'failed' | 'cancelled'; token: string; createdAt: number; source: string; directory: string; digest: string; permissionsDigest: string; manifest: z.infer<typeof pluginManifestSchema>; replaceDigest?: string; message?: string };

/** Constrained JSON envelope, not a general archive: no paths, links, scripts or install hooks. */
export async function unpackRelease(bytes: Buffer, directory: string) {
  if (bytes.length > maxBytes) throw new Error('发布包超过大小上限');
  const input = z.object({ format: z.literal('delivery-plugin/1'), files: z.record(z.string(), z.string()) }).strict().parse(JSON.parse(bytes.toString('utf8')));
  const names = Object.keys(input.files);
  if (!names.includes('plugin.json') || names.some(n => !['plugin.json', 'ui.js', 'ui.css', 'server.mjs'].includes(n))) throw new Error('发布包包含非法文件路径或未支持文件');
  let total = 0;
  const files: Record<string, Buffer> = Object.create(null);
  for (const [name, encoded] of Object.entries(input.files)) {
    const content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded || content.length > (name === 'plugin.json' ? 64_000 : 15_000_000) || (total += content.length) > 30_000_000) throw new Error('发布包编码或大小无效');
    files[name] = content;
  }
  const manifest = pluginManifestSchema.parse(JSON.parse(files['plugin.json'].toString('utf8')));
  const expected = manifest.application ? ['plugin.json', ...Object.values(manifest.application)] : ['plugin.json'];
  if (expected.length !== names.length || expected.some(n => !files[n])) throw new Error('发布包入口不完整');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
  return manifest;
}

async function localBytes(file: string, limit: number) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('必须选择大小受限的普通文件，不允许符号链接');
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new Error('文件超过大小上限');
  return bytes;
}

export function createPluginDistribution(runtime: CustomPluginRuntime, directory: string, sources: Source[] | (() => Promise<Source[]>), stop: (id: string) => void, remoteReader: typeof readCatalogRemote = readCatalogRemote) {
  const getSources = () => typeof sources === 'function' ? sources() : Promise.resolve(sources);
  const remote = (source: Source) => !!source.transport || /^https?:/.test(source.location);
  const busy = new Set<string>();
  const taskPath = (id: string) => path.join(directory, z.uuid().parse(id) + '.json');
  const load = async (id: string): Promise<Task> => { const value = await readJson(taskPath(id), null); if (!value) throw new Error('安装任务不存在或已过期'); return value; };
  const save = (task: Task) => privateJson(taskPath(task.id), task);
  async function catalog(source: Source) {
    if (source.error) throw new Error(source.error);
    const bytes = remote(source) ? await remoteReader(source, maxCatalog) : await localBytes(source.location, maxCatalog);
    const value = catalogSchema.parse(JSON.parse(bytes.toString('utf8')));
    for (const r of value.releases) if (r.id !== r.manifest.id || r.version !== r.manifest.version) throw new Error('目录身份与发布声明不一致');
    if (new Set(value.releases.map(r => `${r.id}@${r.version}`)).size !== value.releases.length) throw new Error('目录包含重复版本');
    return value;
  }
  async function getTask(id: string) {
    const task = await load(id);
    if (task.status === 'installing' && !busy.has(id)) {
      const installed = runtime.list().plugins.find(p => p.manifest.id === task.manifest.id);
      task.status = installed?.digest === task.digest ? 'installed' : 'failed';
      task.message = '宿主曾中断，请核对安装状态；未自动重放'; await save(task);
    }
    if (task.status === 'awaiting-confirmation' && Date.now() - task.createdAt > 15 * 60_000) { task.status = 'cancelled'; task.message = '预览已过期，请重新检查'; await save(task); await fs.rm(task.directory, { recursive: true, force: true }); }
    return task;
  }
  async function cleanup() {
    const entries = await fs.readdir(directory).catch(() => []);
    let awaiting = 0;
    for (const name of entries) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const task = await getTask(name.slice(0, -5));
      if (task.status === 'awaiting-confirmation') awaiting++;
    }
    return awaiting;
  }
  const janitor = setInterval(() => { void cleanup().catch(() => {}); }, 60_000); janitor.unref();
  return {
    close() { clearInterval(janitor); },
    async catalogs() {
      const results = await Promise.all((await getSources()).map(async source => { try { return { id: source.id, name: source.name, location: source.location, ...(await catalog(source)) }; } catch (error) { return { id: source.id, name: source.name, releases: [], error: error instanceof Error ? error.message : '目录不可达' }; } }));
      return { protocol: 1, sources: results };
    },
    getTask,
    async checkConnection(source: Source) { const result = await catalog(source); return { message: `市场连接成功，读取到 ${result.releases.length} 个发布版本` }; },
    async preview(raw: unknown) {
      if (await cleanup() >= 32) throw new Error('待确认安装过多，请取消旧预览后重试');
      const input = z.union([
        z.object({ localPath: z.string().max(4000) }).strict(),
        z.object({ catalogId: z.string(), id: z.string(), version: z.string(), sha256: hashSchema }).strict(),
      ]).parse(raw);
      const id = randomUUID(), staging = path.join(directory, id + '.package');
      let source: string, expected: z.infer<typeof releaseSchema> | undefined;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        if ('localPath' in input) {
          if (!path.isAbsolute(input.localPath)) throw new Error('请选择绝对路径');
          source = input.localPath;
          const stat = await fs.lstat(source);
          if (stat.isSymbolicLink()) throw new Error('不允许符号链接包');
          if (stat.isDirectory()) {
            const checked = await runtime.inspect(source);
            const assets = await readApplicationPackage(source, checked.manifest);
            await fs.mkdir(staging, { mode: 0o700 });
            await fs.writeFile(path.join(staging, 'plugin.json'), JSON.stringify(checked.manifest), { flag: 'wx', mode: 0o600 });
            for (const [name, data] of Object.entries(assets)) await fs.writeFile(path.join(staging, name), data, { flag: 'wx', mode: 0o600 });
            if ((await runtime.inspect(staging)).digest !== checked.digest) throw new Error('包在读取过程中变化');
          } else await unpackRelease(await localBytes(source, maxBytes), staging);
        } else {
          const origin = (await getSources()).find(s => s.id === input.catalogId); if (!origin) throw new Error('未配置该目录来源');
          expected = (await catalog(origin)).releases.find(r => r.id === input.id && r.version === input.version);
          if (!expected || expected.sha256 !== input.sha256) throw new Error('选定版本或目录摘要已经变化，请刷新目录');
          source = remote(origin) ? `${origin.transport || 'http'}: ${origin.location} / ${expected.package}` : path.join(path.dirname(origin.location), expected.package);
          const bytes = remote(origin) ? await remoteReader(origin, maxBytes, expected.package) : await localBytes(source, maxBytes);
          if (sha(bytes) !== expected.sha256) throw new Error('发布包摘要校验失败');
          await unpackRelease(bytes, staging);
        }
        const checked = await runtime.inspect(staging);
        if (expected && fingerprint(checked.manifest) !== fingerprint(expected.manifest)) throw new Error('发布包声明与目录元数据不一致');
        const previous = runtime.list().plugins.find(p => p.manifest.id === checked.manifest.id);
        const task: Task = { id, createdAt: Date.now(), status: 'awaiting-confirmation', token: randomUUID(), source, directory: staging, manifest: checked.manifest, digest: checked.digest, permissionsDigest: fingerprint({ permissions: checked.manifest.permissions, capabilities: checked.manifest.capabilities, consumes: checked.manifest.consumes, provides: checked.manifest.provides }), ...(previous ? { replaceDigest: previous.digest } : {}) };
        await save(task); return { ...task, currentGrants: (previous?.grants || []).filter(grant => {
          const before = previous?.manifest.capabilities?.find(c => c.id === grant), after = checked.manifest.capabilities?.find(c => c.id === grant);
          return fingerprint(before ?? null) === fingerprint(after ?? null) && (grant !== 'capabilities.call' || fingerprint(previous?.manifest.consumes ?? null) === fingerprint(checked.manifest.consumes ?? null));
        }) };
      } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
    },
    async cancel(id: string) {
      if (busy.has(id)) throw new Error('安装正在执行，请查询结果');
      const task = await getTask(id);
      if (task.status !== 'awaiting-confirmation') throw new Error('该任务不能取消');
      task.status = 'cancelled'; await save(task); await fs.rm(task.directory, { recursive: true, force: true }); return task;
    },
    async confirm(raw: unknown) {
      const input = z.object({ id: z.uuid(), token: z.uuid(), digest: hashSchema, permissionsDigest: hashSchema, grants: z.array(capabilitySchema), confirmed: z.literal(true), trustedLocalCode: z.boolean().default(false), showInMenu: z.boolean().default(false) }).strict().parse(raw);
      if (busy.has(input.id)) throw new Error('安装正在执行，请查询结果');
      busy.add(input.id);
      let task: Task | undefined;
      try {
        task = await getTask(input.id);
        if (task.status !== 'awaiting-confirmation' || task.token !== input.token || task.digest !== input.digest || task.permissionsDigest !== input.permissionsDigest) throw new Error('安装确认无效、已使用或已过期');
        if (task.manifest.application && !input.trustedLocalCode) throw new Error('必须单独确认本机代码信任');
        task.status = 'installing'; await save(task);
        await runtime.install({ directory: task.directory, digest: task.digest, grants: input.grants, confirmed: true, ...(input.trustedLocalCode ? { trustedLocalCode: true } : {}), showInMenu: input.showInMenu, ...(task.replaceDigest ? { replaceDigest: task.replaceDigest } : {}) });
        stop(task.manifest.id); task.status = 'installed'; await save(task); return task;
      } catch (error) {
        if (task?.status === 'installing') { task.status = 'failed'; task.message = error instanceof Error ? error.message : '安装失败，旧版本保留'; await save(task); await fs.rm(task.directory, { recursive: true, force: true }); }
        throw error;
      } finally { busy.delete(input.id); }
    },
  };
}
export type PluginDistribution = ReturnType<typeof createPluginDistribution>;

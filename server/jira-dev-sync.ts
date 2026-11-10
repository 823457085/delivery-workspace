/**
 * 设计说明：按 Jira 研发助手云更新站同步 server/jira-dev。
 * - 版本清单必须通过插件内置的 Ed25519 公钥校验；安装包同站 HTTPS、大小与 SHA-256 一致，解压后逐文件核对 MANIFEST.sha256。
 * - skills/ 直接取自已校验的安装包，下次启动会话即生效。
 * - 安装包只含打包后的 server.mjs，没有可单独替换的源码模块；同名 *.mjs 仅在本机插件源码版本与云端版本一致时同步，
 *   并先在临时副本中导入 index.mjs 校验导出完整，代码变化需重启服务后生效。
 * - 替换前备份到 .data/jira-dev/sync-backups；表单、启动流程等工作台改写部分不自动改动，结果中如实列出。
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export const jiraDevManifestUrl = 'https://jira-dev-workbench-updates.lizirui230.chatgpt.site/latest.json';
const publicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAx2Yk1e85KMd1m90FvhdD98by3zjNHpAhvRBoeRfk33c=
-----END PUBLIC KEY-----
`);
const baselineVersion = '1.2.1';
const maxManifestBytes = 64 * 1024, maxDownloadBytes = 30 * 1024 * 1024;
const semver = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

const releaseSchema = z.object({
  plugin: z.literal('jira-dev-workbench'), version: z.string().regex(semver), publishedAt: z.string(),
  notes: z.array(z.string().max(2000)).max(20),
  download: z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/i), size: z.number().int().positive().max(maxDownloadBytes) }),
  installation: z.object({ releaseRoot: z.string(), pluginDirectory: z.string() }).passthrough(),
}).passthrough();
type Release = z.infer<typeof releaseSchema>;
const stateSchema = z.object({ version: z.string().regex(semver), sha256: z.string(), syncedAt: z.string(), codeSource: z.string().optional() });
export const jiraDevSyncInputSchema = z.object({ expectedVersion: z.string().regex(semver), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();

function compare(left: string, right: string) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function exists(file: string) { try { await stat(file); return true; } catch { return false; } }
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  if (!await exists(root)) return [];
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`安装内容包含符号链接：${prefix}${entry.name}`);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(root, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile() && entry.name !== '.DS_Store') result.push(`${prefix}${entry.name}`);
  }
  return result.sort();
}
async function treeHashes(root: string) {
  return new Map(await Promise.all((await listFiles(root)).map(async name => [name, sha256(await readFile(path.join(root, name)))] as const)));
}

// 只用 Python 标准库解压：拒绝绝对路径、越界、符号链接与超限内容，只解到新建的临时目录。
const extractProgram = String.raw`
import os, pathlib, stat, sys, zipfile
archive, output, root_name = sys.argv[1:]
out = pathlib.Path(output); out.mkdir(mode=0o700)
total = 0
with zipfile.ZipFile(archive) as z:
    infos = z.infolist()
    if not 0 < len(infos) <= 2000: raise SystemExit('ZIP 文件数量异常')
    for info in infos:
        parts = info.filename.rstrip('/').split('/')
        if info.filename.startswith('/') or '\\' in info.filename or any(p in ('', '.', '..') for p in parts) or parts[0] != root_name: raise SystemExit('ZIP 包含不安全路径')
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1: raise SystemExit('ZIP 包含符号链接或加密内容')
        total += info.file_size
        if info.file_size > 32 * 1024 * 1024 or total > 100 * 1024 * 1024: raise SystemExit('ZIP 解压后大小超限')
        target = out.joinpath(*parts)
        if info.is_dir(): target.mkdir(parents=True, exist_ok=True); continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as src, open(target, 'xb') as dst:
            size = 0
            while chunk := src.read(65536):
                size += len(chunk)
                if size > info.file_size: raise SystemExit('ZIP 实际大小不符')
                dst.write(chunk)
`;

export function createJiraDevSync(options: { jiraDevDirectory?: string; dataDirectory: string; pluginSource?: string; fetchImpl?: typeof fetch; now?: () => Date }) {
  const jiraDevDirectory = options.jiraDevDirectory || path.join(path.dirname(fileURLToPath(import.meta.url)), 'jira-dev');
  const pluginSource = options.pluginSource || process.env.JIRA_DEV_PLUGIN_SOURCE || '';
  const fetchImpl = options.fetchImpl || fetch, now = options.now || (() => new Date());
  const stateFile = path.join(jiraDevDirectory, 'sync-state.json');
  const syncRoot = path.join(options.dataDirectory, 'jira-dev', 'sync');
  let running: Promise<unknown> | undefined;

  async function readState() {
    try { return stateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8'))); }
    catch { return { version: baselineVersion, sha256: '', syncedAt: '' }; }
  }
  async function download(url: string, limit: number) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`更新站响应异常（HTTP ${response.status}）`);
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > limit) throw new Error('下载内容超过大小限制');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('访问更新站超时，未改动当前版本');
      throw error instanceof Error && /HTTP|大小/.test(error.message) ? error : new Error('无法访问研发助手更新站，未改动当前版本');
    } finally { clearTimeout(timer); }
  }
  async function latest(): Promise<Release> {
    const envelope = z.object({ payload: z.string(), signature: z.string() }).strict().parse(JSON.parse((await download(jiraDevManifestUrl, maxManifestBytes)).toString('utf8')));
    const payload = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64 || !verify(null, payload, publicKey, signature)) throw new Error('更新清单签名校验失败，已拒绝同步');
    const release = releaseSchema.parse(JSON.parse(payload.toString('utf8')));
    if (new URL(release.download.url).origin !== new URL(jiraDevManifestUrl).origin || !release.download.url.startsWith('https://')) throw new Error('安装包必须来自同一更新站点');
    return release;
  }

  /** 本机插件源码：只在版本与目标一致时提供代码模块，含新增的相对依赖。 */
  async function sourceModules(version: string) {
    if (!pluginSource) return { available: false as const, reason: '请在本机配置 JIRA_DEV_PLUGIN_SOURCE' };
    const packageFile = path.join(pluginSource, 'package.json');
    if (!await exists(packageFile)) return { available: false as const, reason: `未找到本机插件源码（${pluginSource}）` };
    const sourceVersion = String(JSON.parse(await readFile(packageFile, 'utf8')).version || '');
    if (sourceVersion !== version) return { available: false as const, reason: `本机插件源码为 ${sourceVersion || '未知版本'}，与云端 ${version} 不一致` };
    const names = new Set((await readdir(jiraDevDirectory)).filter(name => name.endsWith('.mjs') && name !== 'index.mjs'));
    const queue = [...names];
    while (queue.length) {
      const name = queue.shift()!;
      const file = path.join(pluginSource, 'src', name);
      if (!await exists(file)) throw new Error(`本机插件源码缺少 ${name}`);
      for (const match of (await readFile(file, 'utf8')).matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
        if (!names.has(match[1])) { names.add(match[1]); queue.push(match[1]); }
      }
    }
    return { available: true as const, version: sourceVersion, names: [...names].sort() };
  }
  async function changedModules(names: string[]) {
    const changed: string[] = [];
    for (const name of names) {
      const next = await readFile(path.join(pluginSource, 'src', name));
      const current = await readFile(path.join(jiraDevDirectory, name)).catch(() => undefined);
      if (!current || sha256(current) !== sha256(next)) changed.push(name);
    }
    return changed;
  }

  return {
    async status() {
      const [state, release] = await Promise.all([readState(), latest()]);
      const source = await sourceModules(release.version).catch((error: Error) => ({ available: false as const, reason: error.message }));
      return {
        current: state, latest: { version: release.version, publishedAt: release.publishedAt, notes: release.notes, sha256: release.download.sha256.toLowerCase(), size: release.download.size },
        updateAvailable: compare(release.version, state.version) > 0,
        code: source.available ? { available: true, changed: await changedModules(source.names) } : { available: false, reason: source.reason },
        running: !!running,
      };
    },
    async sync(input: unknown) {
      const { expectedVersion, expectedSha256 } = jiraDevSyncInputSchema.parse(input);
      if (running) throw new Error('已有同步正在进行，请稍后刷新状态');
      const task = (async () => {
        const release = await latest();
        if (release.version !== expectedVersion || release.download.sha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('云端版本已变化，请重新检查后再同步');
        const archive = await download(release.download.url, release.download.size);
        if (archive.length !== release.download.size || sha256(archive) !== expectedSha256.toLowerCase()) throw new Error('安装包大小或 SHA-256 校验失败，未改动当前版本');

        await mkdir(syncRoot, { recursive: true, mode: 0o700 });
        const work = await mkdtemp(path.join(syncRoot, '.work-'));
        try {
          await writeFile(path.join(work, 'release.zip'), archive, { mode: 0o600 });
          try { await execute('/usr/bin/python3', ['-I', '-c', extractProgram, path.join(work, 'release.zip'), path.join(work, 'contents'), release.installation.releaseRoot], { timeout: 60_000 }); }
          catch (error) { throw new Error(`安装包解压校验失败：${String((error as { stderr?: string }).stderr || (error as Error).message).trim().slice(0, 300)}`); }
          const packageRoot = path.join(work, 'contents', release.installation.releaseRoot, release.installation.pluginDirectory);
          const manifest = new Map((await readFile(path.join(packageRoot, 'MANIFEST.sha256'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => {
            const match = line.match(/^([a-f0-9]{64}) [ *](?:\.\/)?(.+)$/i);
            if (!match) throw new Error('安装包文件清单格式无效');
            return [match[2], match[1].toLowerCase()] as const;
          }));
          for (const name of await listFiles(packageRoot)) {
            if (name === 'MANIFEST.sha256') continue;
            if (manifest.get(name) !== sha256(await readFile(path.join(packageRoot, name)))) throw new Error(`安装包文件与清单不一致：${name}`);
            manifest.delete(name);
          }
          if (manifest.size) throw new Error('安装包缺少清单中列出的文件');
          const plugin = JSON.parse(await readFile(path.join(packageRoot, 'plugins/jira-dev-workbench/plugin.json'), 'utf8'));
          if (plugin.version !== release.version) throw new Error('安装包内插件版本与签名清单不一致');

          // skills：对比已校验安装包与当前目录，记录增删改。
          const nextSkills = path.join(packageRoot, 'plugins/jira-dev-workbench/skills');
          const [before, after] = await Promise.all([treeHashes(path.join(jiraDevDirectory, 'skills')), treeHashes(nextSkills)]);
          const skillsChanged = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort();

          // 代码模块：仅当本机源码版本一致；先在临时完整副本中导入 index.mjs 校验。
          const source = await sourceModules(release.version);
          const codeChanged = source.available ? await changedModules(source.names) : [];
          if (codeChanged.length) {
            const staged = path.join(work, 'staged-jira-dev');
            await cp(jiraDevDirectory, staged, { recursive: true });
            for (const name of codeChanged) await cp(path.join(pluginSource, 'src', name), path.join(staged, name));
            const exportsCheck = `const m = await import(${JSON.stringify(path.join(staged, 'index.mjs'))}); const bad = Object.entries(m).filter(([, v]) => v === undefined).map(([k]) => k); if (bad.length) { console.error(bad.join(',')); process.exit(1); }`;
            try { await execute(process.execPath, ['--input-type=module', '-e', exportsCheck], { timeout: 30_000, cwd: staged }); }
            catch (error) { throw new Error(`新版代码模块导入校验失败，未改动当前版本：${String((error as { stderr?: string }).stderr || (error as Error).message).trim().slice(0, 300)}`); }
          }

          // 备份后替换：skills 整目录原子换入，代码模块逐个覆盖。
          const stamp = now().toISOString().replace(/[:.]/g, '-');
          const backup = path.join(options.dataDirectory, 'jira-dev', 'sync-backups', `${stamp}-from-${(await readState()).version}`);
          await mkdir(backup, { recursive: true, mode: 0o700 });
          if (skillsChanged.length) {
            await cp(path.join(jiraDevDirectory, 'skills'), path.join(backup, 'skills'), { recursive: true });
            const incoming = path.join(jiraDevDirectory, `.skills-${stamp}`);
            await cp(nextSkills, incoming, { recursive: true });
            await rename(path.join(jiraDevDirectory, 'skills'), path.join(work, 'old-skills'));
            await rename(incoming, path.join(jiraDevDirectory, 'skills'));
          }
          for (const name of codeChanged) {
            const current = path.join(jiraDevDirectory, name);
            if (await exists(current)) await cp(current, path.join(backup, name));
            await cp(path.join(pluginSource, 'src', name), current);
          }
          const state = { version: release.version, sha256: expectedSha256.toLowerCase(), syncedAt: now().toISOString(), ...(source.available ? { codeSource: pluginSource } : {}) };
          await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
          return {
            version: release.version, notes: release.notes, skillsChanged, codeChanged, backup,
            codeSkipped: source.available ? '' : source.reason,
            restartRequired: codeChanged.length > 0,
          };
        } finally { await rm(work, { recursive: true, force: true }); }
      })();
      running = task;
      try { return await task; } finally { running = undefined; }
    },
  };
}

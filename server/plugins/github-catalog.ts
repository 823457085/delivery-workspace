import { createHash } from 'node:crypto';
import { z } from 'zod';
import { githubOptions, type GitHubSettings } from './github-source.mjs';
import { boundedResponse } from './catalog-http.js';
import { pluginManifestSchema } from '../../shared/custom-plugins.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const releaseEntry = z.object({ id:z.string(), version:z.string(), manifest:pluginManifestSchema, package:z.string().regex(/^[a-z0-9][a-z0-9.-]*\.dwp$/), sha256:hash }).strict();
const catalogSchema = z.object({ protocol:z.literal(1), releases:z.array(releaseEntry).max(500) }).strict();
const assetSchema = z.object({ id:z.number().int().positive(), name:z.string(), size:z.number().int().nonnegative(), state:z.string(), digest:z.string().nullable().optional() });
const releaseSchema = z.object({ id:z.number().int().positive(), tag_name:z.string().min(1).max(200), draft:z.boolean(), prerelease:z.boolean() });
type Asset = z.infer<typeof assetSchema>;
type Entry = z.infer<typeof releaseEntry>;
class GithubError extends Error { constructor(message:string, readonly status=0) { super(message); } }
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function createGithubReader(fetchImpl:typeof fetch = fetch) {
  return async (source:GitHubSettings & {location:string}, limit:number, packageName?:string) => {
    const options = githubOptions(source), base = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    async function request(url:string, binary=false) {
      // All authenticated endpoints are constructed below, never taken from an API response.
      if (!url.startsWith(base + '/')) throw new GithubError('GitHub API 路径不匹配');
      try {
        const response = await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(20_000),headers:{
          Accept:binary?'application/octet-stream':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'delivery-workspace',
          ...(source.githubToken?{Authorization:`Bearer ${source.githubToken}`}:{}) }});
        if (!response.ok && !(binary && [301,302,303,307,308].includes(response.status))) await response.body?.cancel();
        if (response.status===401) throw new GithubError('GitHub 认证失败，请重新配置凭据',401);
        if (response.status===429 || response.status===403 && (response.headers.get('x-ratelimit-remaining')==='0' || response.headers.has('retry-after'))) throw new GithubError('GitHub 请求受限，请稍后重试或使用认证并缩小版本范围',429);
        if (response.status===403) throw new GithubError('GitHub 拒绝访问，请检查仓库只读权限或稍后重试',403);
        if (response.status===404) throw new GithubError('GitHub 仓库、标签或文件不存在，或当前凭据无读取权限',404);
        if (!binary && response.status>=300 && response.status<400) throw new GithubError('GitHub API 地址发生跳转，请检查仓库是否迁移');
        if (!response.ok && !(binary && [301,302,303,307,308].includes(response.status))) throw new GithubError(`GitHub 请求失败：HTTP ${response.status}`,response.status);
        return response;
      } catch (e) { if(e instanceof GithubError) throw e; throw new GithubError('GitHub 网络请求失败，请检查网络后重试'); }
    }
    async function json(url:string) { const r=await request(url); try{return JSON.parse((await boundedResponse(r,2_000_000)).toString());}catch{throw new GithubError('GitHub 元数据格式或大小无效');} }
    async function assets(releaseId:number):Promise<Asset[]> {
      const list=z.array(assetSchema).max(100).parse(await json(`${base}/releases/${releaseId}/assets?per_page=100`));
      if(list.length===100)throw new GithubError('单个 Release 资产过多，请限制为少于 100 个');
      return list;
    }
    async function download(asset:Asset, max:number) {
      if(asset.state!=='uploaded'||asset.size>max)throw new GithubError('GitHub 发布资产尚未就绪或超过大小上限');
      let response=await request(`${base}/releases/assets/${asset.id}`,true);
      for(let hop=0;response.status>=300&&response.status<400;hop++){
        const location=response.headers.get('location');await response.body?.cancel();
        if(hop>=3||!location)throw new GithubError('GitHub 资产下载跳转无效');
        let url:URL;try{url=new URL(location);}catch{throw new GithubError('GitHub 资产下载跳转无效');}
        if(url.protocol!=='https:'||!cdnHosts.has(url.hostname)||url.port||url.username||url.password||url.hash)throw new GithubError('GitHub 资产下载跳转到未允许地址');
        // No Authorization, Cookie, Referer or original request headers on signed CDN URLs.
        try{response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(20_000),headers:{Accept:'application/octet-stream'}});}catch{throw new GithubError('GitHub 发布资产下载失败');}
      }
      const bytes=await boundedResponse(response,max);
      if(bytes.length!==asset.size)throw new GithubError('GitHub 发布资产大小已变化');
      if(asset.digest && asset.digest!==`sha256:${createHash('sha256').update(bytes).digest('hex')}`)throw new GithubError('GitHub 发布资产摘要不一致');
      return bytes;
    }
    async function content(tag:string, file:string) {
      // Resolve mutable tags once, then read the exact commit rather than the working branch.
      const commit=z.object({sha:z.string().regex(/^[a-f0-9]{40}$/)}).parse(await json(`${base}/commits/${encodeURIComponent(tag)}`));
      const filePath=[options.directory,file].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
      const value=z.object({type:z.literal('file'),encoding:z.literal('base64'),content:z.string(),size:z.number().int().min(0).max(2_000_000)}).parse(await json(`${base}/contents/${filePath}?ref=${commit.sha}`));
      const encoded=value.content.replace(/\n/g,''), bytes=Buffer.from(encoded,'base64');
      if(bytes.length!==value.size||bytes.toString('base64')!==encoded)throw new GithubError('GitHub 声明文件编码无效');
      return JSON.parse(bytes.toString('utf8'));
    }
    const published=options.policy==='pinned'
      ? [releaseSchema.parse(await json(`${base}/releases/tags/${encodeURIComponent(options.ref)}`))]
      : z.array(releaseSchema).max(50).parse(await json(`${base}/releases?per_page=50`));
    if(options.policy!=='pinned'&&published.length===50)throw new GithubError('Release 超过扫描范围，请选择固定标签；不返回不完整版本目录');
    const entries=new Map<string,Entry>(), packages=new Map<string,Asset>();
    for(const release of published.filter(r=>!r.draft&&(options.policy!=='stable'||!r.prerelease))){
      const available=await assets(release.id);
      if(!available.some(a=>a.name.endsWith('.dwp')))continue;
      let raw:unknown;
      try{raw=await content(release.tag_name,options.kind==='market'?'catalog.json':'plugin.json');}
      catch(e){if(e instanceof GithubError && e.status===404)continue;throw e;}
      let candidates:Entry[];
      if(options.kind==='market')candidates=catalogSchema.parse(raw).releases;
      else{
        const manifest=pluginManifestSchema.parse(raw);
        if(![manifest.version,`v${manifest.version}`].includes(release.tag_name))throw new GithubError('单插件 Release 标签必须与声明版本一致');
        const name=`${manifest.id}-${manifest.version}.dwp`, asset=available.find(a=>a.name===name);
        if(!asset)throw new GithubError('单插件 Release 缺少约定名称的 .dwp 安装包');
        let sha256=asset.digest?.startsWith('sha256:')?asset.digest.slice(7):'';
        if(!sha256){
          const sidecar=available.find(a=>a.name===`${name}.sha256`);
          if(!sidecar)throw new GithubError('发布包缺少 SHA256，请提供 GitHub digest 或同名 .sha256 资产');
          const text=(await download(sidecar,512)).toString().trim();
          const match=text.match(/^([a-f0-9]{64})(?:\s+\*?([a-z0-9.-]+\.dwp))?$/);
          if(!match||match[2]&&match[2]!==name)throw new GithubError('SHA256 资产内容无效');
          sha256=match[1];
        }
        candidates=[{id:manifest.id,version:manifest.version,manifest,package:name,sha256:hash.parse(sha256)}];
      }
      for(const entry of candidates){
        if(entry.id!==entry.manifest.id||entry.version!==entry.manifest.version)throw new GithubError('GitHub 目录与插件声明身份不一致');
        const asset=available.find(a=>a.name===entry.package);
        if(!asset||asset.state!=='uploaded'||asset.size>41_000_000||asset.digest&&asset.digest!==`sha256:${entry.sha256}`)throw new GithubError('目录引用的 Release 包缺失、过大或摘要不符');
        const key=`${entry.id}@${entry.version}`, previous=entries.get(key);
        if(previous){if(JSON.stringify(previous)!==JSON.stringify(entry))throw new GithubError('GitHub 目录同一版本内容冲突');continue;}
        if(packages.has(entry.package))throw new GithubError('GitHub 不同插件版本使用了相同包文件名');
        entries.set(key,entry);packages.set(entry.package,asset);
        if(entries.size>500)throw new GithubError('GitHub 插件版本数量超过上限');
      }
    }
    if(!entries.size)throw new GithubError('未发现兼容插件：请检查仓库类型、目录、Release 标签及 .dwp 资产');
    if(packageName){
      const asset=packages.get(packageName);if(!asset)throw new GithubError('选定发布包已不存在，请刷新目录');
      const bytes=await download(asset,limit);
      const entry=[...entries.values()].find(e=>e.package===packageName)!;
      if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new GithubError('GitHub 发布包摘要校验失败');
      return bytes;
    }
    const bytes=Buffer.from(JSON.stringify({protocol:1,releases:[...entries.values()]}));
    if(bytes.length>limit)throw new GithubError('GitHub 目录超过大小上限');
    return bytes;
  };
}
export const readGithubSource=createGithubReader();

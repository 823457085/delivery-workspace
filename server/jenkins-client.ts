/** Jenkins 返回的内部地址只用于读取已验证的路径，凭据始终发往配置的 HTTPS origin。 */
import type { JenkinsJob, JenkinsParameter } from '../shared/deployments.js';

export interface JenkinsCredentials { baseUrl: string; username: string; token: string }
const maxResponseBytes = 2 * 1024 * 1024;
export function jenkinsBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入 Jenkins HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Jenkins 地址必须为 HTTPS origin，不包含路径、账号或参数');
  }
  return url.origin;
}
export function jenkinsJobPath(fullName: string) {
  const segments = fullName.split('/');
  if (fullName.length > 1000 || !segments.length || segments.some(part => !part || part !== part.trim()
    || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f?#]/.test(part))) throw new Error('Jenkins 任务名称不正确');
  return segments.map(part => `/job/${encodeURIComponent(part)}`).join('');
}
export function responsePath(value: string, baseUrl: string) {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) throw new Error('Jenkins 返回的跟踪地址不正确');
  let url: URL;
  try { url = new URL(value, baseUrl); } catch { throw new Error('Jenkins 返回的跟踪地址不正确'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Jenkins 返回的跟踪地址不正确');
  }
  return url.pathname;
}
export function queueFromLocation(value: string, baseUrl: string) {
  const match = responsePath(value, baseUrl).match(/^\/queue\/item\/(\d+)\/?$/);
  const id = Number(match?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Jenkins 未返回有效的排队编号');
  return id;
}
export function buildFromUrl(value: string, fullName: string, baseUrl: string) {
  const prefix = `${jenkinsJobPath(fullName)}/`;
  const pathname = responsePath(value, baseUrl);
  const number = Number(pathname.startsWith(prefix) ? pathname.slice(prefix.length).match(/^(\d+)\/?$/)?.[1] : NaN);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Jenkins 返回的构建与所选任务不匹配');
  return { number, url: `${baseUrl}${prefix}${number}/` };
}
const sensitiveQueryNames = new Set(['token', 'accesstoken', 'refreshtoken', 'idtoken', 'apitoken', 'apikey', 'key', 'secret',
  'clientsecret', 'secretkey', 'password', 'passwd', 'pwd', 'signature', 'sig', 'sign', 'auth', 'authorization', 'credential',
  'credentials', 'xamzsecuritytoken', 'xamzcredential', 'xamzsignature', 'xgoogsignature', 'xgoogcredential']);
export function redactJenkins(text: string, credentials: JenkinsCredentials) {
  const basic = Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64');
  let result = text;
  for (const value of [credentials.token, basic, encodeURIComponent(credentials.token)]) {
    if (value) result = result.split(value).join('[凭据已隐藏]');
  }
  result = result.replace(/\b11[a-f0-9]{32}\b/gi, '[凭据已隐藏]')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [凭据已隐藏]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, '$1[凭据已隐藏]@')
    .replace(/([?&](?:amp;)?)([^=&#\s"'<>]+)=([^&#\s"'<>]*)/g, (match, separator: string, name: string) => {
      let decoded: string;
      try { decoded = decodeURIComponent(name); } catch { return match; }
      return sensitiveQueryNames.has(decoded.replace(/[_-]/g, '').toLowerCase()) ? `${separator}${name}=[凭据已隐藏]` : match;
    });
  // xtrace 中的 curl 凭据可能来自 Jenkins 任务自身，不能仅屏蔽工作台配置的 Token。
  let continuedCurl = false;
  return result.split(/(\r?\n)/).map(line => {
    if (line === '\n' || line === '\r\n') return line;
    const curl = continuedCurl || /\bcurl\b/.test(line);
    continuedCurl = curl && /\\\s*$/.test(line);
    return curl ? line.replace(/(\s(?:--user(?:\s*=\s*|\s+)|-u(?:\s*=\s*|\s+|(?=\S))))(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/g,
      '$1[凭据已隐藏]') : line;
  }).join('');
}
export async function boundedText(response: Response) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxResponseBytes) throw new Error('Jenkins 返回内容超过 2 MB，偏移未推进，请在 Jenkins 查看');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxResponseBytes) throw new Error('Jenkins 返回内容超过 2 MB，偏移未推进，请在 Jenkins 查看');
      chunks.push(item.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
type RawParameter = { name?: unknown; description?: unknown; type?: unknown; _class?: unknown; choices?: unknown; defaultParameterValue?: { value?: unknown } };
type RawJob = { name?: string; fullName?: string; _class?: string; buildable?: boolean; jobs?: RawJob[];
  property?: { parameterDefinitions?: RawParameter[] }[]; actions?: { parameterDefinitions?: RawParameter[] }[] };
function parameters(job: RawJob): JenkinsParameter[] {
  const definitions = [...(job.property || []), ...(job.actions || [])].flatMap(item => item.parameterDefinitions || []);
  const seen = new Set<string>();
  return definitions.filter(item => typeof item.name === 'string' && item.name && !seen.has(item.name) && !!seen.add(item.name)).map(item => {
    const kind = String(item.type || item._class || '');
    const type: JenkinsParameter['type'] = /PasswordParameterDefinition$/.test(kind) ? 'password'
      : /BooleanParameterDefinition$/.test(kind) ? 'boolean' : /ChoiceParameterDefinition$/.test(kind) ? 'choice'
      : /(?:String|Text)ParameterDefinition$/.test(kind) ? 'string' : 'unsupported';
    const result: JenkinsParameter = { name: String(item.name), description: typeof item.description === 'string' ? item.description : '', type };
    const value = item.defaultParameterValue?.value;
    if (type !== 'password' && (typeof value === 'string' || typeof value === 'boolean')) result.defaultValue = value;
    if (type === 'choice') result.choices = Array.isArray(item.choices) ? item.choices.filter((choice): choice is string => typeof choice === 'string') : [];
    return result;
  });
}
const jobTree = 'name,fullName,_class,buildable,jobs[name,fullName,_class],property[parameterDefinitions[name,description,type,_class,choices,defaultParameterValue[value]]],actions[parameterDefinitions[name,description,type,_class,choices,defaultParameterValue[value]]]';
export function createJenkinsClient(credentials: JenkinsCredentials, fetcher: typeof fetch = fetch) {
  const baseUrl = jenkinsBaseUrl(credentials.baseUrl);
  if (!credentials.username || !credentials.token) throw new Error('请先保存 Jenkins 用户名和 API Token');
  async function request(suffix: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${suffix}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { ...init.headers, Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}` } });
    } catch { throw new Error(init.method === 'POST' ? '构建提交连接中断，结果待确认；请先到 Jenkins 核对，不要重复发布' : 'Jenkins 连接失败或超时'); }
    if (response.status >= 300 && response.status < 400) throw new Error('Jenkins 返回重定向，请核对配置的 HTTPS 地址');
    if (!response.ok) throw new Error(`Jenkins 请求失败（HTTP ${response.status}），请核对账号权限和任务`);
    return response;
  }
  async function json(suffix: string): Promise<Record<string, unknown>> {
    const text = await boundedText(await request(suffix));
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new Error('Jenkins 返回数据格式不正确'); }
  }
  async function job(fullName: string): Promise<JenkinsJob> {
    const pathname = jenkinsJobPath(fullName);
    const raw = await json(`${pathname}/api/json?tree=${encodeURIComponent(jobTree)}`) as RawJob;
    if (raw.fullName !== undefined && raw.fullName !== fullName) throw new Error('Jenkins 返回任务与所选任务不匹配');
    return { fullName, name: raw.name || fullName.split('/').at(-1)!, url: `${baseUrl}${pathname}/`, buildable: raw.buildable === true, parameters: parameters(raw) };
  }
  async function jobs(): Promise<JenkinsJob[]> {
    const result: JenkinsJob[] = [];
    const seen = new Set<string>();
    async function visit(parent: string, depth: number, supplied?: RawJob) {
      if (depth > 12 || seen.size > 300) throw new Error('Jenkins 任务目录过多，请缩小当前账号的可见范围');
      const raw = supplied && (Array.isArray(supplied.jobs) || typeof supplied.buildable === 'boolean') ? supplied
        : await json(`${parent ? jenkinsJobPath(parent) : ''}/api/json?tree=${encodeURIComponent(parent ? jobTree : `jobs[${jobTree}]`)}`) as RawJob;
      if (parent && raw.fullName !== undefined && raw.fullName !== parent) throw new Error('Jenkins 返回任务目录不匹配');
      if (Array.isArray(raw.jobs)) {
        for (const child of raw.jobs) {
          if (!child.name || child.name.includes('/')) throw new Error('Jenkins 返回任务名称不正确');
          const name = parent ? `${parent}/${child.name}` : child.name;
          jenkinsJobPath(name);
          if (child.fullName !== undefined && child.fullName !== name) throw new Error('Jenkins 返回任务目录不匹配');
          if (seen.has(name)) continue;
          seen.add(name);
          await visit(name, depth + 1, child);
        }
      } else if (parent && raw.buildable === true) result.push({ fullName: parent, name: raw.name || parent.split('/').at(-1)!,
        url: `${baseUrl}${jenkinsJobPath(parent)}/`, buildable: true, parameters: parameters(raw) });
    }
    await visit('', 0);
    return result.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }
  return { request, json, job, jobs, baseUrl,
    check: async () => { await json('/api/json?tree=mode,nodeDescription'); return { message: 'Jenkins 连接成功；未触发构建' }; },
  };
}

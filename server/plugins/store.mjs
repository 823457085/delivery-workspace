import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPluginEnabled, definition, pluginBaseUrl, pluginDefinitions, pluginEnabled } from './definitions.mjs';

const connection = config => JSON.stringify(config ? Object.fromEntries(Object.entries(config).filter(([key]) => !['enabled', 'installed'].includes(key))) : {});
const authKeys = ['AUTH_HEADER', 'COOKIE', 'KEYCHAIN_SERVICE', 'KEYCHAIN_ACCOUNT', 'USERNAME', 'API_TOKEN'];
export function managedPluginCredential(key, env = process.env) {
  const match = /^(JIRA|CONFLUENCE)_(.+)$/.exec(key);
  return !!match && env[`DELIVERY_PLUGIN_${match[1]}_MANAGED`] === 'true' && authKeys.includes(match[2]);
}

export const pluginFile = (env = process.env) => path.resolve(env.DELIVERY_DATA_DIR || '.data', 'credentials', 'plugins.json');
export async function readPluginFile(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.version !== 1 || !data.plugins || typeof data.plugins !== 'object' || Array.isArray(data.plugins)) throw new Error();
    for (const [id, config] of Object.entries(data.plugins)) validate(id, config);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, plugins: {} };
    throw new Error('插件配置无法读取，请检查本机 plugins.json；未覆盖原文件');
  }
}
function site(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的服务地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址不能含凭据、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}
function validate(id, input) {
  definition(id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件配置格式无效');
  const fields = id === 'wecom' ? ['enabled', 'installed', 'groupName', 'webhook'] : ['enabled', 'installed', 'baseUrl', 'username', 'token'];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error('插件配置包含不支持的字段');
  if (typeof input.enabled !== 'boolean') throw new Error('请选择插件启用状态');
  if (input.installed !== undefined && typeof input.installed !== 'boolean') throw new Error('插件安装状态无效');
  const output = { ...input };
  for (const key of fields.filter(key => !['enabled', 'installed'].includes(key))) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 4096 || /[\x00-\x1f\x7f]/.test(input[key])) throw new Error('插件字段格式无效');
    output[key] = input[key].trim();
  }
  if (output.baseUrl) output.baseUrl = site(output.baseUrl);
  if (output.webhook) {
    let url;
    try { url = new URL(output.webhook); } catch { throw new Error('企微 Webhook 地址无效'); }
    if (url.origin !== 'https://qyapi.weixin.qq.com' || url.username || url.password || url.hash || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key') || url.searchParams.getAll('key').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'key')) throw new Error('请填写企业微信群机器人 Webhook 地址');
  }
  return output;
}
// Applied before loading application modules. All consumers share the same startup snapshot.
export function applyPluginEnvironment(data, env) {
  for (const plugin of pluginDefinitions) {
    const config = data.plugins[plugin.id];
    if (!config) continue;
    env[`DELIVERY_PLUGIN_${plugin.prefix}_ENABLED`] = String(config.enabled);
    env[`DELIVERY_PLUGIN_${plugin.prefix}_INSTALLED`] = String(config.installed !== false);
    if (plugin.id === 'wecom') {
      if (config.webhook) { env.DELIVERY_PLUGIN_WECOM_WEBHOOK = config.webhook; env.DELIVERY_PLUGIN_WECOM_GROUP = config.groupName || ''; }
    } else if (config.baseUrl) {
      // Never reuse credentials from another site, account, file, or keychain.
      for (const suffix of authKeys) delete env[`${plugin.prefix}_${suffix}`];
      env[`${plugin.prefix}_BASE_URL`] = config.baseUrl;
      env[`${plugin.prefix}_USERNAME`] = config.username || '';
      if (config.token) env[`${plugin.prefix}_AUTH_HEADER`] = config.username
        ? `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}` : `Bearer ${config.token}`;
      env[`DELIVERY_PLUGIN_${plugin.prefix}_MANAGED`] = 'true';
    }
  }
}
export async function createPluginStore({ file = pluginFile(), env = process.env, fetchImpl = fetch, wecomConfig = () => ({}), legacyProbe } = {}) {
  const startup = await readPluginFile(file);
  let queue = Promise.resolve();
  async function list() {
    const data = await readPluginFile(file);
    return pluginDefinitions.map(plugin => {
      const saved = data.plugins[plugin.id];
      const enabled = saved?.enabled ?? env[`DELIVERY_PLUGIN_${plugin.prefix}_ENABLED`] !== 'false';
      const isWecom = plugin.id === 'wecom';
      const legacy = isWecom ? wecomConfig() : {};
      const baseUrl = isWecom ? '' : pluginBaseUrl(plugin.id, env);
      const hasAuthentication = Boolean(env[`${plugin.prefix}_AUTH_HEADER`] || env[`${plugin.prefix}_COOKIE`]
        || env[`${plugin.prefix}_KEYCHAIN_SERVICE`] || env[`${plugin.prefix}_USERNAME`] && env[`${plugin.prefix}_API_TOKEN`]);
      const runningConfigured = isWecom ? Boolean(env.DELIVERY_PLUGIN_WECOM_WEBHOOK || legacy.hasWebhook) : Boolean(baseUrl && hasAuthentication);
      const configured = isWecom ? Boolean(saved?.webhook || legacy.hasWebhook) : saved?.baseUrl ? Boolean(saved.token) : runningConfigured;
      return { ...plugin, enabled, installed: saved?.installed !== false, runningEnabled: pluginEnabled(plugin.id, env),
        runningConfigured, baseUrl: saved?.baseUrl ?? baseUrl,
        username: saved?.username ?? env[`${plugin.prefix}_USERNAME`] ?? '', groupName: saved?.groupName ?? legacy.groupName ?? '',
        configured,
        restartRequired: connection(saved) !== connection(startup.plugins[plugin.id]),
        source: saved ? 'plugin' : 'legacy' };
    });
  }
  async function candidate(id, input) {
    const next = validate(id, input), current = (await readPluginFile(file)).plugins[id];
    // Saving an unchanged legacy connection must not replace its credential source with an empty token.
    const prefix = definition(id).prefix;
    if (id !== 'wecom' && !current?.baseUrl && !next.token && next.baseUrl
      && next.baseUrl === pluginBaseUrl(id, env) && (next.username || '') === (env[`${prefix}_USERNAME`] || '')) {
      return { enabled: next.enabled, ...(current?.installed !== undefined ? {installed: current.installed} : {}), ...(next.installed !== undefined ? {installed: next.installed} : {}) };
    }
    const secret = id === 'wecom' ? 'webhook' : 'token';
    if (next.installed === undefined && current?.installed !== undefined) next.installed = current.installed;
    const sameIdentity = id === 'wecom' || next.baseUrl === current?.baseUrl && (next.username || '') === (current?.username || '');
    if (!next[secret] && sameIdentity && current?.[secret]) next[secret] = current[secret];
    return next;
  }
  return {
    list,
    state(id, input) {
      const plugin = definition(id);
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['enabled', 'installed'].includes(key)) || !Object.keys(input).length || Object.values(input).some(value => typeof value !== 'boolean')) throw new Error('插件状态无效');
      const result = queue.then(async () => {
        const data = await readPluginFile(file);
        const next = { enabled: env[`DELIVERY_PLUGIN_${plugin.prefix}_ENABLED`] !== 'false', ...data.plugins[id], ...input };
        data.plugins[id] = next;
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); await fs.rename(temp, file); }
        finally { await fs.rm(temp, {force: true}); }
        env[`DELIVERY_PLUGIN_${plugin.prefix}_ENABLED`] = String(next.enabled);
        env[`DELIVERY_PLUGIN_${plugin.prefix}_INSTALLED`] = String(next.installed !== false);
        return { plugins: await list(), message: '插件状态已生效；配置、数据与历史记录已保留' };
      });
      queue = result.catch(() => {}); return result;
    },
    save(id, input) {
      const result = queue.then(async () => {
        const next = await candidate(id, input), data = await readPluginFile(file);
        data.plugins[id] = next;
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }); }
        env[`DELIVERY_PLUGIN_${definition(id).prefix}_ENABLED`] = String(next.enabled);
        env[`DELIVERY_PLUGIN_${definition(id).prefix}_INSTALLED`] = String(next.installed !== false);
        return { plugins: await list(), message: '启停状态已生效；连接变更请在任务结束后重启工作台生效' };
      });
      queue = result.catch(() => {}); return result;
    },
    async test(id, input) {
      const plugin = definition(id), config = await candidate(id, input);
      if (id === 'wecom') {
        if (!config.webhook && !wecomConfig().hasWebhook) throw new Error('请先填写 Webhook');
        return { message: 'Webhook 格式检查通过，未发送消息；实际送达请在消息页预览并确认发送' };
      }
      let response;
      // candidate 保留旧连接时会移除站点字段，且只对同一站点和账号执行此操作。
      if (legacyProbe && input.baseUrl && !config.baseUrl) {
        assertPluginEnabled(id, env);
        try { response = await legacyProbe(id); }
        catch { throw new Error('当前连接测试失败，请检查本机凭据和访问权限'); }
      } else {
        if (!config.baseUrl || !config.token) throw new Error('请填写服务地址和认证 Token；修改站点或账号时需要提供新凭据');
        const authorization = config.username ? `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}` : `Bearer ${config.token}`;
        try { response = await fetchImpl(`${config.baseUrl}${plugin.probe}`, { headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
        catch { throw new Error('连接测试失败，请检查地址、网络和认证配置'); }
      }
      if (!response.ok) throw new Error(`连接测试失败：HTTP ${response.status}`);
      let profile;
      try { profile = await response.json(); } catch { throw new Error('服务未返回有效的用户信息'); }
      if (!profile || !(profile.accountId || profile.key || profile.name || profile.username || profile.userKey) || profile.type === 'anonymous') throw new Error('未确认当前认证用户，请检查服务地址和权限');
      return { message: `${plugin.name} 只读连接测试通过` };
    },
  };
}

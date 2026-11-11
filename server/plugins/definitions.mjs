/** Built-in integration manifests. Only registered plugins can receive credentials. */
import jira from '../../plugins/jira/integration.json' with { type: 'json' };
import confluence from '../../plugins/confluence/integration.json' with { type: 'json' };
import wecom from '../../plugins/wecom/integration.json' with { type: 'json' };
export const pluginDefinitions = [jira, confluence, wecom];

export function definition(id) {
  const plugin = pluginDefinitions.find(item => item.id === id);
  if (!plugin) throw new Error('未注册的接入插件');
  return plugin;
}
export function pluginBaseUrl(id, env = process.env) {
  const { prefix } = definition(id);
  const value = (env[`${prefix}_BASE_URL`] || '').trim();
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/+$/, '');
  } catch { return ''; }
}

export function pluginEnabled(id, env = process.env) {
  const { prefix } = definition(id);
  return env[`DELIVERY_PLUGIN_${prefix}_INSTALLED`] !== 'false'
    && env[`DELIVERY_PLUGIN_${prefix}_ENABLED`] !== 'false';
}

export function assertPluginEnabled(id, env = process.env) {
  if (!pluginEnabled(id, env)) {
    throw Object.assign(new Error(`${definition(id).name} 插件已停用或移除，请在插件管理中恢复并启用`),
      { code: 'PLUGIN_DISABLED', definite: true });
  }
}

export function assertIntegrationRequest(pathname, env = process.env, method = 'GET') {
  for (const plugin of pluginDefinitions) {
    if (method === 'GET' && plugin.historyPaths?.includes(pathname)) continue;
    const sourcePaths = plugin.sourceKeys.flatMap(key => [`/api/source/${key}`, `/api/${key}`]);
    if (sourcePaths.includes(pathname) || plugin.apiPaths.includes(pathname) || plugin.apiPrefixes.some(prefix => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) assertPluginEnabled(plugin.id, env);
  }
}
export function assertIntegrationCapability(capability, env = process.env) {
  const plugin = pluginDefinitions.find(item => item.capabilities.includes(capability));
  if (!plugin) throw new Error(`没有提供此能力的插件：${capability}`);
  assertPluginEnabled(plugin.id, env);
}

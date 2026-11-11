/** 保存本人选择的连接来源引用；凭据仍由原文件或钥匙串读取，每次公开 Jira 调用绑定同一连接快照。 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJiraClient, loadJiraConfiguration, normalizeJiraSite, sourceIdentity } from './jira-client.mjs';
import { writePrivateJson } from './ui-state.mjs';

const keysByMode = { existing: ['mode'], file: ['mode', 'envFile'], keychain: ['mode', 'site', 'keychainService', 'keychainAccount'] };
const environmentKeys = ['DELIVERY_CREDENTIALS_FILE', 'DELIVERY_PLUGIN_JIRA_MANAGED', 'JIRA_BASE_URL', 'JIRA_AUTH_HEADER', 'JIRA_COOKIE', 'JIRA_KEYCHAIN_SERVICE', 'JIRA_KEYCHAIN_ACCOUNT', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_START_DATE_FIELD', 'JIRA_START_DATE_FIELD_ID', 'JIRA_END_DATE_FIELD', 'JIRA_END_DATE_FIELD_ID', 'USER'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, code = 'JIRA_CONNECTION_CONFIG') => Object.assign(new Error(message), { code });

function configurationFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(keysByMode, value.mode)) throw failure('请选择有效的 Jira 连接来源。');
  const allowed = keysByMode[value.mode];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw failure('连接设置只接受来源路径或钥匙串引用。');
  for (const key of allowed) {
    if (typeof value[key] !== 'string' || !value[key] || value[key] !== value[key].trim() || value[key].length > (key === 'envFile' ? 4096 : 500) || /[\u0000-\u001f\u007f]/.test(value[key])) throw failure('连接设置的必填字段缺失或格式无效。');
  }
  if (value.mode === 'file' && !isAbsolute(value.envFile)) throw failure('连接文件必须使用已有文件的绝对路径。');
  return Object.fromEntries(allowed.map(key => [key, key === 'site' ? normalizeJiraSite(value[key]) : value[key]]));
}

function authenticationFrom(environment) {
  const method = environment.JIRA_AUTH_HEADER ? 'authorization' : environment.JIRA_KEYCHAIN_SERVICE ? 'keychain' : environment.JIRA_USERNAME && environment.JIRA_API_TOKEN ? 'basic' : environment.JIRA_COOKIE ? 'cookie' : 'none';
  return { configured: method !== 'none', method };
}

export function createConnectionSettings({ dataDirectory, env = process.env, fetchImpl = fetch } = {}) {
  const path = join(dataDirectory, 'connection-settings.json');
  let queue = Promise.resolve(), cached;
  const serial = callback => {
    const result = queue.then(async () => {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const lock = new DatabaseSync(join(dataDirectory, 'connection-settings-lock.sqlite'));
      try {
        try { lock.exec('BEGIN IMMEDIATE'); } catch { throw failure('另一个面板正在保存连接，请刷新后重试。'); }
        return await callback();
      } finally { lock.close(); }
    });
    queue = result.catch(() => {}); return result;
  };
  async function selected() {
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record?.version !== 1 || typeof record.selectionId !== 'string' || !record.selectionId) throw new Error();
      return { configuration: configurationFrom(record.configuration), revision: digest(record) };
    } catch (error) {
      if (error.code === 'ENOENT') return { configuration: { mode: 'existing' }, revision: digest({ mode: 'existing' }) };
      throw failure('本机连接设置无法读取，未覆盖原配置。');
    }
  }
  async function resolveConfiguration(configuration, { requireAuthentication = true, requireSite = true } = {}) {
    let environment;
    if (configuration.mode === 'existing') environment = await loadJiraConfiguration(env);
    if (configuration.mode === 'file') {
      // 只加载所选文件，禁止从环境或隐式文件拼接另一个站点的认证。
      environment = await loadJiraConfiguration({ JIRA_DEV_ENV_FILE: configuration.envFile });
    }
    if (configuration.mode === 'keychain') environment = { JIRA_BASE_URL: configuration.site, JIRA_KEYCHAIN_SERVICE: configuration.keychainService, JIRA_KEYCHAIN_ACCOUNT: configuration.keychainAccount };
    const resolved = Object.fromEntries(environmentKeys.filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
    if (requireSite || resolved.JIRA_BASE_URL) resolved.JIRA_BASE_URL = normalizeJiraSite(resolved.JIRA_BASE_URL);
    if (requireAuthentication && !authenticationFrom(resolved).configured) throw failure('所选来源未配置 Jira 鉴权，请检查既有文件或钥匙串引用。', 'JIRA_AUTH');
    // 不保留 JIRA_DEV_ENV_FILE；客户端只使用此刻解析的快照，不在同一操作中重新读取来源。
    return resolved;
  }
  async function read() {
    const selection = await selected();
    const source = { mode: selection.configuration.mode, ...(selection.configuration.mode === 'file' ? { path: selection.configuration.envFile } : env.JIRA_DEV_ENV_FILE && selection.configuration.mode === 'existing' ? { path: env.JIRA_DEV_ENV_FILE } : {}) };
    try {
      const environment = await resolveConfiguration(selection.configuration, { requireAuthentication: false });
      const authentication = authenticationFrom(environment);
      return { ...selection, source, site: environment.JIRA_BASE_URL, authentication, ...(!authentication.configured ? { warning: '所选来源未配置 Jira 鉴权，请检查既有文件或钥匙串引用。' } : {}) };
    } catch (error) {
      return { ...selection, source, site: selection.configuration.site || '', authentication: { configured: false, method: 'none' }, warning: error.code?.startsWith('JIRA_') ? error.message : '无法读取当前 Jira 连接来源。' };
    }
  }
  async function resolve() { return resolveConfiguration((await selected()).configuration); }
  async function client() {
    const selection = await selected(), environment = await resolveConfiguration(selection.configuration);
    const identity = digest([selection.revision, environment]);
    if (cached?.identity !== identity) cached = { identity, value: createJiraClient({ env: environment, fetchImpl }) };
    return cached.value;
  }
  async function persist(candidate) {
    const record = { version: 1, selectionId: randomUUID(), configuration: candidate };
    await writePrivateJson(path, record);
    cached = undefined;
    const saved = await read();
    if (saved.revision !== digest(record)) throw failure('连接已保存，但回读未能核对，请刷新检查。');
    return saved;
  }
  return {
    read, resolve, client,
    async sourceIdentity(source) {
      const environment = await resolveConfiguration((await selected()).configuration, { requireAuthentication: false, requireSite: false });
      return sourceIdentity(source, environment.JIRA_BASE_URL || '');
    },
    async test({ configuration } = {}) {
      const candidate = configuration === undefined ? (await selected()).configuration : configurationFrom(configuration);
      const environment = await resolveConfiguration(candidate);
      const connection = await createJiraClient({ env: environment, fetchImpl }).connection();
      return { status: 'connected', ...connection };
    },
    connect: ({ configuration, expectedRevision, confirmed } = {}) => serial(async () => {
      if (confirmed !== true) throw failure('请确认连接所选 Jira 授权来源。', 'JIRA_CONNECTION_CONFIRM');
      const current = await selected();
      if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) throw failure('连接来源已变化，请刷新后重新连接。', 'JIRA_CONNECTION_STALE');
      const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const candidate = configuration === undefined ? current.configuration : configurationFrom(configuration);
      const environment = await resolveConfiguration(candidate);
      const connection = await createJiraClient({ env: environment, fetchImpl }).connection();
      const latest = await selected(), latestEnvironment = await resolveConfiguration(candidate);
      if (latest.revision !== current.revision || digest(environment) !== digest(latestEnvironment)) throw failure('连接来源在测试期间已变化，请刷新后重新连接。', 'JIRA_CONNECTION_STALE');
      const saved = await persist(candidate);
      let unchanged = false;
      try { unchanged = (await selected()).revision === saved.revision && digest(environment) === digest(await resolveConfiguration(candidate)); } catch { /* 来源在保存窗口中消失或损坏，不能沿用旧验证。 */ }
      if (!unchanged) {
        const owned = await selected().then(selection => selection.revision === saved.revision, () => false);
        if (owned) {
          if (previous === null) await rm(path, { force: true });
          else await writePrivateJson(path, JSON.parse(previous));
          cached = undefined;
        }
        throw failure('连接来源已变化，请刷新后重新连接。', 'JIRA_CONNECTION_STALE');
      }
      return { ...saved, status: 'connected', account: connection.account, checkedAt: new Date().toISOString() };
    }),
    save: ({ configuration, expectedRevision, confirmed } = {}) => serial(async () => {
      if (confirmed !== true) throw failure('请先确认保存 Jira 连接来源。', 'JIRA_CONNECTION_CONFIRM');
      const candidate = configurationFrom(configuration), current = await selected();
      if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) throw failure('连接来源已变化，请刷新后重新确认。', 'JIRA_CONNECTION_STALE');
      await resolveConfiguration(candidate);
      return persist(candidate);
    }),
  };
}

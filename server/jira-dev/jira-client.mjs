import { assertPluginEnabled } from '../plugins/definitions.mjs';
/**
 * 工作入口共用成员本人的 Jira 连接；承接只读查询及已确认的任务、排期、评论和状态写入。
 * 固定 REST 站点并禁止重定向，凭据仅留在内存；写入只发一次，成功必须通过 GET 回读证明。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';

const execute = promisify(execFile);
const issuePattern = /^[A-Z][A-Z0-9_]*-\d+$/;
const maximumItems = 500;
const maximumPages = 50;
const pageSize = 100;

function clientError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// fetch 会把底层错误包在 cause 或 AggregateError 中；只读取已知类型，不回显原始错误或认证材料。
function readNetworkError(error) {
  const pending = [error], seen = new Set(), markers = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); markers.add(item.code); markers.add(item.name);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors);
  }
  const has = codes => codes.some(code => markers.has(code));
  if (has(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA'])) return clientError('Jira 域名解析失败，请检查 DNS 或网络连接。', 'JIRA_NETWORK_DNS', { uncertain: false, networkReason: 'dns' });
  if (has(['TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'])) return clientError('连接 Jira 超时，请检查网络、代理或 VPN 后重试。', 'JIRA_NETWORK_TIMEOUT', { uncertain: false, networkReason: 'timeout' });
  if (has(['ECONNREFUSED'])) return clientError('Jira 拒绝连接，请检查服务地址、端口或网络访问策略。', 'JIRA_NETWORK_REFUSED', { uncertain: false, networkReason: 'refused' });
  if (has(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'ERR_SSL_CERTIFICATE_VERIFY_FAILED'])) return clientError('Jira TLS 证书验证失败，请检查证书链或系统时间。', 'JIRA_NETWORK_TLS', { uncertain: false, networkReason: 'tls' });
  return clientError('Jira 网络请求失败，请检查网络连接。', 'JIRA_NETWORK', { uncertain: false, networkReason: 'other' });
}

function normalizeSite(value) {
  let url;
  try { url = new URL(value); } catch { throw clientError('请配置本人的 JIRA_BASE_URL。', 'JIRA_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw clientError('Jira 站点必须是不含账号密码和查询参数的 HTTP(S) 地址。', 'JIRA_CONFIG');
  }
  return url.href.replace(/\/+$/, '');
}

export { normalizeSite as normalizeJiraSite };

function issueKey(source, site) {
  if (typeof source !== 'string' || source.length > 2000 || /[\\\x00-\x1f\x7f]/.test(source)) throw clientError('请输入 Jira 编号或当前站点的事项链接。', 'JIRA_SOURCE');
  const input = source.trim();
  if (issuePattern.test(input.toUpperCase())) return input.toUpperCase();
  let url;
  try { url = new URL(input); } catch { throw clientError('请输入有效的 Jira 编号或事项链接。', 'JIRA_SOURCE'); }
  const base = new URL(site);
  const prefix = `${base.pathname.replace(/\/$/, '')}/`;
  if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(prefix)) {
    throw clientError('事项链接必须来自当前成员已配置的 Jira 站点。', 'JIRA_SITE_MISMATCH');
  }
  const match = url.pathname.slice(prefix.length).match(/^(?:browse|projects\/[A-Za-z][A-Za-z0-9_]*\/issues)\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/);
  if (!match) throw clientError('事项链接未包含有效的 Jira 编号。', 'JIRA_SOURCE');
  return match[1].toUpperCase();
}

/** 本地材料的来源身份；无站点时保留明确 Key，但不假定它可发布。 */
export function sourceIdentity(source, site = '') {
  if (site) {
    site = normalizeSite(site);
    const key = issueKey(source, site);
    return { key, url: `${site}/browse/${key}` };
  }
  if (typeof source !== 'string' || source.length > 2000 || /[\\\x00-\x1f\x7f]/.test(source)) throw clientError('请输入有效的 Jira 来源。', 'JIRA_SOURCE');
  const value = source.trim();
  if (issuePattern.test(value.toUpperCase())) return { key: value.toUpperCase(), url: '' };
  let url;
  try { url = new URL(value); } catch { throw clientError('请输入有效的 Jira 编号或事项链接。', 'JIRA_SOURCE'); }
  const match = url.pathname.match(/^(.*)\/(?:browse|projects\/[A-Z][A-Z0-9_]*\/issues)\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
  if (!match || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw clientError('请输入有效的 Jira 事项链接。', 'JIRA_SOURCE');
  return sourceIdentity(value, `${url.origin}${match[1]}`);
}

function dateField(value, fallback) {
  const field = value || fallback;
  const match = String(field).match(/^(?:customfield_)?(\d+)$/);
  if (!match) throw clientError('排期字段必须是 customfield_编号。', 'JIRA_CONFIG');
  return `customfield_${match[1]}`;
}

function hasAuthentication(env) {
  return Boolean(env.JIRA_AUTH_HEADER || env.JIRA_COOKIE || env.JIRA_KEYCHAIN_SERVICE || (env.JIRA_USERNAME && env.JIRA_API_TOKEN));
}

const authenticationKeys = ['JIRA_AUTH_HEADER', 'JIRA_COOKIE', 'JIRA_KEYCHAIN_SERVICE', 'JIRA_KEYCHAIN_ACCOUNT', 'JIRA_USERNAME', 'JIRA_API_TOKEN'];

function selectProfile(previous, incoming) {
  const next = { ...incoming };
  if (!next.JIRA_BASE_URL) delete next.JIRA_BASE_URL;
  const priorSite = previous.JIRA_BASE_URL ? normalizeSite(previous.JIRA_BASE_URL) : undefined;
  const nextSite = next.JIRA_BASE_URL ? normalizeSite(next.JIRA_BASE_URL) : undefined;
  const newAuthentication = authenticationKeys.some(key => Boolean(next[key]));
  const selected = { ...previous };
  if (newAuthentication || (nextSite && nextSite !== priorSite)) for (const key of authenticationKeys) delete selected[key];
  for (const key of authenticationKeys) if (!newAuthentication) delete next[key];
  return { ...selected, ...next };
}

export async function loadJiraConfiguration(environment) {
  assertPluginEnabled('jira');
  assertPluginEnabled('jira', environment);
  async function readProfile(filename, required = false) {
    try { return parseEnv(await readFile(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || required) throw clientError('本机 Jira 连接配置无法读取。', 'JIRA_CONFIG');
      return {};
    }
  }
  if (environment.JIRA_DEV_ENV_FILE) {
    if (!isAbsolute(environment.JIRA_DEV_ENV_FILE)) throw clientError('JIRA_DEV_ENV_FILE 必须是明确的绝对路径。', 'JIRA_CONFIG');
    // 显式文件最高优先级，不读取其他隐式配置；不同站点不能继承环境里的旧认证。
    return selectProfile(environment, await readProfile(environment.JIRA_DEV_ENV_FILE, true));
  }
  if (environment.DELIVERY_PLUGIN_JIRA_MANAGED === 'true') return { ...environment };
  if (environment.DELIVERY_CREDENTIALS_FILE && isAbsolute(environment.DELIVERY_CREDENTIALS_FILE)) {
    return selectProfile(environment, await readProfile(environment.DELIVERY_CREDENTIALS_FILE, false));
  }
  if (environment.JIRA_BASE_URL && hasAuthentication(environment)) return environment;
  const support = join(homedir(), 'Library', 'Application Support');
  const legacy = await readProfile(join(support, 'DeliveryWorkspace', 'credentials', 'jira.env'));
  const former = await readProfile(join(support, 'FrontendTeamDelivery', 'runtime', 'configuration.env'));
  // 原 Delivery 凭据缺省不写站点；其原插件私有配置是已明确关联的站点来源。
  const fallback = !legacy.JIRA_BASE_URL && former.JIRA_BASE_URL
    ? selectProfile({ ...legacy, JIRA_BASE_URL: former.JIRA_BASE_URL }, former) : selectProfile(legacy, former);
  const personal = await readProfile(join(support, 'JiraDevWorkbench', 'configuration.env'));
  return selectProfile(selectProfile(fallback, personal), environment);
}

async function authentication(env) {
  assertPluginEnabled('jira');
  assertPluginEnabled('jira', env);
  let headers;
  if (env.JIRA_AUTH_HEADER) headers = { Authorization: env.JIRA_AUTH_HEADER };
  if (!headers && env.JIRA_KEYCHAIN_SERVICE && process.platform === 'darwin') {
    const args = ['find-generic-password'];
    if (env.JIRA_KEYCHAIN_ACCOUNT || env.USER) args.push('-a', env.JIRA_KEYCHAIN_ACCOUNT || env.USER);
    args.push('-s', env.JIRA_KEYCHAIN_SERVICE, '-w');
    try {
      const { stdout } = await execute('/usr/bin/security', args, { timeout: 2000, maxBuffer: 64 * 1024 });
      const token = stdout.trim();
      if (token) headers = { Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` };
    } catch { /* 沿用原连接的其他鉴权方式，不回显钥匙串输出。 */ }
  }
  if (!headers && env.JIRA_USERNAME && env.JIRA_API_TOKEN) headers = { Authorization: `Basic ${Buffer.from(`${env.JIRA_USERNAME}:${env.JIRA_API_TOKEN}`).toString('base64')}` };
  if (!headers && env.JIRA_COOKIE) headers = { Cookie: env.JIRA_COOKIE };
  if (!headers) throw clientError(env.JIRA_KEYCHAIN_SERVICE ? '当前进程无法读取本人 Jira 钥匙串配置，请检查既有条目的访问权限。' : '请配置本人 Jira 鉴权。', 'JIRA_AUTH');
  if (Object.values(headers).some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) throw clientError('Jira 鉴权配置格式无效。', 'JIRA_AUTH');
  return headers;
}

function accountFrom(user) {
  const id = user?.accountId ?? user?.key ?? user?.name;
  const name = user?.displayName ?? user?.name;
  if (typeof id !== 'string' || !id || typeof name !== 'string') throw clientError('Jira 当前用户返回不符合契约。', 'JIRA_CONTRACT');
  return { id, name };
}

function rawDate(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw clientError('Jira 日期字段返回不符合契约。', 'JIRA_CONTRACT');
  return value;
}

function validateRequirementDates(startDate, endDate, code = 'JIRA_REQUIREMENT_DATES_FIELDS') {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if ([startDate, endDate].some(value => value != null && value !== '' && !valid(value))) throw clientError('计划日期必须是真实的 YYYY-MM-DD 日期。', code, { uncertain: false });
  if (startDate && endDate && endDate < startDate) throw clientError('计划结束日期不能早于计划开始日期。', code, { uncertain: false });
}

function issueFrom(issue, config) {
  if (!issuePattern.test(issue?.key || '') || !issue.fields || typeof issue.fields.summary !== 'string') throw clientError('Jira 事项返回不符合契约。', 'JIRA_CONTRACT');
  const fields = issue.fields;
  return {
    key: issue.key, summary: fields.summary, description: fields.description ?? '',
    status: fields.status?.name ?? '', statusId: fields.status?.id ?? '', assignee: fields.assignee?.displayName ?? fields.assignee?.name ?? '',
    assigneeId: fields.assignee?.accountId ?? fields.assignee?.key ?? fields.assignee?.name ?? '',
    statusCategory: fields.status?.statusCategory?.key ?? '', priority: fields.priority?.name ?? '',
    created: rawDate(fields.created), updated: rawDate(fields.updated), resolutionDate: rawDate(fields.resolutiondate),
    url: `${config.site}/browse/${issue.key}`, startDate: rawDate(fields[config.startField]),
    endDate: rawDate(fields[config.endField]), dueDate: rawDate(fields.duedate),
    ...(fields.project ? { project: { id: String(fields.project.id || ''), key: fields.project.key, name: fields.project.name || '' } } : {}),
    ...(fields.issuetype ? { issueType: { id: String(fields.issuetype.id || ''), name: fields.issuetype.name, subtask: fields.issuetype.subtask === true } } : {}),
    ...(Array.isArray(fields.fixVersions) ? { fixVersions: fields.fixVersions.map(item => ({ id: item?.id == null ? '' : String(item.id), name: item?.name })) } : {}),
    ...(Array.isArray(fields.components) ? { components: fields.components.map(item => ({ id: item?.id == null ? '' : String(item.id), name: item?.name })) } : {}),
    ...(Array.isArray(fields.labels) ? { labels: fields.labels } : {}),
    ...(fields.parent?.key ? { parent: { key: fields.parent.key, url: `${config.site}/browse/${fields.parent.key}`, summary: fields.parent.fields?.summary || '' } } : {}),
    ...(Array.isArray(fields.subtasks) ? { subtasks: fields.subtasks.map(item => ({ key: item.key, url: `${config.site}/browse/${item.key}`, summary: item.fields?.summary || '' })) } : {}),
    ...(Array.isArray(fields.issuelinks) ? { links: fields.issuelinks.flatMap(link => {
      const linked = link.outwardIssue || link.inwardIssue;
      return linked?.key ? [{ key: linked.key, url: `${config.site}/browse/${linked.key}`, summary: linked.fields?.summary || '', type: link.type, direction: link.outwardIssue ? 'outward' : 'inward' }] : [];
    }) } : {}),
  };
}

function commentFrom(comment, key, site) {
  if (!/^\d+$/.test(String(comment?.id ?? '')) || typeof comment.body !== 'string') throw clientError('Jira 评论返回不符合契约。', 'JIRA_CONTRACT');
  return { id: String(comment.id), body: comment.body,
    author: comment.author ? accountFrom(comment.author) : null, created: comment.created ?? null, updated: comment.updated ?? null,
    url: `${site}/browse/${key}?focusedCommentId=${encodeURIComponent(comment.id)}#comment-${encodeURIComponent(comment.id)}` };
}

function transitionFrom(transition) {
  const validId = value => typeof value === 'string' && /^\d+$/.test(value);
  if (!validId(transition?.id) || typeof transition.name !== 'string' || !transition.name ||
      !validId(transition.to?.id) || typeof transition.to.name !== 'string' || !transition.to.name ||
      !transition.fields || typeof transition.fields !== 'object' || Array.isArray(transition.fields)) {
    throw clientError('Jira 状态转换返回不符合契约。', 'JIRA_CONTRACT');
  }
  const requiredFields = [];
  for (const [id, field] of Object.entries(transition.fields)) {
    if (!id || !field || typeof field.required !== 'boolean' || typeof field.name !== 'string' || !field.name ||
        (field.hasDefaultValue !== undefined && typeof field.hasDefaultValue !== 'boolean')) {
      throw clientError('Jira 状态转换字段返回不符合契约。', 'JIRA_CONTRACT');
    }
    if (field.required && field.hasDefaultValue !== true) requiredFields.push({ id, name: field.name });
  }
  return { id: transition.id, name: transition.name, to: { id: transition.to.id, name: transition.to.name }, requiredFields };
}

export function createJiraClient({ env = process.env, fetchImpl = fetch } = {}) {
  let loading;
  async function config() {
    if (!loading) loading = loadJiraConfiguration(env).then(async environment => ({
      site: normalizeSite(environment.JIRA_BASE_URL), headers: await authentication(environment),
      startField: dateField(environment.JIRA_START_DATE_FIELD || environment.JIRA_START_DATE_FIELD_ID, 'customfield_10109'),
      endField: dateField(environment.JIRA_END_DATE_FIELD || environment.JIRA_END_DATE_FIELD_ID, 'customfield_10110'),
    })).catch(error => { loading = undefined; throw error; });
    return loading;
  }
  async function request(path, { method = 'GET', body, transition = false, operation = 'comment', emptyResponse = false } = {}) {
    const connection = await config();
    assertPluginEnabled('jira');
    assertPluginEnabled('jira', env);
    const url = `${connection.site}/rest/api/2/${path}`;
    const writing = !['GET', 'HEAD'].includes(method);
    const uncertainCode = transition ? 'JIRA_TRANSITION_UNCERTAIN' : operation === 'dates' ? 'JIRA_REQUIREMENT_DATES_UNCERTAIN' : operation === 'issue' ? 'JIRA_REQUIREMENT_CREATE_UNCERTAIN' : operation === 'link' ? 'JIRA_REQUIREMENT_LINK_UNCERTAIN' : 'JIRA_COMMENT_UNCERTAIN';
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { ...connection.headers, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      if (!writing) throw readNetworkError(error);
      throw clientError(transition ? 'Jira 状态转换结果不明，请先核对事项状态，勿重复执行。' : operation === 'dates' ? 'Jira 计划日期更新结果不明，请先核对事项日期，勿重复提交。' : operation === 'issue' ? 'Jira 任务创建结果不明，请先核对标记，勿重复创建。' : operation === 'link' ? 'Jira 关联结果不明，请先核对已有关系，勿重复提交。' : 'Jira 评论请求结果不明，请先核对评论，勿重复发送。', uncertainCode, { uncertain: true });
    }
    if (!response.ok) {
      const uncertain = writing && (response.status >= 500 || (response.status >= 300 && response.status < 400));
      throw clientError(`Jira 返回 HTTP ${response.status}。`, uncertain ? uncertainCode : response.status === 401 || response.status === 403 ? 'JIRA_AUTH' : 'JIRA_HTTP', { status: response.status, uncertain, ...(response.status === 401 ? { httpReason: 'unauthorized' } : response.status === 403 ? { httpReason: 'forbidden' } : {}) });
    }
    if (transition) {
      if (response.status === 204) return null;
      throw clientError('Jira 状态转换响应不符合契约，请先核对事项状态，勿重复执行。', uncertainCode, { uncertain: true });
    }
    if (operation === 'dates') {
      if (response.status === 204) return null;
      throw clientError('Jira 计划日期更新响应不符合契约，请先核对事项日期，勿重复提交。', uncertainCode, { uncertain: true });
    }
    if (emptyResponse && [201, 204].includes(response.status)) return null;
    let result;
    try { result = await response.json(); }
    catch { throw clientError('Jira 返回不符合 JSON 契约。', writing ? uncertainCode : 'JIRA_CONTRACT', { uncertain: writing }); }
    return result;
  }
  async function connection() {
    const settings = await config();
    return { site: settings.site, account: accountFrom(await request('myself')) };
  }
  async function readIssue(source) {
    const settings = await config();
    const key = issueKey(source, settings.site);
    const fields = ['summary', 'description', 'status', 'assignee', 'duedate', 'project', 'issuetype', 'fixVersions', 'components', 'parent', 'subtasks', 'issuelinks', 'labels', 'priority', 'created', 'updated', 'resolutiondate', settings.startField, settings.endField];
    const issue = issueFrom(await request(`issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`), settings);
    if (issue.key !== key) throw clientError('Jira 返回的事项编号与请求不一致。', 'JIRA_CONTRACT');
    return issue;
  }
  async function readTransitions(source) {
    const issue = await readIssue(source);
    if (typeof issue.statusId !== 'string' || !/^\d+$/.test(issue.statusId) || typeof issue.status !== 'string' || !issue.status) {
      throw clientError('Jira 事项状态返回不符合契约。', 'JIRA_CONTRACT');
    }
    const result = await request(`issue/${encodeURIComponent(issue.key)}/transitions?expand=transitions.fields`);
    if (!Array.isArray(result?.transitions)) throw clientError('Jira 状态转换返回不符合契约。', 'JIRA_CONTRACT');
    const transitions = result.transitions.map(transitionFrom);
    if (new Set(transitions.map(item => item.id)).size !== transitions.length) throw clientError('Jira 状态转换编号重复。', 'JIRA_CONTRACT');
    return { issue, transitions };
  }
  async function transitionIssue({ source, transitionId, expectedStatusId, targetStatusId, expectedAssigneeId, confirmed } = {}) {
    if (confirmed !== true) throw clientError('请先确认 Jira 状态转换。', 'JIRA_TRANSITION_CONFIRM');
    if (![transitionId, expectedStatusId, targetStatusId].every(value => typeof value === 'string' && /^\d+$/.test(value))) {
      throw clientError('请选择有效的 Jira 状态转换及原状态。', 'JIRA_TRANSITION');
    }
    const { issue, transitions } = await readTransitions(source);
    if (expectedAssigneeId !== undefined && issue.assigneeId !== expectedAssigneeId) throw clientError('Jira 经办人已变化，未执行状态转换。', 'JIRA_TRANSITION_STALE');
    if (issue.statusId !== expectedStatusId) throw clientError('Jira 状态已变化，请刷新后重新选择。', 'JIRA_TRANSITION_STALE');
    const selected = transitions.find(item => item.id === transitionId && item.to.id === targetStatusId);
    if (!selected) throw clientError('当前 Jira 状态不允许所选转换，请刷新后重新选择。', 'JIRA_TRANSITION_STALE');
    if (selected.requiredFields.length) throw clientError('此转换需要补充必填字段，请在 Jira 中完成。', 'JIRA_TRANSITION_FIELDS', { requiredFields: selected.requiredFields });
    await request(`issue/${encodeURIComponent(issue.key)}/transitions`, { method: 'POST', body: { transition: { id: transitionId } }, transition: true });
    try {
      const saved = await readIssue(issue.key);
      if (saved.statusId !== targetStatusId || typeof saved.status !== 'string' || !saved.status) throw clientError('事项回读状态与目标不一致。', 'JIRA_CONTRACT');
      return { issue: saved, transitionId, targetStatusId, verified: true };
    } catch { throw clientError('状态可能已转换，但回读未能核对，请先检查 Jira，勿重复执行。', 'JIRA_TRANSITION_UNCERTAIN', { uncertain: true, transitionId, targetStatusId }); }
  }
  async function paged(path, property) {
    const items = [];
    let total = null, offset = 0, finished = false;
    for (let page = 0; page < maximumPages && offset < maximumItems; page++) {
      const url = new URL(path, 'http://request.invalid');
      url.searchParams.set('startAt', String(offset)); url.searchParams.set('maxResults', String(Math.min(pageSize, maximumItems - offset)));
      const result = await request(`${url.pathname.replace(/^\//, '')}${url.search}`);
      if (!Array.isArray(result[property]) || (result.startAt !== undefined && result.startAt !== offset)) throw clientError('Jira 分页返回不符合契约。', 'JIRA_CONTRACT');
      if (Number.isInteger(result.total) && result.total >= 0) total = result.total;
      const pageItems = result[property];
      const remaining = maximumItems - items.length;
      items.push(...pageItems.slice(0, remaining));
      offset += pageItems.length;
      if (pageItems.length > remaining) break;
      if (result.isLast === true || result.isLastPage === true || (total !== null && offset >= total)) { finished = true; break; }
      if (!pageItems.length) { finished = total === null || offset >= total; break; }
      if (total === null && pageItems.length < (result.maxResults || pageSize)) { finished = true; break; }
    }
    return { items, total: total ?? items.length, truncated: !finished };
  }
  async function calendar(month) {
    if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw clientError('月份必须为 YYYY-MM。', 'JIRA_MONTH');
    const { account } = await connection();
    const settings = await config();
    const [year, number] = month.split('-').map(Number);
    const next = number === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
    const start = `${month}-01`, end = `${next}-01`;
    const a = `cf[${settings.startField.slice(12)}]`, b = `cf[${settings.endField.slice(12)}]`;
    const inMonth = field => `(${field} >= "${start}" AND ${field} < "${end}")`;
    const jql = `assignee = currentUser() AND (${inMonth(a)} OR ${inMonth(b)} OR ${inMonth('duedate')} OR (${a} < "${end}" AND ${b} >= "${start}") OR (${a} < "${end}" AND ${b} IS EMPTY AND duedate >= "${start}") OR (${a} IS EMPTY AND ${b} IS EMPTY AND duedate IS EMPTY)) ORDER BY updated DESC, key ASC`;
    const fields = ['summary', 'description', 'status', 'assignee', 'duedate', 'project', 'issuetype', 'fixVersions', 'priority', 'updated', 'resolutiondate', settings.startField, settings.endField];
    const result = await paged(`search?${new URLSearchParams({ jql, fields: fields.join(',') })}`, 'issues');
    const issues = [], undated = [];
    const seen = new Set();
    for (const item of result.items) {
      const issue = issueFrom(item, settings);
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      if (!issue.startDate && !issue.endDate && !issue.dueDate) undated.push(issue); else issues.push(issue);
    }
    return { month, account, issues, undated, truncated: result.truncated, total: result.total };
  }
  /** 报告完成范围由 Jira 按账号时区查询；保留接口时间原文，避免客户端二次换算。 */
  async function reportIssues({ start, end }) {
    const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!valid(start) || !valid(end) || end < start || Date.parse(end) - Date.parse(start) > 6 * 86400000) throw clientError('报告范围必须是连续 1–7 天的有效日期。', 'JIRA_REPORT_RANGE');
    const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const settings = await config(), user = await request('myself'), account = accountFrom(user);
    const a = `cf[${settings.startField.slice(12)}]`, b = `cf[${settings.endField.slice(12)}]`;
    const within = field => `(${field} >= "${start}" AND ${field} < "${next}")`;
    const fields = ['summary', 'status', 'assignee', 'duedate', 'project', 'issuetype', 'fixVersions', 'created', 'updated', 'resolutiondate', settings.startField, settings.endField];
    const query = jql => paged(`search?${new URLSearchParams({ jql, fields: fields.join(',') })}`, 'issues');
    const results = await Promise.allSettled([
      query(`assignee = currentUser() AND (${within('updated')} OR (statusCategory = "In Progress" AND created < "${next}") OR ${within(a)} OR ${within(b)} OR ${within('duedate')} OR (${a} < "${next}" AND ${b} >= "${start}") OR (${a} < "${next}" AND ${b} IS EMPTY AND duedate >= "${start}")) ORDER BY updated DESC, key ASC`),
      query(`assignee = currentUser() AND statusCategory = Done AND ${within('resolutiondate')} ORDER BY resolutiondate DESC, key ASC`),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const [activity, completed] = results.map(result => result.value), issues = new Map();
    for (const item of [...activity.items, ...completed.items]) { const issue = issueFrom(item, settings); issues.set(issue.key, issue); }
    const truncated = activity.truncated || completed.truncated;
    return { site: settings.site, account, range: { start, end }, timeZone: typeof user.timeZone === 'string' ? user.timeZone : '',
      issues: [...issues.values()], completedKeys: completed.items.map(item => item.key), total: truncated ? null : issues.size, truncated,
      sourceTotals: { activity: activity.total, completed: completed.total } };
  }
  /** 维护只扫描本人未完成事项；分页边界随结果返回，由计划层阻止不完整扫描的写入。 */
  async function maintenanceIssues() {
    const identity = await connection(), settings = await config();
    const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY key ASC';
    const result = await paged(`search?${new URLSearchParams({ jql, fields: '*all' })}`, 'issues');
    const issues = result.items.map(raw => issueFrom(raw, settings));
    if (new Set(issues.map(issue => issue.key)).size !== issues.length) throw clientError('Jira 维护分页出现重复事项，未生成自动动作。', 'JIRA_CONTRACT');
    return { ...identity, issues, total: result.total, truncated: result.truncated };
  }
  async function listComments(source) {
    const settings = await config();
    const key = issueKey(source, settings.site);
    const result = await paged(`issue/${encodeURIComponent(key)}/comment?orderBy=-created`, 'comments');
    return { comments: result.items.map(item => commentFrom(item, key, settings.site)), truncated: result.truncated, total: result.total };
  }
  async function publishComment(source, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 50_000) throw clientError('评论正文必须为 1 至 50000 字的原文。', 'JIRA_COMMENT');
    const settings = await config();
    const key = issueKey(source, settings.site);
    const created = await request(`issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { body } });
    if (!/^\d+$/.test(String(created?.id ?? ''))) throw clientError('评论请求已返回，但没有可核对的评论编号，请先核对已有评论。', 'JIRA_COMMENT_UNCERTAIN', { uncertain: true });
    const commentId = String(created.id);
    try {
      const saved = commentFrom(await request(`issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`), key, settings.site);
      if (saved.id !== commentId || saved.body !== body) throw clientError('评论回读与已提交内容不一致。', 'JIRA_CONTRACT');
      return { ...saved, commentId, verified: true };
    } catch { throw clientError('评论可能已写入，但回读未能核对，请先检查该评论，勿重复发送。', 'JIRA_COMMENT_UNCERTAIN', { uncertain: true, commentId }); }
  }

  async function requirementSource(source) {
    const settings = await config();
    if (!sourceIdentity(source).url) throw clientError('任务创建必须绑定完整 Jira 来源链接。', 'JIRA_SOURCE');
    return { settings, key: issueKey(source, settings.site) };
  }
  async function readRequirementIssue(source) {
    const settings = await config(), key = issueKey(source, settings.site);
    const raw = await request(`issue/${encodeURIComponent(key)}?fields=*all`);
    const issue = issueFrom(raw, settings);
    if (issue.key !== key) throw clientError('Jira 返回的事项编号与请求不一致。', 'JIRA_CONTRACT');
    return { ...issue, rawFields: raw.fields };
  }
  async function metadataPage(path, property) {
    const result = [];
    for (let startAt = 0; startAt < 500;) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
      const page = await request(`${path}?${query}`);
      const values = page.values || page[property];
      if (!Array.isArray(values) || (page.startAt !== undefined && page.startAt !== startAt)) throw clientError('Jira 创建元数据分页不符合契约。', 'JIRA_CONTRACT');
      result.push(...values); startAt += values.length;
      if (page.isLast === true || (Number.isInteger(page.total) && startAt >= page.total) || (!values.length) || (page.total === undefined && values.length < (page.maxResults || 100))) return result;
    }
    throw clientError('Jira 创建元数据超过读取上限，无法确认完整规则。', 'JIRA_METADATA');
  }
  async function readRequirementContext(source, { projectKey: targetProjectKey = '', linksOnly = false } = {}) {
    const { settings } = await requirementSource(source);
    const issue = await readRequirementIssue(source);
    if (!/^[A-Z][A-Z0-9_]*$/.test(issue.project?.key || '')) throw clientError('来源事项缺少准确项目，不能创建任务。', 'JIRA_METADATA');
    if (issue.project.id && !/^\d+$/.test(issue.project.id)) throw clientError('来源项目编号不合法，保留本地任务草稿。', 'JIRA_METADATA');
    for (const field of ['fixVersions', 'components']) if ((issue.rawFields[field] != null && !Array.isArray(issue.rawFields[field])) || (issue[field] || []).some(item => !/^\d+$/.test(item.id))) throw clientError(`来源 ${field} 缺少真实编号，保留本地任务草稿。`, 'JIRA_METADATA');
    if (targetProjectKey && !/^[A-Z][A-Z0-9_]*$/.test(targetProjectKey)) throw clientError('目标 Jira 项目 Key 不正确。', 'JIRA_METADATA');
    const projectKey = targetProjectKey || issue.project.key, prefix = `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
    let issueTypes = [];
    if (!linksOnly) {
    try {
      const types = await metadataPage(prefix, 'issueTypes');
      issueTypes = [];
      for (const type of types.filter(item => item.subtask === true || /^(?:task|dev|development|开发任务|任务|开发)$/i.test(item.name || ''))) {
        const values = await metadataPage(`${prefix}/${encodeURIComponent(type.id)}`, 'fields');
        issueTypes.push({ id: String(type.id), name: type.name, subtask: type.subtask === true,
          fields: Object.fromEntries(values.map(field => [field.fieldId || field.key || field.id, field])) });
      }
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
      const legacy = await request(`issue/createmeta?${new URLSearchParams({ projectKeys: projectKey, expand: 'projects.issuetypes.fields' })}`);
      issueTypes = legacy.projects?.find(project => project.key === projectKey)?.issuetypes;
    }
    if (!Array.isArray(issueTypes)) throw clientError('Jira 未返回当前项目可创建的任务类型。', 'JIRA_METADATA');
    for (const type of issueTypes) {
      if (!/^\d+$/.test(String(type.id)) || typeof type.name !== 'string' || typeof type.subtask !== 'boolean' || !type.fields || Array.isArray(type.fields)) throw clientError('Jira 创建类型或字段规则不完整。', 'JIRA_METADATA');
      for (const [id, field] of Object.entries(type.fields)) if (!id || !field || typeof field.required !== 'boolean') throw clientError('Jira 创建必填字段规则不完整。', 'JIRA_METADATA');
    }
    }
    const rawAccount = await request('myself'), account = accountFrom(rawAccount);
    const assignee = rawAccount.accountId ? { accountId: rawAccount.accountId } : rawAccount.name ? { name: rawAccount.name } : null;
    let linkTypes = [], linkWarning;
    try {
      const permissions = await request(`mypermissions?${new URLSearchParams({ issueKey: issue.key, permissions: 'LINK_ISSUES' })}`);
      if (permissions.permissions?.LINK_ISSUES?.havePermission === true) {
        const result = await request('issueLinkType');
        if (!Array.isArray(result.issueLinkTypes)) throw clientError('Jira 关联类型规则不完整。', 'JIRA_METADATA');
        linkTypes = result.issueLinkTypes.filter(type => /^\d+$/.test(String(type.id)) && typeof type.name === 'string');
      } else linkWarning = '当前账号未确认关联权限，任务正文保留来源链接。';
    } catch { linkWarning = '未取得可用关联类型，任务正文保留来源链接。'; }
    return { issue, project: projectKey === issue.project.key ? issue.project : { key: projectKey }, account, assignee, issueTypes, linkTypes, startField: settings.startField, endField: settings.endField, ...(linkWarning ? { linkWarning } : {}) };
  }
  /** 排期只允许更新当前站点可编辑的日期字段；预览与写入共用元数据，不根据字段名称猜测权限。 */
  async function readRequirementScheduleContext(source) {
    const { settings } = await requirementSource(source);
    const issue = await readRequirementIssue(source);
    const metadata = await request(`issue/${encodeURIComponent(issue.key)}/editmeta`);
    if (!metadata?.fields || typeof metadata.fields !== 'object' || Array.isArray(metadata.fields)) throw clientError('Jira 未返回当前事项可编辑的字段规则。', 'JIRA_METADATA', { uncertain: false });
    return { issue, startField: settings.startField, endField: settings.endField, fields: metadata.fields };
  }
  async function updateRequirementDates({ source, startDate, endDate, expectedStartDate, expectedEndDate, confirmed } = {}) {
    if (confirmed !== true) throw clientError('请先确认计划日期修改预览。', 'JIRA_REQUIREMENT_DATES_CONFIRM', { uncertain: false });
    validateRequirementDates(startDate, endDate);
    const supplied = value => value != null && value !== '';
    if (![startDate, endDate].some(supplied)) throw clientError('请填写需要修改的计划日期；留空会保留已有日期。', 'JIRA_REQUIREMENT_DATES_FIELDS', { uncertain: false });
    if ([expectedStartDate, expectedEndDate].some(value => value !== undefined && value !== null && typeof value !== 'string')) throw clientError('原计划日期参数不正确，请重新生成预览。', 'JIRA_REQUIREMENT_DATES_FIELDS', { uncertain: false });
    let context;
    try { context = await readRequirementScheduleContext(source); }
    catch (error) { throw Object.assign(error, { uncertain: false }); }
    const { issue, startField, endField, fields: metadata } = context;
    if (startField === endField) throw clientError('计划开始日期和结束日期必须配置为不同字段。', 'JIRA_REQUIREMENT_DATES_FIELDS', { uncertain: false });
    if ((expectedStartDate !== undefined && (issue.startDate || '') !== (expectedStartDate || '')) ||
        (expectedEndDate !== undefined && (issue.endDate || '') !== (expectedEndDate || ''))) throw clientError('Jira 计划日期已变化，请重新生成预览后确认。', 'JIRA_REQUIREMENT_DATES_STALE', { uncertain: false });
    const nextStartDate = supplied(startDate) ? startDate : issue.startDate, nextEndDate = supplied(endDate) ? endDate : issue.endDate;
    validateRequirementDates(nextStartDate, nextEndDate);
    const fields = {};
    for (const [field, value] of [[startField, startDate], [endField, endDate]]) {
      if (!supplied(value)) continue;
      const rule = metadata[field];
      if (!rule || rule.schema?.type !== 'date' || !Array.isArray(rule.operations) || !rule.operations.includes('set')) throw clientError('当前事项未提供可设置的计划日期字段，请检查 Jira 字段配置。', 'JIRA_REQUIREMENT_DATES_FIELDS', { uncertain: false });
      fields[field] = value;
    }
    try {
      await request(`issue/${encodeURIComponent(issue.key)}`, { method: 'PUT', body: { fields }, operation: 'dates' });
    } catch (error) {
      if (error.uncertain) Object.assign(error, { key: issue.key, url: issue.url });
      throw error;
    }
    try {
      const saved = await readRequirementIssue(issue.url);
      if ((saved.startDate || '') !== (nextStartDate || '') || (saved.endDate || '') !== (nextEndDate || '')) throw new Error();
      return { ...saved, verified: true };
    } catch { throw clientError('计划日期可能已更新，但 GET 回读未能核对，请只读检查事项日期。', 'JIRA_REQUIREMENT_DATES_UNCERTAIN', { uncertain: true, key: issue.key, url: issue.url }); }
  }
  async function findRequirementIssues({ sourceIssue, markers = [], allProjects = false }) {
    const { settings } = await requirementSource(sourceIssue.url);
    const source = await readRequirementIssue(sourceIssue.url);
    const related = [...new Set([...(source.links || []).map(item => item.key), ...(source.subtasks || []).map(item => item.key), source.parent?.key].filter(key => issuePattern.test(key || '')))];
    const project = source.project?.key || source.key.split('-')[0];
    const quote = value => JSON.stringify(value);
    const markerClauses = markers.filter(Boolean).map(marker => `(labels = ${quote(marker)} OR text ~ ${quote(`"${marker}"`)})`);
    const clauses = [];
    if (markerClauses.length) clauses.push(`${allProjects ? '' : `project = ${quote(project)} AND `}(${markerClauses.join(' OR ')})`);
    if (related.length) clauses.push(`key in (${related.map(quote).join(',')})`);
    clauses.push(`parent in (${[source.key, ...related].map(quote).join(',')})`);
    const jql = clauses.map(clause => `(${clause})`).join(' OR ');
    const result = await paged(`search?${new URLSearchParams({ jql: `${jql} ORDER BY key ASC`, fields: '*all' })}`, 'issues');
    return { sourceIssue: source, issues: result.items.map(raw => ({ ...issueFrom(raw, settings), rawFields: raw.fields })), truncated: result.truncated };
  }
  async function readMaintenanceContext(source) {
    const context = await readRequirementContext(source), settings = await config();
    return { ...context, startField: settings.startField, endField: settings.endField };
  }
  async function findMaintenanceSlices({ source, marker } = {}) {
    const settings = await config(), parent = await readIssue(source);
    if (marker !== undefined && !/^jira-dev-maintenance-[a-f0-9]{32}$/.test(marker)) throw clientError('维护切片标记不合法。', 'JIRA_MAINTENANCE_MARKER');
    const jql = `parent = ${JSON.stringify(parent.key)}${marker ? ` OR labels = ${JSON.stringify(marker)}` : ''} ORDER BY key ASC`;
    const result = await paged(`search?${new URLSearchParams({ jql, fields: '*all' })}`, 'issues');
    const issues = result.items.map(raw => ({ ...issueFrom(raw, settings), rawFields: raw.fields }));
    if (new Set(issues.map(issue => issue.key)).size !== issues.length) throw clientError('Jira 子任务查重出现重复事项。', 'JIRA_CONTRACT');
    return { parent, issues, truncated: result.truncated || (parent.subtasks || []).some(child => !issues.some(issue => issue.key === child.key)) };
  }
  async function createMaintenanceSlice({ source, fields, marker, confirmed } = {}) {
    if (confirmed !== true) throw clientError('请先确认自动维护策略。', 'JIRA_MAINTENANCE_CONFIRM');
    const { settings, key } = await requirementSource(source);
    if (!/^jira-dev-maintenance-[a-f0-9]{32}$/.test(marker || '') || fields?.parent?.key !== key || typeof fields.description !== 'string' || !fields.description.includes(marker) || !fields.labels?.includes(marker)) throw clientError('维护切片字段或父任务标识不正确。', 'JIRA_MAINTENANCE_FIELDS');
    const created = await request('issue', { method: 'POST', body: { fields }, operation: 'issue' });
    if (!issuePattern.test(created?.key || '')) throw clientError('创建响应缺少事项编号，请先核对维护标记。', 'JIRA_MAINTENANCE_UNCERTAIN', { uncertain: true });
    try {
      const saved = await readRequirementIssue(created.key);
      if (saved.parent?.key !== key || saved.issueType?.subtask !== true || saved.issueType.id !== fields.issuetype.id || saved.summary !== fields.summary || saved.description !== fields.description || saved.startDate !== fields[settings.startField] || saved.endDate !== fields[settings.endField] || fields.labels.some(label => !saved.labels?.includes(label))) throw new Error();
      for (const field of ['accountId', 'name']) if (fields.assignee?.[field] && saved.rawFields.assignee?.[field] !== fields.assignee[field]) throw new Error();
      for (const field of ['fixVersions', 'components']) if (fields[field] && fields[field].map(item => String(item.id)).sort().join(',') !== (saved[field] || []).map(item => item.id).sort().join(',')) throw new Error();
      return { ...saved, verified: true };
    } catch { throw clientError('维护切片可能已创建，但回读未确认，请只读核对标记。', 'JIRA_MAINTENANCE_UNCERTAIN', { uncertain: true, key: created.key, url: `${settings.site}/browse/${created.key}` }); }
  }
  async function createRequirementIssue({ source, fields, marker, confirmed }) {
    if (confirmed !== true) throw clientError('请先确认前端任务创建预览。', 'JIRA_REQUIREMENT_CREATE_CONFIRM', { uncertain: false });
    const { settings } = await requirementSource(source);
    if (!fields || typeof fields.summary !== 'string' || typeof fields.description !== 'string' || !fields.description.includes(marker) || !/^jira-dev-requirement-[a-f0-9]{24}-(?:parent|(?:design|implementation)(?:-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2})?)$/.test(marker || '')) throw clientError('创建字段或任务标记不正确。', 'JIRA_REQUIREMENT_CREATE_FIELDS', { uncertain: false });
    validateRequirementDates(fields[settings.startField], fields[settings.endField], 'JIRA_REQUIREMENT_CREATE_FIELDS');
    fields = { ...fields };
    for (const field of [settings.startField, settings.endField]) if (fields[field] == null || fields[field] === '') delete fields[field];
    if (settings.startField === settings.endField && fields[settings.startField] !== undefined) throw clientError('计划开始日期和结束日期必须配置为不同字段。', 'JIRA_REQUIREMENT_CREATE_FIELDS', { uncertain: false });
    const created = await request('issue', { method: 'POST', body: { fields }, operation: 'issue' });
    if (!issuePattern.test(created?.key || '')) throw clientError('创建请求已返回，但缺少可核对的事项编号。', 'JIRA_REQUIREMENT_CREATE_UNCERTAIN', { uncertain: true });
    try {
      const saved = await readRequirementIssue(created.key);
      if (saved.summary !== fields.summary || saved.description !== fields.description || !saved.description?.includes(marker) ||
          (fields.project?.id && saved.project?.id !== String(fields.project.id)) || (fields.project?.key && saved.project?.key !== fields.project.key) ||
          (fields.issuetype?.id && saved.issueType?.id !== String(fields.issuetype.id)) || (fields.parent?.key && saved.parent?.key !== fields.parent.key)) throw new Error();
      for (const field of ['fixVersions', 'components']) if (fields[field] && fields[field].map(item => String(item.id)).sort().join(',') !== (saved[field] || []).map(item => String(item.id)).sort().join(',')) throw new Error();
      for (const field of ['accountId', 'name']) if (fields.assignee?.[field] && saved.rawFields?.assignee?.[field] !== fields.assignee[field]) throw new Error();
      for (const field of [settings.startField, settings.endField]) if (fields[field] !== undefined && saved.rawFields?.[field] !== fields[field]) throw new Error();
      return { ...saved, verified: true };
    } catch { throw clientError('任务可能已创建，但 GET 回读未能核对，请只读检查任务标记。', 'JIRA_REQUIREMENT_CREATE_UNCERTAIN', { uncertain: true, key: created.key, url: `${settings.site}/browse/${created.key}` }); }
  }
  async function linkRequirementIssues({ source, toKey, typeId, confirmed }) {
    if (confirmed !== true) throw clientError('请先确认 Jira 来源关联。', 'JIRA_REQUIREMENT_LINK_CONFIRM', { uncertain: false });
    const { key } = await requirementSource(source);
    if (!issuePattern.test(toKey || '') || !/^\d+$/.test(String(typeId))) throw clientError('Jira 来源关联参数不正确。', 'JIRA_REQUIREMENT_LINK_FIELDS', { uncertain: false });
    await request('issueLink', { method: 'POST', body: { type: { id: String(typeId) }, inwardIssue: { key }, outwardIssue: { key: toKey } }, operation: 'link', emptyResponse: true });
    try {
      const saved = await readRequirementIssue(source);
      if (!saved.links?.some(link => link.key === toKey && String(link.type?.id) === String(typeId))) throw new Error();
      return { verified: true };
    } catch { throw clientError('来源关联可能已写入，但 GET 回读未能核对，请只读检查已有关系。', 'JIRA_REQUIREMENT_LINK_UNCERTAIN', { uncertain: true }); }
  }
  return { readIssue, readTransitions, transitionIssue, connection, calendar, reportIssues, publishComment, listComments,
    maintenanceIssues, readMaintenanceContext, findMaintenanceSlices, createMaintenanceSlice,
    readRequirementContext, readRequirementScheduleContext, updateRequirementDates, findRequirementIssues, createRequirementIssue, linkRequirementIssues,
    sourceIdentity: async source => sourceIdentity(source, (await loadJiraConfiguration(env)).JIRA_BASE_URL || ''),
  };
}

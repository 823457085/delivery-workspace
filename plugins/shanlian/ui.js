import { host } from '../../shared/plugin-application-sdk';
import { serviceApi } from './bridge';
import { hasDelay, visibleNodes, runDelayTests } from './nodes.js';
import { subscriptionUrlFields, writeRuleFields, readRuleFields } from './subscription-ui.js';

export async function start() {
const $ = id => document.getElementById(id);
// Application sandbox blocks native form submission; submit via the checked plugin bridge.
function listenForm(id, handler) {
 const form = $(id), button = form.querySelector('button[type="submit"]') || form.querySelector('button');
 button.type = 'button';
 const submit = () => { if (form.reportValidity()) void handler({preventDefault(){},currentTarget:form}); };
 button.addEventListener('click',submit);
 form.addEventListener('submit',event => event.preventDefault());
 form.addEventListener('keydown',event => {if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();submit();}});
}
let csrf = '', snapshot = null, nodes = [], selected = null, currentView = 'overview', refreshTimer, toastTimer, subscriptionState = null, subscriptionBusy = false, refreshSchedule = null;
let delayRun = null;
const testingNodes = new Set();
const titles = { overview: '连接总览', nodes: '节点选择', subscription: 'Clash 订阅', proxy: '代理接口', account: '闪连账号' };
const bytes = value => { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const n = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4); return `${(value / 1024 ** n).toFixed(n > 1 ? 2 : 0)} ${units[n]}`; };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function api(path, options = {}) {
 try { return await serviceApi(path,options); }
 catch(error) { if (/登录|配置/.test(error.message)) showLogin(); throw error; }
}
const post = (path, data = {}) => api(path, { method: 'POST', body: JSON.stringify(data) });
function clearSubscriptionUi() {
  subscriptionState = null;
  subscriptionBusy = false;
  $('subscription-error').textContent = '';
  $('subscription-status').textContent = '';
  $('subscription-full-url').value = '';
  $('subscription-provider-url').value = '';
  $('subscription-direct-url').value = '';
  $('subscription-direct-provider-url').value = '';
  $('subscription-url-fields').hidden = true;
  writeRuleFields($('subscription-form'));
  $('subscription-rules-preview').textContent = '';
}
function showLogin() {
  if (delayRun) delayRun.stopped = true;
  clearInterval(refreshTimer);
  csrf = '';
  clearSubscriptionUi();
  $('admin-screen').hidden = false;
  $('shanlian-app').hidden = true;
}
async function showApp() { $('admin-screen').hidden = true; $('shanlian-app').hidden = false; await refresh(); clearInterval(refreshTimer); refreshTimer = setInterval(refresh, 6000); }
function setView(view) {
  currentView = Object.hasOwn(titles, view) ? view : 'overview';
  for (const key of Object.keys(titles)) $(`view-${key}`).hidden = key !== currentView;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === currentView); button.setAttribute('aria-current', button.dataset.view === currentView ? 'page' : 'false'); });
  $('page-title').textContent = titles[currentView];

  if (currentView === 'nodes') loadNodes();
  if (currentView === 'subscription') loadSubscription();
  if (currentView === 'proxy') loadNetwork();
  if (currentView === 'account') loadRefreshSchedule();
}
function nodeLabel(id) { return nodes.find(node => node.id === id)?.name ?? (id ? id.replace(/^\[unknown\]\s*/, '') : '自动选择'); }
function renderStatus(value) {
  snapshot = value;
  const connected = value.connected;
  $('connection-badge').textContent = connected ? '连接已建立' : '当前未连接'; $('connection-badge').classList.toggle('off', !connected);
  $('connection-title').textContent = connected ? '闪连正在运行' : '准备建立连接';
  $('connection-description').textContent = connected ? `当前线路：${nodeLabel(value.node?.active)}` : value.account ? '选择节点，连接后即可使用局域网代理。' : '登录闪连账号后，可以在这里建立连接。';
  $('route-node').textContent = connected ? nodeLabel(value.node?.active) : '出口节点';
  $('sidebar-status').textContent = connected ? '闪连已连接' : '闪连未连接';
  $('connection-toggle').textContent = connected ? '断开连接' : '连接闪连';
  $('connection-toggle').disabled = value.busy || (!connected && !value.account?.canConnect);
  $('reconnect').disabled = value.busy || !value.account?.canConnect;
  $('check').disabled = !connected || value.busy;
  $('received').textContent = bytes(value.received); $('sent').textContent = bytes(value.sent);
  $('node-count').textContent = value.node?.count ?? '—'; $('nav-node-count').textContent = value.node?.count ?? '—';
  $('proxy-running').textContent = `${Number(value.httpActive) + Number(value.socksActive)} / 2`;
  $('http-address').textContent = `${value.proxy.address}:${value.proxy.httpPort}`; $('socks-address').textContent = `${value.proxy.address}:${value.proxy.socksPort}`;
  $('http-status').textContent = value.httpActive ? '运行中' : '已停止'; $('socks-status').textContent = value.socksActive ? '运行中' : '已停止';
  $('account-notice').hidden = Boolean(value.account?.canConnect);
  $('account-state').textContent = value.account ? '已登录闪连' : '尚未登录';
  $('account-name').textContent = value.account?.username ?? '—'; $('account-expiry').textContent = value.account?.expires || '—';
  $('account-control').textContent = value.account?.canConnect ? '可以连接与重连' : value.account ? '请检查账号有效期' : '需要登录';
  if (value.lastAction) $('last-action').textContent = `${value.lastAction.label} · ${value.lastAction.ok ? '完成' : '未完成'}`;
  $('refresh-state').textContent = '刚刚同步';
  if (currentView === 'nodes') renderNodes();
}
async function refresh() {
  try {
    const value = await api('/status');
    renderStatus(value);
    if (currentView === 'nodes' && selected !== value.node?.selected) await loadNodes();
  } catch (error) { $('refresh-state').textContent = '同步失败'; }
}
function element(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
function filteredNodes() {
  return visibleNodes(nodes, { query: $('node-search').value, country: $('country-filter').value, sort: $('delay-sort').value });
}
function renderDelayControls() {
  const count = filteredNodes().length;
  $('nodes-test').textContent = `批量测延迟 (${count})`;
  $('nodes-test').disabled = Boolean(delayRun) || !count || !snapshot?.account?.canConnect;
  $('nodes-refresh').disabled = Boolean(delayRun);
  $('nodes-test-stop').hidden = !delayRun?.batch;
  $('nodes-test-stop').disabled = Boolean(delayRun?.stopped);
  if (delayRun) {
    const { completed = 0, total, succeeded = 0, failed = 0 } = delayRun;
    $('nodes-test-progress').textContent = `${delayRun.stopped ? '正在停止，等待当前测试结束' : '正在测试'} · ${completed}/${total} · 可达 ${succeeded} · 未成功 ${failed}`;
  }
}
async function testNodes(ids, batch = false) {
  if (delayRun || !ids.length || !snapshot?.account?.canConnect) return;
  const run = { total: ids.length, batch, stopped: false };
  delayRun = run;
  renderNodes();
  try {
    const result = await runDelayTests(ids, {
      shouldStop: () => run.stopped,
      probe: async id => {
        testingNodes.add(id); renderNodes();
        try { return await api('/nodes/delay', { method: 'POST', body: JSON.stringify({ id }), signal: AbortSignal.timeout(25000) }); }
        finally { testingNodes.delete(id); }
      },
      onResult: (id, value, error) => {
        const node = nodes.find(item => item.id === id);
        if (node) { node.delay = error ? null : value.delay; node.delayTested = true; node.delayError = error?.message; }
        if (error && !batch) toast(error.message);
        renderNodes();
      },
      onProgress: progress => { Object.assign(run, progress); renderDelayControls(); }
    });
    $('nodes-test-progress').textContent = `${result.skipped ? '已停止' : '测试完成'} · ${result.completed}/${result.total} · 可达 ${result.succeeded} · 未成功 ${result.failed}${result.skipped ? ` · 未测试 ${result.skipped}` : ''}`;
  } finally { delayRun = null; renderNodes(); }
}
function renderNodes() {
  const filtered = filteredNodes();
  renderDelayControls();
  $('node-table').replaceChildren(); $('node-results').textContent = `${filtered.length} 个节点`; $('nodes-empty').hidden = filtered.length > 0;
  for (const node of filtered) {
    const row = element('tr', node.id === selected ? 'selected' : '');
    const name = element('td'), cell = element('div', 'node-cell'), info = element('div');
    cell.append(element('span', 'country-code', node.code || 'GL'));
    info.append(element('span', 'node-main', node.name), element('span', 'node-address', node.id)); cell.append(info); name.append(cell); row.append(name);
    row.append(element('td', '', node.protocol));
    const delay = element('td'), test = element('button', 'delay-button', testingNodes.has(node.id) ? '检测中…' : hasDelay(node) ? `${node.delay} ms` : node.delayError ? '测试失败，重试' : node.delayTested ? '暂不可达，重试' : '检测延迟');
    test.disabled = Boolean(delayRun) || !snapshot?.account?.canConnect;
    test.title = node.delayError || '预热后，服务器经此节点访问测速网站的 HTTPS 响应延迟';
    test.addEventListener('click', () => testNodes([node.id])); delay.append(test); row.append(delay);
    row.append(element('td', node.id === selected ? 'node-current' : '', node.id === selected ? '当前选择' : '—'));
    const action = element('td', 'table-action'), choose = element('button', 'button small secondary', node.id === selected ? '已选择' : '使用节点'); choose.disabled = node.id === selected;
    choose.addEventListener('click', async () => { choose.disabled = true; try { await selectNode(node.id); } catch (error) { toast(error.message); choose.disabled = false; } }); action.append(choose); row.append(action); $('node-table').append(row);
  }
}
async function loadNodes() {
  try { const result = await api('/nodes'); nodes = result.nodes; selected = result.selected; const previous = $('country-filter').value; $('country-filter').replaceChildren(element('option', '', '全部地区')); $('country-filter').firstChild.value = ''; for (const country of [...new Set(nodes.map(node => node.country))].sort((a,b) => a.localeCompare(b, 'zh-CN'))) { const option = element('option', '', country); option.value = country; $('country-filter').append(option); } $('country-filter').value = previous; renderNodes(); if (snapshot) renderStatus(snapshot); } catch (error) { toast(error.message); }
}
function setSubscriptionBusy(busy) {
  subscriptionBusy = busy;
  $('subscription-save').disabled = busy;
  $('subscription-copy-full').disabled = busy || !subscriptionState?.fullUrl;
  $('subscription-copy-provider').disabled = busy || !subscriptionState?.providerUrl;
  $('subscription-copy-direct').disabled = busy || !subscriptionState?.directFullUrl;
  $('subscription-copy-direct-provider').disabled = busy || !subscriptionState?.directProviderUrl;
  $('subscription-rotate').disabled = busy || !subscriptionState?.enabled;
  $('subscription-disable').disabled = busy || !subscriptionState?.enabled;
}
function renderSubscription() {
  const form = $('subscription-form');
  if (!subscriptionState) return;
  form.server.value = subscriptionState.server || '';
  form.port.value = subscriptionState.port || '';
  form.transport.value = subscriptionState.tls ? 'tls' : 'plain';
  form.enabled.checked = Boolean(subscriptionState.enabled);
  writeRuleFields(form, subscriptionState.rules);
  form.globalScript.value = subscriptionState.script || '';
  $('subscription-script-state').textContent = subscriptionState.scriptEnabled ? '已启用' : '未启用';
  $('subscription-rules-preview').textContent = (subscriptionState.effectiveRules || []).join('\n');
  const ready = Boolean(subscriptionState.ready);
  const directReady = Boolean(subscriptionState.directReady);
  const urls = subscriptionUrlFields(subscriptionState);
  let statusText = subscriptionState.message || '';
  if (directReady && !ready) {
    statusText = '设备直连订阅可用；服务器转接尚未配置或不可用。';
  }
  if (ready && snapshot && !snapshot.connected) {
    statusText += directReady
      ? ' 管理端当前为断开状态：服务器转接暂停，设备直连不受影响。'
      : ' 管理端当前为断开状态：可下载配置，但转接不会转发流量，需在连接总览先连接闪连。';
  }
  $('subscription-status').textContent = statusText;
  const active = directReady || (ready && snapshot?.connected !== false);
  $('subscription-badge').textContent = active ? '可用' : subscriptionState.enabled ? '待检查' : '未启用';
  $('subscription-badge').classList.toggle('off', !active);
  $('subscription-url-fields').hidden = !urls.visible;
  $('subscription-full-url').value = urls.full;
  $('subscription-provider-url').value = urls.provider;
  $('subscription-direct-url').value = urls.directFull;
  $('subscription-direct-provider-url').value = urls.directProvider;
  $('subscription-url-note').hidden = !urls.visible;
  setSubscriptionBusy(subscriptionBusy);
  if (!subscriptionBusy) {
    $('subscription-copy-full').disabled = !urls.visible;
    $('subscription-copy-provider').disabled = !urls.provider;
    $('subscription-copy-direct').disabled = !urls.directFull;
    $('subscription-copy-direct-provider').disabled = !urls.directProvider;
    $('subscription-rotate').disabled = !subscriptionState.enabled;
    $('subscription-disable').disabled = !subscriptionState.enabled;
  }
}
async function loadSubscription() {
  try {
    subscriptionState = await api('/clash/subscription');
    renderSubscription();
  } catch (error) {
    $('subscription-status').textContent = error.message;
    $('subscription-badge').textContent = '读取失败';
    $('subscription-badge').classList.add('off');
  }
}
async function copySubscription(url) {
  const result = await host.copy(url).then(() => ({copied:true}), () => ({copied:false}));
  if (result.copied) {
    toast('订阅链接已复制');
    return;
  }
  $('subscription-url-fields').hidden = false;
  const fields = new Map([
    [subscriptionState?.providerUrl, $('subscription-provider-url')],
    [subscriptionState?.directFullUrl, $('subscription-direct-url')],
    [subscriptionState?.directProviderUrl, $('subscription-direct-provider-url')],
  ]);
  const field = fields.get(url) || $('subscription-full-url');
  field.value = url;
  field.focus();
  field.select();
  toast('无法写入剪贴板，请手动复制下方链接');
}
function scheduleTime(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
function renderRefreshSchedule() {
  if (!refreshSchedule) return;
  const form = $('refresh-schedule-form');
  form.enabled.checked = Boolean(refreshSchedule.enabled);
  form.intervalMinutes.value = refreshSchedule.intervalMinutes || 360;
  $('refresh-next').textContent = scheduleTime(refreshSchedule.nextRunAt, '未安排');
  $('refresh-last-success').textContent = scheduleTime(refreshSchedule.lastSuccessAt, '尚未执行');
  $('refresh-schedule-status').textContent = refreshSchedule.lastError
    ? `最近一次刷新失败：${refreshSchedule.lastError}`
    : refreshSchedule.enabled ? '自动刷新已启用。' : '自动刷新未启用。';
  $('refresh-schedule-status').className = refreshSchedule.lastError ? 'form-error' : 'caption';
}
async function loadRefreshSchedule() {
  try { refreshSchedule = await api('/account/refresh/schedule'); renderRefreshSchedule(); }
  catch (error) { $('refresh-schedule-error').textContent = error.message; }
}
async function loadNetwork() {
  try { const data = await api('/network'); const select = $('bind-address'); select.replaceChildren(); for (const item of data.addresses) { const option = element('option', '', `${item.address} · ${item.interface}`); option.value = item.address; select.append(option); } for (const [key, value] of Object.entries(data.proxy)) $('proxy-form').elements[key].value = value; } catch (error) { toast(error.message); }
}
async function runConnection(action) {
  $('connection-toggle').disabled = true; $('reconnect').disabled = true;
  try { renderStatus(await post('/connection', { action })); await loadNodes(); toast(action === 'disconnect' ? '闪连已断开' : '连接操作已完成'); } catch (error) { toast(error.message); await refresh(); }
}
async function copyProxy(type) {
  if (!snapshot) return;
  const value = `${snapshot.proxy.address}:${type === 'http' ? snapshot.proxy.httpPort : snapshot.proxy.socksPort}`;
  try { await host.copy(value); toast('代理地址已复制'); }
  catch { toast('复制已取消'); }
}
async function selectNode(id) {
  const result = await post('/nodes/select', { id });
  selected = result.selected; nodes = result.nodes; renderNodes(); await refresh();
  toast(snapshot?.connected ? '节点已切换' : '节点已保存，下次连接时使用'); return { selected: result.selected, active: result.active };
}
async function saveProxy(value) {
  const result = await api('/network', { method: 'PUT', body: JSON.stringify(value) });
  await refresh(); await loadNetwork();
  toast(result.active ? '代理设置已保存并生效' : '代理设置已保存，连接闪连后自动启用');
  return result;
}
listenForm('account-form', async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; button.textContent = '正在登录…'; $('account-error').textContent = '';
  try { const result = await post('/account/login', { username: form.username.value, password: form.password.value, proxy: form.proxy.value.trim() }); form.password.value = ''; await refresh(); toast(result.canConnect ? '闪连账号登录成功' : '账号已登录，请检查有效期和节点资料。'); } catch (error) { $('account-error').textContent = error.message; } finally { button.disabled = false; button.textContent = '登录闪连'; }
});
listenForm('refresh-schedule-form', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = $('refresh-schedule-save');
  button.disabled = true; $('refresh-schedule-error').textContent = '';
  try {
    refreshSchedule = await api('/account/refresh/schedule', { method: 'PUT', body: JSON.stringify({ enabled: form.enabled.checked, intervalMinutes: Number(form.intervalMinutes.value) }) });
    renderRefreshSchedule();
    toast(refreshSchedule.enabled ? '自动刷新计划已保存' : '自动刷新已关闭');
  } catch (error) { $('refresh-schedule-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('admin-logout').addEventListener('click', async () => { try { await post('/session/logout'); } finally { showLogin(); } });
$('refresh').addEventListener('click', async () => { await refresh(); if (currentView === 'account') await loadRefreshSchedule(); }); $('nodes-refresh').addEventListener('click', loadNodes);
$('node-search').addEventListener('input', renderNodes); $('country-filter').addEventListener('change', renderNodes);
$('delay-sort').addEventListener('change', renderNodes);
$('nodes-test').addEventListener('click', () => testNodes(filteredNodes().map(node => node.id), true));
$('nodes-test-stop').addEventListener('click', () => { if (delayRun) { delayRun.stopped = true; renderDelayControls(); } });
listenForm('subscription-form', async event => {
  event.preventDefault();
  if (subscriptionBusy) return;
  const form = event.currentTarget;
  setSubscriptionBusy(true); $('subscription-error').textContent = '';
  try {
    subscriptionState = await api('/clash/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: form.enabled.checked,
        server: form.server.value.trim(),
        port: Number(form.port.value),
        tls: form.transport.value === 'tls',
        rules: readRuleFields(form),
        script: form.globalScript.value
      })
    });
    renderSubscription();
    toast(subscriptionState.enabled ? '订阅与规则已保存，请在客户端更新订阅' : '设置与规则已保存，订阅下载未启用');
  } catch (error) { $('subscription-error').textContent = error.message; }
  finally { setSubscriptionBusy(false); }
});
$('subscription-copy-full').addEventListener('click', () => subscriptionState?.fullUrl && copySubscription(subscriptionState.fullUrl));
$('subscription-copy-provider').addEventListener('click', () => subscriptionState?.providerUrl && copySubscription(subscriptionState.providerUrl));
$('subscription-copy-direct').addEventListener('click', () => subscriptionState?.directFullUrl && copySubscription(subscriptionState.directFullUrl));
$('subscription-copy-direct-provider').addEventListener('click', () => subscriptionState?.directProviderUrl && copySubscription(subscriptionState.directProviderUrl));
$('subscription-rotate').addEventListener('click', async () => {
  if (subscriptionBusy) return;
  setSubscriptionBusy(true);
  try { subscriptionState = await post('/clash/subscription/rotate'); renderSubscription(); toast('订阅链接已重置'); }
  catch (error) { toast(error.message); }
  finally { setSubscriptionBusy(false); renderSubscription(); }
});
$('subscription-disable').addEventListener('click', async () => {
  if (subscriptionBusy) return;
  setSubscriptionBusy(true);
  try {
    subscriptionState = await api('/clash/subscription', { method: 'DELETE', body: '{}' });
    renderSubscription();
    toast('订阅下载已关闭');
  } catch (error) { toast(error.message); }
  finally { setSubscriptionBusy(false); renderSubscription(); }
});
$('connection-toggle').addEventListener('click', () => runConnection(snapshot?.connected ? 'disconnect' : 'connect'));
$('reconnect').addEventListener('click', () => runConnection('reconnect'));
$('check').addEventListener('click', async () => { $('check').disabled = true; $('network-result').textContent = '正在验证代理网络…'; try { const result = await post('/connection/check'); $('network-result').textContent = result.ok ? `代理网络正常 · ${result.duration} ms` : '代理网络暂不可用，请检查连接或更换节点。'; } catch (error) { $('network-result').textContent = error.message; } finally { $('check').disabled = false; } });
$('copy-http').addEventListener('click', () => copyProxy('http')); $('copy-socks').addEventListener('click', () => copyProxy('socks'));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => setView(button.dataset.goto)));
listenForm('proxy-form', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('proxy-save');
  button.disabled = true; button.textContent = '正在应用…'; $('proxy-error').textContent = '';
  try { await saveProxy({ address: form.address.value, httpPort: Number(form.httpPort.value), socksPort: Number(form.socksPort.value), allowedSubnet: form.allowedSubnet.value.trim() }); }
  catch (error) { $('proxy-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '保存并应用'; }
});

async function connect() {
 try { const value = await api('/session'); $('server-address').textContent = value.endpoint || '未配置';
 if(value.authenticated){ await showApp(); await loadNodes(); setView('overview'); }
 else{showLogin();$('admin-error').textContent='尚未配置连接。';}
 }catch(error){showLogin();$('admin-error').textContent=error.message;}
}
$('retry-connection').addEventListener('click',connect);
await connect();
$('account-refresh').addEventListener('click', async () => { const button = $('account-refresh'); button.disabled = true; try { await post('/account/refresh'); await refresh(); await loadNodes(); await loadRefreshSchedule(); toast('账号和节点已更新'); } catch (error) { toast(error.message); } finally { button.disabled = false; } });

}

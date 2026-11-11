import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPluginStore, readPluginFile, applyPluginEnvironment } from '../server/plugins/store.mjs';
import { assertPluginEnabled, pluginBaseUrl } from '../server/plugins/definitions.mjs';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';

test('source startup keeps plugin credentials isolated from legacy files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-startup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = path.join(directory, 'legacy.env');
  await fs.writeFile(legacy, [
    'JIRA_BASE_URL=https://legacy-jira.example.test',
    'JIRA_AUTH_HEADER="Bearer legacy-jira-fixture"',
    'JIRA_COOKIE=legacy-jira-cookie',
    'JIRA_START_DATE_FIELD=customfield_12345',
    'CONFLUENCE_BASE_URL=https://legacy-wiki.example.test',
    'CONFLUENCE_API_TOKEN=legacy-wiki-token',
    'CONFLUENCE_KEYCHAIN_SERVICE=legacy-wiki-keychain',
  ].join('\n'));
  const pluginFile = path.join(directory, 'credentials', 'plugins.json');
  await fs.mkdir(path.dirname(pluginFile));
  await fs.writeFile(pluginFile, JSON.stringify({ version: 1, plugins: {
    jira: { enabled: true, baseUrl: 'https://active-jira.example.test' },
    confluence: { enabled: true, baseUrl: 'https://active-wiki.example.test', token: 'active-wiki-token' },
  } }));
  await promisify(execFile)(process.execPath, [
    `--env-file=${legacy}`, '--import', './server/plugins/bootstrap.mjs', '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { initializeSourceEnvironment } from './server/source-backend.ts';
      initializeSourceEnvironment(5991);
      assert.equal(process.env.JIRA_BASE_URL, 'https://active-jira.example.test');
      assert.equal(process.env.JIRA_AUTH_HEADER, undefined);
      assert.equal(process.env.JIRA_COOKIE, undefined);
      assert.equal(process.env.JIRA_START_DATE_FIELD, 'customfield_12345');
      assert.equal(process.env.CONFLUENCE_BASE_URL, 'https://active-wiki.example.test');
      assert.equal(process.env.CONFLUENCE_AUTH_HEADER, 'Bearer active-wiki-token');
      assert.equal(process.env.CONFLUENCE_API_TOKEN, undefined);
      assert.equal(process.env.CONFLUENCE_KEYCHAIN_SERVICE, undefined);
      const backend = await import('./server/jira-backend/server.mjs');
      globalThis.fetch = () => assert.fail('Unexpected network request');
      delete process.env.JIRA_BASE_URL;
      delete process.env.CONFLUENCE_BASE_URL;
      await assert.rejects(backend.jiraIssueRequest('myself'), /JIRA_BASE_URL/);
      await assert.rejects(backend.confluenceReadRequest('user/current'), /CONFLUENCE_BASE_URL/);
    `,
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH || '', DELIVERY_DATA_DIR: directory, DELIVERY_CREDENTIALS_FILE: legacy }, timeout: 10_000 });
});

test('plugin credentials stay private, survive reload, and never cross site/account boundaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-'));
  try {
    const file = path.join(dir, 'credentials/plugins.json');
    const store = await createPluginStore({ file, env: {} });
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context/', username: 'alice', token: 'private-token' });
    assert.ok(!JSON.stringify(await store.list()).includes('private-token'));
    assert.equal((await store.list())[0].restartRequired, true);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context', username: 'alice', token: '' });
    assert.equal((await readPluginFile(file)).plugins.jira.token, 'private-token');
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context', username: 'bob', token: '' });
    assert.equal((await readPluginFile(file)).plugins.jira.token, '');
    await store.save('jira', { enabled: false, baseUrl: 'https://other.example.com', username: '', token: '' });
    const env = { JIRA_COOKIE: 'old-cookie', JIRA_AUTH_HEADER: 'old-header' } as Record<string, string>;
    applyPluginEnvironment(await readPluginFile(file), env);
    assert.equal(env.JIRA_COOKIE, undefined);
    assert.equal(env.JIRA_AUTH_HEADER, undefined);
    assert.throws(() => assertPluginEnabled('jira', env), /已停用/);
    const reloaded = await createPluginStore({ file, env });
    assert.equal((await reloaded.list())[0].restartRequired, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('read-only probes, webhook validation, unknown fields and malformed storage fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-'));
  try {
    const file = path.join(dir, 'plugins.json'); let calls = 0;
    const store = await createPluginStore({ file, env: {}, fetchImpl: async (url: string, options: RequestInit) => {
      calls++; assert.equal(url, 'https://wiki.example.com/wiki/rest/api/user/current');
      assert.equal(options.redirect, 'error'); assert.equal(options.method, undefined);
      return new Response(JSON.stringify({ username: 'tester' }));
    } });
    await store.test('confluence', { enabled: true, baseUrl: 'https://wiki.example.com/wiki', username: 'tester', token: 'secret' });
    await store.test('wecom', { enabled: true, groupName: 'Test', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret' });
    assert.equal(calls, 1);
    await assert.rejects(store.save('wecom', { enabled: true, webhook: 'https://evil.example/send?key=secret' }));
    await assert.rejects(store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com', token: 'secret\nINJECT=true' }));
    await assert.rejects(store.save('unknown', { enabled: true }));
    await assert.rejects(store.save('jira', { enabled: true, arbitrary: true }));
    await fs.writeFile(file, 'invalid');
    await assert.rejects(store.save('jira', { enabled: true }));
    assert.equal(await fs.readFile(file, 'utf8'), 'invalid');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('legacy keychain connections require the configured site', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-keychain-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plugins.json');
  const env = { JIRA_KEYCHAIN_SERVICE: 'fixture-jira', CONFLUENCE_KEYCHAIN_SERVICE: 'fixture-confluence' };
  const probes: string[] = [];
  const store = await createPluginStore({ file, env, wecomConfig: () => ({ hasWebhook: true }),
    legacyProbe: async id => { probes.push(id); return Response.json({ name: 'fixture' }); },
  });
  assert.deepEqual((await store.list()).slice(0, 2).map(plugin => [plugin.baseUrl, plugin.configured, plugin.runningConfigured]),
    [['', false, false], ['', false, false]]);
  Object.assign(env, { JIRA_BASE_URL: 'https://jira.example.test', CONFLUENCE_BASE_URL: 'https://wiki.example.test' });
  const [jira, confluence] = await store.list();
  assert.equal(jira.baseUrl, pluginBaseUrl('jira', env));
  assert.equal(confluence.baseUrl, pluginBaseUrl('confluence', env));
  assert.equal(jira.runningConfigured, true);
  assert.equal(confluence.runningConfigured, true);
  await store.test('jira', { enabled: true, baseUrl: jira.baseUrl, token: '' });
  await store.test('confluence', { enabled: true, baseUrl: confluence.baseUrl, token: '' });
  await store.test('wecom', { enabled: true, webhook: '' });
  await assert.rejects(store.test('jira', { enabled: true, baseUrl: 'https://different.example.test', token: '' }), /新凭据/);
  await assert.rejects(store.test('jira', { enabled: true, baseUrl: jira.baseUrl, username: 'different-account', token: '' }), /新凭据/);
  await store.save('jira', { enabled: true, baseUrl: jira.baseUrl, token: '' });
  assert.equal((await readPluginFile(file)).plugins.jira.baseUrl, undefined);
  assert.equal((await store.list())[0].runningConfigured, true);
  await store.state('jira', { installed: false });
  await assert.rejects(store.test('jira', { enabled: true, baseUrl: jira.baseUrl, token: '' }), /已停用或移除/);
  assert.deepEqual(probes, ['jira', 'confluence']);
});

test('Jira development keeps the selected account and blocks cached clients when disabled', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-jira-profile-'));
  const previousManaged = process.env.DELIVERY_PLUGIN_JIRA_MANAGED;
  const previousEnabled = process.env.DELIVERY_PLUGIN_JIRA_ENABLED;
  t.after(async () => {
    if (previousManaged === undefined) delete process.env.DELIVERY_PLUGIN_JIRA_MANAGED; else process.env.DELIVERY_PLUGIN_JIRA_MANAGED = previousManaged;
    if (previousEnabled === undefined) delete process.env.DELIVERY_PLUGIN_JIRA_ENABLED; else process.env.DELIVERY_PLUGIN_JIRA_ENABLED = previousEnabled;
    await fs.rm(dir, { recursive: true, force: true });
  });
  process.env.DELIVERY_PLUGIN_JIRA_MANAGED = 'true';
  const profile = path.join(dir, 'selected.env');
  await fs.writeFile(profile, 'JIRA_BASE_URL=https://selected.example.test/context\nJIRA_AUTH_HEADER=Bearer selected-fixture\n');
  const { createConnectionSettings } = await import('../server/jira-dev/connection-settings.mjs');
  const env = { DELIVERY_PLUGIN_JIRA_MANAGED: 'true', DELIVERY_CREDENTIALS_FILE: profile,
    JIRA_BASE_URL: 'https://plugin.example.test', JIRA_AUTH_HEADER: 'Bearer plugin-fixture' };
  const calls: { url: string; authorization: string | null }[] = [];
  const connection = createConnectionSettings({ dataDirectory: dir, env, fetchImpl: async (url: string, options: RequestInit) => {
    calls.push({ url, authorization: new Headers(options.headers).get('Authorization') });
    return Response.json({ name: 'fixture' });
  } });
  const existing = await connection.client();
  await existing.connection();
  await connection.test({ configuration: { mode: 'file', envFile: profile } });
  await assert.rejects(connection.test({ configuration: { mode: 'file', envFile: path.join(dir, 'missing.env') } }), /无法读取/);
  process.env.DELIVERY_PLUGIN_JIRA_ENABLED = 'false';
  await assert.rejects(existing.connection(), /已停用/);
  assert.deepEqual(calls, [
    { url: 'https://plugin.example.test/rest/api/2/myself', authorization: 'Bearer plugin-fixture' },
    { url: 'https://selected.example.test/context/rest/api/2/myself', authorization: 'Bearer selected-fixture' },
  ]);
});

test('disabled plugins block actual Jira and notification calls before network access', async () => {
  const { loadJiraConfiguration } = await import('../server/jira-dev/jira-client.mjs');
  await assert.rejects(loadJiraConfiguration({ DELIVERY_PLUGIN_JIRA_ENABLED: 'false', JIRA_BASE_URL: 'https://jira.example.com', JIRA_AUTH_HEADER: 'Bearer secret' }), /已停用/);
  const { createWecomIntegration } = await import('../server/wecom-integration.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-disabled-'));
  const previous = process.env.DELIVERY_PLUGIN_WECOM_ENABLED;
  const previousInstalled = process.env.DELIVERY_PLUGIN_WECOM_INSTALLED;
  try {
    let calls = 0;
    const service = await createWecomIntegration(dir, { configFile: path.join(dir, 'bot.json'),
      fetch: async () => { calls++; return new Response('{"errcode":0}'); } });
    await service.configure({ groupName: 'Test', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret' });
    const preview = service.messagePreview({ title: 'Test', msgtype: 'text', content: 'Test' });
    assert.equal(preview.canSend, true);
    process.env.DELIVERY_PLUGIN_WECOM_INSTALLED = 'false';
    assert.equal(service.messagePreview(preview.input).canSend, false);
    const item = buildReviewCatalog()[0]!;
    const feedback = service.preview({ interfaceId: item.id, summary: 'Fixture', environment: 'Test',
      parameters: '{}', actual: 'Fixture', expected: 'Fixture', contractReference: 'Fixture' });
    assert.equal(feedback.canSend, false);
    await assert.rejects(service.send({ input: feedback.input, hash: feedback.hash }), /已停用或移除/);
    delete process.env.DELIVERY_PLUGIN_WECOM_INSTALLED;
    process.env.DELIVERY_PLUGIN_WECOM_ENABLED = 'false';
    await assert.rejects(service.sendMessage({ input: preview.input, previewId: preview.previewId, hash: preview.hash }), /已停用/);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.DELIVERY_PLUGIN_WECOM_ENABLED; else process.env.DELIVERY_PLUGIN_WECOM_ENABLED = previous;
    if (previousInstalled === undefined) delete process.env.DELIVERY_PLUGIN_WECOM_INSTALLED; else process.env.DELIVERY_PLUGIN_WECOM_INSTALLED = previousInstalled;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('plugin identity and metadata reads keep the configured site prefix', async t => {
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  const previousSite = process.env.JIRA_BASE_URL;
  const previousHeader = process.env.JIRA_AUTH_HEADER;
  const previousConfluenceSite = process.env.CONFLUENCE_BASE_URL;
  const previousConfluenceHeader = process.env.CONFLUENCE_AUTH_HEADER;
  t.after(() => {
    if (previousSite === undefined) delete process.env.JIRA_BASE_URL; else process.env.JIRA_BASE_URL = previousSite;
    if (previousHeader === undefined) delete process.env.JIRA_AUTH_HEADER; else process.env.JIRA_AUTH_HEADER = previousHeader;
    if (previousConfluenceSite === undefined) delete process.env.CONFLUENCE_BASE_URL; else process.env.CONFLUENCE_BASE_URL = previousConfluenceSite;
    if (previousConfluenceHeader === undefined) delete process.env.CONFLUENCE_AUTH_HEADER; else process.env.CONFLUENCE_AUTH_HEADER = previousConfluenceHeader;
  });
  process.env.JIRA_BASE_URL = 'https://jira.example.test/context';
  process.env.JIRA_AUTH_HEADER = 'Bearer fixture';
  process.env.CONFLUENCE_BASE_URL = 'https://wiki.example.test/context';
  process.env.CONFLUENCE_AUTH_HEADER = 'Bearer fixture';
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (target: string | URL) => {
    const url = new URL(target);
    calls.push(url.href);
    if (url.pathname.endsWith('/attachment/42')) {
      return Response.json({ content: 'https://jira.example.test/context/secure/attachment/42/fixture.txt' });
    }
    return Response.json([]);
  });
  await backend.jiraIssueRequest('project');
  await backend.jiraIssueRequest('myself');
  await backend.jiraIssueRequest('attachment/content/42');
  await backend.confluenceReadRequest('user/current');
  await assert.rejects(backend.jiraIssueRequest('project', 'POST', {}), /仅支持只读/);
  await assert.rejects(backend.jiraIssueRequest('myself', 'POST', {}), /仅支持只读/);
  await assert.rejects(backend.confluenceReadRequest('user/current?anything=true'), /不支持/);
  assert.deepEqual(calls, [
    'https://jira.example.test/context/rest/api/2/project',
    'https://jira.example.test/context/rest/api/2/myself',
    'https://jira.example.test/context/rest/api/2/attachment/42',
    'https://jira.example.test/context/secure/attachment/42/fixture.txt',
    'https://wiki.example.test/context/rest/api/user/current',
  ]);
});

test('disabled backend Jira and Confluence adapters reject before fetch', async t => {
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  const originalJira = process.env.DELIVERY_PLUGIN_JIRA_ENABLED;
  const originalConfluence = process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED;
  t.after(() => {
    if (originalJira === undefined) delete process.env.DELIVERY_PLUGIN_JIRA_ENABLED; else process.env.DELIVERY_PLUGIN_JIRA_ENABLED = originalJira;
    if (originalConfluence === undefined) delete process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED; else process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = originalConfluence;
  });
  process.env.DELIVERY_PLUGIN_JIRA_ENABLED = 'false';
  process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = 'false';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected network request'); });
  await assert.rejects(backend.confluenceReadRequest('content/123?expand=space'), /插件已停用/);
  let responseBody = '';
  await backend.handleJiraTaskCalendarRequest({ method: 'GET', url: '/api/issues?allTime=true', headers: { host: 'localhost:5199' } }, {
    setHeader() {}, writeHead() {}, end(value: string) { responseBody = value; },
  });
  assert.match(responseBody, /插件已停用/);
  assert.equal(calls, 0);
});

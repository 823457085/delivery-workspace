import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBrowserAccountCsv, matchBrowserAccounts, mergeImportedAccounts } from '../shared/system-account-import.js';
import type { BrowserAccount } from '../shared/system-account-import.js';
import type { CatalogSystem, SystemAccount } from '../shared/system-catalog.js';

const header = 'url,username,password';
const login = (url: string, username = 'fixture-user', password = 'fixture-password'): BrowserAccount => ({ url, username, password });
const saved = (id: string, username: string, password: string): SystemAccount => ({ id, username, password,
  hasUsername: !!username, hasPassword: !!password, sourceUrl: '', origin: 'local' });
function system(name: string, region: CatalogSystem['region'], environments: [string, string, string][]): CatalogSystem {
  return { id: name, name, region, repository: '', source: { id: 'fixture', title: 'Fixture', url: '', version: 1 },
    environments: environments.map(([id, name, url]) => ({ id, name, url, branch: '', sourceHref: '', pipeline: '', notes: '', accounts: [] })) };
}

test('Chrome CSV保留引号、逗号、多行、CRLF及原凭据空格，支持BOM和可选列', () => {
  const input = '\uFEFFname,url,username,password,note\r\n'
    + '"Example, Inc",https://example.test/login,"user,""QA"""," one,\r\n""two"" ","note\nsecond line"\r\n'
    + 'Other,https://other.example.test/, plain-user , plain-password ,\r\n';
  assert.deepEqual(parseBrowserAccountCsv(input), [
    login('https://example.test/login', 'user,"QA"', ' one,\r\n"two" '),
    login('https://other.example.test/', ' plain-user ', ' plain-password '),
  ]);
  assert.deepEqual(parseBrowserAccountCsv('PASSWORD, URL ,USERNAME\np,https://example.test,u'), [login('https://example.test/', 'u', 'p')]);
  assert.deepEqual(parseBrowserAccountCsv(header + '\r\n\r\n'), []);
});

test('非法网址或空账号密码忽略，不接受网址内嵌凭据或非网页协议', () => {
  const data = [header, 'javascript:alert(1),u,p', 'file:///tmp/local,u,p', 'https://inline:secret@example.test/,u,p',
    'example.test,u,p', 'https://example.test/,,p', 'https://example.test/,u,', 'https://example.test/,   ,p',
    'https://example.test/,valid,fixture-only'].join('\n');
  assert.deepEqual(parseBrowserAccountCsv(data), [login('https://example.test/', 'valid', 'fixture-only')]);
});

test('畸形CSV和缺失/重复必填列拒绝，错误不回显内容', () => {
  const secretMarker = 'fixture-do-not-echo';
  const badInputs = ['', 'name,url,username', 'url,username,password, URL',
    `${header}\nhttps://example.test,u,"${secretMarker}`, `${header}\nhttps://example.test,u,"${secretMarker}"x`,
    `${header}\nhttps://example.test,u,ab"${secretMarker}`, `${header}\nhttps://example.test,u`,
    `${header}\nhttps://example.test,u,p,extra`, `${header}\n""`];
  for (const input of badInputs) assert.throws(() => parseBrowserAccountCsv(input), (error: Error) => {
    assert.doesNotMatch(error.message, new RegExp(secretMarker));
    assert.match(error.message, /CSV/);
    return true;
  });
});

test('CSV按UTF8字节、逻辑数据行和字段长度限制，带引号换行不多算记录', () => {
  assert.throws(() => parseBrowserAccountCsv('name,' + header + '\n' + '名'.repeat(800_000) + ',https://example.test,u,p'), /2 MiB/);
  assert.throws(() => parseBrowserAccountCsv(header + '\n' + 'https://example.test,u,p\n'.repeat(10_001)), /10000/);
  assert.equal(parseBrowserAccountCsv(header + '\n' + 'https://example.test,u,p\n'.repeat(10_000)).length, 10_000);
  assert.throws(() => parseBrowserAccountCsv(`${header}\nhttps://example.test,${'u'.repeat(501)},p`), /长度/);
  assert.throws(() => parseBrowserAccountCsv(`${header}\nhttps://example.test,u,${'p'.repeat(2001)}`), /长度/);
  assert.equal(parseBrowserAccountCsv(`${header}\nhttps://example.test,${'u'.repeat(500)},${'p'.repeat(2000)}`).length, 1);
  assert.equal(parseBrowserAccountCsv(`${header}\nhttps://example.test,u,"line1\nline2"`).length, 1);
});

test('Web IM和V2按完整origin精确隔离，只匹配海外，不跨协议、子域、端口', () => {
  const systems = [system('Web IM', '海外', [['old-test', '测试', 'https://web-im-test.example.test/']]),
    system('Web IM 2.0', '海外', [['v2-test', '测试', 'https://web-im-v2-test.example.test/'], ['v2-pre', '预发布', 'https://web-im-v2-pre.example.test/']]),
    system('国内系统', '国内', [['domestic', '测试', 'https://domestic.example.test/']])];
  const accounts = [login('https://web-im-test.example.test/login'), login('https://web-im-v2-test.example.test/login'),
    login('https://web-im-v2-pre.example.test/'), login('http://web-im-v2-test.example.test/'),
    login('https://web-im-v2-test.example.test:8443/'), login('https://child.web-im-v2-test.example.test/'),
    login('https://domestic.example.test/')];
  const before = JSON.stringify({ systems, accounts });
  const result = matchBrowserAccounts(accounts, systems);
  assert.deepEqual(result.groups.map(group => [group.environmentId, group.systemName, group.environmentName, group.accounts.length]),
    [['old-test', 'Web IM', '测试', 1], ['v2-test', 'Web IM 2.0', '测试', 1], ['v2-pre', 'Web IM 2.0', '预发布', 1]]);
  assert.equal(result.unmatchedCount, 4);
  assert.equal(result.duplicateCount, 0);
  assert.equal(JSON.stringify({ systems, accounts }), before);
});

test('同源多个环境保持未匹配；同origin相同凭据去重，密码不同的记录保留待合并判断', () => {
  const systems = [system('歧义系统', '海外', [['one', '环境一', 'https://shared.example.test/a'], ['two', '环境二', 'https://shared.example.test/b']]),
    system('唯一系统', '海外', [['unique', '测试', 'https://unique.example.test/']])];
  const result = matchBrowserAccounts([login('https://shared.example.test/a'), login('https://unique.example.test/one'),
    login('https://unique.example.test:443/two'), login('https://unique.example.test/', 'fixture-user', 'changed-fixture'),
    login('https://unknown.example.test/')], systems);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].environmentId, 'unique');
  assert.equal(result.groups[0].accounts.length, 2);
  assert.equal(result.unmatchedCount, 2);
  assert.equal(result.duplicateCount, 1);
  const duplicateId = [system('重复ID', '海外', [['same', '一', 'https://one.example.test/'], ['same', '二', 'https://two.example.test/']])];
  assert.equal(matchBrowserAccounts([login('https://one.example.test/')], duplicateId).unmatchedCount, 1);
});

test('合并保留所有原账号与ID；相同跳过、冲突不覆盖、空密码补齐单独计updated', () => {
  const existing = [saved('known-id', 'known', 'saved-fixture'), saved('empty-id', 'empty', ''), saved('untouched-id', 'untouched', 'keep-fixture')];
  const incoming = [{ username: 'known', password: 'saved-fixture' }, { username: 'known', password: 'conflicting-fixture' },
    { username: 'empty', password: 'filled-fixture' }, { username: 'new', password: 'new-fixture' },
    { username: 'new', password: 'new-fixture' }];
  const before = JSON.stringify({ existing, incoming });
  const result = mergeImportedAccounts(existing, incoming);
  assert.deepEqual(result, { accounts: [{ id: 'known-id', username: 'known', password: 'saved-fixture' },
    { id: 'empty-id', username: 'empty', password: 'filled-fixture' }, { id: 'untouched-id', username: 'untouched', password: 'keep-fixture' },
    { username: 'new', password: 'new-fixture' }], added: 1, updated: 1, skipped: 2, conflicts: 1 });
  assert.equal(JSON.stringify({ existing, incoming }), before);
});

test('已有同名非空密码时不借空项覆盖冲突，旧重复记录也全部保留', () => {
  const existing = [saved('blank', 'same', ''), saved('kept', 'same', 'existing-fixture'), saved('duplicate', 'same', 'existing-fixture')];
  const result = mergeImportedAccounts(existing, [{ username: 'same', password: 'different-fixture' }]);
  assert.equal(result.conflicts, 1);
  assert.equal(result.accounts.length, 3);
  assert.equal(result.accounts[0].password, '');
  assert.deepEqual(result.accounts.map(item => item.id), ['blank', 'kept', 'duplicate']);
});

test('合并超过20整体拒绝且原数据不变，已满环境仍可跳过重复或补齐空密码', () => {
  const existing = Array.from({ length: 20 }, (_, index) => saved(`id-${index}`, `user-${index}`, index ? 'fixture' : ''));
  const before = JSON.stringify(existing);
  assert.throws(() => mergeImportedAccounts(existing, [{ username: 'new-fixture', password: 'do-not-echo-fixture' }]), (error: Error) => {
    assert.equal(error.message, '每个环境最多保存 20 个账号，请减少导入数量后重试');
    return true;
  });
  assert.equal(JSON.stringify(existing), before);
  const result = mergeImportedAccounts(existing, [{ username: 'user-0', password: 'filled-fixture' }, { username: 'user-1', password: 'fixture' }]);
  assert.equal(result.accounts.length, 20);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.throws(() => mergeImportedAccounts([...existing, saved('extra', 'extra', 'fixture')], []), /20/);
  assert.throws(() => mergeImportedAccounts([], [{ username: 'u'.repeat(501), password: 'fixture' }]), /长度/);
});

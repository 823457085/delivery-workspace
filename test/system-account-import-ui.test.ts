/** Execute the actual SFC actions with fake CSV and delayed HTTP responses; no local account store is accessed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { matchBrowserAccounts, mergeImportedAccounts, parseBrowserAccountCsv } from '../shared/system-account-import.js';
import type { CatalogSystem, SystemAccount } from '../shared/system-catalog.js';

const revision = (digit: string) => digit.repeat(64);
const system = (id: string): CatalogSystem => ({ id, name: `System ${id}`, region: '海外', repository: '',
  source: { id, title: 'Fixture', url: 'https://docs.example.test', version: 1 },
  environments: [{ id: `env-${id}`, name: 'Test', branch: '', url: `https://${id}.example.test/login`, sourceHref: '', pipeline: '', notes: '', accounts: [] }] });
const systems = [system('a'), system('b')];
const csv = (ids = ['a', 'b']) => `name,url,username,password\n${ids.map(id => `${id},https://${id}.example.test/sign-in,FAKE_USER_${id},FAKE_SECRET_${id}`).join('\n')}`;
const catalog = { syncedAt: 'fixture', sources: [], systems };
const savedAccount = (id: string): SystemAccount => ({ id: `account-${id}`, username: `FAKE_USER_${id}`, password: `FAKE_SECRET_${id}`,
  hasUsername: true, hasPassword: true, origin: 'local', sourceUrl: '' });
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

function transport() {
  const requests: { url: string; input: any; signal?: AbortSignal; resolve: (value: unknown, status?: number) => void; reject: (cause: Error) => void }[] = [];
  const fetch = (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ url, input: JSON.parse(String(init.body)), signal: init.signal || undefined,
      resolve: (value, status = 200) => resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })), reject });
  });
  const respond = async (index: number, value: unknown, status = 200) => { requests[index].resolve(value, status); await flush(); };
  return { fetch, requests, respond };
}

function source(path: string) {
  const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
  const script = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  return { raw, tree: ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}
function execute(statements: ts.Statement[], tree: ts.SourceFile, dependencies: Record<string, unknown>, names: string[]) {
  const code = ts.transpileModule(statements.map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies));
}
function importer() {
  const { raw, tree } = source('../src/features/system-catalog/BrowserAccountImport.vue');
  const props = reactive({ modelValue: true, systems });
  const events: { name: string; value: unknown }[] = [], messages: string[] = [], cleanups: (() => void)[] = [];
  const http = transport(), scope = effectScope();
  const state = scope.run(() => execute(tree.statements.filter(node => !ts.isImportDeclaration(node)), tree, {
    computed, ref, shallowRef, watch, matchBrowserAccounts, mergeImportedAccounts, parseBrowserAccountCsv,
    defineProps: () => props, defineEmits: () => (name: string, value: unknown) => events.push({ name, value }),
    onBeforeUnmount: (fn: () => void) => cleanups.push(fn), fetch: http.fetch,
    ElMessage: { error: (message: string) => messages.push(message), warning: (message: string) => messages.push(message), success: (message: string) => messages.push(message) },
  }, ['selectFile', 'save', 'rows', 'totals', 'saving', 'parsing', 'parsed', 'selectedCount', 'unmatchedCount', 'duplicateCount']))!;
  const choose = (content: string | Promise<string>) => state.selectFile({ target: { files: [{ name: 'fake-passwords.csv', size: 200, text: () => Promise.resolve(content) }] } });
  return { state, props, events, messages, raw, choose, ...http, close: async () => { props.modelValue = false; await nextTick(); },
    reopen: async () => { props.modelValue = true; await nextTick(); }, cleanup: () => { cleanups.forEach(fn => fn()); scope.stop(); } };
}

test('CSV preview stays local and contains no credential bindings; unchecked environments never produce a write', async () => {
  const f = importer();
  try {
    await f.choose(`${csv()}\na,https://a.example.test/sign-in,FAKE_USER_a,FAKE_SECRET_a\nx,https://outside.example.test,FAKE_OUTSIDE,FAKE_OUTSIDE_SECRET`);
    assert.equal(f.requests.length, 0, 'choosing and previewing a file must not call the account API');
    assert.equal(f.state.rows.value.length, 2);
    assert.equal(f.state.duplicateCount.value, 1);
    assert.equal(f.state.unmatchedCount.value, 1);
    f.state.rows.value[1].selected = false;
    const saving = f.state.save();
    assert.deepEqual(f.requests[0].input, { environmentId: 'env-a' });
    await f.respond(0, { accounts: [], revision: revision('a') });
    assert.equal(f.requests[1].url, '/api/systems/accounts/save');
    assert.equal(f.requests[1].input.expectedRevision, revision('a'));
    assert.deepEqual(f.requests[1].input.accounts, [{ username: 'FAKE_USER_a', password: 'FAKE_SECRET_a' }]);
    await f.respond(1, catalog); await saving;
    assert.equal(f.state.rows.value[0].status, 'done');
    assert.deepEqual(f.state.rows.value[0].accounts, []);
    await f.state.save(); assert.equal(f.requests.length, 2);
    assert.equal(f.requests.some(request => request.input.environmentId === 'env-b'), false);
    const template = f.raw.split('<template>')[1].split('<style')[0];
    assert.doesNotMatch(template, /(?:row|account)\.(?:accounts|username|password)/);
    assert.doesNotMatch(f.messages.join('\n') + JSON.stringify(f.events), /FAKE_(?:USER|SECRET|OUTSIDE)/);
  } finally { f.cleanup(); }
});

test('partial failure retains only the failed selection; retry rereads its revision and preserves concurrent accounts', async () => {
  const f = importer();
  try {
    await f.choose(csv());
    const first = f.state.save();
    await f.respond(0, { accounts: [], revision: revision('a') }); await f.respond(1, catalog);
    await f.respond(2, { accounts: [], revision: revision('b') });
    await f.respond(3, { message: 'L409_ACCOUNT_CHANGED' }, 409); await first;
    assert.equal(f.state.rows.value[0].status, 'done');
    assert.equal(f.state.rows.value[1].status, 'failed');
    assert.equal(f.state.rows.value[1].failure, 'L409_ACCOUNT_CHANGED');
    assert.equal(f.state.totals.value.environments, 1);
    const retry = f.state.save();
    assert.deepEqual(f.requests[4].input, { environmentId: 'env-b' });
    const concurrent = { ...savedAccount('other'), username: 'FAKE_CONCURRENT' };
    await f.respond(4, { accounts: [concurrent], revision: revision('c') });
    assert.equal(f.requests[5].input.expectedRevision, revision('c'));
    assert.equal(f.requests[5].input.accounts[0].id, concurrent.id);
    assert.equal(f.requests[5].input.accounts.length, 2);
    await f.respond(5, catalog); await retry;
    assert.equal(f.state.totals.value.environments, 2);
    assert.equal(f.requests.filter(request => request.url.endsWith('/save') && request.input.environmentId === 'env-a').length, 1);
    assert.ok(f.state.rows.value.every((row: any) => row.status === 'done' && row.accounts.length === 0));
  } finally { f.cleanup(); }
});

test('a lost save response is reconciled by rereading on retry, so an already saved account is not written twice', async () => {
  const f = importer();
  try {
    await f.choose(csv(['a']));
    const first = f.state.save(); await f.respond(0, { accounts: [], revision: revision('a') });
    f.requests[1].reject(new Error('Network unavailable')); await first;
    const retry = f.state.save(); await f.respond(2, { accounts: [savedAccount('a')], revision: revision('b') }); await retry;
    assert.equal(f.requests.filter(request => request.url.endsWith('/save')).length, 1);
    assert.equal(f.state.rows.value[0].status, 'done');
    assert.equal(f.state.totals.value.skipped, 1);
  } finally { f.cleanup(); }
});

test('closing invalidates delayed file parsing and read responses; unmount aborts and never starts the pending write', async () => {
  const f = importer();
  try {
    let resolveFile!: (value: string) => void;
    const parsing = f.choose(new Promise<string>(resolve => { resolveFile = resolve; }));
    await f.close(); await f.reopen(); await f.choose(csv(['b']));
    resolveFile(csv(['a'])); await parsing;
    assert.equal(f.state.rows.value[0].environmentId, 'env-b');
    const saving = f.state.save();
    f.cleanup();
    assert.equal(f.requests[0].signal?.aborted, true);
    await f.respond(0, { accounts: [], revision: revision('a') }); await saving;
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.state.rows.value, []);
    assert.equal(f.events.length, 0);
  } finally { f.cleanup(); }
});

test('a late save after closing cannot replace a new import target, clear its busy state or emit the stale result', async () => {
  const f = importer();
  try {
    await f.choose(csv(['a'])); const first = f.state.save();
    await f.respond(0, { accounts: [], revision: revision('a') });
    await f.close(); await f.reopen(); await f.choose(csv(['b'])); const second = f.state.save();
    await f.respond(1, catalog); await first;
    assert.equal(f.state.rows.value[0].environmentId, 'env-b');
    assert.equal(f.state.saving.value, true);
    assert.equal(f.events.length, 0);
    assert.equal(f.state.totals.value.environments, 0);
    await f.respond(2, { accounts: [], revision: revision('b') }); await f.respond(3, catalog); await second;
    assert.equal(f.events.length, 1);
    assert.equal(f.state.rows.value[0].status, 'done');
  } finally { f.cleanup(); }
});

test('a read without a revision fails closed instead of sending an unconditional account replacement', async () => {
  const f = importer();
  try {
    await f.choose(csv(['a'])); const saving = f.state.save();
    await f.respond(0, { accounts: [] }); await saving;
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.rows.value[0].status, 'failed');
    assert.equal(f.state.rows.value[0].selected, true);
  } finally { f.cleanup(); }
});

function editor() {
  const { tree } = source('../src/features/system-catalog/SystemCatalog.vue');
  const start = tree.text.indexOf('const accountsOpen =');
  const statements = tree.statements.filter(node => node.getStart(tree) >= start || ts.isFunctionDeclaration(node) && node.name?.text === 'api');
  const http = transport(), scope = effectScope(), cleanups: (() => void)[] = [];
  const messages: string[] = [], updates: unknown[] = [];
  const state = scope.run(() => execute(statements, tree, { ref, shallowRef, fetch: http.fetch,
    onBeforeUnmount: (fn: () => void) => cleanups.push(fn), crypto,
    client: { setQueryData: (_key: string[], value: unknown) => updates.push(value) },
    ElMessage: { success: (message: string) => messages.push(message), error: (message: string) => messages.push(message) },
  }, ['openAccounts', 'saveAccounts', 'clearAccounts', 'addAccount', 'accountsOpen', 'accountsLoading', 'saving', 'drafts', 'accountTarget', 'accountRevision']))!;
  const open = (index = 0) => state.openAccounts(systems[index], systems[index].environments[0]);
  return { state, messages, updates, open, ...http, close: () => { state.accountsOpen.value = false; state.clearAccounts(); },
    cleanup: () => { cleanups.forEach(fn => fn()); scope.stop(); } };
}

test('ordinary account editing sends its read revision, prevents duplicate writes and retains drafts on an exact API error', async () => {
  const f = editor();
  try {
    const opening = f.open(); await f.respond(0, { accounts: [savedAccount('a')], revision: revision('a') }); await opening;
    f.state.drafts.value[0].password = 'FAKE_NEW_SECRET';
    const saving = f.state.saveAccounts(); await f.state.saveAccounts();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].input.expectedRevision, revision('a'));
    assert.equal(f.requests[1].input.environmentId, 'env-a');
    await f.respond(1, { message: 'L409_ACCOUNT_CHANGED' }, 409); await saving;
    assert.equal(f.state.accountsOpen.value, true);
    assert.equal(f.state.drafts.value[0].password, 'FAKE_NEW_SECRET');
    assert.equal(f.state.accountRevision.value, revision('a'));
    assert.equal(f.messages.at(-1), 'L409_ACCOUNT_CHANGED');
    assert.doesNotMatch(f.messages.join('\n'), /FAKE_(?:USER|SECRET|NEW)/);
  } finally { f.cleanup(); }
});

test('ordinary editor ignores old reads and saves after closing, switching environments or unmounting', async () => {
  const f = editor();
  try {
    const oldRead = f.open(); f.close(); const currentRead = f.open(1);
    await f.respond(1, { accounts: [savedAccount('b')], revision: revision('b') }); await currentRead;
    await f.respond(0, { accounts: [savedAccount('a')], revision: revision('a') }); await oldRead;
    assert.equal(f.state.drafts.value[0].username, 'FAKE_USER_b');
    const oldSave = f.state.saveAccounts(); f.close(); const nextRead = f.open();
    await f.respond(3, { accounts: [savedAccount('a')], revision: revision('c') }); await nextRead;
    await f.respond(2, catalog); await oldSave;
    assert.equal(f.state.accountsOpen.value, true);
    assert.equal(f.state.drafts.value[0].username, 'FAKE_USER_a');
    assert.equal(f.state.accountRevision.value, revision('c'));
    assert.equal(f.updates.length, 0);
    const unmountedSave = f.state.saveAccounts(); f.cleanup();
    await f.respond(4, catalog); await unmountedSave;
    assert.equal(f.updates.length, 0);
    assert.deepEqual(f.state.drafts.value, []);
    assert.equal(f.messages.length, 0);
  } finally { f.cleanup(); }
});

test('ordinary editor cannot save a response that has no revision', async () => {
  const f = editor();
  try {
    const opening = f.open(); await f.respond(0, { accounts: [savedAccount('a')] }); await opening;
    await f.state.saveAccounts();
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.accountsOpen.value, false);
    assert.equal(f.state.accountRevision.value, undefined);
  } finally { f.cleanup(); }
});

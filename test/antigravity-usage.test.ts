import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityUsageFailure, createAntigravityUsageReader, normalizeAntigravityUsage } from '../server/antigravity-usage.js';

const checkedAt = '2026-11-02T02:00:00.000Z';
const payload = {
  status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9528496265411377,
        reset_time: '2026-11-08T18:57:41Z', description: 'Original weekly description.' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8926019668579102, reset_time: '2026-11-02T06:18:25Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.8500137329101562, reset_time: '2026-11-08T19:11:06Z' },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.7466202974319458, reset_time: '2026-11-02T06:31:31Z' },
    ] },
  ] } },
};

test('Antigravity /usage preserves native group/window labels, all four remaining percentages and reset times', () => {
  const usage = normalizeAntigravityUsage(payload, checkedAt);
  assert.equal(usage.available, true);
  assert.equal(usage.checkedAt, checkedAt);
  assert.deepEqual(usage.groups.map(group => group.name), ['Gemini Models', 'Claude and GPT models']);
  assert.deepEqual(usage.groups.flatMap(group => group.buckets.map(bucket => Math.round(bucket.remainingPercent))), [95, 89, 85, 75]);
  assert.deepEqual(usage.groups[0]!.buckets.map(bucket => bucket.name), ['Weekly Limit Remaining', 'Five Hour Limit Remaining']);
  assert.equal(usage.groups[0]!.buckets[0]!.description, 'Original weekly description.');
  assert.equal(usage.groups[1]!.buckets[1]!.resetsAt, Date.parse('2026-11-02T06:31:31Z') / 1000);
});

test('Antigravity preserves disabled windows and native model-group descriptions', () => {
  const native = { status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [{
    name: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0 },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, disabled: true,
        description: 'You have hit your weekly limit, the 5-hour limit does not currently apply.' },
    ],
  }] } } };
  const usage = normalizeAntigravityUsage(native, checkedAt);
  assert.equal(usage.available, true);
  assert.equal(usage.groups[0]!.description, native.command.data.groups[0]!.description);
  assert.equal(usage.groups[0]!.buckets[0]!.remainingPercent, 0);
  assert.equal(usage.groups[0]!.buckets[0]!.disabled, undefined);
  assert.equal(usage.groups[0]!.buckets[1]!.remainingPercent, 100);
  assert.equal(usage.groups[0]!.buckets[1]!.disabled, true);
  assert.equal(usage.groups[0]!.buckets[1]!.description, native.command.data.groups[0]!.buckets[1]!.description);
});

test('Antigravity rejects model replies, failed metadata and invalid fractions without inventing exhausted or full quota', () => {
  for (const value of [null, { ...payload, num_turns: 1 }, { ...payload, status: 'ERROR' },
    { ...payload, command: { name: 'model', data: payload.command.data } }, { status: 'SUCCESS', num_turns: 0, response: '95%' }]) {
    const result = normalizeAntigravityUsage(value, checkedAt);
    assert.equal(result.available, false); assert.deepEqual(result.groups, []);
  }
  const invalid = structuredClone(payload);
  invalid.command.data.groups = [{ name: 'L_GROUP', buckets: [
    ...[null, '0.5', -0.1, 1.1, Number.NaN].map((remaining_fraction, index) => ({ id: `invalid-${index}`, name: 'L_WINDOW', window: '5h', remaining_fraction, reset_time: '' })),
    { id: 'empty', name: 'L_EMPTY', window: 'weekly', remaining_fraction: 0, reset_time: 'invalid' },
    { id: 'full', name: 'L_FULL', window: '5h', remaining_fraction: 1, reset_time: '2026-11-02T06:18:25Z' },
  ] }] as typeof invalid.command.data.groups;
  const result = normalizeAntigravityUsage(invalid, checkedAt);
  assert.equal(result.groups[0]!.name, 'L_GROUP');
  assert.deepEqual(result.groups[0]!.buckets.map(bucket => [bucket.name, bucket.remainingPercent]), [['L_EMPTY', 0], ['L_FULL', 100]]);
  assert.equal(result.groups[0]!.buckets[0]!.resetsAt, null);
});

test('Antigravity reader calls only native /usage in an empty directory, shares requests and supports refresh', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-usage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'agy.mjs'), calls = path.join(directory, 'calls.jsonl');
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.') })+String.fromCharCode(10));
setTimeout(() => console.log(${JSON.stringify(JSON.stringify(payload))}), 80);
`, { mode: 0o700 });
  const read = createAntigravityUsageReader(binary);
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual(first, second); assert.equal(first.available, true);
  await read();
  let invocations = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args.slice(0, 4), ['-p', '/usage', '--output-format', 'json']);
  assert.deepEqual(JSON.parse(invocations[0].args[5]), { disableSlashCommands: false, useG1Credits: false });
  assert.deepEqual(invocations[0].files, []);
  await assert.rejects(fs.access(invocations[0].cwd), { code: 'ENOENT' });
  await Promise.all([read(true), read(true)]);
  invocations = (await fs.readFile(calls, 'utf8')).trim().split('\n');
  assert.equal(invocations.length, 2);
});

test('Antigravity quota timeouts and CLI failures expose no raw credentials or fabricated windows', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-usage-error-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, code] of [
    ['failed', "console.error('private@example.invalid Bearer PRIVATE_TOKEN'); process.exit(1);"],
    ['invalid', "console.log('not JSON: PRIVATE_TOKEN');"],
    ['timeout', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  ]) {
    const binary = path.join(directory, `${name}.mjs`);
    await fs.writeFile(binary, `#!/usr/bin/env node\n${code}`, { mode: 0o700 });
    const result = await createAntigravityUsageReader(binary, 60_000, 250)();
    assert.equal(result.available, false); assert.deepEqual(result.groups, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|private@/);
  }
});

test('native refresh timeout is distinct from revoked login and raw diagnostics never escape', () => {
  const timeout = antigravityUsageFailure({ stdout: JSON.stringify({ error: 'authentication failed or timed out' }),
    stderr: 'authentication required PRIVATE_TOKEN private@example.invalid' });
  assert.equal(timeout.errorKind, 'timeout');
  assert.match(timeout.message!, /超时/);
  const revoked = antigravityUsageFailure({ stderr: 'invalid_grant: revoked refresh token PRIVATE_TOKEN' });
  assert.equal(revoked.errorKind, 'authentication');
  assert.equal(antigravityUsageFailure({ stderr: 'invalid_grant; authentication failed or timed out', killed: true }).errorKind, 'authentication');
  assert.doesNotMatch(JSON.stringify([timeout, revoked]), /PRIVATE_TOKEN|private@/);
});

test('one transient quota failure retries the native metadata probe and recovers without losing known quota', async () => {
  let count = 0;
  const read = createAntigravityUsageReader('unused', 60_000, 20_000, { request: async () => {
    count++;
    return count === 2 ? antigravityUsageFailure({ code: 'ECONNRESET' }) : normalizeAntigravityUsage(payload, checkedAt);
  } });
  assert.equal((await read()).available, true);
  const [a, b] = await Promise.all([read(true), read(true)]);
  assert.equal(count, 3);
  assert.deepEqual(a, b);
  assert.equal(a.available, true);
  assert.equal(a.stale, undefined);
});

test('persistent failures retain clearly dated quota briefly, retry sooner, expire and recover', async () => {
  let now = 100_000, count = 0, failing = false;
  const read = createAntigravityUsageReader('unused', 60_000, 20_000, { now: () => now, staleMs: 20_000,
    failureTtlMs: 5_000, request: async () => { count++; return failing
      ? antigravityUsageFailure({ code: 'ETIMEDOUT' }) : normalizeAntigravityUsage(payload, checkedAt); } });
  const first = await read();
  failing = true; now += 1_000;
  const stale = await read(true);
  assert.equal(stale.stale, true);
  assert.equal(stale.checkedAt, first.checkedAt);
  assert.equal(stale.lastSuccessAt, checkedAt);
  assert.deepEqual(stale.groups, first.groups);
  assert.equal(stale.errorKind, 'timeout');
  assert.equal(count, 3);
  now += 4_999; await read(); assert.equal(count, 3);
  now += 1; await read(); assert.equal(count, 5);
  now = 120_000;
  const expired = await read();
  assert.equal(expired.available, false);
  assert.deepEqual(expired.groups, []);
  failing = false; now += 5_000;
  const recovered = await read();
  assert.equal(recovered.available, true);
  assert.equal(recovered.stale, undefined);
  assert.equal(recovered.errorKind, undefined);
});

test('explicit authentication failure clears the old account quota without automatic auth loops', async () => {
  let count = 0;
  const read = createAntigravityUsageReader('unused', 60_000, 20_000, { request: async () => ++count === 1
    ? normalizeAntigravityUsage(payload, checkedAt) : antigravityUsageFailure({ stderr: 'UNAUTHENTICATED invalid_grant' }) });
  await read();
  const failed = await read(true);
  assert.equal(count, 2);
  assert.equal(failed.available, false);
  assert.equal(failed.stale, undefined);
  assert.deepEqual(failed.groups, []);
});

test('account version change isolates cached quota and late in-flight responses', async () => {
  const requests: ((value: ReturnType<typeof normalizeAntigravityUsage>) => void)[] = [];
  const read = createAntigravityUsageReader('unused', 60_000, 20_000, { request: () => new Promise(resolve => requests.push(resolve)) });
  const old = read(false, 'account-a');
  const current = read(false, 'account-b');
  assert.equal(requests.length, 2);
  requests[1](antigravityUsageFailure({ stderr: 'UNAUTHENTICATED' }));
  assert.equal((await current).available, false);
  requests[0](normalizeAntigravityUsage(payload, checkedAt));
  await old;
  const cached = await read(false, 'account-b');
  assert.equal(requests.length, 2);
  assert.equal(cached.available, false);
  assert.deepEqual(cached.groups, []);
});

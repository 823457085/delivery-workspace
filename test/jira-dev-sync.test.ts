import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJiraDevSync } from '../server/jira-dev-sync';

test('jira-dev sync rejects manifests not signed by the plugin key and leaves files untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jira-dev-sync-'));
  const jiraDevDirectory = path.join(root, 'jira-dev');
  await cp(path.join(import.meta.dirname, '../server/jira-dev/skills'), path.join(jiraDevDirectory, 'skills'), { recursive: true });
  const before = await readdir(jiraDevDirectory);
  const { privateKey } = generateKeyPairSync('ed25519');
  const payload = Buffer.from(JSON.stringify({ plugin: 'jira-dev-workbench', version: '9.0.0', publishedAt: '2026-10-24T00:00:00Z', notes: [],
    download: { url: 'https://jira-dev-workbench-updates.demo-user230.chatgpt.site/x.zip', sha256: 'a'.repeat(64), size: 10 }, installation: { releaseRoot: 'r', pluginDirectory: 'p' } }));
  const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') });
  const fetchImpl = (async () => new Response(envelope)) as typeof fetch;
  const sync = createJiraDevSync({ jiraDevDirectory, dataDirectory: path.join(root, 'data'), pluginSource: path.join(root, 'missing'), fetchImpl });
  await assert.rejects(sync.status(), /签名校验失败/);
  await assert.rejects(sync.sync({ expectedVersion: '9.0.0', expectedSha256: 'a'.repeat(64) }), /签名校验失败/);
  assert.deepEqual(await readdir(jiraDevDirectory), before);
});

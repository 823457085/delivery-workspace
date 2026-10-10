import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureLock, nativeCaptureReadiness } from '../scripts/integration-capture-lock';

test('锁屏与未知桌面状态不视为可截图；解锁只表示可以开始真实取图核验', () => {
  assert.equal(nativeCaptureReadiness('"CGSSessionScreenIsLocked"=Yes').desktopUnlocked, false);
  assert.match(nativeCaptureReadiness('"CGSSessionScreenIsLocked"=Yes').reason, /等待用户解锁/);
  assert.equal(nativeCaptureReadiness('"CGSSessionScreenIsLocked" = No').desktopUnlocked, true);
  assert.match(nativeCaptureReadiness('"CGSSessionScreenIsLocked" = No').reason, /验证实际原生截图/);
  assert.equal(nativeCaptureReadiness('').desktopUnlocked, null);
});

test('并行原生截图只有一个会话取得锁，其他会话不能释放，原会话释放后才可取得', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-capture-'));
  const file = path.join(dir, 'capture.lock');
  try {
    const owners = ['merchant-request', 'finance-request', 'operations-request'];
    const results = await Promise.all(owners.map(owner => captureLock(file, owner, 'acquire')));
    assert.equal(results.filter(result => 'acquired' in result && result.acquired).length, 1);
    const winner = results.find(result => 'acquired' in result && result.acquired)!.owner;
    const loser = owners.find(owner => owner !== winner)!;
    await assert.rejects(captureLock(file, loser, 'release'), /不能释放其他会话/);
    assert.equal((await captureLock(file, winner, 'acquire') as { acquired: boolean }).acquired, true);
    await captureLock(file, winner, 'release');
    assert.equal((await captureLock(file, loser, 'acquire') as { acquired: boolean }).acquired, true);
    await captureLock(file, loser, 'release');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

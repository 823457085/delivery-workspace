import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareKiroImages } from '../server/kiro-images.js';

const exec = promisify(execFile);
const oneMiB = 1024 * 1024;
const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const macOnly = { skip: process.platform !== 'darwin' };

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.kiro-images-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function largeImage(root: string, name = 'source.png') {
  const source = path.join(root, name);
  await fs.writeFile(source, Buffer.concat([smallPng, Buffer.alloc(oneMiB)]));
  return source;
}

test('Kiro small images and empty selections create no private directory and use canonical original paths', async t => {
  const root = await fixture(t); const source = path.join(root, 'source.png'); const linked = path.join(root, 'linked.png');
  await fs.writeFile(source, smallPng); await fs.symlink(source, linked);
  const directory = path.join(root, 'private', 'run');
  assert.deepEqual(await prepareKiroImages([], directory), []);
  assert.deepEqual(await prepareKiroImages([linked], directory), [await fs.realpath(source)]);
  await assert.rejects(fs.stat(path.dirname(directory)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source), smallPng);
});

test('Kiro images at exactly 1MiB remain unchanged and create no directory', async t => {
  const root = await fixture(t); const source = path.join(root, 'threshold.png'); const before = Buffer.alloc(oneMiB, 37);
  await fs.writeFile(source, before);
  const directory = path.join(root, 'private', 'run');
  assert.deepEqual(await prepareKiroImages([source], directory), [await fs.realpath(source)]);
  assert.equal(digest(await fs.readFile(source)), digest(before));
  await assert.rejects(fs.stat(path.dirname(directory)), { code: 'ENOENT' });
});

test('Kiro makes ordered persistent JPEG copies with private permissions and preserves large originals', macOnly, async t => {
  const root = await fixture(t); const source = await largeImage(root); const small = path.join(root, 'small.png');
  await fs.writeFile(small, smallPng);
  const before = digest(await fs.readFile(source)); const directory = path.join(root, 'private', 'run');
  const prepared = await prepareKiroImages([small, source, source], directory);
  assert.equal(prepared[0], await fs.realpath(small));
  assert.notEqual(prepared[1], prepared[2]);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const copy of prepared.slice(1)) {
    assert.equal(path.dirname(copy), directory);
    assert.match(path.basename(copy), /^image-[23]-[0-9a-f-]+\.jpg$/);
    assert.equal((await fs.stat(copy)).mode & 0o777, 0o600);
    assert.equal((await fs.readFile(copy)).subarray(0, 3).toString('hex'), 'ffd8ff');
  }
  assert.equal((await fs.readdir(directory)).length, 2);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.tmp')), false);
  assert.equal(digest(await fs.readFile(source)), before);
});

test('Kiro compatibility copies use sips to fit large dimensions within 1568 pixels', macOnly, async t => {
  const root = await fixture(t); const source = path.join(root, 'dimensions.png');
  await fs.writeFile(source, smallPng);
  await exec('/usr/bin/sips', ['-z', '1800', '2000', source], { timeout: 30_000 });
  await fs.appendFile(source, Buffer.alloc(oneMiB));
  const before = digest(await fs.readFile(source));
  const [copy] = await prepareKiroImages([source], path.join(root, 'private', 'run'));
  const info = (await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', copy!], { timeout: 30_000 })).stdout;
  assert.match(info, /pixelWidth: 1568/);
  assert.ok(Number(info.match(/pixelHeight: (\d+)/)?.[1]) <= 1568);
  assert.equal(digest(await fs.readFile(source)), before);
});

test('Kiro refuses existing, linked and relative output directories without modifying them', macOnly, async t => {
  const root = await fixture(t); const source = await largeImage(root); const existing = path.join(root, 'existing');
  await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'keep.txt'), 'untouched');
  const linked = path.join(root, 'linked'); await fs.symlink(existing, linked);
  for (const directory of [existing, linked, path.join(linked, 'new-run'), 'relative-run'])
    await assert.rejects(prepareKiroImages([source], directory), /Kiro 图片附件目录/);
  assert.deepEqual(await fs.readdir(existing), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'untouched');
  assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
});

test('Kiro failed conversion cleans this run copies while preserving every original', macOnly, async t => {
  const root = await fixture(t); const valid = await largeImage(root); const corrupt = path.join(root, 'corrupt.png');
  await fs.writeFile(corrupt, Buffer.alloc(oneMiB + 1, 12));
  const before = await Promise.all([valid, corrupt].map(async file => digest(await fs.readFile(file))));
  const directory = path.join(root, 'private', 'failed-run');
  await assert.rejects(prepareKiroImages([valid, corrupt], directory), /兼容处理失败/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all([valid, corrupt].map(async file => digest(await fs.readFile(file)))), before);
});

test('Kiro validates input files before creating any output directory', async t => {
  const root = await fixture(t); const source = await largeImage(root); const directory = path.join(root, 'private', 'run');
  await assert.rejects(prepareKiroImages([source, path.join(root, 'missing.png')], directory), /图片文件无法读取/);
  await assert.rejects(prepareKiroImages([root], directory), /图片文件无法读取/);
  await assert.rejects(fs.stat(path.dirname(directory)), { code: 'ENOENT' });
});

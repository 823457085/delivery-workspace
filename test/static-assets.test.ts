import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHttpByteRange, resolveStaticMimeType, serveWorkspaceStaticAsset } from '../server/static-assets';

test('resolveStaticMimeType maps wallpaper images and video streams accurately', () => {
  assert.equal(resolveStaticMimeType('/dist/themes/immersive-photo/dawn-ridge.avif'), 'image/avif');
  assert.equal(resolveStaticMimeType('/dist/themes/immersive-photo/dawn-ridge.webp'), 'image/webp');
  assert.equal(resolveStaticMimeType('/dist/themes/cinematic-video-hero/aurora-fjord.webm'), 'video/webm');
  assert.equal(resolveStaticMimeType('/dist/themes/cinematic-video-hero/aurora-fjord.mp4'), 'video/mp4');
  assert.equal(resolveStaticMimeType('/dist/assets/index.js'), 'text/javascript; charset=utf-8');
  assert.equal(resolveStaticMimeType('/dist/assets/index.css'), 'text/css; charset=utf-8');
});

test('parseHttpByteRange parses single byte ranges and flags unsatisfiable ranges', () => {
  assert.equal(parseHttpByteRange(undefined, 1000), null);
  assert.deepEqual(parseHttpByteRange('bytes=0-1023', 5000), { start: 0, end: 1023 });
  assert.deepEqual(parseHttpByteRange('bytes=100-', 500), { start: 100, end: 499 });
  assert.deepEqual(parseHttpByteRange('bytes=-120', 500), { start: 380, end: 499 });
  assert.deepEqual(parseHttpByteRange('bytes=400-9999', 500), { start: 400, end: 499 });
  assert.equal(parseHttpByteRange('bytes=500-600', 500), 'unsatisfiable');
  assert.equal(parseHttpByteRange('bytes=-', 500), 'unsatisfiable');
});

test('serveWorkspaceStaticAsset serves theme media with MIME types, HTTP Range 206, HEAD, and SPA fallback', async (t) => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-static-test-'));
  t.after(async () => { await fs.rm(distDir, { recursive: true, force: true }); });

  await fs.mkdir(path.join(distDir, 'themes', 'cinematic-video-hero'), { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>5288</title>');
  const sampleVideo = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  await fs.writeFile(path.join(distDir, 'themes', 'cinematic-video-hero', 'aurora-fjord.mp4'), sampleVideo);
  await fs.writeFile(path.join(distDir, 'themes', 'cinematic-video-hero', 'aurora-fjord.avif'), Buffer.from('avifdata'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void serveWorkspaceStaticAsset(req, res, {
      distDirectory: distDir,
      pathname: url.pathname,
      cacheControl: (rel) => rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;

  const avifRes = await fetch(`${base}/themes/cinematic-video-hero/aurora-fjord.avif`);
  assert.equal(avifRes.status, 200);
  assert.equal(avifRes.headers.get('content-type'), 'image/avif');
  assert.equal(avifRes.headers.get('accept-ranges'), 'bytes');

  const rangeRes = await fetch(`${base}/themes/cinematic-video-hero/aurora-fjord.mp4`, {
    headers: { Range: 'bytes=10-25' },
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('content-type'), 'video/mp4');
  assert.equal(rangeRes.headers.get('content-range'), `bytes 10-25/${sampleVideo.length}`);
  assert.equal(await rangeRes.text(), 'abcdefghijklmnop');

  const headRes = await fetch(`${base}/themes/cinematic-video-hero/aurora-fjord.mp4`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-length'), String(sampleVideo.length));

  const spaRes = await fetch(`${base}/agent?view=today`);
  assert.equal(spaRes.status, 200);
  assert.equal(spaRes.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await spaRes.text(), /5288/);
});

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function resolveStaticMimeType(filePath: string): string {
  return STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseHttpByteRange(rangeHeader: string | undefined, totalSize: number): ByteRange | 'unsatisfiable' | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const spec = rangeHeader.slice('bytes='.length).trim();
  if (!spec || spec.includes(',')) return null;
  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) return 'unsatisfiable';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'unsatisfiable';
  if (totalSize <= 0) return 'unsatisfiable';

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    const start = Math.max(0, totalSize - suffixLength);
    return { start, end: totalSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return 'unsatisfiable';
  const end = rawEnd ? Math.min(totalSize - 1, Number(rawEnd)) : totalSize - 1;
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

export interface ServeStaticOptions {
  distDirectory: string;
  pathname: string;
  cacheControl: (relativePath: string) => string;
}

export async function serveWorkspaceStaticAsset(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ServeStaticOptions,
): Promise<void> {
  const { distDirectory, pathname, cacheControl } = options;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const relative = decodedPathname.replace(/^\/+/, '');
  const resolvedCandidate = path.resolve(distDirectory, relative || 'index.html');
  if (!resolvedCandidate.startsWith(`${distDirectory}${path.sep}`)) {
    response.writeHead(404);
    response.end();
    return;
  }

  const spa = !path.extname(relative);
  const targetFile = spa ? path.join(distDirectory, 'index.html') : resolvedCandidate;
  const cacheTarget = spa ? 'index.html' : relative;

  try {
    const stat = await fs.stat(targetFile);
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const contentType = spa ? STATIC_MIME_TYPES['.html'] : resolveStaticMimeType(targetFile);
    const cacheHeader = cacheControl(cacheTarget);
    const isHead = request.method === 'HEAD';

    if (!spa && request.headers.range) {
      const parsed = parseHttpByteRange(request.headers.range, stat.size);
      if (parsed === 'unsatisfiable') {
        response.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          'Accept-Ranges': 'bytes',
        });
        response.end();
        return;
      }
      if (parsed) {
        const chunkLength = parsed.end - parsed.start + 1;
        response.writeHead(206, {
          'Content-Type': contentType,
          'Cache-Control': cacheHeader,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
          'Content-Length': String(chunkLength),
        });
        if (isHead) {
          response.end();
          return;
        }
        const stream = createReadStream(targetFile, { start: parsed.start, end: parsed.end });
        stream.on('error', () => { if (!response.destroyed) response.destroy(); });
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': cacheHeader,
      'Content-Length': String(stat.size),
    };
    if (!spa) headers['Accept-Ranges'] = 'bytes';

    response.writeHead(200, headers);
    if (isHead) {
      response.end();
      return;
    }
    const stream = createReadStream(targetFile);
    stream.on('error', () => { if (!response.destroyed) response.destroy(); });
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

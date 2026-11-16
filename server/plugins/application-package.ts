import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CustomPluginManifest } from '../../shared/custom-plugins.js';

export async function readApplicationPackage(root: string, manifest: CustomPluginManifest) {
  const files: Record<string, Buffer> = {};
  if (!manifest.application) return files;
  let size = 0;
  for (const name of Object.values(manifest.application)) {
    const file = path.join(root, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 15_000_000) throw new Error('插件入口必须是小于 15 MB 的普通文件');
    const content = await fs.readFile(file);
    size += content.length;
    if (size > 30_000_000) throw new Error('插件包超过 30 MB');
    files[name] = content;
  }
  return files;
}
export function applicationHashes(files: Record<string, Buffer>) {
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, createHash('sha256').update(data).digest('hex')]));
}

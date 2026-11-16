import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectCustomPlugin } from './custom-runtime.js';

/** Discover examples from manifests; discovery never installs or executes a plugin. */
export async function discoverBundledPlugins(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const examples: { name: string; directory: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const source = path.join(directory, entry.name);
    const packaged = path.join(source, 'package');
    const hasPackage = await fs.lstat(packaged).then(stat => stat.isDirectory(), () => false);
    try {
      const candidate = await inspectCustomPlugin(hasPackage ? packaged : source);
      examples.push({ name: candidate.manifest.name, directory: candidate.source });
    } catch {
      // Source integrations, unbuilt packages and invalid manifests are not installable examples.
    }
  }
  return examples;
}

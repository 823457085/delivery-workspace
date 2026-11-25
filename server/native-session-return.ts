import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexHome } from './cli-runtime.js';

/** The provider rejected the resume handle before receiving the new user turn. */
export class NativeSessionUnavailableError extends Error {
  constructor() { super('执行器找不到原生会话'); }
}

export function isMissingNativeSession(message: string, sessionId: string, provider: 'codex' | 'cursor') {
  const escaped = sessionId.replace(/[.*+?^{}${}()|[\]\\]/g, '\\$&');
  const id = `["']?${escaped}["']?`;
  const type = provider === 'codex' ? '(?:session|thread)' : '(?:session|chat)';
  return new RegExp(`^(?:Error:\\s*)?(?:${type} ${id} (?:was )?not found|(?:no ${type} found|no rollout found) for (?:${type} )?(?:id[: ]+)?${id}|(?:could not|cannot) find ${type} ${id})[.!]?$`, 'i').test(message.trim());
}

/** Compare metadata only for the local login and configuration files. */
export async function nativeSessionScope(provider: 'codex' | 'cursor', binary: string) {
  const credentials = process.env;
  const overrides = provider === 'codex'
    ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN']
    : ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_CONFIG_DIR', 'CURSOR_API_ENDPOINT', 'XDG_CONFIG_HOME'];
  if (overrides.some(key => !!credentials[key])) return;
  const configHome = provider === 'codex' ? codexHome : path.join(os.homedir(), '.cursor');
  const storePath = path.join(configHome, provider === 'codex' ? 'auth.json' : 'cli-config.json');
  const metadata = async (file: string) => {
    const stat = await fs.stat(file, { bigint: true }).catch(() => undefined);
    if (stat?.isFile()) return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  const store = await metadata(storePath);
  if (!store) return;
  const executable = await fs.realpath(binary).catch(() => binary);
  const config = provider === 'codex' ? await metadata(path.join(configHome, 'config.toml')) : undefined;
  return createHash('sha256').update([provider, executable, configHome, store, config].join('\0')).digest('hex');
}

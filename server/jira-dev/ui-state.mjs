/** 只保存本人表单偏好，拒绝任意文件名、凭据字段与业务资料。 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export function createUiStateStore({ dataDirectory }) {
  const path = join(dataDirectory, 'ui-state.json');
  return {
    async get() { try { return { state: JSON.parse(await readFile(path, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw new Error('本机表单偏好无法读取。'); return { state: null }; } },
    async set(state) { await mkdir(dataDirectory, { recursive: true, mode: 0o700 }); await writePrivateJson(path, state); return { state }; },
  };
}

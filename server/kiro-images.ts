import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const compatibilityThreshold = 1024 * 1024;

function imageError(message: string, cause: unknown) {
  return Object.assign(new Error(message, { cause }), { code: (cause as NodeJS.ErrnoException)?.code });
}

async function ensurePrivateParent(directory: string) {
  // 逐层核对后创建，避免 recursive mkdir 沿符号链接写到其他位置。
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let state;
    try { state = await fs.lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      state = await fs.lstat(current);
    }
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('附件目录不能经过符号链接或普通文件');
  }
}

/** 小图直接使用原文件；macOS 大图保留原件，生成可被 Kiro 持续读取的私有兼容副本。 */
export async function prepareKiroImages(imagePaths: string[], attachmentDirectory: string): Promise<string[]> {
  const images = await Promise.all(imagePaths.map(async imagePath => {
    try {
      const original = await fs.realpath(imagePath);
      const state = await fs.stat(original);
      if (!state.isFile()) throw new Error('图片路径不是普通文件');
      return { original, size: state.size };
    } catch (error) { throw imageError('Kiro 图片文件无法读取，请重新上传后重试', error); }
  }));
  if (process.platform !== 'darwin' || !images.some(image => image.size > compatibilityThreshold))
    return images.map(image => image.original);
  if (!path.isAbsolute(attachmentDirectory)) throw new Error('Kiro 图片附件目录必须是绝对路径');

  const directory = path.resolve(attachmentDirectory);
  let owned: { dev: number; ino: number } | undefined;
  try {
    await ensurePrivateParent(path.dirname(directory));
    // 每轮目录由调用方按唯一 runId 提供；已有目录（包括符号链接）一律不复用。
    await fs.mkdir(directory, { mode: 0o700 });
    const created = await fs.lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('Kiro 图片附件目录校验失败');
    owned = { dev: created.dev, ino: created.ino };
    await fs.chmod(directory, 0o700);
    const result: string[] = [];
    for (const [index, image] of images.entries()) {
      if (image.size <= compatibilityThreshold) { result.push(image.original); continue; }
      const target = path.join(directory, `image-${index + 1}-${randomUUID()}.jpg`);
      const temporary = `${target}.tmp.jpg`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      await handle.close();
      try {
        await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '1568',
          image.original, '--out', temporary], { timeout: 30_000, maxBuffer: 64_000 });
      } catch (error) { throw imageError('Kiro 图片兼容处理失败，请检查图片格式后重试', error); }
      const currentDirectory = await fs.lstat(directory);
      const output = await fs.lstat(temporary);
      if (currentDirectory.isSymbolicLink() || currentDirectory.dev !== owned.dev || currentDirectory.ino !== owned.ino
        || output.isSymbolicLink() || !output.isFile() || !output.size)
        throw new Error('Kiro 图片附件目录或兼容副本校验失败');
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, target);
      result.push(target);
    }
    return result;
  } catch (error) {
    if (owned) {
      const current = await fs.lstat(directory).catch(() => undefined);
      if (current && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino)
        await fs.rm(directory, { recursive: true, force: true });
    }
    if (error instanceof Error && error.message.startsWith('Kiro')) throw error;
    throw imageError('Kiro 图片附件目录不可用，请重新发送后重试', error);
  }
}

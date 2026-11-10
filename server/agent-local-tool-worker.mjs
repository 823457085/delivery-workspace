/** Runs only inside the OS sandbox. No credentials or controller state enter this process. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

async function boundedRead(handle, size) {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > size) throw new Error('读取时文件增大，请重新核对');
  return buffer.subarray(0, offset);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { name, args, root, writable, snapshot, deniedPaths = [] } = JSON.parse(input);
  if (name === 'snapshot_workspace') {
    // Copy from open, single-link file descriptors inside the source sandbox. Commands never
    // read the live source tree: later symlink/hardlink substitutions cannot expose host files.
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('工作区根已变化');
    let count = 0, bytes = 0;
    const copy = async (source, destination) => {
      for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const target = path.join(source, entry.name);
        if (entry.name === '.git' || /^\.env/.test(entry.name) || ['.ssh', '.aws', '.gnupg', 'api-model-credentials.json'].includes(entry.name)
          || deniedPaths.some(p => target === p || target.startsWith(p + path.sep))) continue;
        if (++count > 200_000) throw new Error('命令工作区超过快照上限');
        if (entry.isSymbolicLink()) continue;
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) continue;
        const to = path.join(destination, entry.name);
        if (stat.isDirectory()) { await fs.mkdir(to, { mode: 0o700 }); await copy(target, to); }
        else {
          const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1) throw new Error('命令快照不允许硬链接或特殊文件');
            bytes += opened.size;
            if (bytes > 256_000_000) throw new Error('命令工作区超过快照容量上限');
            const content = await boundedRead(handle, opened.size);
            await fs.writeFile(to, content, { flag: 'wx', mode: opened.mode & 0o777 });
          } finally { await handle.close(); }
        }
      }
    };
    await fs.mkdir(snapshot, { mode: 0o700 });
    await copy(root, snapshot);
    process.stdout.write(JSON.stringify({ ok: true, result: { files: count, bytes } }));
    process.exit(0);
  }
  if (name === 'run_command') {
    // No process-fork permission: exec replaces this tracked process; background children cannot escape stop.
    process.execve('/bin/sh', ['/bin/sh', '-c', args.command], process.env);
    throw new Error('当前 Node.js 不支持受控命令替换');
  }
  const target = path.resolve(root, args.path || '.');
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('路径超出工作区');
  // Reject symlinks on every component, including a parent of a not-yet-existing file.
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isSymbolicLink() || stat && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error('不允许符号链接、硬链接或特殊文件');
  }
  let result;
  if (name === 'list_files') {
    result = (await fs.readdir(target, { withFileTypes: true })).slice(0, 500).map(entry => ({ name: entry.name,
      type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' }));
  } else {
    let previous = '', exists = true, mode = 0o600;
    try {
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256_000) throw new Error('文件不是普通单链接文件或超过 256KB');
        mode = stat.mode & 0o777;
        previous = (await boundedRead(handle, stat.size)).toString('utf8');
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    const hash = exists ? createHash('sha256').update(previous).digest('hex') : '';
    if (name === 'read_file') {
      if (!exists) throw new Error('文件不存在');
      result = { content: previous, sha256: hash };
    } else if (name === 'apply_patch') {
      if (!writable) throw new Error('当前轮次只读');
      if (Buffer.byteLength(args.content, 'utf8') > 256_000) throw new Error('文件内容超过 256KB');
      if (hash !== args.expected_sha256) throw new Error('文件版本已变化，请重新读取后修改');
      const temporary = path.join(path.dirname(target), `.delivery-tool-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, args.content, { flag: 'wx', mode });
        // Rename replaces an inode rather than following a changed target or hard link.
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
      result = { path: relative, sha256: createHash('sha256').update(args.content).digest('hex') };
    } else throw new Error('不支持的工具');
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  // Do not serialize OS diagnostics, paths or arbitrary file content.
  process.stdout.write(JSON.stringify({ ok: false, error: error.code ? `文件操作失败（${error.code}）` : error.message }));
  process.exitCode = 1;
}

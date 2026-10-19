import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateBackupStore } from '../server/state-backup.js';

const usage = `用法：pnpm exec tsx scripts/state-backup.ts <snapshot|list|verify|restore> [状态相对路径] [备份编号|latest] [--data-dir 路径] [--port 5199]
snapshot：逐文件校验并备份；list：只显示备份元数据；verify：校验 SHA256 和状态结构；restore：仅离线恢复，保留当前原件。
默认数据目录为 DELIVERY_DATA_DIR 或项目 .data。端口应与 PORT 一致；恢复不启动任务。`;
try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.log(usage); }
  else {
    const positional: string[] = [];
    let directory = process.env.DELIVERY_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.data');
    let port = Number(process.env.PORT || 5199);
    for (let index = 0; index < args.length; index++) {
      const value = args[index];
      if (value === '--data-dir' || value === '--port') {
        const next = args[++index];
        if (!next || next.startsWith('--')) throw new Error(`缺少参数：${value}`);
        if (value === '--data-dir') directory = path.resolve(next); else port = Number(next);
      } else if (value.startsWith('--')) throw new Error(`未知参数：${value}`);
      else positional.push(value);
    }
    const [command, relative, id] = positional;
    if (!['snapshot', 'list', 'verify', 'restore'].includes(command) || positional.length > 3) throw new Error(usage);
    if ((command === 'snapshot' && relative) || (command === 'list' && id)) throw new Error(usage);
    if ((command === 'verify' || command === 'restore') && (!relative || !id)) throw new Error(usage);
    const store = await createStateBackupStore(directory);
    let output: unknown;
    if (command === 'snapshot') {
      const manifest = await store.snapshot(); output = manifest;
      if (manifest.entries.some(entry => entry.status === 'failed')) process.exitCode = 1;
    } else if (command === 'list') {
      output = (await Promise.all((relative ? [relative] : await store.managedFiles()).map(file => store.list(file)))).flat();
    } else if (command === 'verify') {
      const selected = id === 'latest' ? (await store.list(relative)).find(entry => entry.valid)?.id : id;
      if (!selected) throw new Error('没有有效备份');
      output = await store.verify(relative, selected);
    } else output = await store.restore(relative, id, { port });
    console.log(JSON.stringify(output, null, 2));
    await store.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

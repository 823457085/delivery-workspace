import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { systemProjectColumns, systemProjectRegions, systemProjectWorkbookLimit, systemWebUrl, type SystemProjectRow } from '../shared/system-catalog.js';

const run = promisify(execFile);
const workbookScript = fileURLToPath(new URL('../scripts/refactor-workbook.py', import.meta.url));
const webAddress = z.string().trim().max(500)
  .refine(value => !value || systemWebUrl(value), '请填写不含账号密码的 HTTP 或 HTTPS 地址')
  .transform(value => value ? systemWebUrl(value) : '');
const fields = z.object({
  name: z.string().trim().min(1, '请填写项目名称').max(100),
  region: z.enum(systemProjectRegions),
  environment: z.string().trim().min(1, '请填写环境').max(80),
  branch: z.string().trim().max(120),
  url: webAddress,
  repository: webAddress,
  notes: z.string().trim().max(500),
}).strict();
const columns = Object.entries(systemProjectColumns) as [keyof SystemProjectRow, string][];

function projectRow(row: unknown, label: string): SystemProjectRow {
  const parsed = fields.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const name = systemProjectColumns[issue.path[0] as keyof SystemProjectRow];
    throw new Error(`${label}${name ? `「${name}」` : ''}${issue.code === 'custom' ? issue.message : '格式不正确、缺少内容或超出长度限制'}`);
  }
  return parsed.data;
}

export function parseSystemProjectRows(input: unknown) {
  const { rows } = z.object({ rows: z.array(z.unknown()).min(1).max(200) }).strict().parse(input);
  return rows.map((row, index) => projectRow(row, `第 ${index + 1} 条记录`));
}

export async function readSystemProjectWorkbook(request: IncomingMessage): Promise<SystemProjectRow[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > systemProjectWorkbookLimit) throw new Error('Excel 文件不能超过 1 MiB');
    chunks.push(bytes);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-project-import-'));
  try {
    const filename = path.join(directory, 'upload.xlsx');
    await fs.writeFile(filename, Buffer.concat(chunks), { mode: 0o600 });
    let output: string;
    try {
      ({ stdout: output } = await run('/usr/bin/python3', [workbookScript, 'catalog', filename], { timeout: 5000, maxBuffer: 2_000_000 }));
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      const detail: unknown = stdout ? JSON.parse(stdout) : null;
      const failure = z.object({ error: z.string().max(200) }).safeParse(detail);
      throw new Error(failure.success ? failure.data.error : '无法读取 Excel，请使用项目导入模板');
    }
    const [header, ...rows] = z.array(z.tuple([z.number(), z.record(z.string(), z.string())])).parse(JSON.parse(output));
    const headers = Object.entries(header?.[1] ?? {}).filter(([, value]) => value.trim());
    const keys = columns.map(([, title]) => headers.find(([, value]) => value.trim() === title)?.[0]);
    if (header?.[0] !== 1 || headers.length !== columns.length || keys.some(key => !key)) {
      throw new Error('第 1 行表头与项目导入模板不匹配');
    }
    if (!rows.length) throw new Error('项目导入工作表没有待导入的数据');
    return rows.map(([line, cells]) => {
      if (Object.entries(cells).some(([key, value]) => value.trim() && !keys.includes(key))) {
        throw new Error(`第 ${line} 行包含模板之外的列`);
      }
      const data = Object.fromEntries(columns.map(([key], index) => [key, cells[keys[index]!] ?? '']));
      data.region = data.region.trim() || '海外';
      return projectRow(data, `Excel 第 ${line} 行`);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

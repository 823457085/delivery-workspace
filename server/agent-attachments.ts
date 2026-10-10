/**
 * 设计说明：会话附件独立存放在 Delivery 私有数据目录，运行记录只保存无路径的公开元数据。
 * 该边界负责类型、常见图片/XLSX 魔数、大小、数量与文件名校验；Agent 运行层只能拿到已验证的本地路径，
 * 避免把浏览器输入直接变成 CLI 文件参数。附件不进入用户选择的 Git 工作区。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentAttachment, AgentImageMimeType } from '../shared/agent-runtime.js';

export const maxAgentAttachmentCount = 6;
export const maxAgentAttachmentBytes = 10 * 1024 * 1024;
const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const mimePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const idPattern = /^[0-9a-f-]{36}$/;
const imageTypes: Record<AgentImageMimeType, { extension: string; matches(buffer: Buffer): boolean }> = {
  'image/png': { extension: 'png', matches: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { extension: 'jpg', matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/webp': { extension: 'webp', matches: (buffer) => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' },
  'image/gif': { extension: 'gif', matches: (buffer) => ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')) },
};
function attachmentType(mimeType: string, name: string) {
  if (!mimePattern.test(mimeType) || mimeType.length > 100) throw new Error('附件类型不正确');
  const imageType = imageTypes[mimeType as AgentImageMimeType];
  if (imageType) return imageType;
  if (mimeType === xlsxMimeType) {
    if (!name.toLowerCase().endsWith('.xlsx')) throw new Error('附件内容与文件类型不一致');
    return { extension: 'xlsx', matches: (buffer: Buffer) => buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) };
  }
  const suffix = path.extname(name).slice(1).toLowerCase();
  return { extension: /^[a-z0-9]{1,12}$/.test(suffix) ? suffix : 'bin', matches: () => true };
}

interface StoredAgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  extension: string;
  createdAt: string;
}

export interface ResolvedAgentAttachment {
  attachment: AgentAttachment;
  filePath: string;
}

function safeId(id: string) {
  if (!idPattern.test(id)) throw new Error('附件 ID 不正确');
  return id;
}

function publicAttachment(item: StoredAgentAttachment): AgentAttachment {
  return { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size,
    url: `/api/agent-runtimes/attachments/${item.id}` };
}

function decodeBase64(value: string) {
  const source = value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!source || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) throw new Error('附件数据格式不正确');
  const buffer = Buffer.from(source, 'base64');
  if (!buffer.length) throw new Error('附件内容为空');
  if (buffer.length > maxAgentAttachmentBytes) throw new Error('单个附件不能超过 10 MB');
  return buffer;
}

export async function createAgentAttachmentStore(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  async function readMetadata(id: string) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, `${safeId(id)}.json`), 'utf8')) as Partial<StoredAgentAttachment>;
    const type = parsed.mimeType;
    const kind = typeof type === 'string' && typeof parsed.name === 'string' ? attachmentType(type, parsed.name) : undefined;
    if (!kind || parsed.id !== id || parsed.extension !== kind.extension || typeof parsed.name !== 'string'
      || typeof parsed.size !== 'number' || parsed.size < 1 || parsed.size > maxAgentAttachmentBytes) throw new Error('附件记录已损坏');
    return parsed as StoredAgentAttachment;
  }

  async function upload(input: { name: string; mimeType: string; data: string }) {
    const name = input.name.replace(/[\u0000-\u001f/\\]/g, '').trim().slice(0, 200);
    if (!name) throw new Error('附件名称不正确');
    const kind = attachmentType(input.mimeType, name);
    const buffer = decodeBase64(input.data);
    if (!kind.matches(buffer))
      throw new Error(input.mimeType === xlsxMimeType ? '附件内容与文件类型不一致' : '图片内容与文件类型不一致');
    const id = randomUUID();
    const item: StoredAgentAttachment = { id, name, mimeType: input.mimeType, size: buffer.length,
      extension: kind.extension, createdAt: new Date().toISOString() };
    const attachmentFile = path.join(directory, `${id}.${kind.extension}`);
    const metadataFile = path.join(directory, `${id}.json`);
    try {
      await fs.writeFile(attachmentFile, buffer, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(metadataFile, JSON.stringify(item), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await Promise.allSettled([fs.unlink(attachmentFile), fs.unlink(metadataFile)]);
      throw error;
    }
    return publicAttachment(item);
  }

  async function resolve(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error('附件不能重复');
    if (uniqueIds.length > maxAgentAttachmentCount) throw new Error(`每条消息最多添加 ${maxAgentAttachmentCount} 个附件`);
    return Promise.all(uniqueIds.map(async (id): Promise<ResolvedAgentAttachment> => {
      const item = await readMetadata(id);
      const filePath = path.join(directory, `${item.id}.${item.extension}`);
      const state = await fs.stat(filePath);
      if (!state.isFile() || state.size !== item.size) throw new Error('附件文件已损坏');
      return { attachment: publicAttachment(item), filePath };
    }));
  }

  async function read(id: string) {
    const [resolved] = await resolve([id]);
    return { attachment: resolved.attachment, content: await fs.readFile(resolved.filePath) };
  }

  async function remove(ids: string[]) {
    const uniqueIds = [...new Set(ids.filter((id) => idPattern.test(id)))];
    await Promise.all(uniqueIds.map(async (id) => {
      let item: StoredAgentAttachment | undefined;
      try { item = await readMetadata(id); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await Promise.allSettled([
        fs.unlink(path.join(directory, `${id}.json`)),
        ...(item ? [fs.unlink(path.join(directory, `${id}.${item.extension}`))] : []),
      ]);
    }));
  }

  return { upload, resolve, read, remove };
}

import fs from 'node:fs/promises';
import path from 'node:path';

interface FileAttachment { name: string; path: string }

const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

export async function prepareClaudeInput(prompt: string, imagePaths: string[], fileAttachments: FileAttachment[],
  attachmentDirectory: string): Promise<{ stdin: string; fileAttachments: FileAttachment[]; readOnlyDirectories: string[] }> {
  const images = [];
  for (const imagePath of imagePaths) {
    const mediaType = imageMimeTypes[path.extname(imagePath).toLowerCase()];
    if (!mediaType) throw new Error('Claude Code 不支持此图片类型');
    images.push({ type: 'image', source: { type: 'base64', media_type: mediaType,
      data: (await fs.readFile(imagePath)).toString('base64') } });
  }

  const preparedFiles: FileAttachment[] = [];
  const readOnlyDirectories: string[] = [];
  if (fileAttachments.length) {
    if (!path.isAbsolute(attachmentDirectory)) throw new Error('Claude Code 附件目录必须是绝对路径');
    await fs.mkdir(path.dirname(attachmentDirectory), { recursive: true, mode: 0o700 });
    // 独占本轮目录，拒绝复用旧目录，避免向 CLI 暴露其他轮次的文件。
    await fs.mkdir(attachmentDirectory, { mode: 0o700 });
    try {
      await fs.chmod(attachmentDirectory, 0o700);
      for (const [index, file] of fileAttachments.entries()) {
        const extension = path.extname(file.path).toLowerCase();
        const target = path.join(attachmentDirectory,
          `attachment-${index + 1}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin'}`);
        await fs.writeFile(target, await fs.readFile(file.path), { mode: 0o600, flag: 'wx' });
        preparedFiles.push({ name: file.name, path: target });
      }
      readOnlyDirectories.push(attachmentDirectory);
    } catch (error) {
      await fs.rm(attachmentDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  const text = preparedFiles.length ? `${prompt}\n\n本轮附加的本地文件（已验证）：\n${preparedFiles
    .map(file => `- ${JSON.stringify(file.name)}：${JSON.stringify(file.path)}`).join('\n')}` : prompt;
  const stdin = JSON.stringify({ type: 'user', message: { role: 'user',
    content: [{ type: 'text', text }, ...images] }, parent_tool_use_id: null }) + '\n';
  return { stdin, fileAttachments: preparedFiles, readOnlyDirectories };
}

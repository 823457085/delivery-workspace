/**
 * 设计说明：该 composable 管理“尚未发送”的本机附件，统一处理选择、粘贴、拖放、上传与移除。
 * 已发送附件属于运行记录，由服务端托管；这里不把 Base64 塞进会话状态，也不接触 Agent 执行逻辑。
 */
import { computed, shallowRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentAttachment } from '../../../shared/agent-runtime';

const maxAttachmentCount = 6;
const maxAttachmentBytes = 10 * 1024 * 1024;
const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const supportedFile = (file: File) => !!file.name;

async function request(path: string, value: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
    body: JSON.stringify(value) });
  const result = await response.json() as { message?: string };
  if (!response.ok) throw new Error(result.message || '附件操作失败');
  return result;
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('附件读取失败'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

export async function removePendingAgentAttachments(attachments: AgentAttachment[]) {
  await Promise.allSettled(attachments.map((attachment) => request(`/api/agent-runtimes/attachments/${attachment.id}/delete`, {})));
}

export function useAgentAttachments(attachments: Ref<AgentAttachment[]>, disabled: () => boolean) {
  const uploading = shallowRef(false);
  const canAdd = computed(() => !disabled() && !uploading.value && attachments.value.length < maxAttachmentCount);

  async function addFiles(files: File[]) {
    if (!files.length || disabled() || uploading.value) return;
    const available = maxAttachmentCount - attachments.value.length;
    if (available <= 0) { ElMessage.warning(`每条消息最多添加 ${maxAttachmentCount} 个附件`); return; }
    const accepted = files.filter(supportedFile);
    if (accepted.length !== files.length) ElMessage.warning('请选择有效文件');
    const selected = accepted.slice(0, available);
    if (accepted.length > available) ElMessage.warning(`每条消息最多添加 ${maxAttachmentCount} 个附件`);
    if (!selected.length) return;
    uploading.value = true;
    try {
      for (const file of selected) {
        if (file.size > maxAttachmentBytes) { ElMessage.error(`${file.name} 超过 10 MB`); continue; }
        const data = await fileBase64(file);
        const uploaded = await request('/api/agent-runtimes/attachments', {
          name: file.name,
          mimeType: file.name.toLowerCase().endsWith('.xlsx') ? xlsxMimeType : file.type || 'application/octet-stream',
          data,
        }) as AgentAttachment;
        attachments.value = [...attachments.value, uploaded];
      }
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      uploading.value = false;
    }
  }

  async function remove(attachment: AgentAttachment) {
    if (disabled()) return;
    try {
      await request(`/api/agent-runtimes/attachments/${attachment.id}/delete`, {});
      attachments.value = attachments.value.filter((item) => item.id !== attachment.id);
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '附件移除失败'); }
  }

  function fromTransfer(transfer: DataTransfer | null, event: Event) {
    const files = [...(transfer?.files || [])].filter(supportedFile);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  return { uploading, canAdd, addFiles, remove, fromTransfer };
}

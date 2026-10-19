/**
 * 设计说明：该 composable 管理“尚未发送”的本机附件，统一处理选择、粘贴、拖放、上传与移除。
 * 已发送附件属于运行记录，由服务端托管；这里不把 Base64 塞进会话状态，也不接触 Agent 执行逻辑。
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { maxAgentAttachmentBytes, type AgentAttachment } from '../../../shared/agent-runtime';

const maxAttachmentCount = 6;
const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const supportedFile = (file: File) => !!file.name;

/** 异步操作持有草稿句柄，切换输入框不会改变归属；会话 ID 迁移时跟随原草稿。 */
export class AgentAttachmentDraft {
  private readonly valid = shallowRef(true);
  private readonly uploads = shallowRef(0);
  private readonly removals = shallowRef(0);
  private readonly destination = shallowRef<AgentAttachmentDraft>();

  constructor(private readonly attachments: Ref<AgentAttachment[]>) {}

  private get current(): AgentAttachmentDraft { return this.destination.value?.current || this; }
  get active() { return this.current.valid.value; }
  get uploading() { return this.current.uploads.value > 0; }
  get pending() { return this.uploading || this.current.removals.value > 0; }
  read() { return this.current.attachments.value; }
  update(change: (items: AgentAttachment[]) => AgentAttachment[]) {
    const current = this.current;
    if (!current.valid.value) return false;
    current.attachments.value = change(current.attachments.value);
    return true;
  }
  begin(operation: 'upload' | 'remove') {
    const key = operation === 'upload' ? 'uploads' : 'removals';
    this.current[key].value++;
    let settled = false;
    return () => { if (!settled) { settled = true; this.current[key].value--; } };
  }
  discard() { this.current.valid.value = false; }
  moveTo(target: AgentAttachmentDraft) {
    const current = this.current, destination = target.current;
    if (current === destination) return;
    destination.uploads.value += current.uploads.value;
    destination.removals.value += current.removals.value;
    current.destination.value = destination;
  }
}

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

export function useAgentAttachments(attachments: Ref<AgentAttachment[]>, disabled: () => boolean,
  draft?: () => AgentAttachmentDraft | undefined) {
  const localDraft = new AgentAttachmentDraft(attachments);
  const currentDraft = () => draft?.() || localDraft;
  const uploading = computed(() => currentDraft().uploading);
  const pending = computed(() => currentDraft().pending);
  const canAdd = computed(() => !disabled() && currentDraft().active && !pending.value && currentDraft().read().length < maxAttachmentCount);
  if (getCurrentScope()) onScopeDispose(() => localDraft.discard());

  async function addFiles(files: File[]) {
    const target = currentDraft();
    if (!files.length || disabled() || !target.active || target.pending) return;
    const available = maxAttachmentCount - target.read().length;
    if (available <= 0) { ElMessage.warning(`每条消息最多添加 ${maxAttachmentCount} 个附件`); return; }
    const accepted = files.filter(supportedFile);
    if (accepted.length !== files.length) ElMessage.warning('请选择有效文件');
    const selected = accepted.slice(0, available);
    if (accepted.length > available) ElMessage.warning(`每条消息最多添加 ${maxAttachmentCount} 个附件`);
    if (!selected.length) return;
    const finish = target.begin('upload');
    try {
      for (const file of selected) {
        if (!target.active) break;
        if (file.size > maxAgentAttachmentBytes) { ElMessage.error(`${file.name} 超过 ${maxAgentAttachmentBytes / 1024 / 1024} MB`); continue; }
        const data = await fileBase64(file);
        if (!target.active) break;
        const uploaded = await request('/api/agent-runtimes/attachments', {
          name: file.name,
          mimeType: file.name.toLowerCase().endsWith('.xlsx') ? xlsxMimeType : file.type || 'application/octet-stream',
          data,
        }) as AgentAttachment;
        if (!target.update(items => [...items, uploaded])) await removePendingAgentAttachments([uploaded]);
      }
    } catch (error) {
      if (target.active) ElMessage.error(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      finish();
    }
  }

  async function remove(attachment: AgentAttachment) {
    const target = currentDraft();
    if (disabled() || !target.active || target.pending || !target.read().some(item => item.id === attachment.id)) return;
    const finish = target.begin('remove');
    try {
      await request(`/api/agent-runtimes/attachments/${attachment.id}/delete`, {});
      target.update(items => items.filter(item => item.id !== attachment.id));
    } catch (error) { if (target.active) ElMessage.error(error instanceof Error ? error.message : '附件移除失败'); }
    finally { finish(); }
  }

  function fromTransfer(transfer: DataTransfer | null, event: Event) {
    const files = [...(transfer?.files || [])].filter(supportedFile);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  return { uploading, pending, canAdd, addFiles, remove, fromTransfer };
}

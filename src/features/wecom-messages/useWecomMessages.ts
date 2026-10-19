/**
 * 消息管理复用已连接的机器人；服务端负责存储、脱敏和发送，客户端只编排编辑与确认。
 * 预览绑定当时的输入和配置，任何编辑都会使它失效，不使用自动发送或自动重试。
 */
import { computed, reactive, shallowRef, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { WecomPublicConfig } from '../../../shared/wecom-integration';
import { wecomMessageLimits, type WecomMessageInput, type WecomMessagePreview, type WecomMessageRecord, type WecomMessageSaved, type WecomMessageSendInput } from '../../../shared/wecom-messages';

async function request<T>(suffix: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/integration-wecom/${suffix}`, input === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `企业微信操作失败 (${response.status})`);
  return data as T;
}

export function useWecomMessages() {
  const client = useQueryClient();
  const configKey = ['integration-wecom-config'];
  const libraryKey = ['wecom-message-library'];
  const historyKey = ['wecom-message-history'];
  const configuration = useQuery({ queryKey: configKey, queryFn: () => request<WecomPublicConfig>('config'), retry: false });
  const library = useQuery({ queryKey: libraryKey, queryFn: () => request<WecomMessageSaved[]>('messages/library'), retry: false });
  const history = useQuery({ queryKey: historyKey, queryFn: () => request<WecomMessageRecord[]>('messages/history'), retry: false });
  for (const query of [configuration, library, history]) watch(query.error, error => { if (error) ElMessage.error(error.message); });

  const form = reactive<WecomMessageInput>({ title: '', msgtype: 'text', content: '' });
  const snapshot = () => ({ title: form.title, msgtype: form.msgtype, content: form.content });
  const inputKey = computed(() => JSON.stringify(snapshot()));
  const savedKey = shallowRef(inputKey.value);
  const activeSaved = shallowRef<WecomMessageSaved>();
  const dirty = computed(() => inputKey.value !== savedKey.value);
  const bytes = computed(() => new TextEncoder().encode(form.content).length);
  const limit = computed(() => wecomMessageLimits[form.msgtype]);
  const valid = computed(() => !!form.title.trim() && !!form.content.trim() && bytes.value <= limit.value);
  const preview = shallowRef<WecomMessagePreview>();
  const previewInputKey = shallowRef('');
  const configVersion = shallowRef(0);
  const confirming = shallowRef(false);
  function clearPreview() { preview.value = undefined; previewInputKey.value = ''; }
  watch(inputKey, clearPreview, { flush: 'sync' });
  watch(configuration.data, () => { configVersion.value++; clearPreview(); }, { flush: 'sync' });

  const configOpen = shallowRef(false);
  const configForm = reactive({ groupName: '', webhook: '' });
  watch(configOpen, open => {
    configForm.webhook = '';
    if (open) configForm.groupName = configuration.data.value?.groupName || '';
  });
  watch(configuration.data, data => { if (configOpen.value && !configForm.groupName && data) configForm.groupName = data.groupName; });
  const configMutation = useMutation({ mutationFn: (input: unknown) => request<WecomPublicConfig & { message: string }>('config', input) });
  const previewMutation = useMutation({ mutationFn: (input: WecomMessageInput) => request<WecomMessagePreview>('messages/preview', input) });
  const sendMutation = useMutation({ mutationFn: (input: WecomMessageSendInput) => request<{ record: WecomMessageRecord; message: string }>('messages/send', input), retry: false });
  const saveMutation = useMutation({ mutationFn: (input: WecomMessageInput & { kind: WecomMessageSaved['kind']; id?: string }) => request<WecomMessageSaved>('messages/library', input) });
  const deleteMutation = useMutation({ mutationFn: (id: string) => request<{ message: string }>('messages/library/delete', { id }) });
  const busy = computed(() => confirming.value || previewMutation.isPending.value || sendMutation.isPending.value || configMutation.isPending.value || saveMutation.isPending.value || deleteMutation.isPending.value);
  const canSend = computed(() => !!preview.value?.canSend && previewInputKey.value === inputKey.value && !busy.value);

  async function saveConfig() {
    if (busy.value) return;
    clearPreview();
    try {
      const data = await configMutation.mutateAsync({ groupName: configForm.groupName, ...(configForm.webhook.trim() ? { webhook: configForm.webhook.trim() } : {}) });
      await client.cancelQueries({ queryKey: configKey });
      client.setQueryData(configKey, data);
      configForm.webhook = '';
      configOpen.value = false;
      ElMessage.success(data.message);
    } catch (error) { ElMessage.error((error as Error).message); }
  }

  async function prepare() {
    if (!valid.value || busy.value) return;
    const key = inputKey.value;
    const version = configVersion.value;
    const input = snapshot();
    clearPreview();
    try {
      const result = await previewMutation.mutateAsync(input);
      if (key === inputKey.value && version === configVersion.value) { preview.value = result; previewInputKey.value = key; }
    } catch (error) { ElMessage.error((error as Error).message); }
  }

  async function send() {
    if (!canSend.value || !preview.value) return;
    const current = preview.value;
    const key = inputKey.value;
    confirming.value = true;
    try {
      await ElMessageBox.confirm(`将把右侧已预览的消息发送到企业微信群“${current.groupName}”。请核对群名称、正文及脱敏结果。`, '确认推送消息', {
        confirmButtonText: '确认发送到群', cancelButtonText: '取消', closeOnClickModal: false,
      });
    } catch { confirming.value = false; return; }
    confirming.value = false;
    if (busy.value || preview.value?.previewId !== current.previewId || inputKey.value !== key) return;
    try {
      const data = await sendMutation.mutateAsync({ input: current.input, previewId: current.previewId, hash: current.hash });
      if (data.record.status === 'sent') ElMessage.success(data.message);
      else ElMessage.warning(data.message);
    } catch (error) { ElMessage.error((error as Error).message); }
    finally {
      clearPreview();
      await client.invalidateQueries({ queryKey: historyKey });
    }
  }

  async function replace(input: WecomMessageInput, saved?: WecomMessageSaved) {
    if (busy.value) return false;
    const next = { title: input.title, msgtype: input.msgtype, content: input.content };
    if (dirty.value && JSON.stringify(next) !== inputKey.value) {
      confirming.value = true;
      try { await ElMessageBox.confirm('当前编辑内容尚未保存，继续后将替换编辑区内容。', '替换编辑内容', { confirmButtonText: '替换内容', cancelButtonText: '保留当前内容' }); }
      catch { return false; }
      finally { confirming.value = false; }
    }
    if (busy.value) return false;
    Object.assign(form, next);
    activeSaved.value = saved;
    savedKey.value = saved ? inputKey.value : JSON.stringify({ title: '', msgtype: 'text', content: '' });
    clearPreview();
    return true;
  }

  async function save(kind: WecomMessageSaved['kind']) {
    if (busy.value || !valid.value) return;
    const input = snapshot();
    const key = inputKey.value;
    try {
      const data = await saveMutation.mutateAsync({ ...input, kind, ...(activeSaved.value?.kind === kind ? { id: activeSaved.value.id } : {}) });
      if (key === inputKey.value) {
        Object.assign(form, { title: data.title, msgtype: data.msgtype, content: data.content });
        activeSaved.value = data;
        savedKey.value = inputKey.value;
      }
      await client.invalidateQueries({ queryKey: libraryKey });
      ElMessage.success(kind === 'draft' ? '草稿已保存' : '模板已保存');
    } catch (error) { ElMessage.error((error as Error).message); }
  }

  async function remove(saved: WecomMessageSaved) {
    if (busy.value) return;
    confirming.value = true;
    try { await ElMessageBox.confirm(`删除“${saved.title}”？编辑区的正文会保留。`, '删除本机保存的消息', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }); }
    catch { return; }
    finally { confirming.value = false; }
    if (busy.value) return;
    try {
      const data = await deleteMutation.mutateAsync(saved.id);
      if (activeSaved.value?.id === saved.id) { activeSaved.value = undefined; savedKey.value = ''; }
      await client.invalidateQueries({ queryKey: libraryKey });
      ElMessage.success(data.message);
    } catch (error) { ElMessage.error((error as Error).message); }
  }

  async function retry(record: WecomMessageRecord) {
    if (record.status !== 'failed') return;
    if (await replace(record.preview.input)) await prepare();
  }
  function refresh() { void configuration.refetch(); void library.refetch(); void history.refetch(); }

  return { form, dirty, bytes, limit, valid, preview, configuration, library, history, activeSaved,
    configOpen, configForm, busy, canSend, previewMutation, sendMutation, configMutation,
    saveConfig, prepare, send, save, remove, replace, retry, refresh,
    clear: () => replace({ title: '', msgtype: 'text', content: '' }),
  };
}

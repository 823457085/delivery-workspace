/** 报告设置、可审阅预览与发送分开；切换设置分栏保留本地草稿。 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { defaultReportPolicy, reportPolicySchema, workspaceReportSettingsSchema, type ReportPolicy, type ReportPreview, type ReportRun, type WorkspaceReportSettings, type WorkspaceReportsDashboard } from '../../../shared/workspace-reports';

async function request<T>(suffix = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/workspace-reports${suffix}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `汇报操作失败 (${response.status})`);
  return value as T;
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const fingerprint = (value: unknown) => JSON.stringify(value);

export function useWorkspaceReports() {
  const client = useQueryClient(), queryKey = ['workspace-reports'];
  const query = useQuery({ queryKey, queryFn: () => request<WorkspaceReportsDashboard>(), retry: false, refetchInterval: 30_000 });
  const settings = ref<WorkspaceReportSettings>(), selectedId = shallowRef(''), saved = shallowRef(''), pending = shallowRef('');
  const preview = shallowRef<ReportPreview>(), previewFingerprint = shallowRef('');
  const botForm = ref({ groupName: '', webhook: '' });
  const botOpen = shallowRef(false);
  const dirty = computed(() => !!settings.value && fingerprint(settings.value) !== saved.value);
  const selected = computed(() => settings.value?.policies.find(policy => policy.id === selectedId.value));
  const bot = computed(() => settings.value && query.data.value?.bots[settings.value.botTarget]);
  const confirmed = computed({
    get: () => !!bot.value?.hasWebhook && !!settings.value && settings.value.confirmedGroupName === bot.value.groupName,
    set: value => { if (settings.value) settings.value.confirmedGroupName = value && bot.value?.hasWebhook ? bot.value.groupName : ''; },
  });
  const valid = computed(() => !!settings.value && workspaceReportSettingsSchema.safeParse(settings.value).success
    && (!settings.value.policies.some(policy => policy.enabled) || confirmed.value));
  const policyValid = computed(() => !!selected.value && reportPolicySchema.safeParse(selected.value).success);
  const previewKey = computed(() => fingerprint({ settings: settings.value, policy: selected.value, bots: query.data.value?.bots }));
  const busy = computed(() => !!pending.value);
  const canSend = computed(() => !!preview.value?.canSend && !busy.value && !dirty.value && confirmed.value
    && !!preview.value.parts?.length && !preview.value.truncated
    && previewFingerprint.value === previewKey.value && preview.value.groupName === bot.value?.groupName);
  function clearPreview() { preview.value = undefined; previewFingerprint.value = ''; }
  function reset() {
    if (!query.data.value) return;
    settings.value = clone(query.data.value.settings);
    saved.value = fingerprint(settings.value);
    if (!settings.value.policies.some(policy => policy.id === selectedId.value)) selectedId.value = settings.value.policies[0]?.id || '';
    clearPreview();
  }
  // 仅同步真正变化的服务端设置；历史或运行状态轮询不打断正在核对的预览。
  watch(() => query.data.value?.settings, value => {
    if (value && (!settings.value || !dirty.value && fingerprint(value) !== saved.value)) reset();
  }, { immediate: true });
  watch(previewKey, clearPreview, { flush: 'sync' });
  watch(() => settings.value?.botTarget, (target, previous) => { if (settings.value && previous && target !== previous) settings.value.confirmedGroupName = ''; });
  watch(botOpen, open => { botForm.value = { groupName: open ? query.data.value?.bots.dedicated.groupName || '' : '', webhook: '' }; });
  function addPolicy(kind: ReportPolicy['kind'] = 'summary') {
    if (!settings.value || busy.value || settings.value.policies.length >= 30) return;
    const policy = defaultReportPolicy(`policy_${crypto.randomUUID()}`);
    policy.name = kind === 'overdue' ? '逾期待办提醒' : '新的汇报策略'; policy.kind = kind;
    settings.value.policies.push(policy); selectedId.value = policy.id;
  }
  function removePolicy() {
    if (!settings.value || !selected.value || busy.value) return;
    settings.value.policies = settings.value.policies.filter(policy => policy.id !== selected.value!.id);
    selectedId.value = settings.value.policies[0]?.id || '';
  }
  function addTime() {
    if (!selected.value || selected.value.times.length >= 12) return;
    const time = ['09:00', '12:00', '18:00', '21:00'].find(value => !selected.value!.times.includes(value)) || '00:00';
    selected.value.times.push(time);
  }
  async function acceptDashboard(value: WorkspaceReportsDashboard) {
    await client.cancelQueries({ queryKey }); client.setQueryData(queryKey, value);
  }
  async function save() {
    if (!settings.value || !valid.value || busy.value) return;
    const input = clone(settings.value), enabled = input.policies.filter(policy => policy.enabled);
    pending.value = 'save';
    try {
      if (enabled.length) await ElMessageBox.confirm(`接收群：${bot.value?.groupName}。保存后将按 ${enabled.map(policy => `「${policy.name}」${policy.timeZone} ${policy.times.join('、')}`).join('；')} 自动推送。请核对目标群与计划。`, '确认保存推送计划', { confirmButtonText: '保存推送计划', cancelButtonText: '取消', closeOnClickModal: false });
      const value = await request<WorkspaceReportsDashboard>('/config', input);
      await acceptDashboard(value);
      // 保存期间禁用编辑，回读采用服务端实际设置（包括启用时间）。
      settings.value = clone(value.settings); saved.value = fingerprint(settings.value); clearPreview();
      ElMessage.success('汇报策略已保存');
    } catch (error) { if (error instanceof Error) ElMessage.error(error.message); }
    finally { pending.value = ''; }
  }
  async function prepare() {
    if (!selected.value || !policyValid.value || busy.value) return;
    const key = previewKey.value, input = clone(selected.value); pending.value = 'preview'; clearPreview();
    try {
      const value = await request<ReportPreview>('/preview', { policy: input });
      if (key === previewKey.value) { preview.value = value; previewFingerprint.value = key; }
    } catch (error) { ElMessage.error((error as Error).message); }
    finally { pending.value = ''; }
  }
  async function send() {
    if (!canSend.value || !preview.value) return;
    const current = preview.value, key = previewKey.value; pending.value = 'send';
    try {
      await ElMessageBox.confirm(`将把已预览的完整 Markdown 分为 ${current.parts.length} 条发送到企业微信群“${current.groupName}”。请核对全部明细和接收群。`, '确认发送完整汇报', { confirmButtonText: '发送完整汇报', cancelButtonText: '取消', closeOnClickModal: false });
      if (preview.value?.id !== current.id || key !== previewKey.value) throw new Error('汇报配置已变化，请重新预览');
      const value = await request<{ record: ReportRun; message: string }>('/send', { previewId: current.id });
      if (value.record.status === 'sent') ElMessage.success(value.message); else ElMessage.warning(value.message);
      clearPreview(); await query.refetch();
    } catch (error) { if (error instanceof Error) ElMessage.error(error.message); }
    finally { pending.value = ''; }
  }
  async function saveBot() {
    if (busy.value || !botForm.value.groupName.trim() || (!query.data.value?.bots.dedicated.hasWebhook && !botForm.value.webhook.trim())) return;
    pending.value = 'bot';
    try {
      const value = await request<WorkspaceReportsDashboard>('/bot', { groupName: botForm.value.groupName.trim(), ...(botForm.value.webhook.trim() ? { webhook: botForm.value.webhook.trim() } : {}) });
      // 更新同名群的 Webhook 也会改变接收配置，公开群名未变时仍须重新预览。
      clearPreview();
      await acceptDashboard(value);
      if (settings.value) {
        settings.value.confirmedGroupName = '';
        for (const policy of settings.value.policies) { policy.enabled = false; delete policy.enabledAt; }
      }
      saved.value = fingerprint(value.settings); botOpen.value = false;
      ElMessage.success('汇报机器人已保存，请确认接收群后保存推送计划');
    } catch (error) { ElMessage.error((error as Error).message); }
    finally { pending.value = ''; }
  }
  return { query, settings, selectedId, selected, bot, confirmed, valid, policyValid, dirty, pending, busy, preview, canSend, botForm, botOpen, reset, addPolicy, removePolicy, addTime, save, prepare, send, saveBot };
}

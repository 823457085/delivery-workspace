/** 只在点击交接时读取 Jira，确认前不写入；服务端记录各步骤，重试不再发已成功的评论。 */
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { JiraFixRecord } from '../../../shared/jira-fix';
import { jiraFixHandoffInputSchema, jiraCommentDraftSchema, type JiraFixHandoffContext, type JiraFixHandoffInput, type JiraFixHandoffState, type JiraStatusChangeState } from '../../../shared/jira-fix-handoff';

export function useJiraFixHandoff(refresh: () => Promise<unknown>) {
  const open = shallowRef(false), loading = shallowRef(false), submitting = shallowRef(false), error = shallowRef('');
  const record = shallowRef<JiraFixRecord>(), context = shallowRef<JiraFixHandoffContext>();
  const form = ref({ transitionId: '', cause: '', impact: '', suggestion: '', conclusion: '' });
  const transitionFields = ref<Record<string, string>>({});
  const dateFields = computed(() => {
    const id = form.value.transitionId === '__testing__' ? context.value?.testingPath?.transitionId : form.value.transitionId;
    return context.value?.transitions.find(item => item.id === id)?.dateFields || [];
  });
  const selectedDates = computed(() => Object.fromEntries(dateFields.value
    .filter(field => transitionFields.value[field.id]).map(field => [field.id, transitionFields.value[field.id]])));
  const datesReady = computed(() => dateFields.value.every(field => !field.required || !!transitionFields.value[field.id]));
  const dateSummary = () => dateFields.value.filter(field => selectedDates.value[field.id])
    .map(field => `${field.name}：${selectedDates.value[field.id]}`).join('；');
  const generating = shallowRef(false), feedback = ref('');
  const applyingStatus = shallowRef(false);
  let generation: AbortController | undefined;
  let controller: AbortController | undefined;
  onScopeDispose(() => { controller?.abort(); generation?.abort(); });
  const locked = computed(() => !!context.value?.handoff);
  const statusUncertain = computed(() => context.value?.statusChange?.status === 'uncertain'
    && context.value.issue.status.id !== (context.value.statusChange.inFlightStatusId || context.value.statusChange.input.targetStatusId));
  const canApplyStatus = computed(() => !locked.value && !loading.value && !submitting.value && !generating.value
    && !applyingStatus.value && !statusUncertain.value && datesReady.value && (form.value.transitionId === '__testing__' ? !!context.value?.testingPath
      : !!context.value?.transitions.some(item => item.id === form.value.transitionId && item.to.id !== context.value?.issue.status.id)));
  const canSubmit = computed(() => {
    const value = context.value;
    return !!value && !loading.value && !generating.value && !applyingStatus.value && !statusUncertain.value && !!value.issue.reporter?.active
      && !['completed', 'uncertain', 'submitting'].includes(value.handoff?.status || '')
      && (locked.value || (datesReady.value && (form.value.transitionId === '__current__' || value.transitions.some(item => item.id === form.value.transitionId))
        && [form.value.cause, form.value.impact, form.value.suggestion, form.value.conclusion].every(text => text.trim())));
  });
  async function show(value: JiraFixRecord) {
    if (submitting.value || applyingStatus.value) return;
    generation?.abort(); generation = undefined; generating.value = false; feedback.value = '';
    controller?.abort(); controller = new AbortController(); const request = controller;
    record.value = value; context.value = undefined; error.value = ''; open.value = true; loading.value = true;
    form.value = { transitionId: '', cause: '', impact: '', suggestion: '', conclusion: '' };
    transitionFields.value = {};
    try {
      const response = await fetch(`/api/agent-runtimes/jira-fix/${value.id}/handoff`, { signal: request.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载 Jira 交接功能，请在任务结束后重启本地服务。' : result.message || '读取 Jira 交接信息失败');
      if (request.signal.aborted) return;
      context.value = result;
      if (statusUncertain.value) error.value = context.value?.statusChange?.error || '状态写入结果待核对';
      const saved = (result as JiraFixHandoffContext).handoff?.input;
      if (saved) {
        form.value = { transitionId: saved.transitionId || '__current__', cause: saved.cause, impact: saved.impact, suggestion: saved.suggestion, conclusion: saved.conclusion };
        transitionFields.value = { ...saved.transitionFields };
      }
      else {
        const preferred = (result as JiraFixHandoffContext).transitions.find(item => item.to.name === '待测试')
          || (result as JiraFixHandoffContext).transitions.find(item => item.to.name === '测试中');
        form.value.transitionId = ['测试中', '待测试'].includes((result as JiraFixHandoffContext).issue.status.name)
          ? '__current__' : preferred?.id || ((result as JiraFixHandoffContext).testingPath ? '__testing__' : '');
      }
    } catch (cause) { if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取失败'; }
    finally { if (controller === request) loading.value = false; }
  }
  function close() {
    if (submitting.value || applyingStatus.value) return;
    generation?.abort(); generation = undefined; generating.value = false;
    controller?.abort(); loading.value = false; open.value = false;
  }
  async function generate() {
    if (!context.value || !record.value || loading.value || generating.value || submitting.value || applyingStatus.value || locked.value) return;
    const request = new AbortController(); generation = request; generating.value = true; error.value = '';
    const { cause, impact, suggestion, conclusion } = form.value;
    const draft = Object.fromEntries(Object.entries({ cause, impact, suggestion, conclusion }).filter(([, text]) => text.trim()));
    try {
      const response = await fetch(`/api/agent-runtimes/jira-fix/${record.value.id}/handoff/draft`, {
        method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
        body: JSON.stringify({ runId: context.value.runId, draft, feedback: feedback.value, authorization: 'generate-jira-comment' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载评论生成功能，请在任务结束后重启本地服务。' : result.message || '生成失败，原草稿已保留');
      if (request.signal.aborted || generation !== request) return;
      const parsed = jiraCommentDraftSchema.safeParse(result);
      if (!parsed.success) throw new Error('生成结果格式不完整，原草稿已保留');
      form.value = { ...form.value, ...parsed.data };
    } catch (cause) { if (!request.signal.aborted && generation === request) error.value = cause instanceof Error ? cause.message : '生成失败，原草稿已保留'; }
    finally { if (generation === request) { generating.value = false; generation = undefined; } }
  }
  async function applyStatus() {
    if (!canApplyStatus.value || !context.value || !record.value) return;
    const current = context.value, id = record.value.id;
    const path = form.value.transitionId === '__testing__' ? current.testingPath : undefined;
    const selected = path ? { id: path.transitionId, to: path.statuses.at(-1)! }
      : current.transitions.find(item => item.id === form.value.transitionId)!;
    const fields = { ...selectedDates.value }, dates = dateSummary();
    applyingStatus.value = true; error.value = '';
    try {
      try {
        const steps = path ? `将依次执行：${[current.issue.status.name, ...path.statuses.map(item => item.name)].join(' → ')}。每步校验权限并回读，失败即停在已到达的状态。` : '';
        await ElMessageBox.confirm(`确认将 ${current.issue.key} 从“${current.issue.status.name}”流转到“${selected.to.name}”？${dates ? `${dates}。` : ''}${steps}本次${dates ? '更新所选日期并流转状态' : '只修改状态'}，不发布评论、不改变指派人。`, '确认状态生效',
          { type: 'warning', confirmButtonText: '确认生效', cancelButtonText: '取消', closeOnClickModal: false });
      } catch { return; }
      const response = await fetch(`/api/agent-runtimes/jira-fix/${id}/handoff/status`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), runId: current.runId, fromStatusId: current.issue.status.id,
          transitionId: selected.id, targetStatusId: selected.to.id, ...(path ? { viaStatusIds: path.statuses.slice(0, -1).map(item => item.id) } : {}),
          ...(Object.keys(fields).length ? { transitionFields: fields } : {}), authorization: 'transition-jira-status' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载状态生效功能，请在任务结束后重启本地服务。' : result.message || '状态生效失败');
      const state = result as JiraStatusChangeState;
      context.value = { ...current, issue: state.result || current.issue, transitions: [], testingPath: undefined, statusChange: state };
      if (state.status === 'completed') {
        form.value.transitionId = '__current__';
        ElMessage.success(`Jira 状态已回读确认：${state.result?.status.name}`);
      }
      else error.value = state.error;
      const refreshed = await fetch(`/api/agent-runtimes/jira-fix/${id}/handoff`);
      if (!refreshed.ok) throw new Error('状态操作已返回，但最新可选状态读取失败；请重新打开核对，评论草稿仍保留。');
      context.value = await refreshed.json();
      if (state.status !== 'completed') {
        // 失败后按最新工作流保留目标，避免误选“保持当前状态”并禁用重试。
        const latest = context.value!;
        form.value.transitionId = latest.issue.status.id === selected.to.id ? '__current__'
          : path && latest.testingPath?.statuses.at(-1)?.id === selected.to.id ? '__testing__'
            : latest.transitions.find(item => item.to.id === selected.to.id)?.id || '';
      }
    } catch (cause) {
      // 不自动重发外部写操作，草稿保留；重新打开时读取真实状态。
      error.value = cause instanceof Error ? cause.message : '状态操作结果未知，请重新打开核对';
      form.value.transitionId = '';
    } finally { applyingStatus.value = false; }
  }
  async function submit() {
    if (submitting.value || !canSubmit.value || !context.value || !record.value) return;
    const current = context.value, selected = current.transitions.find(item => item.id === form.value.transitionId);
    const parsed = jiraFixHandoffInputSchema.safeParse(current.handoff?.input || {
      ...form.value, runId: current.runId, reporterId: current.issue.reporter!.id,
      transitionId: selected?.id || '', targetStatusId: selected?.to.id || current.issue.status.id,
      ...(Object.keys(selectedDates.value).length ? { transitionFields: selectedDates.value } : {}),
      authorization: 'comment-transition-assign-reporter',
    });
    if (!parsed.success) { ElMessage.warning(parsed.error.issues[0]!.message); return; }
    const input: JiraFixHandoffInput = parsed.data, id = record.value.id;
    submitting.value = true; error.value = '';
    try {
      try {
        await ElMessageBox.confirm(`确认将 ${current.issue.key} 的交接说明发布到 Jira，状态设为“${selected?.to.name || current.handoff?.result?.status.name || current.issue.status.name}”，并指派给报告人 ${current.issue.reporter!.name}？${dateSummary() ? `${dateSummary()}。` : ''}已完成的步骤不会重复执行。`, '确认交接 Jira',
          { type: 'warning', confirmButtonText: '确认评论并交接', cancelButtonText: '取消', closeOnClickModal: false });
      } catch { return; }
      const response = await fetch(`/api/agent-runtimes/jira-fix/${id}/handoff`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '交接失败，请刷新核对');
      const state = result as JiraFixHandoffState;
      context.value = { ...current, handoff: state };
      if (state.status === 'completed') ElMessage.success('Jira 评论、状态和报告人指派已回读确认');
      else error.value = state.error;
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '提交结果未知，请重新打开交接核对，不要重复提交'; }
    finally { submitting.value = false; await refresh(); }
  }
  return { open, loading, submitting, generating, applyingStatus, canApplyStatus, applyStatus, feedback, generate, error, record, context, form, transitionFields, dateFields, locked, canSubmit, show, close, submit };
}

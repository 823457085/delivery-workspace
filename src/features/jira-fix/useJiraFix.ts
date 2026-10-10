import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { jiraFixInputSchema, jiraIssueKey, jiraReferenceSchema, type JiraFixInput, type JiraFixContext, type JiraFixProject, type JiraFixRecord } from '../../../shared/jira-fix';
import { createRequestId } from '../requirement-development/request-id';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';

export function useJiraFix(openRun: (id: string) => void) {
  const storageKey = 'qiyuan:jira-fix:v1';
  const form = ref<JiraFixInput>({ issueKey: '', repository: '', parentDirectory: '', baseBranch: 'master', branch: 'feature/', notes: '', rememberProject: false });
  const requestId = shallowRef(createRequestId());
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved?.input) for (const key of Object.keys(form.value) as (keyof JiraFixInput)[]) {
      if (typeof saved.input[key] === typeof form.value[key]) Object.assign(form.value, { [key]: saved.input[key] });
    }
    if (/^[0-9a-f-]{36}$/.test(saved?.requestId || '')) requestId.value = saved.requestId;
  } catch { /* 草稿失败不影响当前表单。 */ }
  const context = shallowRef<JiraFixContext>();
  const resolving = shallowRef(false), starting = shallowRef(false), awaitingId = shallowRef('');
  const retryAttempt = shallowRef<{ sourceId: string; requestId: string }>();
  const retryingId = computed(() => retryAttempt.value?.sourceId || '');
  const selectedRepository = shallowRef('');
  const picker = useWorkspacePicker();
  function saveDraft() {
    try { localStorage.setItem(storageKey, JSON.stringify({ input: form.value, requestId: requestId.value })); } catch { /* 仍可提交。 */ }
  }
  function failedAttempt(message: string) {
    awaitingId.value = ''; requestId.value = createRequestId(); saveDraft(); ElMessage.error(message);
  }
  let resolution: AbortController | undefined;
  onScopeDispose(() => resolution?.abort());
  watch(() => form.value.issueKey, value => {
    resolution?.abort(); context.value = undefined; resolving.value = false;
    selectedRepository.value = ''; form.value.repository = ''; form.value.parentDirectory = ''; form.value.baseBranch = 'master';
    form.value.branch = `feature/${jiraIssueKey(value)}`;
  }, { flush: 'sync' });
  watch(form, () => {
    requestId.value = createRequestId(); awaitingId.value = '';
    saveDraft();
  }, { deep: true, flush: 'sync' });
  async function post<T>(path: string, value: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/agent-runtimes/jira-fix${path}`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '请求失败');
    return result;
  }
  const query = useQuery({ queryKey: ['jira-fix'], retry: false,
    queryFn: async ({ signal }): Promise<JiraFixRecord[]> => {
      const response = await fetch('/api/agent-runtimes/jira-fix', { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载 Jira 修复功能，请在当前任务结束后重启本地服务。' : result.message || '修复记录读取失败');
      return result.records;
    }, refetchInterval: q => q.state.data?.some(item => ['preparing', 'starting'].includes(item.status) || ['queued', 'running'].includes(item.runStatus || '')) ? 2000 : 15000,
  });
  const records = computed(() => query.data.value || []);
  const activePreparation = computed(() => records.value.some(item => item.id === awaitingId.value && ['preparing', 'starting'].includes(item.status)));
  const busy = computed(() => starting.value || activePreparation.value || !!retryAttempt.value);
  const valid = computed(() => !!context.value && context.value.issue.key === jiraIssueKey(form.value.issueKey) && jiraFixInputSchema.safeParse(form.value).success);
  watch(records, items => {
    const record = items.find(item => item.id === awaitingId.value);
    if (record?.runId) { awaitingId.value = ''; openRun(record.runId); }
    else if (record?.status === 'failed') failedAttempt(record.error);
    else if (record?.status === 'uncertain') { awaitingId.value = ''; ElMessage.error(record.error); }
    const retried = items.find(item => item.id === retryAttempt.value?.requestId);
    if (retried) settleRetry(retried);
  });
  function settleRetry(record: JiraFixRecord) {
    if (!record.runId && !['failed', 'uncertain'].includes(record.status)) return;
    retryAttempt.value = undefined;
    if (record.runId) openRun(record.runId);
    else ElMessage.error(record.error);
  }
  async function retry(record: JiraFixRecord) {
    if (busy.value || record.status !== 'failed' || record.runId) return;
    const id = createRequestId();
    retryAttempt.value = { sourceId: record.id, requestId: id };
    try {
      const next = await post<JiraFixRecord>('', { requestId: id, input: record.input, authorization: 'clone-and-fix-jira' });
      if (retryAttempt.value?.requestId !== id) return;
      retryAttempt.value = { sourceId: record.id, requestId: next.id };
      settleRetry(next);
    } catch (error) {
      if (retryAttempt.value?.requestId !== id) return;
      retryAttempt.value = undefined;
      ElMessage.error(error instanceof Error ? error.message : '重试失败，请核对启动记录');
    } finally { await query.refetch(); }
  }
  function selectProject(repository: string) {
    selectedRepository.value = repository;
    const project = context.value?.projects.find(item => item.repository === repository)
      || context.value?.candidates.find(item => item.repository === repository);
    if (project) applyProject(project);
  }
  function applyProject(project: JiraFixProject) {
    selectedRepository.value = project.repository;
    form.value.repository = project.repository; form.value.parentDirectory = project.parentDirectory; form.value.baseBranch = project.baseBranch;
  }
  async function resolveIssue() {
    const parsed = jiraReferenceSchema.safeParse(form.value.issueKey);
    if (!parsed.success) { ElMessage.warning(parsed.error.issues[0]!.message); return; }
    resolution?.abort();
    const controller = new AbortController(); resolution = controller; resolving.value = true; context.value = undefined;
    try {
      const result = await post<JiraFixContext>('/resolve', { issueKey: parsed.data }, controller.signal);
      if (controller.signal.aborted) return;
      context.value = result;
      if (result.projectWarning) ElMessage.warning(result.projectWarning);
      if (result.candidates.length === 1 && !form.value.repository) applyProject(result.candidates[0]!);
      if (!form.value.branch || form.value.branch === 'feature/') form.value.branch = `feature/${result.issue.key}`;
    } catch (error) { if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : 'Jira 读取失败'); }
    finally { if (resolution === controller) resolving.value = false; }
  }
  async function chooseDirectory() {
    const selection = await picker.choose(form.value.parentDirectory);
    if (selection) form.value.parentDirectory = selection.workspacePath;
    else if (picker.error.value) ElMessage.error(picker.error.value);
  }
  async function start() {
    if (busy.value) return;
    const parsed = jiraFixInputSchema.safeParse(form.value);
    if (!valid.value || !parsed.success) { ElMessage.warning(parsed.success ? '请先读取当前 Jira 事项' : parsed.error.issues[0]!.message); return; }
    starting.value = true;
    try {
      const record = await post<JiraFixRecord>('', { requestId: requestId.value, input: parsed.data, authorization: 'clone-and-fix-jira' });
      if (record.runId) openRun(record.runId);
      else if (record.status === 'failed') failedAttempt(record.error);
      else if (record.status === 'uncertain') ElMessage.error(record.error);
      else awaitingId.value = record.id;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '启动失败，请核对启动记录'); }
    finally { await query.refetch(); starting.value = false; }
  }
  return { form, context, resolving, busy, valid, records, query, picker, selectedRepository, selectProject, resolveIssue, chooseDirectory, start, retry, retryingId };
}
